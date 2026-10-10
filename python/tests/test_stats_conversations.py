"""
The stats dashboard must count group and one-on-one conversations the same way
the conversation list does.

iOS sets chat.group_id on every chat, so the old "group_id IS NOT NULL" rule
counted every conversation as a group (found by the corpus tests on a real
iOS 15.3.1 backup: 15 one-on-one chats reported as 15 groups).
"""

import os
import sqlite3
import sys
import tempfile
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from stats import StatsComputer  # noqa: E402


def _build_sms_db(path: str) -> None:
    conn = sqlite3.connect(path)
    conn.executescript(
        """
        CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
        CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT,
                           service_name TEXT, group_id TEXT);
        CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, date INTEGER, is_from_me INTEGER);
        CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);

        INSERT INTO handle VALUES (1, '+15555550100'), (2, '+15555550101'), (3, '22000');
        -- every chat has a group_id, as on a real device
        INSERT INTO chat VALUES (1, '+15555550100', '', 'iMessage', 'A1');
        INSERT INTO chat VALUES (2, '22000', '', 'SMS', 'B2');
        INSERT INTO chat VALUES (3, 'chat123456', 'Family', 'iMessage', 'C3');
        INSERT INTO chat VALUES (4, '+15555550101', '', 'iMessage', 'D4');  -- no messages
        INSERT INTO chat_handle_join VALUES (1, 1), (2, 3), (3, 1), (3, 2), (4, 2);
        INSERT INTO message VALUES (1, 'hi', 700000000000000000, 1), (2, 'code 1234', 700000100000000000, 0),
                                   (3, 'dinner?', 700000200000000000, 0);
        INSERT INTO chat_message_join VALUES (1, 1), (2, 2), (3, 3);
        """
    )
    conn.commit()
    conn.close()


class TestConversationKinds(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.sms_db = os.path.join(self.tmp.name, "sms.db")
        _build_sms_db(self.sms_db)
        self.backup = MagicMock()
        self.backup.get_file.side_effect = lambda path, *a, **k: self.sms_db if path == "Library/SMS/sms.db" else None

    def tearDown(self):
        self.tmp.cleanup()

    def test_group_and_one_on_one_match_conversation_list(self):
        stats = StatsComputer()._message_stats(self.backup, {})
        self.assertEqual(stats["total_conversations"], 3)  # the empty chat isn't listed
        self.assertEqual(stats["group_conversations"], 1)
        self.assertEqual(stats["one_on_one_conversations"], 2)


if __name__ == "__main__":
    unittest.main()
