"""
Copies of a backup's files for another app to open (python/app_copies.py).

The WhatsApp adapter's tests (test_whatsapp_adapter.py) drive this module
through get_whatsapp_attachment: names that could escape or confuse, what is
openable, one folder per engine, and the sweep of folders that ended engines
left. These cover what Messages, WhatsApp and Photos all rely on and those tests don't
reach: the copy's permissions, room on the disk, progress while a long copy
goes, keeping a long session's copies within a budget, and each part of the
app sweeping only its own folders.
"""

import os
import shutil
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


class TestBudget(CopiesCase):
    """A long session that opens or plays many videos mustn't fill the temp folder's disk.

    Past BUDGET_BYTES (100 bytes here, 2 GB in the app) the copies handed out
    longest ago go, but never one handed out in the last IN_USE_SECONDS: it
    may be playing in the app, or open in another app.
    """

    def setUp(self):
        super().setUp()
        self.clock = 1_000_000.0
        for patch in (mock.patch.object(app_copies, "BUDGET_BYTES", 100),
                      mock.patch.object(app_copies, "_now", lambda: self.clock)):
            patch.start()
            self.addCleanup(patch.stop)

    def hand_out(self, name, size=40, at=None, parts=None, mtime=None):
        """The copy of a ``size``-byte file called ``name``, handed out at ``at`` seconds."""
        if at is not None:
            self.clock = 1_000_000.0 + at
        src = os.path.join(self.src, name)
        if not os.path.exists(src):
            self.file(name, name.encode()[:1] * size)
            if mtime is not None:
                os.utime(src, (mtime, mtime))
        return self.copies.copy(src, parts or ("udid", name), f"{name}.mov")

    def test_the_copies_handed_out_longest_ago_go_first(self):
        old = self.hand_out("a", at=0)
        mid = self.hand_out("b", at=1000)
        new = self.hand_out("c", at=2000)  # 120 bytes: a goes
        self.assertFalse(os.path.exists(old))
        self.assertTrue(os.path.isfile(mid) and os.path.isfile(new))
        self.assertFalse(os.path.exists(os.path.dirname(old)), "its folder, empty now, goes too")
        self.assertTrue(os.path.isdir(os.path.join(self.copies.folder, "udid")))

    def test_by_when_handed_out_not_by_the_files_dates(self):
        # same_file goes by the copy's modification time, which is the backup file's
        a = self.hand_out("a", at=0, mtime=time.time())
        b = self.hand_out("b", at=10, mtime=time.time() - 10 * 365 * 86400)
        self.hand_out("a", at=1000)  # opened again: used again, and now the most recent
        self.hand_out("c", at=2000)
        self.assertTrue(os.path.isfile(a))
        self.assertFalse(os.path.exists(b))
        self.assertEqual(os.stat(a).st_mtime_ns, os.stat(os.path.join(self.src, "a")).st_mtime_ns)

    def test_never_one_handed_out_in_the_last_few_minutes(self):
        recent = app_copies.IN_USE_SECONDS - 1
        a = self.hand_out("a", at=0)
        b = self.hand_out("b", at=1)
        c = self.hand_out("c", at=2)  # over the budget, but all in use
        self.assertTrue(all(os.path.isfile(p) for p in (a, b, c)))
        d = self.hand_out("d", at=1 + recent)  # a is no longer in use, b and c still are
        self.assertFalse(os.path.exists(a))
        self.assertTrue(all(os.path.isfile(p) for p in (b, c, d)))
        e = self.hand_out("e", at=2 + app_copies.IN_USE_SECONDS + 1)
        self.assertEqual([os.path.exists(p) for p in (b, c, d, e)], [False, False, True, True])

    def test_never_the_copy_just_made_even_on_its_own_over_the_budget(self):
        small = self.hand_out("a", at=0)
        big = self.hand_out("b", size=500, at=5000)
        self.assertFalse(os.path.exists(small))
        with open(big, "rb") as f:
            self.assertEqual(len(f.read()), 500)
        self.assertEqual(self.hand_out("b", at=10_000), big, "and handed out again from where it is")

    def test_room_is_made_before_the_copy_which_may_be_what_lets_it_fit_on_the_disk(self):
        old = self.hand_out("a", at=0)
        checked = []

        def check_space(folder, src):
            checked.append(os.path.exists(old))

        with mock.patch.object(app_copies, "_check_space", side_effect=check_space):
            self.hand_out("b", size=80, at=5000)
        self.assertEqual(checked, [False])

    def test_a_copy_the_system_wont_let_go_stays_and_the_next_goes(self):
        # Windows won't remove a file that is open in another app
        a = self.hand_out("a", at=0)
        b = self.hand_out("b", at=1)
        remove = os.remove

        def held_open(path, *args, **kwargs):
            if path == a:
                raise PermissionError(13, "The process cannot access the file because it is being used", path)
            return remove(path, *args, **kwargs)

        with mock.patch.object(app_copies.os, "remove", side_effect=held_open):
            c = self.hand_out("c", at=5000)
        self.assertTrue(os.path.isfile(a) and os.path.isfile(c))
        self.assertFalse(os.path.exists(b))
        self.hand_out("d", at=6000)  # let go of now: it goes
        self.assertFalse(os.path.exists(a))

    def test_removing_never_fails_the_call(self):
        self.hand_out("a", at=0)
        self.hand_out("b", at=1)
        with mock.patch.object(app_copies.os, "remove", side_effect=RuntimeError("something unforeseen")):
            c = self.hand_out("c", at=5000)
        self.assertTrue(os.path.isfile(c))

    def test_a_copy_already_gone_is_forgotten(self):
        a = self.hand_out("a", at=0)
        os.remove(a)
        b = self.hand_out("b", at=1)
        c = self.hand_out("c", at=5000)
        self.assertTrue(os.path.isfile(b) and os.path.isfile(c), "a's 40 bytes were counted as freed")
        self.assertNotIn(a, self.copies._handed_out)

    def test_empty_folders_go_up_to_the_engines_own(self):
        a = self.hand_out("a", at=0, parts=("iPhone A", "7"))
        b = self.hand_out("b", at=1, parts=("iPhone B", "7"))
        self.hand_out("c", size=100, at=5000, parts=("iPhone B", "8"))
        root = self.copies.folder
        self.assertFalse(os.path.exists(a) or os.path.exists(b))
        self.assertEqual(sorted(os.listdir(root)), ["iPhone_B"])
        self.assertEqual(os.listdir(os.path.join(root, "iPhone_B")), ["8"])
        self.hand_out("d", size=100, at=10_000, parts=("iPhone C", "1"))
        self.assertEqual(os.listdir(root), ["iPhone_C"])
        self.assertTrue(os.path.isdir(root))

    def test_a_new_folder_starts_a_new_count(self):
        # Something removed this engine's folder, copies and all
        self.hand_out("a", size=90, at=0)
        shutil.rmtree(self.copies.folder)
        b = self.hand_out("b", size=90, at=1)
        self.assertTrue(os.path.isfile(b))
        self.assertEqual(list(self.copies._handed_out), [b])


class TestBudgetInTheApp(unittest.TestCase):

    def test_two_gigabytes_a_part_and_a_few_minutes_in_use(self):
        self.assertEqual(app_copies.BUDGET_BYTES, 2 * 1024 ** 3)
        self.assertTrue(60 <= app_copies.IN_USE_SECONDS <= 30 * 60)


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
        for name in ("IMG_0042.MOV", "clip.mp4", "IMG_0001.HEIC", "a.jpg", "Lease.pdf", "Memo.m4a", "Song.qta",
                     "Memo.qt"):
            self.assertTrue(app_copies.is_openable(name), name)
        for name in ("46ad145c3bed7be57c9541aee31e9fc641c8ccfd", "run.command", "a.exe", "IMG_0042.MOV.sh", "x.app", ""):
            self.assertFalse(app_copies.is_openable(name), name)


if __name__ == "__main__":
    unittest.main()
