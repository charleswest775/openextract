"""
Message extraction adapter.

Delegates raw extraction (list_conversations, get_messages, search_messages)
to ``ios_backup_core.extractors.messages.MessageExtractor``. Keeps two pieces
of openextract-only behaviour:

  * ``get_attachment(backup, attachment_id)`` — the new library embeds
    attachments inline in get_messages output but does not expose a per-id
    extraction RPC. openextract's frontend has its own attachment-load flow,
    so we keep the original implementation here.
  * ``export_conversation`` / ``export_conversations`` (txt, csv, html) — file
    export is out of scope for the library.

Re-exports the utility constants/functions that the rest of the openextract
sidecar imports from this module:

    APPLE_EPOCH, NANOSECOND_THRESHOLD,
    apple_date_to_iso, iso_to_apple_date, parse_attributed_body
"""

import base64
import csv
import os
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


class MessageExtractor:
    """Adapter wrapping the ios-backup-core MessageExtractor.

    Forwards list_conversations, get_messages, and search_messages directly
    to the inner extractor. Keeps openextract's get_attachment and export
    methods (txt/csv/html, separate/merged) inline because the library does
    not provide them.
    """

    def __init__(self):
        self._inner = _CoreMessageExtractor()

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
        return self._inner.search_messages(
            backup, query, contacts, chat_id,
            date_from=date_from, date_to=date_to, limit=limit,
        )

    # ── openextract-only: per-id attachment extraction ───────────────────────

    def get_attachment(self, backup, attachment_id: int) -> dict:
        """Extract and return an attachment file as base64.

        ios-backup-core only embeds attachments in get_messages results; this
        is the standalone per-attachment fetcher openextract's UI uses.
        """
        # Re-use the inner extractor's connection helper so we share the
        # same PRAGMAs / index creation it sets up on first use.
        db_path = self._inner._get_sms_db(backup)
        if not db_path:
            return {"error": "sms.db not found"}

        conn = self._inner._get_conn(db_path)

        try:
            row = conn.execute(
                "SELECT filename, mime_type, transfer_name FROM attachment WHERE ROWID = ?",
                (attachment_id,)
            ).fetchone()

            if not row or not row["filename"]:
                return {"error": "Attachment not found"}

            # The filename in sms.db starts with ~/
            # e.g. "~/Library/SMS/Attachments/ab/12/IMG_1234.jpeg"
            relative_path = row["filename"]
            if relative_path.startswith("~/"):
                relative_path = relative_path[2:]

            # Try MediaDomain first, then HomeDomain
            file_path = backup.get_file(relative_path, domain="MediaDomain")
            if not file_path:
                file_path = backup.get_file(relative_path, domain="HomeDomain")

            if not file_path or not os.path.exists(file_path):
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

    # ── openextract-only: conversation export to disk ────────────────────────

    def export_conversation(self, backup, chat_id: int, contacts: dict,
                            fmt: str, output_dir: str,
                            date_from: Optional[str] = None,
                            date_to: Optional[str] = None,
                            query: Optional[str] = None) -> dict:
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

        if fmt == "txt":
            return self._export_txt(all_messages, chat_id, output_dir)
        elif fmt == "csv":
            return self._export_csv(all_messages, chat_id, output_dir)
        elif fmt == "html":
            return self._export_html(all_messages, chat_id, output_dir)
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

    def _export_txt(self, messages, chat_id, output_dir):
        filename = f"conversation_{chat_id}.txt"
        filepath = os.path.join(output_dir, filename)
        with open(filepath, "w", encoding="utf-8-sig") as f:
            for msg in messages:
                date = msg["date"] or "Unknown date"
                sender = msg["sender"]
                text = self._message_text(msg) or "[No content]"
                f.write(f"[{date}] {sender}: {text}\n")
        return {"file": filepath, "message_count": len(messages)}

    def _export_csv(self, messages, chat_id, output_dir):
        filename = f"conversation_{chat_id}.csv"
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

    def _export_html(self, messages, chat_id, output_dir):
        filename = f"conversation_{chat_id}.html"
        filepath = os.path.join(output_dir, filename)
        with open(filepath, "w", encoding="utf-8") as f:
            f.write("""<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Conversation Export</title>
<style>
body { font-family: -apple-system, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background: #f5f5f5; }
.msg { margin: 8px 0; padding: 10px 14px; border-radius: 18px; max-width: 75%; clear: both; }
.sent { background: #007AFF; color: white; float: right; border-bottom-right-radius: 4px; }
.received { background: #E9E9EB; color: black; float: left; border-bottom-left-radius: 4px; }
.meta { font-size: 11px; color: #888; clear: both; text-align: center; margin: 12px 0 4px; }
.sender { font-size: 11px; color: #666; margin-bottom: 2px; }
</style></head><body>
""")
            for msg in messages:
                css_class = "sent" if msg["is_from_me"] else "received"
                text = msg["text"] or "[Attachment]"
                date = msg["date"] or ""
                f.write(f'<div class="meta">{date}</div>\n')
                if not msg["is_from_me"]:
                    f.write(f'<div class="sender">{msg["sender"]}</div>\n')
                f.write(f'<div class="msg {css_class}">{text}</div>\n')
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
                date_from=date_from, date_to=date_to, query=query
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
            return result["results"]
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
            return all_messages

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

    def _export_merged_html(self, messages, output_dir):
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
</style></head><body>
<h2>Merged Conversations</h2>
""")
            for msg in messages:
                css_class = "sent" if msg["is_from_me"] else "received"
                text = msg["text"] or "[Attachment]"
                date = msg["date"] or ""
                conv = msg["_conversation"]
                direction = "to" if msg["is_from_me"] else "from"
                f.write(f'<div class="meta">{date} <span class="conv-label">({direction} {conv})</span></div>\n')
                if not msg["is_from_me"]:
                    f.write(f'<div class="sender">{msg["sender"]}</div>\n')
                f.write(f'<div class="msg {css_class}">{text}</div>\n')
            f.write("</body></html>")
        return {"files": [filepath], "message_count": len(messages)}
