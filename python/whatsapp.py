"""
WhatsApp adapter.

Delegates reading (chats, pages, offsets, search, where a media file is) to
``ios_backup_core.extractors.whatsapp.WhatsAppExtractor``. Keeps what is
openextract's own:

  * ``get_attachment``: the library hands back a path on disk. The app wants
    the bytes (base64), or, to open a video or document in another app, a
    copy named with its real extension. A file too big to send in one
    JSON-RPC line comes back as ``too_large`` instead.
  * exports (txt, csv, html with the media in a folder beside it, and
    ``pdf_source``, the print-ready HTML Electron turns into a PDF). They
    reuse Messages' export helpers (file names, local dates, the attachment
    folder) but say things WhatsApp's way: arrival order, notices without a
    sender, replies, reactions, calls and locations.

Ids are ChatStorage.sqlite primary keys and overlap with sms.db's ROWIDs. A
WhatsApp id must never reach a Messages method, nor a Messages id this one:
each would quietly return the wrong rows rather than fail.
"""

import atexit
import base64
import csv
import heapq
import html
import io
import mimetypes
import os
import re
import shutil
import sys
import tempfile
import time
import unicodedata
import uuid
from typing import Optional

from messages import (
    EXPORT_FOOTER_HTML,
    HTML_PREVIEW_MAX_PX,
    MessageExtractor,
    _ATTACHMENT_CSS,
    _BROWSER_IMAGE_EXTENSIONS,
    _FILE_NAME_UNSAFE,
    _HtmlAttachmentWriter,
    _IMAGE_EXTENSIONS,
    _PrintAttachmentWriter,
    _VIDEO_EXTENSIONS,
    _WINDOWS_DEVICE_NAMES,
    _save_as_jpeg,
    _without_lone_surrogates,
)

try:
    from ios_backup_core.extractors.whatsapp import (
        SHARED_DOMAIN,
        UNSUPPORTED,
        WhatsAppExtractor as _CoreWhatsAppExtractor,
    )
except ImportError:
    # An ios-backup-core from before WhatsApp support (ios-backup-core#28). The
    # engine must still start and every other section still work, so WhatsApp
    # answers as if it weren't in the backup (see _NoWhatsAppSupport).
    _CoreWhatsAppExtractor = None
    SHARED_DOMAIN = "AppDomainGroup-group.net.whatsapp.WhatsApp.shared"
    UNSUPPORTED = None

__all__ = ["WhatsAppExtractor", "SHARED_DOMAIN", "MAX_INLINE_BYTES"]

# What the app is told, in words for people.
NOT_IN_BACKUP = "WhatsApp is not in this backup"
FILE_NOT_IN_BACKUP = "This file isn't in the backup"
FILE_UNREADABLE = "This file couldn't be read from the backup"
FILE_NOT_COPIED = "This file couldn't be copied to open it"

# The library's words for the same things, which get_attachment translates.
_LIB_FILE_MISSING = "Attachment file not found in backup"
_LIB_NOT_IN_BACKUP = "WhatsApp is not in this backup"

# Biggest file sent inline as base64. Base64 makes it a third bigger, and the
# whole thing travels as one JSON line that Electron reads into memory, so a
# long video is better opened in another app (as_file).
MAX_INLINE_BYTES = 25 * 1024 * 1024

# Copies made for opening in another app live in one folder per engine, under
# the system's temp folder, named "openextract-whatsapp-<engine's process
# id>-<random>". The app stops the engine by killing it, so an engine rarely
# cleans up after itself: the next one removes the folders of engines that
# have ended as it starts. A folder whose process id is in use (a second
# OpenExtract, or a new process given the same id) is removed only once it
# hasn't been touched for _STALE_SECONDS; an engine touches its own on every
# copy. Electron's PDF staging folders use the same hour.
_TEMP_PREFIX = "openextract-whatsapp-"
_TEMP_OWNER = re.compile(re.escape(_TEMP_PREFIX) + r"(\d+)-")
_STALE_SECONDS = 3600

# Copies another app may open (``openable``), by extension, which is what
# Windows and macOS go by when they open a file: photos, videos, audio and
# documents, which a viewer opens without running anything. Everything else (a
# program, script, shortcut, archive, web page, contact or calendar file, or a
# name with no extension) is still copied, but only to show in its folder. The
# sender chose the name: "Invoice.pdf.exe" opened from here would run, and
# Windows wouldn't warn, since the copy didn't come from the internet.
_OPENABLE_EXTENSIONS = frozenset({
    # photos
    "jpg", "jpeg", "png", "gif", "webp", "heic", "heif", "bmp", "tif", "tiff",
    # video
    "mp4", "mov", "m4v", "3gp", "avi", "mkv", "webm",
    # audio
    "opus", "ogg", "oga", "mp3", "m4a", "aac", "wav", "amr", "caf", "flac",
    # documents
    "pdf", "txt", "rtf", "csv", "doc", "docx", "xls", "xlsx", "ppt", "pptx",
    "odt", "ods", "odp", "pages", "numbers", "key", "epub",
})

# Longest copy name, before its extension: 80 characters keeps a Windows path
# well inside 260, and 200 bytes keeps the name, its extension and the
# ".<8 hex>.partial" of a copy in progress inside the 255 bytes Linux allows
# (a title in Chinese or emoji takes 3 or 4 bytes a character).
_COPY_STEM_CHARS = 80
_COPY_STEM_BYTES = 200
_COPY_EXT_BYTES = 16

# Rows per page while an export reads a chat (the engine's own read, not the
# app's paging).
_EXPORT_PAGE = 500

# Words for a kind of media, by the library's message_type.
_KIND_WORDS = {
    "image": "Photo",
    "video": "Video",
    "audio": "Audio",
    "document": "Document",
    "gif": "GIF",
    "sticker": "Sticker",
}

# The library names media that never made it into the backup with one of
# these labels instead of a file name; they aren't names to repeat.
_PLACEHOLDER_NAMES = {
    "Photo", "Video", "Audio", "Document", "GIF", "Sticker", "Attachment",
    "View-once photo", "View-once video", "View-once voice message", "Video message",
}

# What a quoted message was, when it had no text to show.
_QUOTE_KINDS = {
    "image": "Photo", "video": "Video", "audio": "Audio", "document": "Document",
    "gif": "GIF", "sticker": "Sticker", "contact": "Contact card",
    "shared_location": "Location", "live_location": "Live location",
    "link": "Link", "call": "Call", "poll": "Poll", "view_once": "View-once media",
}

# The CSV's Type column.
_TYPE_WORDS = {
    "text": "Text", "image": "Photo", "video": "Video", "audio": "Audio",
    "document": "Document", "gif": "GIF", "sticker": "Sticker",
    "contact": "Contact card", "shared_location": "Location",
    "live_location": "Live location", "link": "Link", "deleted": "Deleted",
    "view_once": "View once", "poll": "Poll", "call": "Call",
    "system": "WhatsApp notice", "unknown": "Other",
}

# Audio a browser plays: Messages' list plus WhatsApp's voice notes, which are
# Opus in an Ogg file (Chromium, Firefox and Safari 17+ play them).
_PLAYABLE_AUDIO = (".mp3", ".m4a", ".aac", ".wav", ".opus", ".ogg", ".oga")

# Longest quoted text repeated in an export before it is cut short.
_QUOTE_MAX = 120

_CSV_HEADER = ["Date", "Sender", "Text", "Is From Me", "Has Attachments", "Type", "Replying To", "Reactions"]
_MERGED_CSV_HEADER = ["Date", "Conversation", "Direction", "Sender", "Text", "Is From Me", "Has Attachments",
                      "Type", "Replying To", "Reactions"]

# A cell starting with one of these is a formula to Excel and LibreOffice. The
# sender writes the text (and the names), so "=HYPERLINK(...)" would become a
# live link that can send the cells around it away: such a cell gets a ' in
# front, which a spreadsheet takes as "this is text".
_FORMULA_START = ("=", "+", "-", "@", "\t", "\r")


class _NoWhatsAppSupport:
    """Stands in for the library's extractor when ios-backup-core has none."""

    def __init__(self):
        print("[whatsapp] this ios-backup-core has no WhatsApp extractor; WhatsApp shows as not in the backup",
              file=sys.stderr, flush=True)

    def clear_cache(self):
        pass

    def has_whatsapp(self, backup):
        return {"has_whatsapp": False, "chats": 0, "messages": 0, "empty_reason": "not_in_backup"}

    def list_conversations(self, backup, contacts):
        return {"conversations": [], "empty_reason": "not_in_backup"}

    def get_messages(self, backup, chat_id, contacts, offset=0, limit=100, date_from=None, date_to=None):
        return {"messages": [], "total": 0, "next_offset": offset, "offset": offset, "limit": limit,
                "empty_reason": "not_in_backup"}

    def get_message_offset(self, backup, chat_id, message_id):
        return {"offset": 0, "found": False}

    def search_messages(self, backup, query, contacts, chat_id=None, date_from=None, date_to=None, limit=500):
        return {"results": [], "query": query, "empty_reason": "not_in_backup"}

    def get_attachment(self, backup, attachment_id, thumbnail=False):
        return {"error": _LIB_NOT_IN_BACKUP}


class _StoreProblem(Exception):
    """The store couldn't be read (or isn't there) while an export read it; ``result`` is what to return."""

    def __init__(self, result: dict):
        super().__init__(result.get("error"))
        self.result = result


def _problem(result: dict) -> Optional[dict]:
    """The error to return for a page or search result that says the store can't be read, else None."""
    reason = result.get("empty_reason")
    if result.get("error"):
        problem = {"error": result["error"]}
        if reason:
            problem["empty_reason"] = reason
        return problem
    if reason == "not_in_backup":
        return {"error": NOT_IN_BACKUP, "empty_reason": "not_in_backup"}
    return None


# ── Media files ──────────────────────────────────────────────────────────────

def _is_heif(mime: str, name: str) -> bool:
    return (mime or "").lower() in ("image/heic", "image/heif") or (name or "").lower().endswith((".heic", ".heif"))


def _heif_as_jpeg(raw: bytes) -> Optional[bytes]:
    """A HEIC/HEIF photo as JPEG, which the app can show; None if it can't be converted."""
    try:
        import pillow_heif
        from PIL import Image

        pillow_heif.register_heif_opener()
        with Image.open(io.BytesIO(raw)) as img:
            out = io.BytesIO()
            img.convert("RGB").save(out, format="JPEG", quality=90)
            return out.getvalue()
    except Exception:
        return None


def _extension_for(mime: str) -> str:
    mime = (mime or "").split(";")[0].strip().lower()
    if not mime:
        return ""
    known = {"image/jpeg": ".jpg", "audio/ogg": ".ogg", "audio/mpeg": ".mp3", "video/quicktime": ".mov"}
    return known.get(mime) or mimetypes.guess_extension(mime) or ""


def _openable_extension(ext: str) -> bool:
    """Whether ".pdf" (say) is a photo, video, audio file or document's extension (see _OPENABLE_EXTENSIONS)."""
    return ext.lower().lstrip(".") in _OPENABLE_EXTENSIONS


def _is_openable(file_name: str) -> bool:
    return _openable_extension(os.path.splitext(file_name)[1])


def _visible(text: str) -> str:
    """``text`` without invisible format characters.

    Direction marks can make "Invoice<RLO>fdp.exe" read as "Invoiceexe.pdf";
    zero-width spaces and joiners hide inside a name. Unicode calls all of
    them "format" characters (Cf), which covers messages.py's
    _FILE_NAME_UNSAFE marks and more; line and paragraph separators go too.
    """
    return "".join(ch for ch in text if unicodedata.category(ch) not in ("Cf", "Zl", "Zp"))


def _cut_utf8(text: str, max_bytes: int) -> str:
    """The longest start of ``text`` that is at most ``max_bytes`` in UTF-8, never half a character."""
    return text.encode("utf-8")[:max_bytes].decode("utf-8", "ignore")


def _name_for_app(name: str, mime: str, thumbnail: bool) -> str:
    """A file name another app will open: the file's own name, safe on every system, with a real extension.

    WhatsApp's thumbnails end in ".thumb" though they are JPEG, and a name can
    lack an extension altogether; the system then wouldn't know what opens it.
    The MIME type supplies one then, but only one of _OPENABLE_EXTENSIONS: the
    sender declared that type, and "Invoice" sent as a program must not
    become "Invoice.exe".
    """
    name = _visible(_without_lone_surrogates(name or "")).replace("\\", "/").rsplit("/", 1)[-1]
    name = re.sub(f"(?:{_FILE_NAME_UNSAFE})+", "_", name).strip(" .")
    stem, ext = os.path.splitext(name)
    if thumbnail or not ext or ext.lower() == ".thumb":
        guessed = _extension_for(mime)
        if _openable_extension(guessed):
            ext = guessed
    stem = _cut_utf8(stem[:_COPY_STEM_CHARS], _COPY_STEM_BYTES).strip(" .") or "WhatsApp file"
    if stem.split(".")[0].rstrip().upper() in _WINDOWS_DEVICE_NAMES:
        stem = f"_{stem}"
    return stem + _cut_utf8(ext, _COPY_EXT_BYTES)


def _safe_part(value) -> str:
    return re.sub(r"[^A-Za-z0-9_-]+", "_", str(value or "")).strip("_") or "backup"


class WhatsAppExtractor:
    """Adapter wrapping ios-backup-core's WhatsAppExtractor."""

    def __init__(self):
        self._inner = _CoreWhatsAppExtractor() if _CoreWhatsAppExtractor is not None else _NoWhatsAppSupport()
        self._temp_dir: Optional[str] = None
        self._export = _WhatsAppExport(self)
        # Made once, as the engine starts: copies an earlier engine left behind
        # (decrypted, under readable names) shouldn't wait for a file to be opened.
        _remove_stale_temp_dirs()

    # Time zone exports show times in: None is the computer's own. Tests set one.
    @property
    def local_tz(self):
        return self._export.local_tz

    @local_tz.setter
    def local_tz(self, tz):
        self._export.local_tz = tz

    # ── Delegated reads ──────────────────────────────────────────────────────

    def clear_cache(self) -> None:
        self._inner.clear_cache()

    def has_whatsapp(self, backup) -> dict:
        return self._inner.has_whatsapp(backup)

    def list_conversations(self, backup, contacts: dict) -> dict:
        return self._inner.list_conversations(backup, contacts)

    def get_messages(self, backup, chat_id, contacts: dict, offset=0, limit=100,
                     date_from: Optional[str] = None, date_to: Optional[str] = None) -> dict:
        return self._inner.get_messages(backup, chat_id, contacts, offset, limit,
                                        date_from=date_from, date_to=date_to)

    def get_message_offset(self, backup, chat_id, message_id) -> dict:
        return self._inner.get_message_offset(backup, chat_id, message_id)

    def search_messages(self, backup, query, contacts: dict, chat_id=None,
                        date_from: Optional[str] = None, date_to: Optional[str] = None, limit=500) -> dict:
        return self._inner.search_messages(backup, query, contacts, chat_id,
                                           date_from=date_from, date_to=date_to, limit=limit)

    # ── One media file ───────────────────────────────────────────────────────

    def get_attachment(self, backup, attachment_id, thumbnail: bool = False, as_file: bool = False) -> dict:
        """A media file (or its thumbnail) for the app.

        Default: ``{data (base64), mime_type, filename, size}``; HEIC photos
        come as JPEG. ``as_file``: ``{path, mime_type, filename, size,
        openable}``, a copy named with its real extension. ``openable`` is True
        only for a photo, video, audio file or document, which the app may
        open in another app; anything else it only shows in its folder. Over
        MAX_INLINE_BYTES and not ``as_file``: ``{too_large: True, ...}`` with
        no data. A file that isn't in the backup, or a backup without
        WhatsApp, is ``{error, empty_reason: "not_in_backup"}``: common
        (media never downloaded, or left out of the backup), not a failure.
        An id that matches nothing is ``{error: "Attachment not found"}``.
        """
        thumbnail, as_file = bool(thumbnail), bool(as_file)
        found = self._inner.get_attachment(backup, attachment_id, thumbnail=thumbnail)
        if found.get("error"):
            return self._attachment_error(found["error"])
        path, name = found.get("path"), found.get("filename") or ""
        # Without parameters ("audio/ogg; codecs=opus" is stored for voice notes):
        # the app puts it in a data: URL, where a space doesn't belong.
        mime = (found.get("mime_type") or "").split(";")[0].strip().lower()
        mime = mime or mimetypes.guess_type(name)[0] or "application/octet-stream"
        try:
            size = os.path.getsize(path)
        except (OSError, TypeError):
            return {"error": FILE_NOT_IN_BACKUP, "empty_reason": "not_in_backup"}
        if as_file:
            return self._copy_for_app(backup, attachment_id, thumbnail, path, mime, name, size)
        if size > MAX_INLINE_BYTES:
            return {"too_large": True, "mime_type": mime, "filename": name, "size": size}
        try:
            with open(path, "rb") as f:
                raw = f.read()
        except OSError as e:
            print(f"[whatsapp] could not read attachment {attachment_id}: {e}", file=sys.stderr, flush=True)
            return {"error": FILE_UNREADABLE}
        if not thumbnail and _is_heif(mime, name):
            converted = _heif_as_jpeg(raw)
            if converted is not None:
                raw, mime = converted, "image/jpeg"
        return {"data": base64.b64encode(raw).decode("ascii"), "mime_type": mime, "filename": name, "size": size}

    @staticmethod
    def _attachment_error(message: str) -> dict:
        if message == _LIB_FILE_MISSING:
            return {"error": FILE_NOT_IN_BACKUP, "empty_reason": "not_in_backup"}
        if message == _LIB_NOT_IN_BACKUP:
            return {"error": NOT_IN_BACKUP, "empty_reason": "not_in_backup"}
        if UNSUPPORTED and message == UNSUPPORTED:
            return {"error": message, "empty_reason": "unsupported_format"}
        # "Attachment not found" (no such id), or the store couldn't be read.
        return {"error": message}

    def _temp_root(self) -> str:
        """This engine's folder for copies, made on first use (and again if something removed it)."""
        if self._temp_dir and os.path.isdir(self._temp_dir):
            return self._temp_dir
        if self._temp_dir is None:
            # Runs only when the engine exits on its own; see _TEMP_PREFIX.
            atexit.register(_remove_dir, lambda: self._temp_dir)
        self._temp_dir = tempfile.mkdtemp(prefix=f"{_TEMP_PREFIX}{os.getpid()}-")
        return self._temp_dir

    def _copy_for_app(self, backup, attachment_id, thumbnail, src, mime, name, size) -> dict:
        root = self._temp_root()
        try:
            os.utime(root)  # still in use: see _STALE_SECONDS
        except OSError:
            pass
        # One folder per backup and attachment keeps the file's own name (what
        # the other app shows) while ids that collide between backups don't.
        key = f"{attachment_id}-thumb" if thumbnail else str(attachment_id)
        folder = os.path.join(root, _safe_part(getattr(backup, "udid", "")), _safe_part(key))
        file_name = _name_for_app(name, mime, thumbnail)
        dest = os.path.join(folder, file_name)
        try:
            if not _same_file(src, dest):
                os.makedirs(folder, exist_ok=True)
                try:
                    _replace_with_copy(src, dest)
                except OSError:
                    # The earlier copy is open in another app (Windows won't
                    # replace it then): make a new one beside it.
                    folder = os.path.join(folder, uuid.uuid4().hex[:8])
                    os.makedirs(folder, exist_ok=True)
                    dest = os.path.join(folder, file_name)
                    _replace_with_copy(src, dest)
        except OSError as e:
            print(f"[whatsapp] could not copy attachment {attachment_id}: {e}", file=sys.stderr, flush=True)
            return {"error": FILE_NOT_COPIED}
        return {"path": dest, "mime_type": mime, "filename": name, "size": size, "openable": _is_openable(file_name)}

    # ── Exports ──────────────────────────────────────────────────────────────

    def export_conversation(self, backup, chat_id, contacts: dict, fmt: str, output_dir: str,
                            date_from: Optional[str] = None, date_to: Optional[str] = None,
                            query: Optional[str] = None, display_name: Optional[str] = None) -> dict:
        """Save one chat: ``{file, message_count}``, or ``{error}`` (with ``empty_reason`` when WhatsApp isn't readable)."""
        return self._export.export_conversation(backup, chat_id, contacts, fmt, output_dir,
                                                date_from=date_from, date_to=date_to, query=query,
                                                display_name=display_name)

    def export_conversations(self, backup, chat_ids: list, conversation_names: dict, contacts: dict,
                             fmt: str, output_dir: str, mode: str = "separate",
                             date_from: Optional[str] = None, date_to: Optional[str] = None,
                             query: Optional[str] = None) -> dict:
        """Save several chats, one file each ("separate") or all in one ("merged"): ``{files, message_count}``."""
        return self._export.export_conversations(backup, chat_ids, conversation_names, contacts, fmt, output_dir,
                                                 mode=mode, date_from=date_from, date_to=date_to, query=query)


def _same_file(src: str, dest: str) -> bool:
    """``dest`` is already a copy of ``src``: _replace_with_copy gives it the same size and modification time.

    On a disk that keeps coarser times the copy is just made again.
    """
    try:
        a, b = os.stat(src), os.stat(dest)
    except OSError:
        return False
    return a.st_size == b.st_size and a.st_mtime_ns == b.st_mtime_ns


def _replace_with_copy(src: str, dest: str) -> None:
    """Copy ``src`` to ``dest`` whole: never a half-written file under the real name.

    The bytes and the modification time only (for _same_file). Not the
    permissions: a backup on an exFAT or NTFS drive marks every file
    executable, and macOS runs an executable file it is asked to open. The
    copy is readable by its owner only, where the system has such
    permissions (Windows' chmod only sets read-only, which would stop the
    copy being replaced or removed).
    """
    partial = f"{dest}.{uuid.uuid4().hex[:8]}.partial"
    try:
        shutil.copyfile(src, partial)
        stat = os.stat(src)
        os.utime(partial, ns=(stat.st_atime_ns, stat.st_mtime_ns))
        if os.name != "nt":
            os.chmod(partial, 0o600)
        os.replace(partial, dest)
    finally:
        if os.path.exists(partial):
            try:
                os.remove(partial)
            except OSError:
                pass


def _remove_dir(get_path) -> None:
    path = get_path()
    if path:
        shutil.rmtree(path, ignore_errors=True)


def _process_running(pid: int) -> bool:
    """Whether a process with this id is running; True when that can't be told (the age rule then decides)."""
    if pid == os.getpid():
        return True
    if pid <= 0 or pid > 0xFFFFFFFF:
        return False  # no engine has such an id (and os.kill(0, ...) would mean this process group)
    if os.name == "nt":
        # Never os.kill here: on Windows it ends the process whatever the signal.
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        kernel32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        kernel32.GetExitCodeProcess.restype = wintypes.BOOL
        kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
        handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return ctypes.get_last_error() != 87  # ERROR_INVALID_PARAMETER: no such process
        try:
            code = wintypes.DWORD()
            if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
                return True
            return code.value == 259  # STILL_ACTIVE
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)  # signal 0 only asks whether the process is there
    except ProcessLookupError:
        return False
    except OSError:
        return True  # there, but another user's (PermissionError), or can't tell
    return True


def _remove_stale_temp_dirs() -> None:
    """Remove copy folders left by engines that have ended (see _TEMP_PREFIX).

    One look at the temp folder. Only this app's own folders are touched, and
    a link is never followed.
    """
    root = tempfile.gettempdir()
    cutoff = time.time() - _STALE_SECONDS
    try:
        with os.scandir(root) as it:
            entries = [e for e in it if e.name.startswith(_TEMP_PREFIX)]
    except OSError:
        return
    for entry in entries:
        try:
            if entry.is_symlink() or not entry.is_dir(follow_symlinks=False):
                continue
            owner = _TEMP_OWNER.match(entry.name)
            ended = owner is not None and not _process_running(int(owner.group(1)))
            if ended or entry.stat(follow_symlinks=False).st_mtime < cutoff:
                shutil.rmtree(entry.path, ignore_errors=True)
        except OSError:
            pass


# ── How a message reads in an export ────────────────────────────────────────

def _one_line(text) -> str:
    return " ".join(str(text or "").split())


def _coords(location) -> str:
    """"45.52, -122.68" for a location with coordinates, else ""."""
    if not location:
        return ""
    lat, lon = location.get("latitude"), location.get("longitude")
    if not isinstance(lat, (int, float)) or not isinstance(lon, (int, float)):
        return ""

    def fmt(value: float) -> str:
        return f"{value:.6f}".rstrip("0").rstrip(".")

    return f"{fmt(lat)}, {fmt(lon)}"


def _quote_text(quoted) -> str:
    """"Riley Sample: Hello from Riley", for a reply's "Replying to"."""
    if not quoted:
        return ""
    who = "You" if quoted.get("is_from_me") else (quoted.get("sender") or "Unknown member")
    snippet = _one_line(quoted.get("text")) or _QUOTE_KINDS.get(quoted.get("message_type"), "Message")
    if len(snippet) > _QUOTE_MAX:
        snippet = snippet[:_QUOTE_MAX - 1].rstrip() + "…"
    return f"{who}: {snippet}"


def _reactions_text(reactions) -> str:
    """"❤️ Riley, 👍 You"."""
    parts = []
    for r in reactions or []:
        if not r.get("emoji"):
            continue
        who = "You" if r.get("is_from_me") else (r.get("sender") or "Unknown member")
        parts.append(f"{r['emoji']} {who}")
    return ", ".join(parts)


def _is_system(msg) -> bool:
    return msg.get("message_type") == "system"


def _media_kind(msg, att) -> str:
    """"Photo", "Video", "Voice message"... for an attachment, from its message's type or else its MIME type."""
    msg_type = msg.get("message_type")
    if msg_type == "view_once":
        return msg.get("event_text") or "View-once media"
    if msg_type == "audio" and (att.get("filename") or "").lower().endswith(".opus"):
        return "Voice message"  # what WhatsApp records with the microphone button
    if msg_type in _KIND_WORDS:
        return _KIND_WORDS[msg_type]
    mime = (att.get("mime_type") or "").lower()
    name = (att.get("filename") or att.get("transfer_name") or "").lower()
    if mime.startswith("image/") or name.endswith(_IMAGE_EXTENSIONS):
        return "Photo"
    if mime.startswith("video/") or name.endswith(_VIDEO_EXTENSIONS):
        return "Video"
    if mime.startswith("audio/"):
        return "Audio"
    return "File"


def _media_name(att) -> str:
    """The file's name, or "" when the library only has a placeholder label for it."""
    name = att.get("transfer_name") or os.path.basename(att.get("filename") or "")
    if not att.get("filename") and name in _PLACEHOLDER_NAMES:
        return ""
    return name


def _media_label(msg, att, missing: bool, unreadable: bool = False) -> str:
    """"Photo: IMG_1.jpg", "Photo not in this backup", "Document not in this backup: notes.pdf".

    ``unreadable``: the backup has the file, but it couldn't be read or
    converted ("Photo couldn't be read: IMG_1.heic"). Saying "not in this
    backup" then would be untrue.
    """
    kind, name = _media_kind(msg, att), _media_name(att)
    if missing:
        kind = f"{kind} not in this backup"
    elif unreadable:
        kind = f"{kind} couldn't be read"
    return f"{kind}: {name}" if name else kind


def _id_part(value) -> str:
    """An attachment id as part of a file name in an export's folder.

    The library's ids are integer row ids. A hand-made store can make them
    text ("/../../x"), which must not reach a path: such an id gets a random
    name, as Messages' writers do.
    """
    if isinstance(value, int) and not isinstance(value, bool):
        return str(value)
    return f"x{uuid.uuid4().hex[:12]}"


def _csv_cell(value):
    """A CSV cell a spreadsheet won't take for a formula (see _FORMULA_START)."""
    if isinstance(value, str) and value.startswith(_FORMULA_START):
        return "'" + value
    return value


class _WhatsAppExport(MessageExtractor):
    """Messages' export machinery, reading WhatsApp and writing it WhatsApp's way.

    Inherits the file naming, local dates and HTML escaping from
    MessageExtractor; reads pages and search results from the WhatsApp
    adapter and media from WhatsApp's own domain. Keeps the chat in arrival
    order (``sort``), never re-sorting by date.
    """

    def __init__(self, source: "WhatsAppExtractor"):
        # No Messages extractor underneath: an sms.db read from here would be
        # a bug (the ids overlap), so make it fail loudly instead.
        self._inner = None
        self._source = source

    # ── reading ──────────────────────────────────────────────────────────────

    def get_messages(self, backup, chat_id, contacts, offset=0, limit=100, date_from=None, date_to=None):
        return self._source.get_messages(backup, chat_id, contacts, offset, limit,
                                         date_from=date_from, date_to=date_to)

    def search_messages(self, backup, query, contacts, chat_id=None, date_from=None, date_to=None, limit=500):
        return self._source.search_messages(backup, query, contacts, chat_id,
                                            date_from=date_from, date_to=date_to, limit=limit)

    @staticmethod
    def _attachment_file_path(backup, filename: str) -> Optional[str]:
        """Where a WhatsApp media file ("Message/Media/...") is on disk, or None."""
        if not filename:
            return None
        try:
            path = backup.get_file(filename, domain=SHARED_DOMAIN)
        except Exception as e:  # a damaged entry must cost one file, not the export
            print(f"[whatsapp] could not extract a media file: {e}", file=sys.stderr, flush=True)
            return None
        if not path or not os.path.exists(path):
            return None
        return path

    def _collect_messages_for_chat(self, backup, chat_id, contacts, date_from=None, date_to=None, query=None):
        """Every message in a chat, in arrival order. Raises _StoreProblem when the store can't be read."""
        pages, offset = [], 0
        while True:
            batch = self.get_messages(backup, chat_id, contacts, offset, _EXPORT_PAGE,
                                      date_from=date_from, date_to=date_to)
            problem = _problem(batch)
            if problem:
                raise _StoreProblem(problem)
            messages = batch.get("messages") or []
            pages.append(messages)
            next_offset = batch.get("next_offset", offset + len(messages))
            if not messages or next_offset >= batch.get("total", 0) or next_offset <= offset:
                break
            offset = next_offset
        # Each page is the next-older batch, in order within itself.
        messages = [m for page in reversed(pages) for m in page]
        if query:
            result = self.search_messages(backup, query, contacts, chat_id,
                                          date_from=date_from, date_to=date_to, limit=100000)
            problem = _problem(result)
            if problem:
                raise _StoreProblem(problem)
            hits = result.get("results") or []
            wanted = {r["message_id"] for r in hits}
            kept = [m for m in messages if m["message_id"] in wanted]
            # Search orders by date; keep the chat's own order, the way the app shows it.
            seen = {m["message_id"] for m in kept}
            kept += [{**r, "message_type": "text", "has_attachments": False, "attachments": []}
                     for r in hits if r["message_id"] not in seen]
            messages = kept
        return messages

    # ── one chat ─────────────────────────────────────────────────────────────

    _FORMATS = ("txt", "csv", "html", "pdf_source")

    def export_conversation(self, backup, chat_id, contacts, fmt, output_dir,
                            date_from=None, date_to=None, query=None, display_name=None):
        if fmt not in self._FORMATS:
            return {"error": f"Unsupported format: {fmt}"}
        display_name = _without_lone_surrogates(display_name)
        try:
            messages = self._collect_messages_for_chat(backup, chat_id, contacts, date_from, date_to, query)
        except _StoreProblem as e:
            return e.result
        os.makedirs(output_dir, exist_ok=True)
        base = (self._get_filename_for_message_export(display_name, self._first_and_last_dated(messages))
                or f"whatsapp_chat_{chat_id}")
        if fmt == "txt":
            return self._write_txt(messages, output_dir, base)
        if fmt == "csv":
            return self._write_csv(messages, output_dir, base)
        if fmt == "html":
            return self._write_html(messages, output_dir, base, display_name,
                                    _WhatsAppHtmlMedia(self, backup))
        return self._write_html(messages, output_dir, base, display_name,
                                _WhatsAppPrintMedia(self, backup, output_dir))

    def _first_and_last_dated(self, messages) -> list:
        """The earliest- and latest-dated messages, for the days in a file name.

        Messages' naming takes the first and last message, which in arrival
        order can be backwards: a last message stamped by a clock that runs
        behind would name the file "Mar 1 2024 - Feb 28 2024".
        """
        dated = [(dt, m) for m in messages if (dt := self._local_datetime(m.get("date"))) is not None]
        if not dated:
            return []
        return [min(dated, key=lambda d: d[0])[1], max(dated, key=lambda d: d[0])[1]]

    # ── several chats ────────────────────────────────────────────────────────

    def export_conversations(self, backup, chat_ids, conversation_names, contacts, fmt, output_dir,
                             mode="separate", date_from=None, date_to=None, query=None):
        if fmt not in self._FORMATS:
            return {"error": f"Unsupported format: {fmt}"}
        names = {k: _without_lone_surrogates(v) for k, v in (conversation_names or {}).items()}
        if mode == "merged":
            return self._export_merged(backup, chat_ids, names, contacts, fmt, output_dir,
                                       date_from=date_from, date_to=date_to, query=query)
        files, total = [], 0
        for chat_id in chat_ids:
            result = self.export_conversation(backup, chat_id, contacts, fmt, output_dir,
                                              date_from=date_from, date_to=date_to, query=query,
                                              display_name=names.get(chat_id))
            if result.get("error"):
                # An unreadable store fails every chat: say so rather than
                # handing back fewer files than were asked for.
                return result
            files.append(result["file"])
            total += result["message_count"]
        return {"files": files, "message_count": total}

    def _export_merged(self, backup, chat_ids, conversation_names, contacts, fmt, output_dir,
                       date_from=None, date_to=None, query=None):
        chats = []
        try:
            for chat_id in chat_ids:
                msgs = self._collect_messages_for_chat(backup, chat_id, contacts, date_from, date_to, query)
                name = conversation_names.get(chat_id) or f"WhatsApp chat {chat_id}"
                chats.append([{**m, "_conversation": name} for m in msgs])
        except _StoreProblem as e:
            return e.result
        # Interleave the chats by date, but never reorder one chat: a merge
        # keeps each chat's arrival order even where its dates disagree.
        messages = list(heapq.merge(*chats, key=lambda m: m.get("date") or ""))
        os.makedirs(output_dir, exist_ok=True)
        base = "all_whatsapp_chats"
        if fmt == "txt":
            result = self._write_txt(messages, output_dir, base, merged=True)
        elif fmt == "csv":
            result = self._write_csv(messages, output_dir, base, merged=True)
        elif fmt == "html":
            result = self._write_html(messages, output_dir, base, "", _WhatsAppHtmlMedia(self, backup), merged=True)
        else:
            result = self._write_html(messages, output_dir, base, "",
                                      _WhatsAppPrintMedia(self, backup, output_dir), merged=True)
        return {"files": [result["file"]], "message_count": result["message_count"]}

    # ── text of one message ──────────────────────────────────────────────────

    def _body_text(self, msg) -> str:
        """What a message says, for TXT and CSV, without its reply or reactions."""
        text = msg.get("text") or ""
        event = msg.get("event_text") or ""
        msg_type = msg.get("message_type")
        if _is_system(msg):
            return event or "WhatsApp notice"
        if msg.get("attachments"):
            labels = " ".join(f"[{_media_label(msg, a, not a.get('available', True))}]" for a in msg["attachments"])
            return f"{text} {labels}" if text.strip() else labels
        if msg.get("location") or msg_type in ("shared_location", "live_location"):
            parts = [f"[{event or 'Location'}]", _coords(msg.get("location"))]
            if text.strip():
                parts.append(text)
            return " ".join(p for p in parts if p)
        if msg_type == "contact":
            return f"[Contact card: {_one_line(text)}]" if text.strip() else "[Contact card]"
        if event and text.strip():
            return f"[{event}] {text}"
        if text.strip():
            return text
        if event:
            return f"[{event}]"
        return "[No content]"

    def _line_text(self, msg) -> str:
        """The whole message for a TXT line: reply, what it says, reactions."""
        parts = []
        if msg.get("quoted"):
            parts.append(f"[Replying to {_quote_text(msg['quoted'])}]")
        parts.append(self._body_text(msg))
        reactions = _reactions_text(msg.get("reactions"))
        if reactions:
            parts.append(f"[Reactions: {reactions}]")
        return " ".join(parts)

    # ── writers ──────────────────────────────────────────────────────────────

    def _write_txt(self, messages, output_dir, base, merged=False):
        filepath = os.path.join(output_dir, self._unused_name(output_dir, base, ".txt"))
        with open(filepath, "w", encoding="utf-8-sig") as f:
            for msg in messages:
                date = self._readable_date(msg.get("date"))
                where = ""
                if merged:
                    direction = "in" if _is_system(msg) else ("to" if msg.get("is_from_me") else "from")
                    where = f"({direction} {msg['_conversation']}) "
                sender = "" if _is_system(msg) else f"{msg.get('sender') or 'Unknown member'}: "
                f.write(f"[{date}] {where}{sender}{self._line_text(msg)}\n")
        return {"file": filepath, "message_count": len(messages)}

    def _write_csv(self, messages, output_dir, base, merged=False):
        filepath = os.path.join(output_dir, self._unused_name(output_dir, base, ".csv"))
        with open(filepath, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.writer(f)
            writer.writerow(_MERGED_CSV_HEADER if merged else _CSV_HEADER)
            for msg in messages:
                row = [
                    self._csv_date(msg.get("date")),
                    msg.get("sender") or "",
                    self._body_text(msg),
                    bool(msg.get("is_from_me")),
                    bool(msg.get("has_attachments")),
                    _TYPE_WORDS.get(msg.get("message_type"), "Other"),
                    _quote_text(msg.get("quoted")),
                    _reactions_text(msg.get("reactions")),
                ]
                if merged:
                    direction = "Notice" if _is_system(msg) else ("Sent" if msg.get("is_from_me") else "Received")
                    row[1:1] = [msg["_conversation"], direction]
                writer.writerow([_csv_cell(cell) for cell in row])
        return {"file": filepath, "message_count": len(messages)}

    def _days_and_times(self, messages):
        """Yield (msg, day heading or "", time) for an HTML export.

        WhatsApp keeps a chat in arrival order, and a message that arrived
        late can carry an earlier date. A day heading only ever moves forward,
        so such a message stays where it arrived, under the current heading,
        with its own date written out in full.
        """
        current = None
        for msg in messages:
            dt = self._local_datetime(msg.get("date"))
            if dt is None:
                yield msg, "", msg.get("date") or ""
                continue
            day = dt.date()
            heading = ""
            if current is None or day > current:
                current, heading = day, self._format_day(dt)
            when = self._format_time(dt) if day == current else f"{self._format_day(dt)}, {self._format_time(dt)}"
            yield msg, heading, when

    def _bubble_html(self, msg, media) -> str:
        """Inner HTML of one message bubble."""
        esc = self._html_escape
        parts = []
        quoted = msg.get("quoted")
        if quoted:
            who = "You" if quoted.get("is_from_me") else (quoted.get("sender") or "Unknown member")
            snippet = (quoted.get("text") or "").strip() or _QUOTE_KINDS.get(quoted.get("message_type"), "Message")
            if len(snippet) > 300:
                snippet = snippet[:299].rstrip() + "…"
            parts.append(f'<div class="quote"><div class="quote-who">{esc(who)}</div>'
                         f'<div class="quote-text">{esc(snippet, preserve_newlines=True)}</div></div>')
        text = msg.get("text") or ""
        event = msg.get("event_text") or ""
        text_html = f'<div class="text">{esc(text, preserve_newlines=True)}</div>' if text.strip() else ""
        msg_type = msg.get("message_type")
        if msg.get("attachments"):
            parts += [media.render(a, msg) for a in msg["attachments"]]
            parts.append(text_html)
        elif msg.get("location") or msg_type in ("shared_location", "live_location"):
            location = msg.get("location") or {}
            parts.append(media.render_map(location))
            parts.append(f'<div class="event">{esc(event or "Location")}</div>')
            coords = _coords(location)
            if coords:
                parts.append(f'<div class="coords">{esc(coords)}</div>')
            parts.append(text_html)
        elif msg_type == "contact":
            label = f"Contact card: {_one_line(text)}" if text.strip() else "Contact card"
            parts.append(f'<div class="event">{esc(label)}</div>')
        else:
            if event:
                parts.append(f'<div class="event">{esc(event)}</div>')
            parts.append(text_html)
            if not event and not text.strip():
                parts.append('<div class="event">No content</div>')
        preview = msg.get("link_preview") or {}
        if preview.get("title") or preview.get("summary"):
            lines = [f'<div class="link-title">{esc(preview["title"])}</div>' if preview.get("title") else "",
                     f'<div class="link-summary">{esc(preview["summary"])}</div>' if preview.get("summary") else "",
                     f'<div class="link-url">{esc(preview["url"])}</div>' if preview.get("url") else ""]
            parts.append(f'<div class="link-preview">{"".join(lines)}</div>')
        reactions = _reactions_text(msg.get("reactions"))
        if reactions:
            parts.append(f'<div class="reactions">{esc(reactions)}</div>')
        return "".join(p for p in parts if p)

    def _write_html(self, messages, output_dir, base, display_name, media, merged=False):
        filepath = os.path.join(output_dir, self._unused_name(output_dir, base, ".html"))
        media.begin(filepath)
        esc = self._html_escape
        safe_name = html.escape(display_name) if display_name else ""
        if merged:
            title = heading = "WhatsApp chats"
        else:
            title = f"WhatsApp chat: {safe_name}" if safe_name else "WhatsApp chat"
            heading = safe_name
        with open(filepath, "w", encoding="utf-8") as f:
            f.write(f"""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>{title}</title>
<style>
{_WHATSAPP_CSS}{_ATTACHMENT_CSS}{_WHATSAPP_PRINT_CSS}</style></head><body>
""")
            if heading:
                f.write(f'<h1 class="conv-title">{heading}</h1>\n')
            for msg, day, when in self._days_and_times(messages):
                if day:
                    f.write(f'<div class="day">{esc(day)}</div>\n')
                meta = esc(when)
                if merged:
                    direction = "in" if _is_system(msg) else ("to" if msg.get("is_from_me") else "from")
                    meta += f' <span class="conv-label">({direction} {esc(msg["_conversation"])})</span>'
                if msg.get("starred"):
                    meta += ' <span class="star" title="Starred">★</span>'
                f.write(f'<div class="meta">{meta}</div>\n')
                if _is_system(msg):
                    f.write(f'<div class="system">{esc(msg.get("event_text") or "WhatsApp notice")}</div>\n')
                    continue
                if not msg.get("is_from_me"):
                    f.write(f'<div class="sender">{esc(msg.get("sender") or "Unknown member")}</div>\n')
                css = "sent" if msg.get("is_from_me") else "received"
                f.write(f'<div class="msg {css}">{self._bubble_html(msg, media)}</div>\n')
            f.write(EXPORT_FOOTER_HTML)
            f.write("</body></html>")
        return {"file": filepath, "message_count": len(messages)}


_WHATSAPP_CSS = """body { font-family: -apple-system, "Segoe UI", sans-serif; max-width: 640px; margin: 0 auto; padding: 20px; background: #efeae2; color: #111b21; }
.msg { margin: 6px 0; padding: 8px 12px; border-radius: 12px; max-width: 75%; clear: both; box-shadow: 0 1px 1px rgba(0,0,0,0.08); }
.sent { background: #d9fdd3; float: right; border-top-right-radius: 4px; }
.received { background: #ffffff; float: left; border-top-left-radius: 4px; }
.meta { font-size: 11px; color: #667781; clear: both; text-align: center; margin: 12px 0 4px; }
.day { font-size: 12px; font-weight: 600; color: #54656f; clear: both; text-align: center; margin: 0 0 4px; padding-top: 24px; }
.sender { font-size: 11px; color: #1f7a4d; font-weight: 600; margin-bottom: 2px; clear: both; }
.conv-title { font-size: 18px; color: #111b21; margin-bottom: 20px; text-align: center; }
.conv-label { font-size: 10px; color: #8696a0; font-style: italic; }
.system { clear: both; width: fit-content; max-width: 80%; margin: 4px auto 8px; padding: 5px 12px; border-radius: 8px; background: #fff3c4; color: #54656f; font-size: 12px; text-align: center; }
.quote { border-left: 3px solid #25d366; background: rgba(0,0,0,0.05); border-radius: 6px; padding: 4px 8px; margin-bottom: 6px; font-size: 13px; }
.quote-who { font-weight: 600; font-size: 12px; color: #1f7a4d; }
.quote-text { opacity: 0.85; }
.event { font-style: italic; opacity: 0.85; }
.coords { font-size: 12px; opacity: 0.8; }
.map { display: block; max-width: 100%; border-radius: 8px; margin-bottom: 4px; }
.reactions { font-size: 12px; margin-top: 4px; opacity: 0.85; }
.link-preview { margin-top: 6px; padding: 6px 8px; border-radius: 6px; background: rgba(0,0,0,0.05); font-size: 12px; }
.link-title { font-weight: 600; }
.link-url { opacity: 0.7; word-break: break-all; }
.star { color: #c99400; }
.msg img.sticker { max-width: 160px; max-height: 160px; border-radius: 0; }
"""

_WHATSAPP_PRINT_CSS = """@media print {
  body { background: #fff; }
  .msg { box-shadow: none; border: 1px solid #ddd; }
  .system { break-inside: avoid; }
}
"""


# ── Media in HTML and PDF exports ───────────────────────────────────────────

def _thumb_src(att: dict) -> str:
    return att.get("thumbnail_path") or ""


class _WhatsAppHtmlMedia(_HtmlAttachmentWriter):
    """Copies WhatsApp media beside an HTML export and shows it.

    Photos, GIFs and stickers show, videos and voice notes play (Opus voice
    notes included), documents link to their file. Media the backup doesn't
    have gets a label saying so, over its thumbnail when the backup kept one.
    Files are named "wa<id>-<name>", so they never collide with Messages'
    "<id>-<name>" in the same folder.
    """

    @staticmethod
    def _file_name(att: dict) -> str:
        return "wa" + _HtmlAttachmentWriter._file_name(att)

    def _copy_extra(self, key: str, rel: str) -> Optional[str]:
        """Copy a thumbnail or map preview (JPEG whatever its extension) once; its file name, or None."""
        if key in self._written:
            return self._written[key]
        name = None
        src = self._extractor._attachment_file_path(self._backup, rel)
        if src:
            dest = os.path.join(self._dir, f"{key}.jpg")
            try:
                os.makedirs(self._dir, exist_ok=True)
                if not (os.path.isfile(dest) and os.path.getsize(dest) == os.path.getsize(src)):
                    shutil.copyfile(src, dest)
                name = os.path.basename(dest)
            except OSError:
                pass
        self._written[key] = name
        return name

    def render(self, att: dict, msg: dict) -> str:
        esc = MessageExtractor._html_escape
        available = att.get("available", True)
        name = self._copy(att) if available else None
        if name is None:
            # Not in the backup, or listed in it but it couldn't be read or copied.
            label = esc(_media_label(msg, att, missing=not available, unreadable=available))
            thumb_key = f"wa{_id_part(att.get('attachment_id'))}-thumb"
            thumb = self._copy_extra(thumb_key, _thumb_src(att)) if _thumb_src(att) else None
            if thumb:
                src = self._href(thumb)
                return f'<img src="{src}" alt="{label}"><div class="attachment-label">{label}</div>'
            return f'<div class="attachment-label">{label}</div>'

        href = self._href(name)
        title = esc(att.get("transfer_name") or name)
        mime = (att.get("mime_type") or "").lower()
        ext = self._ext(att)
        sticker = ' class="sticker"' if msg.get("message_type") == "sticker" else ""

        if _PrintAttachmentWriter._is_image(att):
            if ext in _BROWSER_IMAGE_EXTENSIONS:
                return f'<a href="{href}"><img{sticker} src="{href}" alt="{title}" loading="lazy"></a>'
            preview = os.path.splitext(name)[0] + ".jpg"
            preview_path = os.path.join(self._dir, preview)
            if os.path.isfile(preview_path) or _save_as_jpeg(os.path.join(self._dir, name), preview_path,
                                                             HTML_PREVIEW_MAX_PX):
                src = self._href(preview)
                return f'<a href="{src}"><img{sticker} src="{src}" alt="{title}" loading="lazy"></a>'
            return f'<div class="attachment-label"><a href="{href}">{esc(_media_label(msg, att, False))}</a></div>'

        if mime.startswith("video/") or ext in _VIDEO_EXTENSIONS:
            return (f'<video controls preload="metadata" src="{href}#t=0.001" title="{title}"></video>'
                    f'<div class="attachment-link"><a href="{href}">{title}</a></div>')

        if mime.startswith("audio/") and ext in _PLAYABLE_AUDIO:
            return (f'<audio controls preload="none" src="{href}" title="{title}"></audio>'
                    f'<div class="attachment-link"><a href="{href}">{title}</a></div>')

        return f'<div class="attachment-label"><a href="{href}">{esc(_media_label(msg, att, False))}</a></div>'

    def render_map(self, location: dict) -> str:
        rel = (location or {}).get("thumbnail_path")
        if not rel:
            return ""
        name = self._copy_extra(f"wamap{_id_part(location.get('attachment_id'))}", rel)
        if not name:
            return ""
        return f'<img class="map" src="{self._href(name)}" alt="Map">'


class _WhatsAppPrintMedia(_PrintAttachmentWriter):
    """Writes WhatsApp photos (and stills for videos and maps) as JPEG next to the PDF's HTML.

    Everything else gets a label, "not in this backup" when the backup lacks
    it. Files are named "wa<id>.jpg", "wa<id>-thumb.jpg" and "wamap<id>.jpg".
    """

    def _jpeg(self, key: str, rel: str) -> Optional[str]:
        """``attachments/<key>.jpg`` from a media file, written once; None if it can't be."""
        if key in self._written:
            return self._written[key]
        out = None
        name = f"{key}.jpg"
        dest = os.path.join(self._dir, name)
        if os.path.exists(dest):
            out = f"{self.SUBDIR}/{name}"
        else:
            src = self._extractor._attachment_file_path(self._backup, rel) if rel else None
            if src:
                os.makedirs(self._dir, exist_ok=True)
                if self._convert(src, dest):
                    out = f"{self.SUBDIR}/{name}"
                    self.images_written += 1
        if out is None:
            self.images_missing += 1
        self._written[key] = out
        return out

    def render(self, att: dict, msg: dict) -> str:
        esc = MessageExtractor._html_escape
        key = f"wa{_id_part(att.get('attachment_id'))}"
        available = att.get("available", True)
        unreadable = False
        mime = (att.get("mime_type") or "").lower()
        is_video = mime.startswith("video/") or (att.get("filename") or "").lower().endswith(_VIDEO_EXTENSIONS)
        if self._is_image(att) and available:
            rel = self._jpeg(key, att.get("filename") or "")
            if rel:
                css = ' class="sticker"' if msg.get("message_type") == "sticker" else ""
                return f'<img{css} src="{esc(rel)}" alt="{esc(att.get("transfer_name") or "Photo")}">'
            # In the backup, but it couldn't be read or converted. A document
            # that happens to be a picture (a camera's RAW file) keeps the
            # label every other document gets.
            unreadable = msg.get("message_type") != "document"
        still = None
        if (self._is_image(att) or is_video) and _thumb_src(att):
            still = self._jpeg(f"{key}-thumb", _thumb_src(att))
        text = _media_label(msg, att, missing=not available, unreadable=unreadable)
        label = f'<div class="attachment-label">{esc(text)}</div>'
        if still:
            return f'<img src="{esc(still)}" alt="">{label}'
        return label

    def render_map(self, location: dict) -> str:
        rel = (location or {}).get("thumbnail_path")
        if not rel:
            return ""
        out = self._jpeg(f"wamap{_id_part(location.get('attachment_id'))}", rel)
        return f'<img class="map" src="{MessageExtractor._html_escape(out)}" alt="Map">' if out else ""

