"""
Tests for picking the right backup when several live in one folder (GitHub issue #81).
"""

import os
import plistlib
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from backup import BackupManager  # noqa: E402


def _make_backup(parent: str, udid: str, name: str) -> str:
    path = os.path.join(parent, udid)
    os.makedirs(path)
    open(os.path.join(path, "Manifest.db"), "wb").close()
    with open(os.path.join(path, "Info.plist"), "wb") as f:
        plistlib.dump({"Unique Identifier": udid, "Device Name": name}, f)
    return path


class TestBackupSelection(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.parent = self._tmp.name
        self.paths = {
            udid: _make_backup(self.parent, udid, name)
            for udid, name in [("AAAA1111", "Phone A"), ("BBBB2222", "Phone B"), ("CCCC3333", "Phone C")]
        }
        self.mgr = BackupManager.__new__(BackupManager)

    def tearDown(self):
        self._tmp.cleanup()

    def test_picking_a_backup_folder_returns_only_that_backup(self):
        result = self.mgr.list_backups(custom_path=self.paths["BBBB2222"])
        self.assertEqual([b["udid"] for b in result["backups"]], ["BBBB2222"])

    def test_picking_parent_folder_lists_all_backups(self):
        result = self.mgr.list_backups(custom_path=self.parent)
        self.assertEqual(sorted(b["udid"] for b in result["backups"]),
                         ["AAAA1111", "BBBB2222", "CCCC3333"])

    def test_subdir_fallback_prefers_matching_udid(self):
        info = self.mgr._find_backup_in_subdirs(self.parent, "CCCC3333")
        self.assertEqual(info["backup_dir"], self.paths["CCCC3333"])

    def test_subdir_fallback_matches_dashed_udid(self):
        info = self.mgr._find_backup_in_subdirs(self.parent, "bbbb-2222")
        self.assertEqual(info["backup_dir"], self.paths["BBBB2222"])

    def test_subdir_fallback_without_match_returns_first(self):
        info = self.mgr._find_backup_in_subdirs(self.parent, "ZZZZ9999")
        self.assertEqual(info["backup_dir"], self.paths["AAAA1111"])


if __name__ == "__main__":
    unittest.main()
