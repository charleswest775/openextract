"""
Tests for the print-ready HTML behind the PDF export (GitHub issue #91), and
for the one-line footer on HTML exports.

Electron renders the ``pdf_source`` HTML to PDF; these tests cover the part
Python owns: images written next to the HTML and drawn inline, labels for
everything else, and nothing failing when an attachment is missing.
"""

import os
import re
import sys
import tempfile
import unittest

from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from messages import (  # noqa: E402
    EXPORT_FOOTER_HTML,
    PDF_IMAGE_MAX_PX,
    MessageExtractor,
    _PrintAttachmentWriter,
)

FOOTER_TEXT = "Made with OpenExtract, free at"


class FakeBackup:
    """Maps sms.db attachment paths (without ~/) to files on disk."""

    def __init__(self, files: dict):
        self.files = files
        self.lookups = []

    def get_file(self, relative_path, domain="HomeDomain"):
        self.lookups.append((relative_path, domain))
        if domain != "MediaDomain":
            return None
        return self.files.get(relative_path)


def _att(attachment_id, filename, mime_type, transfer_name=None):
    return {
        "attachment_id": attachment_id,
        "filename": filename,
        "mime_type": mime_type,
        "transfer_name": transfer_name if transfer_name is not None else os.path.basename(filename),
        "total_bytes": 0,
    }


def _msg(message_id, text="", attachments=None, is_from_me=False, conversation=None):
    msg = {
        "message_id": message_id,
        "date": "2026-01-01T09:00:00+00:00",
        "text": text,
        "sender": "me" if is_from_me else "Alice",
        "is_from_me": is_from_me,
        "has_attachments": bool(attachments),
        "attachments": attachments or [],
    }
    if conversation is not None:
        msg["_conversation"] = conversation
    return msg


class TestPdfSourceExport(unittest.TestCase):

    def setUp(self):
        self.ext = MessageExtractor.__new__(MessageExtractor)
        self.src_dir = tempfile.TemporaryDirectory()
        self.out_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.src_dir.cleanup)
        self.addCleanup(self.out_dir.cleanup)

    def _image(self, name, size=(40, 30), mode="RGB", fmt="PNG"):
        path = os.path.join(self.src_dir.name, name)
        color = (10, 120, 200, 128) if mode == "RGBA" else (10, 120, 200)
        Image.new(mode, size, color).save(path, fmt)
        return path

    def _export(self, messages, backup, display_name="Mom"):
        writer = _PrintAttachmentWriter(self.ext, backup, self.out_dir.name)
        result = self.ext._export_html(messages, 7, self.out_dir.name, display_name,
                                       attachments=writer)
        with open(result["file"], encoding="utf-8") as f:
            return result, f.read(), writer

    def test_image_is_drawn_inline_with_relative_src(self):
        png = self._image("IMG_0001.png")
        backup = FakeBackup({"Library/SMS/Attachments/ab/IMG_0001.png": png})
        messages = [_msg(1, "look", [_att(55, "~/Library/SMS/Attachments/ab/IMG_0001.png", "image/png")])]

        _, content, writer = self._export(messages, backup)

        self.assertIn('<img src="attachments/55.jpg" alt="IMG_0001.png">', content)
        self.assertIn('<div class="text">look</div>', content)
        self.assertTrue(os.path.isfile(os.path.join(self.out_dir.name, "attachments", "55.jpg")))
        self.assertEqual(writer.images_written, 1)
        self.assertEqual(writer.images_missing, 0)

    def test_large_image_is_scaled_down_and_transparent_one_flattened(self):
        png = self._image("big.png", size=(PDF_IMAGE_MAX_PX * 2, 100), mode="RGBA")
        backup = FakeBackup({"Library/SMS/Attachments/big.png": png})
        self._export([_msg(1, "", [_att(9, "~/Library/SMS/Attachments/big.png", "image/png")])], backup)

        with Image.open(os.path.join(self.out_dir.name, "attachments", "9.jpg")) as img:
            self.assertEqual(img.format, "JPEG")
            self.assertEqual(img.mode, "RGB")
            self.assertLessEqual(max(img.size), PDF_IMAGE_MAX_PX)

    def test_image_without_mime_type_is_recognised_by_extension(self):
        jpg = self._image("old.jpeg", fmt="JPEG")
        backup = FakeBackup({"Library/SMS/Attachments/old.jpeg": jpg})
        _, content, _ = self._export([_msg(1, "", [_att(3, "~/Library/SMS/Attachments/old.jpeg", None)])], backup)
        self.assertIn('<img src="attachments/3.jpg"', content)

    def test_missing_image_gets_a_label_and_the_export_continues(self):
        backup = FakeBackup({})
        messages = [
            _msg(1, "", [_att(4, "~/Library/SMS/Attachments/gone.heic", "image/heic")]),
            _msg(2, "still here"),
        ]
        result, content, writer = self._export(messages, backup)

        self.assertEqual(result["message_count"], 2)
        self.assertIn("[Image not in this backup: gone.heic]", content)
        self.assertIn("still here", content)
        self.assertNotIn("<img", content)
        self.assertEqual(writer.images_missing, 1)

    def test_unreadable_image_gets_a_label(self):
        bad = os.path.join(self.src_dir.name, "broken.jpg")
        with open(bad, "wb") as f:
            f.write(b"not an image")
        backup = FakeBackup({"Library/SMS/Attachments/broken.jpg": bad})
        _, content, _ = self._export([_msg(1, "", [_att(5, "~/Library/SMS/Attachments/broken.jpg", "image/jpeg")])], backup)
        self.assertIn("[Image not in this backup: broken.jpg]", content)
        self.assertFalse(os.path.exists(os.path.join(self.out_dir.name, "attachments", "5.jpg")))

    def test_video_audio_and_files_get_labels_without_lookups(self):
        backup = FakeBackup({})
        messages = [_msg(1, "", [
            _att(1, "~/a/clip.mov", "video/quicktime"),
            _att(2, "~/a/memo.caf", "audio/x-caf"),
            _att(3, "~/a/doc.pdf", "application/pdf"),
        ])]
        _, content, _ = self._export(messages, backup)
        self.assertIn("[Video: clip.mov]", content)
        self.assertIn("[Audio: memo.caf]", content)
        self.assertIn("[File: doc.pdf]", content)
        self.assertEqual(backup.lookups, [])

    def test_same_image_twice_is_written_once(self):
        png = self._image("dup.png")
        backup = FakeBackup({"Library/SMS/Attachments/dup.png": png})
        att = _att(12, "~/Library/SMS/Attachments/dup.png", "image/png")
        _, content, writer = self._export([_msg(1, "", [att]), _msg(2, "", [att])], backup)
        self.assertEqual(content.count('src="attachments/12.jpg"'), 2)
        self.assertEqual(writer.images_written, 1)

    def test_attachment_names_are_escaped(self):
        backup = FakeBackup({})
        messages = [_msg(1, "", [_att(1, "~/a/x.mov", "video/mp4", transfer_name='<b>"x".mov')])]
        _, content, _ = self._export(messages, backup)
        self.assertNotIn("<b>", content)
        self.assertIn("&lt;b&gt;&quot;x&quot;.mov", content)

    def test_merged_pdf_source_draws_images(self):
        png = self._image("m.png")
        backup = FakeBackup({"Library/SMS/Attachments/m.png": png})
        writer = _PrintAttachmentWriter(self.ext, backup, self.out_dir.name)
        messages = [_msg(1, "hi", [_att(8, "~/Library/SMS/Attachments/m.png", "image/png")], conversation="Mom")]
        result = self.ext._export_merged_html(messages, self.out_dir.name, attachments=writer)
        with open(result["files"][0], encoding="utf-8") as f:
            content = f.read()
        self.assertIn('<img src="attachments/8.jpg"', content)
        self.assertIn(FOOTER_TEXT, content)


class TestExportConversationDispatch(unittest.TestCase):
    """``export_conversation(fmt="pdf_source")`` routes through the HTML export."""

    def test_pdf_source_format_writes_html_with_images(self):
        ext = MessageExtractor.__new__(MessageExtractor)
        with tempfile.TemporaryDirectory() as src, tempfile.TemporaryDirectory() as out:
            png = os.path.join(src, "a.png")
            Image.new("RGB", (10, 10)).save(png)
            backup = FakeBackup({"Library/SMS/Attachments/a.png": png})
            messages = [_msg(1, "", [_att(21, "~/Library/SMS/Attachments/a.png", "image/png")])]
            ext.get_messages = lambda *a, **k: {"messages": list(messages), "total": 1}

            result = ext.export_conversation(backup, 1, {}, "pdf_source", out, display_name="Mom")

            self.assertTrue(result["file"].endswith(".html"))
            with open(result["file"], encoding="utf-8") as f:
                self.assertIn('<img src="attachments/21.jpg"', f.read())

    def test_unknown_format_is_still_an_error(self):
        ext = MessageExtractor.__new__(MessageExtractor)
        ext.get_messages = lambda *a, **k: {"messages": [], "total": 0}
        with tempfile.TemporaryDirectory() as out:
            result = ext.export_conversation(FakeBackup({}), 1, {}, "pdf", out)
        self.assertIn("error", result)


class TestHtmlExportLabelsAttachments(unittest.TestCase):
    """The plain HTML export names attachments but draws no images (that's #83)."""

    def test_attachment_only_message_is_labelled_not_drawn(self):
        ext = MessageExtractor.__new__(MessageExtractor)
        with tempfile.TemporaryDirectory() as tmp:
            messages = [_msg(1, "", [_att(1, "~/a/IMG.png", "image/png")])]
            result = ext._export_html(messages, 1, tmp, "Mom")
            with open(result["file"], encoding="utf-8") as f:
                content = f.read()
            self.assertIn('<div class="msg received"><div class="attachment-label">[Image: IMG.png]</div></div>',
                          content)
            self.assertNotIn("[Attachment]", content)
            self.assertNotIn("<img", content)
            self.assertFalse(os.path.exists(os.path.join(tmp, "attachments")))


class TestExportFooter(unittest.TestCase):

    def setUp(self):
        self.ext = MessageExtractor.__new__(MessageExtractor)

    def test_footer_is_one_line_with_link(self):
        self.assertEqual(EXPORT_FOOTER_HTML.count("\n"), 1)
        self.assertIn(FOOTER_TEXT, EXPORT_FOOTER_HTML)
        self.assertIn('href="https://www.openextract.app"', EXPORT_FOOTER_HTML)
        self.assertIn(">openextract.app</a>", EXPORT_FOOTER_HTML)

    def test_footer_appears_once_at_the_end_of_html_exports(self):
        with tempfile.TemporaryDirectory() as tmp:
            single = self.ext._export_html([_msg(1, "hi")], 1, tmp, "Mom")["file"]
            merged = self.ext._export_merged_html([_msg(1, "hi", conversation="Mom")], tmp)["files"][0]
            for path in (single, merged):
                with open(path, encoding="utf-8") as f:
                    content = f.read()
                self.assertEqual(content.count(FOOTER_TEXT), 1, path)
                self.assertTrue(re.search(r"</footer>\s*</body></html>$", content), path)

    def test_text_and_csv_exports_have_no_footer(self):
        with tempfile.TemporaryDirectory() as tmp:
            for fmt in ("txt", "csv"):
                path = getattr(self.ext, f"_export_{fmt}")([_msg(1, "hi")], 1, tmp, "Mom")["file"]
                with open(path, encoding="utf-8-sig") as f:
                    self.assertNotIn("OpenExtract", f.read(), fmt)


if __name__ == "__main__":
    unittest.main()
