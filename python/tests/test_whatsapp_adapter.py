"""
get_whatsapp_attachment (python/whatsapp.py): one WhatsApp media file for the app.

ios-backup-core's WhatsAppExtractor.get_attachment returns a path; the adapter
turns it into what the app can use: base64 for a picture or a voice note, a
copy named with its real extension for opening a video or document in another
app, or "too large" for a file that shouldn't travel in one JSON-RPC line. A
file the backup doesn't have is a calm empty state, not a failure. These
tests stub the library, so they run without it.
"""

import base64
import io
import os
import subprocess
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import whatsapp  # noqa: E402
from whatsapp import WhatsAppExtractor, _NoWhatsAppSupport  # noqa: E402

UNREADABLE = "WhatsApp is in this backup but could not be read. The backup may be incomplete or damaged."


class FakeInner:
    """Answers get_attachment like the library: {path, mime_type, filename} or {error}."""

    def __init__(self, answers):
        self.answers = answers  # (attachment_id, thumbnail) -> dict
        self.calls = []

    def get_attachment(self, backup, attachment_id, thumbnail=False):
        self.calls.append((attachment_id, thumbnail))
        return dict(self.answers.get((attachment_id, thumbnail), {"error": "Attachment not found"}))


class Backup:
    def __init__(self, udid="00008120-0000000000000001"):
        self.udid = udid


class AdapterCase(unittest.TestCase):

    def setUp(self):
        src = tempfile.TemporaryDirectory()
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(src.cleanup)
        self.addCleanup(temp.cleanup)
        self.src = src.name
        # Point the system temp folder at our own, so copies and the stale-folder sweep stay in it.
        saved = tempfile.tempdir
        tempfile.tempdir = temp.name
        self.addCleanup(setattr, tempfile, "tempdir", saved)
        self.temp = temp.name
        self.wa = WhatsAppExtractor()
        self.backup = Backup()

    def file(self, name, data):
        path = os.path.join(self.src, name)
        with open(path, "wb") as f:
            f.write(data)
        return path

    def answer(self, answers):
        self.wa._inner = FakeInner(answers)
        return self.wa._inner


class TestInline(AdapterCase):

    def test_base64_with_mime_type_name_and_size(self):
        data = b"OggS" + os.urandom(300)
        hashed = self.file("ab12cd34", data)  # an unencrypted backup's files have no extension
        self.answer({(5, False): {"path": hashed, "mime_type": "audio/ogg; codecs=opus", "filename": "voice.opus"}})
        result = self.wa.get_attachment(self.backup, 5)
        self.assertEqual(base64.b64decode(result["data"], validate=True), data)
        # No parameters: the app puts the type in a data: URL
        self.assertEqual((result["mime_type"], result["filename"], result["size"]), ("audio/ogg", "voice.opus", len(data)))

    def test_thumbnail_is_asked_for(self):
        inner = self.answer({(5, True): {"path": self.file("t", b"\xff\xd8\xff thumb"), "mime_type": "image/jpeg",
                                         "filename": "x.thumb"}})
        result = self.wa.get_attachment(self.backup, 5, thumbnail=True)
        self.assertEqual(inner.calls, [(5, True)])
        self.assertEqual(result["mime_type"], "image/jpeg")
        self.assertTrue(base64.b64decode(result["data"]).startswith(b"\xff\xd8\xff"))

    def test_missing_mime_type_is_guessed_from_the_name(self):
        self.answer({(5, False): {"path": self.file("x", b"RIFF webp"), "mime_type": None, "filename": "s.webp"}})
        self.assertEqual(self.wa.get_attachment(self.backup, 5)["mime_type"], "image/webp")
        self.answer({(5, False): {"path": self.file("y", b"?"), "mime_type": None, "filename": "noext"}})
        self.assertEqual(self.wa.get_attachment(self.backup, 5)["mime_type"], "application/octet-stream")

    def test_types_dont_depend_on_the_systems_own_table(self):
        # Windows' table lacks .webp and .opus (CI's windows-latest): WhatsApp's types
        # must come out the same with no help from mimetypes at all.
        from unittest import mock
        with mock.patch("mimetypes.guess_type", return_value=(None, None)), \
                mock.patch("mimetypes.guess_extension", return_value=None):
            for name, mime in (("s.webp", "image/webp"), ("v.opus", "audio/ogg"), ("d.pdf", "application/pdf"),
                               ("m.mp4", "video/mp4"), ("p.JPG", "image/jpeg")):
                self.answer({(5, False): {"path": self.file("z" + name, b"x"), "mime_type": None, "filename": name}})
                self.assertEqual(self.wa.get_attachment(self.backup, 5)["mime_type"], mime, name)
            self.assertEqual(whatsapp._extension_for("image/webp"), ".webp")
            self.assertEqual(whatsapp._extension_for("audio/ogg; codecs=opus"), ".ogg")

    def test_too_large_sends_no_data(self):
        whatsapp.MAX_INLINE_BYTES, saved = 100, whatsapp.MAX_INLINE_BYTES
        self.addCleanup(setattr, whatsapp, "MAX_INLINE_BYTES", saved)
        big = self.file("big", os.urandom(101))
        self.answer({(5, False): {"path": big, "mime_type": "video/mp4", "filename": "clip.mp4"}})
        result = self.wa.get_attachment(self.backup, 5)
        self.assertEqual(result, {"too_large": True, "mime_type": "video/mp4", "filename": "clip.mp4", "size": 101})
        # ...and opens in another app instead
        copy = self.wa.get_attachment(self.backup, 5, as_file=True)
        self.assertTrue(copy["path"].endswith("clip.mp4") and os.path.getsize(copy["path"]) == 101)

    def test_heic_comes_as_jpeg(self):
        try:
            import pillow_heif
            from PIL import Image
            pillow_heif.register_heif_opener()
            buf = io.BytesIO()
            Image.new("RGB", (32, 24), (200, 30, 30)).save(buf, format="HEIF")
        except Exception as e:  # no HEIF encoder in this Pillow build
            self.skipTest(f"can't write a HEIC here: {e}")
        heic = self.file("h", buf.getvalue())
        self.answer({(5, False): {"path": heic, "mime_type": "image/heic", "filename": "IMG_1.heic"}})
        result = self.wa.get_attachment(self.backup, 5)
        self.assertEqual(result["mime_type"], "image/jpeg")
        self.assertTrue(base64.b64decode(result["data"]).startswith(b"\xff\xd8\xff"))


class TestErrors(AdapterCase):

    def test_what_each_library_error_becomes(self):
        cases = {
            "Attachment file not found in backup": {"error": "This file isn't in the backup", "empty_reason": "not_in_backup"},
            "WhatsApp is not in this backup": {"error": "WhatsApp is not in this backup", "empty_reason": "not_in_backup"},
            "Attachment not found": {"error": "Attachment not found"},
            UNREADABLE: {"error": UNREADABLE},  # a real failure: no empty_reason
        }
        if whatsapp.UNSUPPORTED:
            cases[whatsapp.UNSUPPORTED] = {"error": whatsapp.UNSUPPORTED, "empty_reason": "unsupported_format"}
        for library_error, want in cases.items():
            with self.subTest(library_error):
                self.answer({(5, False): {"error": library_error}, (5, True): {"error": library_error}})
                self.assertEqual(self.wa.get_attachment(self.backup, 5), want)
                self.assertEqual(self.wa.get_attachment(self.backup, 5, as_file=True), want)

    def test_a_file_that_vanished_is_not_in_the_backup(self):
        self.answer({(5, False): {"path": os.path.join(self.src, "gone"), "mime_type": "image/jpeg", "filename": "a.jpg"}})
        self.assertEqual(self.wa.get_attachment(self.backup, 5),
                         {"error": "This file isn't in the backup", "empty_reason": "not_in_backup"})


class TestAsFile(AdapterCase):

    def copy(self, attachment_id=5, thumbnail=False, backup=None):
        result = self.wa.get_attachment(backup or self.backup, attachment_id, thumbnail=thumbnail, as_file=True)
        self.assertNotIn("error", result, result)
        return result

    def test_named_with_its_real_extension(self):
        hashed = self.file("0a1b2c", b"%PDF-1.4 fake")
        self.answer({
            (5, False): {"path": hashed, "mime_type": "application/pdf", "filename": "Quarterly report.pdf"},
            (5, True): {"path": self.file("t", b"\xff\xd8\xff"), "mime_type": "image/jpeg", "filename": "doc.thumb"},
            (6, False): {"path": self.file("n", b"x"), "mime_type": "video/mp4", "filename": "clip"},
        })
        doc = self.copy()
        self.assertEqual(os.path.basename(doc["path"]), "Quarterly report.pdf")
        with open(doc["path"], "rb") as f:
            self.assertEqual(f.read(), b"%PDF-1.4 fake")
        self.assertEqual((doc["mime_type"], doc["filename"], doc["size"]), ("application/pdf", "Quarterly report.pdf", 13))
        self.assertIs(doc["openable"], True)
        self.assertTrue(doc["path"].startswith(os.path.join(self.temp, whatsapp._TEMP_PREFIX)))
        thumb = self.copy(thumbnail=True)
        self.assertEqual(os.path.basename(thumb["path"]), "doc.jpg")  # .thumb files are JPEG
        self.assertIs(thumb["openable"], True)
        clip = self.copy(6)
        self.assertEqual(os.path.basename(clip["path"]), "clip.mp4")
        self.assertIs(clip["openable"], True)

    def test_only_photos_videos_audio_and_documents_are_openable(self):
        """The sender picks a document's name and type: a program must never be one click from running."""
        cases = [
            # (name the library gives, declared MIME type) -> (copy's name, openable)
            ("Invoice\u202efdp.exe", "application/pdf", "Invoicefdp.exe", False),  # reads "Invoiceexe.pdf" with the mark
            ("Invoice.pdf.exe", "application/pdf", "Invoice.pdf.exe", False),
            ("report.HTA", "application/hta", "report.HTA", False),
            ("x.lnk", "application/x-ms-shortcut", "x.lnk", False),
            ("a.js", "application/javascript", "a.js", False),
            ("run.command", "text/plain", "run.command", False),
            ("tool.scr", "image/jpeg", "tool.scr", False),               # a picture's type doesn't make it one
            ("Invoice", "application/x-msdownload", "Invoice", False),   # never ".exe" from the declared type
            ("Invoice", "application/javascript", "Invoice", False),
            ("page", "text/html", "page", False),
            ("drawing", "image/svg+xml", "drawing", False),
            ("Riley", "text/vcard", "Riley", False),
            ("photos.zip", "application/zip", "photos.zip", False),
            ("doc.thumb", "application/x-msdownload", "doc.thumb", False),
            ("Photo.JPG", "image/jpeg", "Photo.JPG", True),
            ("Invoice", "application/pdf", "Invoice.pdf", True),          # a viewer's extension from the type is fine
            ("Inv\u200boice\u200d.pdf", "application/pdf", "Invoice.pdf", True),  # zero-width characters go
            ("\ufeffnotes\u2067.txt\u2069", "text/plain", "notes.txt", True),     # so do isolates and a BOM
            ("Budget\u2028Q3.xlsx", None, "BudgetQ3.xlsx", True),
            ("voice.opus", "audio/ogg", "voice.opus", True),
        ]
        self.answer({(i, False): {"path": self.file(f"s{i}", b"MZ fake"), "mime_type": mime, "filename": name}
                     for i, (name, mime, _, _) in enumerate(cases)})
        for i, (name, mime, want_name, want_openable) in enumerate(cases):
            with self.subTest(name=name, mime=mime):
                result = self.copy(i)
                self.assertEqual(os.path.basename(result["path"]), want_name)
                self.assertIs(result["openable"], want_openable)
                self.assertEqual(result["filename"], name)  # what the app shows is the library's, as before
                with open(result["path"], "rb") as f:  # still copied, to show in its folder
                    self.assertEqual(f.read(), b"MZ fake")

    @unittest.skipIf(os.name == "nt", "Windows files have no execute or group/other permission bits")
    def test_the_copy_is_never_executable_and_only_its_owner_reads_it(self):
        # A backup on an exFAT or NTFS drive gives every file 0777; macOS would run such a file.
        src = self.file("loose", b"#!/bin/sh\necho hi\n")
        os.chmod(src, 0o777)
        self.answer({(5, False): {"path": src, "mime_type": "text/plain", "filename": "notes.txt"}})
        path = self.copy()["path"]
        self.assertEqual(os.stat(path).st_mode & 0o777, 0o600)
        self.assertEqual(os.stat(src).st_mode & 0o777, 0o777)  # the backup's file is left alone

    def test_long_names_fit_every_file_system(self):
        """Linux allows 255 bytes a name: the copy and its ".<8 hex>.partial" stage must fit, in any script."""
        partial = len(".0123abcd.partial")
        cases = [("会议记录" * 20 + ".pdf", ".pdf"), ("😀" * 70 + ".pdf", ".pdf"),
                 ("a" * 300 + ".docx", ".docx"), ("x." + "é" * 20, None)]
        self.answer({(i, False): {"path": self.file(f"l{i}", b"x"), "mime_type": "application/pdf", "filename": name}
                     for i, (name, _) in enumerate(cases)})
        for i, (name, ext) in enumerate(cases):
            with self.subTest(name=name[:12]):
                copy_name = os.path.basename(self.copy(i)["path"])
                self.assertLessEqual(len(copy_name.encode("utf-8")) + partial, 255)
                self.assertLessEqual(len(os.path.splitext(copy_name)[0]), 80)  # and Windows paths stay short
                if ext:
                    self.assertTrue(copy_name.endswith(ext) and name.startswith(copy_name[:-len(ext)]))

    def test_reused_until_the_file_changes(self):
        hashed = self.file("0a1b2c", b"first")
        self.answer({(5, False): {"path": hashed, "mime_type": "video/mp4", "filename": "clip.mp4"}})
        first = self.copy()["path"]
        # Mark it (a fresh copy would take the source's access time), keeping its modification time exactly.
        os.utime(first, ns=(time.time_ns() - 100 * 10 ** 9, os.stat(first).st_mtime_ns))
        stamp = os.stat(first).st_atime
        self.assertEqual(self.copy()["path"], first)
        self.assertEqual(os.stat(first).st_atime, stamp)
        with open(hashed, "wb") as f:
            f.write(b"second, longer")
        self.assertEqual(self.copy()["path"], first)
        with open(first, "rb") as f:
            self.assertEqual(f.read(), b"second, longer")

    def test_one_folder_per_backup_and_attachment(self):
        self.answer({(5, False): {"path": self.file("a", b"one"), "mime_type": "image/jpeg", "filename": "IMG.jpg"},
                     (6, False): {"path": self.file("b", b"two"), "mime_type": "image/jpeg", "filename": "IMG.jpg"}})
        paths = {self.copy(5)["path"], self.copy(6)["path"], self.copy(5, backup=Backup("other"))["path"]}
        self.assertEqual(len(paths), 3)
        self.assertEqual({os.path.basename(p) for p in paths}, {"IMG.jpg"})

    def test_names_that_could_escape_or_confuse(self):
        self.answer({
            (5, False): {"path": self.file("a", b"x"), "mime_type": "text/plain", "filename": "../../evil.txt"},
            (6, False): {"path": self.file("b", b"x"), "mime_type": "text/plain", "filename": "CON.txt"},
            (7, False): {"path": self.file("c", b"x"), "mime_type": "application/pdf", "filename": 'a<b>:"c"?.pdf'},
            (8, False): {"path": self.file("d", b"x"), "mime_type": "application/pdf", "filename": ""},
        })
        evil = self.copy(5)["path"]
        self.assertEqual(os.path.basename(evil), "evil.txt")
        self.assertTrue(os.path.realpath(evil).startswith(os.path.realpath(self.temp)))
        self.assertEqual(os.path.basename(self.copy(6)["path"]), "_CON.txt")
        self.assertEqual(os.path.basename(self.copy(7)["path"]), "a_b_c_.pdf")
        self.assertEqual(os.path.basename(self.copy(8)["path"]), "WhatsApp file.pdf")

    def test_one_folder_for_the_engine_named_with_its_process_id(self):
        self.answer({(5, False): {"path": self.file("a", b"x"), "mime_type": "image/jpeg", "filename": "a.jpg"}})
        path = self.copy()["path"]
        root = self.wa._temp_dir
        self.assertTrue(path.startswith(root))
        self.assertTrue(os.path.basename(root).startswith(f"{whatsapp._TEMP_PREFIX}{os.getpid()}-"))
        self.assertEqual(self.copy(5)["path"], path)
        # Made again if something removed it
        import shutil
        shutil.rmtree(root)
        again = self.copy()["path"]
        self.assertTrue(os.path.isfile(again))


class TestStaleFolders(AdapterCase):
    """Copies an engine left behind go when the next engine starts, not when it next opens a file.

    The app stops the engine by killing it, so its own cleanup at exit
    rarely runs, and from an encrypted backup the copies are decrypted.
    """

    def folder(self, name, age_hours=0.0, content=True):
        path = os.path.join(self.temp, name)
        os.makedirs(path)
        if content:
            with open(os.path.join(path, "Divorce papers.pdf"), "wb") as f:
                f.write(b"%PDF")
        when = time.time() - age_hours * 3600
        os.utime(path, (when, when))
        return path

    def process(self, *, running):
        code = "import time; time.sleep(60)" if running else "pass"
        proc = subprocess.Popen([sys.executable, "-c", code])
        if running:
            self.addCleanup(proc.wait)
            self.addCleanup(proc.kill)
        else:
            proc.wait()
        return proc.pid

    def test_swept_as_the_engine_starts(self):
        prefix = whatsapp._TEMP_PREFIX
        ended = self.folder(f"{prefix}{self.process(running=False)}-ab12cd34")             # a minute old
        live_pid = self.process(running=True)
        live = self.folder(f"{prefix}{live_pid}-ef56gh78", age_hours=0.5)                 # another engine, in use
        reused = self.folder(f"{prefix}{live_pid}-ij90kl12", age_hours=2)                 # same id, long idle
        mine = self.folder(f"{prefix}{os.getpid()}-mn34op56", age_hours=0.5)
        unnamed_old = self.folder(f"{prefix}q7r8s9t0", age_hours=2)                       # no process id in the name
        unnamed_new = self.folder(f"{prefix}u1v2w3x4", age_hours=0.1)
        unrelated = self.folder("openextract-pdf-staging", age_hours=48)
        not_a_folder = os.path.join(self.temp, f"{prefix}1-file")
        with open(not_a_folder, "wb") as f:
            f.write(b"keep")
        outside = self.folder("elsewhere", age_hours=48)
        link = os.path.join(self.temp, f"{prefix}1-link")
        try:
            os.symlink(outside, link, target_is_directory=True)
        except (OSError, NotImplementedError):  # Windows without the right to make links
            link = None

        WhatsAppExtractor()  # the engine starting; no file opened

        for gone in (ended, reused, unnamed_old):
            self.assertFalse(os.path.exists(gone), os.path.basename(gone))
        for kept in (live, mine, unnamed_new, unrelated, outside):
            self.assertTrue(os.path.isfile(os.path.join(kept, "Divorce papers.pdf")), os.path.basename(kept))
        self.assertTrue(os.path.isfile(not_a_folder))
        if link:
            self.assertTrue(os.path.islink(link))

    def test_a_process_id_that_cant_be_an_engine(self):
        self.assertTrue(whatsapp._process_running(os.getpid()))
        for pid in (0, -1, 2 ** 40):
            self.assertFalse(whatsapp._process_running(pid))
        self.assertFalse(whatsapp._process_running(self.process(running=False)))
        self.assertTrue(whatsapp._process_running(self.process(running=True)))


class TestWithoutLibrarySupport(unittest.TestCase):

    def test_everything_says_not_in_backup(self):
        none = _NoWhatsAppSupport()
        self.assertEqual(none.list_conversations(None, {}), {"conversations": [], "empty_reason": "not_in_backup"})
        self.assertEqual(none.has_whatsapp(None)["empty_reason"], "not_in_backup")
        self.assertEqual(none.get_messages(None, 1, {}, 0, 50)["empty_reason"], "not_in_backup")
        self.assertEqual(none.search_messages(None, "x", {})["empty_reason"], "not_in_backup")
        self.assertEqual(none.get_message_offset(None, 1, 1), {"offset": 0, "found": False})
        wa = WhatsAppExtractor()
        wa._inner = none
        self.assertEqual(wa.get_attachment(None, 1),
                         {"error": "WhatsApp is not in this backup", "empty_reason": "not_in_backup"})


if __name__ == "__main__":
    unittest.main()
