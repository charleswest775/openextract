"""
attachment_files.py: what Messages' and WhatsApp's attachments share on their way to the app.

The adapters' own tests (test_messages_attachments.py, test_whatsapp_adapter.py)
drive these through get_attachment; these pin the pieces themselves.
"""

import base64
import io
import os
import sys
import tempfile
import unittest
from unittest import mock

from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import attachment_files as files  # noqa: E402


def _picture(fmt="JPEG", size=(120, 80), mode="RGB", colour=(10, 120, 200)):
    buf = io.BytesIO()
    Image.new(mode, size, colour).save(buf, fmt)
    return buf.getvalue()


class TestTypesAndNames(unittest.TestCase):

    def test_clean_mime(self):
        self.assertEqual(files.clean_mime("audio/ogg; codecs=opus"), "audio/ogg")
        self.assertEqual(files.clean_mime(" Image/HEIC "), "image/heic")
        self.assertEqual(files.clean_mime(None), "")
        self.assertEqual(files.clean_mime(b"image/jpeg"), "")  # not text: as if it weren't there

    def test_types_dont_depend_on_the_systems_own_table(self):
        with mock.patch("mimetypes.guess_type", return_value=(None, None)), \
                mock.patch("mimetypes.guess_extension", return_value=None):
            for name, mime in (("a.HEIC", "image/heic"), ("b.tif", "image/tiff"), ("c.caf", "audio/x-caf"),
                               ("d.MOV", "video/quicktime"), ("e.vcf", "text/vcard")):
                self.assertEqual(files.mime_for(name), mime, name)
            self.assertEqual(files.extension_for("image/tiff"), ".tiff")
            self.assertEqual(files.extension_for("video/quicktime; x=y"), ".mov")
            self.assertEqual(files.extension_for(""), "")

    def test_name_for_app(self):
        self.assertEqual(files.name_for_app("IMG_1.HEIC", "image/heic", "Attachment"), "IMG_1.HEIC")
        self.assertEqual(files.name_for_app("Invoice", "application/pdf", "Attachment"), "Invoice.pdf")
        self.assertEqual(files.name_for_app("Invoice", "application/x-msdownload", "Attachment"), "Invoice")
        self.assertEqual(files.name_for_app("", "image/jpeg", "Attachment"), "Attachment.jpg")
        self.assertEqual(files.name_for_app("x.thumb", "image/jpeg", "W", retype_extensions=(".thumb",)), "x.jpg")
        self.assertEqual(files.name_for_app("x.png", "image/jpeg", "W", retype=True), "x.jpg")
        self.assertEqual(files.name_for_app("../../etc/passwd", "text/plain", "Attachment"), "passwd.txt")

    def test_what_is_a_picture(self):
        for mime, name, want in (("image/jpeg", "", True), ("image/heic", "", True), ("image/svg+xml", "", False),
                                 ("video/quicktime", "a.jpg", False), ("", "a.PNG", True), ("", "a.pdf", False),
                                 (None, "noext", False)):
            self.assertIs(files.is_picture(mime, name), want, (mime, name))

    def test_what_is_sent_as_jpeg(self):
        for mime, name, want in (("image/heic", "", True), ("image/heif", "", True), ("image/tiff", "", True),
                                 ("", "scan.TIF", True), ("application/octet-stream", "IMG_1.HEIC", True),
                                 ("image/jpeg", "a.jpg", False), ("image/png", "", False), ("image/gif", "", False),
                                 ("image/jpeg", "misnamed.heic", False)):  # the type says: sent as it is
            self.assertIs(files.shows_as_jpeg(mime, name), want, (mime, name))


class TestPictures(unittest.TestCase):

    def test_thumbnail_from_bytes_or_a_path(self):
        data = _picture(size=(1000, 500))
        made = files.thumbnail(data)
        self.assertIsNotNone(made)
        jpeg, width, height = made
        self.assertEqual((width, height), (1000, 500))
        with Image.open(io.BytesIO(jpeg)) as img:
            self.assertEqual((img.format, img.size), ("JPEG", (400, 200)))
        with tempfile.NamedTemporaryFile(delete=False) as f:
            f.write(data)
        self.addCleanup(os.remove, f.name)
        self.assertEqual(files.thumbnail(f.name, max_px=100)[1:], (1000, 500))

    def test_the_colour_profile_is_kept_when_it_still_fits(self):
        from PIL import ImageCms
        profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
        buf = io.BytesIO()
        Image.new("RGB", (50, 50)).save(buf, "PNG", icc_profile=profile)
        jpeg = files.thumbnail(buf.getvalue())[0]
        with Image.open(io.BytesIO(jpeg)) as img:
            self.assertEqual(img.info.get("icc_profile"), profile)
        # A CMYK picture's profile doesn't describe the RGB JPEG made of it
        buf = io.BytesIO()
        Image.new("CMYK", (50, 50)).save(buf, "JPEG", icc_profile=b"not a CMYK profile, but CMYK all the same")
        with Image.open(io.BytesIO(files.thumbnail(buf.getvalue())[0])) as img:
            self.assertIsNone(img.info.get("icc_profile"))

    def test_what_cant_be_read(self):
        self.assertIsNone(files.thumbnail(b"not a picture"))
        self.assertIsNone(files.jpeg_copy(b"not a picture"))
        self.assertIsNone(files.thumbnail("/no/such/file.jpg"))

    def test_without_pillow(self):
        with mock.patch.object(files, "_pillow", return_value=None):
            self.assertIsNone(files.thumbnail(_picture()))


class TestThumbnailCache(unittest.TestCase):

    def test_least_recently_used_goes_first(self):
        cache = files.ThumbnailCache(size=2)
        cache.put("a", {"data": "A"})
        cache.put("b", {"data": "B"})
        self.assertEqual(cache.get("a"), {"data": "A"})  # now the most recent
        cache.put("c", {"data": "C"})
        self.assertIsNone(cache.get("b"))
        self.assertEqual((cache.get("a"), cache.get("c"), len(cache)), ({"data": "A"}, {"data": "C"}, 2))
        cache.clear()
        self.assertEqual(len(cache), 0)

    def test_answers_are_copies(self):
        cache = files.ThumbnailCache()
        value = {"data": "A"}
        cache.put("a", value)
        value["data"] = "changed"
        got = cache.get("a")
        got["data"] = "changed too"
        self.assertEqual(cache.get("a"), {"data": "A"})

    def test_default_size(self):
        cache = files.ThumbnailCache()
        for n in range(files.THUMBNAIL_CACHE_SIZE + 5):
            cache.put(n, {"n": n})
        self.assertEqual(len(cache), files.THUMBNAIL_CACHE_SIZE)
        self.assertIsNone(cache.get(0))


class TestAnswers(unittest.TestCase):

    def file(self, data):
        f = tempfile.NamedTemporaryFile(delete=False)
        f.write(data)
        f.close()
        self.addCleanup(os.remove, f.name)
        return f.name

    def test_inline_without_converting(self):
        """A WhatsApp thumbnail is already a JPEG, whatever the photo's type."""
        raw = b"stored thumbnail bytes"
        result = files.inline_answer(self.file(raw), "image/heic", "x.heic", len(raw), convert=False)
        self.assertEqual(base64.b64decode(result["data"]), raw)
        self.assertEqual(result["mime_type"], "image/heic")

    def test_inline_file_that_cant_be_read(self):
        result = files.inline_answer("/no/such/file", "video/mp4", "clip.mp4", 10)
        self.assertEqual(result, {"error": files.FILE_UNREADABLE})

    def test_copy_that_fails(self):
        class Copies:
            def copy(self, *args):
                raise PermissionError("denied")

        self.assertEqual(files.copy_for_app(Copies(), "/x", ("u", 1), "a.jpg"), {"error": files.FILE_NOT_COPIED})


if __name__ == "__main__":
    unittest.main()
