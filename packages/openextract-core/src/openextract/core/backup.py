"""Backup opening, validation, and file access.

Provides a unified BackupReader that works for both encrypted and
unencrypted iPhone backups. Extractors receive a BackupReader and
call get_file() without caring which mode is active.
"""
from __future__ import annotations

import hashlib
import os
import platform
import sqlite3
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass, field
from pathlib import Path
from typing import Generator


@dataclass
class BackupInfo:
    """Metadata parsed from Manifest.plist / Info.plist."""

    udid: str
    path: Path
    device_name: str | None = None
    product_type: str | None = None
    ios_version: str | None = None
    last_backup_date: str | None = None
    is_encrypted: bool = False
    size_bytes: int = 0


def default_backup_directories() -> list[Path]:
    """Return platform-default backup search paths."""
    system = platform.system()
    if system == "Darwin":
        return [Path.home() / "Library" / "Application Support" / "MobileSync" / "Backup"]
    if system == "Windows":
        candidates = []
        for base in ["APPDATA", "LOCALAPPDATA"]:
            root = os.environ.get(base)
            if root:
                candidates.append(
                    Path(root) / "Apple Computer" / "MobileSync" / "Backup"
                )
                candidates.append(Path(root) / "Apple" / "MobileSync" / "Backup")
        return candidates
    # Linux / fallback
    return [Path.home() / "MobileSync" / "Backup"]


def discover_backups(search_path: Path | None = None) -> list[BackupInfo]:
    """Scan a directory for iPhone backup folders and return metadata."""
    import plistlib

    roots = [search_path] if search_path else default_backup_directories()
    found: list[BackupInfo] = []

    for root in roots:
        if not root.is_dir():
            continue
        for entry in root.iterdir():
            if not entry.is_dir():
                continue
            manifest = entry / "Manifest.plist"
            info_plist = entry / "Info.plist"
            if not manifest.exists():
                continue
            try:
                with open(manifest, "rb") as f:
                    mdata = plistlib.load(f)
                info: dict = {}
                if info_plist.exists():
                    with open(info_plist, "rb") as f:
                        info = plistlib.load(f)

                size = sum(
                    f.stat().st_size
                    for f in entry.rglob("*")
                    if f.is_file()
                )
                found.append(
                    BackupInfo(
                        udid=entry.name,
                        path=entry,
                        device_name=info.get("Device Name"),
                        product_type=info.get("Product Type"),
                        ios_version=info.get("Product Version"),
                        last_backup_date=str(info.get("Last Backup Date", "")),
                        is_encrypted=mdata.get("IsEncrypted", False),
                        size_bytes=size,
                    )
                )
            except Exception:
                continue

    return found


class BackupReader:
    """Unified file-access abstraction over an iPhone backup.

    Usage::

        reader = BackupReader.open("/path/to/backup")
        # or for encrypted:
        reader = BackupReader.open("/path/to/backup", password="secret")

        with reader.file("Library/SMS/sms.db") as f:
            data = f.read()

        path = reader.extract_to_temp("Library/SMS/sms.db")
    """

    def __init__(self, backup_path: Path, _encrypted_backup=None):
        self._path = Path(backup_path)
        self._encrypted = _encrypted_backup
        self._temp_files: list[Path] = []
        self._manifest_db: sqlite3.Connection | None = None

    @classmethod
    def open(cls, backup_path: str | Path, password: str | None = None) -> "BackupReader":
        """Open a backup.  Raises ValueError if password is wrong."""
        path = Path(backup_path)
        if not path.is_dir():
            raise FileNotFoundError(f"Backup directory not found: {path}")

        manifest = path / "Manifest.plist"
        if not manifest.exists():
            raise FileNotFoundError(f"Not a valid backup (no Manifest.plist): {path}")

        import plistlib

        with open(manifest, "rb") as f:
            mdata = plistlib.load(f)

        is_encrypted = mdata.get("IsEncrypted", False)

        if is_encrypted:
            if password is None:
                raise ValueError("password_required")
            try:
                from iphone_backup_decrypt import EncryptedBackup

                enc = EncryptedBackup(backup_directory=str(path), passphrase=password)
            except Exception as exc:
                raise ValueError(f"wrong_password: {exc}") from exc
            return cls(path, _encrypted_backup=enc)

        return cls(path)

    @classmethod
    def validate_password(cls, backup_path: str | Path, password: str) -> bool:
        """Return True if the password is correct for an encrypted backup."""
        try:
            cls.open(backup_path, password=password)
            return True
        except ValueError as exc:
            if "wrong_password" in str(exc):
                return False
            raise

    # ------------------------------------------------------------------
    # File access
    # ------------------------------------------------------------------

    def _manifest_connection(self) -> sqlite3.Connection:
        if self._manifest_db is None:
            db_path = self._path / "Manifest.db"
            if not db_path.exists():
                raise FileNotFoundError("Manifest.db not found in backup")
            self._manifest_db = sqlite3.connect(str(db_path))
        return self._manifest_db

    def _hash_for_domain_path(self, domain: str, relative_path: str) -> str | None:
        try:
            conn = self._manifest_connection()
            row = conn.execute(
                "SELECT fileID FROM Files WHERE domain=? AND relativePath=?",
                (domain, relative_path),
            ).fetchone()
            return row[0] if row else None
        except Exception:
            return None

    def _resolve_hash(self, backup_relative_path: str) -> str | None:
        """Given a path like 'Library/SMS/sms.db', find its SHA1 hash."""
        # Try common domain prefixes
        domain_map = [
            ("AppDomain", ""),
            ("HomeDomain", ""),
            ("AppDomainGroup", ""),
            ("RootDomain", ""),
            ("CameraRollDomain", ""),
            ("MediaDomain", ""),
            ("HomeDomain", "Library/"),
        ]
        # Direct hash lookup
        conn = self._manifest_connection()
        row = conn.execute(
            "SELECT fileID FROM Files WHERE relativePath=?",
            (backup_relative_path,),
        ).fetchone()
        if row:
            return row[0]

        # Try with domain prefixes
        for domain, prefix in domain_map:
            file_hash = self._hash_for_domain_path(
                domain, prefix + backup_relative_path
            )
            if file_hash:
                return file_hash
        return None

    def get_file_path(self, backup_relative_path: str) -> Path | None:
        """Return the on-disk path for a backup-relative file path.

        For encrypted backups, the file is extracted to a temp path.
        Returns None if the file is not found in the backup.
        """
        if self._encrypted is not None:
            tmp = Path(tempfile.mktemp(suffix=Path(backup_relative_path).suffix))
            try:
                self._encrypted.extract_file(
                    relative_path=backup_relative_path,
                    output_filename=str(tmp),
                )
                self._temp_files.append(tmp)
                return tmp if tmp.exists() else None
            except Exception:
                return None

        # Unencrypted: look up SHA1 from Manifest.db
        file_hash = self._resolve_hash(backup_relative_path)
        if not file_hash:
            return None
        hashed_path = self._path / file_hash[:2] / file_hash
        return hashed_path if hashed_path.exists() else None

    @contextmanager
    def file(self, backup_relative_path: str) -> Generator[bytes, None, None]:
        """Context manager yielding file bytes, or raises FileNotFoundError."""
        path = self.get_file_path(backup_relative_path)
        if path is None:
            raise FileNotFoundError(
                f"File not found in backup: {backup_relative_path}"
            )
        yield path.read_bytes()

    def extract_to_temp(self, backup_relative_path: str) -> Path:
        """Extract a file to a temporary path and return it.

        Caller is responsible for cleanup, or call close() on the reader.
        """
        path = self.get_file_path(backup_relative_path)
        if path is None:
            raise FileNotFoundError(
                f"File not found in backup: {backup_relative_path}"
            )
        # If already a temp copy (encrypted), return as-is
        if path in self._temp_files:
            return path
        # For unencrypted files the path IS the backup file — copy to temp
        import shutil

        tmp = Path(tempfile.mktemp(suffix=path.suffix))
        shutil.copy2(path, tmp)
        self._temp_files.append(tmp)
        return tmp

    def find_files(self, domain: str | None = None, path_like: str | None = None) -> list[dict]:
        """Search the manifest for files matching domain/path patterns."""
        conn = self._manifest_connection()
        query = "SELECT fileID, domain, relativePath, flags FROM Files WHERE 1=1"
        params: list = []
        if domain:
            query += " AND domain LIKE ?"
            params.append(f"%{domain}%")
        if path_like:
            query += " AND relativePath LIKE ?"
            params.append(f"%{path_like}%")
        rows = conn.execute(query, params).fetchall()
        return [
            {"hash": r[0], "domain": r[1], "path": r[2], "flags": r[3]}
            for r in rows
        ]

    def close(self):
        """Clean up temp files and close manifest DB."""
        if self._manifest_db:
            self._manifest_db.close()
            self._manifest_db = None
        for tmp in self._temp_files:
            try:
                tmp.unlink(missing_ok=True)
            except Exception:
                pass
        self._temp_files.clear()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        self.close()
