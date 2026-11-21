"""Check the backup file reference (website/backup-files/files.json) against real backups.

For each public backup in the corpus cache (corpus/manifest.json, fetched with
`python -m corpus.fetch fetch <item>`), this looks up every file's fileID in the backup's
Manifest.db and, where the backup can be read, opens a copy of the file and records:

- the names of its tables (SQLite files),
- which of the file's key columns (files.json "keyColumns") each table has,
- which of the file's key names (files.json "keyNames") a property list has,
- whether the file's companions (files.json "companions", such as sms.db-wal) are listed.

It writes website/backup-files/verified.json, which scripts/build-backup-file-pages.mjs turns
into the pages. Only structure is recorded: table, column and key names. Never row data,
names, messages, numbers or file contents. Encrypted backups are opened with ios-backup-core
and the password their creator published; one without a published password counts only if
its Manifest.db can be read as it is, and then only for the file list.

Run it from the repository root with the Python environment you use for python/:

    python scripts/verify-backup-files.py
"""

from __future__ import annotations

import glob
import json
import os
import plistlib
import shutil
import sqlite3
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FILES_JSON = os.path.join(ROOT, "website", "backup-files", "files.json")
VERIFIED_JSON = os.path.join(ROOT, "website", "backup-files", "verified.json")
CORPUS_MANIFEST = os.path.join(ROOT, "corpus", "manifest.json")
CACHE = os.environ.get("OPENEXTRACT_CORPUS_CACHE", os.path.expanduser("~/.cache/openextract-corpus"))
SQLITE_HEADER = b"SQLite format 3\x00"


def version_key(v: str) -> tuple:
    return tuple(int(p) for p in v.split("."))


def find_backup_dir(item_key: str) -> str | None:
    """The folder holding Manifest.db: <cache>/<item>/backup or a folder inside it."""
    root = os.path.join(CACHE, item_key, "backup")
    if os.path.isfile(os.path.join(root, "Manifest.db")):
        return root
    for d in sorted(glob.glob(os.path.join(root, "*"))):
        if os.path.isfile(os.path.join(d, "Manifest.db")):
            return d
    return None


def is_plain_sqlite(path: str) -> bool:
    with open(path, "rb") as f:
        return f.read(len(SQLITE_HEADER)) == SQLITE_HEADER


def copy_database(src: str, dest_dir: str, name: str) -> str:
    """Copy a database, with its -wal if it has one beside it, so the backup is never opened."""
    dest = os.path.join(dest_dir, name)
    shutil.copyfile(src, dest)
    if os.path.isfile(src + "-wal") and os.path.getsize(src + "-wal") > 0:
        shutil.copyfile(src + "-wal", dest + "-wal")
    return dest


def read_structure(db_path: str, key_columns: dict) -> tuple[list, dict]:
    """Table names, and which of the key columns each table has. Reads no rows.

    db_path is a copy in a temp folder. It's opened read-write only so SQLite can apply its -wal
    (which needs a -shm beside it); query_only stops any statement from changing it.
    """
    conn = sqlite3.connect(db_path)
    try:
        conn.execute("PRAGMA query_only = 1")
        tables = sorted(
            r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")
            if not r[0].startswith("sqlite_")
        )
        columns = {}
        for table, wanted in key_columns.items():
            if table not in tables:
                continue
            have = {r[1] for r in conn.execute(f'PRAGMA table_info("{table}")')}
            columns[table] = [c for c in wanted if c in have]
        return tables, columns
    finally:
        conn.close()


def read_plist_keys(path: str, wanted: list) -> list:
    with open(path, "rb") as f:
        data = plistlib.load(f)
    return [k for k in wanted if isinstance(data, dict) and k in data]


class ManifestLookup:
    """Exact (domain, relativePath) → fileID lookups in one backup's file list."""

    def __init__(self, accessor=None, manifest_path=None):
        self.accessor = accessor
        self.conn = None
        if manifest_path:
            self.conn = sqlite3.connect(f"file:{manifest_path}?mode=ro&immutable=1", uri=True)

    def file_id(self, domain: str, path: str) -> str | None:
        if self.conn is not None:
            row = self.conn.execute(
                "SELECT fileID FROM Files WHERE domain = ? AND relativePath = ? AND flags = 1", (domain, path)
            ).fetchone()
            return row[0] if row else None
        # LIKE treats _ and % as wildcards, so keep only exact matches.
        for e in self.accessor.list_files(domain=domain, path_like=path):
            if e.get("domain") == domain and e.get("path") == path:
                return e.get("hash")
        return None

    def close(self):
        if self.conn is not None:
            self.conn.close()


def main() -> int:
    try:
        from ios_backup_core.backup import open_local_backup
    except ImportError:
        print("ios-backup-core isn't installed in this Python (see python/requirements.txt).", file=sys.stderr)
        return 1

    with open(FILES_JSON, encoding="utf-8") as f:
        files = json.load(f)["files"]
    with open(CORPUS_MANIFEST, encoding="utf-8") as f:
        items = [i for i in json.load(f)["items"] if i.get("layer") == "pub"]

    backups = []
    results = {
        f["slug"]: {"seenIn": [], "notSeenIn": [], "tables": {}, "columns": {}, "keys": {}, "companions": {}}
        for f in files
    }

    for item in items:
        backup_dir = find_backup_dir(item["key"])
        if not backup_dir:
            continue
        with open(os.path.join(backup_dir, "Manifest.plist"), "rb") as f:
            encrypted = bool(plistlib.load(f).get("IsEncrypted"))
        manifest_db = os.path.join(backup_dir, "Manifest.db")
        accessor = lookup = None
        if encrypted and item.get("password"):
            accessor = open_local_backup(backup_dir, password=item["password"])
            lookup = ManifestLookup(accessor=accessor)
            contents = "read"
        elif encrypted and is_plain_sqlite(manifest_db):
            # A backup published with its Manifest.db already decrypted (FCSC 2025): the file
            # list can be read, the files can't.
            lookup = ManifestLookup(manifest_path=manifest_db)
            contents = "file list only"
        elif not encrypted:
            accessor = open_local_backup(backup_dir)
            lookup = ManifestLookup(accessor=accessor)
            contents = "read"
        else:
            print(f"{item['key']}: encrypted and no published password, skipped")
            continue

        ios = item["ios"]
        backups.append({"item": item["key"], "ios": ios, "encrypted": encrypted, "contents": contents})
        print(f"{item['key']} (iOS {ios}, {'encrypted' if encrypted else 'not encrypted'}): {contents}")
        work = tempfile.mkdtemp(prefix="backup-file-reference-")
        try:
            for spec in files:
                r = results[spec["slug"]]
                found = lookup.file_id(spec["domain"], spec["relativePath"])
                if found != spec["fileID"]:
                    r["notSeenIn"].append(ios)
                    if found:
                        print(f"  {spec['slug']}: listed under {found}, not {spec['fileID']}", file=sys.stderr)
                    continue
                r["seenIn"].append(ios)
                for comp in spec.get("companions", []):
                    present = lookup.file_id(comp.get("domain", spec["domain"]), comp["relativePath"]) is not None
                    r["companions"].setdefault(comp["relativePath"], {})[ios] = present
                if accessor is None:
                    continue
                if spec["kind"] == "sqlite":
                    src = accessor.get_database(spec["relativePath"], spec["domain"])
                    if not src:
                        print(f"  {spec['slug']}: listed but couldn't be read", file=sys.stderr)
                        continue
                    copy = copy_database(src, tempfile.mkdtemp(dir=work), os.path.basename(spec["relativePath"]))
                    tables, columns = read_structure(copy, spec.get("keyColumns", {}))
                    r["tables"][ios] = tables
                    r["columns"][ios] = columns
                elif spec["kind"] == "plist":
                    src = accessor.get_file(spec["relativePath"], spec["domain"])
                    if src:
                        r["keys"][ios] = read_plist_keys(src, spec.get("keyNames", []))
        finally:
            shutil.rmtree(work, ignore_errors=True)
            lookup.close()
            if accessor is not None:
                accessor.cleanup()

    backups.sort(key=lambda b: version_key(b["ios"]))
    for r in results.values():
        r["seenIn"].sort(key=version_key)
        r["notSeenIn"].sort(key=version_key)
        for name in ("tables", "columns", "keys"):
            r[name] = {v: r[name][v] for v in sorted(r[name], key=version_key)}
        for comp, seen in r["companions"].items():
            r["companions"][comp] = {v: seen[v] for v in sorted(seen, key=version_key)}
        for empty in [k for k in ("columns", "keys", "companions") if not r[k]]:
            del r[empty]

    out = {
        "about": "Written by scripts/verify-backup-files.py from the public backups in corpus/manifest.json. "
                 "Structure only (table, column and key names); no row data.",
        "backups": backups,
        "files": results,
    }
    with open(VERIFIED_JSON, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")
    missing = [s for s, r in results.items() if not r["seenIn"]]
    print(f"Wrote {os.path.relpath(VERIFIED_JSON, ROOT)}: {len(results) - len(missing)} of {len(results)} files seen.")
    if missing:
        print("Not seen in any backup (drop them or find a backup that has them): " + ", ".join(missing))
    return 0


if __name__ == "__main__":
    sys.exit(main())
