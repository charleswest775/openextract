#!/usr/bin/env python3
"""
Build a synthetic iPhone backup fixture for regression tests.

Writes tests/fixtures/synthetic_backup/<udid>/ with Manifest.db, Info.plist,
and Manifest.plist — the minimum a backup folder needs for openextract's
list_backups and open_backup paths to recognize it.

The fixture is intentionally tiny (<100 KB) and idempotent: re-running this
script reproduces the same folder structure. Commit the generated files so
contributors don't have to run the script locally.

Run:
    python tests/fixtures/build_fixture.py
"""

import os
import plistlib
import shutil
import sqlite3
from datetime import datetime

FIXTURE_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "synthetic_backup")
BACKUP_UDID = "e2e000000000000000000000000000000000001"
BACKUP_DIR = os.path.join(FIXTURE_ROOT, BACKUP_UDID)


def write_manifest_db(path: str) -> None:
    """Write a minimal Manifest.db with the Files table openextract expects."""
    if os.path.exists(path):
        os.remove(path)
    conn = sqlite3.connect(path)
    try:
        conn.executescript(
            """
            CREATE TABLE Files (
                fileID TEXT PRIMARY KEY,
                domain TEXT,
                relativePath TEXT,
                flags INTEGER,
                file BLOB
            );
            CREATE INDEX FilesDomain ON Files(domain);
            CREATE INDEX FilesRelativePath ON Files(relativePath);
            """
        )
        conn.commit()
    finally:
        conn.close()


def write_info_plist(path: str) -> None:
    plistlib.dump(
        {
            "Unique Identifier": BACKUP_UDID.upper(),
            "Device Name": "E2E Test iPhone",
            "Display Name": "E2E Test iPhone",
            "Product Type": "iPhone14,2",
            "Product Version": "17.0",
            "Serial Number": "E2ETEST0001",
            "Phone Number": "",
            "Last Backup Date": datetime(2024, 1, 1, 12, 0, 0),
            "iTunes Version": "12.0",
        },
        open(path, "wb"),
    )


def write_manifest_plist(path: str) -> None:
    plistlib.dump(
        {
            "IsEncrypted": False,
            "Version": "10.0",
            "Date": datetime(2024, 1, 1, 12, 0, 0),
            "SystemDomainsVersion": "20.0",
            "WasPasscodeSet": False,
        },
        open(path, "wb"),
    )


def main() -> None:
    if os.path.exists(FIXTURE_ROOT):
        shutil.rmtree(FIXTURE_ROOT)
    os.makedirs(BACKUP_DIR, exist_ok=True)

    write_manifest_db(os.path.join(BACKUP_DIR, "Manifest.db"))
    write_info_plist(os.path.join(BACKUP_DIR, "Info.plist"))
    write_manifest_plist(os.path.join(BACKUP_DIR, "Manifest.plist"))

    print(f"Wrote fixture to {BACKUP_DIR}")


if __name__ == "__main__":
    main()
