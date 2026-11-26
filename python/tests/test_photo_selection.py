"""
Saving only some photos: the ones picked on the Photos screen, or those from some dates.

Two reports asked for it on 2026-11-24 (OE-193, OE-195): Photos could save a whole
album or every photo, nothing less. list_photos now takes a date range, and
export_photos the uuids of the photos picked, a date range and a kind. Saving into a
folder used before already skipped the photos in it (#315); export_photos now says
how many it found there, so the app can tell people only the new ones were copied.
"""

import datetime
import os
import sqlite3
import sys
import tempfile
import unittest
import uuid

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from photos import LIBRARY, SMART_ALBUMS, PhotoExtractor  # noqa: E402

ALBUM = "10"
FAVORITES = "__favorites__"
HIDDEN = "__hidden__"
APPLE_EPOCH = 978307200
JULY_1 = 1719835200  # 2024-07-01 12:00 UTC
DAY = 86400

# (Z_PK, file name, ZKIND, days after July 1 or None, trashed, favorite, hidden, file in the backup)
ASSETS = [
    (1, "IMG_0001.HEIC", 0, 0, 0, 0, 0, True),
    (2, "IMG_0002.MOV", 1, 1, 0, 1, 0, True),
    (3, "IMG_0003.HEIC", 0, 2, 0, 0, 1, True),    # hidden
    (4, "IMG_0004.HEIC", 0, 3, 1, 0, 0, True),    # trashed
    (5, "IMG_0005.HEIC", 0, 3, 0, 1, 0, False),   # only in iCloud
    (6, "IMG_0006.HEIC", 0, 5, 0, 0, 0, True),    # tests take it out of the folder
    (7, "IMG_0007.MOV", 1, 9, 0, 0, 0, True),
    (8, "IMG_0008.HEIC", 0, None, 0, 0, 0, True),  # no date
    (9, "IMG_0009.HEIC", 0, 9, 0, 0, 0, True),    # the same moment as 7
    (10, "IMG_0010.HEIC", 0, 30, 0, 0, 0, True),
]
ALBUM_ASSETS = [1, 2, 4, 5, 7]


def _taken(days) -> float:
    return JULY_1 + days * DAY


def _file_id(pk: int) -> str:
    return f"{pk:02d}" + "0" * 38


def _path(filename: str) -> str:
    return f"Media/DCIM/100APPLE/{filename}"


class _FakeBackup:
    """A backup accessor over a Photos.sqlite and the DCIM files in ASSETS, on disk."""

    def __init__(self, root: str, encrypted: bool):
        self.backup_dir = root
        self.encrypted = encrypted
        self.photos_db = os.path.join(root, "Photos.sqlite")
        self.files = {}  # CameraRollDomain relative path → fileID
        for pk, filename, *_, present in ASSETS:
            if present:
                file_id = _file_id(pk)
                os.makedirs(os.path.join(root, file_id[:2]), exist_ok=True)
                with open(os.path.join(root, file_id[:2], file_id), "wb") as f:
                    f.write(b"\xff\xd8\xff" + bytes([pk]) * 8)
                self.files[_path(filename)] = file_id
        conn = sqlite3.connect(self.photos_db)
        conn.executescript(
            """
            CREATE TABLE ZASSET (Z_PK INTEGER PRIMARY KEY, ZUUID VARCHAR, ZDIRECTORY VARCHAR,
                                 ZFILENAME VARCHAR, ZKIND INTEGER, ZDATECREATED TIMESTAMP,
                                 ZTRASHEDSTATE INTEGER, ZFAVORITE INTEGER, ZHIDDEN INTEGER,
                                 ZDURATION FLOAT);
            CREATE TABLE ZGENERICALBUM (Z_PK INTEGER PRIMARY KEY, ZTITLE VARCHAR, ZKIND INTEGER);
            CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);
            CREATE TABLE Z_33ASSETS (Z_33ALBUMS INTEGER, Z_3ASSETS INTEGER, Z_FOK_3ASSETS INTEGER);
            INSERT INTO Z_PRIMARYKEY VALUES (33, 'GenericAlbum', 0, 10);
            """
        )
        conn.executemany(
            "INSERT INTO ZASSET VALUES (?, ?, 'DCIM/100APPLE', ?, ?, ?, ?, ?, ?, ?)",
            [(pk, f"UUID-{pk}", name, kind, None if days is None else _taken(days) - APPLE_EPOCH,
              trashed, favorite, hidden, 5.0 if kind == 1 else 0.0)
             for pk, name, kind, days, trashed, favorite, hidden, _ in ASSETS],
        )
        conn.execute("INSERT INTO ZGENERICALBUM VALUES (?, 'Trip', 2)", (int(ALBUM),))
        conn.executemany("INSERT INTO Z_33ASSETS VALUES (?, ?, 0)", [(int(ALBUM), pk) for pk in ALBUM_ASSETS])
        conn.commit()
        conn.close()

    def lose(self, pk: int):
        """Take an asset's file out of the folder but leave it in the list of files (OE-102)."""
        file_id = _file_id(pk)
        os.remove(os.path.join(self.backup_dir, file_id[:2], file_id))

    def get_file(self, relative_path, domain="HomeDomain"):
        if (domain, relative_path) == ("CameraRollDomain", "Media/PhotoData/Photos.sqlite"):
            return self.photos_db if os.path.exists(self.photos_db) else None
        file_id = self.files.get(relative_path) if domain == "CameraRollDomain" else None
        path = os.path.join(self.backup_dir, file_id[:2], file_id) if file_id else None
        return path if path and os.path.isfile(path) else None

    def list_files(self, domain=None, path_like=None):
        prefix = (path_like or "%").rstrip("%")
        return [{"hash": h, "domain": "CameraRollDomain", "path": p}
                for p, h in self.files.items() if p.startswith(prefix)]


def _page_through(extractor, backup, album_id=None, limit=2, **dates):
    """Page the way the grid does: by library rows, until offset reaches total."""
    photos, offset = [], 0
    while True:
        page = extractor.list_photos(backup, offset=offset, limit=limit, album_id=album_id, **dates)
        photos += page["photos"]
        offset += limit
        if offset >= page["total"]:
            return photos, page


def _uuids(photos) -> list:
    return sorted((p["uuid"] for p in photos), key=lambda u: int(u.split("-")[1]))


def _when(photo):
    value = photo.get("date_created")
    return datetime.datetime.fromisoformat(value).timestamp() if value else None


def _saved(folder: str) -> list:
    return sorted(name for _, _, names in os.walk(folder) for name in names)


class _SelectionTests:
    encrypted: bool

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.backup = _FakeBackup(os.path.join(self._tmp.name, "backup"), self.encrypted)
        self.extractor = PhotoExtractor()
        self.out = os.path.join(self._tmp.name, "out")

    def tearDown(self):
        self._tmp.cleanup()

    # ── list_photos with dates ──

    @unittest.skipUnless(SMART_ALBUMS, "needs ios-backup-core with Favorites and Hidden")
    def test_a_date_range_lists_what_the_listing_has_from_those_dates(self):
        ranges = [
            {"date_from": _taken(0), "date_to": _taken(3)},
            {"date_from": _taken(2)},
            {"date_to": _taken(9)},
            {"date_from": _taken(9), "date_to": _taken(9) + 1},  # just the moment 7 and 9 share
            {"date_from": _taken(3), "date_to": _taken(4)},
            {"date_from": _taken(40)},
            {"date_from": _taken(-5), "date_to": _taken(100)},
        ]
        for album_id in (None, LIBRARY, ALBUM, FAVORITES, HIDDEN):
            everything, _ = _page_through(self.extractor, self.backup, album_id=album_id, limit=100)
            for dates in ranges:
                for limit in (1, 2, 100):
                    with self.subTest(album_id=album_id, dates=dates, limit=limit):
                        photos, page = _page_through(self.extractor, self.backup, album_id, limit, **dates)
                        low, high = dates.get("date_from"), dates.get("date_to")
                        expected = [p for p in everything if _when(p) is not None
                                    and (low is None or _when(p) >= low) and (high is None or _when(p) < high)]
                        self.assertEqual(_uuids(photos), _uuids(expected))
                        self.assertEqual(page["in_backup"], len(expected))

    def test_the_range_in_all_photos(self):
        # July 1 to 4: 1 and 2; 3 is hidden, 4 trashed, and 5 only in iCloud.
        photos, page = _page_through(self.extractor, self.backup, date_from=_taken(0), date_to=_taken(4))
        self.assertEqual(_uuids(photos), ["UUID-1", "UUID-2"])
        self.assertEqual((page["total"], page["in_backup"], page["not_in_backup"], page["missing_from_folder"]),
                         (3, 2, 1, 0))

    def test_the_end_of_a_range_is_left_out(self):
        photos, _ = _page_through(self.extractor, self.backup, date_from=_taken(1), date_to=_taken(9))
        self.assertEqual(_uuids(photos), ["UUID-2", "UUID-6"])
        photos, _ = _page_through(self.extractor, self.backup, date_from=_taken(1), date_to=_taken(9) + 1)
        self.assertEqual(_uuids(photos), ["UUID-2", "UUID-6", "UUID-7", "UUID-9"])

    def test_a_photo_with_no_date_is_in_no_range(self):
        everything, _ = _page_through(self.extractor, self.backup)
        self.assertIn("UUID-8", _uuids(everything))
        photos, page = _page_through(self.extractor, self.backup, date_to=_taken(1000))
        self.assertNotIn("UUID-8", _uuids(photos))
        self.assertEqual(page["total"], 7)  # 1, 2, 5, 6, 7, 9 and 10: not 8
        photos, _ = _page_through(self.extractor, self.backup, date_from=_taken(-1000))
        self.assertNotIn("UUID-8", _uuids(photos))

    def test_a_range_in_an_album(self):
        # The album has 1, 2, 4 (trashed: an album lists those), 5 (only in iCloud) and 7.
        photos, page = _page_through(self.extractor, self.backup, ALBUM, date_from=_taken(2), date_to=_taken(10))
        self.assertEqual(_uuids(photos), ["UUID-4", "UUID-7"])
        self.assertEqual((page["total"], page["in_backup"], page["not_in_backup"]), (3, 2, 1))

    def test_a_range_with_nothing_in_it(self):
        page = self.extractor.list_photos(self.backup, 0, 100, date_from=_taken(11), date_to=_taken(20))
        self.assertEqual((page["photos"], page["total"], page["in_backup"]), ([], 0, 0))

    def test_a_range_counts_the_photos_missing_from_the_folder(self):
        self.backup.lose(6)
        photos, page = _page_through(self.extractor, self.backup, date_from=_taken(4), date_to=_taken(6))
        self.assertEqual(photos, [])
        self.assertEqual((page["total"], page["in_backup"], page["not_in_backup"], page["missing_from_folder"]),
                         (1, 0, 0, 1))

    def test_a_range_in_a_backup_without_a_photos_library_finds_nothing(self):
        # The DCIM scan has no dates; the app hides the dates for it.
        os.remove(self.backup.photos_db)
        self.assertEqual(self.extractor.list_photos(self.backup, 0, 100)["source"], "dcim_scan")
        page = self.extractor.list_photos(self.backup, 0, 100, date_from=_taken(0))
        self.assertEqual((page["photos"], page["total"], page["source"]), ([], 0, "dcim_scan"))

    # ── export_photos: the photos picked ──

    def test_saves_only_the_photos_picked(self):
        result = self.extractor.export_photos(self.backup, self.out, {"uuids": ["UUID-2", "UUID-9"]})
        self.assertEqual((result["exported"], result["errors"], result["already_there"]), (2, 0, 0))
        self.assertEqual(_saved(self.out), ["IMG_0002.MOV", "IMG_0009.HEIC"])

    def test_a_picked_photo_is_saved_whatever_album_it_is_in(self):
        # Hidden and trashed ones too, when they were picked in Hidden or an album; and one with no date.
        result = self.extractor.export_photos(self.backup, self.out,
                                              {"uuids": ["UUID-3", "UUID-4", "UUID-8"], "album_id": ALBUM})
        self.assertEqual((result["exported"], result["errors"]), (3, 0))
        self.assertEqual(_saved(self.out), ["IMG_0003.HEIC", "IMG_0004.HEIC", "IMG_0008.HEIC"])

    def test_picked_photos_go_in_their_month_folders(self):
        self.extractor.export_photos(self.backup, self.out,
                                     {"uuids": ["UUID-1", "UUID-10", "UUID-8"], "folder_structure": "by_date"})
        self.assertTrue(os.path.isfile(os.path.join(self.out, "2024", "07", "IMG_0001.HEIC")))
        self.assertTrue(os.path.isfile(os.path.join(self.out, "2024", "07", "IMG_0010.HEIC")))
        self.assertTrue(os.path.isfile(os.path.join(self.out, "Unknown Date", "IMG_0008.HEIC")))

    def test_a_picked_photo_the_backup_has_no_file_for_is_an_error(self):
        self.backup.lose(6)
        seen = []
        result = self.extractor.export_photos(
            self.backup, self.out, {"uuids": ["UUID-1", "UUID-5", "UUID-6", "UUID-404", "UUID-1"]},
            on_progress=lambda done, total, failed: seen.append((done, total, failed)))
        self.assertEqual((result["exported"], result["errors"]), (1, 3))
        self.assertEqual(_saved(self.out), ["IMG_0001.HEIC"])
        self.assertEqual(seen[-1], (4, 4, 3))  # the total counts them, so it never goes past it

    def test_picked_photos_are_found_without_listing_the_library(self):
        calls = []
        real = self.extractor._inner.list_photos
        self.extractor._inner.list_photos = lambda *a, **k: calls.append(a) or real(*a, **k)
        self.extractor.export_photos(self.backup, self.out, {"uuids": ["UUID-7"]})
        self.assertEqual(calls, [])

    def test_a_photo_with_an_ios_6_uuid_can_be_picked(self):
        # iOS 6 keeps ZUUID as the UUID's 16 bytes; list_photos gives the uppercase string.
        raw = uuid.UUID("0f8fad5b-d9cb-469f-a165-70867728950e")
        conn = sqlite3.connect(self.backup.photos_db)
        conn.execute("UPDATE ZASSET SET ZUUID = ? WHERE Z_PK = 1", (raw.bytes,))
        conn.commit()
        conn.close()
        listed = next(p for p in _page_through(self.extractor, self.backup)[0] if p["filename"] == "IMG_0001.HEIC")
        result = self.extractor.export_photos(self.backup, self.out, {"uuids": [listed["uuid"]]})
        self.assertEqual((result["exported"], result["errors"]), (1, 0))
        self.assertEqual(_saved(self.out), ["IMG_0001.HEIC"])

    def test_picking_in_a_backup_without_a_photos_library(self):
        # The DCIM scan's photos have their file's id for a uuid.
        os.remove(self.backup.photos_db)
        scanned = self.extractor.list_photos(self.backup, 0, 100)["photos"]
        picked = [p["uuid"] for p in scanned if p["filename"] in ("IMG_0003.HEIC", "IMG_0010.HEIC")]
        result = self.extractor.export_photos(self.backup, self.out, {"uuids": picked})
        self.assertEqual((result["exported"], result["errors"]), (2, 0))
        self.assertEqual(_saved(self.out), ["IMG_0003.HEIC", "IMG_0010.HEIC"])

    # ── export_photos: dates and kinds ──

    def test_saves_the_photos_from_some_dates(self):
        result = self.extractor.export_photos(self.backup, self.out,
                                              {"date_from": _taken(0), "date_to": _taken(4)})
        self.assertEqual((result["exported"], result["errors"], result["not_in_backup"]), (2, 0, 1))
        self.assertEqual(_saved(self.out), ["IMG_0001.HEIC", "IMG_0002.MOV"])

    def test_saves_the_photos_from_some_dates_in_an_album(self):
        result = self.extractor.export_photos(self.backup, self.out,
                                              {"album_id": ALBUM, "date_from": _taken(2)})
        self.assertEqual((result["exported"], result["not_in_backup"]), (2, 1))
        self.assertEqual(_saved(self.out), ["IMG_0004.HEIC", "IMG_0007.MOV"])

    def test_saves_one_kind(self):
        result = self.extractor.export_photos(self.backup, self.out, {"kind": "video"})
        self.assertEqual((result["exported"], result["errors"]), (2, 0))
        self.assertEqual(_saved(self.out), ["IMG_0002.MOV", "IMG_0007.MOV"])

    def test_one_kind_from_some_dates(self):
        result = self.extractor.export_photos(self.backup, self.out,
                                              {"kind": "photo", "date_from": _taken(5), "date_to": _taken(31)})
        self.assertEqual(_saved(self.out), ["IMG_0006.HEIC", "IMG_0009.HEIC", "IMG_0010.HEIC"])
        self.assertEqual(result["exported"], 3)

    # ── saving into a folder used before ──

    def test_says_how_many_were_already_in_the_folder(self):
        first = self.extractor.export_photos(self.backup, self.out, {"uuids": ["UUID-1", "UUID-2"]})
        self.assertEqual((first["exported"], first["already_there"]), (2, 0))
        again = self.extractor.export_photos(self.backup, self.out)
        # All Photos: 1, 2, 6, 7, 8, 9, 10. Two were there, so five were copied.
        self.assertEqual((again["exported"], again["already_there"], again["errors"]), (7, 2, 0))
        self.assertEqual(len(_saved(self.out)), 7)

    def test_a_different_file_with_the_name_is_not_counted_as_already_there(self):
        os.makedirs(self.out)
        with open(os.path.join(self.out, "IMG_0001.HEIC"), "wb") as f:
            f.write(b"someone else's")
        result = self.extractor.export_photos(self.backup, self.out, {"uuids": ["UUID-1"]})
        self.assertEqual((result["exported"], result["already_there"]), (1, 0))
        self.assertEqual(_saved(self.out), ["IMG_0001 (2).HEIC", "IMG_0001.HEIC"])


class TestPhotoSelectionUnencrypted(_SelectionTests, unittest.TestCase):
    encrypted = False


class TestPhotoSelectionEncrypted(_SelectionTests, unittest.TestCase):
    encrypted = True


if __name__ == "__main__":
    unittest.main()
