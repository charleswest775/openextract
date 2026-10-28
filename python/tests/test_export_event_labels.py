"""
Tests for what exports write for a message with no text and no attachment
file: location sharing, an audio message whose file isn't in the backup, a
group change. These used to read "[Attachment]" in HTML and PDF exports and
"[No content]" in TXT, although there was no attachment.
"""

import csv
import os
import re
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from messages import _EVENT_FALLBACK, _EVENT_LABELS, MessageExtractor, _PrintAttachmentWriter  # noqa: E402

CHAT_BUBBLE = os.path.join(os.path.dirname(__file__), "..", "..", "src", "components", "explore", "ChatBubble.tsx")

# Every message_type the engine gives a message with no text and no
# attachment, and what each export should say.
EXPECTED = {
    "location_started_by_me": "[You started sharing your location]",
    "location_stopped_by_me": "[You stopped sharing your location]",
    "location_started_by_them": "[Started sharing their location]",
    "location_stopped_by_them": "[Stopped sharing their location]",
    "audio": "[Audio message not in this backup]",
    "system": "[Conversation event]",
    "location": "[Conversation event]",
    "link": "[Link]",
    "payment": "[Apple Pay payment]",
    "digital_touch": "[Digital Touch message]",
    "handwriting": "[Handwritten message]",
    "fitness": "[Fitness activity]",
    "game": "[Game message]",
    "app": "[Message from an iMessage app]",
    "something_new": "[Conversation event]",
}


def _event(message_id, message_type, is_from_me=False, conversation=None):
    """A message as the engine returns it for a location share, group change, etc."""
    msg = {
        "message_id": message_id,
        "date": "2026-01-01T09:00:00+00:00",
        "text": "",
        "message_type": message_type,
        "sender": "me" if is_from_me else "Alice",
        "is_from_me": is_from_me,
        "has_attachments": False,
        "attachments": [],
        "is_reaction": False,
    }
    if conversation is not None:
        msg["_conversation"] = conversation
    return msg


def _messages(conversation=None):
    return [_event(i, t, conversation=conversation) for i, t in enumerate(EXPECTED, start=1)]


def _read(path, encoding="utf-8"):
    with open(path, encoding=encoding) as f:
        return f.read()


class TestEventLabels(unittest.TestCase):

    def setUp(self):
        self.ext = MessageExtractor.__new__(MessageExtractor)
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = self.tmp.name

    def _bubbles(self, content):
        return re.findall(r'<div class="msg (?:sent|received)">(.*?)</div>\n', content)

    def assertLabelledBubbles(self, content):
        self.assertNotIn("[Attachment]", content)
        expected = [f'<div class="attachment-label">{label}</div>' for label in EXPECTED.values()]
        self.assertEqual(self._bubbles(content), expected)

    def test_html_labels_each_type_like_an_attachment_label(self):
        result = self.ext._export_html(_messages(), 1, self.out, "Mom")
        self.assertLabelledBubbles(_read(result["file"]))

    def test_pdf_source_labels_each_type(self):
        writer = _PrintAttachmentWriter(self.ext, backup=None, output_dir=self.out)
        result = self.ext._export_html(_messages(), 1, self.out, "Mom", attachments=writer)
        self.assertLabelledBubbles(_read(result["file"]))
        self.assertFalse(os.path.exists(os.path.join(self.out, "attachments")))

    def test_merged_html_and_pdf_source_label_each_type(self):
        for writer in (None, _PrintAttachmentWriter(self.ext, backup=None, output_dir=self.out)):
            result = self.ext._export_merged_html(_messages("Mom"), self.out, attachments=writer)
            self.assertLabelledBubbles(_read(result["files"][0]))

    def test_txt_labels_each_type(self):
        result = self.ext._export_txt(_messages(), 1, self.out, "Mom")
        lines = _read(result["file"], "utf-8-sig").splitlines()
        self.assertEqual(lines, [f"[2026-01-01T09:00:00+00:00] Alice: {label}" for label in EXPECTED.values()])

    def test_merged_txt_labels_each_type(self):
        result = self.ext._export_merged_txt(_messages("Mom"), self.out)
        lines = _read(result["files"][0], "utf-8-sig").splitlines()
        self.assertEqual(lines, [f"[2026-01-01T09:00:00+00:00] (from Mom) Alice: {label}"
                                 for label in EXPECTED.values()])

    def test_csv_text_column_labels_each_type(self):
        for result, column in (
            (self.ext._export_csv(_messages(), 1, self.out, "Mom"), 2),
            (self.ext._export_merged_csv(_messages("Mom"), self.out), 4),
        ):
            path = result["file"] if "file" in result else result["files"][0]
            with open(path, newline="", encoding="utf-8-sig") as f:
                rows = list(csv.reader(f))[1:]
            self.assertEqual([row[column] for row in rows], list(EXPECTED.values()))

    def test_sent_event_is_labelled_in_a_sent_bubble(self):
        result = self.ext._export_html([_event(1, "system", is_from_me=True)], 1, self.out, "Mom")
        self.assertIn('<div class="msg sent"><div class="attachment-label">[Conversation event]</div></div>',
                      _read(result["file"]))

    def test_message_flagged_with_unknown_attachments_still_reads_attachment(self):
        msg = {**_event(1, "attachment"), "has_attachments": True}
        html_file = self.ext._export_html([msg], 1, self.out, "Mom")["file"]
        txt_file = self.ext._export_txt([msg], 1, self.out, "Mom")["file"]
        self.assertIn('<div class="attachment-label">[Attachment]</div>', _read(html_file))
        self.assertIn("Alice: [Attachment]", _read(txt_file, "utf-8-sig"))

    def test_search_result_without_message_type_keeps_its_text(self):
        # Search-filtered exports get search_messages rows, which have no
        # message_type or attachment fields.
        msg = {"message_id": 1, "date": "2026-01-01T09:00:00+00:00", "text": "see you",
               "is_from_me": False, "sender": "Alice", "chat_id": 1}
        html_file = self.ext._export_html([msg], 1, self.out, "Mom")["file"]
        txt_file = self.ext._export_txt([msg], 1, self.out, "Mom")["file"]
        self.assertIn('<div class="msg received">see you</div>', _read(html_file))
        self.assertIn("Alice: see you", _read(txt_file, "utf-8-sig"))

    def test_text_is_never_replaced_by_a_label(self):
        msg = {**_event(1, "location_started_by_them"), "text": "omw"}
        content = _read(self.ext._export_html([msg], 1, self.out, "Mom")["file"])
        self.assertIn('<div class="msg received">omw</div>', content)
        self.assertNotIn("attachment-label", content.split("</style>")[1])

    def test_thread_view_uses_the_same_words(self):
        source = _read(CHAT_BUBBLE)
        for message_type, label in _EVENT_LABELS.items():
            self.assertIn(f"{message_type}: '{label}',", source)
        self.assertIn(f"const EVENT_FALLBACK = '{_EVENT_FALLBACK}';", source)


if __name__ == "__main__":
    unittest.main()
