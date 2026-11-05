"""
Exports filtered by a search (export_conversation / export_conversations with a
query). search_messages results have no has_attachments, attachments or
message_type, which the CSV export read directly (KeyError) and the other
formats need for attachment labels.
"""

import csv
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from messages import MessageExtractor  # noqa: E402


def _full(message_id: int, text: str, attachments: list) -> dict:
    """A message as get_messages returns it."""
    return {
        "message_id": message_id,
        "date": f"2026-01-01T10:0{message_id}:00+00:00",
        "text": text,
        "message_type": "text",
        "sender": "me",
        "is_from_me": True,
        "has_attachments": bool(attachments),
        "attachments": attachments,
    }


def _found(message_id: int, text: str) -> dict:
    """A message as search_messages returns it."""
    return {
        "message_id": message_id,
        "date": f"2026-01-01T10:0{message_id}:00+00:00",
        "text": text,
        "sender": "me",
        "is_from_me": True,
        "chat_id": 7,
    }


PHOTO = {"attachment_id": 1, "filename": "IMG_0001.HEIC", "mime_type": "image/heic",
         "transfer_name": "IMG_0001.HEIC", "total_bytes": 10}


class TestExportSearchResults(unittest.TestCase):

    def setUp(self):
        self.ext = MessageExtractor.__new__(MessageExtractor)
        messages = [
            _full(1, "fresh bread", [PHOTO]),
            _full(2, "no match here", []),
            _full(3, "more bread?", []),
        ]
        self.ext.get_messages = lambda backup, chat_id, contacts, offset=0, limit=500, **kw: {
            "messages": messages if offset == 0 else [], "total": len(messages),
        }
        # Message 4 is a location balloon get_messages hides; the search still finds it
        self.ext.search_messages = lambda backup, query, contacts, chat_id=None, **kw: {
            "results": [_found(1, "fresh bread"), _found(3, "more bread?"), _found(4, "bread at the bakery")],
        }

    def _rows(self, path):
        with open(path, encoding="utf-8-sig", newline="") as f:
            return list(csv.reader(f))

    def test_csv_of_one_conversation(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = self.ext.export_conversation(object(), 7, {}, "csv", tmp, query="bread")
            rows = self._rows(result["file"])
        self.assertEqual(result["message_count"], 3)
        self.assertEqual([(r[2], r[4]) for r in rows[1:]], [
            ("fresh bread [Image: IMG_0001.HEIC]", "True"),
            ("more bread?", "False"),
            ("bread at the bakery", "False"),
        ])

    def test_csv_of_several_conversations_merged(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = self.ext.export_conversations(object(), [7], {7: "Mom"}, {}, "csv", tmp,
                                                   mode="merged", query="bread")
            rows = self._rows(result["files"][0])
        self.assertEqual(result["message_count"], 3)
        self.assertEqual([r[6] for r in rows[1:]], ["True", "False", "False"])

    def test_txt_labels_the_attachment(self):
        with tempfile.TemporaryDirectory() as tmp:
            result = self.ext.export_conversation(object(), 7, {}, "txt", tmp, query="bread")
            with open(result["file"], encoding="utf-8-sig") as f:
                text = f.read()
        self.assertIn("fresh bread [Image: IMG_0001.HEIC]", text)


if __name__ == "__main__":
    unittest.main()
