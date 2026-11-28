"""
Everything with one person, in one save (engine method ``export_person``).

The People screen shows one person's Messages conversations, WhatsApp chats,
calls, voicemails and the notes you share as a single stream. This saves that
stream: whole chats (not only what the screen has read), oldest first, with
every photo, video, voice message, document and voicemail recording copied out
of the backup. When the screen's dates, search or Photos chip pick out some of
a chat's messages, ``message_ids`` and ``whatsapp_message_ids`` save only
those.

Formats (``FORMATS``):

  * ``html``: ``<base>.html`` and ``<base>_attachments/`` beside it holding
    every original file. Photos show in their bubbles (HEIC and TIFF get a
    JPEG copy beside the original), videos and playable audio get a player,
    everything else (voicemail recordings included) links to its file. The
    links are relative, so the page and its folder can be moved together.
  * ``pdf_source``: the same page, print-ready, for Electron to turn into a
    PDF (electron/pdfExport.ts). Images are drawn from JPEG copies in
    ``attachments/`` beside the page; videos, audio and other files are
    labels. With ``media_dir`` (the folder the user chose; the page itself
    goes into Electron's temporary staging folder) every original is also
    copied to ``<media_dir>/<base>_attachments/``, and each label names the
    file saved there.
  * ``csv`` / ``txt``: one row or line per item, and ``<base>_attachments/``
    holding the originals, referred to by their path relative to the file.

Messages and WhatsApp keep their own export code for each bubble (messages.py,
whatsapp.py), so replies, reactions, link previews and locations read the same
as in their own saves. Their ids overlap: sms.db ROWIDs and ChatStorage
primary keys, for chats and attachments alike. So the chat ids come in two
lists, and each source has its own file writer: a writer remembers the files
it copied by attachment id, and a shared one would hand WhatsApp's attachment
5 the Messages photo 5. Files are named "<id>-<name>" (Messages),
"wa<id>-<name>" (WhatsApp) and "vm<id>-<caller> <day>.amr" (voicemail), so
they never collide in the one folder.

Reaction rows (a tapback is its own row in sms.db) are left out, as People
leaves them out, so the counts match the screen. A part that can't be read
(WhatsApp's store, say) is reported in ``errors`` and the rest is still saved.
"""

import csv
import errno
import heapq
import os
import re
import shutil
import sys
from datetime import datetime, timezone
from typing import Callable, Optional
from urllib.parse import quote

from bundle import _writing_failed
from export_progress import ExportProgress
from local_dates import csv_date, format_day, format_time, local_datetime, readable_date
from messages import (
    EXPORT_FOOTER_HTML,
    MessageExtractor,
    _FILE_NAME_UNSAFE,
    _HtmlAttachmentWriter,
    _PrintAttachmentWriter,
    _nothing_known,
    _set_file_date,
    _visible,
    _without_lone_surrogates,
)
from save_files import SaveStopped, write_error as _write_error
from whatsapp import (
    _StoreProblem,
    _WhatsAppHtmlMedia,
    _WhatsAppPrintMedia,
    _csv_cell,
    _is_system,
    _media_label,
    _quote_text,
    _reactions_text,
)

__all__ = ["PersonExporter", "FORMATS", "CSV_HEADER"]

FORMATS = ("html", "pdf_source", "csv", "txt")

CSV_HEADER = ["Date", "Kind", "Conversation", "Direction", "Sender", "Text", "Attachments",
              "Attachment files", "Duration", "Transcript"]

# What the app is told, in words for people.
NOTHING_TO_SAVE = "There's nothing to save for this person."
MESSAGES_UNREADABLE = "Some Messages conversations couldn't be read."
WHATSAPP_UNREADABLE = "WhatsApp couldn't be read."
CALLS_UNREADABLE = "Call history couldn't be read."
VOICEMAIL_UNREADABLE = "Voicemail couldn't be read."
NOTES_UNREADABLE = "Notes couldn't be read."

_EXTENSIONS = {"html": ".html", "pdf_source": ".html", "csv": ".csv", "txt": ".txt"}

# The folder beside a save that holds its files: "<base>_attachments", as the
# Messages and WhatsApp HTML exports name theirs.
_FOLDER_SUFFIX = "_attachments"

# The file name when the person's name has nothing a file name can use.
_FALLBACK_NAME = "Person"

# Where a Messages message went, by the library's per-message service.
# Anything else (iMessage, or not recorded) is shown as "Messages".
_SERVICE_WORDS = {"SMS": "SMS", "RCS": "RCS"}

# A call's kind, by the library's app name.
_CALL_KINDS = {
    "Phone": "call",
    "FaceTime": "FaceTime call",
    "FaceTime Video": "FaceTime video call",
    "FaceTime Audio": "FaceTime audio call",
}

_NO_DATE = float("-inf")

_esc = MessageExtractor._html_escape


def _log(message: str) -> None:
    print(f"[person-export] {message}", file=sys.stderr, flush=True)


# ── Small helpers ─────────────────────────────────────────────────────────────

def _moment(iso) -> float:
    """A date as a POSIX timestamp for ordering; an unreadable or missing one sorts first."""
    if not iso:
        return _NO_DATE
    try:
        dt = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        if dt.tzinfo is None:  # the engine's readers write UTC
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.timestamp()
    except (TypeError, ValueError, OverflowError, OSError):
        return _NO_DATE


def _int_ids(values) -> list:
    """Chat ids as integers, each once, in the order given; anything that isn't one is skipped."""
    out, seen = [], set()
    for value in values or []:
        if isinstance(value, bool):
            continue
        try:
            number = int(value)
        except (TypeError, ValueError):
            _log(f"skipped a chat id that isn't a number: {value!r}")
            continue
        if number not in seen:
            seen.add(number)
            out.append(number)
    return out


def _keep_ids(values) -> Optional[set]:
    """Message ids to keep, as integers; None (keep every message) when none were given."""
    if values is None:
        return None
    return set(_int_ids(values))


def _str_ids(values) -> set:
    """Ids compared as text: list_calls gives 12 for a call, "ft_3" or "vm_9" for the others."""
    return {str(v) for v in values or [] if v is not None and not isinstance(v, bool)}


def _names(mapping) -> dict:
    """``{"12": "Mom"}`` (a JSON object's keys are text) as ``{12: "Mom"}``."""
    out = {}
    if not isinstance(mapping, dict):
        return out
    for key, value in mapping.items():
        try:
            out[int(key)] = _without_lone_surrogates(str(value)) if value is not None else ""
        except (TypeError, ValueError):
            continue
    return out


def _plural(count: int, one: str, many: str) -> str:
    return f"{count:,} {one if count == 1 else many}"


def _duration_text(seconds) -> str:
    """"42 s", "4 min 12 s", "1 h 3 min"; "" for none."""
    try:
        total = int(round(float(seconds or 0)))
    except (TypeError, ValueError):
        return ""
    if total <= 0:
        return ""
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    if hours:
        return f"{hours} h {minutes} min"
    if minutes:
        return f"{minutes} min {secs} s" if secs else f"{minutes} min"
    return f"{secs} s"


def _duration_seconds(seconds):
    """A duration for the CSV, in whole seconds; "" for none."""
    try:
        total = int(round(float(seconds or 0)))
    except (TypeError, ValueError):
        return ""
    return total if total > 0 else ""


def _who(name, number) -> str:
    """"Riley Sample (+12025550101)", or whichever of the two there is."""
    name, number = (name or "").strip(), (number or "").strip()
    if name and number and name != number:
        return f"{name} ({number})"
    return name or number


def _call_title(call: dict) -> str:
    """"Missed call", "Incoming FaceTime video call", "Outgoing WhatsApp call, not answered"."""
    app = call.get("app") or "Phone"
    kind = _CALL_KINDS.get(app) or f"{app} call"
    missed = call.get("status") == "missed"
    if call.get("direction") == "outgoing":
        return f"Outgoing {kind}" + (", not answered" if missed else "")
    return f"{'Missed' if missed else 'Incoming'} {kind}"


def _voicemail_title(vm: dict) -> str:
    """"Voicemail", or "Voicemail (marked as spam, deleted)"."""
    folder = vm.get("folder") or "voicemail"
    notes = []
    if vm.get("is_spam", folder == "spam"):
        notes.append("marked as spam")
    if folder == "deleted":
        notes.append("deleted")
    return f"Voicemail ({', '.join(notes)})" if notes else "Voicemail"


def _note_parts(note: dict) -> tuple:
    """A shared note's title and the rest of its text. A note starts with its
    title, which is already its heading, so the text leaves it out, as the
    Notes save and screen do (notes.py)."""
    raw_title = _without_lone_surrogates(str(note.get("title") or ""))
    body = _without_lone_surrogates(str(note.get("body") or ""))
    if raw_title.strip() and body.lstrip().startswith(raw_title.strip()):
        body = body.lstrip()[len(raw_title.strip()):]
    return _visible(raw_title).strip() or "Untitled", body.strip()


def _note_source(note: dict) -> str:
    """"Shared note", or "Shared note (Recently Deleted)" for one in the iPhone's Recently Deleted folder."""
    return "Shared note (Recently Deleted)" if note.get("is_deleted") else "Shared note"


def _note_text(note: dict) -> str:
    """A shared note in text: its title in quotes, then the rest of it on the lines after."""
    title, body = _note_parts(note)
    return f"“{title}”" + (f"\n{body}" if body else "")


def _messages_kind(att: dict) -> str:
    mime = (att.get("mime_type") or "").lower()
    if _PrintAttachmentWriter._is_image(att):
        return "Image"
    if mime.startswith("video/"):
        return "Video"
    if mime.startswith("audio/"):
        return "Audio"
    if _nothing_known(att):
        return "Attachment"  # a photo or file whose record iOS removed
    return "File"


def _messages_label(att: dict, status: Optional[str] = None) -> str:
    """"Image: IMG_1.jpg", "Video not in this backup: clip.mov", "File couldn't be read: a.pdf"."""
    name = _visible(att.get("transfer_name") or os.path.basename(att.get("filename") or ""))
    kind = _messages_kind(att)
    if status == "not_in_backup":
        kind += " not in this backup"
    elif status == "failed":
        kind += " couldn't be read"
    return f"{kind}: {name}" if name else kind


def _safe_part(text, limit: int = 60) -> str:
    """Text for part of a file name: nothing Windows refuses, not too long."""
    cleaned = " ".join(re.sub(_FILE_NAME_UNSAFE, " ", str(text or "")).split())
    return cleaned[:limit].strip(" .")


def _safe_id(value) -> str:
    """An id for a file name: "7", or an account store's "A-0B1C…-4D.7" as "A-0B1C…-4D_7"."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", str(value))[:64] or "x"


# ── One item of the stream ────────────────────────────────────────────────────

class _Item:
    """A message, WhatsApp message, call, voicemail or shared note, with where it's from."""

    __slots__ = ("kind", "data", "conversation", "date", "moment")

    def __init__(self, kind: str, data: dict, conversation: str, date):
        self.kind = kind                  # "message", "whatsapp", "call", "voicemail" or "note"
        self.data = data
        self.conversation = conversation  # the chat's name; "" for calls, voicemail and notes
        self.date = date
        self.moment = _moment(date)

    @property
    def media_count(self) -> int:
        """Files this item has to copy: its attachments, or a voicemail's recording."""
        if self.kind == "voicemail":
            return 1
        if self.kind in ("message", "whatsapp"):
            return len(self.data.get("attachments") or [])
        return 0

    @property
    def copyable_count(self) -> int:
        """Files that may really be copied: attachments the backup has (not marked unavailable), or a recording."""
        if self.kind == "voicemail":
            return 1
        if self.kind in ("message", "whatsapp"):
            return sum(1 for a in (self.data.get("attachments") or []) if a.get("available") is not False)
        return 0


# ── Copying files ─────────────────────────────────────────────────────────────

_TALLY_KEYS = ("copied", "not_in_backup", "failed")

# Errors about one file's name (too long, or characters this file system won't take)
_ONE_FILES_NAME = {errno.ENAMETOOLONG, errno.EINVAL, getattr(errno, "EILSEQ", -1)}


class _TalliedCopy:
    """Copies each original once into the writer's folder and counts how that went.

    Mixed into the Messages and WhatsApp HTML writers in place of their own
    ``_copy``, which says None both for a file the backup lacks and for one
    that couldn't be copied. Here a file the backup has but that can't be read
    counts as ``failed``; a failure to write into the save's own folder (a
    full disk) is raised, so the save stops instead of quietly leaving files
    out. Each writer keeps its own record, keyed by attachment id, so a
    Messages id and a WhatsApp id that happen to be equal never share a file.
    """

    def _init_tally(self) -> None:
        self.tally = dict.fromkeys(_TALLY_KEYS, 0)
        self._status: dict = {}

    @staticmethod
    def _key(att: dict):
        att_id = att.get("attachment_id")
        if isinstance(att_id, int) and not isinstance(att_id, bool):
            return att_id
        # No usable id: this one attachment (the save holds every item until it ends).
        return ("object", id(att))

    def status(self, att: dict) -> Optional[str]:
        """"copied", "not_in_backup" or "failed", once the attachment has been copied."""
        return self._status.get(self._key(att))

    def rel_path(self, name: str) -> str:
        """Where a copied file is, relative to the save: "Mom_attachments/12-IMG_1.jpg"."""
        return f"{self._rel}/{name}"

    def _copy(self, att: dict, when: Optional[str] = None) -> Optional[str]:
        key = self._key(att)
        if key in self._written:
            return self._written[key]
        name, status = None, "not_in_backup"
        if att.get("available", True) and att.get("filename"):
            try:
                src = self._extractor._attachment_file_path(self._backup, att.get("filename") or "")
            except Exception as e:  # a damaged entry must cost one file, not the save
                _log(f"couldn't read attachment {att.get('attachment_id')} from the backup: {e}")
                src, status = None, "failed"
            else:
                if not src and att.get("available") is True:
                    status = "failed"  # the backup lists the file, but it couldn't be had
            if src:
                dest = os.path.join(self._dir, self._file_name(att))
                try:
                    os.makedirs(self._dir, exist_ok=True)
                    shutil.copyfile(src, dest)
                    _set_file_date(dest, when)
                    name, status = os.path.basename(dest), "copied"
                except OSError as e:
                    # A name this file system won't take is that file's problem, not the save's
                    if _writing_failed(e, self._dir) and e.errno not in _ONE_FILES_NAME:
                        raise
                    _log(f"couldn't copy attachment {att.get('attachment_id')}: {e}")
                    status = "failed"
        self._written[key] = name
        self._status[key] = status
        self.tally[status] += 1
        return name


class _MessagesFiles(_TalliedCopy, _HtmlAttachmentWriter):
    """Messages attachments: copied as "<id>-<name>" and drawn the way the Messages HTML export draws them."""

    def __init__(self, extractor, backup):
        _HtmlAttachmentWriter.__init__(self, extractor, backup)
        self._init_tally()

    def render(self, att: dict, when: Optional[str] = None) -> str:
        name = self._copy(att, when=when)
        if name is None and self.status(att) == "failed":
            return f'<div class="attachment-label">[{_esc(_messages_label(att, "failed"))}]</div>'
        return _HtmlAttachmentWriter.render(self, att, when=when)


class _WhatsAppFiles(_TalliedCopy, _WhatsAppHtmlMedia):
    """WhatsApp media: copied as "wa<id>-<name>" and drawn the way the WhatsApp HTML export draws it."""

    def __init__(self, export, backup):
        _WhatsAppHtmlMedia.__init__(self, export, backup)
        self._init_tally()

    def render(self, att: dict, msg: dict) -> str:
        # Copy (and count) first: WhatsApp's own render doesn't ask for media it knows isn't there.
        self._copy(att)
        return _WhatsAppHtmlMedia.render(self, att, msg)


class _VoicemailFiles:
    """Voicemail recordings (AMR, as the iPhone keeps them), copied as "vm<id>-<caller> <day>.amr"."""

    def __init__(self, voicemail_extractor, backup, local_tz=None):
        self._extractor = voicemail_extractor
        self._backup = backup
        self._local_tz = local_tz
        self._dir = ""
        self._rel = ""
        self._written: dict = {}
        self._status: dict = {}
        self.tally = dict.fromkeys(_TALLY_KEYS, 0)

    def begin(self, page_path: str) -> None:
        """Use the folder beside ``page_path``, as the attachment writers do."""
        base = os.path.splitext(os.path.basename(page_path))[0]
        self._rel = f"{base}{_FOLDER_SUFFIX}"
        self._dir = os.path.join(os.path.dirname(page_path), self._rel)

    def href(self, name: str) -> str:
        return _esc(quote(f"{self._rel}/{name}"))

    def rel_path(self, name: str) -> str:
        return f"{self._rel}/{name}"

    def status(self, vm: dict) -> Optional[str]:
        return self._status.get(str(vm.get("id")))

    def _file_name(self, vm: dict) -> str:
        dt = local_datetime(vm.get("date_received"), self._local_tz)
        caller = _safe_part(vm.get("contact_name") or vm.get("phone_number") or "")
        label = " ".join(p for p in (caller, dt.date().isoformat() if dt else "") if p) or "voicemail"
        return f"vm{_safe_id(vm.get('id'))}-{label}.amr"

    def copy(self, vm: dict) -> Optional[str]:
        key = str(vm.get("id"))
        if key in self._written:
            return self._written[key]
        name, status = None, "not_in_backup"
        try:
            src = self._extractor._inner.get_audio_path(self._backup, vm.get("id"))
        except Exception as e:
            _log(f"couldn't read voicemail {key} from the backup: {e}")
            src, status = None, "failed"
        if src and os.path.exists(src):
            dest = os.path.join(self._dir, self._file_name(vm))
            try:
                os.makedirs(self._dir, exist_ok=True)
                shutil.copyfile(src, dest)
                name, status = os.path.basename(dest), "copied"
            except OSError as e:
                if _writing_failed(e, self._dir):
                    raise
                _log(f"couldn't copy voicemail {key}: {e}")
                status = "failed"
        self._written[key] = name
        self._status[key] = status
        self.tally[status] += 1
        return name


class _PdfMedia:
    """Attachments in the PDF: what the print writer draws, plus, with a media
    folder, the original copied there and named under anything that isn't a
    picture on the page (a video, a voice message, a document)."""

    def __init__(self, printer, files, folder: str):
        self.printer = printer
        self.files = files        # a _TalliedCopy writer into the media folder, or None
        self.folder = folder

    def _note(self, att: dict, drawn: str) -> str:
        if self.files is None:
            return ""
        name = self.files._copy(att)
        if not name or (_PrintAttachmentWriter._is_image(att) and "<img" in drawn):
            return ""
        return (f'<div class="attachment-link">Saved as {_esc(name)} in the '
                f'“{_esc(self.folder)}” folder</div>')


class _PdfMessages(_PdfMedia):
    def render(self, att: dict, when: Optional[str] = None) -> str:
        drawn = self.printer.render(att, when=when)
        return drawn + self._note(att, drawn)


class _PdfWhatsApp(_PdfMedia):
    def render(self, att: dict, msg: dict) -> str:
        drawn = self.printer.render(att, msg)
        return drawn + self._note(att, drawn)

    def render_map(self, location: dict) -> str:
        return self.printer.render_map(location)


class _Writers:
    """The file writers of one save, one per source."""

    def __init__(self, messages, whatsapp, voicemail, files, printers=()):
        self.messages = messages      # renders a Messages attachment
        self.whatsapp = whatsapp      # renders WhatsApp media
        self.voicemail = voicemail    # _VoicemailFiles, or None (a PDF without a media folder)
        self.files = files            # the writers that copy originals (counted in ``media``)
        self.printers = printers      # the PDF's image writers

    def tally(self) -> dict:
        total = dict.fromkeys(_TALLY_KEYS, 0)
        if self.files:
            for writer in self.files:
                for key in _TALLY_KEYS:
                    total[key] += writer.tally[key]
        else:  # a PDF without a media folder: only the images drawn in it
            for printer in self.printers:
                total["copied"] += printer.images_written
                total["not_in_backup"] += printer.images_missing
        return total

    def failed(self) -> int:
        return sum(writer.tally["failed"] for writer in self.files) if self.files else 0


# ── The save ──────────────────────────────────────────────────────────────────

class PersonExporter:
    """Writes one person's messages, WhatsApp messages, calls, voicemails and shared notes into one file."""

    def __init__(self, message_extractor, whatsapp_extractor, call_extractor, voicemail_extractor,
                 note_extractor=None):
        self.messages = message_extractor
        self.whatsapp = whatsapp_extractor
        self.calls = call_extractor
        self.voicemail = voicemail_extractor
        self.notes = note_extractor

    # The time zone dates are shown in: None is this computer's, as the app's.
    # Shared with the Messages adapter, whose file naming this save uses.
    @property
    def local_tz(self):
        return self.messages.local_tz

    @local_tz.setter
    def local_tz(self, tz) -> None:
        self.messages.local_tz = tz

    def export(self, backup, contacts: dict, output_dir: str, fmt: str, display_name: Optional[str] = None,
               chat_ids=(), conversation_names=None, whatsapp_chat_ids=(), whatsapp_names=None,
               call_ids=(), voicemail_ids=(), media_dir: Optional[str] = None,
               on_progress: Optional[Callable[[int, int, int], None]] = None,
               message_ids=None, whatsapp_message_ids=None, note_ids=()) -> dict:
        """Save everything with one person. See the module's docstring for the formats.

        ``chat_ids``: sms.db chat ROWIDs; ``whatsapp_chat_ids``: ChatStorage
        chat ids (never mixed: they overlap). Both are whole chats.
        ``call_ids``: as list_calls gives them (12, "ft_3", "vm_9").
        ``voicemail_ids``: as list_voicemails gives them. ``note_ids``: shared
        notes, as list_notes gives them. ``message_ids`` (sms.db ROWIDs) and
        ``whatsapp_message_ids`` (ChatStorage primary keys): when given, only
        those messages of the chats are saved; absent, the chats are saved
        whole. The names map a chat
        id (as text or a number) to its name. ``media_dir``: for
        ``pdf_source`` only, the folder the PDF goes in; every original is
        copied there too.

        Returns ``{file, message_count, counts, media, errors}``, plus
        ``media_folder`` when files were copied into one. ``counts`` has
        ``message``, ``whatsapp``, ``call`` and ``voicemail``; ``media`` has
        ``copied``, ``not_in_backup`` and ``failed`` (``note`` too, with notes);
        ``errors`` names each
        part that couldn't be read (the rest is still saved). Nothing found at
        all is ``{error, errors}``, and so is a folder that can't be written
        to (whatever was half-written is removed).
        """
        if fmt not in FORMATS:
            return {"error": f"Unsupported format: {fmt}"}
        if not output_dir:
            return {"error": "Choose a folder to save in."}
        display_name = _without_lone_surrogates(str(display_name)).strip() if display_name else ""
        media_dir = media_dir if fmt == "pdf_source" and media_dir else None

        errors: dict = {}
        items, counts = self._read(backup, contacts, display_name, chat_ids, conversation_names,
                                   whatsapp_chat_ids, whatsapp_names, call_ids, voicemail_ids, errors,
                                   message_ids=message_ids, whatsapp_message_ids=whatsapp_message_ids,
                                   note_ids=note_ids)
        if not items:
            return {"error": next(iter(errors.values()), NOTHING_TO_SAVE), "errors": errors}

        try:
            os.makedirs(output_dir, exist_ok=True)
        except OSError as e:
            _log(f"couldn't make the folder to save in: {e}")
            return {"error": _write_error(e), "errors": errors}
        base = self._base_name(display_name, items, fmt, output_dir, media_dir)
        page = os.path.join(output_dir, base + _EXTENSIONS[fmt])
        files_root = media_dir or (output_dir if fmt != "pdf_source" else None)
        folder_name = base + _FOLDER_SUFFIX
        folder = os.path.join(files_root, folder_name) if files_root else None

        try:
            writers = self._writers(backup, fmt, output_dir, files_root, base, folder_name)
            media_total = sum(it.media_count for it in items)
            progress = ExportProgress(on_progress, max(len(items) + media_total, 1))
            state = {"done": 0}
            progress.update(0, 0)

            def step(item: _Item) -> None:
                state["done"] += 1 + item.media_count
                progress.update(state["done"], writers.failed())

            if fmt == "csv":
                self._write_csv(page, items, writers, step)
            elif fmt == "txt":
                self._write_txt(page, items, writers, display_name, step)
            else:
                self._write_html(page, items, display_name, counts, writers, fmt, folder_name, media_total, step)
            if state["done"] < progress.total:  # the last update always says it's done
                progress.update(progress.total, writers.failed())
        except OSError as e:
            self._remove(page, folder)
            _log(f"couldn't write the save: {e}")
            return {"error": _write_error(e), "errors": errors}
        except SaveStopped as e:  # from the shared writers: no room to decrypt
            self._remove(page, folder)
            return {"error": str(e), "errors": errors}
        except BaseException:
            self._remove(page, folder)
            raise

        result = {
            "file": page,
            "message_count": len(items),
            "counts": counts,
            "media": writers.tally(),
            "errors": errors,
        }
        if folder and os.path.isdir(folder):
            result["media_folder"] = folder
        return result

    # ── reading ──────────────────────────────────────────────────────────────

    def _read(self, backup, contacts, display_name, chat_ids, conversation_names, whatsapp_chat_ids,
              whatsapp_names, call_ids, voicemail_ids, errors, message_ids=None, whatsapp_message_ids=None,
              note_ids=()) -> tuple:
        """Every item, merged by date (oldest first), and how many of each kind."""
        messages = self._read_messages(backup, contacts, _int_ids(chat_ids), _names(conversation_names),
                                       display_name, errors, keep=_keep_ids(message_ids))
        chats = self._read_whatsapp(backup, contacts, _int_ids(whatsapp_chat_ids), _names(whatsapp_names),
                                    display_name, errors, keep=_keep_ids(whatsapp_message_ids))
        calls = self._read_calls(backup, contacts, _str_ids(call_ids), errors)
        voicemails = self._read_voicemails(backup, contacts, _str_ids(voicemail_ids), errors)
        notes = self._read_notes(backup, _str_ids(note_ids), errors)
        counts = {
            "message": len(messages),
            "whatsapp": sum(len(chat) for chat in chats),
            "call": len(calls),
            "voicemail": len(voicemails),
        }
        if notes:
            counts["note"] = len(notes)
        # Each Messages, call and voicemail stream is in date order. A WhatsApp
        # chat stays in arrival order, where a late message can carry an earlier
        # date: merging interleaves the streams by date but never reorders one,
        # as WhatsApp's own merged save does.
        items = list(heapq.merge(messages, *chats, calls, voicemails, notes, key=lambda it: it.moment))
        return items, counts

    def _read_messages(self, backup, contacts, chat_ids, names, display_name, errors, keep=None) -> list:
        items, seen = [], set()
        for chat_id in chat_ids:
            try:
                messages = self.messages._collect_messages_for_chat(backup, chat_id, contacts)
            except Exception as e:  # one conversation must not cost the rest
                _log(f"couldn't read Messages conversation {chat_id}: {e}")
                errors["message"] = MESSAGES_UNREADABLE
                continue
            name = names.get(chat_id) or display_name
            for msg in messages:
                if msg.get("is_reaction"):
                    continue
                message_id = msg.get("message_id")
                if keep is not None and message_id not in keep:  # not among those the screen picked out
                    continue
                if message_id is not None:
                    if message_id in seen:  # in two of the person's chats: once, as People shows it
                        continue
                    seen.add(message_id)
                items.append(_Item("message", msg, name, msg.get("date")))
        items.sort(key=lambda it: (it.moment, it.data.get("message_id") or 0))
        return items

    def _read_whatsapp(self, backup, contacts, chat_ids, names, display_name, errors, keep=None) -> list:
        chats = []
        export = self.whatsapp._export
        for chat_id in chat_ids:
            try:
                messages = export._collect_messages_for_chat(backup, chat_id, contacts)
            except _StoreProblem as e:
                # The store is the same for every chat: the others would fail too.
                errors["whatsapp"] = e.result.get("error") or WHATSAPP_UNREADABLE
                break
            except Exception as e:
                _log(f"couldn't read WhatsApp chat {chat_id}: {e}")
                errors["whatsapp"] = WHATSAPP_UNREADABLE
                continue
            name = names.get(chat_id) or display_name
            chats.append([_Item("whatsapp", msg, name, msg.get("date"))
                          for msg in messages
                          if not msg.get("is_reaction") and (keep is None or msg.get("message_id") in keep)])
        return chats

    def _read_calls(self, backup, contacts, wanted: set, errors) -> list:
        if not wanted:
            return []
        try:
            result = self.calls.list_calls(backup, contacts, 0, 10_000_000)
        except Exception as e:
            _log(f"couldn't read call history: {e}")
            errors["call"] = CALLS_UNREADABLE
            return []
        calls = result.get("calls") or []
        # No calls with an empty_reason ("requires_encryption") is a normal state, even with an error.
        if result.get("error") and not calls and not result.get("empty_reason"):
            errors["call"] = result["error"]
        items = [_Item("call", call, "", call.get("date")) for call in calls if str(call.get("call_id")) in wanted]
        items.sort(key=lambda it: (it.moment, str(it.data.get("call_id"))))
        return items

    def _read_voicemails(self, backup, contacts, wanted: set, errors) -> list:
        if not wanted:
            return []
        try:
            result = self.voicemail.list_voicemails(backup, contacts, include_deleted=True)
        except Exception as e:
            _log(f"couldn't read voicemail: {e}")
            errors["voicemail"] = VOICEMAIL_UNREADABLE
            return []
        voicemails = result.get("voicemails") or []
        if result.get("error") and not voicemails:
            errors["voicemail"] = result["error"]
        items = [_Item("voicemail", vm, "", vm.get("date_received"))
                 for vm in voicemails if str(vm.get("id")) in wanted]
        items.sort(key=lambda it: (it.moment, str(it.data.get("id"))))
        return items

    def _read_notes(self, backup, wanted: set, errors) -> list:
        """The shared notes asked for, dated as the Timeline dates them (made, else last changed)."""
        if not wanted:
            return []
        if self.notes is None:
            errors["note"] = NOTES_UNREADABLE
            return []
        try:
            result = self.notes.list_notes(backup)
        except Exception as e:
            _log(f"couldn't read notes: {e}")
            errors["note"] = NOTES_UNREADABLE
            return []
        notes = (result.get("notes") if isinstance(result, dict) else result) or []
        if isinstance(result, dict) and result.get("error") and not notes:
            errors["note"] = result["error"]
        items = [_Item("note", note, "", note.get("created") or note.get("modified"))
                 for note in notes if str(note.get("note_id")) in wanted]
        items.sort(key=lambda it: (it.moment, str(it.data.get("note_id"))))
        return items

    # ── names and writers ────────────────────────────────────────────────────

    def _base_name(self, display_name, items, fmt, output_dir, media_dir) -> str:
        """"Riley Sample, Mar 1 2024 - Jun 21 2026", or "… (2)" if that would overwrite anything.

        For a PDF with a media folder, neither "<base>.pdf" nor
        "<base>_attachments" may be in that folder yet, so the PDF Electron
        writes from "<base>.html" and the folder of originals match.
        """
        dated = [it for it in items if it.moment != _NO_DATE]
        span = []
        if dated:
            span = [{"date": min(dated, key=lambda it: it.moment).date},
                    {"date": max(dated, key=lambda it: it.moment).date}]
        base = (self.messages._get_filename_for_message_export(display_name, span)
                or self.messages._get_filename_for_message_export(_FALLBACK_NAME, span))
        ext = _EXTENSIONS[fmt]

        def taken(candidate: str) -> list:
            paths = [os.path.join(output_dir, candidate + ext)]
            if fmt != "pdf_source":
                paths.append(os.path.join(output_dir, candidate + _FOLDER_SUFFIX))
            if media_dir:
                paths += [os.path.join(media_dir, candidate + ".pdf"),
                          os.path.join(media_dir, candidate + _FOLDER_SUFFIX)]
            return paths

        candidate, n = base, 2
        while any(os.path.lexists(p) for p in taken(candidate)):
            candidate = f"{base} ({n})"
            n += 1
        return candidate

    def _writers(self, backup, fmt, output_dir, files_root, base, folder_name) -> _Writers:
        files = None
        if files_root:
            # begin() takes a page path and uses "<its base>_attachments" beside it.
            beside = os.path.join(files_root, base + ".html")
            files = (_MessagesFiles(self.messages, backup),
                     _WhatsAppFiles(self.whatsapp._export, backup),
                     _VoicemailFiles(self.voicemail, backup, self.local_tz))
            for writer in files:
                writer.begin(beside)
        if fmt != "pdf_source":
            return _Writers(files[0], files[1], files[2], files)
        printers = (_PrintAttachmentWriter(self.messages, backup, output_dir),
                    _WhatsAppPrintMedia(self.whatsapp._export, backup, output_dir))
        return _Writers(
            _PdfMessages(printers[0], files[0] if files else None, folder_name),
            _PdfWhatsApp(printers[1], files[1] if files else None, folder_name),
            files[2] if files else None,
            files,
            printers,
        )

    @staticmethod
    def _remove(page: str, folder: Optional[str]) -> None:
        """Remove a half-written save: its file and its folder of originals (both new: see _base_name)."""
        try:
            if os.path.isfile(page):
                os.remove(page)
        except OSError:
            pass
        if folder and os.path.isdir(folder):
            shutil.rmtree(folder, ignore_errors=True)

    # ── text of an item, for TXT and CSV ─────────────────────────────────────

    @staticmethod
    def _source(it: _Item) -> str:
        if it.kind == "whatsapp":
            return "WhatsApp"
        if it.kind == "message":
            return _SERVICE_WORDS.get(it.data.get("service") or "", "Messages")
        if it.kind == "note":
            return _note_source(it.data)
        return "Call" if it.kind == "call" else "Voicemail"

    def _messages_text(self, msg: dict) -> str:
        """What a Messages message says, without its attachments (they're listed on their own)."""
        text = msg.get("text") or ""
        if text.strip():
            return text
        if msg.get("attachments"):
            return ""
        return self.messages._event_label(msg)

    def _whatsapp_text(self, msg: dict) -> str:
        """What a WhatsApp message says, with its reply and reactions, without its media."""
        export = self.whatsapp._export
        if _is_system(msg):
            return msg.get("event_text") or "WhatsApp notice"
        if not msg.get("attachments"):
            return export._line_text(msg)
        parts = []
        if msg.get("quoted"):
            parts.append(f"[Replying to {_quote_text(msg['quoted'])}]")
        if (msg.get("text") or "").strip():
            parts.append(msg["text"])
        reactions = _reactions_text(msg.get("reactions"))
        if reactions:
            parts.append(f"[Reactions: {reactions}]")
        return " ".join(parts)

    @staticmethod
    def _media(it: _Item, writers: _Writers) -> list:
        """[(label, saved path or None)] for an item's files, copying each into the folder."""
        if it.kind == "voicemail":
            files = writers.voicemail
            name = files.copy(it.data)
            if name:
                return [("Recording", files.rel_path(name))]
            failed = files.status(it.data) == "failed"
            return [("Recording couldn't be read" if failed else "Recording not in this backup", None)]
        if it.kind not in ("message", "whatsapp"):
            return []
        files = writers.messages if it.kind == "message" else writers.whatsapp
        out = []
        for att in it.data.get("attachments") or []:
            name = files._copy(att)
            status = None if name else files.status(att)
            if it.kind == "message":
                label = _messages_label(att, status)
            else:
                label = _media_label(it.data, att, missing=status == "not_in_backup", unreadable=status == "failed")
            out.append((label, files.rel_path(name) if name else None))
        return out

    # ── CSV ──────────────────────────────────────────────────────────────────

    def _csv_row(self, it: _Item, writers: _Writers) -> list:
        tz = self.local_tz
        data = it.data
        media = self._media(it, writers)
        labels = [label for label, _ in media]
        paths = [path for _, path in media if path]
        duration, transcript = "", ""
        if it.kind == "message":
            direction = "Sent" if data.get("is_from_me") else "Received"
            sender, text = data.get("sender") or "", self._messages_text(data)
        elif it.kind == "whatsapp":
            if _is_system(data):
                direction, sender = "Notice", ""
            else:
                direction = "Sent" if data.get("is_from_me") else "Received"
                sender = data.get("sender") or "Unknown member"
            text = self._whatsapp_text(data)
        elif it.kind == "call":
            outgoing = data.get("direction") == "outgoing"
            direction = "Outgoing" if outgoing else "Incoming"
            sender = "me" if outgoing else _who(data.get("contact_name"), data.get("address"))
            text, duration = _call_title(data), _duration_seconds(data.get("duration"))
        elif it.kind == "note":
            direction, sender, text = "", "", _note_text(data)
        else:
            direction = "Received"
            sender = _who(data.get("contact_name"), data.get("phone_number"))
            text, duration = _voicemail_title(data), _duration_seconds(data.get("duration"))
            transcript = data.get("transcript") or ""
        row = [csv_date(it.date, tz), self._source(it), it.conversation, direction, sender, text,
               "; ".join(labels), "; ".join(paths), duration, transcript]
        return [_csv_cell(cell) for cell in row]

    def _write_csv(self, path, items, writers, step) -> None:
        with open(path, "w", newline="", encoding="utf-8-sig", errors="replace") as f:
            writer = csv.writer(f)
            writer.writerow(CSV_HEADER)
            for it in items:
                writer.writerow(self._csv_row(it, writers))
                step(it)

    # ── TXT ──────────────────────────────────────────────────────────────────

    def _txt_line(self, it: _Item, writers: _Writers, display_name: str) -> str:
        data = it.data
        where = self._source(it)
        if it.kind in ("message", "whatsapp") and it.conversation and it.conversation != display_name:
            where += f", in {it.conversation}"
        files = [f"[{label} -> {path}]" if path else f"[{label}]" for label, path in self._media(it, writers)]
        if it.kind == "message":
            body = f"{data.get('sender') or 'Unknown'}: {self._messages_text(data)}".rstrip()
        elif it.kind == "whatsapp":
            text = self._whatsapp_text(data)
            body = text if _is_system(data) else f"{data.get('sender') or 'Unknown member'}: {text}".rstrip()
        elif it.kind == "call":
            parts = [_call_title(data), _who(data.get("contact_name"), data.get("address")),
                     _duration_text(data.get("duration"))]
            body = " · ".join(p for p in parts if p)
        elif it.kind == "note":
            body = _note_text(data).replace("\n", "\n    ")
        else:
            parts = [_voicemail_title(data), _who(data.get("contact_name"), data.get("phone_number")),
                     _duration_text(data.get("duration"))]
            body = " · ".join(p for p in parts if p)
        line = f"[{readable_date(it.date, self.local_tz)}] ({where}) {body}"
        if files:
            line += " " + " ".join(files)
        if it.kind == "voicemail" and data.get("transcript"):
            line += f" Transcript: “{' '.join(str(data['transcript']).split())}”"
        return line

    def _write_txt(self, path, items, writers, display_name, step) -> None:
        with open(path, "w", encoding="utf-8-sig", errors="replace") as f:
            for it in items:
                f.write(self._txt_line(it, writers, display_name) + "\n")
                step(it)

    # ── HTML (and the PDF's HTML) ────────────────────────────────────────────

    def _days(self, items):
        """Yield (item, day heading or "", time) like WhatsApp's export: a heading
        only moves forward, so a WhatsApp message that arrived late with an
        earlier date stays where it arrived, with its own date written out."""
        current = None
        for it in items:
            dt = local_datetime(it.date, self.local_tz)
            if dt is None:
                yield it, "", it.date or ""
                continue
            day = dt.date()
            heading = ""
            if current is None or day > current:
                current, heading = day, format_day(dt)
            when = format_time(dt) if day == current else f"{format_day(dt)}, {format_time(dt)}"
            yield it, heading, when

    def _summary(self, counts: dict, items: list) -> str:
        """"135 messages · 12 WhatsApp messages · 4 calls · 2 voicemails · Mar 1, 2024 – Jun 21, 2026"."""
        parts = []
        if counts["message"]:
            parts.append(_plural(counts["message"], "message", "messages"))
        if counts["whatsapp"]:
            parts.append(_plural(counts["whatsapp"], "WhatsApp message", "WhatsApp messages"))
        if counts["call"]:
            parts.append(_plural(counts["call"], "call", "calls"))
        if counts["voicemail"]:
            parts.append(_plural(counts["voicemail"], "voicemail", "voicemails"))
        if counts.get("note"):
            parts.append(_plural(counts["note"], "shared note", "shared notes"))
        dated = [dt for it in items if (dt := local_datetime(it.date, self.local_tz)) is not None]
        if dated:
            first, last = format_day(min(dated)), format_day(max(dated))
            parts.append(first if first == last else f"{first} – {last}")
        return " · ".join(parts)

    def _conversation_html(self, it: _Item, display_name: str) -> str:
        if not it.conversation or it.conversation == display_name:
            return ""
        return f' <span class="conv">in {_esc(it.conversation)}</span>'

    def _message_html(self, it: _Item, when: str, writers: _Writers, display_name: str) -> str:
        msg = it.data
        source = self._source(it)
        side = "sent" if msg.get("is_from_me") else "received"
        classes = f"item imessage {side}" + (" sms" if source != "Messages" else "")
        out = [f'<div class="{classes}">',
               f'<div class="meta">{_esc(when)} · <span class="src">{source}</span>'
               f'{self._conversation_html(it, display_name)}</div>']
        if not msg.get("is_from_me"):
            out.append(f'<div class="sender">{_esc(msg.get("sender") or "Unknown")}</div>')
        out.append(f'<div class="msg">{self.messages._message_html(msg, writers.messages)}</div></div>')
        return "".join(out)

    def _whatsapp_html(self, it: _Item, when: str, writers: _Writers, display_name: str) -> str:
        msg = it.data
        meta = f'{_esc(when)} · <span class="src">WhatsApp</span>{self._conversation_html(it, display_name)}'
        if msg.get("starred"):
            meta += ' <span class="star" title="Starred">★</span>'
        if _is_system(msg):
            return (f'<div class="item whatsapp notice"><div class="meta">{meta}</div>'
                    f'<div class="system">{_esc(msg.get("event_text") or "WhatsApp notice")}</div></div>')
        side = "sent" if msg.get("is_from_me") else "received"
        out = [f'<div class="item whatsapp {side}">', f'<div class="meta">{meta}</div>']
        if not msg.get("is_from_me"):
            out.append(f'<div class="sender">{_esc(msg.get("sender") or "Unknown member")}</div>')
        out.append(f'<div class="msg">{self.whatsapp._export._bubble_html(msg, writers.whatsapp)}</div></div>')
        return "".join(out)

    def _call_html(self, it: _Item, when: str) -> str:
        call = it.data
        missed = call.get("status") == "missed" and call.get("direction") != "outgoing"
        detail = " · ".join(p for p in (_who(call.get("contact_name"), call.get("address")),
                                             _duration_text(call.get("duration"))) if p)
        return (f'<div class="item log call{" missed" if missed else ""}">'
                f'<div class="meta">{_esc(when)}</div><div class="log-box">'
                f'<div class="log-title">{_esc(_call_title(call))}</div>'
                + (f'<div class="log-detail">{_esc(detail)}</div>' if detail else "")
                + "</div></div>")

    def _voicemail_html(self, it: _Item, when: str, writers: _Writers, fmt: str, folder_name: str) -> str:
        vm = it.data
        detail = " · ".join(p for p in (_who(vm.get("contact_name"), vm.get("phone_number")),
                                             _duration_text(vm.get("duration"))) if p)
        parts = [f'<div class="log-title">{_esc(_voicemail_title(vm))}</div>']
        if detail:
            parts.append(f'<div class="log-detail">{_esc(detail)}</div>')
        if vm.get("transcript"):
            parts.append(f'<div class="transcript">“{_esc(vm["transcript"], preserve_newlines=True)}”</div>')
        files = writers.voicemail
        if files is None:  # a PDF without a media folder: it can't hold audio
            parts.append('<div class="attachment-label">[Audio: voicemail recording]</div>')
        else:
            name = files.copy(vm)
            if name and fmt == "pdf_source":
                parts.append(f'<div class="attachment-link">Recording saved as {_esc(name)} in the '
                             f'“{_esc(folder_name)}” folder</div>')
            elif name:
                # AMR: no browser plays it, so a link that opens it in another app.
                parts.append(f'<div class="attachment-link"><a href="{files.href(name)}" title="AMR audio">'
                             f'Recording: {_esc(name)}</a></div>')
            elif files.status(vm) == "failed":
                parts.append('<div class="attachment-label">Recording couldn\'t be read</div>')
            else:
                parts.append('<div class="attachment-label">Recording not in this backup</div>')
        return (f'<div class="item log voicemail"><div class="meta">{_esc(when)}</div>'
                f'<div class="log-box">{"".join(parts)}</div></div>')

    @staticmethod
    def _note_html(it: _Item, when: str) -> str:
        title, body = _note_parts(it.data)
        parts = [f'<div class="log-title">{_esc(title)}</div>']
        if body:
            parts.append(f'<div class="note-body">{_esc(body, preserve_newlines=True)}</div>')
        return (f'<div class="item log note"><div class="meta">{_esc(when)} · <span class="src">{_esc(_note_source(it.data))}</span></div>'
                f'<div class="log-box">{"".join(parts)}</div></div>')

    def _files_note(self, fmt: str, folder_name: str, media_total: int, has_folder: bool) -> str:
        if not media_total or not has_folder:
            return ""
        folder = f"“{_esc(folder_name)}”"
        if fmt == "pdf_source":
            return (f"Photos are shown here. Every original file, videos and recordings included, "
                    f"is saved in the {folder} folder next to this PDF.")
        return (f"Photos, videos, recordings and other files are in the {folder} folder next to "
                f"this page. Keep the two together when you move or share them.")

    def _write_html(self, path, items, display_name, counts, writers, fmt, folder_name, media_total, step) -> None:
        safe_name = _esc(display_name)
        title = f"Everything with {safe_name}" if safe_name else "Everything with this person"
        # Only promise a folder when there are files the backup has: none at all means no folder
        note = self._files_note(fmt, folder_name, sum(it.copyable_count for it in items), writers.files is not None)
        with open(path, "w", encoding="utf-8", errors="replace") as f:
            f.write(f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
{_PERSON_CSS}</style></head><body>
<h1 class="person-title">{safe_name or title}</h1>
<p class="summary">{_esc(self._summary(counts, items))}</p>
""")
            if note:
                f.write(f'<p class="files-note">{note}</p>\n')
            for it, day, when in self._days(items):
                if day:
                    f.write(f'<div class="day">{_esc(day)}</div>\n')
                if it.kind == "message":
                    f.write(self._message_html(it, when, writers, display_name))
                elif it.kind == "whatsapp":
                    f.write(self._whatsapp_html(it, when, writers, display_name))
                elif it.kind == "call":
                    f.write(self._call_html(it, when))
                elif it.kind == "note":
                    f.write(self._note_html(it, when))
                else:
                    f.write(self._voicemail_html(it, when, writers, fmt, folder_name))
                f.write("\n")
                step(it)
            f.write(EXPORT_FOOTER_HTML)
            f.write("</body></html>\n")


# Each source's bubbles keep their own look, scoped by the item's class
# (.imessage, .whatsapp), because the Messages and WhatsApp exports use the
# same class names (.msg, .sent, .received) with different colours.
_PERSON_CSS = """body { font-family: -apple-system, "Segoe UI", sans-serif; max-width: 640px; margin: 0 auto; padding: 20px; background: #f5f5f5; color: #111; }
.person-title { font-size: 20px; color: #222; text-align: center; margin: 0 0 4px; }
.summary, .files-note { font-size: 12px; color: #666; text-align: center; margin: 0 0 6px; }
.files-note { margin-bottom: 12px; }
.day { font-size: 12px; font-weight: 600; color: #555; text-align: center; margin: 0 0 4px; padding-top: 24px; }
.item { display: flex; flex-direction: column; align-items: flex-start; }
.item.sent { align-items: flex-end; }
.item.log, .item.notice { align-items: center; }
.item .meta { align-self: stretch; font-size: 11px; color: #888; text-align: center; margin: 12px 0 4px; }
.item .src { font-weight: 600; }
.item .conv { font-style: italic; }
.item .star { color: #c99400; }
.item .sender { font-size: 11px; color: #666; margin-bottom: 2px; }
.msg { max-width: 75%; padding: 10px 14px; border-radius: 18px; overflow-wrap: anywhere; }
.msg img { display: block; max-width: 100%; max-height: 420px; border-radius: 12px; margin: 2px 0; }
.msg video { display: block; max-width: 100%; max-height: 420px; border-radius: 12px; margin: 2px 0; background: #000; }
.msg audio { display: block; width: 260px; max-width: 100%; margin: 2px 0; }
.msg a { color: inherit; }
.msg .text:not(:first-child) { margin-top: 6px; }
.attachment-label { font-style: italic; opacity: 0.85; }
.attachment-link { font-size: 12px; opacity: 0.85; }
.imessage .src { color: #0a64d6; }
.imessage.sms .src { color: #248a3d; }
.imessage.sent .msg { background: #007aff; color: #fff; border-bottom-right-radius: 4px; }
.imessage.sent.sms .msg { background: #34c759; }
.imessage.received .msg { background: #e9e9eb; color: #000; border-bottom-left-radius: 4px; }
.whatsapp .src, .whatsapp .sender { color: #1f7a4d; }
.whatsapp .sender { font-weight: 600; }
.whatsapp .msg { padding: 8px 12px; border-radius: 12px; color: #111b21; box-shadow: 0 1px 1px rgba(0,0,0,0.08); }
.whatsapp.sent .msg { background: #d9fdd3; border-top-right-radius: 4px; }
.whatsapp.received .msg { background: #fff; border-top-left-radius: 4px; }
.whatsapp .system { max-width: 80%; padding: 5px 12px; border-radius: 8px; background: #fff3c4; color: #54656f; font-size: 12px; text-align: center; }
.whatsapp .quote { border-left: 3px solid #25d366; background: rgba(0,0,0,0.05); border-radius: 6px; padding: 4px 8px; margin-bottom: 6px; font-size: 13px; }
.whatsapp .quote-who { font-weight: 600; font-size: 12px; color: #1f7a4d; }
.whatsapp .quote-text { opacity: 0.85; }
.whatsapp .event { font-style: italic; opacity: 0.85; }
.whatsapp .coords { font-size: 12px; opacity: 0.8; }
.whatsapp .map { border-radius: 8px; margin-bottom: 4px; }
.whatsapp .reactions { font-size: 12px; margin-top: 4px; opacity: 0.85; }
.whatsapp .link-preview { margin-top: 6px; padding: 6px 8px; border-radius: 6px; background: rgba(0,0,0,0.05); font-size: 12px; }
.whatsapp .link-title { font-weight: 600; }
.whatsapp .link-url { opacity: 0.7; word-break: break-all; }
.whatsapp .msg img.sticker { max-width: 160px; max-height: 160px; border-radius: 0; }
.log-box { max-width: 80%; padding: 6px 14px; border-radius: 10px; background: #fff; border: 1px solid #e0e0e0; text-align: center; font-size: 13px; overflow-wrap: anywhere; }
.log-title { font-weight: 600; }
.call.missed .log-title { color: #d70015; }
.log-detail { font-size: 12px; color: #666; }
.transcript { margin-top: 4px; font-size: 13px; font-style: italic; text-align: left; }
.note-body { margin-top: 4px; font-size: 13px; text-align: left; white-space: pre-wrap; }
.log-box a { color: inherit; }
@media print {
  body { background: #fff; max-width: none; }
  .item { break-inside: avoid; }
  .msg img, .msg video { max-height: 360px; }
  .whatsapp .msg { box-shadow: none; border: 1px solid #ddd; }
  .day, .person-title { break-after: avoid; }
}
"""
