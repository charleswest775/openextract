"""
Searching every conversation at once (no chat_id) must find matches in all of
them and name the conversation each one is in, the way the conversation list
names it, so the results can say where a message was sent.
"""

import os
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from messages import MessageExtractor  # noqa: E402


def _build_sms_db(path: str) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT,
                           service_name TEXT);
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, date INTEGER,
                              is_from_me INTEGER, handle_id INTEGER);
        CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);

        INSERT INTO handle VALUES (1, '+15555550100'), (2, '+15555550101');
        INSERT INTO chat VALUES (1, '+15555550100', '', 'iMessage');
        INSERT INTO chat VALUES (2, 'chat123456', 'Book Club', 'iMessage');
        INSERT INTO chat_handle_join VALUES (1, 1), (2, 1), (2, 2);
        INSERT INTO message VALUES
            (1, 'Pizza tonight?', 700000000000000000, 0, 1),
            (2, 'sure', 700000100000000000, 1, 0),
            (3, 'Who is bringing the pizza', 700000200000000000, 0, 2),
            (4, 'chapter 3 next', 700000300000000000, 1, 0);
        INSERT INTO chat_message_join VALUES (1, 1), (1, 2), (2, 3), (2, 4);
        """
    )
    conn.commit()
    conn.close()


class TestSearchAllMessages(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.sms_db = os.path.join(self.tmp.name, "sms.db")
        _build_sms_db(self.sms_db)
        # Only what a backup accessor has: a bare MagicMock would also "have" get_database().
        self.backup = MagicMock(spec=["get_file", "backup_dir"])
        self.backup.backup_dir = self.tmp.name
        self.backup.get_file.side_effect = lambda path, *a, **k: self.sms_db if path == "Library/SMS/sms.db" else None
        self.contacts = {"+15555550100": "Alex Sample"}
        self.ext = MessageExtractor()

    def tearDown(self):
        for conn in self.ext._inner._connections.values():
            conn.close()
        self.tmp.cleanup()

    def test_finds_matches_in_every_conversation_with_their_names(self):
        results = self.ext.search_messages(self.backup, "pizza", self.contacts)["results"]
        self.assertEqual([r["message_id"] for r in results], [1, 3])
        self.assertEqual([r["chat_id"] for r in results], [1, 2])
        self.assertEqual([r["chat_name"] for r in results], ["Alex Sample", "Book Club"])
        self.assertEqual(results[0]["sender"], "Alex Sample")

    def test_one_conversation_search_is_unchanged(self):
        results = self.ext.search_messages(self.backup, "pizza", self.contacts, chat_id=2)["results"]
        self.assertEqual([r["message_id"] for r in results], [3])
        self.assertNotIn("chat_name", results[0])

    def test_no_matches(self):
        self.assertEqual(self.ext.search_messages(self.backup, "zebra", self.contacts)["results"], [])


if __name__ == "__main__":
    unittest.main()
