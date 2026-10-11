"""
Tests for photos with no location. iOS writes -180 to ZLATITUDE and ZLONGITUDE
then, not NULL (392 of 567 photos on the public iOS 17.3 Hickman backup).
"""

import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from photos import PhotoExtractor  # noqa: E402
from stats import StatsComputer  # noqa: E402


class _FakeBackup:
    encrypted = True  # get_photo_metadata then addresses files as "dcim:<path>"

    def __init__(self, photos_db: str):
        self.photos_db = photos_db

    def get_file(self, relative_path, domain="HomeDomain"):
        if (domain, relative_path) == ("CameraRollDomain", "Media/PhotoData/Photos.sqlite"):
            return self.photos_db
        return None


class TestPhotoLocation(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        path = os.path.join(self._tmp.name, "Photos.sqlite")
        conn = sqlite3.connect(path)
        conn.execute(
            "CREATE TABLE ZASSET (Z_PK INTEGER PRIMARY KEY, ZUUID VARCHAR, ZFILENAME VARCHAR, "
            "ZDIRECTORY VARCHAR, ZKIND INTEGER, ZLATITUDE FLOAT, ZLONGITUDE FLOAT, ZTRASHEDSTATE INTEGER)"
        )
        conn.executemany(
            "INSERT INTO ZASSET VALUES (?, ?, ?, 'DCIM/100APPLE', 0, ?, ?, ?)",
            [
                (1, "PLACED", "IMG_0001.HEIC", 35.6, -78.8, 0),
                (2, "NOWHERE", "IMG_0002.HEIC", -180.0, -180.0, 0),
                (3, "NULL", "IMG_0003.HEIC", None, None, 0),
                (4, "ZERO", "IMG_0004.HEIC", 0.0, 0.0, 0),
                (5, "TRASHED", "IMG_0005.HEIC", 51.5, -0.1, 1),
            ],
        )
        conn.commit()
        conn.close()
        self.backup = _FakeBackup(path)

    def tearDown(self):
        self._tmp.cleanup()

    def test_dashboard_counts_only_photos_with_a_location(self):
        stats = StatsComputer()._photo_stats(self.backup)
        self.assertEqual(stats["total_photos"], 4)
        self.assertEqual(stats["with_location"], 1)

    def test_photo_details_report_no_location_as_null(self):
        details = PhotoExtractor().get_photo_metadata(self.backup, "NOWHERE")
        self.assertIsNone(details["latitude"])
        self.assertIsNone(details["longitude"])

    def test_photo_details_keep_a_real_location(self):
        details = PhotoExtractor().get_photo_metadata(self.backup, "PLACED")
        self.assertEqual((details["latitude"], details["longitude"]), (35.6, -78.8))


if __name__ == "__main__":
    unittest.main()
