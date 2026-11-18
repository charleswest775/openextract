"""
Files a backup lists that aren't in its folder (in-app report OE-102).

OE-102's backup (Windows, iOS 26.5.2, not encrypted) listed its photos in Manifest.db, but the
photo files weren't in the folder, and nothing said the backup didn't finish. The Photos screen
listed every photo and each one failed with "Photo not found". backup_files.py counts such
files, and check_backup_files hands the count to the app.
"""

import os
import plistlib
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import backup_files  # noqa: E402

UDID = "00008110-001A2B3C4D5E6F70"

# (domain, relativePath, flags): 1 a file, 2 a folder, 4 a link
FILES = [
    ("CameraRollDomain", "Media/DCIM/100APPLE", 2),
    ("CameraRollDomain", "Media/DCIM/100APPLE/IMG_0001.HEIC", 1),
    ("CameraRollDomain", "Media/DCIM/100APPLE/IMG_0002.MOV", 1),
    ("CameraRollDomain", "Media/PhotoData/CPLAssets/group79/IMG_0100.JPG", 1),
    ("CameraRollDomain", "Media/PhotoData/Photos.sqlite", 1),
    ("HomeDomain", "Library/SMS/sms.db", 1),
    ("MediaDomain", "Library/SMS/Attachments/ab/01/IMG_5000.HEIC", 1),
    ("HomeDomain", "Library/Preferences", 2),
    ("HomeDomain", "Library/Preferences/link", 4),
    ("AppDomain-net.whatsapp.WhatsApp", "Documents/ChatStorage.sqlite", 1),
]


def _file_id(domain: str, path: str) -> str:
    import hashlib
    return hashlib.sha1(f"{domain}-{path}".encode()).hexdigest()


def make_backup(parent: str, *, missing=(), legacy=False, sizes=None) -> str:
    """A backup folder of FILES, without the files whose paths are in `missing`.

    legacy: laid out as iOS 9 and earlier keep it (files directly in the folder), with the
    sizes ios-backup-core's Manifest.mbdb conversion records (`sizes`: path → size, default 1).
    """
    root = os.path.join(parent, UDID)
    os.makedirs(root)
    with open(os.path.join(root, "Info.plist"), "wb") as f:
        plistlib.dump({"Unique Identifier": UDID, "Device Name": "Phone", "Product Version": "26.5.2",
                       "Product Type": "iPhone14,4"}, f)
    with open(os.path.join(root, "Manifest.plist"), "wb") as f:
        plistlib.dump({"IsEncrypted": False}, f)
    conn = sqlite3.connect(os.path.join(root, "Manifest.db"))
    if legacy:
        conn.execute("CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, "
                     "flags INTEGER, file BLOB, size INTEGER)")
    else:
        conn.execute("CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, "
                     "flags INTEGER, file BLOB)")
    for domain, path, flags in FILES:
        file_id = _file_id(domain, path)
        size = (sizes or {}).get(path, 1)
        if legacy:
            conn.execute("INSERT INTO Files VALUES (?, ?, ?, ?, NULL, ?)", (file_id, domain, path, flags, size))
        else:
            conn.execute("INSERT INTO Files VALUES (?, ?, ?, ?, NULL)", (file_id, domain, path, flags))
        if flags != 1 or path in missing or (legacy and size == 0):
            continue
        folder = root if legacy else os.path.join(root, file_id[:2])
        os.makedirs(folder, exist_ok=True)
        with open(os.path.join(folder, file_id), "wb") as f:
            f.write(b"x")
    conn.commit()
    conn.close()
    return root


class _Backup:
    """The parts of an open backup backup_files reads."""

    encrypted = False

    def __init__(self, backup_dir: str):
        self.backup_dir = backup_dir

    def get_manifest_db(self):
        return os.path.join(self.backup_dir, "Manifest.db")


class _EncryptedBackup(_Backup):
    """An encrypted backup's list_files reads its decrypted Manifest.db, files only."""

    encrypted = True

    def list_files(self, domain=None, path_like=None):
        return [{"hash": _file_id(d, p), "domain": d, "path": p} for d, p, flags in FILES if flags == 1]


class TestMissingFiles(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def test_a_complete_backup_has_nothing_missing(self):
        # Folders and links are listed too, but have no file to store.
        result = backup_files.missing_files(_Backup(make_backup(self._tmp.name)))
        self.assertEqual(result, {"listed": 7, "missing": 0,
                                  "missing_by_area": {"photos": 0, "messages": 0, "other": 0}})

    def test_files_missing_from_the_folder_are_counted_by_area(self):
        root = make_backup(self._tmp.name, missing={
            "Media/DCIM/100APPLE/IMG_0001.HEIC",
            "Media/DCIM/100APPLE/IMG_0002.MOV",
            "Media/PhotoData/CPLAssets/group79/IMG_0100.JPG",
            "Library/SMS/Attachments/ab/01/IMG_5000.HEIC",
            "Documents/ChatStorage.sqlite",
        })
        result = backup_files.missing_files(_Backup(root))
        self.assertEqual(result, {"listed": 7, "missing": 5,
                                  "missing_by_area": {"photos": 3, "messages": 1, "other": 1}})

    def test_photos_library_database_is_not_a_photo(self):
        root = make_backup(self._tmp.name, missing={"Media/PhotoData/Photos.sqlite"})
        self.assertEqual(backup_files.missing_files(_Backup(root))["missing_by_area"],
                         {"photos": 0, "messages": 0, "other": 1})

    def test_ios_9_and_earlier_keep_files_directly_in_the_folder(self):
        root = make_backup(self._tmp.name, legacy=True, missing={"Library/SMS/sms.db"},
                           sizes={"Media/PhotoData/Photos.sqlite": 0})
        # The empty file isn't stored and isn't counted; sms.db is missing.
        result = backup_files.missing_files(_Backup(root))
        self.assertEqual((result["listed"], result["missing"]), (6, 1))
        self.assertEqual(result["missing_by_area"], {"photos": 0, "messages": 1, "other": 0})

    def test_encrypted_backups_are_checked_too(self):
        root = make_backup(self._tmp.name, missing={"Media/DCIM/100APPLE/IMG_0001.HEIC"})
        result = backup_files.missing_files(_EncryptedBackup(root))
        self.assertEqual((result["listed"], result["missing"], result["missing_by_area"]["photos"]), (7, 1, 1))

    def test_nothing_counts_as_missing_when_the_folder_cant_be_read(self):
        backup = _Backup(os.path.join(self._tmp.name, "gone"))
        self.assertIsNone(backup_files.stored_file_ids(backup))
        self.assertTrue(backup_files.is_stored(backup, "0" * 40))
        self.assertEqual(backup_files.missing_files(backup)["missing"], 0)

    def test_the_folder_is_read_once_per_backup(self):
        root = make_backup(self._tmp.name)
        backup = _Backup(root)
        first = backup_files.stored_file_ids(backup)
        os.makedirs(os.path.join(root, "zz"))
        with open(os.path.join(root, "zz", "z" * 40), "wb"):
            pass
        self.assertIs(backup_files.stored_file_ids(backup), first)
        self.assertNotIn("z" * 40, first)


class TestCheckBackupFilesRpc(unittest.TestCase):
    """What the app gets: the backup opens as usual, and check_backup_files says what's missing."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        from rpc_contract_support import load_engine_module
        self.server = load_engine_module().SidecarServer()

    def _open(self, root):
        result = self.server.open_backup({"udid": UDID, "backup_dir": root})
        self.addCleanup(self.server.backup_manager.close_backup, UDID)
        return result

    def test_oe_102_photos_missing_from_a_finished_backup(self):
        root = make_backup(self._tmp.name, missing={
            "Media/DCIM/100APPLE/IMG_0001.HEIC", "Media/DCIM/100APPLE/IMG_0002.MOV"})
        opened = self._open(root)
        # Nothing about the folder says the backup didn't finish.
        self.assertEqual(opened["status"], "open")
        self.assertFalse(opened["info"]["unfinished"])
        result = self.server.check_backup_files({"udid": UDID})
        self.assertEqual((result["missing"], result["missing_by_area"]["photos"]), (2, 2))

    def test_complete_backup(self):
        self._open(make_backup(self._tmp.name))
        self.assertEqual(self.server.check_backup_files({"udid": UDID})["missing"], 0)


if __name__ == "__main__":
    unittest.main()
