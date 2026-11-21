"""
get_attachment and the attachment fields of get_messages (python/messages.py): Messages' files for the app.

The app shows Messages' photos and videos the way it shows WhatsApp's
(test_whatsapp_adapter.py): a small JPEG thumbnail for a bubble or a card, the
whole file as base64 (HEIC and TIFF photos as JPEG), "too large" for a file
that shouldn't travel in one JSON-RPC line, and a copy named with its real
extension to open or play. get_messages says, for each attachment, whether
its file is in the backup, so the app never asks for one that isn't. These
tests build a small unencrypted backup folder (Manifest.db, files stored under
their fileIDs, an sms.db) and open it the way the engine does.
"""

import base64
import contextlib
import hashlib
import io
import os
import sqlite3
import sys
import tempfile
import unittest
from unittest import mock

from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import app_copies  # noqa: E402
import attachment_files  # noqa: E402
import messages  # noqa: E402
from backup import OpenBackup  # noqa: E402
from messages import MessageExtractor  # noqa: E402
from year_counts import YearCounter  # noqa: E402

UDID = "00008120-0000000000000042"
NOT_IN_BACKUP = {"error": "This file isn't in the backup", "empty_reason": "not_in_backup"}
JPEG_MAGIC = b"\xff\xd8\xff"

SMS_TABLES = """
CREATE TABLE handle (ROWID INTEGER PRIMARY KEY, id TEXT);
CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, display_name TEXT);
CREATE TABLE chat_handle_join (chat_id INTEGER, handle_id INTEGER);
CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT, date INTEGER, is_from_me INTEGER,
                      handle_id INTEGER, cache_has_attachments INTEGER, associated_message_type INTEGER);
CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
CREATE TABLE message_attachment_join (message_id INTEGER, attachment_id INTEGER);
INSERT INTO handle VALUES (1, '+15035550101');
INSERT INTO chat VALUES (1, '+15035550101', '');
INSERT INTO chat_handle_join VALUES (1, 1);
"""
# iOS 26's columns that matter here, and an old sms.db's (iOS 6), which has none of the extras.
ATTACHMENT_TABLE = ("CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT, "
                    "transfer_name TEXT, total_bytes INTEGER, uti TEXT, is_sticker INTEGER)")
OLD_ATTACHMENT_TABLE = "CREATE TABLE attachment (ROWID INTEGER PRIMARY KEY, filename TEXT, mime_type TEXT)"


def picture(fmt="JPEG", size=(1600, 1200), colour=(10, 120, 200), mode="RGB", orientation=None, **save):
    """A picture's bytes; ``orientation`` writes an EXIF orientation tag."""
    img = Image.new(mode, size, colour)
    if orientation:
        exif = Image.Exif()
        exif[0x0112] = orientation
        save["exif"] = exif.tobytes()
    buf = io.BytesIO()
    img.save(buf, fmt, **save)
    return buf.getvalue()


def heic(size=(64, 48)):
    try:
        import pillow_heif
        pillow_heif.register_heif_opener()
        return picture("HEIF", size)
    except Exception as e:  # no HEIF encoder in this Pillow build
        raise unittest.SkipTest(f"can't write a HEIC here: {e}")


def decoded(result):
    assert "data" in result, result
    return base64.b64decode(result["data"], validate=True)


class BackupFolder:
    """An unencrypted backup folder: Manifest.db, files under their fileIDs, sms.db with one conversation."""

    def __init__(self, root, old_schema=False):
        self.dir = os.path.join(root, UDID)
        os.makedirs(self.dir)
        self.old_schema = old_schema
        self.listed = []        # (fileID, domain, relativePath)
        self.attachments = []   # sms.db attachment rows
        self.with_sms_db = True

    def store(self, domain, rel, data, stored=True):
        file_id = hashlib.sha1(f"{domain}-{rel}".encode()).hexdigest()
        self.listed.append((file_id, domain, rel))
        if stored:
            os.makedirs(os.path.join(self.dir, file_id[:2]), exist_ok=True)
            with open(os.path.join(self.dir, file_id[:2], file_id), "wb") as f:
                f.write(data)
        return file_id

    def attach(self, rowid, name, data=None, mime="image/jpeg", *, stored=True, listed=True, domain="MediaDomain",
               prefix="~/", transfer_name=None, uti=None, sticker=0, total_bytes=None, filename=...):
        """An attachment of message ``rowid`` (one message each); its file in the backup unless told otherwise."""
        rel = f"Library/SMS/Attachments/{rowid % 100:02x}/{rowid:02d}/GUID-{rowid}/{name}"
        if data is not None and listed:
            self.store(domain, rel, data, stored)
        if filename is ...:
            filename = prefix + rel
        size = total_bytes if total_bytes is not None else (len(data) if data is not None else None)
        self.attachments.append((rowid, filename, mime, transfer_name if transfer_name is not None else name,
                                 size, uti, sticker))
        return rel

    def open(self) -> OpenBackup:
        if self.with_sms_db:
            sms_path = os.path.join(self.dir, "sms.db.tmp")
            conn = sqlite3.connect(sms_path)
            conn.executescript(SMS_TABLES)
            conn.execute(OLD_ATTACHMENT_TABLE if self.old_schema else ATTACHMENT_TABLE)
            for rowid, filename, mime, transfer_name, size, uti, sticker in self.attachments:
                conn.execute("INSERT INTO message VALUES (?, '', ?, 0, 1, 1, 0)", (rowid, 700000000 + rowid))
                conn.execute("INSERT INTO chat_message_join VALUES (1, ?)", (rowid,))
                conn.execute("INSERT INTO message_attachment_join VALUES (?, ?)", (rowid, rowid))
                if self.old_schema:
                    conn.execute("INSERT INTO attachment VALUES (?, ?, ?)", (rowid, filename, mime))
                else:
                    conn.execute("INSERT INTO attachment VALUES (?, ?, ?, ?, ?, ?, ?)",
                                 (rowid, filename, mime, transfer_name, size, uti, sticker))
            conn.commit()
            conn.close()
            with open(sms_path, "rb") as f:
                self.store("HomeDomain", "Library/SMS/sms.db", f.read())
            os.remove(sms_path)
        manifest = sqlite3.connect(os.path.join(self.dir, "Manifest.db"))
        manifest.executescript("""
            CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB);
            CREATE INDEX FilesDomainIdx ON Files(domain);
            CREATE INDEX FilesRelativePathIdx ON Files(relativePath);
        """)
        manifest.executemany("INSERT INTO Files VALUES (?, ?, ?, 1, NULL)", self.listed)
        manifest.commit()
        manifest.close()
        return OpenBackup(self.dir, UDID, {}, False)


class Case(unittest.TestCase):

    def setUp(self):
        root = tempfile.TemporaryDirectory()
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(root.cleanup)
        self.addCleanup(temp.cleanup)
        # Point the system temp folder at our own, so copies and the stale-folder sweep stay in it.
        saved = tempfile.tempdir
        tempfile.tempdir = temp.name
        self.addCleanup(setattr, tempfile, "tempdir", saved)
        self.temp = temp.name
        self.folder = BackupFolder(root.name)
        self.ext = MessageExtractor()
        self._backup = None

    def old_schema(self):
        self.folder.old_schema = True

    @property
    def backup(self) -> OpenBackup:
        if self._backup is None:
            self._backup = self.folder.open()
            self.addCleanup(self._backup.close)
            self.addCleanup(self.ext._inner.close)
        return self._backup

    def get(self, attachment_id, **flags):
        return self.ext.get_attachment(self.backup, attachment_id, **flags)

    def page(self, limit=100):
        return self.ext.get_messages(self.backup, 1, {}, 0, limit)["messages"]

    def attachment(self, rowid):
        return next(a for m in self.page() for a in m["attachments"] if a["attachment_id"] == rowid)


# ── Default: the file as base64 ──────────────────────────────────────────────

class TestWholeFile(Case):

    def test_a_jpeg_comes_byte_for_byte(self):
        data = picture()
        self.folder.attach(1, "IMG_0001.jpeg", data)
        result = self.get(1)
        self.assertEqual(decoded(result), data)
        self.assertEqual((result["mime_type"], result["filename"], result["size"]),
                         ("image/jpeg", "IMG_0001.jpeg", len(data)))

    def test_other_files_come_as_they_are(self):
        files = {
            2: ("Plans.pdf", b"%PDF-1.4 fake", "application/pdf"),
            3: ("Audio Message.caf", b"caff" + os.urandom(200), "audio/x-caf"),
            4: ("clip.MOV", os.urandom(500), "video/quicktime"),
            5: ("drawing.png", picture("PNG", (30, 20), mode="RGBA", colour=(1, 2, 3, 0)), "image/png"),
            6: ("Riley.vcf", b"BEGIN:VCARD\r\nEND:VCARD\r\n", "text/vcard"),
        }
        for rowid, (name, data, mime) in files.items():
            self.folder.attach(rowid, name, data, mime)
        for rowid, (name, data, mime) in files.items():
            with self.subTest(name):
                result = self.get(rowid)
                self.assertEqual(decoded(result), data)
                self.assertEqual((result["mime_type"], result["filename"], result["size"]), (mime, name, len(data)))

    def test_the_name_it_was_sent_with(self):
        self.folder.attach(1, "IMG_0001.jpeg", picture(), transfer_name="Birthday.jpeg")
        self.assertEqual(self.get(1)["filename"], "Birthday.jpeg")

    def test_an_old_sms_db_without_types_or_names(self):
        """iOS 6's sms.db has no transfer_name or total_bytes, and often no mime_type: the name says."""
        self.old_schema()
        data = picture()
        self.folder.attach(1, "IMG_0042.JPG", data, mime=None)
        self.folder.attach(2, "notes.pdf", b"%PDF-1.4", mime=None)
        self.folder.attach(3, "noext", b"?", mime=None)
        result = self.get(1)
        self.assertEqual(decoded(result), data)
        self.assertEqual((result["mime_type"], result["filename"], result["size"]), ("image/jpeg", "IMG_0042.JPG", len(data)))
        self.assertEqual(self.get(2)["mime_type"], "application/pdf")
        self.assertEqual(self.get(3)["mime_type"], "application/octet-stream")

    def test_mime_type_parameters_and_case_are_dropped(self):
        self.folder.attach(1, "a.jpeg", picture(), mime="Image/JPEG; foo=bar")
        self.assertEqual(self.get(1)["mime_type"], "image/jpeg")

    def test_heic_comes_as_jpeg(self):
        self.folder.attach(1, "IMG_0001.HEIC", heic(), mime="image/heic")
        result = self.get(1)
        self.assertEqual(result["mime_type"], "image/jpeg")
        self.assertEqual(result["filename"], "IMG_0001.HEIC")
        with Image.open(io.BytesIO(decoded(result))) as img:
            self.assertEqual((img.format, img.size), ("JPEG", (64, 48)))

    def test_tiff_comes_as_an_upright_jpeg_no_bigger_than_the_cap(self):
        # 300 x 100 stored, turned a quarter turn by its EXIF orientation: shown 100 wide, 300 tall
        self.folder.attach(1, "scan.tiff", picture("TIFF", (300, 100), orientation=6), mime="image/tiff")
        with mock.patch.object(attachment_files, "JPEG_MAX_PX", 150):
            result = self.get(1)
        self.assertEqual(result["mime_type"], "image/jpeg")
        with Image.open(io.BytesIO(decoded(result))) as img:
            self.assertEqual(img.size, (50, 150))

    def test_a_photo_that_cant_be_converted_comes_as_it_is(self):
        self.folder.attach(1, "broken.heic", b"not a photo at all", mime="image/heic")
        result = self.get(1)
        self.assertEqual((decoded(result), result["mime_type"]), (b"not a photo at all", "image/heic"))

    def test_too_large_sends_no_data(self):
        self.folder.attach(1, "clip.mov", os.urandom(101), mime="video/quicktime")
        with mock.patch.object(attachment_files, "MAX_INLINE_BYTES", 100):
            self.assertEqual(self.get(1), {"too_large": True, "mime_type": "video/quicktime",
                                           "filename": "clip.mov", "size": 101})
            # ...and opens from a copy instead
            copy = self.get(1, as_file=True)
        self.assertEqual(os.path.getsize(copy["path"]), 101)

    def test_the_limit_is_checked_after_converting(self):
        """A big HEIC still shows: it's the JPEG that travels."""
        tiff = picture("TIFF", (64, 48))  # uncompressed: far bigger than its JPEG
        self.folder.attach(1, "scan.tif", tiff, mime="image/tiff")
        with mock.patch.object(attachment_files, "MAX_INLINE_BYTES", len(tiff) - 1):
            result = self.get(1)
        self.assertTrue(decoded(result).startswith(JPEG_MAGIC))
        self.assertEqual(result["size"], len(tiff))
        with mock.patch.object(attachment_files, "MAX_INLINE_BYTES", 10):
            self.assertTrue(self.get(1)["too_large"])


# ── thumbnail ────────────────────────────────────────────────────────────────

class TestThumbnail(Case):

    def thumb(self, rowid):
        result = self.get(rowid, thumbnail=True)
        self.assertNotIn("error", result, result)
        self.assertEqual(result["mime_type"], "image/jpeg")
        img = Image.open(io.BytesIO(decoded(result)))
        self.assertEqual(img.format, "JPEG")
        return result, img

    def test_a_small_jpeg_with_the_whole_pictures_size(self):
        data = picture(size=(1600, 1200))
        self.folder.attach(1, "IMG_0001.jpeg", data)
        result, img = self.thumb(1)
        self.assertEqual(img.size, (400, 300))
        self.assertEqual((result["width"], result["height"]), (1600, 1200))
        self.assertEqual((result["filename"], result["size"]), ("IMG_0001.jpeg", len(data)))
        self.assertLess(len(result["data"]), len(base64.b64encode(data)))

    def test_turned_upright_by_its_exif_orientation(self):
        # Stored 800 x 400 with orientation 6 (turn a quarter clockwise): shown 400 wide, 800 tall
        self.folder.attach(1, "IMG_0002.jpeg", picture(size=(800, 400), orientation=6))
        result, img = self.thumb(1)
        self.assertEqual(img.size, (200, 400))
        self.assertEqual((result["width"], result["height"]), (400, 800))

    def test_a_small_picture_isnt_made_bigger(self):
        self.folder.attach(1, "tiny.png", picture("PNG", (40, 30)), mime="image/png")
        result, img = self.thumb(1)
        self.assertEqual((img.size, result["width"], result["height"]), ((40, 30), 40, 30))

    def test_every_kind_of_picture(self):
        kinds = {
            1: ("a.png", picture("PNG", (900, 300), mode="RGBA", colour=(255, 0, 0, 0)), "image/png"),
            2: ("b.gif", picture("GIF", (300, 900), mode="P", colour=3), "image/gif"),
            3: ("c.webp", picture("WEBP", (500, 500)), "image/webp"),
            4: ("d.bmp", picture("BMP", (120, 60)), "image/bmp"),
            5: ("e.tiff", picture("TIFF", (2000, 1000)), "image/tiff"),
            6: ("f.jpg", picture(size=(100, 100), mode="CMYK", colour=(0, 0, 0, 0)), "image/jpeg"),
        }
        for rowid, (name, data, mime) in kinds.items():
            self.folder.attach(rowid, name, data, mime)
        for rowid, (name, data, mime) in kinds.items():
            with self.subTest(name):
                result, img = self.thumb(rowid)
                self.assertLessEqual(max(img.size), 400)
                self.assertEqual(img.mode, "RGB")
                with Image.open(io.BytesIO(data)) as original:
                    self.assertEqual((result["width"], result["height"]), original.size)

    def test_transparency_goes_onto_white(self):
        self.folder.attach(1, "sticker.png", picture("PNG", (50, 50), mode="RGBA", colour=(255, 0, 0, 0)),
                           mime="image/png")
        _, img = self.thumb(1)
        self.assertEqual(img.convert("RGB").getpixel((25, 25)), (255, 255, 255))

    def test_heic(self):
        self.folder.attach(1, "IMG_0003.HEIC", heic((640, 480)), mime="image/heic")
        result, img = self.thumb(1)
        self.assertEqual((img.size, result["width"], result["height"]), ((400, 300), 640, 480))

    def test_kept_for_the_next_ask(self):
        rel = self.folder.attach(1, "IMG_0001.jpeg", picture())
        first = self.get(1, thumbnail=True)
        file_id = hashlib.sha1(f"MediaDomain-{rel}".encode()).hexdigest()
        os.remove(os.path.join(self.folder.dir, file_id[:2], file_id))
        with mock.patch.object(attachment_files, "thumbnail") as make:
            self.assertEqual(self.get(1, thumbnail=True), first)
        make.assert_not_called()
        # The whole file is read afresh, and is gone
        self.assertEqual(self.get(1), NOT_IN_BACKUP)

    def test_kept_apart_per_backup(self):
        """Two backups of one iPhone (the same UDID, in different folders) have their own attachment 1."""
        self.folder.attach(1, "IMG_0001.jpeg", picture(size=(100, 50)))
        mine = self.get(1, thumbnail=True)
        other_root = tempfile.TemporaryDirectory()
        self.addCleanup(other_root.cleanup)
        other = BackupFolder(other_root.name)
        other.attach(1, "IMG_0001.jpeg", picture(size=(50, 100)))
        other_backup = other.open()
        self.addCleanup(other_backup.close)
        self.addCleanup(self.ext._inner.close)  # its sms.db too, before the folder goes (Windows)
        theirs = MessageExtractor.get_attachment(self.ext, other_backup, 1, thumbnail=True)
        self.assertEqual(((mine["width"], mine["height"]), (theirs["width"], theirs["height"])),
                         ((100, 50), (50, 100)))

    def test_anything_else_has_none_and_its_file_isnt_read(self):
        """No thumbnail is not a failure (no error key), and an encrypted backup mustn't decrypt a video to say so."""
        self.folder.attach(1, "clip.mov", os.urandom(300), mime="video/quicktime")
        self.folder.attach(2, "Plans.pdf", b"%PDF-1.4", mime="application/pdf")
        self.folder.attach(3, "drawing.svg", b"<svg/>", mime="image/svg+xml")
        backup = self.backup
        with mock.patch.object(backup, "get_file", wraps=backup.get_file) as get_file:
            for rowid, name, mime, size in ((1, "clip.mov", "video/quicktime", 300),
                                            (2, "Plans.pdf", "application/pdf", 8),
                                            (3, "drawing.svg", "image/svg+xml", 6)):
                with self.subTest(name):
                    self.assertEqual(self.get(rowid, thumbnail=True),
                                     {"no_thumbnail": True, "mime_type": mime, "filename": name, "size": size})
        attachment_reads = [c for c in get_file.call_args_list if "Attachments" in c.args[0]]
        self.assertEqual(attachment_reads, [])

    def test_a_picture_that_cant_be_read_has_none(self):
        broken = b"\xff\xd8\xff not really"
        self.folder.attach(1, "broken.jpeg", broken, mime="image/jpeg")
        self.assertEqual(self.get(1, thumbnail=True),
                         {"no_thumbnail": True, "mime_type": "image/jpeg", "filename": "broken.jpeg", "size": len(broken)})


# ── as_file: a copy to open or play ──────────────────────────────────────────

class TestAsFile(Case):

    def copy(self, rowid, **kwargs):
        result = self.get(rowid, as_file=True, **kwargs)
        self.assertNotIn("error", result, result)
        return result

    def test_a_copy_under_its_own_name_outside_the_backup(self):
        data = os.urandom(2000)
        self.folder.attach(1, "clip.mov", data, mime="video/quicktime")
        result = self.copy(1)
        self.assertEqual(os.path.basename(result["path"]), "clip.mov")
        with open(result["path"], "rb") as f:
            self.assertEqual(f.read(), data)
        self.assertEqual((result["mime_type"], result["filename"], result["size"], result["openable"]),
                         ("video/quicktime", "clip.mov", 2000, True))
        # In this engine's folder of copies, where the app looks for files it may play
        root = os.path.basename(os.path.dirname(os.path.dirname(os.path.dirname(result["path"]))))
        self.assertTrue(root.startswith(f"openextract-messages-{os.getpid()}-"), root)
        self.assertFalse(os.path.realpath(result["path"]).startswith(os.path.realpath(self.folder.dir)))

    def test_wins_over_thumbnail(self):
        data = picture()
        self.folder.attach(1, "IMG_0001.jpeg", data)
        result = self.copy(1, thumbnail=True)
        with open(result["path"], "rb") as f:
            self.assertEqual(f.read(), data)

    def test_only_photos_videos_audio_and_documents_are_openable(self):
        cases = [
            # (name it was sent with, declared type) -> (copy's name, openable)
            ("Invoice.pdf.exe", "application/pdf", "Invoice.pdf.exe", False),
            ("Riley.vcf", "text/vcard", "Riley.vcf", False),
            ("page.html", "text/html", "page.html", False),
            ("Invoice", "application/x-msdownload", "Invoice", False),   # never ".exe" from the declared type
            ("Invoice", "application/pdf", "Invoice.pdf", True),          # a viewer's extension from the type is fine
            ("Audio Message.caf", "audio/x-caf", "Audio Message.caf", True),
            ("IMG_0001.HEIC", "image/heic", "IMG_0001.HEIC", True),      # the original, not the JPEG
        ]
        for rowid, (name, mime, _, _) in enumerate(cases, start=1):
            self.folder.attach(rowid, name, b"MZ fake", mime=mime)
        for rowid, (name, mime, want_name, want_openable) in enumerate(cases, start=1):
            with self.subTest(name=name, mime=mime):
                result = self.copy(rowid)
                self.assertEqual(os.path.basename(result["path"]), want_name)
                self.assertIs(result["openable"], want_openable)
                with open(result["path"], "rb") as f:
                    self.assertEqual(f.read(), b"MZ fake")

    @unittest.skipIf(os.name == "nt", "Windows files have no execute or group/other permission bits")
    def test_the_copy_is_never_executable(self):
        rel = self.folder.attach(1, "notes.txt", b"#!/bin/sh\necho hi\n", mime="text/plain")
        file_id = hashlib.sha1(f"MediaDomain-{rel}".encode()).hexdigest()
        os.chmod(os.path.join(self.folder.dir, file_id[:2], file_id), 0o777)  # an exFAT drive's files
        self.assertEqual(os.stat(self.copy(1)["path"]).st_mode & 0o777, 0o600)

    def test_used_again_and_one_folder_per_attachment(self):
        self.folder.attach(1, "IMG.jpeg", b"one")
        self.folder.attach(2, "IMG.jpeg", b"two")
        first = self.copy(1)["path"]
        self.assertEqual(self.copy(1)["path"], first)
        self.assertNotEqual(self.copy(2)["path"], first)

    def test_a_long_copy_reports_progress(self):
        self.folder.attach(1, "clip.mov", os.urandom(10_000), mime="video/quicktime")
        seen = []
        with mock.patch.object(app_copies, "_CHUNK_BYTES", 4096):
            self.copy(1, on_progress=lambda done, total: seen.append((done, total)))
        self.assertEqual(seen, [(4096, 10_000), (8192, 10_000), (10_000, 10_000)])

    def test_a_long_sessions_copies_keep_within_the_budget(self):
        # app_copies.BUDGET_BYTES (2 GB in the app): the copies handed out longest ago go
        clock = [0.0]
        for rowid in (1, 2, 3):
            self.folder.attach(rowid, f"clip{rowid}.mov", os.urandom(1000), mime="video/quicktime")
        with mock.patch.object(app_copies, "BUDGET_BYTES", 2500), \
                mock.patch.object(app_copies, "_now", lambda: clock[0]):
            paths = []
            for rowid in (1, 2, 3):
                clock[0] += app_copies.IN_USE_SECONDS
                paths.append(self.copy(rowid)["path"])
            self.assertEqual([os.path.exists(p) for p in paths], [False, True, True])
            clock[0] += app_copies.IN_USE_SECONDS
            again = self.copy(1)["path"]  # opened again: copied again
        self.assertEqual(again, paths[0])
        self.assertEqual([os.path.exists(p) for p in paths], [True, False, True])

    def test_no_room_says_so(self):
        self.folder.attach(1, "clip.mov", os.urandom(100), mime="video/quicktime")
        with mock.patch.object(app_copies, "_check_space", side_effect=app_copies.NotEnoughSpace(4_200_000_000, 310_000_000)):
            result = self.get(1, as_file=True)
        self.assertEqual(set(result), {"error"})
        self.assertIn("4.2 GB", result["error"])
        self.assertIn("310 MB", result["error"])


# ── What isn't there ─────────────────────────────────────────────────────────

class TestErrors(Case):

    def each_mode(self, rowid):
        return [self.get(rowid, **flags) for flags in ({}, {"thumbnail": True}, {"as_file": True})]

    def test_an_id_no_attachment_has(self):
        self.folder.attach(1, "IMG.jpeg", picture())
        for attachment_id in (999, -1, "abc", None, [1], 1.5, True, "²"):
            with self.subTest(attachment_id=attachment_id):
                for result in self.each_mode(attachment_id):
                    self.assertEqual(result, {"error": "Attachment not found"})

    def test_an_id_sent_as_text(self):
        data = picture()
        self.folder.attach(7, "IMG.jpeg", data)
        self.assertEqual(decoded(self.get("7")), data)

    def test_a_file_the_backup_hasnt_got(self):
        self.folder.attach(1, "listed-not-stored.jpeg", picture(), stored=False)  # a backup copied partway
        self.folder.attach(2, "never-listed.jpeg", picture(), listed=False)       # left out of the backup
        self.folder.attach(3, "never-downloaded.jpeg", None, filename=None)       # still in iCloud: no file name
        for rowid in (1, 2, 3):
            with self.subTest(rowid=rowid):
                self.assertEqual(self.each_mode(rowid), [NOT_IN_BACKUP] * 3)

    def test_a_file_that_vanished(self):
        rel = self.folder.attach(1, "IMG.jpeg", picture())
        self.assertIn("data", self.get(1))
        file_id = hashlib.sha1(f"MediaDomain-{rel}".encode()).hexdigest()
        os.remove(os.path.join(self.folder.dir, file_id[:2], file_id))
        self.assertEqual(self.get(1), NOT_IN_BACKUP)

    def test_a_backup_without_sms_db(self):
        self.folder.with_sms_db = False
        for result in self.each_mode(1):
            self.assertEqual(result, {"error": "sms.db not found"})

    def test_paths_written_from_the_root_of_the_iphone(self):
        data = picture()
        self.folder.attach(1, "a.jpeg", data, prefix="/private/var/mobile/")
        self.folder.attach(2, "b.jpeg", data, prefix="/var/mobile/")
        self.folder.attach(3, "c.jpeg", data, domain="HomeDomain")
        for rowid in (1, 2, 3):
            with self.subTest(rowid=rowid):
                self.assertEqual(decoded(self.get(rowid)), data)
                self.assertIs(self.attachment(rowid)["available"], True)


# ── get_messages: available, uti, is_sticker ─────────────────────────────────

class TestPageFields(Case):

    def test_each_attachment_says_whether_its_file_is_in_the_backup(self):
        self.folder.attach(1, "here.jpeg", picture(), uti="public.jpeg")
        self.folder.attach(2, "listed-not-stored.jpeg", picture(), stored=False)
        self.folder.attach(3, "never-listed.jpeg", picture(), listed=False)
        self.folder.attach(4, "never-downloaded.jpeg", None, filename=None)
        self.folder.attach(5, "Audio Message.caf", b"caff", mime="audio/x-caf", uti="com.apple.coreaudio-format")
        self.folder.attach(6, "sticker.heic", b"x", mime="image/heic", uti="public.heic", sticker=1)
        got = {a["attachment_id"]: a for m in self.page() for a in m["attachments"]}
        self.assertEqual({i: a["available"] for i, a in got.items()},
                         {1: True, 2: False, 3: False, 4: False, 5: True, 6: True})
        self.assertEqual({i: a["uti"] for i, a in got.items()},
                         {1: "public.jpeg", 2: None, 3: None, 4: None, 5: "com.apple.coreaudio-format", 6: "public.heic"})
        self.assertEqual({i: a["is_sticker"] for i, a in got.items()},
                         {1: False, 2: False, 3: False, 4: False, 5: False, 6: True})
        # What was there before is unchanged
        first = got[1]
        self.assertEqual({k: first[k] for k in ("filename", "mime_type", "transfer_name", "total_bytes")},
                         {"filename": first["filename"], "mime_type": "image/jpeg", "transfer_name": "here.jpeg",
                          "total_bytes": len(picture())})
        self.assertTrue(first["filename"].startswith("~/Library/SMS/Attachments/"))
        # ...and agrees with get_attachment
        for rowid, att in got.items():
            with self.subTest(rowid=rowid):
                self.assertEqual("error" not in self.get(rowid), att["available"])

    def test_an_old_sms_db(self):
        self.old_schema()
        self.folder.attach(1, "IMG_0042.JPG", picture(), mime=None)
        att = self.attachment(1)
        self.assertEqual((att["available"], att["uti"], att["is_sticker"]), (True, None, False))

    def test_one_look_at_the_backups_list_of_files_per_page(self):
        for rowid in range(1, 31):
            self.folder.attach(rowid, f"IMG_{rowid:04d}.jpeg", b"x" * rowid, stored=rowid % 3 != 0)
        self.page()  # finds sms.db (a look-up of its own, made once)
        conn = self.backup._get_manifest_conn()
        queries = []
        conn.set_trace_callback(queries.append)
        self.addCleanup(conn.set_trace_callback, None)
        page = self.page()
        looked_up = [q for q in queries if "FROM Files" in q]
        self.assertEqual(len(looked_up), 1, looked_up)
        self.assertEqual(sum(a["available"] for m in page for a in m["attachments"]), 20)

    def test_many_attachments_on_one_page(self):
        """More than SQLite allows in one IN (...) list in old builds (999)."""
        for rowid in range(1, 1201):
            self.folder.attach(rowid, f"IMG_{rowid:04d}.jpeg", b"x", stored=rowid != 600)
        atts = [a for m in self.page(limit=2000) for a in m["attachments"]]
        self.assertEqual(len(atts), 1200)
        self.assertEqual([a["attachment_id"] for a in atts if not a["available"]], [600])

    def test_a_list_of_files_that_cant_be_read_hides_nothing(self):
        self.folder.attach(1, "IMG.jpeg", picture())
        with mock.patch.object(messages, "_manifest_rows", side_effect=sqlite3.DatabaseError("file is not a database")):
            att = self.attachment(1)
        self.assertIs(att["available"], True)  # get_attachment says otherwise if it isn't

    def test_sms_db_that_cant_be_read_for_types_still_gives_the_page(self):
        self.folder.attach(1, "IMG.jpeg", picture(), uti="public.jpeg")
        with mock.patch.object(MessageExtractor, "_attachment_details", side_effect=sqlite3.OperationalError("locked")):
            att = self.attachment(1)
        self.assertEqual((att["available"], att["uti"], att["is_sticker"]), (True, None, False))

    def test_the_timelines_day_has_them_too(self):
        """get_messages_on_day reads its pages through get_messages."""
        self.folder.attach(1, "here.jpeg", picture())
        self.folder.attach(2, "gone.jpeg", picture(), stored=False)
        counter = YearCounter(self.ext, None, None, None, None)
        days = {messages.local_datetime(m["date"]).date().isoformat() for m in self.page()}
        found = {}
        for day in days:
            for conv in counter.messages_on_day(self.backup, {}, day)["conversations"]:
                for m in conv["messages"]:
                    for a in m["attachments"]:
                        found[a["attachment_id"]] = a["available"]
        self.assertEqual(found, {1: True, 2: False})


class TestEncryptedList(unittest.TestCase):
    """An encrypted backup's list of files is read through its decrypted copy (manifest_db_cursor)."""

    def test_read_through_the_decrypted_list(self):
        conn = sqlite3.connect(":memory:")
        conn.execute("CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)")
        conn.executemany("INSERT INTO Files VALUES (?, ?, ?, 1, NULL)", [
            ("a" * 40, "MediaDomain", "Library/SMS/Attachments/a.jpeg"),
            ("b" * 40, "MediaDomain", "Library/SMS/Attachments/b.jpeg"),          # not stored
            ("c" * 40, "CameraRollDomain", "Library/SMS/Attachments/c.jpeg"),     # not an attachment's domain
            ("d" * 40, "HomeDomain", "Library/SMS/Attachments/d.jpeg"),
        ])
        stored = {"a" * 40, "c" * 40, "d" * 40}

        class Decrypted:
            @contextlib.contextmanager
            def manifest_db_cursor(self):
                cur = conn.cursor()
                try:
                    yield cur
                finally:
                    cur.close()

        class Encrypted:
            encrypted = True
            _decrypted_backup = Decrypted()

            def locate_file(self, file_id):
                return f"/backup/{file_id}" if file_id in stored else None

        present = messages._files_in_backup(Encrypted(), [f"Library/SMS/Attachments/{n}.jpeg" for n in "abcde"])
        self.assertEqual(present, {"Library/SMS/Attachments/a.jpeg", "Library/SMS/Attachments/d.jpeg"})

    def test_no_decrypted_list_means_cant_tell(self):
        class Encrypted:
            encrypted = True
            _decrypted_backup = None

        self.assertIsNone(messages._files_in_backup(Encrypted(), ["Library/SMS/Attachments/a.jpeg"]))
        self.assertEqual(messages._files_in_backup(Encrypted(), ["", None]), set())


if __name__ == "__main__":
    unittest.main()
