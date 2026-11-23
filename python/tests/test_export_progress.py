"""
Progress for long photo saves (OE-14).

Saving a big library from an encrypted backup took longer than the app waited,
with nothing on screen but "Saving…". export_photos now reports files done of
the total, and failures so far, a few times a second; main.py sends that to the
app as export.progress notifications.
"""

import os
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from export_progress import ChatSaveProgress, ExportProgress  # noqa: E402
from messages import MessageExtractor  # noqa: E402
from photos import PhotoExtractor  # noqa: E402
from rpc_contract_support import load_engine_module  # noqa: E402
from whatsapp import WhatsAppExtractor  # noqa: E402


class _Clock:
    def __init__(self):
        self.now = 100.0

    def __call__(self):
        return self.now


class ExportProgressTests(unittest.TestCase):
    def setUp(self):
        self.sent = []
        self.clock = _Clock()
        self.progress = ExportProgress(lambda *a: self.sent.append(a), 10, clock=self.clock)

    def test_first_update_goes_out_straight_away(self):
        self.progress.update(0, 0)
        self.assertEqual(self.sent, [(0, 10, 0)])

    def test_updates_in_quick_succession_are_dropped(self):
        for done in range(4):
            self.progress.update(done, 0)
            self.clock.now += 0.1
        # 0 at 0.0s, 3 at 0.3s; 1 and 2 came less than INTERVAL after the last one sent
        self.assertEqual(self.sent, [(0, 10, 0), (3, 10, 0)])

    def test_last_update_always_goes_out(self):
        self.progress.update(9, 1)
        self.progress.update(10, 1)
        self.assertEqual(self.sent, [(9, 10, 1), (10, 10, 1)])

    def test_done_never_passes_the_total(self):
        # A file whose copy worked but whose .json didn't counts as saved and failed.
        self.progress.update(11, 2)
        self.assertEqual(self.sent, [(10, 10, 2)])

    def test_no_callback_does_nothing(self):
        ExportProgress(None, 10).update(5, 0)


class ChatSaveProgressTests(unittest.TestCase):
    def setUp(self):
        self.sent = []
        self.clock = _Clock()

    def progress(self, chats=1, read_first=False):
        return ChatSaveProgress(self.sent.append, chats, read_first, clock=self.clock)

    def test_updates_in_quick_succession_are_dropped(self):
        progress = self.progress()
        for _ in progress.saving(list(range(20))):
            self.clock.now += 0.05
        self.assertLess(len(self.sent), 6)
        self.assertEqual(self.sent[0]["done"], 0)
        self.assertEqual([p["done"] for p in self.sent], sorted(p["done"] for p in self.sent))

    def test_chats_saved_one_after_another_fill_the_bar_once(self):
        progress = self.progress(chats=2)
        for chat in range(2):
            progress.start_chat(chat)
            self.clock.now += 1
            progress.read(10, 10)
            for _ in progress.saving(list(range(4))):
                self.clock.now += 1
        percents = [p["percent"] for p in self.sent]
        self.assertEqual(percents, sorted(percents))
        self.assertGreater(percents[-1], 85)
        self.assertEqual({(p["chat"], p["chats"]) for p in self.sent}, {(1, 2), (2, 2)})

    def test_chats_read_first_are_the_first_tenth(self):
        progress = self.progress(chats=3, read_first=True)
        for chat in range(3):
            progress.start_chat(chat)
            self.clock.now += 1
            progress.read(500, 500)
        self.assertEqual(self.sent[-1]["percent"], 10)
        progress.one_file()
        self.clock.now += 1
        next(iter(progress.saving(["a", "b"])))
        self.assertEqual((self.sent[-1]["phase"], self.sent[-1]["percent"], self.sent[-1]["chats"]), ("saving", 10, 1))

    def test_nothing_to_count_or_nobody_listening_sends_nothing(self):
        self.progress().read(0, 0)
        self.assertEqual(list(ChatSaveProgress().saving([1, 2])), [1, 2])
        self.assertEqual(self.sent, [])


def _message(n, **more):
    return {"message_id": n, "date": f"2024-05-01T10:{n % 60:02d}:00+00:00", "sender": "Sam", "is_from_me": False,
            "text": f"message {n}", "message_type": "text", "has_attachments": False, "attachments": [], **more}


class SavingChatsReportsTests(unittest.TestCase):
    """Every page read and every message written says the save is still going (OE-132)."""

    TOTAL = 1200  # three pages of 500

    def get_messages(self, backup, chat_id, contacts, offset=0, limit=100, date_from=None, date_to=None):
        page = [_message(n) for n in range(offset, min(offset + limit, self.TOTAL))]
        return {"messages": page, "total": self.TOTAL, "next_offset": offset + len(page)}

    def extractors(self):
        messages = MessageExtractor()
        messages.get_messages = self.get_messages
        whatsapp = WhatsAppExtractor()
        whatsapp.get_messages = self.get_messages
        return (("messages", messages), ("whatsapp", whatsapp))

    def reported(self, save):
        sent = []
        with mock.patch.object(ChatSaveProgress, "INTERVAL", 0):
            result = save(sent.append)
        self.assertNotIn("error", result)
        return sent

    def test_planning_reports_each_page_read(self):
        for name, extractor in self.extractors():
            with self.subTest(name):
                sent = self.reported(lambda hear: extractor.plan_pdf_parts(
                    None, [1, 2], {}, progress=ChatSaveProgress(hear, 2, read_first=True)))
                self.assertEqual([(p["phase"], p["chat"], p["done"]) for p in sent],
                                 [("reading", c, d) for c in (1, 2) for d in (500, 1000, 1200)])
                self.assertEqual(sent[-1]["percent"], 10)

    def test_saving_reports_each_message_written(self):
        for name, extractor in self.extractors():
            for fmt in ("pdf_source", "html"):
                for mode, files in (("separate", 2), ("merged", 1)):
                    with self.subTest(f"{name} {fmt} {mode}"), tempfile.TemporaryDirectory() as out:
                        sent = self.reported(lambda hear: extractor.export_conversations(
                            None, [1, 2], {1: "Sam", 2: "Alex"}, {}, fmt, out, mode=mode,
                            progress=ChatSaveProgress(hear, 2, read_first=mode == "merged")))
                        saving = [p for p in sent if p["phase"] == "saving"]
                        self.assertEqual(len(saving), 2 * self.TOTAL)
                        self.assertEqual(len({p["chat"] for p in saving}), files)
                        percents = [p["percent"] for p in sent]
                        self.assertEqual(percents, sorted(percents))
                        self.assertGreaterEqual(percents[-1], 99)


class ExportPhotosProgressTests(unittest.TestCase):
    """export_photos over a fake library: four photos, a video, a Live Photo, one file missing."""

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.root = self._tmp.name
        kinds = ["photo", "photo", "video", "live_photo", "photo", "photo"]
        self.photos = [
            {"filename": f"IMG_{i:04d}.JPG", "file_hash": f"hash{i}", "kind": kind, "date_created": None}
            for i, kind in enumerate(kinds)
        ]
        self.sources = {}
        for photo in self.photos[:-1]:  # the last one's file is missing
            path = os.path.join(self.root, photo["file_hash"])
            with open(path, "wb") as f:
                f.write(b"\xff\xd8\xff")
            self.sources[photo["file_hash"]] = path
        self.extractor = PhotoExtractor()
        self.extractor.list_photos = lambda backup, offset=0, limit=100, album_id=None: {
            "photos": self.photos[offset:offset + limit], "total": len(self.photos),
        }
        self.extractor._resolve_file = lambda backup, file_hash: self.sources.get(file_hash)
        self.sent = []

    def tearDown(self):
        self._tmp.cleanup()

    def _export(self, interval, **options):
        with mock.patch.object(ExportProgress, "INTERVAL", interval):
            return self.extractor.export_photos(
                object(), os.path.join(self.root, "out"), options,
                on_progress=lambda *a: self.sent.append(a),
            )

    def test_reports_each_file_against_the_total_it_will_save(self):
        # As the app saves: no Live Photo videos, so 5 to save
        result = self._export(0, include_live_photo_videos=False)
        self.assertEqual((result["exported"], result["errors"]), (4, 1))
        self.assertEqual(self.sent, [
            (0, 5, 0), (1, 5, 0), (2, 5, 0), (3, 5, 0),
            (3, 5, 0),  # the Live Photo, left out, doesn't move it
            (4, 5, 0),
            (5, 5, 1),  # the missing file
        ])

    def test_total_counts_what_the_options_leave_in(self):
        self._export(0)
        self.assertEqual({total for _, total, _ in self.sent}, {6})
        self.sent.clear()
        self._export(0, include_videos=False, include_live_photo_videos=False)
        self.assertEqual({total for _, total, _ in self.sent}, {4})
        self.assertEqual(self.sent[-1], (4, 4, 1))

    def test_a_quick_save_sends_only_the_first_and_last(self):
        self._export(3600)
        self.assertEqual(self.sent, [(0, 6, 0), (6, 6, 1)])

    def test_an_empty_library_reports_nothing_to_save(self):
        self.photos.clear()
        self._export(0)
        self.assertEqual(self.sent, [(0, 0, 0)])

    def test_saves_without_a_callback(self):
        result = self.extractor.export_photos(object(), os.path.join(self.root, "out"))
        self.assertEqual(result["exported"], 5)


class ExportProgressNotificationTests(unittest.TestCase):
    def test_progress_goes_to_the_app_as_export_progress(self):
        server = load_engine_module().SidecarServer()
        sent = []
        server.send_notification = lambda method, params: sent.append((method, params))
        server._export_progress("photos")(1234, 5678, 2)
        self.assertEqual(sent, [
            ("export.progress", {"kind": "photos", "done": 1234, "total": 5678, "failed": 2}),
        ])

    def test_saving_chats_goes_to_the_app_as_export_progress(self):
        server = load_engine_module().SidecarServer()
        sent = []
        server.send_notification = lambda method, params: sent.append((method, params))
        server._chat_progress("whatsapp", chats=4).read(500, 1000)
        self.assertEqual(sent, [
            ("export.progress", {"kind": "whatsapp", "done": 500, "total": 1000, "failed": 0,
                                 "phase": "reading", "chat": 1, "chats": 4, "percent": 1}),
        ])


if __name__ == "__main__":
    unittest.main()
