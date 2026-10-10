"""Synthetic corpus items: backups written on demand by ios-backup-core's ``backupgen``.

``corpus/synthetic.json`` lists them (persona, snapshot, encrypted or not, tiers).
They are generated into ``<cache>/syn/<key>/`` and regenerated whenever the
generator, its harvested schemas or the persona pack change. Each comes with
``expected.json``, the answer key written by the generator, which the corpus
tests compare OpenExtract's output against.

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
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from corpus.manifest import CORPUS_DIR, cache_root

SYNTHETIC_PATH = CORPUS_DIR / "synthetic.json"
_FINGERPRINT = "fingerprint.txt"


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

    def item_dir(self, root: Optional[Path] = None) -> Path:
        return (root or cache_root()) / "syn" / self.key

    def unpack_dir(self, root: Optional[Path] = None) -> Path:
        return self.item_dir(root)

    def backup_dir(self, root: Optional[Path] = None) -> Optional[Path]:
        folder = self.item_dir(root)
        if not (folder / "expected.json").is_file():
            return None
        return next((p for p in folder.iterdir() if (p / "Manifest.plist").is_file()), None)

    def facts_path(self) -> Path:
        return CORPUS_DIR / "facts" / f"{self.key}.json"  # synthetic items use expected.json instead

    def expected(self, root: Optional[Path] = None) -> Optional[dict]:
        path = self.item_dir(root) / "expected.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.is_file() else None

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


def ensure_generated(item: SyntheticItem, root: Optional[Path] = None) -> Optional[Path]:
    """Generate the item if it's missing or stale. Returns its backup folder, or None without backupgen."""
    if not persona_available(item.persona):
        return None  # no backupgen, or this ios-backup-core checkout predates the persona
    backupgen = _import_backupgen()
    fingerprint = _fingerprint(backupgen_root(), item)
    folder = item.item_dir(root)
    marker = folder / _FINGERPRINT
    if item.backup_dir(root) is not None and marker.is_file() and marker.read_text() == fingerprint:
        return item.backup_dir(root)
    if folder.exists():
        shutil.rmtree(folder)
    backupgen.generate.generate(item.persona, item.snapshot, folder, password=item.password)
    marker.write_text(fingerprint)
    (folder / "generated_at.txt").write_text(datetime.now(timezone.utc).isoformat(timespec="seconds"))
    return item.backup_dir(root)
