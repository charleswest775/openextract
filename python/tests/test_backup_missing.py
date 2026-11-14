"""
Opening a backup that isn't where the app said it was (in-app report OE-40).

The home screen's recent list keeps each backup's folder. When that folder has been
moved, renamed or deleted, or is on a drive that isn't plugged in, and the iPhone has no
backup in the usual folders either, open_backup used to fail with "Backup not found:
<udid>", which reads as if the backup were gone. It now says where it looked and what to
do, behind a BACKUP_MISSING prefix the app uses to offer "Find it".
"""

import os
import plistlib
import shutil
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from backup import BACKUP_MISSING, BackupManager  # noqa: E402

UDID = "00008110-001A2B3C4D5E6F70"


def _make_backup(parent: str, udid: str = UDID) -> str:
    path = os.path.join(parent, udid)
    os.makedirs(path)
    with open(os.path.join(path, "Info.plist"), "wb") as f:
        plistlib.dump({"Unique Identifier": udid, "Device Name": "Phone", "Product Version": "17.4"}, f)
    with open(os.path.join(path, "Manifest.plist"), "wb") as f:
        plistlib.dump({"IsEncrypted": False}, f)
    con = sqlite3.connect(os.path.join(path, "Manifest.db"))
    con.execute("CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)")
    con.commit()
    con.close()
    return path


class TestBackupMissing(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        # The folder the user chose in Back up my iPhone, which list_backups doesn't search.
        self.backup_dir = _make_backup(os.path.join(self.root, "Chosen"))
        # The usual backup folders (Finder, iTunes, Apple Devices): empty unless a test adds one.
        self.usual = os.path.join(self.root, "MobileSync", "Backup")
        os.makedirs(self.usual)
        patcher = patch.object(BackupManager, "_get_default_backup_dirs", return_value=[self.usual])
        patcher.start()
        self.addCleanup(patcher.stop)
        self.mgr = BackupManager()
        self.addCleanup(self._close_all)

    def _close_all(self):
        for udid in list(self.mgr._open_backups):
            self.mgr.close_backup(udid)
        self._tmp.cleanup()

    def _open_error(self, backup_dir) -> str:
        with self.assertRaises(ValueError) as ctx:
            self.mgr.open_backup(UDID, backup_dir=backup_dir)
        message = str(ctx.exception)
        self.assertTrue(message.startswith(BACKUP_MISSING + " "), message)
        self.assertIn("OpenExtract can't find this backup.", message)
        self.assertNotIn(UDID.split("-")[1], message.replace(str(backup_dir), ""), "no bare device id")
        return message

    def test_the_folder_opens_while_it_is_there(self):
        result = self.mgr.open_backup(UDID, backup_dir=self.backup_dir)
        self.assertEqual(result["status"], "open")

    def test_a_folder_moved_away_says_so_and_offers_to_find_it(self):
        shutil.move(os.path.dirname(self.backup_dir), os.path.join(self.root, "Moved"))
        message = self._open_error(self.backup_dir)
        self.assertIn(f"It was in {self.backup_dir}, and that folder isn't there now.", message)
        self.assertIn("plug the drive in", message)
        self.assertIn("click Find it", message)

    def test_a_drive_that_is_not_plugged_in_reads_the_same(self):
        gone = os.path.join(self.root, "Unplugged drive", "iPhone backups", UDID)
        message = self._open_error(gone)
        self.assertIn(f"It was in {gone}, and that folder isn't there now.", message)

    def test_a_folder_with_no_backup_left_in_it(self):
        os.remove(os.path.join(self.backup_dir, "Manifest.db"))
        message = self._open_error(self.backup_dir)
        self.assertIn(f"There's no iPhone backup in {self.backup_dir} now.", message)
        self.assertIn("click Find it", message)

    def test_a_recent_backup_saved_without_its_folder(self):
        message = self._open_error(None)
        self.assertIn("It isn't in the usual backup folders on this computer.", message)
        self.assertIn("click Find it", message)

    def test_the_same_iphone_in_a_usual_folder_still_opens_when_the_saved_folder_is_gone(self):
        usual_backup = _make_backup(self.usual)
        shutil.rmtree(os.path.dirname(self.backup_dir))
        result = self.mgr.open_backup(UDID, backup_dir=self.backup_dir)
        self.assertEqual(result["status"], "open")
        self.assertEqual(result["info"]["backup_dir"], usual_backup)


if __name__ == "__main__":
    unittest.main()
