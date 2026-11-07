"""
Tests for conversation-export filenames (GitHub issue #92): who the
conversation is with and which days it covers, in words people read, e.g.
"Karin Lindqvist, Jul 5 2024 - Jun 21 2026.txt", and safe on Windows and macOS.
"""

import os
import re
import sys
import tempfile
import unittest
from datetime import timezone
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from messages import MessageExtractor  # noqa: E402

# What Windows refuses in a file name, plus control characters.
_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


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
        self.ext.local_tz = timezone.utc
        self.messages = [
            _msg(1, "2026-01-01T09:00:00+00:00"),
            _msg(2, "2026-01-02T09:00:00+00:00"),
        ]
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.out = self._tmp.name

    def _name(self, display_name, messages=None):
        return self.ext._get_filename_for_message_export(
            display_name, self.messages if messages is None else messages)

    def _export(self, fmt, messages, display_name):
        """Export into a fresh folder; return the file's name and contents."""
        with tempfile.TemporaryDirectory() as tmp:
            result = getattr(self.ext, f"_export_{fmt}")(messages, 42, tmp, display_name)
            self.assertEqual(os.listdir(tmp), [os.path.basename(result["file"])])
            with open(result["file"], encoding="utf-8-sig") as f:
                return os.path.basename(result["file"]), f.read()

    def test_name_and_date_range(self):
        self.assertEqual(self._name("Mom & Dad"), "Mom & Dad, Jan 1 2026 - Jan 2 2026")

    def test_one_day(self):
        self.assertEqual(self._name("Mom", self.messages[:1]), "Mom, Jan 1 2026")

    def test_different_ranges_get_different_names(self):
        later = self.messages + [_msg(3, "2026-02-14T09:00:00+00:00")]
        self.assertEqual(self._name("Mom", later), "Mom, Jan 1 2026 - Feb 14 2026")
        self.assertNotEqual(self._name("Mom", later), self._name("Mom"))

    def test_no_display_name_falls_back_to_chat_id(self):
        for fmt in ("txt", "csv", "html"):
            name, _ = self._export(fmt, self.messages, None)
            self.assertEqual(name, f"conversation_42.{fmt}")

    def test_empty_export_does_not_crash(self):
        # e.g. a date filter that matches no messages
        for fmt in ("txt", "csv", "html"):
            name, _ = self._export(fmt, [], "Mom")
            self.assertEqual(name, f"Mom.{fmt}")

    def test_missing_dates_are_skipped(self):
        name, _ = self._export("txt", [_msg(1, None)], "Mom")
        self.assertEqual(name, "Mom.txt")
        # Messages without a date sort first; the range comes from the rest.
        self.assertEqual(self._name("Mom", [_msg(1, None)] + self.messages), "Mom, Jan 1 2026 - Jan 2 2026")

    def test_unusable_name_falls_back(self):
        for display_name in ("", "   ", "...", '<>:"/\\|?*'):
            with self.subTest(display_name=display_name):
                name, _ = self._export("txt", [], display_name)
                self.assertEqual(name, "conversation_42.txt")

    def test_unicode_and_emoji_names_are_kept(self):
        # Written to disk, so this also checks the file system takes them
        # (0.10.2 fixed garbled emoji names on Windows).
        for display_name in ("José Núñez", "🎉🎉", "Family 👨‍👩‍👧 chat", "Ünïcødé ✈️ 日本"):
            with self.subTest(display_name=display_name):
                name, _ = self._export("txt", self.messages, display_name)
                self.assertEqual(name, f"{display_name}, Jan 1 2026 - Jan 2 2026.txt")

    def test_characters_windows_refuses_are_replaced(self):
        name = self._name('Mom/Dad: "Work" <a|b>?*\\')
        self.assertEqual(name, "Mom Dad Work a b, Jan 1 2026 - Jan 2 2026")
        file_name, _ = self._export("csv", self.messages, 'Mom/Dad: "Work" <a|b>?*\\')
        self.assertFalse(_UNSAFE.search(file_name), file_name)

    def test_control_and_direction_characters_are_removed(self):
        self.assertEqual(self._name("Bob\n\tSmith‮\x7f", []), "Bob Smith")

    def test_half_an_emoji_does_not_fail_the_export(self):
        # A lone surrogate, which JSON.stringify sends as "\ud83c" when a name
        # is cut in the middle of an emoji. HTML used to fail on its title.
        with mock.patch.object(self.ext, "_collect_messages_for_chat", return_value=self.messages):
            for fmt in ("txt", "csv", "html", "pdf_source"):
                with self.subTest(fmt=fmt), tempfile.TemporaryDirectory() as tmp:
                    result = self.ext.export_conversation(None, 42, {}, fmt, tmp, display_name="Bad \ud83c name")
                    self.assertEqual(os.path.basename(result["file"]),
                                     f"Bad � name, Jan 1 2026 - Jan 2 2026.{'html' if fmt == 'pdf_source' else fmt}")
            for fmt in ("txt", "csv", "html"):
                with self.subTest(merged=fmt), tempfile.TemporaryDirectory() as tmp:
                    result = self.ext.export_conversations(None, [42], {42: "Bad \ud83c name"}, {}, fmt, tmp,
                                                           mode="merged")
                    with open(result["files"][0], encoding="utf-8-sig") as f:
                        self.assertIn("Bad � name", f.read())

    def test_no_leading_dot_or_trailing_dot_or_space(self):
        self.assertEqual(self._name(". .hidden. . ", []), "hidden")
        self.assertEqual(self._name("Dr. J.R. Ewing.", []), "Dr. J.R. Ewing")

    def test_windows_device_names_are_avoided(self):
        self.assertEqual(self._name("CON", []), "_CON")
        self.assertEqual(self._name("aux.team", []), "_aux.team")
        self.assertEqual(self._name("Lpt1", []), "_Lpt1")
        self.assertEqual(self._name("Connie", []), "Connie")
        self.assertEqual(self._name("COM10", []), "COM10")

    def test_long_names_are_shortened(self):
        self.assertEqual(self._name("a" * 200, []), "a" * 60)
        group = "Karin Lindqvist, Theo Navarro, Nadia Haddad, Leah Brooks, Sam Ortiz"
        name = self._name(group)
        self.assertEqual(name, "Karin Lindqvist, Theo Navarro, Nadia Haddad, Leah Brooks, Sa, Jan 1 2026 - Jan 2 2026")
        # Cut right after a comma: no ", ," before the dates.
        group = "Karin Lindqvist, Theo Navarro, Nadia Haddad, Leah Brooksby, Sam Ortiz"
        self.assertEqual(self._name(group), "Karin Lindqvist, Theo Navarro, Nadia Haddad, Leah Brooksby, Jan 1 2026 - Jan 2 2026")

    def test_saving_again_keeps_the_first_file(self):
        for fmt in ("txt", "csv", "html"):
            for display_name, base in (("Mom", "Mom, Jan 1 2026 - Jan 2 2026"), (None, "conversation_42")):
                with self.subTest(fmt=fmt, display_name=display_name):
                    with tempfile.TemporaryDirectory() as tmp:
                        export = getattr(self.ext, f"_export_{fmt}")
                        names = [os.path.basename(export(self.messages, 42, tmp, display_name)["file"])
                                 for _ in range(3)]
                        self.assertEqual(names, [f"{base}.{fmt}", f"{base} (2).{fmt}", f"{base} (3).{fmt}"])
                        self.assertEqual(sorted(os.listdir(tmp)), sorted(names))

    def test_merged_export_keeps_its_name(self):
        messages = [dict(m, _conversation="Mom") for m in self.messages]
        for fmt in ("txt", "csv", "html"):
            result = getattr(self.ext, f"_export_merged_{fmt}")(messages, self.out)
            self.assertEqual(os.path.basename(result["files"][0]), f"all_conversations.{fmt}")

    def test_html_escapes_display_name(self):
        _, content = self._export("html", self.messages, "<b>Bob</b>")
        self.assertIn("&lt;b&gt;Bob&lt;/b&gt;", content)
        self.assertNotIn("<b>Bob</b>", content)


if __name__ == "__main__":
    unittest.main()
