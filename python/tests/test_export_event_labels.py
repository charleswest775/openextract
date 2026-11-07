"""
Tests for what exports write for a message with no text and no attachment
file: location sharing, an audio message whose file isn't in the backup, a
group change, an unsent message. These used to read "[Attachment]" in HTML
and PDF exports and "[No content]" in TXT, although there was no attachment,
and group changes and unsent messages all read "[Conversation event]"
(report OE-7).
"""

import csv
import html
import os
import re
import sys
import tempfile
import unittest
from datetime import timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from messages import _EVENT_FALLBACK, _EVENT_LABELS, MessageExtractor, _PrintAttachmentWriter  # noqa: E402

THREAD_VIEW_LABELS = os.path.join(os.path.dirname(__file__), "..", "..", "src", "lib", "messageEvents.ts")

# Every message_type the engine gives a message with no text and no
# attachment, and what each export should say.
EXPECTED = {
    "location_started_by_me": "[You started sharing your location]",
    "location_stopped_by_me": "[You stopped sharing your location]",
    "location_started_by_them": "[Started sharing their location]",
    "location_stopped_by_them": "[Stopped sharing their location]",
    "audio": "[Audio message not in this backup]",
    "system": "[Conversation update]",
    "location": "[Conversation update]",
    "link": "[Link]",
    "payment": "[Apple Pay payment]",
    "digital_touch": "[Digital Touch message]",
    "handwriting": "[Handwritten message]",
    "fitness": "[Fitness activity]",
    "game": "[Game message]",
    "app": "[Message from an iMessage app]",
    "something_new": "[Conversation update]",
}

# Group changes, unsent messages and FaceTime calls: the engine says what
# happened in event_text, and every export writes exactly that.
EVENTS = [
    ("group_member_added", "Karin added Theo to the conversation"),
    ("group_member_removed", "You removed Theo from the conversation"),
    ("group_renamed", 'You named the conversation "Trip"'),
    ("group_name_removed", "Karin removed the conversation name"),
    ("group_member_left", "Theo left the conversation"),
    ("group_photo_changed", "The group photo was changed"),
    ("group_photo_removed", "Karin removed the group photo"),
    ("unsent", "Karin unsent a message"),
    ("facetime", "FaceTime call"),
]
LABELS = list(EXPECTED.values()) + [f"[{words}]" for _, words in EVENTS]


def _event(message_id, message_type, is_from_me=False, conversation=None, event_text=None):
    """A message as the engine returns it for a location share, group change, etc."""
    msg = {
        "message_id": message_id,
        "date": "2026-01-01T09:00:00+00:00",
        "text": "",
        "message_type": message_type,
        "event_text": event_text,
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
    plain = [_event(i, t, conversation=conversation) for i, t in enumerate(EXPECTED, start=1)]
    events = [_event(i, t, conversation=conversation, event_text=words)
              for i, (t, words) in enumerate(EVENTS, start=len(plain) + 1)]
    return plain + events


def _read(path, encoding="utf-8"):
    with open(path, encoding=encoding) as f:
        return f.read()


class TestEventLabels(unittest.TestCase):

    def setUp(self):
        self.ext = MessageExtractor.__new__(MessageExtractor)
        self.ext.local_tz = timezone.utc
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.out = self.tmp.name

    def _bubbles(self, content):
        return re.findall(r'<div class="msg (?:sent|received)">(.*?)</div>\n', content)

    def assertLabelledBubbles(self, content):
        self.assertNotIn("[Attachment]", content)
        expected = [f'<div class="attachment-label">{html.escape(label)}</div>' for label in LABELS]
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
        self.assertEqual(lines, [f"[Jan 1, 2026, 9:00 AM] Alice: {label}" for label in LABELS])

    def test_merged_txt_labels_each_type(self):
        result = self.ext._export_merged_txt(_messages("Mom"), self.out)
        lines = _read(result["files"][0], "utf-8-sig").splitlines()
        self.assertEqual(lines, [f"[Jan 1, 2026, 9:00 AM] (from Mom) Alice: {label}"
                                 for label in LABELS])

    def test_csv_text_column_labels_each_type(self):
        for result, column in (
            (self.ext._export_csv(_messages(), 1, self.out, "Mom"), 2),
            (self.ext._export_merged_csv(_messages("Mom"), self.out), 4),
        ):
            path = result["file"] if "file" in result else result["files"][0]
            with open(path, newline="", encoding="utf-8-sig") as f:
                rows = list(csv.reader(f))[1:]
            self.assertEqual([row[column] for row in rows], LABELS)

    def test_sent_event_is_labelled_in_a_sent_bubble(self):
        result = self.ext._export_html([_event(1, "system", is_from_me=True)], 1, self.out, "Mom")
        self.assertIn('<div class="msg sent"><div class="attachment-label">[Conversation update]</div></div>',
                      _read(result["file"]))

    def test_event_text_is_escaped_in_html(self):
        msg = _event(1, "group_renamed", event_text='Tom & <Jerry> named the conversation "Fun"')
        for writer in (None, _PrintAttachmentWriter(self.ext, backup=None, output_dir=self.out)):
            content = _read(self.ext._export_html([msg], 1, self.out, "Mom", attachments=writer)["file"])
            self.assertIn('<div class="attachment-label">[Tom &amp; &lt;Jerry&gt; named the conversation '
                          '&quot;Fun&quot;]</div>', content)
            self.assertNotIn("<Jerry>", content)

    def test_text_and_attachments_win_over_event_text(self):
        with_text = {**_event(1, "unsent", event_text="Karin unsent a message"), "text": "still here"}
        with_file = {**_event(2, "unsent", event_text="Karin unsent a message"), "has_attachments": True}
        lines = _read(self.ext._export_txt([with_text, with_file], 1, self.out, "Mom")["file"], "utf-8-sig")
        self.assertEqual(lines.splitlines(), ["[Jan 1, 2026, 9:00 AM] Alice: still here",
                                              "[Jan 1, 2026, 9:00 AM] Alice: [Attachment]"])

    def test_message_from_an_older_engine_without_event_text(self):
        msg = _event(1, "system")
        del msg["event_text"]
        txt_file = self.ext._export_txt([msg], 1, self.out, "Mom")["file"]
        self.assertIn("Alice: [Conversation update]", _read(txt_file, "utf-8-sig"))

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
        source = _read(THREAD_VIEW_LABELS)
        for message_type, label in _EVENT_LABELS.items():
            self.assertIn(f"{message_type}: '{label}',", source)
        self.assertIn(f"export const EVENT_FALLBACK = '{_EVENT_FALLBACK}';", source)
        self.assertIn("if (message.event_text) return message.event_text;", source)


if __name__ == "__main__":
    unittest.main()
