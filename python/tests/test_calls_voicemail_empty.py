"""
Tests for the Calls and Voicemail empty states.

Backups with no call history or no voicemail (like the synthetic "Einstein"
backups, which hold only Messages and Contacts) used to come back with errors:
every call-less backup was told to turn on encryption, even encrypted ones,
and a missing voicemail.db was reported as "voicemail.db not found".
"""

import hashlib
import os
import plistlib
import shutil
import sqlite3
import sys
import tempfile
import unittest
from contextlib import contextmanager

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from backup import BackupManager, OpenBackup  # noqa: E402
from calls import CallExtractor  # noqa: E402
from voicemail import VoicemailExtractor  # noqa: E402

UDID = "00008030-0000000000000000"
CALL_DB = "Library/CallHistoryDB/CallHistory.storedata"
VOICEMAIL_DB = "Library/Voicemail/voicemail.db"


def _file_id(rel_path: str) -> str:
    return hashlib.sha1(f"HomeDomain-{rel_path}".encode()).hexdigest()


def _make_backup(backup_dir: str, files: dict, encrypted: bool = False) -> None:
    """Write a minimal backup holding ``files`` (relative path -> SQL script)."""
    os.makedirs(backup_dir)
    with open(os.path.join(backup_dir, "Info.plist"), "wb") as f:
        plistlib.dump({"Unique Identifier": UDID, "Device Name": "Test iPhone"}, f)
    with open(os.path.join(backup_dir, "Manifest.plist"), "wb") as f:
        plistlib.dump({"IsEncrypted": encrypted}, f)
    manifest = sqlite3.connect(os.path.join(backup_dir, "Manifest.db"))
    manifest.execute(
        "CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, "
        "relativePath TEXT, flags INTEGER, file BLOB)"
    )
    for rel_path, script in files.items():
        file_id = _file_id(rel_path)
        os.makedirs(os.path.join(backup_dir, file_id[:2]), exist_ok=True)
        db = sqlite3.connect(os.path.join(backup_dir, file_id[:2], file_id))
        db.executescript(script)
        db.close()
        manifest.execute(
            "INSERT INTO Files VALUES (?, 'HomeDomain', ?, 1, NULL)", (file_id, rel_path)
        )
    manifest.commit()
    manifest.close()


EMPTY_CALL_HISTORY = """
    CREATE TABLE ZCALLRECORD (
        Z_PK INTEGER PRIMARY KEY, ZADDRESS TEXT, ZDATE REAL, ZDURATION REAL,
        ZCALLTYPE INTEGER, ZORIGINATED INTEGER, ZANSWERED INTEGER
    );
"""

EMPTY_VOICEMAIL = """
    CREATE TABLE voicemail (
        ROWID INTEGER PRIMARY KEY, sender TEXT, date INTEGER, duration INTEGER,
        flags INTEGER, trashed_date INTEGER, token TEXT
    );
"""


class _FakeEncryptedBackup:
    """Stands in for iphone_backup_decrypt.EncryptedBackup over a plain backup."""

    def __init__(self, backup_dir: str):
        self._backup_dir = backup_dir

    @contextmanager
    def manifest_db_cursor(self):
        conn = sqlite3.connect(os.path.join(self._backup_dir, "Manifest.db"))
        try:
            yield conn.cursor()
        finally:
            conn.close()

    def extract_file(self, relative_path, domain_like, output_filename):
        with self.manifest_db_cursor() as cur:
            row = cur.execute(
                "SELECT fileID FROM Files WHERE relativePath = ? AND domain = ?",
                (relative_path, domain_like),
            ).fetchone()
        if not row:
            # The real library raises for files that aren't in the backup.
            raise FileNotFoundError(relative_path)
        shutil.copy(os.path.join(self._backup_dir, row[0][:2], row[0]), output_filename)


class TestCallsVoicemailEmptyStates(unittest.TestCase):

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        # Cleanups run last-registered first, so this one runs after every
        # backup is closed: Windows can't delete a database that is still open.
        self.addCleanup(tmp.cleanup)
        self._tmp = tmp.name

    def _new_backup_dir(self) -> str:
        return os.path.join(tempfile.mkdtemp(dir=self._tmp), UDID)

    def _open(self, files: dict):
        """Open an unencrypted backup the way the open_backup RPC does."""
        backup_dir = self._new_backup_dir()
        _make_backup(backup_dir, files)
        mgr = BackupManager()
        self.assertEqual(mgr.open_backup(UDID, backup_dir=backup_dir)["status"], "open")
        self.addCleanup(mgr.close_backup, UDID)
        return mgr.get_open_backup(UDID)

    def _open_encrypted(self, files: dict):
        backup_dir = self._new_backup_dir()
        _make_backup(backup_dir, files, encrypted=True)
        backup = OpenBackup(
            backup_dir=backup_dir, udid=UDID, info={}, encrypted=True,
            decrypted_backup=_FakeEncryptedBackup(backup_dir),
        )
        self.addCleanup(backup.close)
        return backup

    def test_unencrypted_without_call_history_keeps_encryption_hint(self):
        backup = self._open({})
        result = CallExtractor().list_calls(backup, {})
        self.assertEqual(result["calls"], [])
        self.assertEqual(result["empty_reason"], "requires_encryption")
        self.assertIn("encrypt", result["error"].lower())

    def test_encrypted_without_call_history_is_an_empty_state(self):
        backup = self._open_encrypted({})
        result = CallExtractor().list_calls(backup, {})
        self.assertEqual(result["calls"], [])
        self.assertEqual(result["empty_reason"], "not_in_backup")
        self.assertNotIn("error", result)

    def test_empty_call_history_is_an_empty_state(self):
        for open_backup in (self._open, self._open_encrypted):
            with self.subTest(open_backup.__name__):
                backup = open_backup({CALL_DB: EMPTY_CALL_HISTORY})
                result = CallExtractor().list_calls(backup, {})
                self.assertEqual(result["calls"], [])
                self.assertEqual(result["empty_reason"], "no_records")
                self.assertNotIn("error", result)

    def test_missing_voicemail_db_is_an_empty_state(self):
        for open_backup in (self._open, self._open_encrypted):
            with self.subTest(open_backup.__name__):
                backup = open_backup({})
                result = VoicemailExtractor().list_voicemails(backup, {})
                self.assertEqual(result, {"voicemails": [], "empty_reason": "not_in_backup"})

    def test_empty_voicemail_db_is_an_empty_state(self):
        backup = self._open({VOICEMAIL_DB: EMPTY_VOICEMAIL})
        result = VoicemailExtractor().list_voicemails(backup, {})
        self.assertEqual(result, {"voicemails": [], "empty_reason": "no_records"})

    def test_exporting_without_voicemail_db_is_not_an_error(self):
        backup = self._open({})
        out_dir = os.path.join(self._tmp, "export")
        result = VoicemailExtractor().export_voicemails(backup, {}, out_dir)
        self.assertEqual(result, {"status": "success", "exported": 0})


if __name__ == "__main__":
    unittest.main()
