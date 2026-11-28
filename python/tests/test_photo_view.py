"""
get_photo (python/photos.py): what the photo viewer is handed is something it can show.

The viewer is a Chromium <img>, which can't show HEIC. get_photo turns an iPhone photo into
a JPEG with Pillow (pillow-heif reads HEIC). When Pillow couldn't decode it (pillow-heif
missing from a build, or a HEIC it can't read), get_photo dropped the reason and handed
the viewer the raw HEIC as image/heic: the viewer stayed blank and nothing was said, and the
engine's diagnostics showed the call as answered (OE-206, Windows, 0.20.0). Now a photo it
can't turn into something viewable comes back as a plain error the viewer shows.

These build a small stand-in backup folder (a Manifest.db and hash-named files), like
test_photo_open.py.
"""

import base64
import io
import os
import sys
import tempfile
import unittest
from unittest import mock

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, ".."))
sys.path.insert(0, HERE)
import photos  # noqa: E402
from photos import PhotoExtractor  # noqa: E402
from test_photo_open import VIDEO, Backup  # noqa: E402

try:
    from PIL import Image
    import pillow_heif
    pillow_heif.register_heif_opener()
except ImportError:  # pragma: no cover - both are in requirements.txt
    Image = None


def heic_bytes():
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (200, 30, 30)).save(buf, format="HEIF")
    return buf.getvalue()


def jpeg_bytes():
    buf = io.BytesIO()
    Image.new("RGB", (64, 48), (30, 200, 30)).save(buf, format="JPEG")
    return buf.getvalue()


# A HEIC's header with nothing a decoder can read after it: a damaged file, or one in a
# form this build's pillow-heif doesn't know.
DAMAGED_HEIC = b"\x00\x00\x00\x18ftypheic\x00\x00\x00\x00mif1heic" + b"\x00" * 64

# What Chromium can draw in an <img>.
VIEWABLE = {"image/jpeg", "image/png", "image/gif", "image/webp"}


@unittest.skipIf(Image is None, "Pillow and pillow-heif are needed")
class TestPhotoView(unittest.TestCase):

    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.backup = Backup(folder.name)
        self.photos = PhotoExtractor()

    def test_a_heic_comes_back_as_a_jpeg(self):
        fid = self.backup.add("Media/DCIM/100APPLE/IMG_0001.HEIC", data=heic_bytes())

        got = self.photos.get_photo(self.backup, fid)

        self.assertNotIn("error", got)
        self.assertEqual(got["mime_type"], "image/jpeg")
        self.assertTrue(base64.b64decode(got["data"]).startswith(b"\xff\xd8\xff"))

    def test_a_heic_pillow_cant_decode_says_so_instead_of_going_blank(self):
        fid = self.backup.add("Media/DCIM/100APPLE/IMG_0002.HEIC", data=heic_bytes())

        # As in a build without pillow-heif: Pillow doesn't know the format.
        with mock.patch.object(photos.Image, "open", side_effect=OSError("cannot identify image file")):
            got = self.photos.get_photo(self.backup, fid)

        self.assertNotEqual(got.get("mime_type"), "image/heic", "never raw HEIC to the viewer")
        self.assertIn("error", got)
        self.assertIn("couldn't be shown", got["error"])
        self.assertIn("Save", got["error"], "says the original can still be saved")

    def test_a_damaged_heic_says_so_instead_of_going_blank(self):
        fid = self.backup.add("Media/DCIM/100APPLE/IMG_0003.HEIC", data=DAMAGED_HEIC)

        got = self.photos.get_photo(self.backup, fid)

        self.assertNotEqual(got.get("mime_type"), "image/heic")
        self.assertIn("error", got)
        self.assertIn("couldn't be shown", got["error"])

    def test_without_pillow_a_heic_says_so(self):
        fid = self.backup.add("Media/DCIM/100APPLE/IMG_0004.HEIC", data=heic_bytes())

        with mock.patch.object(photos, "HAS_PIL", False):
            got = self.photos.get_photo(self.backup, fid)

        self.assertIn("error", got)
        self.assertNotEqual(got.get("mime_type"), "image/heic")

    def test_the_reason_is_logged(self):
        fid = self.backup.add("Media/DCIM/100APPLE/IMG_0005.HEIC", data=heic_bytes())

        err = io.StringIO()
        with mock.patch.object(photos.Image, "open", side_effect=OSError("cannot identify image file")), \
                mock.patch.object(sys, "stderr", err):
            self.photos.get_photo(self.backup, fid)

        self.assertIn("cannot identify image file", err.getvalue())

    def test_a_jpeg_still_shows_when_pillow_cant_read_it(self):
        # The viewer draws a JPEG itself, so those bytes are still worth handing over.
        fid = self.backup.add("Media/DCIM/100APPLE/IMG_0006.JPG", data=jpeg_bytes())

        with mock.patch.object(photos.Image, "open", side_effect=OSError("broken")):
            got = self.photos.get_photo(self.backup, fid)

        self.assertNotIn("error", got)
        self.assertEqual(got["mime_type"], "image/jpeg")
        self.assertIn(got["mime_type"], VIEWABLE)

    def test_a_video_still_comes_back_as_its_bytes(self):
        fid = self.backup.add("Media/DCIM/100APPLE/IMG_0007.MOV", data=VIDEO)

        got = self.photos.get_photo(self.backup, fid)

        self.assertNotIn("error", got)
        self.assertEqual(got["mime_type"], "video/mp4")


if __name__ == "__main__":
    unittest.main()
