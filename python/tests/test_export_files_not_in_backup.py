"""
A photo or file whose sms.db record iOS removed, keeping the message.

ios-backup-core lists each such file with no id, no name and no type, and
available False (the way a file the backup lacks is marked). Every save says
"Attachment not in this backup" for it, as the thread view does
(src/lib/whatsapp.ts missingLabel): not "Conversation update", which those
messages used to read, and not "File" or "Document", which would be a guess.
An ordinary file with no type keeps its old label.
"""

import csv
import os
import sys
import tempfile
import unittest
from datetime import timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from messages import MessageExtractor, _PrintAttachmentWriter, _nothing_known  # noqa: E402
from person_export import _messages_label  # noqa: E402

LABEL = "[Attachment not in this backup]"


def _gone():
    """One file as ios-backup-core lists it once its record is gone (get_messages adds available)."""
    return {"attachment_id": None, "filename": "", "mime_type": None, "transfer_name": "",
            "total_bytes": None, "available": False}


def _msg(message_id, attachments, text=""):
    return {
        "message_id": message_id,
        "date": "2026-01-01T09:00:00+00:00",
        "text": text,
        "message_type": "attachment",
        "event_text": None,
        "sender": "Alice",
        "is_from_me": False,
        "has_attachments": bool(attachments),
        "attachments": attachments,
    }


class FakeBackup:
    """A backup holding no attachment files."""

    def get_file(self, relative_path, domain="HomeDomain"):
        return None


class TestFilesNotInBackup(unittest.TestCase):

    def setUp(self):
        self.ext = MessageExtractor.__new__(MessageExtractor)
        self.ext.local_tz = timezone.utc
        out = tempfile.TemporaryDirectory()
        self.addCleanup(out.cleanup)
        self.out = out.name
        self.messages = [_msg(1, [_gone()]), _msg(2, [_gone(), _gone()]), _msg(3, [_gone()], text="Look")]

    def _save(self, fmt):
        self.ext.get_messages = lambda *a, **k: {"messages": [dict(m) for m in self.messages],
                                                 "total": len(self.messages)}
        return self.ext.export_conversation(FakeBackup(), 1, {}, fmt, self.out, display_name="Mom")

    @staticmethod
    def _read(path):
        with open(path, encoding="utf-8-sig") as f:
            return f.read()

    def test_nothing_known(self):
        self.assertTrue(_nothing_known(_gone()))
        self.assertTrue(_nothing_known({"transfer_name": "‎ "}))  # nothing visible is no name
        self.assertFalse(_nothing_known({"filename": "~/Library/SMS/Attachments/ab/12/X/notes.bin"}))
        self.assertFalse(_nothing_known({"transfer_name": "notes.bin"}))
        self.assertFalse(_nothing_known({"mime_type": "image/jpeg"}))

    def test_txt(self):
        lines = self._read(self._save("txt")["file"]).splitlines()
        self.assertEqual(lines, [
            f"[Jan 1, 2026, 9:00 AM] Alice: {LABEL}",
            f"[Jan 1, 2026, 9:00 AM] Alice: {LABEL} {LABEL}",
            f"[Jan 1, 2026, 9:00 AM] Alice: Look {LABEL}",
        ])

    def test_csv(self):
        with open(self._save("csv")["file"], newline="", encoding="utf-8-sig") as f:
            rows = list(csv.reader(f))[1:]
        self.assertEqual([row[2] for row in rows], [LABEL, f"{LABEL} {LABEL}", f"Look {LABEL}"])

    def test_html_says_so_and_copies_nothing(self):
        result = self._save("html")
        content = self._read(result["file"])
        self.assertEqual(content.count(f'<div class="attachment-label">{LABEL}</div>'), 4)
        self.assertNotIn("Conversation update", content)
        self.assertNotIn("[File", content)
        self.assertEqual(result.get("failed_files", 0), 0)
        self.assertFalse(os.path.exists(os.path.splitext(result["file"])[0] + "_attachments"))

    def test_pdf_says_so(self):
        content = self._read(self._save("pdf_source")["file"])
        self.assertEqual(content.count(f'<div class="attachment-label">{LABEL}</div>'), 4)

    def test_print_label(self):
        for missing in (True, False):  # never in the backup, whether or not a copy was tried
            self.assertEqual(_PrintAttachmentWriter._label(_gone(), missing=missing),
                             f'<div class="attachment-label">{LABEL}</div>')

    def test_save_everything_on_people(self):
        self.assertEqual(_messages_label(_gone(), "not_in_backup"), "Attachment not in this backup")

    def test_an_ordinary_file_without_a_type_keeps_its_label(self):
        notes = {"attachment_id": 7, "filename": "~/Library/SMS/Attachments/ab/12/X/notes.bin",
                 "mime_type": None, "transfer_name": "notes.bin", "available": False}
        self.assertEqual(_messages_label(notes, "not_in_backup"), "File not in this backup: notes.bin")
        self.assertEqual(_PrintAttachmentWriter._label(notes, missing=True),
                         '<div class="attachment-label">[File not in this backup: notes.bin]</div>')
        self.assertEqual(self.ext._attachment_label({"attachments": [notes]}), "[File: notes.bin]")

    def test_page_details_leave_it_not_in_the_backup(self):
        """get_messages adds available, uti and is_sticker to a page's files: a file with no id or name is
        left not in the backup, and costs no lookup."""
        page = [_msg(1, [{k: v for k, v in _gone().items() if k != "available"}])]
        self.ext._inner = None  # no sms.db needed: there's no id to look up
        self.ext._describe_attachments(FakeBackup(), page)
        att = page[0]["attachments"][0]
        self.assertEqual((att["available"], att["uti"], att["is_sticker"]), (False, None, False))


if __name__ == "__main__":
    unittest.main()
