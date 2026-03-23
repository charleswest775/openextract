"""
Backup discovery, validation, and management.
Handles both encrypted and unencrypted iTunes/Finder backups.
"""

import os
import sys
import json
import plistlib
import sqlite3
import tempfile
import time
from pathlib import Path
from datetime import datetime
from typing import Optional


def _size_cache_path() -> str:
    cache_dir = os.path.join(Path.home(), ".openextract")
    os.makedirs(cache_dir, exist_ok=True)
    return os.path.join(cache_dir, "size_cache.json")


def _load_size_cache() -> dict:
    try:
        with open(_size_cache_path(), "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def _save_size_cache(cache: dict) -> None:
    try:
        with open(_size_cache_path(), "w", encoding="utf-8") as f:
            json.dump(cache, f)
    except Exception:
        pass


def _tlog(msg: str) -> None:
    try:
        with open("python_log.txt", "a", encoding="utf-8") as f:
            f.write(f"[TIMING {time.strftime('%H:%M:%S')}] {msg}\n")
    except Exception:
        pass


# Files that must be decrypted before any data is accessible.
# Pre-warming these during open_backup avoids 10-15s stalls on first use.
_PREWARM_FILES = [
    ("Library/AddressBook/AddressBook.sqlitedb", "HomeDomain"),
    ("Library/SMS/sms.db",                       "HomeDomain"),
]

# Try to import iphone_backup_decrypt for encrypted backups
try:
    from iphone_backup_decrypt import EncryptedBackup
    HAS_DECRYPT = True
except ImportError:
    HAS_DECRYPT = False


class OpenBackup:
    """Represents an opened (and possibly decrypted) backup."""

    def __init__(self, backup_dir: str, udid: str, info: dict, encrypted: bool,
                 decrypted_backup=None):
        self.backup_dir = backup_dir
        self.udid = udid
        self.info = info
        self.encrypted = encrypted
        self._decrypted_backup = decrypted_backup  # EncryptedBackup instance
        self._manifest_db_path: Optional[str] = None
        self._temp_dir = tempfile.mkdtemp(prefix="openextract_")
        self._file_cache: dict = {}

    def get_file(self, relative_path: str, domain: str = "HomeDomain") -> Optional[str]:
        """
        Extract a file from the backup and return its path on disk.
        For unencrypted backups, looks up the hash in Manifest.db.
        For encrypted backups, uses iphone_backup_decrypt.
        """
        cache_key = f"{domain}:{relative_path}"
        if cache_key in self._file_cache:
            return self._file_cache[cache_key]

        output_path = os.path.join(
            self._temp_dir,
            relative_path.replace("/", "--").replace("\\", "--")
        )

        if self.encrypted and self._decrypted_backup:
            try:
                self._decrypted_backup.extract_file(
                    relative_path=relative_path,
                    domain_like=domain,
                    output_filename=output_path
                )
                if os.path.exists(output_path):
                    self._file_cache[cache_key] = output_path
                    return output_path
            except Exception as e:
                print(f"[backup.get_file] extract_file failed for {domain}:{relative_path}: {e}", file=sys.stderr, flush=True)
                return None
        else:
            # Unencrypted: look up file hash in Manifest.db
            file_hash = self._lookup_file_hash(relative_path, domain)
            if file_hash:
                source = os.path.join(self.backup_dir, file_hash[:2], file_hash)
                if os.path.exists(source):
                    # For unencrypted, we can read directly
                    self._file_cache[cache_key] = source
                    return source

        return None

    def get_manifest_db(self) -> Optional[str]:
        """Get path to a readable copy of Manifest.db."""
        if self._manifest_db_path and os.path.exists(self._manifest_db_path):
            return self._manifest_db_path

        manifest_path = os.path.join(self.backup_dir, "Manifest.db")
        if os.path.exists(manifest_path):
            self._manifest_db_path = manifest_path
            return manifest_path

        return None

    def _lookup_file_hash(self, relative_path: str, domain: str) -> Optional[str]:
        """Look up the SHA1 hash for a file in Manifest.db."""
        manifest = self.get_manifest_db()
        if not manifest:
            return None

        try:
            conn = sqlite3.connect(manifest)
            cursor = conn.execute(
                "SELECT fileID FROM Files WHERE relativePath = ? AND domain = ?",
                (relative_path, domain)
            )
            row = cursor.fetchone()
            conn.close()
            return row[0] if row else None
        except Exception:
            return None

    def list_files(self, domain: Optional[str] = None,
                   path_like: Optional[str] = None) -> list:
        """List files in the backup matching optional filters."""
        if self.encrypted and self._decrypted_backup:
            # For encrypted backups, query the library's decrypted manifest.
            try:
                query = "SELECT fileID, domain, relativePath FROM Files WHERE flags=1"
                params = []
                if domain:
                    query += " AND domain = ?"
                    params.append(domain)
                if path_like:
                    query += " AND relativePath LIKE ?"
                    params.append(path_like)
                with self._decrypted_backup.manifest_db_cursor() as cur:
                    cur.execute(query, params)
                    return [
                        {"hash": row[0], "domain": row[1], "path": row[2]}
                        for row in cur.fetchall()
                    ]
            except Exception as e:
                print(f"[backup.list_files] encrypted manifest query failed: {e}", file=sys.stderr, flush=True)
                return []

        manifest = self.get_manifest_db()
        if not manifest:
            return []

        try:
            conn = sqlite3.connect(manifest)
            query = "SELECT fileID, domain, relativePath FROM Files WHERE 1=1"
            params = []

            if domain:
                query += " AND domain = ?"
                params.append(domain)
            if path_like:
                query += " AND relativePath LIKE ?"
                params.append(path_like)

            cursor = conn.execute(query, params)
            results = [
                {"hash": row[0], "domain": row[1], "path": row[2]}
                for row in cursor.fetchall()
            ]
            conn.close()
            return results
        except Exception:
            return []

    def cleanup(self):
        """Clean up temporary files."""
        import shutil
        if os.path.exists(self._temp_dir):
            shutil.rmtree(self._temp_dir, ignore_errors=True)


class BackupManager:
    """Discovers and manages iPhone backups."""

    def __init__(self):
        self._open_backups: dict[str, OpenBackup] = {}

    def _get_default_backup_dirs(self) -> list[str]:
        """Return platform-specific default backup locations."""
        dirs = []
        if sys.platform == "darwin":
            home = Path.home()
            dirs.append(str(home / "Library" / "Application Support" / "MobileSync" / "Backup"))
        elif sys.platform == "win32":
            # APPDATA — classic iTunes (Apple website installer)
            appdata = os.environ.get("APPDATA", "")
            if appdata:
                dirs.append(os.path.join(appdata, "Apple Computer", "MobileSync", "Backup"))
                dirs.append(os.path.join(appdata, "Apple", "MobileSync", "Backup"))
            # LOCALAPPDATA — Apple Devices app (Microsoft Store, Windows 11+)
            localappdata = os.environ.get("LOCALAPPDATA", "")
            if localappdata:
                dirs.append(os.path.join(localappdata, "Apple", "MobileSync", "Backup"))
                dirs.append(os.path.join(localappdata, "Apple Computer", "MobileSync", "Backup"))
            # USERPROFILE — some versions store directly in the user's home folder
            userprofile = os.environ.get("USERPROFILE", "")
            if userprofile:
                dirs.append(os.path.join(userprofile, "Apple", "MobileSync", "Backup"))
                dirs.append(os.path.join(userprofile, "Apple Computer", "MobileSync", "Backup"))
        else:
            home = Path.home()
            dirs.append(str(home / "MobileSync" / "Backup"))

        return [d for d in dirs if os.path.isdir(d)]

    def list_backups(self, custom_path: Optional[str] = None) -> dict:
        """Discover all iPhone backups on the system."""
        backups = []
        search_dirs = []

        if custom_path and os.path.isdir(custom_path):
            # Check if this IS a backup folder (has Manifest.db)
            if os.path.exists(os.path.join(custom_path, "Manifest.db")):
                search_dirs = [os.path.dirname(custom_path)]
            else:
                search_dirs = [custom_path]
        else:
            search_dirs = self._get_default_backup_dirs()

        for search_dir in search_dirs:
            try:
                for entry in os.listdir(search_dir):
                    backup_dir = os.path.join(search_dir, entry)
                    if not os.path.isdir(backup_dir):
                        continue

                    info = self._read_backup_info(backup_dir)
                    if info:
                        backups.append(info)
            except PermissionError:
                continue

        return {"backups": backups, "search_dirs": search_dirs}

    def _read_backup_info(self, backup_dir: str) -> Optional[dict]:
        """Read metadata from a backup directory."""
        info_plist = os.path.join(backup_dir, "Info.plist")
        manifest_plist = os.path.join(backup_dir, "Manifest.plist")
        manifest_db = os.path.join(backup_dir, "Manifest.db")

        if not os.path.exists(manifest_db):
            return None

        info = {}

        # Read Info.plist
        if os.path.exists(info_plist):
            try:
                with open(info_plist, "rb") as f:
                    plist = plistlib.load(f)
                info = {
                    "udid": plist.get("Unique Identifier", os.path.basename(backup_dir)),
                    "device_name": plist.get("Device Name", "Unknown"),
                    "product_type": plist.get("Product Type", "Unknown"),
                    "product_version": plist.get("Product Version", "Unknown"),
                    "serial_number": plist.get("Serial Number", ""),
                    "phone_number": plist.get("Phone Number", ""),
                    "last_backup": plist.get("Last Backup Date", ""),
                }
                # Convert datetime to ISO string
                if isinstance(info["last_backup"], datetime):
                    info["last_backup"] = info["last_backup"].isoformat()
            except Exception:
                info = {
                    "udid": os.path.basename(backup_dir),
                    "device_name": "Unknown",
                    "product_type": "Unknown",
                    "product_version": "Unknown",
                }
        else:
            # No Info.plist — still provide the required fields so the rest of the
            # code (open_backup, dashboard) doesn't crash on missing keys.
            info = {
                "udid": os.path.basename(backup_dir),
                "device_name": "Unknown",
                "product_type": "Unknown",
                "product_version": "Unknown",
                "serial_number": "",
                "phone_number": "",
                "last_backup": "",
            }

        # Read Manifest.plist for encryption status
        encrypted = False
        if os.path.exists(manifest_plist):
            try:
                with open(manifest_plist, "rb") as f:
                    manifest = plistlib.load(f)
                encrypted = manifest.get("IsEncrypted", False)
            except Exception:
                pass

        info["encrypted"] = encrypted
        info["backup_dir"] = backup_dir

        # Size is computed lazily via get_backup_size() to keep list_backups fast.
        info["size_bytes"] = None
        info["size_gb"] = None

        return info

    @staticmethod
    def _norm_udid(udid: str) -> str:
        """Normalise a UDID for comparison: strip dashes, lowercase."""
        return udid.replace("-", "").lower()

    def open_backup(self, udid: str, password: Optional[str] = None,
                    backup_dir: Optional[str] = None) -> dict:
        """
        Open a backup for reading. Decrypts if encrypted and password provided.
        Accepts an optional backup_dir to skip re-scanning — important when the
        backup was found via a custom/browse path or a non-default location.
        """
        _tlog(f"open_backup called: udid={udid!r} backup_dir={backup_dir!r}")
        backup_info = None
        norm_udid = self._norm_udid(udid)

        # Fast path: use the provided directory directly.
        # When backup_dir is explicitly supplied (e.g. immediately after
        # creating a backup), trust it unconditionally — do NOT reject on a
        # UDID mismatch because pymobiledevice3 may format UDIDs differently
        # from what iTunes writes into Info.plist.
        if backup_dir and os.path.isdir(backup_dir):
            _tlog("open_backup fast-path: dir exists, reading backup info")
            backup_info = self._read_backup_info(backup_dir)
            _tlog(f"open_backup fast-path: _read_backup_info returned {'OK' if backup_info else 'None'}")

            if not backup_info:
                # _resolve_backup_path in device_backup should have already resolved
                # the correct directory, but as a safety net scan one level deep.
                try:
                    subdirs = [e.name for e in os.scandir(backup_dir) if e.is_dir()]
                    _tlog(f"open_backup fast-path fallback scan: subdirs={subdirs!r}")
                    for entry in os.scandir(backup_dir):
                        if entry.is_dir():
                            backup_info = self._read_backup_info(entry.path)
                            if backup_info:
                                _tlog(f"open_backup fast-path fallback: found in subdir {entry.name!r}")
                                break
                except Exception as exc:
                    _tlog(f"open_backup fast-path fallback scan error: {exc}")

            if backup_info:
                _tlog(
                    f"open_backup fast-path OK: dir={backup_dir!r} "
                    f"udid_param={udid!r} udid_plist={backup_info.get('udid')!r}"
                )
            else:
                _tlog(
                    f"open_backup fast-path MISS: dir={backup_dir!r} "
                    f"udid_param={udid!r} — no Manifest.db found at this path or one level deep"
                )
        elif backup_dir:
            _tlog(f"open_backup: backup_dir supplied but is not a directory: {backup_dir!r}")

        # Slow path: scan all default locations
        if not backup_info:
            _tlog(f"open_backup slow-path: scanning default backup locations for udid={udid!r}")
            all_backups = self.list_backups()
            _tlog(f"open_backup slow-path: found {len(all_backups['backups'])} backup(s) in default dirs")
            for b in all_backups["backups"]:
                if self._norm_udid(b["udid"]) == norm_udid:
                    backup_info = b
                    _tlog(f"open_backup slow-path: matched udid in {b['backup_dir']!r}")
                    break

        if not backup_info:
            _tlog(f"open_backup FAILED: backup not found for udid={udid!r} backup_dir={backup_dir!r}")
            raise ValueError(f"Backup not found: {udid}")

        # Ensure udid is always present — _read_backup_info falls back to the
        # directory name when Info.plist is absent, but guard here as well.
        if not backup_info.get("udid"):
            _tlog(f"open_backup: backup_info missing udid, filling from param: {udid!r}")
            backup_info["udid"] = udid

        backup_dir = backup_info["backup_dir"]
        encrypted = backup_info["encrypted"]

        decrypted_backup = None
        if encrypted:
            if not password:
                return {
                    "status": "password_required",
                    "info": backup_info,
                }
            if not HAS_DECRYPT:
                raise RuntimeError(
                    "iphone_backup_decrypt is not installed. "
                    "Run: pip install iphone-backup-decrypt"
                )
            try:
                decrypted_backup = EncryptedBackup(
                    backup_directory=backup_dir,
                    passphrase=password
                )
                # Validate passphrase — EncryptedBackup.__init__ may succeed
                # with a wrong password; the real check happens when accessing
                # encrypted data.  Query the decrypted manifest to force
                # keybag decryption now so we can surface a clear error.
                with decrypted_backup.manifest_db_cursor() as cur:
                    cur.execute("SELECT COUNT(*) FROM Files")
            except Exception as e:
                raise ValueError(f"Failed to decrypt backup: {e}")

        backup = OpenBackup(
            backup_dir=backup_dir,
            udid=udid,
            info=backup_info,
            encrypted=encrypted,
            decrypted_backup=decrypted_backup,
        )

        self._open_backups[self._norm_udid(backup_info["udid"])] = backup

        # For encrypted backups, pre-decrypt the most-accessed files now so that
        # list_conversations / get_messages don't stall on first use.
        # Unencrypted get_file is a fast hash lookup — no pre-warm needed.
        if encrypted:
            t_pw = time.perf_counter()
            for path, domain in _PREWARM_FILES:
                t_f = time.perf_counter()
                result = backup.get_file(path, domain)
                _tlog(f"open_backup prewarm {path}: {time.perf_counter()-t_f:.3f}s {'OK' if result else 'MISSING'}")
            _tlog(f"open_backup prewarm total={time.perf_counter()-t_pw:.3f}s")

        _tlog(f"open_backup SUCCESS: udid={udid!r} backup_dir={backup_dir!r} encrypted={encrypted}")
        return {
            "status": "open",
            "info": backup_info,
        }

    def validate_password(self, udid: str, password: str,
                          backup_dir: Optional[str] = None) -> dict:
        """Fast check: is this passphrase correct for the encrypted backup?

        Only decrypts the keybag / manifest — does NOT create an OpenBackup or
        prewarm any files, so it returns in under a second.
        """
        # Resolve the backup directory (same logic as open_backup fast-path)
        if backup_dir and os.path.isdir(backup_dir):
            info = self._read_backup_info(backup_dir)
            if not info:
                for entry in os.scandir(backup_dir):
                    if entry.is_dir():
                        info = self._read_backup_info(entry.path)
                        if info:
                            backup_dir = entry.path
                            break
        else:
            info = None
            for b in self.list_backups()["backups"]:
                if self._norm_udid(b["udid"]) == self._norm_udid(udid):
                    info = b
                    backup_dir = b["backup_dir"]
                    break

        if not info:
            return {"valid": False, "error": "Backup not found"}
        if not info.get("encrypted"):
            return {"valid": True}
        if not HAS_DECRYPT:
            return {"valid": False, "error": "Decryption library not installed"}

        try:
            eb = EncryptedBackup(backup_directory=backup_dir, passphrase=password)
            with eb.manifest_db_cursor() as cur:
                cur.execute("SELECT COUNT(*) FROM Files")
            return {"valid": True}
        except Exception:
            return {"valid": False, "error": "Incorrect password"}

    def get_backup_size(self, backup_dir: str) -> dict:
        """
        Return the total size of a backup directory.
        Results are cached in ~/.openextract/size_cache.json keyed by backup_dir
        and the mtime of Manifest.db, so repeated calls are instant.
        """
        manifest_db = os.path.join(backup_dir, "Manifest.db")
        try:
            mtime = os.path.getmtime(manifest_db)
        except OSError:
            mtime = 0.0

        cache = _load_size_cache()
        key = backup_dir
        entry = cache.get(key)
        if entry and entry.get("mtime") == mtime:
            return {"size_bytes": entry["size_bytes"], "size_gb": entry["size_gb"]}

        # Compute by scanning one level of hex subdirs
        total_size = 0
        try:
            for entry_dir in os.scandir(backup_dir):
                if entry_dir.is_dir() and len(entry_dir.name) == 2:
                    for f in os.scandir(entry_dir.path):
                        if f.is_file():
                            total_size += f.stat().st_size
        except Exception:
            pass

        size_gb = round(total_size / (1024 ** 3), 2)
        cache[key] = {"mtime": mtime, "size_bytes": total_size, "size_gb": size_gb}
        _save_size_cache(cache)
        return {"size_bytes": total_size, "size_gb": size_gb}

    def get_open_backup(self, udid: str) -> OpenBackup:
        """Get an already-opened backup by UDID."""
        key = self._norm_udid(udid)
        if key not in self._open_backups:
            raise ValueError(f"Backup not open: {udid}. Call open_backup first.")
        return self._open_backups[key]
