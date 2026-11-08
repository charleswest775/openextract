"""
Saved photos carry the date they were taken.

export_photos copied each file with shutil.copy2, which keeps the backup file's
modified time: the day the backup was made, or for an encrypted backup a date
from its decrypted temp file. Converted JPEGs and .json sidecars got the time
of saving, and the conversion dropped the HEIC's EXIF, date taken included. So
Finder, Explorer and photo apps sorted a whole library by when it was backed up.
"""

import io
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import photos  # noqa: E402
from photos import PhotoExtractor  # noqa: E402

# Taken at 4:10 PM PDT, which is 23:10 UTC.
TAKEN = datetime(2024, 7, 13, 23, 10, 37, tzinfo=timezone.utc)
TAKEN_ISO = TAKEN.isoformat()  # what ios-backup-core gives: "2024-07-13T23:10:37+00:00"
BACKED_UP = datetime(2026, 11, 5, 16, 35, 59, tzinfo=timezone.utc).timestamp()

_ORIENTATION, _EXIF_IFD, _DATE_TAKEN, _DATE_TAKEN_OFFSET = 0x0112, 0x8769, 0x9003, 0x9011


def _use_time_zone(test: unittest.TestCase, tz: str) -> None:
    """Set this process's local time zone for the rest of the test (POSIX only)."""
    if not hasattr(time, "tzset"):
        return
    patcher = mock.patch.dict(os.environ, {"TZ": tz})
    patcher.start()
    test.addCleanup(time.tzset)
    test.addCleanup(patcher.stop)
    time.tzset()


def _heic(date_taken: bool) -> bytes:
    """A 40x20 HEIC whose EXIF says to turn it a quarter turn clockwise, with or without a date taken."""
    from PIL import Image
    img = Image.new("RGB", (40, 20), "blue")
    exif = Image.Exif()
    exif[_ORIENTATION] = 6
    exif[0x010F] = "Apple"  # Make
    if date_taken:
        details = exif.get_ifd(_EXIF_IFD)
        details[_DATE_TAKEN] = "2024:07:13 16:10:37"
        details[_DATE_TAKEN_OFFSET] = "-07:00"
    out = io.BytesIO()
    img.save(out, format="HEIF", exif=exif.tobytes())
    return out.getvalue()


class _Backup:
    """An unencrypted backup: each file at <backup>/<first two of fileID>/<fileID>, dated when it was backed up."""

    encrypted = False

    def __init__(self, root: str):
        self.backup_dir = root

    def add(self, file_id: str, content: bytes) -> str:
        os.makedirs(os.path.join(self.backup_dir, file_id[:2]), exist_ok=True)
        path = os.path.join(self.backup_dir, file_id[:2], file_id)
        with open(path, "wb") as f:
            f.write(content)
        os.utime(path, (BACKED_UP, BACKED_UP))
        return file_id


class _EncryptedBackup:
    """An encrypted backup: get_file decrypts into a new temp file each time, dated now."""

    encrypted = True

    def __init__(self, root: str):
        self.temp_dir = root
        self.files = {}  # CameraRollDomain relative path → content
        self.decrypted = []

    def add(self, relative_path: str, content: bytes) -> str:
        self.files[relative_path] = content
        return f"dcim:{relative_path}"

    def get_file(self, relative_path, domain="HomeDomain"):
        if domain != "CameraRollDomain" or relative_path not in self.files:
            return None
        fd, path = tempfile.mkstemp(dir=self.temp_dir)
        with os.fdopen(fd, "wb") as f:
            f.write(self.files[relative_path])
        self.decrypted.append(path)
        return path


class _Extractor(PhotoExtractor):
    """export_photos over a fixed list of assets instead of a Photos.sqlite."""

    def __init__(self, assets: list):
        super().__init__()
        self.assets = assets

    def list_photos(self, backup, offset=0, limit=100, album_id=None):
        return {"photos": self.assets[offset:offset + limit], "total": len(self.assets)}


def _asset(filename: str, file_hash: str, date_created=TAKEN_ISO) -> dict:
    return {"filename": filename, "file_hash": file_hash, "kind": "photo", "date_created": date_created}


class TestPhotoDates(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.out = os.path.join(self._tmp.name, "saved")
        # A computer west of UTC, so reading a UTC date as local time would show.
        _use_time_zone(self, "America/Los_Angeles")

    def _dir(self, name: str) -> str:
        path = os.path.join(self._tmp.name, name)
        os.makedirs(path)
        return path

    def _export(self, backup, assets: list, **options) -> dict:
        result = _Extractor(assets).export_photos(backup, self.out, options)
        self.assertEqual((result["exported"], result["errors"]), (len(assets), 0))
        return result

    def assertDated(self, name: str, when: float = TAKEN.timestamp()):
        st = os.stat(os.path.join(self.out, name))
        self.assertAlmostEqual(st.st_mtime, when, delta=1, msg=f"{name} modified time")
        # Windows moves the accessed time whenever anything reads a new file
        # (antivirus, the search indexer), so it can already be now.
        if sys.platform != "win32":
            self.assertAlmostEqual(st.st_atime, when, delta=1, msg=f"{name} accessed time")

    def test_copy_and_its_json_get_the_date_taken_not_the_backup_date(self):
        backup = _Backup(self._dir("backup"))
        file_id = backup.add("ab" + "0" * 38, b"\xff\xd8\xff photo")
        self._export(backup, [_asset("IMG_0001.JPG", file_id)], include_metadata_sidecar=True)
        self.assertDated("IMG_0001.JPG")
        self.assertDated("IMG_0001.JPG.json")
        with open(os.path.join(self.out, "IMG_0001.JPG"), "rb") as f:
            self.assertEqual(f.read(), b"\xff\xd8\xff photo")

    def test_copy_from_an_encrypted_backup_gets_the_date_taken(self):
        # Its source is a temp file decrypted moments ago.
        backup = _EncryptedBackup(self._dir("decrypted"))
        file_hash = backup.add("Media/DCIM/100APPLE/IMG_0001.MOV", b"\x00\x00\x00\x18ftypqt  ")
        self._export(backup, [dict(_asset("IMG_0001.MOV", file_hash), kind="video")])
        self.assertGreater(os.stat(backup.decrypted[0]).st_mtime, BACKED_UP)
        self.assertDated("IMG_0001.MOV")

    def test_date_taken_is_the_same_instant_however_it_is_written(self):
        backup = _Backup(self._dir("backup"))
        assets = [
            _asset("UTC.JPG", backup.add("01" + "0" * 38, b"utc")),
            # No zone: Photos.sqlite dates are UTC, not this computer's time.
            _asset("NOZONE.JPG", backup.add("02" + "0" * 38, b"no zone"), "2024-07-13T23:10:37"),
            _asset("PDT.JPG", backup.add("03" + "0" * 38, b"pdt"), "2024-07-13T16:10:37-07:00"),
            _asset("Z.JPG", backup.add("04" + "0" * 38, b"z"), "2024-07-13T23:10:37Z"),
        ]
        self._export(backup, assets)
        for name in ("UTC.JPG", "NOZONE.JPG", "PDT.JPG", "Z.JPG"):
            self.assertDated(name)

    def test_photo_from_before_1970_gets_its_date(self):
        # A scanned print, say. Its time stamp is negative.
        backup = _Backup(self._dir("backup"))
        file_id = backup.add("05" + "0" * 38, b"scan")
        self._export(backup, [_asset("SCAN.JPG", file_id, "1965-03-01T12:00:00+00:00")])
        self.assertDated("SCAN.JPG", datetime(1965, 3, 1, 12, tzinfo=timezone.utc).timestamp())

    def test_missing_or_unreadable_date_saves_the_file_as_before(self):
        backup = _Backup(self._dir("backup"))
        assets = [
            _asset("NONE.JPG", backup.add("06" + "0" * 38, b"none"), None),
            _asset("EMPTY.JPG", backup.add("07" + "0" * 38, b"empty"), ""),
            _asset("BAD.JPG", backup.add("08" + "0" * 38, b"bad"), "not a date"),
        ]
        self._export(backup, assets, include_metadata_sidecar=True)
        for name in ("NONE.JPG", "EMPTY.JPG", "BAD.JPG"):
            self.assertEqual(os.stat(os.path.join(self.out, name)).st_mtime, BACKED_UP)

    @unittest.skipUnless(photos.HAS_HEIF, "needs pillow-heif")
    def test_jpeg_made_from_a_heic_gets_the_date_taken_and_keeps_its_exif(self):
        from PIL import Image
        backup = _Backup(self._dir("backup"))
        file_id = backup.add("09" + "0" * 38, _heic(date_taken=True))
        self._export(backup, [_asset("IMG_0002.HEIC", file_id)], format="jpeg",
                     include_metadata_sidecar=True)
        self.assertDated("IMG_0002.jpg")
        self.assertDated("IMG_0002.jpg.json")

        with Image.open(os.path.join(self.out, "IMG_0002.jpg")) as jpeg:
            exif = jpeg.getexif()
            size = jpeg.size
        details = exif.get_ifd(_EXIF_IFD)
        # The camera's own date and zone, not Photos.sqlite's.
        self.assertEqual((details.get(_DATE_TAKEN), details.get(_DATE_TAKEN_OFFSET)),
                         ("2024:07:13 16:10:37", "-07:00"))
        self.assertEqual(exif.get(0x010F), "Apple")
        # Upright pixels, so the orientation mustn't turn them again.
        self.assertEqual((size, exif.get(_ORIENTATION)), ((20, 40), 1))

    @unittest.skipUnless(photos.HAS_HEIF, "needs pillow-heif")
    def test_jpeg_from_a_heic_without_a_date_taken_gets_photos_date(self):
        from PIL import Image
        backup = _Backup(self._dir("backup"))
        file_id = backup.add("10" + "0" * 38, _heic(date_taken=False))
        self._export(backup, [_asset("IMG_0003.HEIC", file_id)], format="jpeg")
        self.assertDated("IMG_0003.jpg")

        with Image.open(os.path.join(self.out, "IMG_0003.jpg")) as jpeg:
            details = jpeg.getexif().get_ifd(_EXIF_IFD)
        written = details.get(_DATE_TAKEN) + details.get(_DATE_TAKEN_OFFSET).replace(":", "")
        # This computer's local time, with its offset, so it's the same instant.
        self.assertEqual(datetime.strptime(written, "%Y:%m:%d %H:%M:%S%z"), TAKEN)
        self.assertEqual(details.get(_DATE_TAKEN), TAKEN.astimezone().strftime("%Y:%m:%d %H:%M:%S"))


if __name__ == "__main__":
    unittest.main()
