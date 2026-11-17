"""Voicemail, Spam and Deleted, as the Phone app lists them (OE-79, OE-85).

ios-backup-core gives each voicemail a ``folder``. Here: the home screen's
numbers leave deleted voicemails out, and Save all writes every list, with
spam and deleted audio in folders of their own and file names Windows accepts.
"""

import csv
import hashlib
import os
import plistlib
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from backup import BackupManager  # noqa: E402
from stats import StatsComputer  # noqa: E402
from voicemail import VoicemailExtractor  # noqa: E402
from ios_backup_core.extractors import voicemail as _core_voicemail  # noqa: E402

# A deleted spam voicemail keeps its spam mark from charleswest775/ios-backup-core#36 on
SPAM_MARK = hasattr(_core_voicemail, "is_spam")

UDID = "00008030-0000000000000001"
ACCOUNT = "A-0B1C2D3E-4F50-4A6B-8C7D-9E0F1A2B3C4D"
AMR = b"#!AMR\n" + bytes(32)

LIVE, SPAM, TRASHED, DELETED_LONG_AGO = 0x1103, 0x1182, 0x110A, 0x110B
SPAM_THEN_DELETED = 0x118A


def _voicemail_db(rows) -> bytes:
    """rows: (ROWID, date, sender, duration, flags, trashed_date)"""
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "voicemail.db")
        conn = sqlite3.connect(path)
        conn.execute(
            "CREATE TABLE voicemail (ROWID INTEGER PRIMARY KEY, remote_uid INTEGER, date INTEGER, "
            "token TEXT, sender TEXT, callback_num TEXT, duration INTEGER, expiration INTEGER, "
            "trashed_date INTEGER, flags INTEGER, receiver TEXT, label TEXT)"
        )
        conn.executemany(
            "INSERT INTO voicemail (ROWID, date, sender, duration, flags, trashed_date) VALUES (?, ?, ?, ?, ?, ?)",
            rows,
        )
        conn.commit()
        conn.close()
        with open(path, "rb") as f:
            return f.read()


def _make_backup(backup_dir: str, files: dict) -> None:
    os.makedirs(backup_dir)
    with open(os.path.join(backup_dir, "Info.plist"), "wb") as f:
        plistlib.dump({"Unique Identifier": UDID, "Device Name": "Test iPhone", "Product Version": "27.2"}, f)
    with open(os.path.join(backup_dir, "Manifest.plist"), "wb") as f:
        plistlib.dump({"IsEncrypted": False}, f)
    manifest = sqlite3.connect(os.path.join(backup_dir, "Manifest.db"))
    manifest.execute("CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)")
    for rel_path, data in files.items():
        file_id = hashlib.sha1(f"HomeDomain-{rel_path}".encode()).hexdigest()
        os.makedirs(os.path.join(backup_dir, file_id[:2]), exist_ok=True)
        with open(os.path.join(backup_dir, file_id[:2], file_id), "wb") as f:
            f.write(data)
        manifest.execute("INSERT INTO Files VALUES (?, 'HomeDomain', ?, 1, NULL)", (file_id, rel_path))
    manifest.commit()
    manifest.close()


class VoicemailListsTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        backup_dir = os.path.join(self.tmp.name, UDID)
        _make_backup(backup_dir, {
            "Library/Voicemail/voicemail.db": _voicemail_db([
                (1, 1_700_000_000, "+15550000001", 20, LIVE, 0),
                (2, 1_710_000_000, "+15550000002", 30, SPAM, 0),
                (3, 1_720_000_000, "+15550000003", 40, TRASHED, 1_720_000_100),
                (4, 1_600_000_000, "+15550000004", 50, DELETED_LONG_AGO, 0),
                (5, 1_725_000_000, "+15550000005", 12, SPAM_THEN_DELETED, 1_725_000_100),
            ]),
            f"Library/Voicemail/{ACCOUNT}/voicemail.db": _voicemail_db([
                (7, 1_730_000_000, "Mum: home?", 60, 0x3, 0),  # only in the account store
            ]),
            **{f"Library/Voicemail/{n}.amr": AMR for n in (1, 2, 3, 4, 5)},
            f"Library/Voicemail/{ACCOUNT}/7.amr": AMR,
        })
        # Through the app's own manager, which closes Manifest.db: Windows won't
        # delete the temp folder while it's open.
        manager = BackupManager()
        self.assertEqual(manager.open_backup(UDID, backup_dir=backup_dir)["status"], "open")
        self.addCleanup(manager.close_backup, UDID)
        self.backup = manager.get_open_backup(UDID)

    def test_home_numbers_leave_deleted_out(self):
        stats = StatsComputer()._voicemail_stats(self.backup)
        self.assertEqual(
            {k: stats[k] for k in ("total", "read", "unread", "spam", "deleted")},
            {"total": 3, "read": 2, "unread": 1, "spam": 1, "deleted": 3},
        )
        self.assertEqual(stats["total_duration_seconds"], 20 + 30 + 60)

    def test_save_all_writes_every_list(self):
        out = os.path.join(self.tmp.name, "out")
        result = VoicemailExtractor().export_voicemails(self.backup, {}, out)
        self.assertEqual(result["exported"], 6)
        with open(os.path.join(out, "voicemails.csv"), newline="", encoding="utf-8") as f:
            rows = list(csv.reader(f))
        self.assertEqual(rows[0][:2], ["ID", "List"])
        self.assertEqual(
            sorted((r[0], r[1]) for r in rows[1:]),
            sorted([("1", "Voicemail"), ("2", "Spam"), ("3", "Deleted"), ("4", "Deleted"), ("5", "Deleted"),
                    (f"{ACCOUNT}.7", "Voicemail")]),
        )
        audio = sorted(os.path.relpath(os.path.join(d, f), out) for d, _, fs in os.walk(out) for f in fs if f.endswith(".amr"))
        self.assertEqual(len(audio), 6)
        self.assertEqual(sum(p.startswith(os.path.join("audio", "Spam") + os.sep) for p in audio), 1)
        self.assertEqual(sum(p.startswith(os.path.join("audio", "Deleted") + os.sep) for p in audio), 3)
        account = [p for p in audio if ACCOUNT in p]
        self.assertEqual(len(account), 1)
        self.assertNotIn(":", os.path.basename(account[0]))  # "Mum: home?" made safe for Windows
        self.assertNotIn("?", os.path.basename(account[0]))

    def _saved_list(self):
        out = os.path.join(self.tmp.name, "out")
        VoicemailExtractor().export_voicemails(self.backup, {"+15550000002": "Dentist"}, out)
        with open(os.path.join(out, "voicemails.csv"), newline="", encoding="utf-8") as f:
            return list(csv.DictReader(f))

    def test_the_list_keeps_a_saved_contacts_number(self):
        """Contact is the address book's name; Phone Number is always the number (it was
        lost for saved contacts)."""
        rows = self._saved_list()
        self.assertEqual(list(rows[0]), ["ID", "List", "Date (UTC)", "Contact", "Phone Number", "Spam",
                                         "Duration", "Is Read", "Transcript"])
        by_id = {r["ID"]: r for r in rows}
        self.assertEqual((by_id["2"]["Contact"], by_id["2"]["Phone Number"]), ("Dentist", "+15550000002"))
        self.assertEqual((by_id["1"]["Contact"], by_id["1"]["Phone Number"]), ("+15550000001", "+15550000001"))
        self.assertEqual((by_id["2"]["List"], by_id["2"]["Spam"]), ("Spam", "True"))
        self.assertTrue(by_id["1"]["Date (UTC)"].endswith("+00:00"))

    @unittest.skipUnless(SPAM_MARK, "needs ios-backup-core with is_spam (charleswest775/ios-backup-core#36)")
    def test_the_list_keeps_every_spam_mark(self):
        """Spam stays True for spam that was then deleted (its List is Deleted)."""
        by_id = {r["ID"]: r for r in self._saved_list()}
        self.assertEqual({i: (r["List"], r["Spam"]) for i, r in by_id.items()}, {
            "1": ("Voicemail", "False"), "2": ("Spam", "True"), "3": ("Deleted", "False"),
            "4": ("Deleted", "False"), "5": ("Deleted", "True"), f"{ACCOUNT}.7": ("Voicemail", "False"),
        })

    def test_a_voicemail_only_in_the_account_store_plays(self):
        result = VoicemailExtractor().get_audio(self.backup, f"{ACCOUNT}.7")
        self.assertNotIn("error", result)
        self.assertEqual(result["voicemail_id"], f"{ACCOUNT}.7")

    def test_audio_that_isnt_there_says_so(self):
        result = VoicemailExtractor().get_audio(self.backup, 1940)
        self.assertIn("isn't in the backup", result["error"])


if __name__ == "__main__":
    unittest.main()
