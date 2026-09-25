"""
Tests for export message ordering (GitHub issue #82).

get_messages returns newest-first *pages*. Concatenating those pages without
sorting puts newer days before older ones in TXT/CSV/HTML exports.
"""

import os
import sys
import tempfile
import unittest
from unittest.mock import MagicMock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from messages import MessageExtractor  # noqa: E402


def _msg(message_id: int, date: str, text: str = "") -> dict:
    return {
        "message_id": message_id,
        "date": date,
        "text": text or f"msg-{message_id}",
        "sender": "me",
        "is_from_me": True,
        "has_attachments": False,
        "attachments": [],
    }


class TestExportMessageOrder(unittest.TestCase):
    """Single-conversation export must be oldest → newest across all pages."""

    def setUp(self):
        self.ext = MessageExtractor.__new__(MessageExtractor)
        self.ext._inner = MagicMock()

    def test_sort_messages_chronologically(self):
        # Newer page chunk first (as if concatenated from get_messages pages).
        messages = [
            _msg(3, "2026-01-02T10:00:00+00:00"),
            _msg(4, "2026-01-02T11:00:00+00:00"),
            _msg(1, "2026-01-01T09:00:00+00:00"),
            _msg(2, "2026-01-01T10:00:00+00:00"),
        ]
        ordered = MessageExtractor._sort_messages_chronologically(messages)
        self.assertEqual(
            [m["message_id"] for m in ordered],
            [1, 2, 3, 4],
        )

    def test_export_html_is_chronological_across_pages(self):
        # Simulate two get_messages pages: newest day first, then older day.
        page_new = [
            _msg(3, "2026-01-02T10:00:00+00:00", "day2-a"),
            _msg(4, "2026-01-02T11:00:00+00:00", "day2-b"),
        ]
        page_old = [
            _msg(1, "2026-01-01T09:00:00+00:00", "day1-a"),
            _msg(2, "2026-01-01T10:00:00+00:00", "day1-b"),
        ]

        def fake_get_messages(backup, chat_id, contacts, offset=0, limit=500,
                              date_from=None, date_to=None):
            # Mimic real pagination: offset 0 = newest window, offset 500 = older.
            # total > 500 so export_conversation fetches both pages.
            if offset == 0:
                batch = page_new
            elif offset == 500:
                batch = page_old
            else:
                batch = []
            return {
                "messages": batch,
                "total": 1000,
                "next_offset": offset + limit,
            }

        self.ext.get_messages = fake_get_messages
        self.ext.search_messages = MagicMock()

        with tempfile.TemporaryDirectory() as tmp:
            result = self.ext.export_conversation(
                backup=object(),
                chat_id=1,
                contacts={},
                fmt="html",
                output_dir=tmp,
            )
            with open(result["file"], encoding="utf-8") as f:
                html = f.read()

        # Day 1 content must appear before day 2 in the exported HTML.
        self.assertLess(html.index("day1-a"), html.index("day1-b"))
        self.assertLess(html.index("day1-b"), html.index("day2-a"))
        self.assertLess(html.index("day2-a"), html.index("day2-b"))


if __name__ == "__main__":
    unittest.main()
