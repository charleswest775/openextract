"""
Tests for closing an opened backup.

An opened backup keeps Manifest.db open for fast file lookups. Unless it is
closed, that connection lives on until the garbage collector runs, and on
Windows an open file can't be deleted or moved.
"""

import hashlib
import os
import plistlib
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from backup import BackupManager  # noqa: E402

UDID = "00008030-0000000000000000"
SMS_DB = "Library/SMS/sms.db"


def _make_backup(backup_dir: str) -> None:
    """Write a minimal unencrypted backup holding an empty sms.db."""
    os.makedirs(backup_dir)
    with open(os.path.join(backup_dir, "Info.plist"), "wb") as f:
        plistlib.dump({"Unique Identifier": UDID}, f)
    with open(os.path.join(backup_dir, "Manifest.plist"), "wb") as f:
        plistlib.dump({"IsEncrypted": False}, f)
    file_id = hashlib.sha1(f"HomeDomain-{SMS_DB}".encode()).hexdigest()
    os.makedirs(os.path.join(backup_dir, file_id[:2]))
    sqlite3.connect(os.path.join(backup_dir, file_id[:2], file_id)).close()
    manifest = sqlite3.connect(os.path.join(backup_dir, "Manifest.db"))
    manifest.execute(
        "CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, "
        "relativePath TEXT, flags INTEGER, file BLOB)"
    )
    manifest.execute("INSERT INTO Files VALUES (?, 'HomeDomain', ?, 1, NULL)", (file_id, SMS_DB))
    manifest.commit()
    manifest.close()


class TestCloseBackup(unittest.TestCase):

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.backup_dir = os.path.join(tmp.name, UDID)
        _make_backup(self.backup_dir)
        self.mgr = BackupManager()
        self.addCleanup(self.mgr.close_backup, UDID)

    def _open(self):
        self.assertEqual(self.mgr.open_backup(UDID, backup_dir=self.backup_dir)["status"], "open")
        backup = self.mgr.get_open_backup(UDID)
        # A file lookup opens the Manifest.db connection the backup keeps.
        self.assertIsNotNone(backup.get_file(SMS_DB))
        conn = backup._manifest_conn
        self.assertIsNotNone(conn)
        return backup, conn

    def _assert_closed(self, conn):
        with self.assertRaises(sqlite3.ProgrammingError):
            conn.execute("SELECT 1")

    def test_close_backup_closes_manifest_and_forgets_the_backup(self):
        backup, conn = self._open()
        self.mgr.close_backup(UDID)
        self._assert_closed(conn)
        self.assertFalse(os.path.exists(backup._temp_dir))
        with self.assertRaises(ValueError):
            self.mgr.get_open_backup(UDID)
        # Once closed, the backup folder can be moved (Windows refuses while it's open).
        moved = self.backup_dir + "-moved"
        os.rename(self.backup_dir, moved)
        os.rename(moved, self.backup_dir)

    def test_closing_a_backup_that_is_not_open_does_nothing(self):
        self.mgr.close_backup(UDID)

    def test_opening_again_closes_the_earlier_backup(self):
        first, first_conn = self._open()
        second, _ = self._open()
        self.assertIsNot(first, second)
        self._assert_closed(first_conn)
        self.assertIs(self.mgr.get_open_backup(UDID), second)


if __name__ == "__main__":
    unittest.main()
