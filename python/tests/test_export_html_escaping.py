"""
Tests that HTML exports escape user-derived content.

Message text, sender names and conversation labels come straight from the
backup, so anything like ``<3``, ``<b>`` or ``<script>`` must be written as
text, not interpreted as markup when the export is opened in a browser.
"""

import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from messages import MessageExtractor  # noqa: E402

SCRIPT = "<script>alert(1)</script>"
SCRIPT_ESCAPED = "&lt;script&gt;alert(1)&lt;/script&gt;"


def _msg(message_id: int, text: str, sender: str = "Alice",
         is_from_me: bool = False, conversation: str = None) -> dict:
    msg = {
        "message_id": message_id,
        "date": "2026-01-01T09:00:00+00:00",
        "text": text,
        "sender": sender,
        "is_from_me": is_from_me,
        "has_attachments": False,
        "attachments": [],
    }
    if conversation is not None:
        msg["_conversation"] = conversation
    return msg


class TestExportHtmlEscaping(unittest.TestCase):

    def setUp(self):
        self.ext = MessageExtractor.__new__(MessageExtractor)

    def _export_single(self, messages, display_name="Mom"):
        with tempfile.TemporaryDirectory() as tmp:
            result = self.ext._export_html(messages, 42, tmp, display_name)
            with open(result["file"], encoding="utf-8") as f:
                return f.read()

    def _export_merged(self, messages):
        with tempfile.TemporaryDirectory() as tmp:
            result = self.ext._export_merged_html(messages, tmp)
            with open(result["files"][0], encoding="utf-8") as f:
                return f.read()

    # ── Single-conversation export ──────────────────────────────────────────

    def test_single_escapes_markup_in_text(self):
        content = self._export_single([
            _msg(1, "I <3 you"),
            _msg(2, "<b>bold</b>"),
            _msg(3, SCRIPT),
        ])
        self.assertIn("I &lt;3 you", content)
        self.assertIn("&lt;b&gt;bold&lt;/b&gt;", content)
        self.assertIn(SCRIPT_ESCAPED, content)
        self.assertNotIn("<b>bold</b>", content)
        self.assertNotIn("<script>", content)

    def test_single_escapes_markup_in_sender(self):
        content = self._export_single([_msg(1, "hi", sender=SCRIPT)])
        self.assertIn(f'<div class="sender">{SCRIPT_ESCAPED}</div>', content)
        self.assertNotIn("<script>", content)

    def test_single_escapes_markup_in_conversation_name(self):
        content = self._export_single([_msg(1, "hi")], display_name=SCRIPT)
        self.assertIn(f"<title>Conversation Export: {SCRIPT_ESCAPED}</title>", content)
        self.assertIn(f'<h1 class="conv-title">{SCRIPT_ESCAPED}</h1>', content)
        self.assertNotIn("<script>", content)

    def test_single_preserves_newlines_in_text(self):
        content = self._export_single([_msg(1, "line one\n<i>line two</i>")])
        self.assertIn("line one<br>&lt;i&gt;line two&lt;/i&gt;", content)

    # ── Merged export ───────────────────────────────────────────────────────

    def test_merged_escapes_markup_in_text(self):
        content = self._export_merged([
            _msg(1, "I <3 you", conversation="Mom"),
            _msg(2, "<b>bold</b>", conversation="Mom"),
            _msg(3, SCRIPT, is_from_me=True, conversation="Mom"),
        ])
        self.assertIn("I &lt;3 you", content)
        self.assertIn("&lt;b&gt;bold&lt;/b&gt;", content)
        self.assertIn(SCRIPT_ESCAPED, content)
        self.assertNotIn("<b>bold</b>", content)
        self.assertNotIn("<script>", content)

    def test_merged_escapes_markup_in_sender(self):
        content = self._export_merged([_msg(1, "hi", sender=SCRIPT, conversation="Mom")])
        self.assertIn(f'<div class="sender">{SCRIPT_ESCAPED}</div>', content)
        self.assertNotIn("<script>", content)

    def test_merged_escapes_markup_in_conversation_label(self):
        content = self._export_merged([
            _msg(1, "hi", conversation=SCRIPT),
            _msg(2, "hey", is_from_me=True, conversation="<b>Team</b>"),
        ])
        self.assertIn(f"(from {SCRIPT_ESCAPED})", content)
        self.assertIn("(to &lt;b&gt;Team&lt;/b&gt;)", content)
        self.assertNotIn("<script>", content)
        self.assertNotIn("<b>Team</b>", content)

    def test_merged_preserves_newlines_in_text(self):
        content = self._export_merged([_msg(1, "line one\r\nline two", conversation="Mom")])
        self.assertIn("line one<br>line two", content)


if __name__ == "__main__":
    unittest.main()
