"""The People list's face thumbnails and the Photos grid's thumbnails (python/photos.py).

Face thumbnails: Photos keeps some faces without a box (centre 0, 0, size 0: a third of the
faces it picked in the public test backups); cutting one out gave a single-colour circle, so
those are skipped for the person's next face. Grid thumbnails: the iPhone's own thumbnail
(Media/PhotoData/Thumbnails/V2/<photo>/5005.JPG) is used when the backup has it, instead of
decoding the full-size original, which took a few hundred milliseconds a photo.
"""

import base64
import io
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from PIL import Image  # noqa: E402

import photos  # noqa: E402
from photos import MIN_FACE_CROP, PhotoExtractor, body_crop_box, choose_face, face_crop_box  # noqa: E402


def _jpeg(path: str, size: tuple, color=(200, 120, 40)) -> str:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    Image.new("RGB", size, color).save(path, "JPEG")
    return path


class FaceCropBox(unittest.TestCase):
    def test_twice_photos_box_from_the_bottom_left(self):
        # Centre (0.25, 0.25) from the bottom-left of 4000x3000 is (1000, 2250) from the top-left.
        self.assertEqual(face_crop_box(4000, 3000, 0.25, 0.25, 0.1), (700, 1950, 1300, 2550))

    def test_a_tiny_box_still_crops_a_readable_square(self):
        left, top, right, bottom = face_crop_box(4000, 3000, 0.5, 0.5, 0.001)
        self.assertEqual((right - left, bottom - top), (MIN_FACE_CROP, MIN_FACE_CROP))

    def test_the_square_stays_inside_a_small_photo(self):
        self.assertEqual(face_crop_box(80, 60, 0.9, 0.1, 0.001), (20, 0, 80, 60))


class FaceForThePeopleList(unittest.TestCase):
    STILLS = {"A": "hash-a", "B": "hash-b", "C": "hash-c"}
    POSTERS = {"V": "dcim:Media/PhotoData/Thumbnails/V2/DCIM/100APPLE/IMG_0009.MOV/5005.JPG"}

    @staticmethod
    def _row(face, uuid, size=0.0, x=0.0, y=0.0, body=None, video=False):
        bx, by, bw, bh = body or (None, None, None, None)
        return {"face": face, "asset_uuid": uuid, "video": video, "center_x": x, "center_y": y, "size": size,
                "body_x": bx, "body_y": by, "body_w": bw, "body_h": bh}

    def _choose(self, rows, key=None):
        return choose_face(rows, key, self.STILLS, self.POSTERS)

    def test_a_key_face_without_a_box_gives_way_to_the_next_face_with_one(self):
        rows = [self._row(1, "A"), self._row(2, "B", 0.12, 0.4, 0.6)]
        self.assertEqual(self._choose(rows, key=1), {"file_hash": "hash-b", "center_x": 0.4, "center_y": 0.6, "size": 0.12})

    def test_the_key_face_wins_over_a_bigger_one(self):
        rows = [self._row(1, "A", 0.05, 0.5, 0.5), self._row(2, "C", 0.3, 0.5, 0.5)]
        self.assertEqual(self._choose(rows, key=1)["file_hash"], "hash-a")
        self.assertEqual(self._choose(rows, key=None)["file_hash"], "hash-c")

    def test_someone_seen_only_from_behind_gets_their_body_box(self):
        rows = [self._row(1, "A", body=(0.6, 0.2, 0.19, 0.24)), self._row(2, "B", body=(0.4, 0.5, 0.05, 0.08))]
        face = self._choose(rows)
        self.assertEqual((face["file_hash"], face["size"], face["body"]),
                         ("hash-a", None, {"center_x": 0.6, "center_y": 0.2, "width": 0.19, "height": 0.24}))

    def test_someone_only_in_videos_gets_the_iphones_thumbnail_of_one(self):
        face = self._choose([self._row(1, "V", 0.2, 0.5, 0.5, video=True)])
        self.assertEqual((face["file_hash"], face["size"], face["poster"]), (self.POSTERS["V"], 0.2, True))
        bare = self._choose([self._row(1, "V", video=True)])
        self.assertEqual((bare["file_hash"], bare["size"], bare.get("body")), (self.POSTERS["V"], None, None))

    def test_a_face_on_a_photo_not_in_the_backup_or_a_video_without_a_thumbnail_isnt_used(self):
        self.assertIsNone(self._choose([self._row(1, "Z", 0.3, 0.5, 0.5), self._row(2, "W", 0.3, 0.5, 0.5, video=True)]))

    def test_a_body_box_crops_head_and_shoulders(self):
        # Body centred at (0.5, 0.5) from the bottom-left, 0.2 wide and 0.4 tall, on 1000x1000:
        # its top is at 300 from the top; the square is 1.1 x its width, from just above it.
        self.assertEqual(body_crop_box(1000, 1000, 0.5, 0.5, 0.2, 0.4), (390, 289, 610, 509))


class _EncryptedBackup:
    """Files by path, as an encrypted backup hands them out (decrypted to temp files)."""

    encrypted = True

    def __init__(self, files: dict):
        self.files = files

    def list_files(self, domain=None, path_like=None):
        prefix = (path_like or "").rstrip("%")
        return [{"path": p, "hash": f"id-{i}"} for i, p in enumerate(self.files) if p.startswith(prefix)]

    def get_file(self, relative_path, domain="HomeDomain"):
        return self.files.get(relative_path)


THUMBS = "Media/PhotoData/Thumbnails/V2/DCIM/100APPLE/"


@mock.patch.object(photos.backup_files, "is_stored", lambda backup, file_id: True)
class GridThumbnails(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.tmp = tempfile.mkdtemp()
        self.addCleanup(__import__("shutil").rmtree, self.tmp, True)

    def _thumb(self, backup, file_hash, size=200):
        return PhotoExtractor().get_thumbnail(backup, file_hash, size)

    def test_the_iphones_own_thumbnail_is_used_when_the_backup_has_it(self):
        backup = _EncryptedBackup({
            THUMBS + "IMG_0001.HEIC/5005.JPG": _jpeg(os.path.join(self.tmp, "t", "5005.jpg"), (360, 480)),
            # No original: had it been needed, the thumbnail would have failed.
        })
        result = self._thumb(backup, "dcim:Media/DCIM/100APPLE/IMG_0001.HEIC")
        image = Image.open(io.BytesIO(base64.b64decode(result["data"])))
        self.assertEqual((image.size, result["width"], result["height"]), ((150, 200), 150, 200))

    def test_the_biggest_numbered_thumbnail_wins(self):
        backup = _EncryptedBackup({
            THUMBS + "IMG_0001.HEIC/5003.JPG": _jpeg(os.path.join(self.tmp, "a", "5003.jpg"), (90, 120)),
            THUMBS + "IMG_0001.HEIC/5005.JPG": _jpeg(os.path.join(self.tmp, "b", "5005.jpg"), (360, 480)),
        })
        self.assertIn("data", self._thumb(backup, "dcim:Media/DCIM/100APPLE/IMG_0001.HEIC"))

    def test_a_thumbnail_smaller_than_asked_for_leaves_it_to_the_original(self):
        original = _jpeg(os.path.join(self.tmp, "o", "IMG_0001.JPG"), (1600, 1200), (10, 200, 10))
        backup = _EncryptedBackup({
            THUMBS + "IMG_0001.JPG/5003.JPG": _jpeg(os.path.join(self.tmp, "t", "5003.jpg"), (120, 90), (200, 10, 10)),
            "Media/DCIM/100APPLE/IMG_0001.JPG": original,
        })
        result = self._thumb(backup, "dcim:Media/DCIM/100APPLE/IMG_0001.JPG")
        image = Image.open(io.BytesIO(base64.b64decode(result["data"]))).convert("RGB")
        self.assertEqual(image.size, (200, 150))
        self.assertGreater(image.getpixel((100, 75))[1], 150)  # the original's green, not the thumbnail's red

    def test_videos_keep_their_play_tile(self):
        backup = _EncryptedBackup({
            THUMBS + "IMG_0002.MOV/5005.JPG": _jpeg(os.path.join(self.tmp, "t", "5005.jpg"), (480, 360)),
            "Media/DCIM/100APPLE/IMG_0002.MOV": os.path.join(self.tmp, "IMG_0002.MOV"),
        })
        open(backup.files["Media/DCIM/100APPLE/IMG_0002.MOV"], "wb").close()
        with mock.patch.object(backup, "get_file", wraps=backup.get_file) as get_file:
            self.assertEqual(self._thumb(backup, "dcim:Media/DCIM/100APPLE/IMG_0002.MOV").get("error"), "video")
        get_file.assert_not_called()  # known by its name: the video isn't copied out of the backup

    def test_an_unencrypted_backups_file_ids_find_the_thumbnail_too(self):
        class Unencrypted(_EncryptedBackup):
            encrypted = False
            backup_dir = self.tmp

        backup = Unencrypted({THUMBS + "IMG_0003.HEIC/5005.JPG": None})
        thumb_id = backup.list_files()[0]["hash"]
        _jpeg(os.path.join(self.tmp, thumb_id[:2], thumb_id), (480, 360))
        extractor = PhotoExtractor()
        with mock.patch.object(extractor, "_original_files",
                               return_value=({"Media/DCIM/100APPLE/IMG_0003.HEIC": "orig-id"}, frozenset())):
            result = extractor.get_thumbnail(backup, "orig-id", 200)
        self.assertEqual((result.get("width"), result.get("height")), (200, 150))


if __name__ == "__main__":
    unittest.main()
