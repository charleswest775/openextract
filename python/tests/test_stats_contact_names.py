"""
Tests for contact-name resolution on the stats dashboard.

The dashboard's "Top conversations" looked chat handles up in the contacts map
verbatim, so a handle like "+447700900101" missed a contact saved as
"+44 7700 900101" and the raw number was shown — while the Messages tab, which
normalizes via resolve_contact, showed the name.
"""

import os
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from contacts import ContactResolver  # noqa: E402
from stats import StatsComputer  # noqa: E402

SMS_PATH = "Library/SMS/sms.db"
ADDRESS_BOOK_PATH = "Library/AddressBook/AddressBook.sqlitedb"
CALL_HISTORY_PATH = "Library/CallHistoryDB/CallHistory.storedata"

# (first, last, phone as saved in the address book)
CONTACTS = [
    ("Alice", "Example", "+44 7700 900101"),
    ("Bob", "Example", "(555) 010-0123"),
]

# (chat_identifier, chat display_name, message count). Handles use the E.164
# form Messages stores, not the address book formatting above.
CHATS = [
    ("+447700900101", "", 5),
    ("+15550100123", "", 4),
    ("chat123456789", "Book Club", 3),
    ("+447700900199", "", 2),  # not in contacts
]

# (address, number of calls)
CALLS = [
    ("+447700900101", 3),
    ("+15550100123", 2),
]


def _build_address_book(path: str):
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE ABPerson (ROWID INTEGER PRIMARY KEY, First TEXT, Last TEXT,
                               Organization TEXT);
        CREATE TABLE ABMultiValue (record_id INTEGER, property INTEGER, value TEXT);
    """)
    for rowid, (first, last, phone) in enumerate(CONTACTS, start=1):
        conn.execute("INSERT INTO ABPerson VALUES (?, ?, ?, NULL)", (rowid, first, last))
        conn.execute("INSERT INTO ABMultiValue VALUES (?, 3, ?)", (rowid, phone))
    conn.commit()
    conn.close()


def _build_sms_db(path: str):
    conn = sqlite3.connect(path)
    conn.executescript("""
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT,
                           display_name TEXT, service_name TEXT, group_id TEXT);
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, date INTEGER, is_from_me INTEGER,
                              handle_id INTEGER, item_type INTEGER);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
        CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY);
    """)
    msg_id = 0
    for chat_id, (identifier, display_name, count) in enumerate(CHATS, start=1):
        conn.execute(
            "INSERT INTO chat VALUES (?, ?, ?, 'iMessage', NULL)",
            (chat_id, identifier, display_name),
        )
        for _ in range(count):
            msg_id += 1
            conn.execute(
                "INSERT INTO message VALUES (?, ?, 0, NULL, 0)",
                (msg_id, 700000000 + msg_id * 3600),
            )
            conn.execute("INSERT INTO chat_message_join VALUES (?, ?)", (chat_id, msg_id))
    conn.commit()
    conn.close()


def _build_call_history(path: str):
    conn = sqlite3.connect(path)
    conn.execute("""
        CREATE TABLE ZCALLRECORD (Z_PK INTEGER PRIMARY KEY, ZADDRESS TEXT, ZDATE REAL,
                                  ZDURATION REAL, ZCALLTYPE INTEGER, ZORIGINATED INTEGER,
                                  ZANSWERED INTEGER)
    """)
    pk = 0
    for address, count in CALLS:
        for _ in range(count):
            pk += 1
            conn.execute(
                "INSERT INTO ZCALLRECORD VALUES (?, ?, ?, 60, 1, 1, 1)",
                (pk, address, 700000000 + pk * 86400),
            )
    conn.commit()
    conn.close()


class _FakeBackup:
    """Minimal BackupAccessor serving hand-built databases from a temp dir."""

    udid = "STATS-CONTACT-NAMES"
    info = {}

    def __init__(self, files: dict):
        self._files = files  # relative path -> local path (all HomeDomain)

    def get_file(self, relative_path: str, domain: str = "HomeDomain"):
        if domain != "HomeDomain":
            return None
        return self._files.get(relative_path)

    def list_files(self, domain=None, path_like=None):
        needle = (path_like or "").strip("%")
        return [
            {"hash": rel, "domain": "HomeDomain", "path": rel}
            for rel in self._files
            if needle in rel
        ]


class TestStatsContactNames(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        builders = {
            ADDRESS_BOOK_PATH: ("AddressBook.sqlitedb", _build_address_book),
            SMS_PATH: ("sms.db", _build_sms_db),
            CALL_HISTORY_PATH: ("CallHistory.storedata", _build_call_history),
        }
        files = {}
        for rel, (name, build) in builders.items():
            files[rel] = os.path.join(self._tmp.name, name)
            build(files[rel])
        self.backup = _FakeBackup(files)
        contacts = ContactResolver().load_contacts(self.backup)
        self.stats = StatsComputer().compute(self.backup, contacts)

    def tearDown(self):
        self._tmp.cleanup()

    def test_no_section_errors(self):
        self.assertEqual(self.stats["errors"], [])

    def test_top_conversations_resolve_differently_formatted_numbers(self):
        self.assertEqual(
            self.stats["messages"]["top_conversations"],
            [
                {"display_name": "Alice Example", "message_count": 5},
                {"display_name": "Bob Example", "message_count": 4},
                {"display_name": "Book Club", "message_count": 3},
                {"display_name": "+447700900199", "message_count": 2},
            ],
        )

    def test_call_top_contacts_resolve_differently_formatted_numbers(self):
        self.assertEqual(
            self.stats["calls"]["top_contacts"],
            [
                {"name": "Alice Example", "count": 3},
                {"name": "Bob Example", "count": 2},
            ],
        )


if __name__ == "__main__":
    unittest.main()
