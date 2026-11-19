"""
Copies of a backup's files for another app to open (python/app_copies.py).

The WhatsApp adapter's tests (test_whatsapp_adapter.py) drive this module
through get_whatsapp_attachment: names that could escape or confuse, what is
openable, one folder per engine, and the sweep of folders that ended engines
left. These cover what WhatsApp and Photos both rely on and those tests don't
reach: the copy's permissions, room on the disk, progress while a long copy
goes, and each part of the app sweeping only its own folders.
"""

import os
import stat
import subprocess
import sys
import tempfile
import time
import unittest
from collections import namedtuple
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import app_copies  # noqa: E402
from app_copies import AppCopies, NotEnoughSpace  # noqa: E402

Usage = namedtuple("Usage", "total used free")


class CopiesCase(unittest.TestCase):

    def setUp(self):
        src = tempfile.TemporaryDirectory()
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(src.cleanup)
        self.addCleanup(temp.cleanup)
        self.src = src.name
        # Point the system temp folder at our own, so copies and the stale-folder sweep stay in it.
        saved = tempfile.tempdir
        tempfile.tempdir = temp.name
        self.addCleanup(setattr, tempfile, "tempdir", saved)
        self.temp = temp.name
        self.copies = AppCopies("photos")

    def file(self, name, data=b"video bytes"):
        path = os.path.join(self.src, name)
        with open(path, "wb") as f:
            f.write(data)
        return path

    def everything_under_temp(self):
        return sorted(name for _, _, names in os.walk(self.temp) for name in names)


class TestCopy(CopiesCase):

    def test_under_its_own_name_in_this_engines_folder(self):
        hashed = self.file("46ad145c3bed7be57c9541aee31e9fc641c8ccfd")
        path = self.copies.copy(hashed, ("00008120-0001", "46ad145c3bed7be5"), "IMG_0042.MOV")
        self.assertEqual(os.path.basename(path), "IMG_0042.MOV")
        with open(path, "rb") as f:
            self.assertEqual(f.read(), b"video bytes")
        root = self.copies.folder
        self.assertTrue(os.path.basename(root).startswith(f"openextract-photos-{os.getpid()}-"))
        self.assertEqual(os.path.dirname(root), self.temp)
        self.assertEqual(os.path.relpath(path, root), os.path.join("00008120-0001", "46ad145c3bed7be5", "IMG_0042.MOV"))
        # Two files with one name, and one file from two backups, don't collide
        other = self.copies.copy(self.file("b", b"another"), ("00008120-0001", "ffff"), "IMG_0042.MOV")
        elsewhere = self.copies.copy(hashed, ("another iPhone",), "IMG_0042.MOV")
        self.assertEqual(len({path, other, elsewhere}), 3)

    @unittest.skipIf(os.name == "nt", "Windows has no executable permission")
    def test_never_executable_whatever_the_backups_file_is(self):
        """A backup on an exFAT or NTFS drive marks every file executable, and macOS runs
        an executable file it is asked to open (issue #297)."""
        hashed = self.file("46ad145c")
        os.chmod(hashed, 0o777)
        path = self.copies.copy(hashed, ("udid", "id"), "IMG_0042.MOV")
        self.assertEqual(stat.S_IMODE(os.stat(path).st_mode), 0o600)

    def test_used_again_until_the_file_changes(self):
        hashed = self.file("a")
        first = self.copies.copy(hashed, ("udid", "id"), "IMG_0042.MOV")
        with mock.patch.object(app_copies, "replace_with_copy", side_effect=AssertionError("copied again")):
            self.assertEqual(self.copies.copy(hashed, ("udid", "id"), "IMG_0042.MOV"), first)
        with open(hashed, "wb") as f:
            f.write(b"a different video")
        later = time.time() + 5
        os.utime(hashed, (later, later))
        self.assertEqual(self.copies.copy(hashed, ("udid", "id"), "IMG_0042.MOV"), first)
        with open(first, "rb") as f:
            self.assertEqual(f.read(), b"a different video")

    def test_a_file_that_isnt_there(self):
        with self.assertRaises(OSError):
            self.copies.copy(os.path.join(self.src, "gone"), ("udid", "id"), "IMG_0042.MOV")
        self.assertEqual(self.everything_under_temp(), [])


class TestRoom(CopiesCase):
    """A long video mustn't fill the disk the temp folder is on, which is usually the system's."""

    def free(self, free):
        return mock.patch.object(app_copies.shutil, "disk_usage", return_value=Usage(10 ** 12, 0, free))

    def test_a_copy_that_wouldnt_fit_isnt_started(self):
        hashed = self.file("a", b"x" * 1000)
        with self.free(999), self.assertRaises(NotEnoughSpace) as raised:
            self.copies.copy(hashed, ("udid", "id"), "IMG_0042.MOV")
        self.assertEqual((raised.exception.needed, raised.exception.free), (1000, 999))
        self.assertIsInstance(raised.exception, OSError)  # WhatsApp says "couldn't be copied" for any of them
        self.assertEqual(self.everything_under_temp(), [], "not even a partial file")

    def test_a_big_copy_leaves_room_to_spare_and_a_small_one_its_own_size(self):
        hashed = self.file("a", b"x" * 1000)
        with mock.patch.object(app_copies, "_SPARE_BYTES", 100):
            with self.free(1099), self.assertRaises(NotEnoughSpace):
                self.copies.copy(hashed, ("udid", "big"), "IMG_0042.MOV")
            with self.free(1100):
                self.copies.copy(hashed, ("udid", "big"), "IMG_0042.MOV")
        # The real margin is far more than a document: a nearly full disk can still open one
        with self.free(1999), self.assertRaises(NotEnoughSpace):
            self.copies.copy(hashed, ("udid", "small"), "Lease.pdf")
        with self.free(2000):
            self.copies.copy(hashed, ("udid", "small"), "Lease.pdf")

    def test_copied_anyway_when_the_free_space_cant_be_told(self):
        hashed = self.file("a")
        with mock.patch.object(app_copies.shutil, "disk_usage", side_effect=OSError("no such disk")):
            path = self.copies.copy(hashed, ("udid", "id"), "IMG_0042.MOV")
        self.assertTrue(os.path.isfile(path))


class TestProgress(CopiesCase):

    def test_reported_as_the_copy_goes(self):
        hashed = self.file("a", b"0123456789")
        seen = []
        with mock.patch.object(app_copies, "_CHUNK_BYTES", 4):
            path = self.copies.copy(hashed, ("udid", "id"), "IMG_0042.MOV", lambda done, total: seen.append((done, total)))
        self.assertEqual(seen, [(4, 10), (8, 10), (10, 10)])
        with open(path, "rb") as f:
            self.assertEqual(f.read(), b"0123456789")
        self.assertEqual(os.stat(path).st_mtime_ns, os.stat(hashed).st_mtime_ns)

    def test_a_copy_that_stops_partway_leaves_nothing_behind(self):
        hashed = self.file("a", b"0123456789")

        def unplugged(done, total):
            raise OSError("the drive went away")

        with mock.patch.object(app_copies, "_CHUNK_BYTES", 4), self.assertRaises(OSError):
            self.copies.copy(hashed, ("udid", "id"), "IMG_0042.MOV", unplugged)
        self.assertEqual(self.everything_under_temp(), [], "no half-written file, under the real name or any other")


class TestStaleFolders(CopiesCase):

    def ended_process(self):
        proc = subprocess.Popen([sys.executable, "-c", "pass"])
        proc.wait()
        return proc.pid

    def test_each_part_of_the_app_sweeps_only_its_own(self):
        pid = self.ended_process()
        folders = {}
        for label in ("photos", "whatsapp"):
            folders[label] = os.path.join(self.temp, f"openextract-{label}-{pid}-ab12cd34")
            os.makedirs(folders[label])
            with open(os.path.join(folders[label], "IMG_0042.MOV"), "wb") as f:
                f.write(b"left behind")
        AppCopies("photos")  # the engine starting
        self.assertFalse(os.path.exists(folders["photos"]))
        self.assertTrue(os.path.isdir(folders["whatsapp"]))
        AppCopies("whatsapp")
        self.assertFalse(os.path.exists(folders["whatsapp"]))


class TestNames(unittest.TestCase):

    def name(self, own, default="Video"):
        return app_copies.join_name(*app_copies.split_name(own), default)

    def test_a_files_own_name_from_where_the_iphone_kept_it(self):
        self.assertEqual(self.name("Media/DCIM/100APPLE/IMG_0042.MOV"), "IMG_0042.MOV")
        self.assertEqual(self.name("IMG_0042.MOV"), "IMG_0042.MOV")
        self.assertEqual(self.name("..\\..\\evil.mov"), "evil.mov")
        self.assertEqual(self.name('a<b>:"c"?.mp4'), "a_b_c_.mp4")
        self.assertEqual(self.name("CON.mov"), "_CON.mov")
        self.assertEqual(self.name(""), "Video")
        self.assertEqual(self.name(None), "Video")
        self.assertEqual(self.name("Media/DCIM/100APPLE/"), "Video")
        long = self.name("x" * 300 + ".mov")
        self.assertTrue(long.endswith(".mov") and len(long) == app_copies.STEM_CHARS + 4, long)

    def test_a_name_that_is_only_an_extension_isnt_a_video(self):
        # ".mov" alone is a hidden file with no extension, not a video: never opened, only shown
        name = self.name(".mov")
        self.assertEqual(name, "mov")
        self.assertFalse(app_copies.is_openable(name))

    def test_what_another_app_may_open(self):
        for name in ("IMG_0042.MOV", "clip.mp4", "IMG_0001.HEIC", "a.jpg", "Lease.pdf"):
            self.assertTrue(app_copies.is_openable(name), name)
        for name in ("46ad145c3bed7be57c9541aee31e9fc641c8ccfd", "run.command", "a.exe", "IMG_0042.MOV.sh", "x.app", ""):
            self.assertFalse(app_copies.is_openable(name), name)


if __name__ == "__main__":
    unittest.main()
