"""Load and validate ``corpus/manifest.json`` and locate items in the local cache."""

from __future__ import annotations

import json
import os
import plistlib
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

CORPUS_DIR = Path(__file__).resolve().parent
MANIFEST_PATH = CORPUS_DIR / "manifest.json"
FACTS_DIR = CORPUS_DIR / "facts"

SCHEMA_VERSION = 1
LAYERS = {"pub", "ffs", "ref", "syn"}
FETCH_METHODS = {"direct", "zip_member", "targz_member", "manual"}
ARCHIVES = {"zip", "tar.xz"}
TIERS = {"pr", "nightly", "weekly", "release"}
_SHA256 = re.compile(r"^[0-9a-f]{64}$")


class ManifestError(ValueError):
    """The manifest is malformed."""


def cache_root() -> Path:
    """Where fetched items live. Override with ``$OPENEXTRACT_CORPUS_CACHE``."""
    env = os.environ.get("OPENEXTRACT_CORPUS_CACHE")
    if env:
        return Path(env).expanduser()
    return Path.home() / ".cache" / "openextract-corpus"


@dataclass(frozen=True)
class Fetch:
    method: str
    artifact: str
    archive: str
    url: Optional[str] = None
    member: Optional[str] = None
    size: Optional[int] = None
    sha256: Optional[str] = None
    instructions: Optional[str] = None


@dataclass(frozen=True)
class Item:
    key: str
    layer: str
    ios: str
    build: Optional[str]
    product_type: Optional[str]
    host: str
    encrypted: bool
    password: Optional[str]
    udid: Optional[str]
    fetch: Fetch
    creator: str
    source_page: str
    terms: str
    verified: str
    tiers: tuple[str, ...] = ()
    documentation: Optional[str] = None
    password_source: Optional[str] = None
    notes: Optional[str] = None

    # ── cache locations ──────────────────────────────────────────────────────

    def item_dir(self, root: Optional[Path] = None) -> Path:
        return (root or cache_root()) / self.key

    def artifact_path(self, root: Optional[Path] = None) -> Path:
        return self.item_dir(root) / "download" / self.fetch.artifact

    def unpack_dir(self, root: Optional[Path] = None) -> Path:
        return self.item_dir(root) / "backup"

    def backup_dir(self, root: Optional[Path] = None) -> Optional[Path]:
        """The unpacked backup folder (the one holding Manifest.plist), or None."""
        base = self.unpack_dir(root)
        if not base.is_dir():
            return None
        if self.udid and (base / self.udid / "Manifest.plist").is_file():
            return base / self.udid
        if (base / "Manifest.plist").is_file():
            return base
        for manifest in sorted(base.glob("*/Manifest.plist")):
            return manifest.parent
        for manifest in sorted(base.glob("*/*/Manifest.plist")):
            return manifest.parent
        return None

    def facts_path(self) -> Path:
        return FACTS_DIR / f"{self.key}.json"

    def backup_date(self, root: Optional[Path] = None):
        """When the backup was last written, as an aware datetime.

        The latest of Manifest.plist ``Date``, Status.plist ``Date`` and Info.plist
        ``Last Backup Date``: incremental backups don't always refresh Manifest.plist.
        """
        from datetime import datetime, timezone

        backup_dir = self.backup_dir(root)
        if backup_dir is None:
            return None
        dates = []
        for name, key in (("Manifest.plist", "Date"), ("Status.plist", "Date"), ("Info.plist", "Last Backup Date")):
            try:
                with open(backup_dir / name, "rb") as f:
                    value = plistlib.load(f).get(key)
            except (OSError, plistlib.InvalidFileException):
                continue
            if isinstance(value, datetime):
                dates.append(value if value.tzinfo else value.replace(tzinfo=timezone.utc))
        return max(dates) if dates else None


def _require(obj: dict, field: str, where: str, kind=str):
    if field not in obj or obj[field] is None:
        raise ManifestError(f"{where}: missing '{field}'")
    if not isinstance(obj[field], kind):
        raise ManifestError(f"{where}: '{field}' must be {kind.__name__}")
    return obj[field]


def _parse_fetch(raw: dict, where: str) -> Fetch:
    where = f"{where}.fetch"
    method = _require(raw, "method", where)
    if method not in FETCH_METHODS:
        raise ManifestError(f"{where}: unknown method '{method}' (expected one of {sorted(FETCH_METHODS)})")
    archive = _require(raw, "archive", where)
    if archive not in ARCHIVES:
        raise ManifestError(f"{where}: unknown archive '{archive}' (expected one of {sorted(ARCHIVES)})")
    artifact = _require(raw, "artifact", where)
    if "/" in artifact or "\\" in artifact:
        raise ManifestError(f"{where}: 'artifact' must be a bare file name")
    if method in ("direct", "zip_member", "targz_member"):
        _require(raw, "url", where)
    if method in ("zip_member", "targz_member"):
        _require(raw, "member", where)
    if method == "manual":
        _require(raw, "instructions", where)
    sha = raw.get("sha256")
    if sha is not None and not _SHA256.match(sha):
        raise ManifestError(f"{where}: 'sha256' must be 64 lowercase hex characters")
    size = raw.get("size")
    if size is not None and (not isinstance(size, int) or size <= 0):
        raise ManifestError(f"{where}: 'size' must be a positive integer")
    return Fetch(
        method=method,
        artifact=artifact,
        archive=archive,
        url=raw.get("url"),
        member=raw.get("member"),
        size=size,
        sha256=sha,
        instructions=raw.get("instructions"),
    )


def _parse_item(raw: dict, index: int) -> Item:
    where = f"items[{index}]"
    key = _require(raw, "key", where)
    where = f"item '{key}'"
    layer = _require(raw, "layer", where)
    if layer not in LAYERS:
        raise ManifestError(f"{where}: unknown layer '{layer}'")
    encrypted = _require(raw, "encrypted", where, bool)
    tiers = tuple(raw.get("tiers", []))
    unknown = set(tiers) - TIERS
    if unknown:
        raise ManifestError(f"{where}: unknown tiers {sorted(unknown)}")
    password = raw.get("password")
    if password is not None and not encrypted:
        raise ManifestError(f"{where}: has a password but is not encrypted")
    return Item(
        key=key,
        layer=layer,
        ios=_require(raw, "ios", where),
        build=raw.get("build"),
        product_type=raw.get("product_type"),
        host=_require(raw, "host", where),
        encrypted=encrypted,
        password=password,
        udid=raw.get("udid"),
        fetch=_parse_fetch(_require(raw, "fetch", where, dict), where),
        creator=_require(raw, "creator", where),
        source_page=_require(raw, "source_page", where),
        terms=_require(raw, "terms", where),
        verified=_require(raw, "verified", where),
        tiers=tiers,
        documentation=raw.get("documentation"),
        password_source=raw.get("password_source"),
        notes=raw.get("notes"),
    )


def load_manifest(path: Path = MANIFEST_PATH) -> dict[str, Item]:
    """Return the manifest's items keyed by item key, validating as we go."""
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
    if data.get("schema_version") != SCHEMA_VERSION:
        raise ManifestError(
            f"{path}: schema_version {data.get('schema_version')!r} is not supported (expected {SCHEMA_VERSION})"
        )
    items: dict[str, Item] = {}
    for index, raw in enumerate(data.get("items", [])):
        item = _parse_item(raw, index)
        if item.key in items:
            raise ManifestError(f"duplicate item key '{item.key}'")
        items[item.key] = item
    return items
