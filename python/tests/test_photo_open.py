"""
get_photo_path (python/photos.py: get_file_for_app): a video as a file the computer's
video player can open (issue #297).

An unencrypted backup keeps each file under its hash, with no extension. The app used to
hand the computer that file as it lay in the backup: the computer couldn't tell it was a
video, and from a backup on a drive that marks every file executable, macOS ran it and
opened Terminal. Now the engine copies it out under the name the iPhone gave it.

These build a small stand-in backup folder (a Manifest.db and one hash-named file per
video), so they run without ios-backup-core's backupgen. test_old_backups.py and
test_rpc_contract.py ask the same of generated backups.
"""

import hashlib
import os
import sqlite3
import stat
import sys
import tempfile
import unittest
from collections import namedtuple
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
sys.path.insert(0, HERE)
import app_copies  # noqa: E402
import photos  # noqa: E402
from photos import PhotoExtractor  # noqa: E402
from rpc_contract_support import load_engine_module  # noqa: E402

# main.py under its own name, loaded now, while this file is collected: test_backup.py later
# reloads "main" with stand-ins for the extractors, and whatever is first imported then
# (whatsapp.py's export class, for one) is built on a stand-in for the rest of the run.
ENGINE = load_engine_module()

Usage = namedtuple("Usage", "total used free")
VIDEO = b"\x00\x00\x00\x14ftypqt  " + b"not really a video" * 4


def file_id(relative_path, domain="CameraRollDomain"):
    return hashlib.sha1(f"{domain}-{relative_path}".encode()).hexdigest()


class Backup:
    """An unencrypted backup's folder: Manifest.db, and files under their fileIDs."""

    encrypted = False
    udid = "00008120-0000000000000001"

    def __init__(self, folder, flat=False):
        self.backup_dir = folder
        self.flat = flat  # iOS 9 and earlier keep files directly in the folder
        self.manifest = os.path.join(folder, "Manifest.db")
        conn = sqlite3.connect(self.manifest)
        conn.execute("CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)")
        conn.commit()
        conn.close()

    def add(self, relative_path, data=VIDEO, listed=True):
        fid = file_id(relative_path)
        folder = self.backup_dir if self.flat else os.path.join(self.backup_dir, fid[:2])
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, fid), "wb") as f:
            f.write(data)
        if listed:
            conn = sqlite3.connect(self.manifest)
            conn.execute("INSERT INTO Files VALUES (?, 'CameraRollDomain', ?, 1, NULL)", (fid, relative_path))
            conn.commit()
            conn.close()
        return fid

    def stored(self, fid):
        return os.path.join(self.backup_dir, fid) if self.flat else os.path.join(self.backup_dir, fid[:2], fid)

    def get_manifest_db(self):
        return self.manifest

    def get_file(self, relative_path, domain="HomeDomain"):
        path = self.stored(file_id(relative_path, domain))
        return path if os.path.isfile(path) else None


class EncryptedBackup:
    """An encrypted backup as _resolve_file sees it: get_file decrypts to a temp file that keeps its extension."""

    encrypted = True
    udid = "00008120-0000000000000001"
    _decrypted_backup = None

    def __init__(self, folder, temp):
        self.backup_dir = folder
        self.temp = temp

    def get_file(self, relative_path, domain="HomeDomain"):
        ext = os.path.splitext(relative_path)[1]
        path = os.path.join(self.temp, file_id(relative_path, domain) + ext)
        with open(path, "wb") as f:
            f.write(VIDEO)
        return path


class PhotoOpenCase(unittest.TestCase):

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.addCleanup(temp.cleanup)
        # Point the system temp folder at our own, so copies stay in it.
        saved = tempfile.tempdir
        tempfile.tempdir = temp.name
        self.addCleanup(setattr, tempfile, "tempdir", saved)
        self.folder, self.temp = folder.name, temp.name
        self.photos = PhotoExtractor()

    def inside(self, path, folder):
        return os.path.commonpath([os.path.realpath(path), os.path.realpath(folder)]) == os.path.realpath(folder)


class TestUnencrypted(PhotoOpenCase):

    def test_a_copy_under_the_iphones_name_never_the_backups_own_file(self):
        for flat in (False, True):
            with self.subTest("iOS 9 and earlier" if flat else "iOS 10 and later"):
                folder = os.path.join(self.folder, "flat" if flat else "nested")
                os.makedirs(folder)
                backup = Backup(folder, flat=flat)
                fid = backup.add("Media/DCIM/100APPLE/IMG_0042.MOV")
                self.assertEqual(os.path.splitext(backup.stored(fid))[1], "", "what the backup keeps has no extension")

                got = self.photos.get_file_for_app(backup, fid)

                self.assertEqual(sorted(got), ["filename", "openable", "path"])
                self.assertEqual(os.path.basename(got["path"]), "IMG_0042.MOV")
                self.assertEqual(got["filename"], "IMG_0042.MOV")
                self.assertIs(got["openable"], True)
                self.assertFalse(self.inside(got["path"], folder), "not a path into the backup's folder")
                self.assertTrue(self.inside(got["path"], self.temp))
                with open(got["path"], "rb") as f:
                    self.assertEqual(f.read(), VIDEO)
                with open(backup.stored(fid), "rb") as f:
                    self.assertEqual(f.read(), VIDEO, "the backup's file is as it was")

    @unittest.skipIf(os.name == "nt", "Windows has no executable permission")
    def test_from_a_drive_that_marks_every_file_executable(self):
        """Issue #297: macOS ran the backup's file in Terminal. The copy has a video's name and can't be run."""
        backup = Backup(self.folder)
        fid = backup.add("Media/DCIM/100APPLE/IMG_0042.MOV")
        os.chmod(backup.stored(fid), 0o777)
        got = self.photos.get_file_for_app(backup, fid)
        self.assertEqual(stat.S_IMODE(os.stat(got["path"]).st_mode), 0o600)
        self.assertEqual(os.path.splitext(got["path"])[1], ".MOV")

    def test_the_same_copy_the_second_time(self):
        backup = Backup(self.folder)
        fid = backup.add("Media/DCIM/100APPLE/IMG_0042.MOV")
        first = self.photos.get_file_for_app(backup, fid)
        with mock.patch.object(app_copies, "replace_with_copy", side_effect=AssertionError("copied again")):
            self.assertEqual(self.photos.get_file_for_app(backup, fid), first)

    def test_two_videos_with_one_name_and_one_video_in_two_backups(self):
        backup = Backup(self.folder)
        a = backup.add("Media/DCIM/100APPLE/IMG_0042.MOV", b"first")
        b = backup.add("Media/DCIM/101APPLE/IMG_0042.MOV", b"second")
        other = Backup(tempfile.mkdtemp(dir=self.folder))
        other.udid = "00008120-0000000000000002"
        c = other.add("Media/DCIM/100APPLE/IMG_0042.MOV", b"third")
        self.assertEqual(a, c, "one path, one fileID, in every backup")
        paths = [self.photos.get_file_for_app(backup, a)["path"], self.photos.get_file_for_app(backup, b)["path"],
                 self.photos.get_file_for_app(other, c)["path"]]
        self.assertEqual(len(set(paths)), 3)
        self.assertEqual({os.path.basename(p) for p in paths}, {"IMG_0042.MOV"})
        contents = []
        for p in paths:
            with open(p, "rb") as f:
                contents.append(f.read())
        self.assertEqual(contents, [b"first", b"second", b"third"])

    def test_a_file_that_isnt_in_the_backups_folder(self):
        backup = Backup(self.folder)
        self.assertEqual(self.photos.get_file_for_app(backup, "0" * 40), {"error": "File not found"})
        self.assertEqual(os.listdir(self.temp), [], "no folder of copies made for nothing")

    def test_only_a_photo_or_video_is_openable(self):
        """The name comes from the backup. A program is never one click from running, whatever lists it as a video."""
        backup = Backup(self.folder)
        for relative_path, name in [("Media/DCIM/100APPLE/IMG_0042.MOV.command", "IMG_0042.MOV.command"),
                                    ("Media/DCIM/100APPLE/run.sh", "run.sh"),
                                    ("Media/DCIM/100APPLE/IMG_0042", "IMG_0042")]:
            with self.subTest(name):
                got = self.photos.get_file_for_app(backup, backup.add(relative_path))
                self.assertEqual(os.path.basename(got["path"]), name)
                self.assertIs(got["openable"], False)
                self.assertFalse(self.inside(got["path"], self.folder))

    def test_a_file_the_backup_doesnt_name_is_copied_but_not_openable(self):
        backup = Backup(self.folder)
        fid = backup.add("Media/DCIM/100APPLE/IMG_0042.MOV", listed=False)
        got = self.photos.get_file_for_app(backup, fid)
        self.assertIs(got["openable"], False)
        self.assertFalse(self.inside(got["path"], self.folder))

    def test_a_manifest_that_cant_be_read_doesnt_stop_the_engine(self):
        backup = Backup(self.folder)
        fid = backup.add("Media/DCIM/100APPLE/IMG_0042.MOV")
        with open(backup.manifest, "wb") as f:
            f.write(b"not a database")
        got = self.photos.get_file_for_app(backup, fid)
        self.assertIs(got["openable"], False)
        self.assertFalse(self.inside(got["path"], self.folder))


class TestWhenItCantBeCopied(PhotoOpenCase):

    def test_no_room_says_how_much_is_needed_and_what_to_do(self):
        backup = Backup(self.folder)
        fid = backup.add("Media/DCIM/100APPLE/IMG_0042.MOV")
        size = 4_200_000_000
        with mock.patch.object(app_copies.os.path, "getsize", return_value=size), \
                mock.patch.object(app_copies.shutil, "disk_usage", return_value=Usage(10 ** 12, 0, 310_000_000)):
            got = self.photos.get_file_for_app(backup, fid)
        self.assertEqual(sorted(got), ["error"])
        self.assertIn("this one is 4.2 GB, and 310 MB is free", got["error"])
        self.assertIn("Free up some space", got["error"])
        self.assertNotRegex(got["error"], r"Errno|ENOSPC|bytes|Traceback")
        self.assertEqual([n for _, _, names in os.walk(self.temp) for n in names], [])

    def test_a_copy_that_fails_says_so_in_plain_words(self):
        backup = Backup(self.folder)
        fid = backup.add("Media/DCIM/100APPLE/IMG_0042.MOV")
        with mock.patch.object(app_copies, "replace_with_copy", side_effect=OSError(5, "Input/output error")):
            got = self.photos.get_file_for_app(backup, fid)
        self.assertEqual(got, {"error": photos.NOT_COPIED})
        self.assertNotRegex(got["error"], r"Errno|Input/output|Traceback")

    def test_sizes_as_people_say_them(self):
        self.assertEqual(photos._size_words(4_200_000_000), "4.2 GB")
        self.assertEqual(photos._size_words(1_000_000_000), "1.0 GB")
        self.assertEqual(photos._size_words(310_400_000), "310 MB")
        self.assertEqual(photos._size_words(12), "1 MB")


class TestEncrypted(PhotoOpenCase):

    def test_the_decrypted_temp_file_which_keeps_its_extension(self):
        backup = EncryptedBackup(self.folder, self.temp)
        got = self.photos.get_file_for_app(backup, "dcim:Media/DCIM/100APPLE/IMG_0042.MOV")
        self.assertEqual(os.path.splitext(got["path"])[1], ".MOV")
        self.assertEqual(got["filename"], "IMG_0042.MOV")
        self.assertIs(got["openable"], True)
        self.assertEqual(os.path.dirname(got["path"]), self.temp, "used where it is: not copied a second time")


class TestOverRpc(PhotoOpenCase):
    """main.py's get_photo_path, with the engine's own notifications."""

    def setUp(self):
        super().setUp()
        self.server = ENGINE.SidecarServer()
        self.backup = Backup(self.folder)
        self.fid = self.backup.add("Media/DCIM/100APPLE/IMG_0042.MOV", b"0123456789")
        self.server.backup_manager.get_open_backup = lambda udid: self.backup
        self.notes = []
        self.server.send_notification = lambda method, params: self.notes.append((method, params))

    def call(self):
        return self.server.methods["get_photo_path"]({"udid": self.backup.udid, "file_hash": self.fid})

    def test_a_quick_copy_sends_no_progress(self):
        got = self.call()
        self.assertEqual(os.path.basename(got["path"]), "IMG_0042.MOV")
        self.assertIs(got["openable"], True)
        self.assertEqual(self.notes, [])

    def test_a_long_copy_says_it_is_still_going(self):
        """Each notification starts the app's time limit for the call over (electron/sidecar.ts)."""
        with mock.patch.object(ENGINE, "_OPEN_PROGRESS_SECONDS", 0), \
                mock.patch.object(app_copies, "_CHUNK_BYTES", 4):
            got = self.call()
        self.assertIs(got["openable"], True)
        self.assertEqual(self.notes, [
            ("open.progress", {"kind": "photos", "done": 4, "total": 10}),
            ("open.progress", {"kind": "photos", "done": 8, "total": 10}),
            ("open.progress", {"kind": "photos", "done": 10, "total": 10}),
        ])


if __name__ == "__main__":
    unittest.main()
