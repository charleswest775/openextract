"""
Message extraction adapter.

Delegates raw extraction (list_conversations, get_messages, search_messages)
to ``ios_backup_core.extractors.messages.MessageExtractor``. Keeps two pieces
of openextract-only behaviour:

  * ``get_attachment(backup, attachment_id)`` — the new library embeds
    attachments inline in get_messages output but does not expose a per-id
    extraction RPC. openextract's frontend has its own attachment-load flow,
    so we keep the original implementation here.
  * ``export_conversation`` / ``export_conversations`` (txt, csv, html, and
    ``pdf_source``, the print-ready HTML with images that Electron turns into
    a PDF) — file export is out of scope for the library.

Re-exports the utility constants/functions that the rest of the openextract
sidecar imports from this module:

    APPLE_EPOCH, NANOSECOND_THRESHOLD,
    apple_date_to_iso, iso_to_apple_date, parse_attributed_body
"""

import base64
import csv
import html
import os
import uuid
from typing import Optional

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

# Styles for images and attachment labels inside bubbles, plus page breaks
# for the PDF. Harmless in the plain HTML export, which has no images yet.
_ATTACHMENT_CSS = """.msg img { display: block; max-width: 100%; max-height: 420px; border-radius: 12px; margin: 2px 0; }
.msg .text { margin-top: 6px; }
.attachment-label { font-style: italic; opacity: 0.85; }
@media print {
  body { background: #fff; max-width: none; }
  .msg { float: none; width: fit-content; break-inside: avoid; }
  .msg img { max-height: 360px; }
  .sent { margin-left: auto; }
  .received { margin-right: auto; }
  .meta, .sender { break-after: avoid; }
}
"""

# Extensions we try to render as images when sms.db has no mime type.
_IMAGE_EXTENSIONS = (
    ".jpg", ".jpeg", ".png", ".gif", ".heic", ".heif", ".webp", ".bmp", ".tif", ".tiff",
)


class MessageExtractor:
    """Adapter wrapping the ios-backup-core MessageExtractor.

    Forwards list_conversations, get_messages, and search_messages directly
    to the inner extractor. Keeps openextract's get_attachment and export
    methods (txt/csv/html, separate/merged) inline because the library does
    not provide them.
    """

    def __init__(self):
        self._inner = _CoreMessageExtractor()
        # Conversation names keyed by sms.db path, so a search across every
        # conversation can say which one each match is in. A backup doesn't
        # change while it's open, so the names are worked out once.
        self._chat_names: dict[str, dict[int, str]] = {}

    # ── Delegated raw-extraction methods ─────────────────────────────────────

    def list_conversations(self, backup, contacts: dict) -> dict:
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
        result = self._inner.search_messages(
            backup, query, contacts, chat_id,
            date_from=date_from, date_to=date_to, limit=limit,
        )
        # Searching every conversation: name the one each match is in, as the
        # conversation list names it.
        if chat_id is None and result.get("results"):
            names = self._conversation_names(backup, contacts)
            for r in result["results"]:
                r["chat_name"] = names.get(r["chat_id"], "")
        return result

    def _conversation_names(self, backup, contacts: dict) -> dict[int, str]:
        db_path = self._inner._get_sms_db(backup) or ""
        if db_path not in self._chat_names:
            convos = self._inner.list_conversations(backup, contacts).get("conversations", [])
            self._chat_names[db_path] = {c["chat_id"]: c["display_name"] for c in convos}
        return self._chat_names[db_path]

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

        try:
            row = conn.execute(
                "SELECT filename, mime_type, transfer_name FROM attachment WHERE ROWID = ?",
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
        if query:
            # Search-filtered export — fetch matching messages directly
            result = self.search_messages(
                backup, query, contacts, chat_id,
                date_from=date_from, date_to=date_to, limit=100000
            )
            all_messages = result["results"]
        else:
            # Date-range or full export via paginated get_messages
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

        all_messages = self._sort_messages_chronologically(all_messages)

        if fmt == "txt":
            return self._export_txt(all_messages, chat_id, output_dir, display_name)
        elif fmt == "csv":
            return self._export_csv(all_messages, chat_id, output_dir, display_name)
        elif fmt == "html":
            return self._export_html(all_messages, chat_id, output_dir, display_name)
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

    def _message_text(self, msg) -> str:
        """Return the display text for a message, replacing binary attachment data with labels."""
        if msg.get("has_attachments"):
            label = self._attachment_label(msg)
            text = (msg.get("text") or "").strip()
            return f"{text} {label}".strip() if text else label
        return msg.get("text") or ""

    @staticmethod
    def _html_escape(value, preserve_newlines: bool = False) -> str:
        """Escape a user-derived value for safe inclusion in exported HTML."""
        escaped = html.escape(str(value)) if value is not None else ""
        if preserve_newlines:
            escaped = escaped.replace("\r\n", "\n").replace("\n", "<br>")
        return escaped

    def _get_filename_for_message_export(self, display_name, messages) -> str:
        """Build a filesystem-safe base filename from the conversation name and the
        date range of ``messages`` (which must be sorted oldest-first).

        Returns "" when nothing usable can be built, so callers can fall back to
        ``conversation_<chat_id>``.
        """
        from datetime import datetime
        import re

        if not display_name:
            return ""

        # Collapse runs of whitespace/punctuation into a single underscore (Unicode safe).
        sanit_name = re.sub(r'\W+', '_', str(display_name)).strip('_')[:50]

        # Add from and to date, to get distinct file names for other ranges if exporting more often.
        # Empty exports (e.g. a date filter with no matches) or missing dates just skip this.
        date_part = ""
        try:
            date_format = "%y%m%d%H%M%S-%f"
            from_date = datetime.fromisoformat(messages[0]["date"]).astimezone().strftime(date_format)
            to_date = datetime.fromisoformat(messages[-1]["date"]).astimezone().strftime(date_format)
            date_part = f"{from_date}--{to_date}"
        except (IndexError, KeyError, TypeError, ValueError):
            pass

        return "--".join(p for p in (sanit_name, date_part) if p)

    def _export_txt(self, messages, chat_id, output_dir, display_name = ""):
        base = self._get_filename_for_message_export(display_name, messages)
        filename = f"{base or f'conversation_{chat_id}'}.txt"
        filepath = os.path.join(output_dir, filename)
        with open(filepath, "w", encoding="utf-8-sig") as f:
            for msg in messages:
                date = msg["date"] or "Unknown date"
                sender = msg["sender"]
                text = self._message_text(msg) or "[No content]"
                f.write(f"[{date}] {sender}: {text}\n")
        return {"file": filepath, "message_count": len(messages)}

    def _export_csv(self, messages, chat_id, output_dir, display_name = ""):
        base = self._get_filename_for_message_export(display_name, messages)
        filename = f"{base or f'conversation_{chat_id}'}.csv"
        filepath = os.path.join(output_dir, filename)
        with open(filepath, "w", newline="", encoding="utf-8-sig") as f:
            writer = csv.writer(f)
            writer.writerow(["Date", "Sender", "Text", "Is From Me", "Has Attachments"])
            for msg in messages:
                writer.writerow([
                    msg["date"], msg["sender"], self._message_text(msg),
                    msg["is_from_me"], msg["has_attachments"]
                ])
        return {"file": filepath, "message_count": len(messages)}

    def _message_html(self, msg, attachments=None) -> str:
        """Inner HTML of one message bubble.

        Without ``attachments`` (the plain HTML export) this is the escaped
        text. With a ``_PrintAttachmentWriter`` (the PDF export) images are
        drawn inline and other attachments get a short label.
        """
        text = self._html_escape(msg.get("text") or "", preserve_newlines=True)
        if attachments is not None and msg.get("attachments"):
            parts = [attachments.render(a) for a in msg["attachments"]]
            if text:
                parts.append(f'<div class="text">{text}</div>')
            return "".join(parts)
        return text or "[Attachment]"

    def _export_html(self, messages, chat_id, output_dir, display_name = "",
                     attachments=None):
        base = self._get_filename_for_message_export(display_name, messages)
        filename = f"{base or f'conversation_{chat_id}'}.html"
        filepath = os.path.join(output_dir, filename)
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
.sender {{ font-size: 11px; color: #666; margin-bottom: 2px; }}
.conv-title {{ font-size: 18px; color: #333; margin-bottom: 20px; text-align: center; }}
{_ATTACHMENT_CSS}</style></head><body>
""")
            if safe_name:
                f.write(f'<h1 class="conv-title">{safe_name}</h1>\n')
            for msg in messages:
                css_class = "sent" if msg["is_from_me"] else "received"
                text = self._message_html(msg, attachments)
                date = self._html_escape(msg["date"] or "")
                f.write(f'<div class="meta">{date}</div>\n')
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
        if query:
            result = self.search_messages(
                backup, query, contacts, chat_id,
                date_from=date_from, date_to=date_to, limit=100000
            )
            all_messages = result["results"]
        else:
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
            return self._export_merged_html(all_messages, output_dir)
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
                date = msg["date"] or "Unknown date"
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
                    msg["date"], msg["_conversation"], direction,
                    msg["sender"], self._message_text(msg),
                    msg["is_from_me"], msg["has_attachments"]
                ])
        return {"files": [filepath], "message_count": len(messages)}

    def _export_merged_html(self, messages, output_dir, attachments=None):
        filepath = os.path.join(output_dir, "all_conversations.html")
        with open(filepath, "w", encoding="utf-8") as f:
            f.write("""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Merged Conversations Export</title>
<style>
body { font-family: -apple-system, sans-serif; max-width: 700px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
.msg { margin: 8px 0; padding: 10px 14px; border-radius: 18px; max-width: 75%; clear: both; }
.sent { background: #007AFF; color: white; float: right; border-bottom-right-radius: 4px; }
.received { background: #E9E9EB; color: black; float: left; border-bottom-left-radius: 4px; }
.meta { font-size: 11px; color: #888; clear: both; text-align: center; margin: 12px 0 4px; }
.sender { font-size: 11px; color: #666; margin-bottom: 2px; }
.conv-label { font-size: 10px; color: #999; font-style: italic; }
""" + _ATTACHMENT_CSS + """</style></head><body>
<h2>Merged Conversations</h2>
""")
            for msg in messages:
                css_class = "sent" if msg["is_from_me"] else "received"
                text = self._message_html(msg, attachments)
                date = self._html_escape(msg["date"] or "")
                conv = self._html_escape(msg["_conversation"])
                direction = "to" if msg["is_from_me"] else "from"
                f.write(f'<div class="meta">{date} <span class="conv-label">({direction} {conv})</span></div>\n')
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
        self._heif_registered = False
        self.images_written = 0
        self.images_missing = 0

    @staticmethod
    def _is_image(att: dict) -> bool:
        mime = (att.get("mime_type") or "").lower()
        if mime.startswith("image/"):
            return mime != "image/svg+xml"
        name = (att.get("filename") or att.get("transfer_name") or "").lower()
        return name.endswith(_IMAGE_EXTENSIONS)

    @staticmethod
    def _label(att: dict, missing: bool = False) -> str:
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
        label = f"[{kind}: {name}]" if name else f"[{kind}]"
        return f'<div class="attachment-label">{MessageExtractor._html_escape(label)}</div>'

    def _convert(self, src_path: str, dest_path: str) -> bool:
        try:
            from PIL import Image, ImageOps
        except ImportError:
            return False
        if not self._heif_registered:
            try:
                import pillow_heif
                pillow_heif.register_heif_opener()
            except Exception:
                pass
            self._heif_registered = True
        try:
            with Image.open(src_path) as opened:
                img = ImageOps.exif_transpose(opened)
                img.thumbnail((PDF_IMAGE_MAX_PX, PDF_IMAGE_MAX_PX))
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
