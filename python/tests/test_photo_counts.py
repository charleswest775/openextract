"""
Photo counts for libraries whose originals aren't all in the backup (#106).

With iCloud Photos and "Optimize iPhone Storage", most rows in Photos.sqlite
have no file in the backup: a reporter's header said 6,000 photos while about
300 loaded. list_photos leaves those rows out, and now says how many photos it
holds (in_backup) next to the library row count (total) that paging uses.
"""

import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from photos import PhotoExtractor  # noqa: E402
from stats import StatsComputer  # noqa: E402

ALBUM = "10"
EMPTY_ALBUM = "11"

# (Z_PK, ZDIRECTORY, ZFILENAME, ZTRASHEDSTATE, original in the backup)
ASSETS = [
    (1, "DCIM/100APPLE", "IMG_0001.HEIC", 0, True),
    (2, "DCIM/100APPLE", "IMG_0002.HEIC", 0, True),
    (3, "DCIM/100APPLE", "IMG_0003.HEIC", 1, True),   # trashed
    (4, "DCIM/105APPLE", "IMG_5000.HEIC", 0, False),  # only in iCloud
    (5, "DCIM/105APPLE", "IMG_5001.HEIC", 0, False),  # only in iCloud
    (6, "PhotoCloudSharingData/1/2/100CLOUD", "IMG_9000.JPG", 0, False),  # Shared Album
    (7, "DCIM/105APPLE", None, 0, False),             # no file name
    # iCloud Photos keeps photos from other devices outside DCIM
    (8, "PhotoData/CPLAssets/group79", "IMG_0100.JPG", 0, True),
    (9, "PhotoData/CPLAssets/group80", "IMG_0101.JPG", 0, False),
]
ALBUM_ASSETS = [1, 3, 4, 8]


def _path(directory: str, filename: str) -> str:
    """Where the asset's file is in CameraRollDomain."""
    return f"Media/{directory}/{filename}"


class _FakeBackup:
    """A backup accessor over a Photos.sqlite and a few DCIM files on disk."""

    def __init__(self, root: str, encrypted: bool):
        self.backup_dir = root
        self.encrypted = encrypted
        self.photos_db = os.path.join(root, "Photos.sqlite")
        self.files = {}  # CameraRollDomain relative path → fileID
        self.list_files_calls = 0
        for pk, directory, filename, _, present in ASSETS:
            if present:
                file_id = f"{pk:02d}" + "0" * 38
                os.makedirs(os.path.join(root, file_id[:2]), exist_ok=True)
                with open(os.path.join(root, file_id[:2], file_id), "wb") as f:
                    f.write(b"\xff\xd8\xff" + bytes(pk))
                self.files[_path(directory, filename)] = file_id

    def get_file(self, relative_path, domain="HomeDomain"):
        if (domain, relative_path) == ("CameraRollDomain", "Media/PhotoData/Photos.sqlite"):
            return self.photos_db
        file_id = self.files.get(relative_path) if domain == "CameraRollDomain" else None
        return os.path.join(self.backup_dir, file_id[:2], file_id) if file_id else None

    def list_files(self, domain=None, path_like=None):
        self.list_files_calls += 1
        prefix = (path_like or "%").rstrip("%")
        return [
            {"hash": h, "domain": "CameraRollDomain", "path": p}
            for p, h in self.files.items() if p.startswith(prefix)
        ]


def _write_photos_db(path: str) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE ZASSET (Z_PK INTEGER PRIMARY KEY, ZUUID VARCHAR, ZDIRECTORY VARCHAR,
                             ZFILENAME VARCHAR, ZKIND INTEGER, ZDATECREATED TIMESTAMP,
                             ZTRASHEDSTATE INTEGER);
        CREATE TABLE ZGENERICALBUM (Z_PK INTEGER PRIMARY KEY, ZTITLE VARCHAR, ZKIND INTEGER);
        CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);
        CREATE TABLE Z_33ASSETS (Z_33ALBUMS INTEGER, Z_3ASSETS INTEGER, Z_FOK_3ASSETS INTEGER);
        INSERT INTO Z_PRIMARYKEY VALUES (33, 'GenericAlbum', 0, 10);
        """
    )
    conn.executemany(
        "INSERT INTO ZASSET VALUES (?, ?, ?, ?, 0, ?, ?)",
        [(pk, f"UUID-{pk}", d, f, 700000000 + pk, t) for pk, d, f, t, _ in ASSETS],
    )
    conn.execute("INSERT INTO ZGENERICALBUM VALUES (?, 'Yellowstone', 2)", (int(ALBUM),))
    conn.execute("INSERT INTO ZGENERICALBUM VALUES (?, 'Empty', 2)", (int(EMPTY_ALBUM),))
    conn.executemany("INSERT INTO Z_33ASSETS VALUES (?, ?, 0)", [(int(ALBUM), pk) for pk in ALBUM_ASSETS])
    conn.commit()
    conn.close()


def _page_through(extractor, backup, album_id=None, limit=2):
    """Page the way the grid does: by library rows, until offset reaches total."""
    photos, offset = [], 0
    while True:
        page = extractor.list_photos(backup, offset=offset, limit=limit, album_id=album_id)
        photos += page["photos"]
        offset += limit
        if offset >= page["total"]:
            return photos, page


class _PhotoCountTests:
    encrypted: bool

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.backup = _FakeBackup(self._tmp.name, self.encrypted)
        _write_photos_db(self.backup.photos_db)
        self.extractor = PhotoExtractor()

    def tearDown(self):
        self._tmp.cleanup()

    def test_library_count_is_what_paging_returns(self):
        photos, page = _page_through(self.extractor, self.backup)
        self.assertEqual(sorted(p["uuid"] for p in photos), ["UUID-1", "UUID-2", "UUID-8"])
        self.assertEqual(page["total"], 8)  # library rows, not trashed
        self.assertEqual(page["in_backup"], 3)
        self.assertEqual(page["not_in_backup"], 5)

    def test_album_count_is_what_paging_returns(self):
        # An album view lists every asset in the album, trashed ones too (as the library does).
        photos, page = _page_through(self.extractor, self.backup, album_id=ALBUM)
        self.assertEqual(sorted(p["uuid"] for p in photos), ["UUID-1", "UUID-3", "UUID-8"])
        self.assertEqual((page["total"], page["in_backup"], page["not_in_backup"]), (4, 3, 1))

    def test_empty_album_lists_nothing(self):
        # It used to fall back to the DCIM scan, which lists the whole camera roll.
        page = self.extractor.list_photos(self.backup, album_id=EMPTY_ALBUM)
        self.assertEqual((page["photos"], page["total"], page["in_backup"]), ([], 0, 0))

    def test_albums_say_how_many_photos_are_in_the_backup(self):
        albums = {a["id"]: a for a in self.extractor.list_albums(self.backup)["albums"]}
        self.assertEqual((albums["__all__"]["asset_count"], albums["__all__"]["in_backup"]), (8, 3))
        self.assertEqual((albums[ALBUM]["asset_count"], albums[ALBUM]["in_backup"]), (4, 3))

    def test_manifest_is_read_once_per_backup(self):
        self.extractor.list_photos(self.backup, offset=0, limit=1)
        reads = self.backup.list_files_calls
        _page_through(self.extractor, self.backup, limit=1)
        _page_through(self.extractor, self.backup, album_id=ALBUM, limit=1)
        self.extractor.list_albums(self.backup)
        self.assertEqual(self.backup.list_files_calls, reads)


    def test_export_reports_photos_not_in_the_backup(self):
        out = os.path.join(self._tmp.name, "export")
        result = self.extractor.export_photos(self.backup, out)
        self.assertEqual((result["exported"], result["errors"], result["not_in_backup"]), (3, 0, 5))

    def test_overview_tile_counts_what_the_photos_screen_shows(self):
        # The tile showed library rows (8 here; 6,000 for the reporter, with about 300 in the backup).
        overview = StatsComputer(self.extractor).compute(self.backup, {})["overview"]
        self.assertEqual(overview["photos_in_backup"], 3)
        self.assertEqual(overview["total_photos"] + overview["total_videos"], 8)


class TestPhotoCountsUnencrypted(_PhotoCountTests, unittest.TestCase):
    encrypted = False

    def test_photos_are_addressed_by_file_id(self):
        photos, _ = _page_through(self.extractor, self.backup)
        self.assertEqual({p["file_hash"] for p in photos}, {f"{pk:02d}" + "0" * 38 for pk in (1, 2, 8)})


class TestPhotoCountsEncrypted(_PhotoCountTests, unittest.TestCase):
    encrypted = True

    def test_photos_are_addressed_by_path(self):
        # Before #106 an encrypted backup listed every library row, so iCloud-only
        # photos showed up as tiles that never loaded.
        photos, _ = _page_through(self.extractor, self.backup)
        self.assertEqual(
            {p["file_hash"] for p in photos},
            {
                "dcim:Media/DCIM/100APPLE/IMG_0001.HEIC",
                "dcim:Media/DCIM/100APPLE/IMG_0002.HEIC",
                "dcim:Media/PhotoData/CPLAssets/group79/IMG_0100.JPG",
            },
        )


if __name__ == "__main__":
    unittest.main()
