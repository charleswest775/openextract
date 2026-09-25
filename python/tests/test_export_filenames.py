"""
Tests for conversation-export filenames (GitHub issue #92).
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from messages import MessageExtractor  # noqa: E402


def _msg(message_id: int, date, text: str = "hi") -> dict:
    return {
        "message_id": message_id,
        "date": date,
        "text": text,
        "sender": "Alice",
        "is_from_me": False,
        "has_attachments": False,
        "attachments": [],
    }


class TestExportFilenames(unittest.TestCase):

    def setUp(self):
        self.ext = MessageExtractor.__new__(MessageExtractor)
        self.messages = [
            _msg(1, "2026-01-01T09:00:00+00:00"),
            _msg(2, "2026-01-02T09:00:00+00:00"),
        ]

    def _export(self, fmt, messages, display_name):
        with tempfile.TemporaryDirectory() as tmp:
            export = getattr(self.ext, f"_export_{fmt}")
            result = export(messages, 42, tmp, display_name)
            name = os.path.basename(result["file"])
            with open(result["file"], encoding="utf-8-sig") as f:
                return name, f.read()

    def test_name_and_date_range(self):
        name = self.ext._get_filename_for_message_export("Mom & Dad", self.messages)
        self.assertTrue(name.startswith("Mom_Dad--"), name)
        self.assertEqual(name.count("--"), 2)

    def test_no_display_name_falls_back_to_chat_id(self):
        for fmt in ("txt", "csv", "html"):
            name, _ = self._export(fmt, self.messages, None)
            self.assertEqual(name, f"conversation_42.{fmt}")

    def test_empty_export_does_not_crash(self):
        # e.g. a date filter that matches no messages
        for fmt in ("txt", "csv", "html"):
            name, _ = self._export(fmt, [], "Mom")
            self.assertEqual(name, f"Mom.{fmt}")

    def test_missing_date_does_not_crash(self):
        name, _ = self._export("txt", [_msg(1, None)], "Mom")
        self.assertEqual(name, "Mom.txt")

    def test_unusable_name_and_no_dates_falls_back(self):
        name, _ = self._export("txt", [], "🎉🎉")
        self.assertEqual(name, "conversation_42.txt")

    def test_html_escapes_display_name(self):
        _, content = self._export("html", self.messages, "<b>Bob</b>")
        self.assertIn("&lt;b&gt;Bob&lt;/b&gt;", content)
        self.assertNotIn("<b>Bob</b>", content)


if __name__ == "__main__":
    unittest.main()
