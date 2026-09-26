"""
Tests for unreadable backup folders (GitHub issue #84).

On macOS, ~/Library/Application Support/MobileSync is privacy-protected; without
Full Disk Access, listing it raises PermissionError. A chmod-000 folder
reproduces the same PermissionError on any POSIX system.
"""

import os
import plistlib
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import backup as backup_mod  # noqa: E402
from backup import BackupManager  # noqa: E402

CAN_BLOCK = os.name == "posix" and hasattr(os, "geteuid") and os.geteuid() != 0


def _make_backup(parent: str, udid: str) -> str:
    path = os.path.join(parent, udid)
    os.makedirs(path)
    open(os.path.join(path, "Manifest.db"), "wb").close()
    with open(os.path.join(path, "Info.plist"), "wb") as f:
        plistlib.dump({"Unique Identifier": udid, "Device Name": "Phone"}, f)
    return path


@unittest.skipUnless(CAN_BLOCK, "needs a non-root POSIX user to make a folder unreadable")
class TestUnreadableBackupFolder(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.parent = os.path.join(self._tmp.name, "Backup")
        os.makedirs(self.parent)
        self.backup_dir = _make_backup(self.parent, "AAAA1111")
        self.mgr = BackupManager.__new__(BackupManager)

    def tearDown(self):
        for path in (self.parent, self.backup_dir):
            os.chmod(path, 0o755)
        self._tmp.cleanup()

    def _block(self, path):
        os.chmod(path, 0)

    def test_browse_to_blocked_parent_raises_fda_on_mac(self):
        self._block(self.parent)
        with patch.object(backup_mod.sys, "platform", "darwin"):
            with self.assertRaises(RuntimeError) as ctx:
                self.mgr.list_backups(custom_path=self.parent)
        self.assertTrue(str(ctx.exception).startswith("FULL_DISK_ACCESS_REQUIRED:"))
        self.assertIn(self.parent, str(ctx.exception))

    def test_browse_to_blocked_backup_raises_fda_on_mac(self):
        self._block(self.backup_dir)
        with patch.object(backup_mod.sys, "platform", "darwin"):
            with self.assertRaises(RuntimeError) as ctx:
                self.mgr.list_backups(custom_path=self.backup_dir)
        self.assertTrue(str(ctx.exception).startswith("FULL_DISK_ACCESS_REQUIRED:"))

    def test_blocked_folder_on_other_platforms_is_plain_permission_error(self):
        self._block(self.parent)
        with patch.object(backup_mod.sys, "platform", "win32"):
            with self.assertRaises(RuntimeError) as ctx:
                self.mgr.list_backups(custom_path=self.parent)
        self.assertNotIn("FULL_DISK_ACCESS_REQUIRED", str(ctx.exception))
        self.assertIn("permission", str(ctx.exception))

    def test_default_scan_reports_blocked_dirs_instead_of_hiding_them(self):
        self._block(self.parent)
        with patch.object(BackupManager, "_get_default_backup_dirs", return_value=[self.parent]):
            result = self.mgr.list_backups()
        self.assertEqual(result["backups"], [])
        self.assertEqual(result["permission_denied"], [self.parent])

    def test_open_blocked_backup_raises_fda_on_mac(self):
        self._block(self.backup_dir)
        with patch.object(backup_mod.sys, "platform", "darwin"):
            with self.assertRaises(RuntimeError) as ctx:
                self.mgr.open_backup("AAAA1111", backup_dir=self.backup_dir)
        self.assertTrue(str(ctx.exception).startswith("FULL_DISK_ACCESS_REQUIRED:"))

    def test_open_by_udid_when_default_dir_blocked_raises_fda_not_not_found(self):
        self._block(self.parent)
        with (
            patch.object(backup_mod.sys, "platform", "darwin"),
            patch.object(BackupManager, "_get_default_backup_dirs", return_value=[self.parent]),
        ):
            with self.assertRaises(RuntimeError) as ctx:
                self.mgr.open_backup("AAAA1111")
        self.assertTrue(str(ctx.exception).startswith("FULL_DISK_ACCESS_REQUIRED:"))

    def test_readable_folder_still_lists_normally(self):
        result = self.mgr.list_backups(custom_path=self.parent)
        self.assertEqual([b["udid"] for b in result["backups"]], ["AAAA1111"])
        self.assertEqual(result["permission_denied"], [])


if __name__ == "__main__":
    unittest.main()
