"""
Photo stats on iOS 13 and earlier, where Photos.sqlite calls the assets table
ZGENERICASSET instead of ZASSET (found by the corpus tests on a real iOS 13.4.1
backup: the dashboard reported 0 photos).
"""

import os
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from stats import StatsComputer  # noqa: E402


class TestPhotoStatsBeforeIOS14(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.db = os.path.join(self.tmp.name, "Photos.sqlite")
        conn = sqlite3.connect(self.db)
        conn.executescript(
            """
            CREATE TABLE ZGENERICASSET (Z_PK INTEGER PRIMARY KEY, ZKIND INTEGER, ZTRASHEDSTATE INTEGER,
                                        ZDATECREATED TIMESTAMP, ZLATITUDE FLOAT, ZFAVORITE INTEGER,
                                        ZDURATION FLOAT);
            INSERT INTO ZGENERICASSET VALUES (1, 0, 0, 600000000, 35.6, 1, 0);
            INSERT INTO ZGENERICASSET VALUES (2, 0, 0, 600000100, NULL, 0, 0);
            INSERT INTO ZGENERICASSET VALUES (3, 1, 0, 600000200, NULL, 0, 12.5);
            INSERT INTO ZGENERICASSET VALUES (4, 0, 1, 600000300, NULL, 0, 0);  -- trashed
            """
        )
        conn.commit()
        conn.close()
        self.backup = MagicMock()
        self.backup.get_file.side_effect = (
            lambda path, *a, **k: self.db if path == "Media/PhotoData/Photos.sqlite" else None
        )

    def tearDown(self):
        self.tmp.cleanup()

    def test_counts_photos_and_videos(self):
        stats = StatsComputer()._photo_stats(self.backup)
        self.assertEqual(stats["total_photos"], 2)
        self.assertEqual(stats["total_videos"], 1)
        self.assertEqual(stats["with_location"], 1)


if __name__ == "__main__":
    unittest.main()
