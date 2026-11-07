"""
Tests for attachments in the HTML export (GitHub issue #83, OE-15).

Every attachment is copied into a folder beside the page, named after it;
photos and GIFs show inline, videos and common audio get a player, and
everything links to its file. Photos browsers can't show get a JPEG copy.
"""

import os
import sys
import tempfile
import unittest

from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from messages import MessageExtractor  # noqa: E402


class FakeBackup:
    """Maps sms.db attachment paths (without ~/) to files on disk."""

    def __init__(self, files: dict):
        self.files = files

    def get_file(self, relative_path, domain="HomeDomain"):
        return self.files.get(relative_path) if domain == "MediaDomain" else None


def _att(attachment_id, name, mime_type, transfer_name=None):
    return {
        "attachment_id": attachment_id,
        "filename": f"~/Library/SMS/Attachments/ab/{name}",
        "mime_type": mime_type,
        "transfer_name": transfer_name if transfer_name is not None else name,
        "total_bytes": 0,
    }


def _msg(message_id, text="", attachments=None, conversation=None):
    msg = {
        "message_id": message_id,
        "date": "2026-01-01T09:00:00+00:00",
        "text": text,
        "sender": "Alice",
        "is_from_me": False,
        "has_attachments": bool(attachments),
        "attachments": attachments or [],
    }
    if conversation is not None:
        msg["_conversation"] = conversation
    return msg


class TestHtmlExportAttachments(unittest.TestCase):

    def setUp(self):
        self.ext = MessageExtractor.__new__(MessageExtractor)
        src = tempfile.TemporaryDirectory()
        out = tempfile.TemporaryDirectory()
        self.addCleanup(src.cleanup)
        self.addCleanup(out.cleanup)
        self.src, self.out = src.name, out.name
        self.files = {}

    def _file(self, name, data=None, image=None):
        """A file in the fake backup; ``image`` is a PIL format to draw one in."""
        path = os.path.join(self.src, name)
        if image:
            Image.new("RGB", (40, 30), (10, 120, 200)).save(path, image)
        else:
            with open(path, "wb") as f:
                f.write(data if data is not None else os.urandom(64))
        self.files[f"Library/SMS/Attachments/ab/{name}"] = path
        return path

    def _export(self, messages, display_name="Mom"):
        self.ext.get_messages = lambda *a, **k: {"messages": list(messages), "total": len(messages)}
        result = self.ext.export_conversation(FakeBackup(self.files), 1, {}, "html", self.out,
                                              display_name=display_name)
        page = result["file"]
        with open(page, encoding="utf-8") as f:
            content = f.read()
        folder = os.path.splitext(page)[0] + "_attachments"
        return result, content, folder, os.path.basename(folder)

    def test_photo_is_copied_beside_the_page_and_shown(self):
        png = self._file("IMG_0001.png", image="PNG")
        _, content, folder, rel = self._export([_msg(1, "look", [_att(55, "IMG_0001.png", "image/png")])])

        copied = os.path.join(folder, "55-IMG_0001.png")
        with open(png, "rb") as a, open(copied, "rb") as b:
            self.assertEqual(a.read(), b.read())
        self.assertIn(f'<a href="{rel}/55-IMG_0001.png"><img src="{rel}/55-IMG_0001.png" alt="IMG_0001.png" loading="lazy"></a>',
                      content)
        self.assertIn('<div class="text">look</div>', content)

    def test_gif_is_copied_unchanged_so_it_still_moves(self):
        gif = self._file("party.gif", image="GIF")
        _, content, folder, rel = self._export([_msg(1, "", [_att(3, "party.gif", "image/gif")])])
        with open(gif, "rb") as a, open(os.path.join(folder, "3-party.gif"), "rb") as b:
            self.assertEqual(a.read(), b.read())
        self.assertIn(f'<img src="{rel}/3-party.gif"', content)

    def test_photo_browsers_cannot_show_gets_a_jpeg_copy_and_keeps_the_original(self):
        tiff = self._file("scan.tiff", image="TIFF")
        _, content, folder, rel = self._export([_msg(1, "", [_att(8, "scan.tiff", "image/tiff")])])

        with open(tiff, "rb") as a, open(os.path.join(folder, "8-scan.tiff"), "rb") as b:
            self.assertEqual(a.read(), b.read())
        with Image.open(os.path.join(folder, "8-scan.jpg")) as preview:
            self.assertEqual(preview.format, "JPEG")
        self.assertIn(f'<img src="{rel}/8-scan.jpg"', content)
        self.assertNotIn('src="' + rel + '/8-scan.tiff"', content)

    def test_heic_photo_gets_a_jpeg_copy(self):
        try:
            import pillow_heif
            pillow_heif.register_heif_opener()
            path = os.path.join(self.src, "IMG_2.HEIC")
            Image.new("RGB", (40, 30), (200, 10, 10)).save(path, "HEIF")
        except Exception as e:  # no HEIF encoder in this build
            self.skipTest(f"can't write HEIC here: {e}")
        self.files["Library/SMS/Attachments/ab/IMG_2.HEIC"] = path
        _, content, folder, rel = self._export([_msg(1, "", [_att(2, "IMG_2.HEIC", "image/heic")])])
        self.assertTrue(os.path.isfile(os.path.join(folder, "2-IMG_2.HEIC")))
        self.assertIn(f'<img src="{rel}/2-IMG_2.jpg"', content)

    def test_unreadable_photo_still_links_to_its_file(self):
        self._file("broken.heic", data=b"not an image")
        _, content, folder, rel = self._export([_msg(1, "", [_att(5, "broken.heic", "image/heic")])])
        self.assertTrue(os.path.isfile(os.path.join(folder, "5-broken.heic")))
        self.assertFalse(os.path.exists(os.path.join(folder, "5-broken.jpg")))
        self.assertIn(f'<a href="{rel}/5-broken.heic">[Image: broken.heic]</a>', content)
        self.assertNotIn("<img", content)

    def test_video_gets_a_player_and_a_link(self):
        clip = self._file("clip.mov")
        _, content, folder, rel = self._export([_msg(1, "", [_att(9, "clip.mov", "video/quicktime")])])
        with open(clip, "rb") as a, open(os.path.join(folder, "9-clip.mov"), "rb") as b:
            self.assertEqual(a.read(), b.read())
        self.assertIn(f'<video controls preload="metadata" src="{rel}/9-clip.mov#t=0.001"', content)
        self.assertIn(f'<a href="{rel}/9-clip.mov">clip.mov</a>', content)

    def test_video_without_a_mime_type_is_recognised_by_extension(self):
        self._file("old.mp4")
        _, content, _, rel = self._export([_msg(1, "", [_att(4, "old.mp4", None)])])
        self.assertIn(f'<video controls preload="metadata" src="{rel}/4-old.mp4#t=0.001"', content)

    def test_common_audio_plays_and_voice_messages_get_a_link(self):
        self._file("song.m4a")
        self._file("Audio Message.caf")
        _, content, folder, rel = self._export([_msg(1, "", [
            _att(6, "song.m4a", "audio/mp4"),
            _att(7, "Audio Message.caf", "audio/x-caf"),
        ])])
        self.assertIn(f'<audio controls preload="none" src="{rel}/6-song.m4a"', content)
        self.assertTrue(os.path.isfile(os.path.join(folder, "7-Audio Message.caf")))
        self.assertIn(f'<a href="{rel}/7-Audio%20Message.caf">[Audio: Audio Message.caf]</a>', content)
        self.assertEqual(content.count("<audio"), 1)

    def test_other_files_are_copied_and_linked(self):
        self._file("menu.pdf")
        _, content, folder, rel = self._export([_msg(1, "", [_att(11, "menu.pdf", "application/pdf")])])
        self.assertTrue(os.path.isfile(os.path.join(folder, "11-menu.pdf")))
        self.assertIn(f'<div class="attachment-label"><a href="{rel}/11-menu.pdf">[File: menu.pdf]</a></div>', content)

    def test_missing_attachment_gets_a_label_and_the_export_continues(self):
        result, content, folder, _ = self._export([
            _msg(1, "", [_att(4, "gone.heic", "image/heic")]),
            _msg(2, "still here"),
        ])
        self.assertEqual(result["message_count"], 2)
        self.assertIn("[Image not in this backup: gone.heic]", content)
        self.assertIn("still here", content)
        self.assertFalse(os.path.exists(folder))

    def test_messages_without_attachments_make_no_folder(self):
        _, _, folder, _ = self._export([_msg(1, "just text")])
        self.assertFalse(os.path.exists(folder))

    def test_same_attachment_twice_is_copied_once(self):
        self._file("dup.png", image="PNG")
        att = _att(12, "dup.png", "image/png")
        _, content, folder, rel = self._export([_msg(1, "", [att]), _msg(2, "", [att])])
        self.assertEqual(content.count(f'<img src="{rel}/12-dup.png"'), 2)
        self.assertEqual(os.listdir(folder), ["12-dup.png"])

    def test_saving_again_into_the_same_folder_works(self):
        self._file("again.png", image="PNG")
        messages = [_msg(1, "", [_att(13, "again.png", "image/png")])]
        _, first, folder, _ = self._export(messages)
        _, second, _, _ = self._export(messages)
        self.assertEqual(first, second)
        self.assertEqual(os.listdir(folder), ["13-again.png"])

    def test_names_sent_by_others_cannot_leave_the_folder_or_break_the_page(self):
        self._file("x.mov")
        att = _att(14, "x.mov", "video/mp4", transfer_name='..\\../evil <b>"x"?.mov')
        _, content, folder, rel = self._export([_msg(1, "", [att])])

        self.assertEqual(os.listdir(folder), ["14-evil _b_x_.mov"])
        self.assertEqual(sorted(os.listdir(self.out)), sorted([os.path.basename(folder), rel[:-len("_attachments")] + ".html"]))
        self.assertNotIn("<b>", content)
        self.assertIn(f'src="{rel}/14-evil%20_b_x_.mov#t=0.001"', content)
        self.assertIn("&lt;b&gt;&quot;x&quot;", content)

    def test_name_without_extension_takes_the_backup_files_extension(self):
        self._file("IMG_7.jpeg", image="JPEG")
        _, content, folder, rel = self._export([_msg(1, "", [_att(15, "IMG_7.jpeg", "image/jpeg", transfer_name="photo")])])
        self.assertEqual(os.listdir(folder), ["15-photo.jpeg"])
        self.assertIn(f'<img src="{rel}/15-photo.jpeg"', content)

    def test_each_conversation_saved_separately_gets_its_own_folder(self):
        self._file("a.png", image="PNG")
        self._file("b.png", image="PNG")
        by_chat = {
            1: [_msg(1, "", [_att(1, "a.png", "image/png")])],
            2: [_msg(2, "", [_att(2, "b.png", "image/png")])],
        }
        self.ext.get_messages = lambda backup, chat_id, *a, **k: {"messages": list(by_chat[chat_id]), "total": 1}
        result = self.ext.export_conversations(FakeBackup(self.files), [1, 2], {1: "Mom", 2: "Dad"}, {}, "html", self.out)
        self.assertEqual(len(result["files"]), 2)
        for page, name in zip(result["files"], ["1-a.png", "2-b.png"]):
            self.assertEqual(os.listdir(os.path.splitext(page)[0] + "_attachments"), [name])

    def test_merged_export_uses_a_folder_named_after_its_page(self):
        self._file("m.png", image="PNG")
        messages = [_msg(1, "hi", [_att(8, "m.png", "image/png")], conversation="Mom")]
        self.ext.get_messages = lambda *a, **k: {"messages": [dict(m) for m in messages], "total": 1}
        result = self.ext.export_conversations(FakeBackup(self.files), [1], {1: "Mom"}, {}, "html", self.out,
                                               mode="merged")
        with open(result["files"][0], encoding="utf-8") as f:
            content = f.read()
        self.assertIn('<img src="all_conversations_attachments/8-m.png"', content)
        self.assertTrue(os.path.isfile(os.path.join(self.out, "all_conversations_attachments", "8-m.png")))


if __name__ == "__main__":
    unittest.main()
