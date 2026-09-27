"""
Tests for the Voice Memos adapter: audio delivery and export.

The core extractor is stubbed, so these run against any ios-backup-core version.
"""

import base64
import csv
import os
import sys
import tempfile
import unittest
from datetime import datetime

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import voice_memos  # noqa: E402
from export_files import safe_filename  # noqa: E402
from voice_memos import VoiceMemoExtractor, export_file_name  # noqa: E402


def _memo(memo_id, title, date, file_name, deleted=False, has_audio=True):
    return {"id": memo_id, "title": title, "date": date, "duration": 12.34, "folder": None,
            "deleted": deleted, "deleted_date": None, "file_name": file_name,
            "has_audio": has_audio}


class _StubCore:
    """Serves memos and audio files from a temp folder."""

    def __init__(self, memos, audio_dir, hashed_names=False):
        self.memos = memos
        self.paths = {}
        for m in memos:
            if m["has_audio"]:
                # Unencrypted backups store files under extension-less hash names.
                name = f"hash{m['id']}" if hashed_names else m["file_name"]
                path = os.path.join(audio_dir, name)
                with open(path, "wb") as f:
                    f.write(f"audio-{m['id']}".encode())
                self.paths[m["id"]] = path

    def list_voice_memos(self, backup):
        return {"voice_memos": self.memos, "errors": []}

    def get_audio_file(self, backup, memo_id):
        memo = next((m for m in self.memos if m["id"] == memo_id), None)
        if not memo or memo_id not in self.paths:
            return None
        return {"path": self.paths[memo_id], "file_name": memo["file_name"],
                "mime_type": "audio/mp4"}


class VoiceMemoAdapterTests(unittest.TestCase):
    def setUp(self):
        self.src = tempfile.mkdtemp()
        self.out = tempfile.mkdtemp()
        self.ext = VoiceMemoExtractor()
        self.memos = [
            _memo(3, "Idea", "2024-01-01T14:00:00+00:00", "c.m4a", deleted=True),
            _memo(2, "Standup", "2024-01-01T13:00:00+00:00", "b.qta"),
            _memo(1, "Standup", "2024-01-01T13:00:00+00:00", "a.m4a"),
            _memo(4, "Lost", "2024-01-01T11:00:00+00:00", "d.m4a", has_audio=False),
        ]

    def _use(self, hashed_names=False):
        self.ext._inner = _StubCore(self.memos, self.src, hashed_names)

    def test_export_names_copies_and_csv(self):
        self._use()
        result = self.ext.export_voice_memos(object(), self.out)
        self.assertEqual((result["exported"], result["missing"], result["total"]), (3, 1, 4))

        stamp = datetime.fromisoformat("2024-01-01T13:00:00+00:00").astimezone()
        base = stamp.strftime("%Y-%m-%d %H.%M") + " Standup"
        files = set(os.listdir(self.out))
        self.assertIn(base + ".qta", files)
        self.assertIn(base + ".m4a", files)
        self.assertIn("voice_memos.csv", files)

        with open(os.path.join(self.out, base + ".qta"), "rb") as f:
            self.assertEqual(f.read(), b"audio-2")
        self.assertAlmostEqual(os.path.getmtime(os.path.join(self.out, base + ".qta")),
                               stamp.timestamp(), delta=1)

        with open(os.path.join(self.out, "voice_memos.csv"), encoding="utf-8") as f:
            rows = list(csv.reader(f))
        self.assertEqual(rows[0], ["Date", "Title", "Duration (seconds)", "Folder",
                                   "Recently Deleted", "File"])
        self.assertEqual(rows[1][4], "Yes")          # the deleted memo is flagged
        self.assertEqual(rows[4][5], "")             # no audio → no file

    def test_duplicate_names_get_a_suffix(self):
        self.memos[2]["file_name"] = "a.qta"  # same title, date and extension as memo 2
        self._use()
        self.ext.export_voice_memos(object(), self.out)
        audio = sorted(f for f in os.listdir(self.out) if f.endswith(".qta"))
        self.assertEqual(len(audio), 2)
        self.assertTrue(audio[0].endswith(" (2).qta") or audio[1].endswith(" (2).qta"))

    def test_export_can_skip_deleted(self):
        self._use()
        result = self.ext.export_voice_memos(object(), self.out, include_deleted=False)
        self.assertEqual(result["total"], 3)

    def test_get_audio_base64(self):
        self._use()
        audio = self.ext.get_audio(object(), 2)
        self.assertEqual(base64.b64decode(audio["data"]), b"audio-2")
        self.assertEqual(audio["mime_type"], "audio/mp4")

    def test_get_audio_too_large(self):
        self._use()
        original = voice_memos.MAX_INLINE_AUDIO_BYTES
        voice_memos.MAX_INLINE_AUDIO_BYTES = 3
        try:
            audio = self.ext.get_audio(object(), 2)
        finally:
            voice_memos.MAX_INLINE_AUDIO_BYTES = original
        self.assertTrue(audio["too_large"])
        self.assertNotIn("data", audio)

    def test_get_audio_missing(self):
        self._use()
        self.assertIn("error", self.ext.get_audio(object(), 4))

    def test_playable_file_gets_its_extension(self):
        self._use(hashed_names=True)
        path = self.ext.get_playable_file(object(), 2)["path"]
        self.assertTrue(path.endswith(".qta"))
        with open(path, "rb") as f:
            self.assertEqual(f.read(), b"audio-2")

    def test_playable_file_used_directly_when_named(self):
        self._use()
        self.assertEqual(self.ext.get_playable_file(object(), 1)["path"],
                         os.path.join(self.src, "a.m4a"))

    def test_outdated_core(self):
        self.ext._inner = None
        self.assertEqual(len(self.ext.list_voice_memos(object())["errors"]), 1)
        self.assertIn("error", self.ext.get_audio(object(), 1))


class FileNameTests(unittest.TestCase):
    def test_safe_filename(self):
        self.assertEqual(safe_filename('a/b:c*d?"e<f>g|h'), "a_b_c_d__e_f_g_h")
        self.assertEqual(safe_filename("  trailing dots... "), "trailing dots")
        self.assertEqual(safe_filename(""), "Untitled")

    def test_export_file_name_without_title_or_date(self):
        self.assertEqual(export_file_name({"title": "", "date": None, "file_name": "x.qta"}),
                         "Recording.qta")


if __name__ == "__main__":
    unittest.main()
