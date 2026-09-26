#!/usr/bin/env python3
"""
Build synthetic iPhone-backup fixtures for regression tests.

Writes tests/fixtures/synthetic_backup/<udid>/ and synthetic_backup_encrypted/<udid>/
with the minimum a backup folder needs for openextract's list_backups and
open_backup paths to recognize it: Manifest.db, Info.plist, Manifest.plist.

Small (<100 KB total) and idempotent — re-running reproduces byte-identical
files. Commit the output so contributors don't have to run this script.

Run:
    python tests/fixtures/build_fixture.py
"""

import os
import plistlib
import shutil
import sqlite3
from datetime import datetime

FIXTURE_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "synthetic_backup")
ENCRYPTED_FIXTURE_ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "synthetic_backup_encrypted")
BACKUP_UDID = "e2e000000000000000000000000000000000001"
ENCRYPTED_UDID = "e2e000000000000000000000000000000000002"
BACKUP_DIR = os.path.join(FIXTURE_ROOT, BACKUP_UDID)
ENCRYPTED_DIR = os.path.join(ENCRYPTED_FIXTURE_ROOT, ENCRYPTED_UDID)


def write_manifest_db(path: str) -> None:
    """Empty Manifest.db with the Files table openextract expects."""
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


def write_info_plist(path: str, udid: str, device_name: str) -> None:
    with open(path, "wb") as f:
        plistlib.dump(
            {
                "Unique Identifier": udid.upper(),
                "Device Name": device_name,
                "Display Name": device_name,
                "Product Type": "iPhone14,2",
                "Product Version": "17.0",
                "Serial Number": "E2ETEST0001",
                "Phone Number": "",
                "Last Backup Date": datetime(2024, 1, 1, 12, 0, 0),
                "iTunes Version": "12.0",
            },
            f,
        )


def write_manifest_plist(path: str, encrypted: bool) -> None:
    with open(path, "wb") as f:
        plistlib.dump(
            {
                "IsEncrypted": encrypted,
                "Version": "10.0",
                "Date": datetime(2024, 1, 1, 12, 0, 0),
                "SystemDomainsVersion": "20.0",
                "WasPasscodeSet": encrypted,
            },
            f,
        )


def build_backup(root_dir: str, backup_dir: str, udid: str, device_name: str, encrypted: bool) -> None:
    if os.path.exists(root_dir):
        shutil.rmtree(root_dir)
    os.makedirs(backup_dir, exist_ok=True)
    write_manifest_db(os.path.join(backup_dir, "Manifest.db"))
    write_info_plist(os.path.join(backup_dir, "Info.plist"), udid, device_name)
    write_manifest_plist(os.path.join(backup_dir, "Manifest.plist"), encrypted=encrypted)


def main() -> None:
    build_backup(FIXTURE_ROOT, BACKUP_DIR, BACKUP_UDID, "E2E Test iPhone", encrypted=False)
    print(f"Wrote unencrypted fixture to {BACKUP_DIR}")
    build_backup(ENCRYPTED_FIXTURE_ROOT, ENCRYPTED_DIR, ENCRYPTED_UDID, "E2E Encrypted iPhone", encrypted=True)
    print(f"Wrote encrypted fixture to {ENCRYPTED_DIR}")


if __name__ == "__main__":
    main()
