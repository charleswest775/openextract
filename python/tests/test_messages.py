"""
Tests for messages.py — MessageExtractor

Tests focus on the get_video_frame_as_b64_jpg method which extracts
the first frame from video data and returns it as base64-encoded JPEG.
"""

import base64
import hashlib
import os
import unittest

from messages import MessageExtractor  # noqa: E402


# ---------------------------------------------------------------------------
# Test: get_video_frame_as_b64_jpg
# ---------------------------------------------------------------------------

class TestGetVideoFrameAsB64Jpg(unittest.TestCase):

    def setUp(self):
        self.extractor = MessageExtractor()
        # Reset mock calls before each test

        self.MOV_FILE = os.path.join(os.path.dirname(__file__), "IMG_1062.MOV")
        #self.B64_FILE = os.path.join(os.path.dirname(__file__), "movie-data.txt")

    def test_accepts_bytes_input(self):
        """Function should accept raw bytes as input."""
        with open(self.MOV_FILE, "rb") as f:
            video_data = f.read()

        result = self.extractor.get_video_frame_as_b64_jpg(video_data)

        # Should return a string (base64 encoded)
        self.assertIsInstance(result, str)
        # Should be valid base64
        try:
            base64.b64decode(result)
        except Exception:
            self.fail("Result should be valid base64")

    def test_accepts_base64_string_input(self):
        """Function should accept base64-encoded string as input."""
        with open(self.MOV_FILE, "rb") as f:
            video_data = f.read()
        b64_string = base64.b64encode(video_data).decode('ascii')

        result = self.extractor.get_video_frame_as_b64_jpg(b64_string)

        # Should return a string (base64 encoded)
        self.assertIsInstance(result, str)
        # Should be valid base64
        try:
            base64.b64decode(result)
        except Exception:
            self.fail("Result should be valid base64")

    def test_invalid_input_type_raises(self):
        """Function should raise ValueError for non-bytes/non-string input."""
        with self.assertRaises(ValueError):
            self.extractor.get_video_frame_as_b64_jpg(123)

    def test_invalid_input_string_raises(self):
        """Function should raise ValueError for bad (not b64 encoded) string input."""
        with self.assertRaises(ValueError):
            self.extractor.get_video_frame_as_b64_jpg("123")

    def test_invalid_bytes_data_raises(self):
        """Function should raise ValueError for non-video bytes input."""
        with self.assertRaises(Warning):
            self.extractor.get_video_frame_as_b64_jpg(b'agdfgdfg')


    def test_extract_frame_from_real_video(self):
        """Integration test: extract first frame from actual MOV file."""
        import os

        video_path = self.MOV_FILE

        if not os.path.exists(video_path):
            self.skipTest(f"Video file not found: {video_path}")

        # Read actual video file
        with open(video_path, "rb") as f:
            video_data = f.read()

        #write to text file for comparison with known text file
        #with open(os.path.join(self.B64_FILE), "w") as f:
        #    f.write(base64.b64encode(video_data).decode('ascii'))

        result = self.extractor.get_video_frame_as_b64_jpg(video_data)

        # Verify result is valid base64
        self.assertIsInstance(result, str, "Result of video frame extration should be a base64 string")
        try:
            decoded = base64.b64decode(result)
            # Should be non-empty JPEG data
            self.assertGreater(len(decoded), 100)
            # JPEG files start with FF D8
            self.assertEqual(decoded[0:2], b'\xff\xd8')
        except Exception as e:
            self.fail(f"Result should be valid non-empty JPEG: {e}")

        # check md5sum for decoded
        md5sum = hashlib.md5(decoded).hexdigest()
        self.assertEqual(md5sum, "3b1fa7705a2e1b6b10b86669c264cc95",
                         "MD5 sum of extracted video frame should match the known target MD5 sum")

        with open(os.path.join(os.path.dirname(__file__), "frame--IMG_1062.jpg"), "wb") as f:
            f.write(decoded)


if __name__ == "__main__":
    unittest.main()
