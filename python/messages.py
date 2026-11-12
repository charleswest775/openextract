"""
Message extraction adapter.

Delegates raw extraction (list_conversations, get_messages, search_messages)
to ``ios_backup_core.extractors.messages.MessageExtractor``. Keeps two pieces
of openextract-only behaviour:

  * ``get_attachment(backup, attachment_id)`` — the new library embeds
    attachments inline in get_messages output but does not expose a per-id
    extraction RPC. openextract's frontend has its own attachment-load flow,
    so we keep the original implementation here.
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
import os
import re
import shutil
import uuid
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

# Month names for the dates in exports, written out so the computer's
# language settings can't change them (strftime's %b follows the locale).
_MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun",
           "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")

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

_heif_registered = False


def _save_as_jpeg(src_path: str, dest_path: str, max_px: int) -> bool:
    """Write an image (HEIC included) as an upright JPEG no bigger than
    ``max_px`` on its longest side. Returns False, leaving nothing behind,
    if the image can't be read."""
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
            img.save(dest_path, "JPEG", quality=85)
        return True
    except Exception:
        if os.path.exists(dest_path):
            os.remove(dest_path)
        return False


def _without_lone_surrogates(text):
    """A conversation name with half an emoji in it (a lone surrogate, which
    JSON.stringify sends as "\\ud83c") can't be written as UTF-8, so the export
    failed. Show that half as "�" instead."""
    if not isinstance(text, str):
        return text
    return "".join("�" if "\ud800" <= ch <= "\udfff" else ch for ch in text)


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
        return self._inner.get_messages(
            backup, chat_id, contacts, offset, limit,
            date_from=date_from, date_to=date_to,
        )

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

    # ── openextract-only: per-id attachment extraction ───────────────────────

    def get_attachment(self, backup, attachment_id: int) -> dict:
        """Extract and return an attachment file as base64.

        ios-backup-core only embeds attachments in get_messages results; this
        is the standalone per-attachment fetcher openextract's UI uses.
        """
        # Re-use the inner extractor's read-only connection to sms.db.
        db_path = self._inner._get_sms_db(backup)
        if not db_path:
            return {"error": "sms.db not found"}

        conn = self._inner._get_conn(db_path, backup)
        # Older sms.db files have no attachment.transfer_name.
        transfer_name = "transfer_name" if self._inner._schema(db_path, conn)["has_transfer_name"] else "NULL"

        try:
            row = conn.execute(
                f"SELECT filename, mime_type, {transfer_name} AS transfer_name FROM attachment WHERE ROWID = ?",
                (attachment_id,)
            ).fetchone()

            if not row or not row["filename"]:
                return {"error": "Attachment not found"}

            file_path = self._attachment_file_path(backup, row["filename"])
            if not file_path:
                return {"error": "Attachment file not found in backup"}

            with open(file_path, "rb") as f:
                raw_data = f.read()

            mime_type = row["mime_type"]
            filename_lower = (row["filename"] or "").lower()
            if mime_type in ("image/heic", "image/heif") or filename_lower.endswith(".heic") or filename_lower.endswith(".heif"):
                try:
                    import io
                    import pillow_heif
                    from PIL import Image
                    pillow_heif.register_heif_opener()
                    img = Image.open(io.BytesIO(raw_data))
                    buf = io.BytesIO()
                    img.save(buf, format="JPEG")
                    raw_data = buf.getvalue()
                    mime_type = "image/jpeg"
                except Exception:
                    pass

            # Infer mime_type from extension if still missing (older backups)
            if not mime_type:
                _ext_map = {
                    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
                    ".png": "image/png", ".gif": "image/gif",
                    ".heic": "image/heic", ".heif": "image/heif",
                    ".webp": "image/webp", ".bmp": "image/bmp",
                }
                for ext, inferred in _ext_map.items():
                    if filename_lower.endswith(ext):
                        mime_type = inferred
                        break

            data = base64.b64encode(raw_data).decode("ascii")

            return {
                "data": data,
                "mime_type": mime_type,
                "filename": row["transfer_name"] or os.path.basename(row["filename"]),
            }
        except Exception:
            raise

    @staticmethod
    def _attachment_file_path(backup, sms_filename: str) -> Optional[str]:
        """Return the on-disk path of an attachment in the backup, or None.

        The filename in sms.db starts with ~/, e.g.
        "~/Library/SMS/Attachments/ab/12/IMG_1234.jpeg". Attachments live in
        MediaDomain, older ones sometimes in HomeDomain.
        """
        if not sms_filename:
            return None
        relative_path = sms_filename[2:] if sms_filename.startswith("~/") else sms_filename
        file_path = backup.get_file(relative_path, domain="MediaDomain")
        if not file_path:
            file_path = backup.get_file(relative_path, domain="HomeDomain")
        if not file_path or not os.path.exists(file_path):
            return None
        return file_path

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
                            display_name: Optional[str] = None) -> dict:
        """Export a conversation to the specified format, with optional date/search filters."""
        display_name = _without_lone_surrogates(display_name)
        all_messages = self._collect_messages_for_chat(
            backup, chat_id, contacts, date_from, date_to, query
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
            name = a.get("transfer_name") or a.get("filename") or ""
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
    # (src/lib/dates.ts): "Jul 5, 2024" for a day, "9:10 AM" for a time.

    def _local_datetime(self, iso) -> Optional[datetime]:
        """A message's date in local time, or None if it has none we can read."""
        if not iso:
            return None
        try:
            return datetime.fromisoformat(iso).astimezone(self.local_tz)
        except (TypeError, ValueError, OverflowError, OSError):
            return None

    @staticmethod
    def _format_day(dt: datetime) -> str:
        return f"{_MONTHS[dt.month - 1]} {dt.day}, {dt.year}"

    @staticmethod
    def _format_time(dt: datetime) -> str:
        return f"{dt.hour % 12 or 12}:{dt.minute:02d} {'AM' if dt.hour < 12 else 'PM'}"

    def _readable_date(self, iso) -> str:
        """"Jul 5, 2024, 9:10 AM", for a TXT line that reads on its own."""
        dt = self._local_datetime(iso)
        if dt is None:
            return iso or "Unknown date"
        return f"{self._format_day(dt)}, {self._format_time(dt)}"

    def _csv_date(self, iso) -> str:
        """The date as ISO 8601 in local time with its offset, e.g.
        "2024-07-05T09:10:09-07:00": the same moment as the engine's UTC
        value, so programs read it exactly, and the clock time people expect."""
        dt = self._local_datetime(iso)
        return dt.isoformat() if dt is not None else (iso or "")

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
        overwrites a file. The PDF export does the same (electron/pdfExport.ts)."""
        name = f"{base}{ext}"
        n = 2
        while os.path.exists(os.path.join(output_dir, name)):
            name = f"{base} ({n}){ext}"
            n += 1
        return name

    def _export_txt(self, messages, chat_id, output_dir, display_name = ""):
        base = self._get_filename_for_message_export(display_name, messages)
        filename = self._unused_name(output_dir, base or f"conversation_{chat_id}", ".txt")
        filepath = os.path.join(output_dir, filename)
        with open(filepath, "w", encoding="utf-8-sig") as f:
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
        with open(filepath, "w", newline="", encoding="utf-8-sig") as f:
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
        with open(filepath, "w", encoding="utf-8") as f:
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
        return {"file": filepath, "message_count": len(messages)}

    # ── Multi-conversation export ────────────────────────────────────────────

    def export_conversations(self, backup, chat_ids: list, conversation_names: dict,
                             contacts: dict, fmt: str, output_dir: str,
                             mode: str = "separate",
                             date_from: Optional[str] = None,
                             date_to: Optional[str] = None,
                             query: Optional[str] = None) -> dict:
        """Export multiple conversations.

        mode="separate" — one file per conversation.
        mode="merged"   — all messages in a single file, sorted by timestamp,
                          with explicit sender/recipient context on each line.
        """
        conversation_names = {k: _without_lone_surrogates(v) for k, v in conversation_names.items()}
        if mode == "merged":
            return self._export_merged(
                backup, chat_ids, conversation_names, contacts, fmt, output_dir,
                date_from=date_from, date_to=date_to, query=query
            )

        files = []
        total_count = 0
        for chat_id in chat_ids:
            result = self.export_conversation(
                backup, chat_id, contacts, fmt, output_dir,
                date_from=date_from, date_to=date_to, query=query,
                display_name=conversation_names.get(chat_id)
            )
            if "error" not in result:
                files.append(result["file"])
                total_count += result["message_count"]
        return {"files": files, "message_count": total_count}

    def _collect_messages_for_chat(self, backup, chat_id, contacts,
                                   date_from=None, date_to=None, query=None):
        """Collect all messages for a single chat (with optional filters)."""
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
        return self._sort_messages_chronologically(all_messages)

    def _export_merged(self, backup, chat_ids, conversation_names, contacts,
                       fmt, output_dir, date_from=None, date_to=None, query=None):
        """Merge messages from multiple conversations into one file, sorted by timestamp."""
        all_messages = []
        for chat_id in chat_ids:
            msgs = self._collect_messages_for_chat(
                backup, chat_id, contacts, date_from, date_to, query
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
            )
        else:
            return {"error": f"Unsupported format: {fmt}"}

    def _export_merged_txt(self, messages, output_dir):
        filepath = os.path.join(output_dir, "all_conversations.txt")
        with open(filepath, "w", encoding="utf-8-sig") as f:
            for msg in messages:
                date = self._readable_date(msg["date"])
                sender = msg["sender"]
                conv = msg["_conversation"]
                direction = "to" if msg["is_from_me"] else "from"
                text = self._message_text(msg) or "[No content]"
                f.write(f"[{date}] ({direction} {conv}) {sender}: {text}\n")
        return {"files": [filepath], "message_count": len(messages)}

    def _export_merged_csv(self, messages, output_dir):
        filepath = os.path.join(output_dir, "all_conversations.csv")
        with open(filepath, "w", newline="", encoding="utf-8-sig") as f:
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

    def _export_merged_html(self, messages, output_dir, attachments=None):
        filepath = os.path.join(output_dir, "all_conversations.html")
        if attachments is not None:
            attachments.begin(filepath)
        with open(filepath, "w", encoding="utf-8") as f:
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
        return {"files": [filepath], "message_count": len(messages)}


class _PrintAttachmentWriter:
    """Writes a message's images next to a print-ready HTML file.

    Used only for the PDF export: the HTML and its ``attachments/`` folder go
    into a temporary folder that Electron renders to PDF and then deletes, so
    the file names here never reach the user. Images are converted to JPEG
    (HEIC included), turned upright and scaled down to ``PDF_IMAGE_MAX_PX``.
    Videos, audio and other files, and images missing from the backup, get a
    short text label instead, so one bad attachment never fails the export.
    """

    SUBDIR = "attachments"

    def __init__(self, extractor: "MessageExtractor", backup, output_dir: str):
        self._extractor = extractor
        self._backup = backup
        self._dir = os.path.join(output_dir, self.SUBDIR)
        self._written: dict = {}
        self.images_written = 0
        self.images_missing = 0

    def begin(self, html_path: str) -> None:
        """Nothing to set up: images go into ``attachments/`` beside the page."""

    @staticmethod
    def _is_image(att: dict) -> bool:
        mime = (att.get("mime_type") or "").lower()
        if mime.startswith("image/"):
            return mime != "image/svg+xml"
        name = (att.get("filename") or att.get("transfer_name") or "").lower()
        return name.endswith(_IMAGE_EXTENSIONS)

    @staticmethod
    def _label(att: dict, missing: bool = False, href: Optional[str] = None) -> str:
        """``[Video: clip.mov]`` and the like; a link to the file if ``href`` is given."""
        name = att.get("transfer_name") or os.path.basename(att.get("filename") or "")
        mime = (att.get("mime_type") or "").lower()
        if _PrintAttachmentWriter._is_image(att):
            kind = "Image"
        elif mime.startswith("video/"):
            kind = "Video"
        elif mime.startswith("audio/"):
            kind = "Audio"
        else:
            kind = "File"
        if missing:
            kind = f"{kind} not in this backup"
        label = MessageExtractor._html_escape(f"[{kind}: {name}]" if name else f"[{kind}]")
        if href:
            label = f'<a href="{href}">{label}</a>'
        return f'<div class="attachment-label">{label}</div>'

    def _convert(self, src_path: str, dest_path: str) -> bool:
        return _save_as_jpeg(src_path, dest_path, PDF_IMAGE_MAX_PX)

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
                src = self._extractor._attachment_file_path(self._backup, att.get("filename") or "")
                if src:
                    os.makedirs(self._dir, exist_ok=True)
                    if self._convert(src, dest):
                        rel = f"{self.SUBDIR}/{name}"
                        self.images_written += 1
            if rel is None:
                self.images_missing += 1
            if isinstance(att_id, int):
                self._written[att_id] = rel

        if rel is None:
            return self._label(att, missing=True)
        alt = MessageExtractor._html_escape(att.get("transfer_name") or "Image")
        return f'<img src="{rel}" alt="{alt}">'


class _HtmlAttachmentWriter:
    """Saves a message's attachments beside an HTML export and shows them.

    Every file is copied as it is into a folder named after the page
    (``Mom.html`` gets ``Mom_attachments/``), so the two can be moved or
    shared together. Photos and GIFs show in the bubble, videos and common
    audio get a player, and everything links to its file, so a format the
    browser can't play (HEVC video on some PCs, voice messages) still opens
    in another app. Photos browsers can't show (HEIC, TIFF) also get a JPEG
    copy for the page. An attachment missing from the backup gets a label,
    so one bad file never fails the export.
    """

    def __init__(self, extractor: "MessageExtractor", backup):
        self._extractor = extractor
        self._backup = backup
        self._dir = ""
        self._rel = ""
        self._written: dict = {}
        self.files_written = 0
        self.files_missing = 0

    def begin(self, html_path: str) -> None:
        """Use the folder beside ``html_path``. Called before any render()."""
        base = os.path.splitext(os.path.basename(html_path))[0]
        self._rel = f"{base}_attachments"
        self._dir = os.path.join(os.path.dirname(html_path), self._rel)

    @staticmethod
    def _file_name(att: dict) -> str:
        """``<attachment id>-<name it was sent with>``, safe on every system.

        attachment_id is sms.db's ROWID, unique within the backup, so two
        files sent with the same name (IMG_0001.HEIC) never collide.
        """
        name = att.get("transfer_name") or os.path.basename(att.get("filename") or "") or "attachment"
        name = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', "_", name.replace("\\", "/").rsplit("/", 1)[-1])
        name = name.strip(" .") or "attachment"
        stem, ext = os.path.splitext(name)
        name = stem[:80] + (ext or _HtmlAttachmentWriter._ext(att))[:16]
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

    def _copy(self, att: dict) -> Optional[str]:
        """Copy the attachment into the folder once; its file name, or None."""
        att_id = att.get("attachment_id")
        if isinstance(att_id, int) and att_id in self._written:
            return self._written[att_id]
        name = None
        src = self._extractor._attachment_file_path(self._backup, att.get("filename") or "")
        if src:
            dest = os.path.join(self._dir, self._file_name(att))
            try:
                os.makedirs(self._dir, exist_ok=True)
                # The same conversation saved again into the same folder.
                if not (os.path.isfile(dest) and os.path.getsize(dest) == os.path.getsize(src)):
                    shutil.copyfile(src, dest)
                name = os.path.basename(dest)
                self.files_written += 1
            except OSError:
                pass
        if name is None:
            self.files_missing += 1
        if isinstance(att_id, int):
            self._written[att_id] = name
        return name

    def render(self, att: dict) -> str:
        """Return the HTML for one attachment inside a message bubble."""
        name = self._copy(att)
        if name is None:
            return _PrintAttachmentWriter._label(att, missing=True)

        href = self._href(name)
        title = MessageExtractor._html_escape(att.get("transfer_name") or name)
        mime = (att.get("mime_type") or "").lower()
        ext = self._ext(att)

        if _PrintAttachmentWriter._is_image(att):
            if ext in _BROWSER_IMAGE_EXTENSIONS:
                return f'<a href="{href}"><img src="{href}" alt="{title}" loading="lazy"></a>'
            preview = os.path.splitext(name)[0] + ".jpg"
            preview_path = os.path.join(self._dir, preview)
            if os.path.isfile(preview_path) or _save_as_jpeg(
                os.path.join(self._dir, name), preview_path, HTML_PREVIEW_MAX_PX
            ):
                src = self._href(preview)
                return f'<a href="{src}"><img src="{src}" alt="{title}" loading="lazy"></a>'
            return _PrintAttachmentWriter._label(att, href=href)

        if mime.startswith("video/") or ext in _VIDEO_EXTENSIONS:
            # #t=0.001 makes Safari show the first frame instead of a black box.
            return (f'<video controls preload="metadata" src="{href}#t=0.001" title="{title}"></video>'
                    f'<div class="attachment-link"><a href="{href}">{title}</a></div>')

        if mime.startswith("audio/") and ext in _BROWSER_AUDIO_EXTENSIONS:
            return (f'<audio controls preload="none" src="{href}" title="{title}"></audio>'
                    f'<div class="attachment-link"><a href="{href}">{title}</a></div>')

        return _PrintAttachmentWriter._label(att, href=href)
