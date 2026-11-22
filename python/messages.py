"""
Message extraction adapter.

Delegates raw extraction (list_conversations, get_messages, search_messages)
to ``ios_backup_core.extractors.messages.MessageExtractor``. Keeps the
openextract-only behaviour:

  * ``get_attachment(backup, attachment_id, thumbnail, as_file)`` — the
    library lists each message's attachments but doesn't hand over a file.
    The app wants the bytes (base64; HEIC and TIFF photos as JPEG), a small
    JPEG thumbnail of a picture, or a copy named with its real extension to
    open or play (as_file), the way WhatsApp's media comes (whatsapp.py); the
    shared part is attachment_files.py. get_messages adds to each attachment
    whether its file is in the backup (``available``), its ``uti`` and
    ``is_sticker``.
  * ``export_conversation`` / ``export_conversations`` (txt, csv, html with
    its attachments in a folder beside it, and ``pdf_source``, the print-ready
    HTML with images that Electron turns into a PDF) — file export is out of
    scope for the library.

Re-exports the utility constants/functions that the rest of the openextract
sidecar imports from this module:

    APPLE_EPOCH, NANOSECOND_THRESHOLD,
    apple_date_to_iso, iso_to_apple_date, parse_attributed_body
"""

import base64
import csv
import html
import io
import os
import re
import sys
import uuid
import unicodedata
from datetime import datetime
from typing import Optional
from urllib.parse import quote

from ios_backup_core.extractors.messages import MessageExtractor as _CoreMessageExtractor
from ios_backup_core.text import parse_attributed_body  # noqa: F401  (re-export)
from ios_backup_core.timestamps import (
    APPLE_EPOCH,           # noqa: F401  (re-export)
    NANOSECOND_THRESHOLD,  # noqa: F401  (re-export)
    apple_to_iso as apple_date_to_iso,
    iso_to_apple as iso_to_apple_date,
)

from local_dates import (
    MONTHS as _MONTHS,
    csv_date,
    format_day,
    format_time,
    local_datetime,
    readable_date,
)
import pdf_parts
from save_files import (
    CANT_READ,
    NO_ROOM,
    NO_ROOM_FOR_PDF,
    FileNotSaved,
    SaveStopped,
    copy_whole,
    log_failure,
    new_page,
    remove,
    write_error,
    write_whole,
)

__all__ = [
    "MessageExtractor",
    "apple_date_to_iso",
    "iso_to_apple_date",
    "parse_attributed_body",
    "APPLE_EPOCH",
    "NANOSECOND_THRESHOLD",
]

# One small grey line at the end of HTML and PDF exports. To remove it, make
# this an empty string; nothing else depends on it.
EXPORT_FOOTER_HTML = (
    '<footer style="clear: both; padding-top: 32px; text-align: center; '
    'font-size: 10px; color: #999;">Made with OpenExtract, free at '
    '<a href="https://www.openextract.app" style="color: inherit;">openextract.app</a>'
    '</footer>\n'
)

# Longest side, in pixels, of images written for a PDF export. Big enough to
# look sharp on a printed page, small enough that a long thread stays a
# reasonable file size.
PDF_IMAGE_MAX_PX = 1600

# Longest side of the JPEG copy an HTML export writes for a photo browsers
# can't show (HEIC, TIFF). The original is saved beside it.
HTML_PREVIEW_MAX_PX = 2048

# Styles for images, players and attachment labels inside bubbles, plus page
# breaks for the PDF.
_ATTACHMENT_CSS = """.msg img { display: block; max-width: 100%; max-height: 420px; border-radius: 12px; margin: 2px 0; }
.msg video { display: block; max-width: 100%; max-height: 420px; border-radius: 12px; margin: 2px 0; background: #000; }
.msg audio { display: block; width: 260px; max-width: 100%; margin: 2px 0; }
.msg a { color: inherit; }
.msg .text { margin-top: 6px; }
.attachment-label { font-style: italic; opacity: 0.85; }
.attachment-link { font-size: 12px; opacity: 0.85; }
@media print {
  body { background: #fff; max-width: none; }
  .msg { float: none; width: fit-content; break-inside: avoid; }
  .msg img { max-height: 360px; }
  .sent { margin-left: auto; }
  .received { margin-right: auto; }
  .day, .meta, .sender { break-after: avoid; }
}
"""

# What can't go in an export's file name: characters Windows refuses (macOS
# only refuses "/" and ":"), control characters, and the invisible marks that
# reverse the direction of text, which can disguise a name.
_FILE_NAME_UNSAFE = r'[<>:"/\\|?*\x00-\x1f\x7f‪-‮⁦-⁩]'

# Names Windows keeps for devices, with or without an extension ("CON.txt").
_WINDOWS_DEVICE_NAMES = {"CON", "PRN", "AUX", "NUL",
                         *(f"COM{n}" for n in range(1, 10)), *(f"LPT{n}" for n in range(1, 10))}

# Longest conversation name kept in a file name, so the whole path stays well
# inside Windows' 260-character limit.
_FILE_NAME_MAX_NAME = 60

# What exports write for a message with no text and no attachment file. The
# engine says what happened in event_text for a group change, an unsent
# message or a FaceTime call ("Karin added Theo to the conversation"); other
# such messages get a label by message_type. Anything else is a
# "Conversation update": the engine calls rows it can't name "system" (and
# some "location"), so a more specific label wouldn't be true. The thread
# view (src/lib/messageEvents.ts) uses the same words.
_EVENT_LABELS = {
    "location_started_by_me": "You started sharing your location",
    "location_stopped_by_me": "You stopped sharing your location",
    "location_started_by_them": "Started sharing their location",
    "location_stopped_by_them": "Stopped sharing their location",
    "audio": "Audio message not in this backup",
    "attachment": "Attachment",
    "link": "Link",
    "payment": "Apple Pay payment",
    "digital_touch": "Digital Touch message",
    "handwriting": "Handwritten message",
    "fitness": "Fitness activity",
    "game": "Game message",
    "app": "Message from an iMessage app",
}
_EVENT_FALLBACK = "Conversation update"

# Extensions we try to render as images when sms.db has no mime type.
_IMAGE_EXTENSIONS = (
    ".jpg", ".jpeg", ".png", ".gif", ".heic", ".heif", ".webp", ".bmp", ".tif", ".tiff",
)

# Images every browser shows as they are; other photos get a JPEG copy.
_BROWSER_IMAGE_EXTENSIONS = (".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp")

# Videos, for an old backup whose sms.db has no mime type.
_VIDEO_EXTENSIONS = (".mov", ".mp4", ".m4v")

# Audio most browsers play. iMessage voice messages (.caf) and old .amr ones
# only get a link, which opens them in another app.
_BROWSER_AUDIO_EXTENSIONS = (".mp3", ".m4a", ".aac", ".wav")

# The folder of files beside a web page: "Mom.html" and "Mom_attachments".
ATTACHMENTS_SUFFIX = "_attachments"

# What get_attachment says when there's nothing to give. Matched by the app
# and the contract tests, so they keep their words.
ATTACHMENT_NOT_FOUND = "Attachment not found"  # no attachment has that id
SMS_DB_NOT_FOUND = "sms.db not found"

# How sms.db names an attachment's file: "~/Library/SMS/Attachments/ab/12/<GUID>/IMG_1234.jpeg",
# and in some backups by its full path on the iPhone. The backup lists it
# without either start, in MediaDomain (older ones sometimes in HomeDomain).
_ATTACHMENT_PATH_PREFIXES = ("~/", "/private/var/mobile/", "/var/mobile/")
_ATTACHMENT_DOMAINS = ("MediaDomain", "HomeDomain")

# Ids or paths per IN (...) query: well inside SQLite's limit on parameters,
# which is 999 in builds before 3.32.
_IN_CHUNK = 500

_heif_registered = False


def _save_as_jpeg(src_path: str, dest_path: str, max_px: int) -> bool:
    """Write an image (HEIC included) as an upright JPEG no bigger than
    ``max_px`` on its longest side. Returns False, leaving nothing behind,
    if the image can't be read. Raises if the JPEG can't be written, as
    save_files.write_whole does."""
    global _heif_registered
    try:
        from PIL import Image, ImageOps
    except ImportError:
        return False
    if not _heif_registered:
        try:
            import pillow_heif
            pillow_heif.register_heif_opener()
        except Exception:
            pass
        _heif_registered = True
    try:
        with Image.open(src_path) as opened:
            img = ImageOps.exif_transpose(opened)
            img.thumbnail((max_px, max_px))
            if img.mode not in ("RGB", "L"):
                rgba = img.convert("RGBA")
                flat = Image.new("RGB", rgba.size, (255, 255, 255))
                flat.paste(rgba, mask=rgba.getchannel("A"))
                img = flat
            # In memory first: Pillow raises OSError both for a damaged picture and for a full disk
            jpeg = io.BytesIO()
            img.save(jpeg, "JPEG", quality=85)
    except Exception:
        return False
    write_whole(dest_path, jpeg.getvalue())
    return True


def _relative_attachment_path(sms_filename) -> str:
    """Where the backup lists an attachment: sms.db's file name without "~/" or "/private/var/mobile/"; "" if none."""
    if not isinstance(sms_filename, str):
        return ""
    for prefix in _ATTACHMENT_PATH_PREFIXES:
        if sms_filename.startswith(prefix):
            return sms_filename[len(prefix):]
    return sms_filename


def _attachment_rowid(value) -> Optional[int]:
    """An attachment id as sms.db's ROWID: the app sends a number; None for anything that can't be one."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.strip().isascii() and value.strip().isdigit():
        return int(value)
    return None


def _att_key(att: dict):
    """What a save's writer remembers an attachment by: its id, or the attachment itself without one."""
    att_id = att.get("attachment_id")
    return att_id if isinstance(att_id, int) else ("object", id(att))


def _chunks(items: list, size: int = _IN_CHUNK):
    for start in range(0, len(items), size):
        yield items[start:start + size]


def _manifest_rows(backup, paths: list) -> Optional[list]:
    """(relativePath, domain, fileID) of each file the backup lists at one of ``paths``; None if its list can't be read.

    An encrypted backup's list is read through its decrypted copy, an
    unencrypted one's straight from Manifest.db (or what ios-backup-core
    built from an iOS 9 Manifest.mbdb). The domain is checked by the caller:
    the query goes by relativePath alone, which Manifest.db indexes.
    """
    rows: list = []

    def run(execute) -> None:
        for chunk in _chunks(paths):
            marks = ",".join("?" * len(chunk))
            rows.extend(execute(f"SELECT relativePath, domain, fileID FROM Files WHERE relativePath IN ({marks})",
                                chunk))

    if getattr(backup, "encrypted", False):
        decrypted = getattr(backup, "_decrypted_backup", None)
        if decrypted is None:
            return None
        with decrypted.manifest_db_cursor() as cur:
            run(lambda sql, args: cur.execute(sql, args).fetchall())
        return rows
    get_conn = getattr(backup, "_get_manifest_conn", None)  # kept open while the backup is
    conn = get_conn() if callable(get_conn) else None
    if conn is None:
        return None
    run(lambda sql, args: conn.execute(sql, args).fetchall())
    return rows


def _files_in_backup(backup, relative_paths) -> Optional[set]:
    """Which of these attachment paths the backup has; None when its list of files can't be read.

    A file counts when the backup lists it in MediaDomain or HomeDomain and
    its folder holds it: a backup copied only partway lists files it hasn't
    got (OE-102). A folder that can't be looked in counts as holding it
    (OpenBackup.may_hold). One query for the lot, so a page of messages costs one look
    at the list however many attachments it has.
    """
    paths = sorted({p for p in relative_paths if p})
    if not paths:
        return set()
    rows = _manifest_rows(backup, paths)
    if rows is None:
        return None
    locate = getattr(backup, "locate_file", None)
    may_hold = getattr(backup, "may_hold", None)
    present: set = set()
    for rel, domain, file_id in rows:
        if rel in present or domain not in _ATTACHMENT_DOMAINS:
            continue
        if callable(locate):
            if not (isinstance(file_id, str) and file_id):
                continue
            if not locate(file_id) and not (callable(may_hold) and may_hold(file_id)):
                continue
        present.add(rel)
    return present


def _without_lone_surrogates(text):
    """A conversation name with half an emoji in it (a lone surrogate, which
    JSON.stringify sends as "\\ud83c") can't be written as UTF-8, so the export
    failed. Show that half as "�" instead."""
    if not isinstance(text, str):
        return text
    return "".join("�" if "\ud800" <= ch <= "\udfff" else ch for ch in text)



def _visible(text: str) -> str:
    """A sent file's name without invisible format characters, for saving and showing it.

    A direction mark makes "Invoice<RLO>fdp.exe" read as "Invoiceexe.pdf", a
    program posing as a document. The same rule as app_copies.visible, which
    imports this module, so it can't be imported from there.
    """
    return "".join(ch for ch in (text or "") if unicodedata.category(ch) not in ("Cf", "Zl", "Zp"))

class MessageExtractor:
    """Adapter wrapping the ios-backup-core MessageExtractor.

    Forwards list_conversations, get_messages, and search_messages directly
    to the inner extractor. Keeps openextract's get_attachment and export
    methods (txt/csv/html, separate/merged) inline because the library does
    not provide them.
    """

    # Time zone exports show times in. None is the computer's own, as the
    # app uses; tests set a fixed one.
    local_tz = None

    def __init__(self):
        self._inner = _CoreMessageExtractor()
        # Imported here: app_copies imports this module.
        from app_copies import AppCopies
        from attachment_files import ThumbnailCache
        # Copies for other apps (as_file). Made as the engine starts, which is
        # when the copies an earlier engine left behind are removed.
        self._copies = AppCopies("messages")
        self._thumbnails = ThumbnailCache()

    def close_databases(self) -> None:
        """
        Let go of the sms.db files read so far, which the library otherwise keeps open until the
        engine stops. Windows won't move a folder with a file open in it, and on a Mac the open
        file follows the folder into the Trash and would be shown as whatever backup is next at
        that path. The next call opens what it needs again.
        """
        self._inner.close()

    # ── Delegated raw-extraction methods ─────────────────────────────────────

    def list_conversations(self, backup, contacts: dict) -> dict:
        # No sms.db (a backup that stopped early, or one of a device that never
        # had Messages) means no conversations: a calm empty, like Voicemail's,
        # not a read error with a Report button. The library says "sms.db not
        # found" as an error, so ask it where sms.db is rather than read that.
        if not self._inner._get_sms_db(backup):
            return {"conversations": [], "empty_reason": "not_in_backup"}
        return self._inner.list_conversations(backup, contacts)

    def get_messages(self, backup, chat_id: int, contacts: dict,
                     offset: int = 0, limit: int = 100,
                     date_from: Optional[str] = None,
                     date_to: Optional[str] = None) -> dict:
        result = self._inner.get_messages(
            backup, chat_id, contacts, offset, limit,
            date_from=date_from, date_to=date_to,
        )
        self._describe_attachments(backup, result.get("messages") or [])
        return result

    def search_messages(self, backup, query: str, contacts: dict,
                        chat_id: Optional[int] = None,
                        date_from: Optional[str] = None,
                        date_to: Optional[str] = None,
                        limit: int = 500) -> dict:
        return self._inner.search_messages(
            backup, query, contacts, chat_id,
            date_from=date_from, date_to=date_to, limit=limit,
        )

    # ── openextract-only: where one message sits in its conversation ─────────

    def get_message_offset(self, backup, chat_id: int, message_id: int) -> dict:
        """How many of a conversation's messages are newer than this one.

        get_messages pages from the newest message down (by message id), so
        this is the offset of the page that starts at the message. The UI uses
        it to open a long conversation at a message a search found.
        """
        db_path = self._inner._get_sms_db(backup)
        if not db_path:
            return {"error": "sms.db not found"}

        conn = self._inner._get_conn(db_path, backup)
        newer = conn.execute(
            "SELECT COUNT(DISTINCT message_id) FROM chat_message_join WHERE chat_id = ? AND message_id > ?",
            (chat_id, message_id),
        ).fetchone()[0]
        found = conn.execute(
            "SELECT 1 FROM chat_message_join WHERE chat_id = ? AND message_id = ? LIMIT 1",
            (chat_id, message_id),
        ).fetchone() is not None
        return {"offset": newer, "found": found}

    # ── openextract-only: what a page's attachments are ──────────────────────

    def _describe_attachments(self, backup, messages: list) -> None:
        """Add ``available``, ``uti`` and ``is_sticker`` to each attachment on a page of messages.

        ``available``: whether the backup has the file (see _files_in_backup),
        so the app can say a photo isn't in the backup without asking for it.
        One look at the backup's list of files for the whole page. True for
        every file when that list can't be read; get_attachment then says.
        ``uti``: Apple's name for the type ("public.jpeg",
        "com.apple.coreaudio-format"), or None. ``is_sticker``: False when
        sms.db doesn't say. Never fails the page: anything that can't be read
        is left at those defaults.
        """
        attachments = [a for m in messages for a in (m.get("attachments") or []) if isinstance(a, dict)]
        if not attachments:
            return
        try:
            details = self._attachment_details(backup, [a.get("attachment_id") for a in attachments])
        except Exception as e:  # noqa: BLE001  extras: the page must still come back
            print(f"[messages] couldn't read attachment types: {e}", file=sys.stderr, flush=True)
            details = {}
        try:
            present = _files_in_backup(backup, (_relative_attachment_path(a.get("filename")) for a in attachments))
        except Exception as e:  # noqa: BLE001
            print(f"[messages] couldn't look attachments up in the backup's list of files: {e}",
                  file=sys.stderr, flush=True)
            present = None
        for att in attachments:
            rel = _relative_attachment_path(att.get("filename"))
            att["available"] = bool(rel) and (present is None or rel in present)
            att["uti"], att["is_sticker"] = details.get(att.get("attachment_id"), (None, False))

    def _attachment_details(self, backup, ids: list) -> dict:
        """{attachment id: (uti, is_sticker)} from sms.db, in one query per _IN_CHUNK ids."""
        ids = sorted({i for i in ids if isinstance(i, int) and not isinstance(i, bool)})
        db_path = self._inner._get_sms_db(backup) if ids else None
        if not db_path:
            return {}
        conn = self._inner._get_conn(db_path, backup)
        columns = {row[1] for row in conn.execute("PRAGMA table_info(attachment)")}
        uti = "uti" if "uti" in columns else "NULL"
        sticker = "is_sticker" if "is_sticker" in columns else "0"
        details = {}
        for chunk in _chunks(ids):
            marks = ",".join("?" * len(chunk))
            for row in conn.execute(f"SELECT ROWID, {uti}, {sticker} FROM attachment WHERE ROWID IN ({marks})", chunk):
                details[row[0]] = (row[1] if isinstance(row[1], str) and row[1] else None, bool(row[2]))
        return details

    # ── openextract-only: one attachment's file ──────────────────────────────

    def get_attachment(self, backup, attachment_id, thumbnail: bool = False, as_file: bool = False,
                       on_progress=None) -> dict:
        """One attachment for the app, the way WhatsApp's media comes (whatsapp.py).

        Default: ``{data (base64), mime_type, filename, size}``. The file is
        sent byte for byte, except a HEIC, HEIF or TIFF photo, which comes as
        an upright JPEG. Over attachment_files.MAX_INLINE_BYTES (after that):
        ``{too_large: True, mime_type, filename, size}`` with no data.

        ``thumbnail``: a picture as a small upright JPEG, ``{data, mime_type:
        "image/jpeg", filename, size, width, height}``, where width and height
        are the whole picture's as it is shown. Kept in memory for the next
        ask. Anything else, or a picture that can't be read, is
        ``{no_thumbnail: True, mime_type, filename, size}``: not a failure.

        ``as_file`` (which wins over ``thumbnail``): ``{path, mime_type,
        filename, size, openable}``, a copy under its own name in this engine's
        folder of copies (app_copies.py), for another app to open or the app to
        play. Always a copy, even of an encrypted backup's decrypted file, so
        the app finds every such file in one place. ``openable`` is True only
        for a photo, video, audio file or document. ``on_progress(bytes copied,
        bytes in all)`` is called while a big copy is made.

        ``filename`` is the name it was sent with, ``size`` the file's bytes.
        An id no attachment has is ``{error: "Attachment not found"}``; a file
        the backup hasn't got (never downloaded, or left out of it) is
        ``{error, empty_reason: "not_in_backup"}``; a backup without sms.db is
        ``{error: "sms.db not found"}``.
        """
        import attachment_files as files  # here, not at the top: see attachment_files

        thumbnail, as_file = bool(thumbnail), bool(as_file)
        rowid = _attachment_rowid(attachment_id)
        cache_key = (getattr(backup, "udid", ""), getattr(backup, "backup_dir", ""), rowid)
        if thumbnail and not as_file and rowid is not None:
            cached = self._thumbnails.get(cache_key)
            if cached is not None:
                return cached

        db_path = self._inner._get_sms_db(backup)
        if not db_path:
            return {"error": SMS_DB_NOT_FOUND}
        row = self._attachment_row(db_path, backup, rowid) if rowid is not None else None
        if row is None:
            return {"error": ATTACHMENT_NOT_FOUND}
        sms_filename = row["filename"] or ""
        name = row["transfer_name"] or os.path.basename(sms_filename)
        mime = (files.clean_mime(row["mime_type"]) or files.mime_for(name) or files.mime_for(sms_filename)
                or "application/octet-stream")

        if thumbnail and not as_file and not files.is_picture(mime, name):
            # Nothing to draw. Said without reading the file, which an encrypted
            # backup would first decrypt whole (a long video) only for this.
            return {"no_thumbnail": True, "mime_type": mime, "filename": name, "size": row["total_bytes"]}

        path = self._attachment_file_path(backup, sms_filename)
        try:
            size = os.path.getsize(path) if path else None
        except OSError:
            size = None
        if size is None:
            return files.not_in_backup()

        if as_file:
            return self._copy_for_app(backup, rowid, path, mime, name, size, on_progress)
        if thumbnail:
            made = files.thumbnail(path)
            if made is None:
                return {"no_thumbnail": True, "mime_type": mime, "filename": name, "size": size}
            jpeg, width, height = made
            result = {"data": base64.b64encode(jpeg).decode("ascii"), "mime_type": "image/jpeg",
                      "filename": name, "size": size, "width": width, "height": height}
            self._thumbnails.put(cache_key, result)
            return result
        return files.inline_answer(path, mime, name, size, log_label="messages")

    def _attachment_row(self, db_path: str, backup, rowid: int):
        """sms.db's row for an attachment (filename, mime_type, transfer_name, total_bytes), or None."""
        conn = self._inner._get_conn(db_path, backup)
        schema = self._inner._schema(db_path, conn)
        # Older sms.db files have neither transfer_name nor total_bytes.
        transfer_name = "transfer_name" if schema.get("has_transfer_name") else "NULL"
        total_bytes = "total_bytes" if schema.get("has_total_bytes") else "NULL"
        return conn.execute(
            f"SELECT filename, mime_type, {transfer_name} AS transfer_name, {total_bytes} AS total_bytes "
            "FROM attachment WHERE ROWID = ?",
            (rowid,),
        ).fetchone()

    def _copy_for_app(self, backup, rowid: int, src: str, mime: str, name: str, size: int, on_progress) -> dict:
        import attachment_files as files

        file_name = files.name_for_app(name, mime, "Attachment")
        # A folder per backup and attachment: ids collide between backups.
        copied = files.copy_for_app(self._copies, src, (getattr(backup, "udid", ""), rowid), file_name,
                                    on_progress, log_label="messages")
        if "error" in copied:
            return copied
        return {"path": copied["path"], "mime_type": mime, "filename": name, "size": size,
                "openable": copied["openable"]}

    @staticmethod
    def _attachment_file_path(backup, sms_filename: str) -> Optional[str]:
        """Return the on-disk path of an attachment in the backup, or None.

        sms.db names the file "~/Library/SMS/Attachments/ab/12/<GUID>/IMG_1234.jpeg"
        (or by its full path on the iPhone; see _relative_attachment_path).
        Attachments live in MediaDomain, older ones sometimes in HomeDomain.
        An encrypted backup's file is decrypted to a temp file first.
        """
        relative_path = _relative_attachment_path(sms_filename)
        if not relative_path:
            return None
        file_path = backup.get_file(relative_path, domain="MediaDomain")
        if not file_path:
            file_path = backup.get_file(relative_path, domain="HomeDomain")
        if not file_path or not os.path.exists(file_path):
            return None
        return file_path

    @staticmethod
    def _backup_places(sms_filename: str) -> list:
        """(path, domain) of each place the backup may keep an attachment's file."""
        relative_path = _relative_attachment_path(sms_filename)
        return [(relative_path, domain) for domain in _ATTACHMENT_DOMAINS] if relative_path else []

    def _file_to_save(self, backup, filename: str, listed: bool) -> Optional[str]:
        """The file to copy into a save; None only when the backup hasn't got it.

        ``listed``: the backup has the file (an attachment's ``available``), so
        finding nothing is a failure to read it. It's then looked for again
        (OpenBackup.get_file_again): that's how a full temp folder is told
        apart, and stops the save. Any other failure raises FileNotSaved.
        """
        if not filename:
            return None
        try:
            src = self._attachment_file_path(backup, filename)
            again = getattr(backup, "get_file_again", None)
            if not src and listed and callable(again):
                src = next(filter(None, (again(*place) for place in self._backup_places(filename))), None)
        except SaveStopped:
            raise
        except Exception as e:  # a damaged entry must cost one file, not the save
            raise FileNotSaved(CANT_READ) from e
        if not src and listed:
            raise FileNotSaved(CANT_READ)
        return src

    # ── openextract-only: conversation export to disk ────────────────────────

    @staticmethod
    def _sort_messages_chronologically(messages: list) -> list:
        """Oldest-first order for exports.

        ``get_messages`` returns pages of the *newest* remaining rows (each page
        is chronological within itself). Concatenating those pages without a
        final sort puts newer days before older ones — see GitHub issue #82.
        """
        return sorted(
            messages,
            key=lambda m: (m.get("date") or "", m.get("message_id") or 0),
        )

    def export_conversation(self, backup, chat_id: int, contacts: dict,
                            fmt: str, output_dir: str,
                            date_from: Optional[str] = None,
                            date_to: Optional[str] = None,
                            query: Optional[str] = None,
                            display_name: Optional[str] = None,
                            part: Optional[dict] = None) -> dict:
        """Export a conversation to the specified format, with optional date/search
        filters. ``part`` is one file of a PDF save split by year (pdf_parts.py)."""
        display_name = _without_lone_surrogates(display_name)
        all_messages = self._collect_messages_for_chat(
            backup, chat_id, contacts, date_from, date_to, query, part=part
        )

        if fmt == "txt":
            return self._export_txt(all_messages, chat_id, output_dir, display_name)
        elif fmt == "csv":
            return self._export_csv(all_messages, chat_id, output_dir, display_name)
        elif fmt == "html":
            return self._export_html(
                all_messages, chat_id, output_dir, display_name,
                attachments=_HtmlAttachmentWriter(self, backup),
            )
        elif fmt == "pdf_source":
            return self._export_html(
                all_messages, chat_id, output_dir, display_name,
                attachments=_PrintAttachmentWriter(self, backup, output_dir),
            )
        else:
            return {"error": f"Unsupported format: {fmt}"}

    def _attachment_label(self, msg) -> str:
        """Return a clean text label for a message's attachments."""
        attachments = msg.get("attachments") or []
        if not attachments:
            return "[Attachment]"
        parts = []
        for a in attachments:
            name = _visible(a.get("transfer_name") or a.get("filename") or "")
            mime = a.get("mime_type") or ""
            if mime.startswith("image/"):
                kind = "Image"
            elif mime.startswith("video/"):
                kind = "Video"
            elif mime.startswith("audio/"):
                kind = "Audio"
            else:
                kind = "File"
            label = f"[{kind}: {name}]" if name else f"[{kind}]"
            parts.append(label)
        return " ".join(parts)

    @staticmethod
    def _event_label(msg) -> str:
        """Label for a message with no text and no attachment file, e.g.
        "[Karin added Theo to the conversation]" or "[You started sharing
        your location]". Only a message flagged as having attachments we know
        nothing about is an "[Attachment]"."""
        if msg.get("has_attachments"):
            return "[Attachment]"
        if msg.get("event_text"):
            return f"[{msg['event_text']}]"
        return f"[{_EVENT_LABELS.get(msg.get('message_type'), _EVENT_FALLBACK)}]"

    def _message_text(self, msg) -> str:
        """Return the display text for a message, replacing binary attachment data with labels."""
        if msg.get("has_attachments"):
            label = self._attachment_label(msg)
            text = (msg.get("text") or "").strip()
            return f"{text} {label}".strip() if text else label
        return msg.get("text") or self._event_label(msg)

    @staticmethod
    def _html_escape(value, preserve_newlines: bool = False) -> str:
        """Escape a user-derived value for safe inclusion in exported HTML."""
        escaped = html.escape(str(value)) if value is not None else ""
        if preserve_newlines:
            escaped = escaped.replace("\r\n", "\n").replace("\n", "<br>")
        return escaped

    # ── Dates in exports ─────────────────────────────────────────────────────
    # The engine gives each message's date in UTC ("2024-07-05T16:10:09+00:00").
    # Exports show it in local time, the way the app's thread view does
    # (src/lib/dates.ts): "Jul 5, 2024" for a day, "9:10 AM" for a time. The
    # helpers are in local_dates.py, shared with the other saves.

    def _local_datetime(self, iso) -> Optional[datetime]:
        """A message's date in local time, or None if it has none we can read."""
        return local_datetime(iso, self.local_tz)

    _format_day = staticmethod(format_day)
    _format_time = staticmethod(format_time)

    def _readable_date(self, iso) -> str:
        """"Jul 5, 2024, 9:10 AM", for a TXT line that reads on its own."""
        return readable_date(iso, self.local_tz)

    def _csv_date(self, iso) -> str:
        """"2024-07-05T09:10:09-07:00": the engine's moment, in local time."""
        return csv_date(iso, self.local_tz)

    def _with_day_and_time(self, messages):
        """Yield (msg, day, time) for an HTML export: day is "Jul 5, 2024" on
        the first message of each local day and "" on the rest, time is
        "9:10 AM". A message without a readable date gets its raw date."""
        last_day = None
        for msg in messages:
            dt = self._local_datetime(msg.get("date"))
            if dt is None:
                yield msg, "", msg.get("date") or ""
                continue
            day = self._format_day(dt)
            yield msg, ("" if day == last_day else day), self._format_time(dt)
            last_day = day

    def _get_filename_for_message_export(self, display_name, messages) -> str:
        """File name, without extension, saying who a conversation is with and
        which days it covers, in local time: "Karin Lindqvist, Jul 5 2024 -
        Jun 21 2026", "Karin Lindqvist, Jul 5 2024" for one day, or just
        "Karin Lindqvist" for no messages (a date filter that matched nothing).
        ``messages`` must be sorted oldest-first.

        Safe on Windows and macOS. Returns "" when the name has nothing usable,
        so callers can fall back to ``conversation_<chat_id>``.
        """
        import re

        name = " ".join(re.sub(_FILE_NAME_UNSAFE, " ", str(display_name or "")).split())
        # A leading dot hides a file on a Mac, Windows drops trailing dots and
        # spaces, and a trailing comma would double the one added below.
        name = name[:_FILE_NAME_MAX_NAME].lstrip(". ").rstrip(" .,")
        if not name:
            return ""
        if name.split(".")[0].rstrip().upper() in _WINDOWS_DEVICE_NAMES:
            name = f"_{name}"

        def first_date(msgs):
            dates = (self._local_datetime(m.get("date")) for m in msgs)
            return next((dt for dt in dates if dt is not None), None)

        first, last = first_date(messages), first_date(reversed(messages))
        if first is None:
            return name
        days = [f"{_MONTHS[dt.month - 1]} {dt.day} {dt.year}" for dt in (first, last)]
        return f"{name}, {days[0]}" if days[0] == days[1] else f"{name}, {days[0]} - {days[1]}"

    @staticmethod
    def _unused_name(output_dir, base, ext) -> str:
        """"Mom.txt", or "Mom (2).txt" if that exists, so saving again never
        overwrites a file. The PDF export does the same (electron/newFile.ts).

        A web page needs "Mom_attachments" unused too: that folder is another save's
        (its page moved, another backup's, or People's), and files in it would be replaced."""
        def taken(stem: str) -> bool:
            names = [stem + ext] + ([stem + ATTACHMENTS_SUFFIX] if ext == ".html" else [])
            return any(os.path.lexists(os.path.join(output_dir, name)) for name in names)

        stem, n = base, 2
        while taken(stem):
            stem = f"{base} ({n})"
            n += 1
        return f"{stem}{ext}"

    def _export_txt(self, messages, chat_id, output_dir, display_name = ""):
        base = self._get_filename_for_message_export(display_name, messages)
        filename = self._unused_name(output_dir, base or f"conversation_{chat_id}", ".txt")
        filepath = os.path.join(output_dir, filename)
        with open(filepath, "x", encoding="utf-8-sig") as f:
            for msg in messages:
                date = self._readable_date(msg["date"])
                sender = msg["sender"]
                text = self._message_text(msg) or "[No content]"
                f.write(f"[{date}] {sender}: {text}\n")
        return {"file": filepath, "message_count": len(messages)}

    def _export_csv(self, messages, chat_id, output_dir, display_name = ""):
        base = self._get_filename_for_message_export(display_name, messages)
        filename = self._unused_name(output_dir, base or f"conversation_{chat_id}", ".csv")
        filepath = os.path.join(output_dir, filename)
        with open(filepath, "x", newline="", encoding="utf-8-sig") as f:
            writer = csv.writer(f)
            writer.writerow(["Date", "Sender", "Text", "Is From Me", "Has Attachments"])
            for msg in messages:
                writer.writerow([
                    self._csv_date(msg["date"]), msg["sender"], self._message_text(msg),
                    msg["is_from_me"], msg["has_attachments"]
                ])
        return {"file": filepath, "message_count": len(messages)}

    def _message_html(self, msg, attachments=None) -> str:
        """Inner HTML of one message bubble.

        ``attachments`` draws each attachment: ``_HtmlAttachmentWriter`` (the
        HTML export) shows photos, videos and audio and links every file;
        ``_PrintAttachmentWriter`` (the PDF export) draws images and labels
        the rest. Without one every attachment gets a label. A message with
        no text and no attachment file gets a label saying what it is.
        """
        text = self._html_escape(msg.get("text") or "", preserve_newlines=True)
        if msg.get("attachments"):
            render = attachments.render if attachments is not None else _PrintAttachmentWriter._label
            parts = [render(a) for a in msg["attachments"]]
            if text:
                parts.append(f'<div class="text">{text}</div>')
            return "".join(parts)
        if text:
            return text
        return f'<div class="attachment-label">{self._html_escape(self._event_label(msg))}</div>'

    def _export_html(self, messages, chat_id, output_dir, display_name = "",
                     attachments=None):
        base = self._get_filename_for_message_export(display_name, messages)
        filename = self._unused_name(output_dir, base or f"conversation_{chat_id}", ".html")
        filepath = os.path.join(output_dir, filename)
        if attachments is not None:
            attachments.begin(filepath)
        safe_name = html.escape(display_name) if display_name else ""
        title = f"Conversation Export: {safe_name}" if safe_name else "Conversation Export"
        with new_page(filepath, attachments) as f:
            f.write(f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>{title}</title>
<style>
body {{ font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f5f5f5; }}
.msg {{ margin: 8px 0; padding: 10px 14px; border-radius: 18px; max-width: 75%; clear: both; }}
.sent {{ background: #007AFF; color: white; float: right; border-bottom-right-radius: 4px; }}
.received {{ background: #E9E9EB; color: black; float: left; border-bottom-left-radius: 4px; }}
.meta {{ font-size: 11px; color: #888; clear: both; text-align: center; margin: 12px 0 4px; }}
.day {{ font-size: 12px; font-weight: 600; color: #555; clear: both; text-align: center; margin: 0 0 4px; padding-top: 24px; }}
.sender {{ font-size: 11px; color: #666; margin-bottom: 2px; }}
.conv-title {{ font-size: 18px; color: #333; margin-bottom: 20px; text-align: center; }}
{_ATTACHMENT_CSS}</style></head><body>
""")
            if safe_name:
                f.write(f'<h1 class="conv-title">{safe_name}</h1>\n')
            for msg, day, time in self._with_day_and_time(messages):
                css_class = "sent" if msg["is_from_me"] else "received"
                text = self._message_html(msg, attachments)
                if day:
                    f.write(f'<div class="day">{day}</div>\n')
                f.write(f'<div class="meta">{self._html_escape(time)}</div>\n')
                if not msg["is_from_me"]:
                    f.write(f'<div class="sender">{self._html_escape(msg["sender"])}</div>\n')
                f.write(f'<div class="msg {css_class}">{text}</div>\n')
            f.write(EXPORT_FOOTER_HTML)
            f.write("</body></html>")
        return {"file": filepath, "message_count": len(messages),
                **(attachments.outcome() if attachments is not None else {})}

    # ── Multi-conversation export ────────────────────────────────────────────

    def export_conversations(self, backup, chat_ids: list, conversation_names: dict,
                             contacts: dict, fmt: str, output_dir: str,
                             mode: str = "separate",
                             date_from: Optional[str] = None,
                             date_to: Optional[str] = None,
                             query: Optional[str] = None,
                             part: Optional[dict] = None) -> dict:
        """Export multiple conversations.

        mode="separate" — one file per conversation.
        mode="merged"   — all messages in a single file, sorted by timestamp,
                          with explicit sender/recipient context on each line.
        ``part`` is one file of a PDF save split by year (pdf_parts.py).
        """
        conversation_names = {k: _without_lone_surrogates(v) for k, v in conversation_names.items()}
        if mode == "merged":
            return self._export_merged(
                backup, chat_ids, conversation_names, contacts, fmt, output_dir,
                date_from=date_from, date_to=date_to, query=query, part=part
            )

        files = []
        total_count = 0
        failed_files = 0
        for chat_id in chat_ids:
            try:
                result = self.export_conversation(
                    backup, chat_id, contacts, fmt, output_dir,
                    date_from=date_from, date_to=date_to, query=query,
                    display_name=conversation_names.get(chat_id), part=part
                )
            except SaveStopped as e:
                if fmt != "html":  # a PDF's pages are only staged: none of them is saved yet
                    raise
                raise e.after(len(files), "conversation", failed_files) from None
            if "error" not in result:
                files.append(result["file"])
                total_count += result["message_count"]
                failed_files += result.get("failed_files", 0)
        return {"files": files, "message_count": total_count,
                **({"failed_files": failed_files} if fmt == "html" else {})}

    def _collect_messages_for_chat(self, backup, chat_id, contacts,
                                   date_from=None, date_to=None, query=None, part=None):
        """Collect all messages for a single chat (with optional filters).
        ``part`` keeps one file's months of a PDF save split by year."""
        if part and not date_from and not date_to:
            date_from, date_to = pdf_parts.query_window(part, self.local_tz)
        all_messages = []
        offset = 0
        while True:
            batch = self.get_messages(
                backup, chat_id, contacts, offset, 500,
                date_from=date_from, date_to=date_to
            )
            all_messages.extend(batch["messages"])
            if offset + 500 >= batch["total"]:
                break
            offset += 500
        if query:
            # search_messages picks the matches, but its results lack the attachment
            # details every format reads (has_attachments, attachments, message_type),
            # so export each match's full message. A match get_messages hides (a
            # location balloon) keeps its search result.
            by_id = {msg["message_id"]: msg for msg in all_messages}
            result = self.search_messages(
                backup, query, contacts, chat_id,
                date_from=date_from, date_to=date_to, limit=100000
            )
            all_messages = [
                by_id.get(msg["message_id"]) or {**msg, "has_attachments": False, "attachments": []}
                for msg in result["results"]
            ]
        if part:
            all_messages = [m for m in all_messages
                            if pdf_parts.in_part(self._local_datetime(m.get("date")), part)]
        return self._sort_messages_chronologically(all_messages)

    # ── Planning a PDF save ──────────────────────────────────────────────────

    @staticmethod
    def _print_images(msg) -> int:
        """How many pictures a message puts in a PDF (_PrintAttachmentWriter draws images only)."""
        return sum(1 for att in (msg.get("attachments") or []) if _PrintAttachmentWriter._is_image(att))

    def plan_pdf_parts(self, backup, chat_ids: list, contacts: dict, merged: bool = False,
                       date_from: Optional[str] = None, date_to: Optional[str] = None,
                       query: Optional[str] = None) -> dict:
        """How a PDF save of these conversations should be split (pdf_parts.py):
        ``{groups: [{chat_ids, split, messages, images, parts}]}``, one group per
        file the save would otherwise write (each chat, or all of them merged)."""
        groups = []
        for ids in ([list(chat_ids)] if merged else [[c] for c in chat_ids]):
            counts: dict = {}
            for chat_id in ids:
                msgs = self._collect_messages_for_chat(backup, chat_id, contacts, date_from, date_to, query)
                pdf_parts.count_by_month(msgs, self._local_datetime, self._print_images, counts)
            groups.append({"chat_ids": ids, **pdf_parts.plan(counts)})
        return {"groups": groups}

    def _export_merged(self, backup, chat_ids, conversation_names, contacts,
                       fmt, output_dir, date_from=None, date_to=None, query=None, part=None):
        """Merge messages from multiple conversations into one file, sorted by timestamp."""
        all_messages = []
        for chat_id in chat_ids:
            msgs = self._collect_messages_for_chat(
                backup, chat_id, contacts, date_from, date_to, query, part=part
            )
            conv_name = conversation_names.get(chat_id, f"Chat {chat_id}")
            for msg in msgs:
                msg["_conversation"] = conv_name
            all_messages.extend(msgs)

        all_messages.sort(key=lambda m: m.get("date") or "")

        if fmt == "txt":
            return self._export_merged_txt(all_messages, output_dir)
        elif fmt == "csv":
            return self._export_merged_csv(all_messages, output_dir)
        elif fmt == "html":
            return self._export_merged_html(
                all_messages, output_dir, attachments=_HtmlAttachmentWriter(self, backup),
            )
        elif fmt == "pdf_source":
            return self._export_merged_html(
                all_messages, output_dir,
                attachments=_PrintAttachmentWriter(self, backup, output_dir),
                part_label=pdf_parts.file_label(part),
            )
        else:
            return {"error": f"Unsupported format: {fmt}"}

    def _export_merged_txt(self, messages, output_dir):
        filepath = os.path.join(output_dir, self._unused_name(output_dir, "all_conversations", ".txt"))
        with open(filepath, "x", encoding="utf-8-sig") as f:
            for msg in messages:
                date = self._readable_date(msg["date"])
                sender = msg["sender"]
                conv = msg["_conversation"]
                direction = "to" if msg["is_from_me"] else "from"
                text = self._message_text(msg) or "[No content]"
                f.write(f"[{date}] ({direction} {conv}) {sender}: {text}\n")
        return {"files": [filepath], "message_count": len(messages)}

    def _export_merged_csv(self, messages, output_dir):
        filepath = os.path.join(output_dir, self._unused_name(output_dir, "all_conversations", ".csv"))
        with open(filepath, "x", newline="", encoding="utf-8-sig") as f:
            writer = csv.writer(f)
            writer.writerow(["Date", "Conversation", "Direction", "Sender", "Text", "Is From Me", "Has Attachments"])
            for msg in messages:
                direction = "Sent" if msg["is_from_me"] else "Received"
                writer.writerow([
                    self._csv_date(msg["date"]), msg["_conversation"], direction,
                    msg["sender"], self._message_text(msg),
                    msg["is_from_me"], msg["has_attachments"]
                ])
        return {"files": [filepath], "message_count": len(messages)}

    def _export_merged_html(self, messages, output_dir, attachments=None, part_label=""):
        # One part of a PDF save split by year: "all_conversations 2019-2021"
        name = f"all_conversations {part_label}" if part_label else "all_conversations"
        filepath = os.path.join(output_dir, self._unused_name(output_dir, name, ".html"))
        if attachments is not None:
            attachments.begin(filepath)
        with new_page(filepath, attachments) as f:
            f.write("""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Merged Conversations Export</title>
<style>
body { font-family: -apple-system, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
.msg { margin: 8px 0; padding: 10px 14px; border-radius: 18px; max-width: 75%; clear: both; }
.sent { background: #007AFF; color: white; float: right; border-bottom-right-radius: 4px; }
.received { background: #E9E9EB; color: black; float: left; border-bottom-left-radius: 4px; }
.meta { font-size: 11px; color: #888; clear: both; text-align: center; margin: 12px 0 4px; }
.day { font-size: 12px; font-weight: 600; color: #555; clear: both; text-align: center; margin: 0 0 4px; padding-top: 24px; }
.sender { font-size: 11px; color: #666; margin-bottom: 2px; }
.conv-label { font-size: 10px; color: #999; font-style: italic; }
""" + _ATTACHMENT_CSS + """</style></head><body>
<h2>Merged Conversations</h2>
""")
            for msg, day, time in self._with_day_and_time(messages):
                css_class = "sent" if msg["is_from_me"] else "received"
                text = self._message_html(msg, attachments)
                conv = self._html_escape(msg["_conversation"])
                direction = "to" if msg["is_from_me"] else "from"
                if day:
                    f.write(f'<div class="day">{day}</div>\n')
                f.write(f'<div class="meta">{self._html_escape(time)} <span class="conv-label">({direction} {conv})</span></div>\n')
                if not msg["is_from_me"]:
                    f.write(f'<div class="sender">{self._html_escape(msg["sender"])}</div>\n')
                f.write(f'<div class="msg {css_class}">{text}</div>\n')
            f.write(EXPORT_FOOTER_HTML)
            f.write("</body></html>")
        return {"files": [filepath], "message_count": len(messages),
                **(attachments.outcome() if attachments is not None else {})}


class _PrintAttachmentWriter:
    """Writes a message's images next to a print-ready HTML file.

    Used only for the PDF export: the HTML and its ``attachments/`` folder go
    into a temporary folder that Electron renders to PDF and then deletes, so
    the file names here never reach the user. Images are converted to JPEG
    (HEIC included), turned upright and scaled down to ``PDF_IMAGE_MAX_PX``.
    Videos, audio and other files, and images missing from the backup or that
    can't be read, get a short text label instead, so one bad attachment never
    fails the export. No room to write them stops it (save_files.py).
    """

    SUBDIR = "attachments"
    no_room = NO_ROOM_FOR_PDF

    def __init__(self, extractor: "MessageExtractor", backup, output_dir: str):
        self._extractor = extractor
        self._backup = backup
        self._dir = os.path.join(output_dir, self.SUBDIR)
        self._written: dict = {}
        self._problems: dict = {}
        self.images_written = 0
        self.images_missing = 0

    def begin(self, html_path: str) -> None:
        """Nothing to set up: images go into ``attachments/`` beside the page."""

    def take_back(self) -> None:
        """Nothing to take back: Electron deletes the temporary folder."""

    def outcome(self) -> dict:
        """Nothing to add to the save's result."""
        return {}

    @staticmethod
    def _is_image(att: dict) -> bool:
        mime = (att.get("mime_type") or "").lower()
        if mime.startswith("image/"):
            return mime != "image/svg+xml"
        name = (att.get("filename") or att.get("transfer_name") or "").lower()
        return name.endswith(_IMAGE_EXTENSIONS)

    @staticmethod
    def _label(att: dict, missing: bool = False, href: Optional[str] = None, problem: Optional[str] = None) -> str:
        """``[Video: clip.mov]`` and the like; a link to the file if ``href`` is given."""
        name = _visible(att.get("transfer_name") or os.path.basename(att.get("filename") or ""))
        mime = (att.get("mime_type") or "").lower()
        if _PrintAttachmentWriter._is_image(att):
            kind = "Image"
        elif mime.startswith("video/"):
            kind = "Video"
        elif mime.startswith("audio/"):
            kind = "Audio"
        else:
            kind = "File"
        if problem:
            kind = f"{kind} {problem}"
        elif missing:
            kind = f"{kind} not in this backup"
        label = MessageExtractor._html_escape(f"[{kind}: {name}]" if name else f"[{kind}]")
        if href:
            label = f'<a href="{href}">{label}</a>'
        return f'<div class="attachment-label">{label}</div>'

    def _convert(self, src_path: str, dest_path: str) -> bool:
        return _save_as_jpeg(src_path, dest_path, PDF_IMAGE_MAX_PX)

    def _draw(self, src_path: str, dest_path: str) -> bool:
        """_convert into the staging folder. No room there is this computer's, wherever the PDF is going."""
        try:
            os.makedirs(self._dir, exist_ok=True)
            return self._convert(src_path, dest_path)
        except OSError as e:
            log_failure("a PDF stopped", e)
            raise SaveStopped(write_error(e, self.no_room)) from None

    def render(self, att: dict) -> str:
        """Return the HTML for one attachment inside a message bubble."""
        if not self._is_image(att):
            return self._label(att)

        # attachment_id is sms.db's ROWID, unique within the backup, so it
        # names the file. Several conversations exported into one folder (or
        # the same image forwarded twice) then share one copy.
        att_id = att.get("attachment_id")
        if isinstance(att_id, int) and att_id in self._written:
            rel = self._written[att_id]
        else:
            rel = None
            name = f"{att_id}.jpg" if isinstance(att_id, int) else f"x{uuid.uuid4().hex}.jpg"
            dest = os.path.join(self._dir, name)
            if os.path.exists(dest):
                rel = f"{self.SUBDIR}/{name}"
            else:
                try:
                    src = self._extractor._file_to_save(self._backup, att.get("filename") or "",
                                                        att.get("available") is True)
                    if src:
                        if not self._draw(src, dest):
                            raise FileNotSaved(CANT_READ)
                        rel = f"{self.SUBDIR}/{name}"
                        self.images_written += 1
                except FileNotSaved as e:
                    self._problems[_att_key(att)] = e.problem
                    log_failure(f"attachment {att_id} isn't in the PDF", e)
            if rel is None:
                self.images_missing += 1
            if isinstance(att_id, int):
                self._written[att_id] = rel

        if rel is None:
            return self._label(att, missing=True, problem=self._problems.get(_att_key(att)))
        alt = MessageExtractor._html_escape(_visible(att.get("transfer_name") or "") or "Image")
        return f'<img src="{rel}" alt="{alt}">'


class _HtmlAttachmentWriter:
    """Saves a message's attachments beside an HTML export and shows them.

    Every file is copied as it is into a folder named after the page
    (``Mom.html`` gets ``Mom_attachments/``), so the two can be moved or
    shared together. Photos and GIFs show in the bubble, videos and common
    audio get a player, and everything links to its file, so a format the
    browser can't play (HEVC video on some PCs, voice messages) still opens
    in another app. Photos browsers can't show (HEIC, TIFF) also get a JPEG
    copy for the page. An attachment missing from the backup gets a label, as
    does one that can't be read or saved (counted in ``failed_files``), so one
    bad file never fails the export. No room to write stops it (save_files.py).
    """

    no_room = NO_ROOM

    def __init__(self, extractor: "MessageExtractor", backup):
        self._extractor = extractor
        self._backup = backup
        self._dir = ""
        self._rel = ""
        self._written: dict = {}
        self._problems: dict = {}
        # What this save made, to take back if it stops
        self._made: list = []
        self._made_dir = False
        self.files_written = 0
        self.files_missing = 0
        self.files_failed = 0

    def begin(self, html_path: str) -> None:
        """Use the folder beside ``html_path``. Called before any render()."""
        base = os.path.splitext(os.path.basename(html_path))[0]
        self._rel = f"{base}{ATTACHMENTS_SUFFIX}"
        self._dir = os.path.join(os.path.dirname(html_path), self._rel)

    @staticmethod
    def _file_name(att: dict) -> str:
        """``<attachment id>-<name it was sent with>``, safe on every system.

        attachment_id is sms.db's ROWID, unique within the backup, so two
        files sent with the same name (IMG_0001.HEIC) never collide.
        """
        name = att.get("transfer_name") or os.path.basename(att.get("filename") or "") or "attachment"
        # Nothing invisible: a direction mark makes "Invoice<RLO>fdp.exe" read as "Invoiceexe.pdf"
        name = _visible(name)
        name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", name.replace("\\", "/").rsplit("/", 1)[-1])
        name = name.strip(" .") or "attachment"
        stem, ext = os.path.splitext(name)
        # At most 80 characters and, for file systems that count bytes (255 on Linux), 180 bytes,
        # never cutting a character in half
        stem = stem[:80].encode("utf-8")[:180].decode("utf-8", "ignore").rstrip(" .") or "attachment"
        ext = (ext or _HtmlAttachmentWriter._ext(att))[:16].encode("utf-8")[:32].decode("utf-8", "ignore")
        name = stem + ext
        att_id = att.get("attachment_id")
        prefix = str(att_id) if isinstance(att_id, int) else f"x{uuid.uuid4().hex[:12]}"
        return f"{prefix}-{name}"

    @staticmethod
    def _ext(att: dict) -> str:
        for name in (att.get("filename"), att.get("transfer_name")):
            ext = os.path.splitext(name or "")[1].lower()
            if ext:
                return ext
        return ""

    def _href(self, name: str) -> str:
        return MessageExtractor._html_escape(quote(f"{self._rel}/{name}"))

    def outcome(self) -> dict:
        """What the save's result says about its files."""
        return {"failed_files": self.files_failed}

    def take_back(self) -> None:
        """Remove what this save made, and nothing that was there before it."""
        for path in self._made:
            remove(path)
        if self._made_dir:
            try:
                os.rmdir(self._dir)
            except OSError:
                pass  # something else is in it, or the drive is gone

    def _put(self, src: str, name: str) -> None:
        """Copy ``src`` into the folder as ``name``. FileNotSaved is that file's problem, an OSError the save's."""
        dest = os.path.join(self._dir, name)
        there = os.path.lexists(dest)
        if there:
            try:
                # The same conversation saved again into the same folder.
                if os.path.isfile(dest) and os.path.getsize(dest) == os.path.getsize(src):
                    return
            except OSError as e:
                raise FileNotSaved(CANT_READ) from e
        if not os.path.isdir(self._dir):
            os.makedirs(self._dir, exist_ok=True)
            self._made_dir = True
        copy_whole(src, dest)
        if not there:
            self._made.append(dest)

    def _failed(self, key, error: FileNotSaved, counts: bool = True) -> None:
        self._problems[key] = error.problem
        if counts:
            self.files_failed += 1
        log_failure(f"file {key} {error.problem}", error)

    def _copy(self, att: dict) -> Optional[str]:
        """Copy the attachment into the folder once; its file name, or None."""
        att_id = att.get("attachment_id")
        if isinstance(att_id, int) and att_id in self._written:
            return self._written[att_id]
        name = None
        try:
            src = self._extractor._file_to_save(self._backup, att.get("filename") or "",
                                                att.get("available") is True)
            if src:
                file_name = self._file_name(att)
                self._put(src, file_name)
                name = file_name
                self.files_written += 1
            else:
                self.files_missing += 1
        except FileNotSaved as e:
            self._failed(_att_key(att), e)
        if isinstance(att_id, int):
            self._written[att_id] = name
        return name

    def _preview(self, att: dict, name: str) -> Optional[str]:
        """The JPEG copy of a saved photo browsers can't show; its file name, or None."""
        preview = os.path.splitext(name)[0] + ".jpg"
        path = os.path.join(self._dir, preview)
        if os.path.isfile(path):
            return preview
        key = ("preview", _att_key(att))
        if key in self._problems:
            return None
        try:
            if not _save_as_jpeg(os.path.join(self._dir, name), path, HTML_PREVIEW_MAX_PX):
                return None
        except FileNotSaved as e:
            self._failed(key, e)
            return None
        self._made.append(path)
        return preview

    def _preview_note(self, att: dict) -> str:
        """What the page says under a photo whose JPEG copy couldn't be saved."""
        problem = self._problems.get(("preview", _att_key(att)))
        if not problem:
            return ""
        return f'<div class="attachment-label">{MessageExtractor._html_escape(f"Preview {problem}")}</div>'

    def render(self, att: dict) -> str:
        """Return the HTML for one attachment inside a message bubble."""
        name = self._copy(att)
        if name is None:
            return _PrintAttachmentWriter._label(att, missing=True, problem=self._problems.get(_att_key(att)))

        href = self._href(name)
        title = MessageExtractor._html_escape(_visible(att.get("transfer_name") or "") or name)
        mime = (att.get("mime_type") or "").lower()
        ext = self._ext(att)

        if _PrintAttachmentWriter._is_image(att):
            if ext in _BROWSER_IMAGE_EXTENSIONS:
                return f'<a href="{href}"><img src="{href}" alt="{title}" loading="lazy"></a>'
            preview = self._preview(att, name)
            if preview:
                src = self._href(preview)
                return f'<a href="{src}"><img src="{src}" alt="{title}" loading="lazy"></a>'
            return _PrintAttachmentWriter._label(att, href=href) + self._preview_note(att)

        if mime.startswith("video/") or ext in _VIDEO_EXTENSIONS:
            # #t=0.001 makes Safari show the first frame instead of a black box.
            return (f'<video controls preload="metadata" src="{href}#t=0.001" title="{title}"></video>'
                    f'<div class="attachment-link"><a href="{href}">{title}</a></div>')

        if mime.startswith("audio/") and ext in _BROWSER_AUDIO_EXTENSIONS:
            return (f'<audio controls preload="none" src="{href}" title="{title}"></audio>'
                    f'<div class="attachment-link"><a href="{href}">{title}</a></div>')

        return _PrintAttachmentWriter._label(att, href=href)
