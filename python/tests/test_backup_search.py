"""
"Open a backup folder" with a folder that isn't the backup or the folder just above it (feedback
#191): a backup further down is found, one the folder is inside is opened, and a folder with no
backup says what it held, with no names.
"""

import os
import plistlib
import sys
import tempfile
import time
import unittest
from datetime import datetime
from unittest.mock import patch

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import backup_search  # noqa: E402
from backup import BackupManager  # noqa: E402


def _make_backup(parent: str, udid: str, last_backup=datetime(2026, 11, 1)) -> str:
    path = os.path.join(parent, udid)
    os.makedirs(path)
    open(os.path.join(path, "Manifest.db"), "wb").close()
    with open(os.path.join(path, "Info.plist"), "wb") as f:
        plistlib.dump({"Unique Identifier": udid, "Device Name": udid, "Last Backup Date": last_backup}, f)
    os.makedirs(os.path.join(path, "0a"))
    return path


class TestChosenFolder(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        self.mgr = BackupManager.__new__(BackupManager)

    def tearDown(self):
        self._tmp.cleanup()

    def _list(self, path):
        return self.mgr.list_backups(custom_path=path)

    def test_the_backup_and_the_folder_above_still_work(self):
        b = _make_backup(os.path.join(self.root, "Backup"), "AAA")
        self.assertEqual([x["backup_dir"] for x in self._list(b)["backups"]], [b])
        self.assertEqual([x["backup_dir"] for x in self._list(os.path.dirname(b))["backups"]], [b])

    def test_mobilesync_or_a_drive_finds_the_backup_further_down(self):
        b = _make_backup(os.path.join(self.root, "Apple Computer", "MobileSync", "Backup"), "AAA")
        for chosen in (os.path.join(self.root, "Apple Computer", "MobileSync"),
                       os.path.join(self.root, "Apple Computer"), self.root):
            result = self._list(chosen)
            self.assertEqual([x["backup_dir"] for x in result["backups"]], [b], chosen)
            self.assertNotIn("hint", result)

    def test_several_further_down_are_all_offered_newest_first(self):
        old = _make_backup(os.path.join(self.root, "tool", "Backup", "one"), "OLD", datetime(2024, 1, 1))
        new = _make_backup(os.path.join(self.root, "other", "Backup"), "NEW", datetime(2026, 1, 1))
        self.assertEqual([x["backup_dir"] for x in self._list(self.root)["backups"]], [new, old])

    def test_too_deep_is_not_found(self):
        _make_backup(os.path.join(self.root, "a", "b", "c", "d"), "AAA")
        result = self._list(self.root)
        self.assertEqual(result["backups"], [])
        self.assertIn("4 folders deep", result["hint"])

    def test_a_folder_inside_a_backup_opens_that_backup(self):
        b = _make_backup(os.path.join(self.root, "Backup"), "AAA")
        result = self._list(os.path.join(b, "0a"))
        self.assertEqual([x["backup_dir"] for x in result["backups"]], [b])

    def test_does_not_go_into_a_backup(self):
        outer = _make_backup(self.root, "OUTER")
        _make_backup(os.path.join(outer, "0b"), "INNER")
        self.assertEqual([x["udid"] for x in self._list(self.root)["backups"]], ["OUTER"])

    def test_an_unrenamed_try_with_nothing_to_open_is_not_offered(self):
        work = os.path.join(self.root, "x", "Backup", "OpenExtract-new", "AAA")
        os.makedirs(work)
        with open(os.path.join(work, "Info.plist"), "wb") as f:
            plistlib.dump({"Unique Identifier": "AAA"}, f)
        open(os.path.join(work, "Manifest.plist"), "wb").close()
        self.assertEqual(self._list(self.root)["backups"], [])

    def test_stops_after_the_limit(self):
        for i in range(30):
            os.makedirs(os.path.join(self.root, f"f{i:02d}", "inner"))
        _make_backup(os.path.join(self.root, "zz"), "LATE")
        with patch.object(backup_search, "MAX_DIRS", 10):
            found, stopped = backup_search.find_below(self.root, self.mgr._read_backup_info, max_dirs=10)
        self.assertTrue(stopped)
        self.assertEqual(found, [])
        self.assertIn("stopped looking", backup_search.describe(self.root, stopped=True))

    def test_stops_after_the_time_limit(self):
        os.makedirs(os.path.join(self.root, "a", "b"))
        with patch.object(backup_search.time, "monotonic", side_effect=[0.0] + [99.0] * 10):
            _, stopped = backup_search.find_below(self.root, self.mgr._read_backup_info)
        self.assertTrue(stopped)

    def test_folders_that_sound_like_backups_are_looked_in_first(self):
        for i in range(20):
            os.makedirs(os.path.join(self.root, f"a{i:02d}", "x"))
        b = _make_backup(os.path.join(self.root, "zz MobileSync", "Backup"), "AAA")
        found, _ = backup_search.find_below(self.root, self.mgr._read_backup_info, max_dirs=25)
        self.assertEqual([x["backup_dir"] for x in found], [b])


class TestDescribe(unittest.TestCase):
    """What a folder with no backup held: the cases a report needs to tell apart, with no names."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = os.path.join(self._tmp.name, "Jane's secret folder")
        os.makedirs(self.root)
        self.mgr = BackupManager.__new__(BackupManager)

    def tearDown(self):
        self._tmp.cleanup()

    def _touch(self, *names):
        for n in names:
            open(os.path.join(self.root, n), "wb").close()

    def _hint(self):
        return self.mgr.list_backups(custom_path=self.root)["hint"]

    def test_empty(self):
        self.assertEqual(self._hint(), "That folder is empty.")

    def test_compressed(self):
        self._touch("iPhone backup 2025.zip")
        self.assertIn("compressed file (.zip)", self._hint())

    def test_stored_files_without_the_list(self):
        for i in range(20):
            os.makedirs(os.path.join(self.root, f"{i:02x}"))
        self._touch("Info.plist")
        self.assertIn("stored files but not its list", self._hint())

    def test_some_backup_files_without_the_list(self):
        self._touch("Info.plist", "Status.plist")
        self.assertIn("some of a backup's files", self._hint())

    def test_photos(self):
        self._touch("IMG_0001.HEIC", "IMG_0002.JPG", "IMG_0003.MOV", "notes.txt")
        self.assertIn("photos or videos", self._hint())

    def test_other(self):
        os.makedirs(os.path.join(self.root, "Documents"))
        self._touch("a.txt")
        hint = self._hint()
        self.assertIn("1 folders and 1 files", hint)
        for name in ("Jane", "Documents", "a.txt"):
            self.assertNotIn(name, hint)

    def test_quick_on_a_folder_with_much_in_it(self):
        for i in range(200):
            os.makedirs(os.path.join(self.root, f"d{i}", "e", "f"))
        start = time.monotonic()
        self._hint()
        self.assertLess(time.monotonic() - start, 5)


if __name__ == "__main__":
    unittest.main()
