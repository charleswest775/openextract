"""
A save never replaces a file that's already in the folder.

Merged conversations, the voicemail list and recordings, and a photo's .json had fixed
names and were written over whatever had them: an earlier save, a save of another
backup, or the person's own file. test_photo_save_names.py covers the photos' names.
"""

import io
import os
import sys
import tempfile
import unittest
from datetime import timezone
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))
import photos  # noqa: E402
import voice_memos  # noqa: E402
import whatsapp  # noqa: E402
from messages import MessageExtractor  # noqa: E402
from test_photo_save_names import FIRST, SECOND, _FakeBackup  # noqa: E402
from voicemail import VoicemailExtractor  # noqa: E402


def _write(path: str, data: bytes) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)
    return path


def _files(folder: str) -> dict:
    """relative path (with /) → contents, for every file under ``folder``."""
    found = {}
    for parent, _, names in os.walk(folder):
        for name in names:
            path = os.path.join(parent, name)
            with open(path, "rb") as f:
                found[os.path.relpath(path, folder).replace(os.sep, "/")] = f.read()
    return found


class _InATempFolder(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = tmp.name
        self.out = os.path.join(tmp.name, "out")
        os.makedirs(self.out)


class TestPhotos(_InATempFolder):
    def backup(self, files: dict, name: str = "backup", encrypted: bool = False):
        return _FakeBackup(os.path.join(self.tmp, name), files, encrypted)

    def save(self, backup, **options) -> dict:
        return photos.PhotoExtractor().export_photos(backup, self.out, options)

    def test_saving_again_by_month_makes_no_copies(self):
        backup = self.backup({FIRST: b"first", SECOND: b"second"})
        self.save(backup, folder_structure="by_date")
        saved = _files(self.out)
        self.save(backup, folder_structure="by_date")
        self.assertEqual(sorted(saved.values()), [b"first", b"second"])
        self.assertEqual(_files(self.out), saved)

    def test_someone_elses_json_is_never_replaced(self):
        # Google Takeout names its own sidecars exactly like ours
        _write(os.path.join(self.out, "IMG_0001.JPG.json"), b"theirs")
        backup = self.backup({FIRST: b"first"})
        self.save(backup, include_metadata_sidecar=True)
        saved = _files(self.out)
        self.assertEqual(saved["IMG_0001.JPG.json"], b"theirs")
        self.assertIn(b'"filename": "IMG_0001.JPG"', saved["IMG_0001.JPG (2).json"])
        self.save(backup, include_metadata_sidecar=True)
        self.assertEqual(_files(self.out), saved, "saving again made copies of the .json")

    def test_sidecars_saved_again_make_no_copies(self):
        backup = self.backup({FIRST: b"first", SECOND: b"second"})
        self.save(backup, include_metadata_sidecar=True)
        saved = _files(self.out)
        self.save(backup, include_metadata_sidecar=True)
        self.assertEqual(len(saved), 4)
        self.assertEqual(_files(self.out), saved)

    def test_two_heics_made_jpegs_are_two_jpegs(self):
        from PIL import Image

        def picture(colour) -> bytes:
            # PIL goes by the contents, so this needs no pillow-heif
            buf = io.BytesIO()
            Image.new("RGB", (32, 32), colour).save(buf, format="PNG")
            return buf.getvalue()

        _write(os.path.join(self.out, "IMG_0001.jpg"), b"theirs")
        backup = self.backup({FIRST.replace(".JPG", ".HEIC"): picture("red"),
                              SECOND.replace(".JPG", ".HEIC"): picture("blue")})
        self.assertEqual(self.save(backup, format="jpeg")["exported"], 2)
        saved = _files(self.out)
        self.assertEqual((len(saved), saved["IMG_0001.jpg"]), (3, b"theirs"))
        self.save(backup, format="jpeg")
        self.assertEqual(_files(self.out), saved)

    def test_a_file_that_turns_up_after_the_name_was_chosen_is_left_alone(self):
        _write(os.path.join(self.out, "IMG_0001.JPG"), b"theirs")
        backup = self.backup({FIRST: b"first"})
        # The folder didn't show it when the name was chosen (it arrived since, or a drive didn't say)
        with mock.patch("os.path.lexists", return_value=False):
            result = self.save(backup)
        self.assertEqual(_files(self.out), {"IMG_0001.JPG": b"theirs"})
        self.assertEqual((result["exported"], result["errors"]), (0, 1))

    def test_a_copy_changed_since_the_last_save_isnt_taken_for_the_photo(self):
        backup = self.backup({FIRST: b"first"})
        self.save(backup)
        self.save(backup)  # compares the two files, and finds them the same
        saved = os.path.join(self.out, "IMG_0001.JPG")
        before = os.stat(saved)
        _write(saved, b"FIRST")  # edited, keeping its size and date
        os.utime(saved, ns=(before.st_atime_ns, before.st_mtime_ns))
        self.save(backup)
        self.assertEqual(sorted(_files(self.out).values()), [b"FIRST", b"first"])


def _message(text: str, attachments=()) -> dict:
    return {"message_id": 1, "date": "2026-01-01T09:00:00+00:00", "text": text, "sender": "Alice",
            "is_from_me": False, "has_attachments": bool(attachments), "attachments": list(attachments)}


class _MediaBackup:
    def __init__(self, files: dict):
        self.files = files

    def get_file(self, relative_path, domain="HomeDomain"):
        return self.files.get(relative_path) if domain == "MediaDomain" else None


class TestMessages(_InATempFolder):
    def setUp(self):
        super().setUp()
        self.messages = MessageExtractor.__new__(MessageExtractor)
        self.messages.local_tz = timezone.utc

    def merge(self, fmt: str, *messages, backup=None, part=None) -> str:
        self.messages.get_messages = lambda *a, **k: {"messages": [dict(m) for m in messages], "total": len(messages)}
        return self.messages.export_conversations(
            backup or _MediaBackup({}), [1], {1: "Alice"}, {}, fmt, self.out, mode="merged", part=part,
        )["files"][0]

    def test_a_second_merged_save_keeps_the_first(self):
        for fmt, ext in (("txt", "txt"), ("csv", "csv"), ("html", "html")):
            with self.subTest(fmt):
                first = self.merge(fmt, _message("the first selection"))
                kept = _files(self.out)[f"all_conversations.{ext}"]
                second = self.merge(fmt, _message("another selection"))
                saved = _files(self.out)
                self.assertEqual(saved[f"all_conversations.{ext}"], kept)
                self.assertIn(b"another selection", saved[f"all_conversations (2).{ext}"])
                self.assertEqual([os.path.basename(first), os.path.basename(second)],
                                 [f"all_conversations.{ext}", f"all_conversations (2).{ext}"])

    def test_a_merged_page_for_a_pdf_keeps_its_name_and_never_replaces_one(self):
        part = {"from": "2026-01", "to": "2026-12", "label": "2026", "undated": False}
        names = [os.path.basename(self.merge("pdf_source", _message("hello"), part=part)) for _ in range(2)]
        self.assertEqual(names, ["all_conversations 2026.html", "all_conversations 2026 (2).html"])

    def test_someone_elses_file_of_that_name_is_left_alone(self):
        _write(os.path.join(self.out, "all_conversations.txt"), b"theirs")
        self.merge("txt", _message("hello"))
        self.assertEqual(_files(self.out)["all_conversations.txt"], b"theirs")

    def test_a_folder_of_files_already_there_is_never_written_into(self):
        # Left from a save whose page was moved, from another backup (whose ids start at 1 too),
        # or made by People's save, whose folder has the same name.
        source = _write(os.path.join(self.tmp, "backup", "photo.jpg"), b"new photo")
        backup = _MediaBackup({"Library/SMS/Attachments/ab/photo.jpg": source})
        att = {"attachment_id": 7, "filename": "~/Library/SMS/Attachments/ab/photo.jpg",
               "mime_type": "image/jpeg", "transfer_name": "photo.jpg"}
        self.messages.get_messages = lambda *a, **k: {"messages": [_message("", [att])], "total": 1}
        single = "Alice, Jan 1 2026"
        saves = (
            ("all_conversations", lambda: self.merge("html", _message("", [att]), backup=backup)),
            (single, lambda: self.messages.export_conversation(
                backup, 1, {}, "html", self.out, display_name="Alice")["file"]),
        )
        for base, save in saves:
            with self.subTest(base):
                old = f"{base}_attachments/7-photo.jpg"
                _write(os.path.join(self.out, old), b"an older one")
                page = save()
                saved = _files(self.out)
                self.assertEqual(saved[old], b"an older one")
                self.assertEqual(os.path.basename(page), f"{base} (2).html")
                self.assertEqual(saved[f"{base} (2)_attachments/7-photo.jpg"], b"new photo")

    def test_whatsapp_pages_dont_write_into_that_folder_either(self):
        _write(os.path.join(self.out, "all_whatsapp_chats_attachments", "wa1-photo.jpg"), b"an older one")
        export = whatsapp._WhatsAppExport.__new__(whatsapp._WhatsAppExport)
        export.local_tz = timezone.utc
        media = whatsapp._WhatsAppHtmlMedia(export, None)
        page = export._write_html([], self.out, "all_whatsapp_chats", "", media, merged=True)["file"]
        self.assertEqual(os.path.basename(page), "all_whatsapp_chats (2).html")


class TestVoicemail(_InATempFolder):
    def save(self, audio: bytes, folder: str = "voicemail", transcript: str = "Call me") -> dict:
        source = _write(os.path.join(self.tmp, "backup", "1.amr"), audio)
        vm = {"id": 1, "folder": folder, "date_received": "2024-07-05T12:00:00+00:00", "contact_name": "Mum",
              "phone_number": "+15550000001", "duration": 9, "is_read": True, "transcript": transcript}
        extractor = VoicemailExtractor()
        extractor.local_tz = timezone.utc
        extractor._inner = mock.Mock(**{"list_voicemails.return_value": {"voicemails": [vm]},
                                        "get_audio_path.return_value": source})
        return extractor.export_voicemails(None, {}, self.out)

    def test_a_second_list_keeps_the_first(self):
        self.save(b"amr", transcript="the first save")
        self.save(b"amr", transcript="another save")
        saved = _files(self.out)
        self.assertIn(b"the first save", saved["voicemails.csv"])
        self.assertIn(b"another save", saved["voicemails (2).csv"])

    def test_a_different_recording_with_that_name_is_kept(self):
        # Two phones' first voicemails, from the same person on the same day
        for folder, where in (("voicemail", "audio"), ("spam", "audio/Spam"), ("deleted", "audio/Deleted")):
            with self.subTest(folder):
                self.save(b"one phone's", folder)
                self.save(b"the other's", folder)
                saved = _files(self.out)
                self.assertEqual(saved[f"{where}/Mum_2024-07-05_1.amr"], b"one phone's")
                self.assertEqual(saved[f"{where}/Mum_2024-07-05_1 (2).amr"], b"the other's")

    def test_saving_again_makes_no_copies_of_the_recordings(self):
        self.save(b"amr")
        self.save(b"amr")
        self.assertEqual([p for p in _files(self.out) if p.endswith(".amr")], ["audio/Mum_2024-07-05_1.amr"])


class TestVoiceMemos(_InATempFolder):
    def test_a_copy_that_finds_a_file_there_doesnt_delete_it(self):
        source = _write(os.path.join(self.tmp, "backup", "memo.m4a"), b"memo")
        dest = _write(os.path.join(self.out, "Memo.m4a"), b"theirs")
        with self.assertRaises(FileExistsError):
            voice_memos._copy_new(source, dest)
        self.assertEqual(_files(self.out), {"Memo.m4a": b"theirs"})


if __name__ == "__main__":
    unittest.main()
