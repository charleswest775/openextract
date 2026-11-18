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
from photos import LIBRARY, SMART_ALBUMS, PhotoExtractor  # noqa: E402
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

# What the Overview's Photos card counts, for the assets that have any:
# Z_PK → (ZKIND, ZFAVORITE, ZLATITUDE, ZLONGITUDE, ZDURATION).
DETAILS = {
    1: (1, 0, 44.6, -110.5, 20.0),  # a video with a location
    2: (1, 0, 44.6, -110.5, 12.5),  # a hidden video with a location
    3: (0, 1, 44.6, -110.5, 0),     # trashed favorite
    4: (0, 1, 44.6, -110.5, 0),     # favorite with a location, only in iCloud
    5: (1, 0, -180, -180, 30.0),    # video, only in iCloud
    8: (0, 1, -180, -180, 0),       # favorite
}
NO_DETAILS = (0, 0, -180, -180, 0)  # a photo with no location
# Hidden: a video in the backup, and a photo only in iCloud. All Photos leaves them out,
# as the iPhone does; they're under Hidden, and Save to this computer saves them too.
HIDDEN_ASSETS = {2, 9}


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
        self.camera_roll_reads = 0  # Manifest.db reads of CameraRollDomain
        for pk, directory, filename, _, present in ASSETS:
            if present:
                file_id = f"{pk:02d}" + "0" * 38
                os.makedirs(os.path.join(root, file_id[:2]), exist_ok=True)
                with open(os.path.join(root, file_id[:2], file_id), "wb") as f:
                    f.write(b"\xff\xd8\xff" + bytes(pk))
                self.files[_path(directory, filename)] = file_id

    def lose(self, *pks):
        """Take assets' files out of the folder but leave them in the list of files (OE-102)."""
        for pk, directory, filename, _, _ in ASSETS:
            if pk in pks:
                file_id = self.files[_path(directory, filename)]
                os.remove(os.path.join(self.backup_dir, file_id[:2], file_id))

    def get_file(self, relative_path, domain="HomeDomain"):
        if (domain, relative_path) == ("CameraRollDomain", "Media/PhotoData/Photos.sqlite"):
            return self.photos_db if os.path.exists(self.photos_db) else None
        file_id = self.files.get(relative_path) if domain == "CameraRollDomain" else None
        path = os.path.join(self.backup_dir, file_id[:2], file_id) if file_id else None
        return path if path and os.path.isfile(path) else None

    def list_files(self, domain=None, path_like=None):
        if domain == "CameraRollDomain":
            self.camera_roll_reads += 1
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
                             ZTRASHEDSTATE INTEGER, ZFAVORITE INTEGER, ZLATITUDE FLOAT,
                             ZLONGITUDE FLOAT, ZDURATION FLOAT, ZHIDDEN INTEGER);
        CREATE TABLE ZGENERICALBUM (Z_PK INTEGER PRIMARY KEY, ZTITLE VARCHAR, ZKIND INTEGER);
        CREATE TABLE Z_PRIMARYKEY (Z_ENT INTEGER PRIMARY KEY, Z_NAME VARCHAR, Z_SUPER INTEGER, Z_MAX INTEGER);
        CREATE TABLE Z_33ASSETS (Z_33ALBUMS INTEGER, Z_3ASSETS INTEGER, Z_FOK_3ASSETS INTEGER);
        INSERT INTO Z_PRIMARYKEY VALUES (33, 'GenericAlbum', 0, 10);
        """
    )
    conn.executemany(
        "INSERT INTO ZASSET (Z_PK, ZUUID, ZDIRECTORY, ZFILENAME, ZDATECREATED, ZTRASHEDSTATE,"
        " ZKIND, ZFAVORITE, ZLATITUDE, ZLONGITUDE, ZDURATION, ZHIDDEN) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [(pk, f"UUID-{pk}", d, f, 700000000 + pk, t, *DETAILS.get(pk, NO_DETAILS), int(pk in HIDDEN_ASSETS))
         for pk, d, f, t, _ in ASSETS],
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
        self.assertEqual(sorted(p["uuid"] for p in photos), ["UUID-1", "UUID-8"])
        self.assertEqual(page["total"], 6)  # library rows, not trashed or hidden
        self.assertEqual(page["in_backup"], 2)
        self.assertEqual(page["not_in_backup"], 4)

    def test_every_photo_with_the_hidden_ones_is_what_paging_returns(self):
        photos, page = _page_through(self.extractor, self.backup, album_id=LIBRARY)
        self.assertEqual(sorted(p["uuid"] for p in photos), ["UUID-1", "UUID-2", "UUID-8"])
        self.assertEqual((page["total"], page["in_backup"], page["not_in_backup"]), (8, 3, 5))

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
        self.assertEqual((albums["__all__"]["asset_count"], albums["__all__"]["in_backup"]), (6, 2))
        self.assertNotIn(LIBRARY, albums)
        self.assertEqual((albums[ALBUM]["asset_count"], albums[ALBUM]["in_backup"]), (4, 3))

    @unittest.skipUnless(SMART_ALBUMS, "needs ios-backup-core with Favorites and Hidden")
    def test_favorites_and_hidden_say_how_many_photos_are_in_the_backup(self):
        albums = {a["id"]: a for a in self.extractor.list_albums(self.backup)["albums"]}
        # Favorites: 4 (only in iCloud) and 8; 3 is trashed. Hidden: 2, and 9 (only in iCloud).
        self.assertEqual((albums["__favorites__"]["asset_count"], albums["__favorites__"]["in_backup"]), (2, 1))
        self.assertEqual((albums["__hidden__"]["asset_count"], albums["__hidden__"]["in_backup"]), (2, 1))

    @unittest.skipUnless(SMART_ALBUMS, "needs ios-backup-core with Favorites and Hidden")
    def test_favorites_and_hidden_counts_are_what_paging_returns(self):
        photos, page = _page_through(self.extractor, self.backup, album_id="__favorites__")
        self.assertEqual([p["uuid"] for p in photos], ["UUID-8"])
        self.assertEqual((page["total"], page["in_backup"], page["not_in_backup"]), (2, 1, 1))
        photos, page = _page_through(self.extractor, self.backup, album_id="__hidden__")
        self.assertEqual([p["uuid"] for p in photos], ["UUID-2"])
        self.assertEqual((page["total"], page["in_backup"], page["not_in_backup"]), (2, 1, 1))

    def test_export_saves_only_the_chosen_album(self):
        out = os.path.join(self._tmp.name, "album")
        result = self.extractor.export_photos(self.backup, out, {"album_id": ALBUM})
        self.assertEqual((result["exported"], result["errors"], result["not_in_backup"]), (3, 0, 1))
        self.assertEqual(sum(len(files) for _, _, files in os.walk(out)), 3)

    @unittest.skipUnless(SMART_ALBUMS, "needs ios-backup-core with Favorites and Hidden")
    def test_export_saves_hidden_photos_on_their_own(self):
        out = os.path.join(self._tmp.name, "hidden")
        result = self.extractor.export_photos(self.backup, out, {"album_id": "__hidden__"})
        self.assertEqual((result["exported"], result["errors"], result["not_in_backup"]), (1, 0, 1))

    def test_manifest_is_read_once_per_backup(self):
        self.extractor.list_photos(self.backup, offset=0, limit=1)
        reads = self.backup.camera_roll_reads
        _page_through(self.extractor, self.backup, limit=1)
        _page_through(self.extractor, self.backup, album_id=ALBUM, limit=1)
        self.extractor.list_albums(self.backup)
        StatsComputer(self.extractor).compute(self.backup, {})
        self.assertEqual(self.backup.camera_roll_reads, reads)

    def test_export_reports_photos_not_in_the_backup(self):
        out = os.path.join(self._tmp.name, "export")
        result = self.extractor.export_photos(self.backup, out)
        self.assertEqual((result["exported"], result["errors"], result["not_in_backup"]), (2, 0, 4))

    def test_save_to_this_computer_saves_hidden_photos_too(self):
        # ExportPanel saves LIBRARY: All Photos and Hidden together.
        out = os.path.join(self._tmp.name, "everything")
        result = self.extractor.export_photos(self.backup, out, {"album_id": LIBRARY})
        self.assertEqual((result["exported"], result["errors"], result["not_in_backup"]), (3, 0, 5))
        self.assertEqual(sum(len(files) for _, _, files in os.walk(out)), 3)

    def test_overview_tile_counts_what_the_photos_screen_shows(self):
        # The tile showed library rows (8 here; 6,000 for the reporter, with about 300 in the backup).
        overview = StatsComputer(self.extractor).compute(self.backup, {})["overview"]
        self.assertEqual(overview["photos_in_backup"], 2)
        self.assertEqual(overview["photos_missing_from_folder"], 0)
        self.assertEqual(overview["total_photos"] + overview["total_videos"], 6)
        # Not in that count, as on the iPhone, but Save to this computer adds it.
        self.assertEqual(overview["hidden_photos_in_backup"], 1)

    def test_overview_card_describes_the_photos_in_the_backup(self):
        # It described every library row, next to a tile that counts only these 3.
        stats = StatsComputer(self.extractor).compute(self.backup, {})
        photos = stats["photos"]
        # All Photos: 1 and 8. The hidden video (2) isn't counted.
        self.assertEqual(photos["by_kind"], {"photo": 1, "video": 1})
        self.assertEqual((photos["total_favorites"], photos["with_location"]), (1, 1))
        self.assertEqual(photos["total_video_duration_seconds"], 20.0)
        listed, _ = _page_through(self.extractor, self.backup)
        dates = sorted(p["date_created"] for p in listed)
        self.assertEqual((photos["earliest_date"], photos["latest_date"]), (dates[0], dates[-1]))
        # Library rows, as before; the card says how many of them are only in iCloud.
        self.assertEqual((photos["total_photos"], photos["total_videos"]), (4, 2))
        self.assertEqual((stats["overview"]["total_photos"], stats["overview"]["total_videos"]), (4, 2))

    # ── Files the backup lists but its folder doesn't have (OE-102) ──────────

    def test_photos_missing_from_the_folder_are_left_out_and_counted(self):
        # OE-102: they were listed, and every tile failed with "Photo not found".
        self.backup.lose(1)
        photos, page = _page_through(self.extractor, self.backup)
        self.assertEqual([p["uuid"] for p in photos], ["UUID-8"])
        self.assertEqual((page["total"], page["in_backup"]), (6, 1))
        # Not counted as only in iCloud: 4, 5, 6 and 9's rows still are, as before.
        self.assertEqual((page["not_in_backup"], page["missing_from_folder"]), (4, 1))

    def test_nothing_is_missing_from_a_complete_folder(self):
        _, page = _page_through(self.extractor, self.backup)
        self.assertEqual(page["missing_from_folder"], 0)

    def test_album_and_every_photo_counts_leave_out_missing_files(self):
        self.backup.lose(1, 2)
        photos, page = _page_through(self.extractor, self.backup, album_id=ALBUM)
        self.assertEqual(sorted(p["uuid"] for p in photos), ["UUID-3", "UUID-8"])
        self.assertEqual((page["total"], page["in_backup"], page["not_in_backup"], page["missing_from_folder"]),
                         (4, 2, 1, 1))
        photos, page = _page_through(self.extractor, self.backup, album_id=LIBRARY)
        self.assertEqual([p["uuid"] for p in photos], ["UUID-8"])
        missing = 2 if SMART_ALBUMS else 1  # the hidden video too, where Hidden is counted
        self.assertEqual((page["in_backup"], page["missing_from_folder"]), (1, missing))
        albums = {a["id"]: a for a in self.extractor.list_albums(self.backup)["albums"]}
        self.assertEqual((albums["__all__"]["in_backup"], albums[ALBUM]["in_backup"]), (1, 2))

    @unittest.skipUnless(SMART_ALBUMS, "needs ios-backup-core with Favorites and Hidden")
    def test_favorites_leave_out_missing_files(self):
        self.backup.lose(8)
        photos, page = _page_through(self.extractor, self.backup, album_id="__favorites__")
        self.assertEqual(photos, [])
        self.assertEqual((page["total"], page["in_backup"], page["not_in_backup"], page["missing_from_folder"]),
                         (2, 0, 1, 1))

    def test_every_photo_missing_from_the_folder(self):
        self.backup.lose(1, 2, 3, 8)
        photos, page = _page_through(self.extractor, self.backup)
        self.assertEqual(photos, [])
        # All Photos: 1 and 8 (2 is hidden, 3 trashed).
        self.assertEqual((page["in_backup"], page["not_in_backup"], page["missing_from_folder"]), (0, 4, 2))
        overview = StatsComputer(self.extractor).compute(self.backup, {})["overview"]
        self.assertEqual(overview["photos_in_backup"], 0)
        # So the home page and Backup details don't call them only in iCloud.
        self.assertEqual(overview["photos_missing_from_folder"], 2)

    def test_export_reports_photos_missing_from_the_folder(self):
        self.backup.lose(1)
        out = os.path.join(self._tmp.name, "export")
        result = self.extractor.export_photos(self.backup, out)
        # Left out, as iCloud-only ones are, not errors.
        self.assertEqual((result["exported"], result["errors"], result["not_in_backup"], result["missing_from_folder"]),
                         (1, 0, 4, 1))

    def test_scan_without_a_photos_library_leaves_out_missing_files(self):
        # When Photos.sqlite can't be read, the DCIM folders are listed instead.
        self.backup.lose(2)
        os.remove(self.backup.photos_db)
        page = self.extractor.list_photos(self.backup, offset=0, limit=100)
        self.assertEqual(page["source"], "dcim_scan")
        self.assertEqual(sorted(p["filename"] for p in page["photos"]), ["IMG_0001.HEIC", "IMG_0003.HEIC"])
        self.assertEqual((page["in_backup"], page["missing_from_folder"]), (2, 1))

    def test_overview_card_is_empty_when_every_photo_is_only_in_icloud(self):
        self.backup.files.clear()
        stats = StatsComputer(self.extractor).compute(self.backup, {})
        photos = stats["photos"]
        self.assertEqual(photos["by_kind"], {})
        self.assertEqual(
            (photos["total_favorites"], photos["with_location"], photos["total_video_duration_seconds"],
             photos["earliest_date"], photos["latest_date"]),
            (0, 0, 0.0, None, None),
        )
        # The card still shows, to say all 6 are only in iCloud.
        overview = stats["overview"]
        self.assertEqual((overview["photos_in_backup"], overview["total_photos"] + overview["total_videos"]), (0, 6))
        self.assertEqual(overview["hidden_photos_in_backup"], 0)


class TestPhotoCountsUnencrypted(_PhotoCountTests, unittest.TestCase):
    encrypted = False

    def test_photos_are_addressed_by_file_id(self):
        photos, _ = _page_through(self.extractor, self.backup)
        self.assertEqual({p["file_hash"] for p in photos}, {f"{pk:02d}" + "0" * 38 for pk in (1, 8)})


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
                "dcim:Media/PhotoData/CPLAssets/group79/IMG_0100.JPG",
            },
        )


if __name__ == "__main__":
    unittest.main()
