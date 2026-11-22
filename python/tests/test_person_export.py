"""
Saving everything with one person (python/person_export.py, engine method export_person).

The readers here are fakes in the shapes ios-backup-core returns (fictional
people and text): Messages pages newest first, WhatsApp chats in arrival
order, calls with integer and text ids ("ft_3", "vm_9"), voicemails with
their recordings. What must hold:

  * every format (html, pdf_source with and without media_dir, csv, txt)
    holds every item, merged by date, with reaction rows left out;
  * each source has its own file writer, so ids that collide (a Messages
    attachment and a WhatsApp one both numbered 5) never share a file;
  * every original is copied, voicemail recordings included; a file the
    backup lacks or can't give is counted and labelled, never fatal;
  * a save never overwrites anything, for a PDF's media folder too;
  * a WhatsApp store that can't be read doesn't cost the rest;
  * the page escapes everything a message or a file name could carry, its
    links are relative (the page and its folder can be moved together), and
    each source's bubbles keep their own scoped look.
"""

import csv
import errno
import html
import os
import re
import shutil
import sys
import tempfile
import unittest
from datetime import timezone
from types import SimpleNamespace
from unittest import mock
from urllib.parse import unquote

from PIL import Image

HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.join(HERE, ".."))
sys.path.insert(0, HERE)
import person_export  # noqa: E402
from messages import MessageExtractor  # noqa: E402
from person_export import CSV_HEADER, NOTHING_TO_SAVE, PersonExporter  # noqa: E402
from save_files import NO_ROOM_FOR_PDF, NO_ROOM_TO_DECRYPT, SaveStopped  # noqa: E402
from whatsapp import SHARED_DOMAIN, WhatsAppExtractor  # noqa: E402

UNREADABLE = "WhatsApp is in this backup but could not be read. The backup may be incomplete or damaged."
D = "2024-03-01T12:{:02d}:00+00:00".format
SMS_DIR = "Library/SMS/Attachments/ab"
AMR = b"#!AMR\n" + bytes(16)


# ── Fakes ────────────────────────────────────────────────────────────────────

class FakeBackup:
    """Files by (domain, relative path); a path in ``broken`` raises, like a damaged entry."""

    def __init__(self):
        self.files = {}
        self.broken = set()

    def get_file(self, relative_path, domain="HomeDomain"):
        if (domain, relative_path) in self.broken:
            raise RuntimeError("damaged entry")
        return self.files.get((domain, relative_path))


def fake_messages(chats: dict) -> MessageExtractor:
    """The Messages adapter, reading ``chats`` (chat id -> messages, oldest first) a page at a time, newest page first."""
    ext = MessageExtractor.__new__(MessageExtractor)
    ext.pages_read = 0

    def get_messages(backup, chat_id, contacts, offset=0, limit=100, date_from=None, date_to=None):
        ext.pages_read += 1
        messages = chats.get(chat_id, [])
        newest_first = list(reversed(messages))[offset:offset + limit]
        return {"messages": list(reversed(newest_first)), "total": len(messages),
                "next_offset": offset + len(newest_first), "offset": offset, "limit": limit}

    ext.get_messages = get_messages
    return ext


class FakeWhatsApp:
    """Pages chats like ios-backup-core: newest page first, each page in arrival order."""

    def __init__(self, chats, error=None, empty_reason=None):
        self.chats, self.error, self.empty_reason = chats, error, empty_reason

    def get_messages(self, backup, chat_id, contacts, offset=0, limit=100, date_from=None, date_to=None):
        if self.error or self.empty_reason:
            out = {"messages": [], "total": 0, "next_offset": offset, "offset": offset, "limit": limit}
            if self.error:
                out["error"] = self.error
            if self.empty_reason:
                out["empty_reason"] = self.empty_reason
            return out
        messages = self.chats.get(chat_id, [])
        newest_first = list(reversed(messages))[offset:offset + limit]
        return {"messages": list(reversed(newest_first)), "total": len(messages), "offset": offset,
                "limit": limit, "next_offset": offset + len(newest_first)}


class FakeCalls:
    def __init__(self, calls, result=None):
        self.calls, self.result = calls, result

    def list_calls(self, backup, contacts, offset=0, limit=200):
        if self.result is not None:
            return self.result
        return {"calls": self.calls[offset:offset + limit], "total": len(self.calls), "offset": offset, "limit": limit}


class FakeVoicemail:
    def __init__(self, voicemails, audio):
        self.voicemails = voicemails
        self._inner = SimpleNamespace(get_audio_path=lambda backup, vm_id: audio.get(str(vm_id)))

    def list_voicemails(self, backup, contacts, include_deleted=False):
        assert include_deleted, "a person's save lists deleted voicemails too"
        return {"voicemails": list(self.voicemails)}


class FakeNotes:
    """list_notes as ios-backup-core gives it; ``error`` makes it raise, like a damaged NoteStore."""

    def __init__(self, notes, error=None):
        self.notes, self.error = notes, error

    def list_notes(self, backup):
        if self.error:
            raise RuntimeError(self.error)
        return {"notes": list(self.notes), "total": len(self.notes)}


def note(note_id, created, title, body="", shared_with=None):
    return {"note_id": note_id, "title": title, "body": body, "created": created, "modified": created,
            "shared_with": shared_with or []}


def sms(message_id, date, text="", *, from_me=False, sender="Riley Sample", attachments=None, reaction=False,
        service="iMessage", message_type="text"):
    return {"message_id": message_id, "date": date, "text": text, "message_type": message_type, "event_text": None,
            "link_preview": None, "is_from_me": from_me, "sender": "me" if from_me else sender,
            "sender_handle": "+12025550101", "service": service, "has_attachments": bool(attachments),
            "attachments": attachments or [], "is_reaction": reaction}


def sms_att(att_id, name, mime, **extra):
    return {"attachment_id": att_id, "filename": f"~/{SMS_DIR}/{att_id}/{name}", "mime_type": mime,
            "transfer_name": name, "total_bytes": 0, **extra}


def wa(message_id, sort, date, text="", *, from_me=False, sender="Riley Sample", message_type="text",
       event_text=None, attachments=None, quoted=None, reactions=None):
    return {"message_id": message_id, "sort": sort, "date": date, "text": text, "message_type": message_type,
            "event_text": event_text, "is_from_me": from_me, "sender": "me" if from_me else sender,
            "sender_handle": "", "sender_jid": "", "has_attachments": bool(attachments),
            "attachments": attachments or [], "is_reaction": False, "quoted": quoted, "reactions": reactions or [],
            "call": None, "location": None, "received_date": None, "event_code": None, "starred": False,
            "vcard": None, "link_preview": None}


def wa_att(att_id, rel, mime, available=True, transfer_name=None):
    return {"attachment_id": att_id, "filename": rel if available else "", "mime_type": mime,
            "transfer_name": transfer_name or os.path.basename(rel), "total_bytes": None, "thumbnail_path": None,
            "width": None, "height": None, "duration": None, "available": available}


def call(call_id, date, *, direction="incoming", status="answered", duration=0, app="Phone",
         name="Riley Sample", address="+12025550101"):
    return {"call_id": call_id, "address": address, "contact_name": name, "date": date, "duration": duration,
            "direction": direction, "status": status, "app": app}


def voicemail(vm_id, date, *, duration=20, transcript="", folder="voicemail", name="Riley Sample",
              number="+12025550101", is_spam=False):
    return {"id": vm_id, "phone_number": number, "contact_name": name, "date_received": date,
            "duration": duration, "is_read": True, "transcript": transcript, "folder": folder,
            "is_spam": is_spam, "is_deleted": folder == "deleted"}


# ── The base case ────────────────────────────────────────────────────────────

class PersonExportCase(unittest.TestCase):

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = tmp.name
        self.src = os.path.join(self.root, "backup-files")
        self.out = os.path.join(self.root, "out")
        os.makedirs(self.src)
        os.makedirs(self.out)
        self.backup = FakeBackup()
        self.sms_chats, self.wa_chats = {}, {}
        self.calls, self.voicemails, self.vm_audio = [], [], {}
        self.notes, self.notes_error = [], None
        self.wa_error = None
        self.calls_result = None
        self.progress = []
        self.messages = None

    # files in the fake backup

    def _write(self, data=None, image=None, size=(40, 30), color=(10, 120, 200)) -> tuple:
        path = os.path.join(self.src, f"f{len(os.listdir(self.src))}")
        if image:
            Image.new("RGB", size, color).save(path, image)
        else:
            with open(path, "wb") as f:
                f.write(data if data is not None else os.urandom(64))
        with open(path, "rb") as f:
            return path, f.read()

    def sms_file(self, att, **kwargs) -> bytes:
        path, data = self._write(**kwargs)
        self.backup.files[("MediaDomain", att["filename"][2:])] = path
        return data

    def wa_file(self, rel, **kwargs) -> bytes:
        path, data = self._write(**kwargs)
        self.backup.files[(SHARED_DOMAIN, rel)] = path
        return data

    def vm_file(self, vm_id, data=AMR) -> bytes:
        path, data = self._write(data=data)
        self.vm_audio[str(vm_id)] = path
        return data

    # the save

    def exporter(self) -> PersonExporter:
        self.messages = fake_messages(self.sms_chats)
        whatsapp = WhatsAppExtractor()
        whatsapp._inner = FakeWhatsApp(self.wa_chats, error=self.wa_error)
        exporter = PersonExporter(self.messages, whatsapp, FakeCalls(self.calls, self.calls_result),
                                  FakeVoicemail(self.voicemails, self.vm_audio),
                                  FakeNotes(self.notes, self.notes_error))
        exporter.local_tz = timezone.utc
        return exporter

    def export(self, fmt="html", output_dir=None, **params) -> dict:
        args = dict(display_name="Riley Sample", chat_ids=list(self.sms_chats), whatsapp_chat_ids=list(self.wa_chats),
                    call_ids=[c["call_id"] for c in self.calls], voicemail_ids=[v["id"] for v in self.voicemails])
        args.update(params)
        return self.exporter().export(self.backup, {}, output_dir or self.out, fmt,
                                      on_progress=lambda done, total, failed: self.progress.append((done, total, failed)),
                                      **args)

    def ok(self, fmt="html", **params) -> dict:
        result = self.export(fmt, **params)
        self.assertNotIn("error", result, result)
        return result

    @staticmethod
    def read(path, encoding="utf-8") -> str:
        with open(path, encoding=encoding) as f:
            return f.read()

    def standard(self):
        """One person in every source, interleaved by date, with ids that collide across sources."""
        self.photo = sms_att(5, "IMG_0005.jpg", "image/jpeg")
        self.clip = sms_att(6, "clip.mov", "video/quicktime")
        self.sms_photo = self.sms_file(self.photo, image="JPEG", color=(200, 30, 30))
        self.sms_clip = self.sms_file(self.clip, data=b"fictional movie " * 4)
        self.wa_photo_att = wa_att(5, "Message/Media/r/a/IMG_0005.jpg", "image/jpeg")
        self.wa_voice_att = wa_att(6, "Message/Media/r/a/voice.opus", "audio/ogg")
        self.wa_photo = self.wa_file(self.wa_photo_att["filename"], image="JPEG", color=(30, 200, 30))
        self.wa_voice = self.wa_file(self.wa_voice_att["filename"], data=b"OggS fictional voice note")
        self.sms_chats[1] = [
            sms(1, D(0), "first sms"),
            sms(2, D(3), "Loved “first sms”", reaction=True),
            sms(3, D(4), "look at this", attachments=[self.photo, self.clip]),
            sms(4, D(9), "last sms", from_me=True),
        ]
        self.wa_chats[1] = [  # the same chat id as the Messages conversation: a different chat
            wa(101, 1, D(1), "wa hello"),
            wa(102, 2, D(7), "", attachments=[self.wa_photo_att], message_type="image"),
            wa(103, 3, D(8), "", from_me=True, attachments=[self.wa_voice_att], message_type="audio"),
        ]
        self.calls = [
            call(5, D(2), direction="outgoing", duration=65),
            call("ft_3", D(6), app="FaceTime Video", duration=30),
            call("vm_9", "2024-03-01T12:08:30+00:00", status="missed"),
        ]
        self.voicemails = [voicemail(7, D(5), transcript="Call me back")]
        self.vm_bytes = self.vm_file(7)
        # What each item shows, in date order
        self.markers = ["first sms", "wa hello", "Outgoing call", "look at this", "Call me back",
                        "FaceTime video call", "wa5-IMG_0005.jpg", "wa6-voice.opus", "Missed call", "last sms"]

    def assert_in_order(self, text, markers):
        positions = [text.find(m) for m in markers]
        self.assertNotIn(-1, positions, [m for m, p in zip(markers, positions) if p < 0])
        self.assertEqual(positions, sorted(positions), markers)


# ── Every format ─────────────────────────────────────────────────────────────

class TestEveryFormat(PersonExportCase):

    def setUp(self):
        super().setUp()
        self.standard()

    def test_counts_and_merged_order_in_html(self):
        result = self.ok("html")
        self.assertEqual(result["counts"], {"message": 3, "whatsapp": 3, "call": 3, "voicemail": 1})
        self.assertEqual(result["message_count"], 10)
        self.assertEqual(result["media"], {"copied": 5, "not_in_backup": 0, "failed": 0})
        self.assertEqual(result["errors"], {})
        page = self.read(result["file"])
        self.assert_in_order(page, self.markers)
        self.assertNotIn("Loved", page)  # a reaction row isn't an item

    def test_file_name_says_who_and_when_and_sits_in_the_folder_chosen(self):
        result = self.ok("html")
        self.assertEqual(os.path.basename(result["file"]), "Riley Sample, Mar 1 2024.html")
        self.assertEqual(result["media_folder"], os.path.join(self.out, "Riley Sample, Mar 1 2024_attachments"))

    def test_every_original_is_copied_and_colliding_ids_keep_their_own_files(self):
        result = self.ok("html")
        folder = result["media_folder"]

        def content(name):
            with open(os.path.join(folder, name), "rb") as f:
                return f.read()

        self.assertEqual(content("5-IMG_0005.jpg"), self.sms_photo)
        self.assertEqual(content("wa5-IMG_0005.jpg"), self.wa_photo)
        self.assertNotEqual(self.sms_photo, self.wa_photo)
        self.assertEqual(content("6-clip.mov"), self.sms_clip)
        self.assertEqual(content("wa6-voice.opus"), self.wa_voice)
        self.assertEqual(content("vm7-Riley Sample 2024-03-01.amr"), self.vm_bytes)
        self.assertEqual(sorted(os.listdir(folder)), sorted([
            "5-IMG_0005.jpg", "6-clip.mov", "wa5-IMG_0005.jpg", "wa6-voice.opus", "vm7-Riley Sample 2024-03-01.amr"]))

    def test_html_shows_photos_plays_video_and_voice_notes_and_links_the_recording(self):
        result = self.ok("html")
        page = self.read(result["file"])
        rel = re.escape("Riley%20Sample%2C%20Mar%201%202024_attachments")
        self.assertRegex(page, rf'<img src="{rel}/5-IMG_0005.jpg"')
        self.assertRegex(page, rf'<img src="{rel}/wa5-IMG_0005.jpg"')
        self.assertRegex(page, rf'<video controls[^>]* src="{rel}/6-clip.mov#t=0.001"')
        self.assertRegex(page, rf'<audio controls[^>]* src="{rel}/wa6-voice.opus"')
        self.assertRegex(page, rf'<a href="{rel}/vm7-Riley%20Sample%202024-03-01.amr"[^>]*>Recording: ')
        self.assertIn("Call me back", page)

    def test_each_bubble_says_where_it_came_from(self):
        self.sms_chats[1].append(sms(8, D(10), "an sms", service="SMS"))
        page = self.read(self.ok("html")["file"])
        self.assertIn('<div class="item imessage received"><div class="meta">12:00 PM · <span class="src">Messages</span>', page)
        self.assertIn('<div class="item imessage received sms"><div class="meta">12:10 PM · <span class="src">SMS</span>', page)
        self.assertIn('<div class="item whatsapp received"><div class="meta">12:01 PM · <span class="src">WhatsApp</span>', page)
        self.assertIn('<div class="item imessage sent">', page)
        self.assertIn('<div class="item whatsapp sent">', page)

    def test_csv(self):
        result = self.ok("csv")
        self.assertTrue(result["file"].endswith("Riley Sample, Mar 1 2024.csv"))
        with open(result["file"], "rb") as f:
            self.assertTrue(f.read().startswith(b"\xef\xbb\xbf"))  # utf-8-sig, so Excel reads it as UTF-8
        with open(result["file"], newline="", encoding="utf-8-sig") as f:
            rows = list(csv.reader(f))
        self.assertEqual(rows[0], CSV_HEADER)
        body = rows[1:]
        self.assertEqual(len(body), 10)
        self.assertEqual([r[1] for r in body],
                         ["Messages", "WhatsApp", "Call", "Messages", "Voicemail", "Call", "WhatsApp", "WhatsApp",
                          "Call", "Messages"])
        by_text = {r[5]: r for r in body}
        photo_row = by_text["look at this"]
        self.assertEqual(photo_row[6], "Image: IMG_0005.jpg; Video: clip.mov")
        folder = "Riley Sample, Mar 1 2024_attachments"
        self.assertEqual(photo_row[7], f"{folder}/5-IMG_0005.jpg; {folder}/6-clip.mov")
        for row in body:
            for rel in filter(None, row[7].split("; ")):
                self.assertTrue(os.path.isfile(os.path.join(self.out, *rel.split("/"))), rel)
        outgoing = by_text["Outgoing call"]
        self.assertEqual((outgoing[3], outgoing[4], outgoing[8]), ("Outgoing", "me", "65"))
        vm = by_text["Voicemail"]
        self.assertEqual((vm[3], vm[6], vm[9]), ("Received", "Recording", "Call me back"))
        self.assertEqual(vm[7], f"{folder}/vm7-Riley Sample 2024-03-01.amr")
        self.assertEqual(vm[4], "Riley Sample (+12025550101)")
        self.assertEqual(body[0][0], "2024-03-01T12:00:00+00:00")
        self.assertEqual(by_text["last sms"][3:5], ["Sent", "me"])

    def test_csv_cells_never_become_formulas(self):
        self.sms_chats[1].append(sms(9, D(11), '=HYPERLINK("https://example.com","x")', sender="+1 555 0100"))
        with open(self.ok("csv")["file"], newline="", encoding="utf-8-sig") as f:
            rows = list(csv.reader(f))
        last = rows[-1]
        self.assertEqual(last[5], '\'=HYPERLINK("https://example.com","x")')
        self.assertEqual(last[4], "'+1 555 0100")

    def test_txt(self):
        self.wa_chats[2] = [wa(201, 1, D(10), "group hello", sender="Casey")]
        result = self.ok("txt", whatsapp_names={"1": "Riley Sample", "2": "Weekend Plans"})
        self.assertTrue(result["file"].endswith(".txt"))
        text = self.read(result["file"], encoding="utf-8-sig")
        lines = text.splitlines()
        self.assertEqual(len(lines), 11)
        self.assertEqual(lines[0], "[Mar 1, 2024, 12:00 PM] (Messages) Riley Sample: first sms")
        folder = "Riley Sample, Mar 1 2024_attachments"
        self.assertIn(f"Riley Sample: look at this [Image: IMG_0005.jpg -> {folder}/5-IMG_0005.jpg] "
                      f"[Video: clip.mov -> {folder}/6-clip.mov]", text)
        self.assertIn(f"(WhatsApp) Riley Sample: [Photo: IMG_0005.jpg -> {folder}/wa5-IMG_0005.jpg]", text)
        self.assertIn("(Call) Outgoing call · Riley Sample (+12025550101) · 1 min 5 s", text)
        self.assertIn(f"(Voicemail) Voicemail · Riley Sample (+12025550101) · 20 s "
                      f"[Recording -> {folder}/vm7-Riley Sample 2024-03-01.amr] Transcript: “Call me back”",
                      text)
        self.assertIn("(WhatsApp, in Weekend Plans) Casey: group hello", text)
        self.assert_in_order(text, ["first sms", "wa hello", "Outgoing call", "look at this", "Call me back",
                                    "FaceTime video call", "wa5-", "wa6-", "Missed call", "last sms", "group hello"])

    def test_pdf_source_without_a_media_folder_draws_images_and_labels_the_rest(self):
        result = self.ok("pdf_source")
        page = self.read(result["file"])
        self.assertEqual(os.path.dirname(result["file"]), self.out)
        self.assertEqual(set(re.findall(r'<img src="(attachments/[^"]+)"', page)),
                         {"attachments/5.jpg", "attachments/wa5.jpg"})
        for rel in ("attachments/5.jpg", "attachments/wa5.jpg"):
            with Image.open(os.path.join(self.out, rel)) as img:
                self.assertEqual(img.format, "JPEG")
        self.assertIn("[Video: clip.mov]", page)
        self.assertIn("Voice message: voice.opus", page)
        self.assertIn("[Audio: voicemail recording]", page)
        self.assertNotIn("<video", page)
        self.assertNotIn("<audio", page)
        self.assertNotIn("_attachments", page)
        self.assertNotIn("media_folder", result)
        self.assertEqual(sorted(os.listdir(self.out)), ["Riley Sample, Mar 1 2024.html", "attachments"])
        self.assertEqual(result["media"]["copied"], 2)  # the images drawn

    def test_pdf_source_with_a_media_folder_copies_every_original_there_and_names_each(self):
        staging = os.path.join(self.root, "staging")
        chosen = os.path.join(self.root, "chosen")
        os.makedirs(staging)
        os.makedirs(chosen)
        result = self.ok("pdf_source", output_dir=staging, media_dir=chosen)
        self.assertEqual(result["file"], os.path.join(staging, "Riley Sample, Mar 1 2024.html"))
        folder = os.path.join(chosen, "Riley Sample, Mar 1 2024_attachments")
        self.assertEqual(result["media_folder"], folder)
        self.assertEqual(sorted(os.listdir(folder)), sorted([
            "5-IMG_0005.jpg", "6-clip.mov", "wa5-IMG_0005.jpg", "wa6-voice.opus", "vm7-Riley Sample 2024-03-01.amr"]))
        with open(os.path.join(folder, "5-IMG_0005.jpg"), "rb") as f:
            self.assertEqual(f.read(), self.sms_photo)  # the original, not the PDF's copy
        self.assertEqual(result["media"], {"copied": 5, "not_in_backup": 0, "failed": 0})
        page = self.read(result["file"])
        note = "in the “Riley Sample, Mar 1 2024_attachments” folder"
        self.assertIn(f"[Video: clip.mov]</div><div class=\"attachment-link\">Saved as 6-clip.mov {note}", page)
        self.assertIn(f"Saved as wa6-voice.opus {note}", page)
        self.assertIn(f"Recording saved as vm7-Riley Sample 2024-03-01.amr {note}", page)
        self.assertNotIn("Saved as 5-IMG_0005.jpg", page)  # a photo is on the page itself
        # No links into the media folder: they would point into the staging folder, which is deleted
        self.assertNotIn("href=\"Riley", page)
        self.assertIn("next to this PDF", page)
        self.assertEqual(os.listdir(chosen), ["Riley Sample, Mar 1 2024_attachments"])  # Electron writes the PDF

    def test_unsupported_format(self):
        for fmt in ("docx", "pdf", "md", None):
            self.assertEqual(self.export(fmt), {"error": f"Unsupported format: {fmt}"})
        self.assertEqual(os.listdir(self.out), [])

    def test_progress_counts_items_and_files_and_ends_at_the_total(self):
        self.ok("html")
        total = 10 + 5  # items, and their files
        self.assertTrue(self.progress)
        self.assertEqual({t for _, t, _ in self.progress}, {total})
        done = [d for d, _, _ in self.progress]
        self.assertEqual(done, sorted(done))
        self.assertEqual((done[0], done[-1]), (0, total))
        self.assertEqual(done.count(total), 1)

    def test_media_dir_is_ignored_for_other_formats(self):
        chosen = os.path.join(self.root, "chosen")
        result = self.ok("html", media_dir=chosen)
        self.assertEqual(os.path.dirname(result["media_folder"]), self.out)
        self.assertFalse(os.path.exists(chosen))


# ── Reading ──────────────────────────────────────────────────────────────────

class TestReading(PersonExportCase):

    def test_whole_chats_are_read_past_one_page(self):
        self.sms_chats[3] = [sms(i, f"2024-01-01T00:{i // 60 % 60:02d}:{i % 60:02d}+00:00", f"m{i}")
                             for i in range(1, 1201)]
        result = self.ok("csv")
        self.assertEqual(result["counts"]["message"], 1200)
        self.assertGreaterEqual(self.messages.pages_read, 3)

    def test_a_message_in_two_of_the_persons_chats_is_saved_once(self):
        shared = sms(7, D(1), "in both")
        self.sms_chats[1] = [sms(6, D(0), "phone"), shared]
        self.sms_chats[2] = [dict(shared), sms(8, D(2), "email")]
        result = self.ok("txt")
        self.assertEqual(result["counts"]["message"], 3)
        self.assertEqual(self.read(result["file"], encoding="utf-8-sig").count("in both"), 1)

    def test_call_ids_compare_as_text(self):
        self.calls = [call(5, D(0)), call("ft_3", D(1), app="FaceTime Audio"), call("vm_9", D(2), status="missed"),
                      call(6, D(3), name="Someone else")]
        result = self.ok("csv", call_ids=["5", "ft_3", "vm_9"])
        self.assertEqual(result["counts"]["call"], 3)
        self.assertNotIn("Someone else", self.read(result["file"], encoding="utf-8-sig"))
        result = self.ok("csv", call_ids=[5, 6])
        self.assertEqual(result["counts"]["call"], 2)

    def test_voicemail_ids_from_an_account_store_and_every_list(self):
        account_id = "A-0B1C2D3E-4F50-4A6B-8C7D-9E0F1A2B3C4D.7"
        self.voicemails = [voicemail(account_id, D(0), transcript="from the account store"),
                           voicemail(3, D(1), folder="deleted", is_spam=True), voicemail(4, D(2)),
                           voicemail(5, D(3), name="Someone else")]
        data = self.vm_file(account_id)
        result = self.ok("html", voicemail_ids=[account_id, 3, "4"])
        self.assertEqual(result["counts"]["voicemail"], 3)
        self.assertEqual(result["media"], {"copied": 1, "not_in_backup": 2, "failed": 0})
        name = "vmA-0B1C2D3E-4F50-4A6B-8C7D-9E0F1A2B3C4D_7-Riley Sample 2024-03-01.amr"
        with open(os.path.join(result["media_folder"], name), "rb") as f:
            self.assertEqual(f.read(), data)
        page = self.read(result["file"])
        self.assertIn("Voicemail (marked as spam, deleted)", page)
        self.assertEqual(page.count("Recording not in this backup"), 2)
        self.assertNotIn("Someone else", page)

    def test_whatsapp_keeps_its_arrival_order_inside_the_merge(self):
        # Arrived second, though its sender's clock put it before the first.
        self.wa_chats[1] = [wa(1, 1, D(5), "arrived first"), wa(2, 2, D(1), "arrived second, stamped early"),
                            wa(3, 3, D(6), "arrived third")]
        self.sms_chats[1] = [sms(1, D(0), "sms at 0"), sms(2, D(7), "sms at 7")]
        text = self.read(self.ok("txt")["file"], encoding="utf-8-sig")
        self.assert_in_order(text, ["sms at 0", "arrived first", "arrived second", "arrived third", "sms at 7"])

    def test_a_late_whatsapp_message_keeps_its_own_date_under_the_days_heading(self):
        self.wa_chats[1] = [wa(1, 1, "2024-03-02T09:00:00+00:00", "Saturday"),
                            wa(2, 2, "2024-03-01T23:00:00+00:00", "sent Friday, arrived Saturday")]
        page = self.read(self.ok("html")["file"])
        self.assertEqual(page.count('<div class="day">'), 1)
        self.assertIn("Mar 1, 2024, 11:00 PM", page)

    def test_a_whatsapp_store_problem_keeps_the_messages_calls_and_voicemail(self):
        self.standard()
        self.wa_error = UNREADABLE
        result = self.ok("html")
        self.assertEqual(result["errors"], {"whatsapp": UNREADABLE})
        self.assertEqual(result["counts"], {"message": 3, "whatsapp": 0, "call": 3, "voicemail": 1})
        page = self.read(result["file"])
        self.assertIn("first sms", page)
        self.assertNotIn("wa hello", page)

    def test_whatsapp_missing_from_the_backup_is_reported(self):
        self.sms_chats[1] = [sms(1, D(0), "hi")]
        self.wa_chats[1] = [wa(1, 1, D(1), "never read")]
        exporter = self.exporter()
        exporter.whatsapp._inner = FakeWhatsApp({}, empty_reason="not_in_backup")
        result = exporter.export(self.backup, {}, self.out, "txt", display_name="Riley", chat_ids=[1],
                                 whatsapp_chat_ids=[1])
        self.assertEqual(result["errors"], {"whatsapp": "WhatsApp is not in this backup"})
        self.assertEqual(result["counts"]["message"], 1)

    def test_nothing_to_save(self):
        self.assertEqual(self.export("html"), {"error": NOTHING_TO_SAVE, "errors": {}})
        self.wa_chats[1] = [wa(1, 1, D(0), "unreadable")]
        self.wa_error = UNREADABLE
        self.assertEqual(self.export("html"), {"error": UNREADABLE, "errors": {"whatsapp": UNREADABLE}})
        self.assertEqual(os.listdir(self.out), [])

    def test_call_history_that_needs_encryption_is_not_an_error(self):
        self.sms_chats[1] = [sms(1, D(0), "hi")]
        self.calls_result = {"calls": [], "total": 0, "empty_reason": "requires_encryption",
                             "error": "Call history not found. Apple requires backups to be encrypted..."}
        result = self.ok("txt", call_ids=["vm_1"])
        self.assertEqual(result["errors"], {})
        self.calls_result = {"calls": [], "total": 0, "error": "Call history is in this backup but could not be read."}
        result = self.ok("txt", call_ids=[1])
        self.assertEqual(result["errors"], {"call": "Call history is in this backup but could not be read."})

    def test_a_conversation_that_fails_to_read_costs_only_itself(self):
        self.sms_chats[1] = [sms(1, D(0), "readable")]
        exporter = self.exporter()
        read = exporter.messages.get_messages

        def flaky(backup, chat_id, *args, **kwargs):
            if chat_id == 2:
                raise RuntimeError("database disk image is malformed")
            return read(backup, chat_id, *args, **kwargs)

        exporter.messages.get_messages = flaky
        result = exporter.export(self.backup, {}, self.out, "txt", display_name="Riley", chat_ids=[2, 1])
        self.assertEqual(result["errors"], {"message": person_export.MESSAGES_UNREADABLE})
        self.assertEqual(result["counts"]["message"], 1)

    def test_names_come_as_json_object_keys(self):
        self.sms_chats[1] = [sms(1, D(0), "hi")]
        self.sms_chats[2] = [sms(2, D(1), "in the group")]
        text = self.read(self.ok("txt", conversation_names={"1": "Riley Sample", "2": "Family"})["file"],
                         encoding="utf-8-sig")
        self.assertIn("(Messages) Riley Sample: hi", text)
        self.assertIn("(Messages, in Family) Riley Sample: in the group", text)


# ── Files ────────────────────────────────────────────────────────────────────

class TestWhatTheScreenPicked(PersonExportCase):
    """People's dates, search or Photos chip pick out some messages: only those are saved, with only their files."""

    def setUp(self):
        super().setUp()
        self.standard()

    def test_only_the_messages_picked_out_with_only_their_files(self):
        result = self.ok("html", message_ids=[3], whatsapp_message_ids=[102], call_ids=[], voicemail_ids=[])
        self.assertEqual(result["counts"], {"message": 1, "whatsapp": 1, "call": 0, "voicemail": 0})
        self.assertEqual(result["media"], {"copied": 3, "not_in_backup": 0, "failed": 0})
        page = self.read(result["file"])
        self.assert_in_order(page, ["look at this", "wa5-IMG_0005.jpg"])
        for gone in ("first sms", "last sms", "wa hello", "wa6-voice.opus"):
            self.assertNotIn(gone, page)

    def test_ids_are_each_sources_own(self):
        # 101 is a WhatsApp id; as a Messages id it picks out nothing
        result = self.ok("csv", message_ids=[101], whatsapp_message_ids=[101], call_ids=[], voicemail_ids=[])
        self.assertEqual(result["counts"], {"message": 0, "whatsapp": 1, "call": 0, "voicemail": 0})

    def test_none_picked_from_a_source_is_none_and_absent_is_the_whole_chat(self):
        result = self.ok("txt", message_ids=[], call_ids=[], voicemail_ids=[])
        self.assertEqual(result["counts"], {"message": 0, "whatsapp": 3, "call": 0, "voicemail": 0})
        self.assertEqual(self.ok("txt")["counts"]["message"], 3)

    def test_ids_that_arent_numbers_are_skipped(self):
        result = self.ok("csv", message_ids=["4", "x", None, True], whatsapp_message_ids=[], call_ids=[], voicemail_ids=[])
        self.assertEqual(result["counts"]["message"], 1)


class TestSharedNotes(PersonExportCase):

    def setUp(self):
        super().setUp()
        self.sms_chats[1] = [sms(1, D(0), "first sms"), sms(2, D(9), "last sms", from_me=True)]
        self.notes = [
            note(41, D(4), "Trip packing list", "tent\nstove <and> fuel", shared_with=[{"name": "Riley", "email": None, "phone": "+12025550101"}]),
            note("42", D(5), "Someone else's", "not hers"),
        ]

    def test_a_shared_note_is_in_every_format_in_date_order(self):
        page = self.read(self.ok("html", note_ids=["41"])["file"])
        self.assert_in_order(page, ["first sms", "Trip packing list", "stove &lt;and&gt; fuel", "last sms"])
        self.assertIn('<span class="src">Shared note</span>', page)
        self.assertNotIn("<and>", page)
        self.assertNotIn("not hers", page)
        self.assertIn("2 messages · 1 shared note", page)
        rows = list(csv.reader(open(self.ok("csv", note_ids=[41])["file"], encoding="utf-8-sig")))
        self.assertEqual(rows[2][1:3], ["Shared note", ""])
        self.assertEqual(rows[2][5], "“Trip packing list”\ntent\nstove <and> fuel")
        text = self.read(self.ok("txt", note_ids=[41])["file"], encoding="utf-8-sig")
        self.assertIn("(Shared note) “Trip packing list”\n    tent\n    stove <and> fuel\n", text)

    def test_a_notes_title_isnt_repeated_at_the_top_of_its_text(self):
        # A real note's text starts with its title, which is already its heading
        self.notes = [note(43, D(4), "Trip packing list", "Trip packing list\ntent\nstove")]
        page = self.read(self.ok("html", note_ids=[43])["file"])
        self.assertEqual(page.count("Trip packing list"), 1)
        self.assertIn('<div class="note-body">tent<br>stove</div>', page)
        text = self.read(self.ok("txt", note_ids=[43])["file"], encoding="utf-8-sig")
        self.assertIn("(Shared note) “Trip packing list”\n    tent\n    stove\n", text)
        # A note that is only its title
        self.notes = [note(44, D(4), "Call the vet", "Call the vet")]
        rows = list(csv.reader(open(self.ok("csv", note_ids=[44])["file"], encoding="utf-8-sig")))
        self.assertEqual(rows[2][5], "“Call the vet”")

    def test_counts_name_notes_only_when_there_are_some(self):
        self.assertEqual(self.ok("csv", note_ids=[41, "42"])["counts"]["note"], 2)
        self.assertNotIn("note", self.ok("csv")["counts"])

    def test_notes_alone_are_something_to_save(self):
        result = self.ok("html", chat_ids=[], note_ids=[41])
        self.assertEqual(result["message_count"], 1)
        self.assertNotIn("media_folder", result)

    def test_notes_that_cant_be_read_cost_only_themselves(self):
        self.notes_error = "damaged NoteStore"
        result = self.ok("csv", note_ids=[41])
        self.assertEqual(result["counts"]["message"], 2)
        self.assertEqual(result["errors"], {"note": person_export.NOTES_UNREADABLE})


class TestFiles(PersonExportCase):

    def test_missing_and_unreadable_files_are_counted_and_labelled(self):
        present = sms_att(1, "here.jpg", "image/jpeg")
        missing = sms_att(2, "gone.jpg", "image/jpeg")
        damaged = sms_att(3, "damaged.pdf", "application/pdf")
        listed_not_found = sms_att(4, "listed.jpg", "image/jpeg", available=True)
        self.sms_file(present, image="JPEG")
        self.backup.broken.add(("MediaDomain", damaged["filename"][2:]))
        self.sms_chats[1] = [sms(1, D(0), "", attachments=[present, missing, damaged, listed_not_found])]
        self.wa_chats[1] = [wa(1, 1, D(1), "", message_type="image",
                               attachments=[wa_att(9, "Message/Media/x/gone.jpg", "image/jpeg", available=False)])]
        result = self.ok("html")
        self.assertEqual(result["media"], {"copied": 1, "not_in_backup": 2, "failed": 2})
        page = self.read(result["file"])
        self.assertIn("[Image not in this backup: gone.jpg]", page)
        self.assertIn("[File couldn&#x27;t be read: damaged.pdf]", page)
        self.assertIn("[Image couldn&#x27;t be read: listed.jpg]", page)
        self.assertIn("Photo not in this backup: gone.jpg", page)
        self.assertEqual(self.progress[-1][2], 2)  # failed, in the progress too

    def test_photos_browsers_cant_show_get_a_jpeg_beside_the_original(self):
        tiff = sms_att(4, "scan.tiff", "image/tiff")
        data = self.sms_file(tiff, image="TIFF")
        self.sms_chats[1] = [sms(1, D(0), "", attachments=[tiff])]
        result = self.ok("html")
        with open(os.path.join(result["media_folder"], "4-scan.tiff"), "rb") as f:
            self.assertEqual(f.read(), data)
        with Image.open(os.path.join(result["media_folder"], "4-scan.jpg")) as preview:
            self.assertEqual(preview.format, "JPEG")
        self.assertIn("4-scan.jpg", self.read(result["file"]))

    def test_saving_again_never_overwrites(self):
        self.sms_chats[1] = [sms(1, D(0), "hi", attachments=[sms_att(1, "a.jpg", "image/jpeg")])]
        self.sms_file(self.sms_chats[1][0]["attachments"][0], image="JPEG")
        first = self.ok("html")
        second = self.ok("html")
        self.assertEqual(os.path.basename(second["file"]), "Riley Sample, Mar 1 2024 (2).html")
        self.assertEqual(os.path.basename(second["media_folder"]), "Riley Sample, Mar 1 2024 (2)_attachments")
        self.assertIn("Riley%20Sample%2C%20Mar%201%202024%20%282%29_attachments/1-a.jpg", self.read(second["file"]))
        self.assertTrue(os.path.isfile(first["file"]))
        # A folder of the same name left by another save counts too
        os.makedirs(os.path.join(self.out, "Riley Sample, Mar 1 2024 (3)_attachments"))
        third = self.ok("csv")
        self.assertEqual(os.path.basename(third["file"]), "Riley Sample, Mar 1 2024 (4).csv")

    def test_a_pdfs_name_is_free_in_the_media_folder_for_both_the_pdf_and_its_files(self):
        self.sms_chats[1] = [sms(1, D(0), "hi", attachments=[sms_att(1, "a.jpg", "image/jpeg")])]
        self.sms_file(self.sms_chats[1][0]["attachments"][0], image="JPEG")
        chosen = os.path.join(self.root, "chosen")
        os.makedirs(chosen)
        open(os.path.join(chosen, "Riley Sample, Mar 1 2024.pdf"), "w").close()
        os.makedirs(os.path.join(chosen, "Riley Sample, Mar 1 2024 (2)_attachments"))
        staging = os.path.join(self.root, "staging")
        os.makedirs(staging)
        result = self.ok("pdf_source", output_dir=staging, media_dir=chosen)
        self.assertEqual(os.path.basename(result["file"]), "Riley Sample, Mar 1 2024 (3).html")
        self.assertEqual(result["media_folder"], os.path.join(chosen, "Riley Sample, Mar 1 2024 (3)_attachments"))
        self.assertTrue(os.path.isfile(os.path.join(result["media_folder"], "1-a.jpg")))

    def test_no_media_no_folder(self):
        self.sms_chats[1] = [sms(1, D(0), "just words")]
        result = self.ok("html")
        self.assertNotIn("media_folder", result)
        self.assertEqual(os.listdir(self.out), ["Riley Sample, Mar 1 2024.html"])
        self.assertNotIn("files-note", self.read(result["file"]).split("</style>")[1])

    def test_no_files_in_the_backup_no_promise_of_a_folder(self):
        # Every attachment kept off the backup (Messages in iCloud): nothing is copied, so the page
        # mustn't send the reader to a folder that was never made
        self.sms_chats[1] = [sms(1, D(0), "", attachments=[sms_att(1, "a.jpg", "image/jpeg", available=False)])]
        self.wa_chats[1] = [wa(2, 2, D(1), "", message_type="image", attachments=[wa_att(9, "Message/Media/x/gone.jpg", "image/jpeg", available=False)])]
        for fmt in ("html", "pdf_source"):
            result = self.ok(fmt)
            self.assertEqual(result["media"]["copied"], 0, fmt)
            self.assertNotIn("media_folder", result, fmt)
            self.assertNotIn("files-note", self.read(result["file"]).split("</style>")[1], fmt)

    def test_a_full_disk_stops_the_save_and_removes_what_it_wrote(self):
        self.standard()
        with mock.patch.object(person_export.shutil, "copyfile",
                               side_effect=OSError(errno.ENOSPC, "No space left on device")):
            result = self.export("html")
        self.assertEqual(result["error"],
                         "There isn't enough space to save here. Free up some space or choose another folder.")
        self.assertEqual(os.listdir(self.out), [])

    def test_no_room_for_a_preview_stops_the_save_too(self):
        att = sms_att(1, "scan.tiff", "image/tiff")
        self.sms_file(att, image="TIFF")
        self.sms_chats[1] = [sms(1, D(0), "", attachments=[att])]
        with mock.patch("messages.write_whole", side_effect=OSError(errno.ENOSPC, "No space left on device")):
            result = self.export("html")
        self.assertIn("There isn't enough space to save here", result["error"])
        self.assertEqual(os.listdir(self.out), [])

    def test_no_room_to_decrypt_stops_the_save_too(self):
        att = sms_att(1, "a.jpg", "image/jpeg", available=True)
        self.sms_chats[1] = [sms(1, D(0), "", attachments=[att])]

        def full(relative_path, domain):
            raise SaveStopped(NO_ROOM_TO_DECRYPT)

        self.backup.get_file_again = full
        result = self.export("pdf_source")
        self.assertEqual(result["error"], NO_ROOM_TO_DECRYPT)
        self.assertEqual(os.listdir(self.out), [])

    def test_a_folder_that_cant_be_written_to(self):
        self.sms_chats[1] = [sms(1, D(0), "hi")]
        with mock.patch("builtins.open", side_effect=PermissionError(errno.EACCES, "Permission denied")):
            result = self.export("txt")
        self.assertEqual(result["error"], "OpenExtract can't save in that folder. Choose another folder.")
        # A "folder" that is a file can't be made into one
        not_a_folder = os.path.join(self.root, "a file")
        open(not_a_folder, "w").close()
        result = self.export("txt", output_dir=os.path.join(not_a_folder, "inside"))
        self.assertTrue(result["error"].startswith(("The save couldn't finish", "OpenExtract can't save")), result)

    def test_no_room_to_make_the_pdf_doesnt_say_choose_another_folder(self):
        # The pages are staged on this computer's disk, wherever the PDF goes
        att = sms_att(1, "a.jpg", "image/jpeg")
        self.sms_file(att, image="JPEG")
        self.sms_chats[1] = [sms(1, D(0), "", attachments=[att])]
        with mock.patch("messages.write_whole", side_effect=OSError(errno.ENOSPC, "No space left on device")):
            result = self.export("pdf_source")
        self.assertEqual(result["error"], NO_ROOM_FOR_PDF)


# ── The page ─────────────────────────────────────────────────────────────────

class TestPage(PersonExportCase):

    def test_everything_a_message_or_file_name_carries_is_escaped(self):
        evil = '<script>alert("x")</script>'
        att = sms_att(1, '"><img src=x onerror=alert(1)>.jpg', "image/jpeg")
        self.sms_file(att, image="JPEG")
        self.sms_chats[1] = [sms(1, D(0), f"{evil} & more", sender=evil, attachments=[att])]
        self.wa_chats[1] = [wa(1, 1, D(1), evil, sender=evil,
                               quoted={"is_from_me": False, "sender": evil, "text": evil, "message_type": "text"},
                               reactions=[{"emoji": "❤️", "sender": evil, "is_from_me": False}])]
        self.calls = [call(1, D(2), name=evil, address="<b>555</b>", app="<i>App</i>")]
        self.voicemails = [voicemail(1, D(3), transcript=f"</div>{evil}", name=evil)]
        self.vm_file(1)
        for fmt in ("html", "pdf_source"):
            out = os.path.join(self.root, fmt)
            os.makedirs(out)
            result = self.ok(fmt, output_dir=out, display_name=evil, conversation_names={"1": evil},
                             whatsapp_names={"1": f"{evil}2"})
            page = self.read(result["file"])
            body = page.split("</style>", 1)[1]
            self.assertNotIn("<script", body)
            self.assertNotIn("<b>555", body)
            self.assertNotIn("<i>App", body)
            self.assertNotIn("onerror=alert(1)>", body)
            self.assertIn(html.escape(evil), body)
            self.assertIn("&lt;/div&gt;", body)
            # Attribute values never break out of their quotes
            for value in re.findall(r'(?:href|src|alt|title)="([^"]*)"', body):
                self.assertNotIn("<", value)
            self.assertIn("<title>Everything with &lt;script&gt;", page)

    def test_links_are_relative_so_the_page_and_its_folder_can_move_together(self):
        self.standard()
        result = self.ok("html")
        moved = os.path.join(self.root, "somewhere else")
        os.makedirs(moved)
        shutil.move(result["file"], moved)
        shutil.move(result["media_folder"], moved)
        page_path = os.path.join(moved, os.path.basename(result["file"]))
        page = self.read(page_path)
        links = [v for v in re.findall(r'(?:href|src)="([^"]+)"', page) if not v.startswith("https://")]
        self.assertGreaterEqual(len(links), 8)
        for link in links:
            self.assertFalse(os.path.isabs(link) or link.startswith(("file:", "/")), link)
            target = os.path.join(moved, unquote(html.unescape(link).split("#")[0]))
            self.assertTrue(os.path.isfile(target), link)

    def test_each_sources_styles_are_scoped(self):
        self.standard()
        page = self.read(self.ok("html")["file"])
        css = page.split("<style>", 1)[1].split("</style>", 1)[0]
        rules = re.findall(r"([^{}]+)\{[^{}]*\}", css.replace("@media print {", ""))
        selectors = [s.strip() for rule in rules for s in rule.split(",")]
        for selector in selectors:
            if re.search(r"\.(sent|received|sender|quote|reactions|system|event|sticker)\b", selector):
                self.assertRegex(selector, r"\.(imessage|whatsapp|item)\b", selector)
        self.assertIn(".imessage.sent .msg", css)
        self.assertIn(".whatsapp.sent .msg", css)
        self.assertNotRegex(css, r"(^|\n)\.sent\b")
        self.assertNotRegex(css, r"(^|\n)\.received\b")

    def test_the_summary_says_what_is_in_it(self):
        self.standard()
        page = self.read(self.ok("html")["file"])
        self.assertIn('<p class="summary">3 messages · 3 WhatsApp messages · 3 calls · 1 voicemail '
                      '· Mar 1, 2024</p>', page)
        self.assertIn("<h1 class=\"person-title\">Riley Sample</h1>", page)
        self.assertIn("Made with OpenExtract", page)

    def test_calls_read_like_the_phone(self):
        self.calls = [
            call(1, D(0), direction="outgoing", status="missed", app="WhatsApp"),
            call(2, D(1), status="missed", app="FaceTime Audio"),
            call(3, D(2), app="Phone", duration=3725),
            call(4, D(3), app="FaceTime Video", direction="outgoing", duration=60),
            call(5, D(4), app="Skype", name="+12025550101"),
        ]
        page = self.read(self.ok("html")["file"])
        for text in ("Outgoing WhatsApp call, not answered", "Missed FaceTime audio call", "Incoming call",
                     "1 h 2 min", "Outgoing FaceTime video call", "1 min", "Incoming Skype call"):
            self.assertIn(text, page)
        self.assertEqual(page.count('class="item log call missed"'), 1)  # an unanswered outgoing call isn't "missed"

    def test_a_display_name_with_nothing_for_a_file_name(self):
        self.sms_chats[1] = [sms(1, D(0), "hi")]
        result = self.ok("txt", display_name='///???')
        self.assertEqual(os.path.basename(result["file"]), "Person, Mar 1 2024.txt")

    def test_half_an_emoji_in_a_name_is_written(self):
        self.sms_chats[1] = [sms(1, D(0), "hi")]
        result = self.ok("html", display_name="Riley \ud83c")
        self.assertIn("Riley �", self.read(result["file"]))


# ── Through the engine ───────────────────────────────────────────────────────

class TestEngineMethod(PersonExportCase):

    def test_export_person_is_served_with_progress_as_person(self):
        from rpc_contract_support import load_engine_module

        self.standard()
        self.notes = [note(41, D(4), "Trip packing list")]
        server = load_engine_module().SidecarServer()
        notifications = []
        server.send_notification = lambda method, params: notifications.append((method, params))
        exporter = self.exporter()
        server.person_exporter = exporter
        server.backup_manager.get_open_backup = lambda udid: self.backup
        server.contact_resolver.load_contacts = lambda backup: {}
        response = server.handle_request({"id": "p-1", "method": "export_person", "params": {
            "udid": "x", "output_dir": self.out, "format": "html", "display_name": "Riley Sample",
            "chat_ids": [1], "conversation_names": {"1": "Riley Sample"},
            "whatsapp_chat_ids": [1], "whatsapp_names": {"1": "Riley Sample"},
            "call_ids": [5, "ft_3", "vm_9"], "voicemail_ids": [7]}})
        self.assertEqual(response["id"], "p-1")
        # What the screen picked out, and the notes you share, go through as given
        picked = server.handle_request({"id": "p-3", "method": "export_person", "params": {
            "udid": "x", "output_dir": self.out, "format": "csv", "display_name": "Riley Sample",
            "chat_ids": [1], "whatsapp_chat_ids": [1], "message_ids": [3], "whatsapp_message_ids": [],
            "note_ids": ["41"]}})["result"]
        self.assertEqual(picked["counts"], {"message": 1, "whatsapp": 0, "call": 0, "voicemail": 0, "note": 1})
        result = response["result"]
        self.assertEqual(result["counts"], {"message": 3, "whatsapp": 3, "call": 3, "voicemail": 1})
        progress = [p for m, p in notifications if m == "export.progress"]
        self.assertTrue(progress)
        self.assertEqual({p["kind"] for p in progress}, {"person"})
        self.assertEqual(progress[-1]["done"], progress[-1]["total"])
        bad = server.handle_request({"id": "p-2", "method": "export_person", "params": {
            "udid": "x", "output_dir": self.out, "format": "docx"}})
        self.assertEqual(bad["result"], {"error": "Unsupported format: docx"})


if __name__ == "__main__":
    unittest.main()
