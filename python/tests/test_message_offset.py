"""
A search can find a message deep in a long conversation. get_message_offset
says how many of the conversation's messages are newer than it, which is the
get_messages offset whose page starts at it.
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
        CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
        -- chat 1 has messages 10..19; chat 2 has 20 and 21, and shares message 15 with chat 1
        INSERT INTO chat_message_join VALUES (1, 10), (1, 11), (1, 12), (1, 13), (1, 14),
                                             (1, 15), (1, 16), (1, 17), (1, 18), (1, 19);
        INSERT INTO chat_message_join VALUES (2, 15), (2, 20), (2, 21);
        -- a duplicate join row must not count twice
        INSERT INTO chat_message_join VALUES (1, 19);
        """
    )
    conn.commit()
    conn.close()


class TestMessageOffset(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.sms_db = os.path.join(self.tmp.name, "sms.db")
        _build_sms_db(self.sms_db)
        self.extractor = MessageExtractor()
        # The engine finds sms.db and opens it; this test is about the count
        self.extractor._inner._get_sms_db = lambda backup: self.sms_db
        self.extractor._inner._get_conn = lambda path, backup: self._conn()
        self.backup = MagicMock()

    def _conn(self):
        conn = sqlite3.connect(self.sms_db)
        self.addCleanup(conn.close)
        return conn

    def tearDown(self):
        self.tmp.cleanup()

    def test_newest_message_is_at_offset_zero(self):
        self.assertEqual(self.extractor.get_message_offset(self.backup, 1, 19), {"offset": 0, "found": True})

    def test_counts_only_newer_messages_in_the_same_chat(self):
        self.assertEqual(self.extractor.get_message_offset(self.backup, 1, 15), {"offset": 4, "found": True})
        self.assertEqual(self.extractor.get_message_offset(self.backup, 2, 15), {"offset": 2, "found": True})

    def test_oldest_message(self):
        self.assertEqual(self.extractor.get_message_offset(self.backup, 1, 10), {"offset": 9, "found": True})

    def test_message_not_in_chat(self):
        self.assertFalse(self.extractor.get_message_offset(self.backup, 2, 12)["found"])

    def test_no_sms_db(self):
        self.extractor._inner._get_sms_db = lambda backup: None
        self.assertIn("error", self.extractor.get_message_offset(self.backup, 1, 10))


if __name__ == "__main__":
    unittest.main()
