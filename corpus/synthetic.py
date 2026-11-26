"""Synthetic corpus items: backups written on demand by ios-backup-core's ``backupgen``.

``corpus/synthetic.json`` lists them (persona, snapshot, encrypted or not, tiers).
Each comes with ``expected.json``, the answer key written by the generator, which
the corpus tests compare OpenExtract's output against.

They are generated into ``<cache>/syn/<key>@<version>/``, where the version is the
first 12 hex digits of a fingerprint of everything that shapes the output (the
generator, its harvested schemas and the persona pack). Two runs with different
ios-backup-core checkouts therefore use different folders and can share a cache
without deleting each other's backups. A backup is generated into a temporary
folder beside it and renamed into place once complete, so a folder under its final
name is never half-written. Older versions of an item are deleted, but only beyond
the newest few and never one used in the last hour (see ``_prune``).

``backupgen`` lives in the ios-backup-core repository, outside its installed
package. It is found via ``$OPENEXTRACT_IOS_BACKUP_CORE``, the sibling checkout
(``../ios-backup-core``) or the checkout ``ios_backup_core`` is imported from.
When it can't be found, synthetic items are skipped.
"""

from __future__ import annotations

import hashlib
import json
import os
import plistlib
import shutil
import sys
import tempfile
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from corpus.manifest import CORPUS_DIR, cache_root

SYNTHETIC_PATH = CORPUS_DIR / "synthetic.json"
_FINGERPRINT = "fingerprint.txt"
_GENERATED_AT = "generated_at.txt"
VERSION_DIGITS = 12  # of the fingerprint, in each generated folder's name
KEEP_VERSIONS = 3  # an item's newest generated versions, never deleted
KEEP_RECENT_SECONDS = 3600  # nor one generated or used this recently: another run may have it open


def backupgen_root() -> Optional[Path]:
    """The ios-backup-core checkout that holds ``backupgen/``, or None."""
    candidates = []
    if os.environ.get("OPENEXTRACT_IOS_BACKUP_CORE"):
        candidates.append(Path(os.environ["OPENEXTRACT_IOS_BACKUP_CORE"]).expanduser())
    candidates.append(CORPUS_DIR.parent.parent / "ios-backup-core")
    try:
        import ios_backup_core

        candidates.append(Path(ios_backup_core.__file__).resolve().parents[2])
    except ImportError:
        pass
    for candidate in candidates:
        if (candidate / "backupgen" / "generate.py").is_file():
            return candidate
    return None


def persona_available(persona: str) -> bool:
    root = backupgen_root()
    return root is not None and (root / "backupgen" / "personas" / persona / "persona.json").is_file()


def _import_backupgen():
    root = backupgen_root()
    if root is None:
        return None
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    import backupgen.generate

    return backupgen


@dataclass(frozen=True)
class SyntheticItem:
    key: str
    persona: str
    snapshot: str
    password: Optional[str]
    tiers: tuple[str, ...] = ()
    layer: str = "syn"

    # Attributes shared with manifest items, so the corpus tests treat both alike.
    @property
    def encrypted(self) -> bool:
        return self.password is not None

    @property
    def udid(self) -> Optional[str]:
        expected = self.expected()
        return expected["udid"] if expected else None

    @property
    def ios(self) -> Optional[str]:
        expected = self.expected()
        return expected["ios"] if expected else None

    @property
    def product_type(self) -> Optional[str]:
        expected = self.expected()
        return expected["product_type"] if expected else None

    def item_dir(self, root: Optional[Path] = None) -> Optional[Path]:
        """The folder this item is generated into by the ios-backup-core checkout in use
        (``<cache>/syn/<key>@<version>``), or None without backupgen or this persona."""
        fingerprint = item_fingerprint(self)
        return None if fingerprint is None else version_dir(synthetic_root(root), self.key, fingerprint)

    def unpack_dir(self, root: Optional[Path] = None) -> Optional[Path]:
        return self.item_dir(root)

    def backup_dir(self, root: Optional[Path] = None) -> Optional[Path]:
        folder = self.item_dir(root)
        return None if folder is None else _backup_folder(folder)

    def facts_path(self) -> Path:
        return CORPUS_DIR / "facts" / f"{self.key}.json"  # synthetic items use expected.json instead

    def expected(self, root: Optional[Path] = None) -> Optional[dict]:
        folder = self.item_dir(root)
        path = None if folder is None else folder / "expected.json"
        return json.loads(path.read_text(encoding="utf-8")) if path is not None and path.is_file() else None

    def backup_date(self, root: Optional[Path] = None):
        backup_dir = self.backup_dir(root)
        if backup_dir is None:
            return None
        date = plistlib.load(open(backup_dir / "Manifest.plist", "rb"))["Date"]
        return date if date.tzinfo else date.replace(tzinfo=timezone.utc)


def load_synthetic(path: Path = SYNTHETIC_PATH) -> dict[str, SyntheticItem]:
    data = json.loads(path.read_text(encoding="utf-8"))
    items = {}
    for raw in data.get("items", []):
        item = SyntheticItem(raw["key"], raw["persona"], raw["snapshot"], raw.get("password"), tuple(raw.get("tiers", [])))
        if item.key in items:
            raise ValueError(f"duplicate synthetic key {item.key}")
        items[item.key] = item
    return items


def _fingerprint(root: Path, item: SyntheticItem) -> str:
    """Hash of everything that shapes the output: generator code, schemas and this persona's pack."""
    digest = hashlib.sha256(json.dumps([item.persona, item.snapshot, item.password]).encode())
    for path in sorted((root / "backupgen").rglob("*")):
        if not path.is_file() or "__pycache__" in path.parts:
            continue
        relative = path.relative_to(root)
        if len(relative.parts) > 2 and relative.parts[1] == "personas" and relative.parts[2] != item.persona:
            continue
        digest.update(str(relative).encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


_fingerprints: dict[tuple, str] = {}


def item_fingerprint(item: SyntheticItem, *, fresh: bool = False) -> Optional[str]:
    """The item's fingerprint with the ios-backup-core checkout in use, or None without backupgen
    or this persona. Hashing backupgen takes a moment, so it's done once per process unless ``fresh``."""
    root = backupgen_root()
    if root is None or not persona_available(item.persona):
        return None
    key = (str(root), item.persona, item.snapshot, item.password)
    if fresh or key not in _fingerprints:
        _fingerprints[key] = _fingerprint(root, item)
    return _fingerprints[key]


def synthetic_root(root: Optional[Path] = None) -> Path:
    """``<cache>/syn``, which holds every generated item."""
    return (root or cache_root()) / "syn"


def version_dir(syn_root: Path, key: str, fingerprint: str) -> Path:
    """Where one version of an item lives. No ':' in the name, so it works on Windows."""
    return syn_root / f"{key}@{fingerprint[:VERSION_DIGITS]}"


def _backup_folder(folder: Path) -> Optional[Path]:
    """The backup inside a generated folder, once it's complete (it has expected.json)."""
    if not (folder / "expected.json").is_file():
        return None
    return next((p for p in folder.iterdir() if (p / "Manifest.plist").is_file()), None)


def _is_complete(folder: Path, fingerprint: str) -> bool:
    marker = folder / _FINGERPRINT
    try:
        return marker.read_text() == fingerprint and _backup_folder(folder) is not None
    except OSError:
        return False


def _remove(path: Path) -> None:
    """Delete a folder, out of the way first: renamed, it's no longer anyone's version, so a
    half-deleted one is never mistaken for a backup."""
    trash = path.with_name(f".{path.name}.{os.getpid()}.{time.monotonic_ns()}.del")
    try:
        path.rename(trash)
    except OSError:
        return  # gone already, or open on Windows: try again next time
    shutil.rmtree(trash, ignore_errors=True)


def _rename(source: Path, target: Path) -> None:
    """Rename a folder, retrying briefly on Windows, where a scanner may still hold a new file."""
    for attempt in range(20):
        try:
            source.rename(target)
            return
        except PermissionError:
            if os.name != "nt" or attempt == 19:
                raise
            time.sleep(0.25)


def _generate(backupgen, item: SyntheticItem, folder: Path, fingerprint: str) -> None:
    """Write the item into a temporary folder beside ``folder``, then rename it into place."""
    folder.parent.mkdir(parents=True, exist_ok=True)
    temp = Path(tempfile.mkdtemp(prefix=f".{folder.name}.", suffix=".tmp", dir=folder.parent))
    try:
        backupgen.generate.generate(item.persona, item.snapshot, temp, password=item.password)
        (temp / _FINGERPRINT).write_text(fingerprint)
        (temp / _GENERATED_AT).write_text(datetime.now(timezone.utc).isoformat(timespec="seconds"))
        try:
            _rename(temp, folder)
        except OSError:
            if not folder.exists():
                raise
            if not _is_complete(folder, fingerprint):
                # Not this version after all (left by hand, or a fingerprint that shares the first
                # 12 digits): put this one in its place.
                _remove(folder)
                _rename(temp, folder)
            # else another run finished this version first; use theirs.
    finally:
        if temp.exists():
            shutil.rmtree(temp, ignore_errors=True)


def _last_used(folder: Path) -> float:
    try:
        return folder.stat().st_mtime  # set when generated and each time ensure_generated returns it
    except OSError:
        return 0.0


def _prune(syn_root: Path, key: str, current: Path, *, keep: int = KEEP_VERSIONS,
           recent: float = KEEP_RECENT_SECONDS, now: Optional[float] = None) -> None:
    """Delete older versions of ``key``: never ``current``, never the ``keep`` most recently used,
    and never one generated or used within ``recent`` seconds, which another run may still have
    open. Also clears temporary folders that killed runs left behind."""
    now = time.time() if now is None else now
    versions = sorted(
        (p for p in syn_root.glob(f"{key}@*") if p.is_dir() and p.name.rpartition("@")[0] == key),
        key=_last_used, reverse=True,
    )
    for index, folder in enumerate(versions):
        # _last_used is read again here: a run may have just started using it.
        if folder == current or index < keep or now - _last_used(folder) < recent:
            continue
        _remove(folder)
    for leftover in [*syn_root.glob(f".{key}@*.tmp"), *syn_root.glob(f".{key}@*.del")]:
        if leftover.is_dir() and now - _last_used(leftover) >= recent:
            shutil.rmtree(leftover, ignore_errors=True)


def ensure_generated(item: SyntheticItem, root: Optional[Path] = None) -> Optional[Path]:
    """Generate the item if this ios-backup-core checkout's version of it is missing. Returns its
    backup folder, or None without backupgen."""
    if not persona_available(item.persona):
        return None  # no backupgen, or this ios-backup-core checkout predates the persona
    backupgen = _import_backupgen()
    fingerprint = item_fingerprint(item, fresh=True)
    syn_root = synthetic_root(root)
    folder = version_dir(syn_root, item.key, fingerprint)
    try:
        os.utime(folder)  # in use: another run's _prune keeps it for the next hour
    except OSError:
        pass  # not generated yet
    if not _is_complete(folder, fingerprint):
        _generate(backupgen, item, folder, fingerprint)
    _prune(syn_root, item.key, folder)
    return _backup_folder(folder)
