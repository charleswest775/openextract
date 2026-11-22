"""
Saving photos never puts one photo on top of another.

iPhones reuse file names (IMG_0001 again in a later DCIM folder after IMG_9999, or
after setting up a new iPhone), and photo saves copied each to its bare name: the
last one written replaced the others, and all of them were counted as saved.
"""

import hashlib
import os
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import photos  # noqa: E402

FIRST = "Media/DCIM/100APPLE/IMG_0001.JPG"
SECOND = "Media/DCIM/110APPLE/IMG_0001.JPG"
OTHER_CASE = "Media/DCIM/120APPLE/img_0001.jpg"  # the same name on macOS and Windows


class _FakeBackup:
    def __init__(self, root: str, files: dict, encrypted: bool = False):
        """``files`` is CameraRollDomain path → contents, oldest first."""
        self.backup_dir = root
        self.encrypted = encrypted
        self.files = {}
        os.makedirs(root, exist_ok=True)
        self.photos_db = os.path.join(root, "Photos.sqlite")
        conn = sqlite3.connect(self.photos_db)
        conn.execute(
            "CREATE TABLE ZASSET (Z_PK INTEGER PRIMARY KEY, ZUUID VARCHAR, ZDIRECTORY VARCHAR, "
            "ZFILENAME VARCHAR, ZKIND INTEGER, ZDATECREATED TIMESTAMP, ZTRASHEDSTATE INTEGER)"
        )
        for n, (path, contents) in enumerate(files.items()):
            file_id = hashlib.sha1(f"CameraRollDomain-{path}".encode()).hexdigest()
            os.makedirs(os.path.join(root, file_id[:2]), exist_ok=True)
            with open(os.path.join(root, file_id[:2], file_id), "wb") as f:
                f.write(contents)
            self.files[path] = file_id
            directory, name = path[len("Media/DCIM/"):].rsplit("/", 1)
            conn.execute("INSERT INTO ZASSET VALUES (?, ?, ?, ?, 0, ?, 0)",
                         (n + 1, f"UUID-{n}", directory, name, 700000000 + n))
        conn.commit()
        conn.close()

    def get_file(self, relative_path, domain="HomeDomain"):
        if domain != "CameraRollDomain":
            return None
        if relative_path == "Media/PhotoData/Photos.sqlite":
            return self.photos_db
        file_id = self.files.get(relative_path)
        return os.path.join(self.backup_dir, file_id[:2], file_id) if file_id else None

    def list_files(self, domain=None, path_like=None):
        prefix = (path_like or "%").rstrip("%")
        return [{"hash": h, "domain": "CameraRollDomain", "path": p}
                for p, h in self.files.items() if p.startswith(prefix)]


def _saved(folder: str) -> list:
    """What's in every file under ``folder``."""
    found = []
    for parent, _, names in os.walk(folder):
        for name in names:
            with open(os.path.join(parent, name), "rb") as f:
                found.append(f.read())
    return sorted(found)


class _SaveNameTests:
    encrypted: bool

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.out = os.path.join(self._tmp.name, "out")

    def tearDown(self):
        self._tmp.cleanup()

    def save(self, files: dict, name: str = "backup", **options) -> dict:
        backup = _FakeBackup(os.path.join(self._tmp.name, name), files, self.encrypted)
        return photos.PhotoExtractor().export_photos(backup, self.out, options)

    def test_photos_with_one_name_are_all_saved(self):
        result = self.save({FIRST: b"first", SECOND: b"second", OTHER_CASE: b"third"})
        self.assertEqual((result["exported"], result["errors"]), (3, 0))
        self.assertEqual(_saved(self.out), [b"first", b"second", b"third"])

    def test_one_month_folder_keeps_both(self):
        result = self.save({FIRST: b"first", SECOND: b"second"}, folder_structure="by_date")
        self.assertEqual((result["exported"], _saved(self.out)), (2, [b"first", b"second"]))

    def test_the_second_is_numbered_like_finder_and_explorer(self):
        self.save({FIRST: b"first", SECOND: b"second"})
        self.assertEqual(sorted(os.listdir(self.out)), ["IMG_0001 (2).JPG", "IMG_0001.JPG"])

    def test_two_identical_photos_are_still_two_files(self):
        result = self.save({FIRST: b"same", SECOND: b"same"})
        self.assertEqual((result["exported"], _saved(self.out)), (2, [b"same", b"same"]))

    def test_saving_again_makes_no_copies(self):
        files = {FIRST: b"first", SECOND: b"second"}
        self.save(files)
        result = self.save(files, name="backup again")
        self.assertEqual((result["exported"], _saved(self.out)), (2, [b"first", b"second"]))

    def test_a_newer_backup_adds_only_the_new_photo(self):
        self.save({FIRST: b"first", SECOND: b"second"})
        # The newest is written first, so it meets both earlier files before they're claimed.
        self.save({FIRST: b"first", SECOND: b"second", OTHER_CASE: b"third"}, name="newer")
        self.assertEqual(_saved(self.out), [b"first", b"second", b"third"])

    def test_a_different_file_already_in_the_folder_is_left_alone(self):
        os.makedirs(self.out)
        with open(os.path.join(self.out, "IMG_0001.JPG"), "wb") as f:
            f.write(b"theirs")
        self.save({FIRST: b"first"})
        self.assertEqual(_saved(self.out), [b"first", b"theirs"])

    def test_a_folder_with_the_photos_name_is_left_alone(self):
        os.makedirs(os.path.join(self.out, "IMG_0001.JPG"))
        result = self.save({FIRST: b"first"})
        self.assertEqual((result["exported"], _saved(self.out)), (1, [b"first"]))

    def test_each_photo_keeps_its_own_sidecar(self):
        self.save({FIRST: b"first", SECOND: b"second"}, include_metadata_sidecar=True)
        self.assertEqual(sorted(os.listdir(self.out)),
                         ["IMG_0001 (2).JPG", "IMG_0001 (2).JPG.json", "IMG_0001.JPG", "IMG_0001.JPG.json"])

    @unittest.skipUnless(photos.HAS_HEIF, "needs pillow-heif")
    def test_a_heic_made_a_jpeg_does_not_replace_the_jpeg_of_that_name(self):
        import io
        from PIL import Image

        heic = io.BytesIO()
        Image.new("RGB", (64, 64), (200, 30, 30)).save(heic, format="HEIF")
        files = {FIRST.replace(".JPG", ".HEIC"): heic.getvalue(), SECOND: b"a jpeg"}
        self.save(files, format="jpeg")
        self.save(files, name="backup again", format="jpeg")
        saved = _saved(self.out)
        self.assertEqual(len(saved), 2)
        self.assertIn(b"a jpeg", saved)

    def test_a_copy_that_fails_leaves_no_part_of_a_file(self):
        def drive_full(src, dst):
            with open(dst, "wb") as f:
                f.write(b"par")
            raise OSError(28, "No space left on device")

        with mock.patch.object(photos.shutil, "copyfile", side_effect=drive_full):
            result = self.save({FIRST: b"first"})
        self.assertEqual((result["exported"], result["errors"], _saved(self.out)), (0, 1, []))

    def test_a_drive_that_will_not_take_file_details_still_gets_the_photo(self):
        with mock.patch.object(photos.shutil, "copystat", side_effect=PermissionError(1, "no")):
            result = self.save({FIRST: b"first"})
        self.assertEqual((result["exported"], result["errors"], _saved(self.out)), (1, 0, [b"first"]))


class TestSaveNamesUnencrypted(_SaveNameTests, unittest.TestCase):
    encrypted = False


class TestSaveNamesEncrypted(_SaveNameTests, unittest.TestCase):
    encrypted = True


if __name__ == "__main__":
    unittest.main()
