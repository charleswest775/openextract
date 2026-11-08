"""
Tests for finding backups in the usual folders, which the home screen lists
without the user picking a folder.
"""

import os
import plistlib
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import backup as backup_mod  # noqa: E402
from backup import BackupManager  # noqa: E402

CAN_BLOCK = os.name == "posix" and hasattr(os, "geteuid") and os.geteuid() != 0


def _make_backup(parent: str, udid: str, last_backup: datetime) -> str:
    path = os.path.join(parent, udid)
    os.makedirs(path)
    open(os.path.join(path, "Manifest.db"), "wb").close()
    with open(os.path.join(path, "Info.plist"), "wb") as f:
        plistlib.dump({"Unique Identifier": udid, "Device Name": udid, "Last Backup Date": last_backup}, f)
    return path


class TestDefaultFolderScan(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.home = self._tmp.name
        self.mgr = BackupManager.__new__(BackupManager)

    def tearDown(self):
        self._tmp.cleanup()

    def test_lists_backups_newest_first_and_skips_missing_folders(self):
        found = os.path.join(self.home, "Backup")
        missing = os.path.join(self.home, "Nowhere", "Backup")
        _make_backup(found, "OLDER", datetime(2024, 5, 1))
        _make_backup(found, "NEWER", datetime(2026, 10, 30))
        with patch.object(BackupManager, "_get_default_backup_dirs", return_value=[missing, found]):
            result = self.mgr.list_backups()
        self.assertEqual([b["udid"] for b in result["backups"]], ["NEWER", "OLDER"])
        self.assertEqual(result["search_dirs"], [found])
        self.assertEqual(result["permission_denied"], [])

    def test_mac_with_no_backup_folder_finds_nothing_quietly(self):
        with (
            patch.object(backup_mod.sys, "platform", "darwin"),
            patch.object(backup_mod.Path, "home", return_value=Path(self.home)),
        ):
            result = self.mgr.list_backups()
        self.assertEqual(result["backups"], [])
        self.assertEqual(result["permission_denied"], [])

    def test_mac_finds_finder_backups(self):
        backups = os.path.join(self.home, "Library", "Application Support", "MobileSync", "Backup")
        _make_backup(backups, "AAAA1111", datetime(2026, 11, 1))
        with (
            patch.object(backup_mod.sys, "platform", "darwin"),
            patch.object(backup_mod.Path, "home", return_value=Path(self.home)),
        ):
            result = self.mgr.list_backups()
        self.assertEqual([b["udid"] for b in result["backups"]], ["AAAA1111"])

    @unittest.skipUnless(CAN_BLOCK, "needs a non-root POSIX user to make a folder unreadable")
    def test_mac_reports_backup_folder_hidden_by_privacy_controls(self):
        # macOS protects MobileSync itself, so even checking whether Backup
        # inside it exists fails. That must read as blocked, not as missing.
        mobilesync = os.path.join(self.home, "Library", "Application Support", "MobileSync")
        backups = os.path.join(mobilesync, "Backup")
        _make_backup(backups, "AAAA1111", datetime(2026, 11, 1))
        os.chmod(mobilesync, 0)
        try:
            self.assertFalse(os.path.isdir(backups))
            with (
                patch.object(backup_mod.sys, "platform", "darwin"),
                patch.object(backup_mod.Path, "home", return_value=Path(self.home)),
            ):
                result = self.mgr.list_backups()
                with self.assertRaises(RuntimeError) as ctx:
                    self.mgr.open_backup("AAAA1111")
        finally:
            os.chmod(mobilesync, 0o755)
        self.assertEqual(result["backups"], [])
        self.assertEqual(result["permission_denied"], [backups])
        self.assertTrue(str(ctx.exception).startswith("FULL_DISK_ACCESS_REQUIRED:"))

    def test_windows_folder_named_twice_is_listed_once(self):
        _make_backup(os.path.join(self.home, "Apple", "MobileSync", "Backup"), "AAAA1111", datetime(2026, 11, 1))
        env = {"APPDATA": self.home, "LOCALAPPDATA": self.home, "USERPROFILE": self.home}
        with (
            patch.object(backup_mod.sys, "platform", "win32"),
            patch.dict(backup_mod.os.environ, env),
        ):
            dirs = self.mgr._get_default_backup_dirs()
            result = self.mgr.list_backups()
        self.assertEqual(len(dirs), len(set(dirs)))
        self.assertEqual([b["udid"] for b in result["backups"]], ["AAAA1111"])


if __name__ == "__main__":
    unittest.main()
