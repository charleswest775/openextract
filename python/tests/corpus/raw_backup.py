"""Independent access to a backup's raw files, used as ground truth by the invariants.

This deliberately does not go through ios-backup-core or the sidecar: encrypted
backups are opened with ``iphone_backup_decrypt`` directly, unencrypted ones by
looking up ``Manifest.db`` and copying the hashed file. Databases are copied
into a scratch folder together with their ``-wal``/``-shm`` files, so rows that
were never checkpointed are counted too.
"""

from __future__ import annotations

import plistlib
import shutil
import sqlite3
import tempfile
from pathlib import Path
from typing import Optional


class RawBackup:
    def __init__(self, backup_dir: Path, password: Optional[str] = None):
        self.backup_dir = Path(backup_dir)
        with open(self.backup_dir / "Manifest.plist", "rb") as f:
            self.manifest_plist = plistlib.load(f)
        self.encrypted = bool(self.manifest_plist.get("IsEncrypted"))
        self._tmp = tempfile.TemporaryDirectory(prefix="openextract-raw-")
        self.workdir = Path(self._tmp.name)
        self._extracted: dict[tuple[str, str], Optional[Path]] = {}
        self._encrypted_backup = None
        if self.encrypted:
            if not password:
                raise ValueError("encrypted backup needs a password")
            from iphone_backup_decrypt import EncryptedBackup

            self._encrypted_backup = EncryptedBackup(backup_directory=str(self.backup_dir), passphrase=password)
            self.manifest_db = self.workdir / "Manifest.db"
            self._encrypted_backup.save_manifest_file(str(self.manifest_db))
        else:
            self.manifest_db = self.workdir / "Manifest.db"
            shutil.copyfile(self.backup_dir / "Manifest.db", self.manifest_db)
        self._manifest = sqlite3.connect(str(self.manifest_db))

    def close(self) -> None:
        self._manifest.close()
        self._tmp.cleanup()

    # ── Manifest.db ──────────────────────────────────────────────────────────

    def file_id(self, domain: str, relative_path: str) -> Optional[str]:
        row = self._manifest.execute(
            "SELECT fileID FROM Files WHERE domain = ? AND relativePath = ? AND flags = 1",
            (domain, relative_path),
        ).fetchone()
        return row[0] if row else None

    def has_file(self, domain: str, relative_path: str) -> bool:
        return self.file_id(domain, relative_path) is not None

    def find_files(self, relative_path_like: str, domain_like: str = "%") -> list[tuple[str, str]]:
        """(domain, relativePath) for regular files matching the LIKE patterns."""
        return self._manifest.execute(
            "SELECT domain, relativePath FROM Files WHERE domain LIKE ? AND relativePath LIKE ? AND flags = 1 "
            "ORDER BY domain, relativePath",
            (domain_like, relative_path_like),
        ).fetchall()

    def file_count(self) -> int:
        return self._manifest.execute("SELECT COUNT(*) FROM Files WHERE flags = 1").fetchone()[0]

    # ── extraction ───────────────────────────────────────────────────────────

    def _extract_one(self, domain: str, relative_path: str, dest: Path) -> bool:
        if not self.has_file(domain, relative_path):
            return False
        if self._encrypted_backup is not None:
            self._encrypted_backup.extract_file(
                relative_path=relative_path, domain_like=domain, output_filename=str(dest)
            )
        else:
            file_id = self.file_id(domain, relative_path)
            shutil.copyfile(self.backup_dir / file_id[:2] / file_id, dest)
        return True

    def db_path(self, domain: str, relative_path: str) -> Optional[Path]:
        """A local copy of a database (with its -wal/-shm files), or None if it isn't in the backup."""
        key = (domain, relative_path)
        if key not in self._extracted:
            folder = self.workdir / f"db{len(self._extracted)}"
            folder.mkdir()
            dest = folder / Path(relative_path).name
            if self._extract_one(domain, relative_path, dest):
                for suffix in ("-wal", "-shm"):
                    self._extract_one(domain, relative_path + suffix, folder / (dest.name + suffix))
                self._extracted[key] = dest
            else:
                self._extracted[key] = None
        return self._extracted[key]

    def connect(self, domain: str, relative_path: str) -> Optional[sqlite3.Connection]:
        path = self.db_path(domain, relative_path)
        if path is None:
            return None
        conn = sqlite3.connect(str(path))
        conn.row_factory = sqlite3.Row
        return conn

    def query(self, domain: str, relative_path: str, sql: str, params: tuple = ()) -> Optional[list[sqlite3.Row]]:
        conn = self.connect(domain, relative_path)
        if conn is None:
            return None
        try:
            return conn.execute(sql, params).fetchall()
        finally:
            conn.close()

    @staticmethod
    def columns(conn: sqlite3.Connection, table: str) -> set[str]:
        return {row[1] for row in conn.execute(f"PRAGMA table_info({table})")}

    @staticmethod
    def tables(conn: sqlite3.Connection) -> set[str]:
        return {row[0] for row in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
