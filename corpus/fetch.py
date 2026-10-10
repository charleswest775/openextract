"""Fetch corpus items into the local cache and check them against their pinned hashes.

Run from the repository root:

    python -m corpus.fetch list
    python -m corpus.fetch fetch pub-hickman-15.3.1
    python -m corpus.fetch fetch --tier weekly
    python -m corpus.fetch verify pub-hickman-15.3.1
    python -m corpus.fetch path pub-hickman-15.3.1
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from corpus import remote
from corpus.manifest import Item, cache_root, load_manifest

RECORD = "fetch.json"


class HashMismatch(remote.FetchError):
    pass


class ManualFetchRequired(remote.FetchError):
    pass


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(remote.CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


class _Progress:
    """Prints a progress line at most every couple of seconds."""

    def __init__(self, label: str, log):
        self.label, self.log, self.last = label, log, 0.0

    def __call__(self, done: int, total: Optional[int]) -> None:
        now = time.monotonic()
        if now - self.last < 2 and done != total:
            return
        self.last = now
        if total:
            self.log(f"  {self.label}: {done / 1e6:,.0f} / {total / 1e6:,.0f} MB ({100 * done / total:.0f}%)")
        else:
            self.log(f"  {self.label}: {done / 1e6:,.0f} MB")


def _read_record(item: Item, root: Path) -> dict:
    path = item.item_dir(root) / RECORD
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def is_fetched(item: Item, root: Optional[Path] = None) -> bool:
    """True when the item is unpacked and its record matches the manifest's pinned hash."""
    root = root or cache_root()
    record = _read_record(item, root)
    if not record or item.backup_dir(root) is None:
        return False
    return item.fetch.sha256 is None or record.get("sha256") == item.fetch.sha256


def _download(item: Item, artifact: Path, log) -> None:
    fetch = item.fetch
    progress = _Progress(artifact.name, log)
    if fetch.method == "direct":
        log(f"Downloading {fetch.url}")
        remote.download(fetch.url, artifact, expected_size=fetch.size, progress=progress)
    elif fetch.method == "zip_member":
        log(f"Extracting '{fetch.member}' from {fetch.url} (range requests)")
        remote.extract_zip_member(fetch.url, fetch.member, artifact, progress=progress)
    elif fetch.method == "targz_member":
        log(f"Streaming {fetch.url} until '{fetch.member}' has been read")
        remote.extract_targz_member(fetch.url, fetch.member, artifact, progress=progress)
    elif fetch.method == "manual":
        raise ManualFetchRequired(
            f"{item.key} must be downloaded by hand.\n{fetch.instructions}\n"
            f"Then place the file at:\n  {artifact}\nand run this command again."
        )
    else:  # load_manifest rejects unknown methods; this guards direct callers
        raise remote.FetchError(f"{item.key}: unknown fetch method '{fetch.method}'")


def fetch_item(item: Item, root: Optional[Path] = None, *, force: bool = False, log=print) -> Path:
    """Make sure ``item`` is downloaded, verified and unpacked. Returns the backup folder."""
    root = root or cache_root()
    if not force and is_fetched(item, root):
        log(f"{item.key}: already fetched")
        return item.backup_dir(root)

    artifact = item.artifact_path(root)
    if force and artifact.exists():
        artifact.unlink()
    if not artifact.exists():
        _download(item, artifact, log)

    log(f"{item.key}: checking SHA-256")
    digest = sha256_file(artifact)
    pinned = item.fetch.sha256
    if pinned and digest != pinned:
        bad = artifact.with_name(artifact.name + ".mismatch")
        artifact.replace(bad)
        raise HashMismatch(
            f"{item.key}: SHA-256 mismatch.\n  expected {pinned}\n  got      {digest}\n"
            f"The download was moved to {bad} for inspection."
        )
    if not pinned:
        log(f"{item.key}: WARNING: no pinned SHA-256 in corpus/manifest.json. Computed:\n  {digest}\n"
            f"  Check it against the creator's published hash, then pin it.")

    log(f"{item.key}: unpacking")
    remote.unpack(artifact, item.fetch.archive, item.unpack_dir(root))
    backup_dir = item.backup_dir(root)
    if backup_dir is None:
        raise remote.FetchError(f"{item.key}: no Manifest.plist found after unpacking {artifact.name}")

    record = {
        "key": item.key,
        "sha256": digest,
        "size": artifact.stat().st_size,
        "backup_dir": str(backup_dir),
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    (item.item_dir(root) / RECORD).write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    log(f"{item.key}: ready at {backup_dir}")
    return backup_dir


def verify_item(item: Item, root: Optional[Path] = None) -> tuple[bool, str]:
    """Re-hash the downloaded artifact. Returns (ok, message)."""
    root = root or cache_root()
    artifact = item.artifact_path(root)
    if not artifact.exists():
        return False, f"{item.key}: not downloaded"
    digest = sha256_file(artifact)
    if item.fetch.sha256 is None:
        return True, f"{item.key}: not pinned; SHA-256 is {digest}"
    if digest != item.fetch.sha256:
        return False, f"{item.key}: SHA-256 mismatch (got {digest})"
    return True, f"{item.key}: OK"


def _select(items: dict[str, Item], keys: list[str], tier: Optional[str]) -> list[Item]:
    unknown = [k for k in keys if k not in items]
    if unknown:
        raise SystemExit(f"Unknown item(s): {', '.join(unknown)}. Run `python -m corpus.fetch list`.")
    chosen = [items[k] for k in keys]
    if tier:
        chosen += [i for i in items.values() if tier in i.tiers and i not in chosen]
    if not chosen:
        raise SystemExit("Name at least one item, or pass --tier.")
    return chosen


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m corpus.fetch", description=__doc__.split("\n\n")[0])
    parser.add_argument("--cache", type=Path, help="cache folder (default: $OPENEXTRACT_CORPUS_CACHE or ~/.cache/openextract-corpus)")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("list", help="list items and whether they are fetched")
    p_fetch = sub.add_parser("fetch", help="download, verify and unpack items")
    p_fetch.add_argument("keys", nargs="*")
    p_fetch.add_argument("--tier", help="also fetch every item in this tier (e.g. weekly)")
    p_fetch.add_argument("--force", action="store_true", help="download again even if cached")
    p_verify = sub.add_parser("verify", help="re-hash downloaded artifacts")
    p_verify.add_argument("keys", nargs="*")
    p_verify.add_argument("--tier")
    p_path = sub.add_parser("path", help="print an item's unpacked backup folder")
    p_path.add_argument("key")
    args = parser.parse_args(argv)

    root = args.cache.expanduser() if args.cache else cache_root()
    items = load_manifest()

    if args.command == "list":
        print(f"cache: {root}")
        for item in items.values():
            state = "fetched" if is_fetched(item, root) else ("manual" if item.fetch.method == "manual" else "-")
            tiers = ",".join(item.tiers) or "-"
            enc = "encrypted" if item.encrypted else "plain"
            print(f"  {item.key:28} iOS {item.ios:8} {enc:9} tiers={tiers:8} {state}")
        return 0

    if args.command == "path":
        if args.key not in items:
            raise SystemExit(f"Unknown item: {args.key}")
        backup_dir = items[args.key].backup_dir(root)
        if backup_dir is None:
            print(f"{args.key} is not fetched", file=sys.stderr)
            return 1
        print(backup_dir)
        return 0

    chosen = _select(items, args.keys, args.tier)
    failures = 0
    for item in chosen:
        try:
            if args.command == "fetch":
                fetch_item(item, root, force=args.force)
            else:
                ok, message = verify_item(item, root)
                print(message)
                failures += not ok
        except remote.FetchError as e:
            print(f"ERROR: {e}", file=sys.stderr)
            failures += 1
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
