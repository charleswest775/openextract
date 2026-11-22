"""
Finding a file in an encrypted backup uses its path (OE-132).

iphone-backup-decrypt's query for one file names relativePath and flags, both
indexed, and SQLite picked flags: nearly every row. Each photo in a save then
read the whole list of files: with 400,000 of them, 468 ms on Windows and 154 ms on a Mac.
"""

import os
import plistlib
import sqlite3
import sys
import tempfile
import unittest
from contextlib import contextmanager
from types import SimpleNamespace
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import backup as backup_module  # noqa: E402

UDID = "00008140-0000000000000132"
PATH = "Message/Media/a/b/photo.jpg"
DOMAIN = "AppDomainGroup-group.net.whatsapp.WhatsApp.shared"
# Manifest.db's table and indexes, the same in every iOS 13 to 17 public corpus backup.
MANIFEST = """
CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB);
CREATE INDEX FilesDomainIdx ON Files(domain);
CREATE INDEX FilesRelativePathIdx ON Files(relativePath);
CREATE INDEX FilesFlagsIdx ON Files(flags);
"""


class _Decrypted:
    """An unlocked backup's decrypted copy of Manifest.db, as iphone-backup-decrypt keeps it."""

    def __init__(self, path):
        self.conn = sqlite3.connect(path)
        self.conn.executescript(MANIFEST)
        self.conn.executemany(
            "INSERT INTO Files VALUES (?, 'HomeDomain', ?, 1, x'00')", [(f"id{i}", f"file{i}") for i in range(200)],
        )
        self.conn.execute("INSERT INTO Files VALUES ('photo', ?, ?, 1, x'01')", (DOMAIN, PATH))
        self.conn.commit()

    @contextmanager
    def manifest_db_cursor(self):
        cur = self.conn.cursor()
        try:
            yield cur
        finally:
            cur.close()

    def plan(self, sql, args):
        return " | ".join(row[-1] for row in self.conn.execute(f"EXPLAIN QUERY PLAN {sql}", args))


class EncryptedFileLookupTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.decrypted = _Decrypted(os.path.join(self.tmp.name, "decrypted.db"))
        self.addCleanup(self.decrypted.conn.close)

    def library_lookup(self):
        """The library's own lookup of PATH on that copy: (what it found, the SQL it ran)."""
        try:
            from iphone_backup_decrypt import EncryptedBackup
        except (ImportError, OSError):
            self.skipTest("iphone-backup-decrypt isn't installed")
        library = EncryptedBackup.__new__(EncryptedBackup)
        library._temp_manifest_db_conn = self.decrypted.conn
        library._temporary_folder = None
        ran = []
        self.decrypted.conn.set_trace_callback(ran.append)
        try:
            found = library._file_metadata_from_manifest(PATH, DOMAIN)
        finally:
            self.decrypted.conn.set_trace_callback(None)
            library._temp_manifest_db_conn = None  # ours to close
        return found, ran[-1].strip().rstrip(";")

    def test_the_librarys_lookup_goes_by_path(self):
        before, _ = self.library_lookup()
        backup_module._speed_up_file_lookups(self.decrypted)
        found, sql = self.library_lookup()
        self.assertEqual(found, before)
        self.assertEqual(found[0], "photo")
        self.assertIn("FilesRelativePathIdx", self.decrypted.plan(sql, ()))

    def test_an_ios_9_backups_lookup_goes_by_path(self):
        # ios_backup_core.legacy_crypto's query, on the table it builds from Manifest.mbdb
        backup_module._speed_up_file_lookups(self.decrypted)
        plan = self.decrypted.plan(
            "SELECT fileID FROM Files WHERE relativePath = ? AND domain LIKE ? AND flags = 1 ORDER BY domain LIMIT 1",
            (PATH, DOMAIN),
        )
        self.assertIn("FilesRelativePathIdx", plan)

    def test_listing_one_domain_goes_by_domain(self):
        # list_files, which WhatsApp asks which media the backup has
        backup_module._speed_up_file_lookups(self.decrypted)
        sql = "SELECT fileID FROM Files WHERE flags=1 AND domain = ? AND relativePath LIKE ?"
        self.assertIn("FilesDomainIdx", self.decrypted.plan(sql, (DOMAIN, "Message/%")))
        self.assertEqual(self.decrypted.conn.execute(sql, (DOMAIN, "Message/%")).fetchall(), [("photo",)])

    def open_encrypted(self, decrypted):
        folder = os.path.join(self.tmp.name, UDID)
        os.makedirs(folder)
        for name, content in (
            ("Info.plist", {"Unique Identifier": UDID}),
            ("Manifest.plist", {"IsEncrypted": True, "BackupKeyBag": b"keys"}),
            ("Status.plist", {"SnapshotState": "finished"}),
        ):
            with open(os.path.join(folder, name), "wb") as f:
                plistlib.dump(content, f)
        sealed = os.path.join(folder, "Manifest.db")
        with open(sealed, "wb") as f:
            f.write(b"\x8f" * 4096)  # encrypted, as the backup keeps it
        manager = backup_module.BackupManager()
        with mock.patch.object(backup_module, "open_local_backup",
                               return_value=SimpleNamespace(_decrypted_backup=decrypted)), \
                mock.patch.object(backup_module, "_PREWARM_FILES", []):
            result = manager.open_backup(UDID, "test", folder)
        self.addCleanup(manager.close_backup, UDID)
        with open(sealed, "rb") as f:
            self.assertEqual(f.read(), b"\x8f" * 4096, "the backup itself was written to")
        return result

    def test_opening_an_encrypted_backup_does_it_and_leaves_the_backup_alone(self):
        self.assertEqual(self.open_encrypted(self.decrypted)["status"], "open")
        self.assertFalse(self.decrypted.conn.in_transaction)
        other = sqlite3.connect(os.path.join(self.tmp.name, "decrypted.db"))
        self.addCleanup(other.close)
        indexes = {row[0] for row in other.execute("SELECT name FROM sqlite_master WHERE type = 'index'")}
        self.assertNotIn("FilesFlagsIdx", indexes)
        self.assertIn("FilesRelativePathIdx", indexes)

    def test_a_backup_still_opens_if_it_cant(self):
        broken = SimpleNamespace(manifest_db_cursor=mock.Mock(side_effect=sqlite3.OperationalError("disk full")))
        self.assertEqual(self.open_encrypted(broken)["status"], "open")


if __name__ == "__main__":
    unittest.main()
