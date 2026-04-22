"""
Message recovery.

Scans sms.db for messages that are no longer visible in the Messages app
and groups them by their original (or reconstructed) conversation so the
frontend can render them with the normal conversation-thread layout.

Two recovery sources:

  * ``chat_recoverable_message_join`` — iOS 16+ "Recently Deleted" bucket.
    Messages the user deleted in the last ~30 days. The join table preserves
    the original chat_id, so these can be rendered inside their real
    conversation.

  * Orphaned messages — rows in ``message`` with no entry in
    ``chat_message_join``. The original chat row is gone, so we can't
    reconstruct the chat. We fall back to grouping by the message's
    ``handle_id`` (the other party on a 1:1 thread). Group-chat membership
    for orphaned messages is unrecoverable from sms.db alone.

Read-only; nothing is written back to the backup.
"""

from __future__ import annotations

import csv
import html
import os
import sqlite3
from typing import Optional

from ios_backup_core.contacts import resolve_contact
from ios_backup_core.text import parse_attributed_body
from ios_backup_core.timestamps import apple_to_iso as apple_date_to_iso


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    row = conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        (name,),
    ).fetchone()
    return row is not None


def _column_exists(conn: sqlite3.Connection, table: str, column: str) -> bool:
    try:
        rows = conn.execute(f"PRAGMA table_info({table})").fetchall()
        return any(r[1] == column for r in rows)
    except sqlite3.DatabaseError:
        return False


def _decode_text(raw_text: Optional[str], attributed_body: Optional[bytes]) -> str:
    if raw_text:
        return raw_text
    if attributed_body:
        try:
            text, _kind = parse_attributed_body(attributed_body)
            return text or ""
        except Exception:
            return ""
    return ""


def _sender_for(is_from_me: int, handle_identifier: Optional[str], contacts: dict) -> str:
    if is_from_me:
        return ""
    if not handle_identifier:
        return ""
    return resolve_contact(handle_identifier, contacts) or handle_identifier


def _preview(text: str) -> str:
    if not text:
        return ""
    t = text.replace("\n", " ").strip()
    return t[:80] + ("…" if len(t) > 80 else "")


def _build_message(row: sqlite3.Row, contacts: dict, source: str,
                   deleted_date_raw: Optional[int] = None) -> Optional[dict]:
    """Build a recovered-message dict. Returns None when there is no text
    content to recover (empty, whitespace-only, or undecodable)."""
    text = _decode_text(row["text"], row["attributed_body"])
    if not text or not text.strip():
        return None
    return {
        "message_id": row["message_id"],
        "text": text,
        "message_type": "text",
        "date": apple_date_to_iso(row["date"]),
        "is_from_me": bool(row["is_from_me"]),
        "sender": _sender_for(row["is_from_me"], row["handle_identifier"], contacts),
        "sender_handle": row["handle_identifier"] or "",
        "has_attachments": False,
        "is_reaction": False,
        "source": source,
        "deleted_date": apple_date_to_iso(deleted_date_raw) if deleted_date_raw else None,
    }


class MessageRecoveryExtractor:
    """Scan sms.db and return recovered messages grouped by conversation."""

    def recover_messages(self, backup, contacts: dict) -> dict:
        db_path = backup.get_file("Library/SMS/sms.db", "HomeDomain")
        if not db_path:
            return {
                "conversations": [],
                "messages_by_conversation": {},
                "scanned": {"recently_deleted": 0, "orphaned": 0},
                "schema_support": {"recently_deleted": False},
            }

        conn = sqlite3.connect(db_path)
        conn.row_factory = sqlite3.Row
        try:
            has_recoverable = _table_exists(conn, "chat_recoverable_message_join")

            # Conversation bucket keyed by recovery_id
            # Each bucket: { meta: {...}, messages: [...] }
            buckets: dict[str, dict] = {}

            # ── Recently Deleted ────────────────────────────────────────────
            recently_deleted_count = 0
            if has_recoverable:
                delete_col = (
                    "delete_date"
                    if _column_exists(conn, "chat_recoverable_message_join", "delete_date")
                    else None
                )
                delete_select = f", crmj.{delete_col} AS delete_date" if delete_col else ""
                rows = conn.execute(
                    f"""
                    SELECT m.ROWID         AS message_id,
                           m.text          AS text,
                           m.attributedBody AS attributed_body,
                           m.date          AS date,
                           m.is_from_me    AS is_from_me,
                           h.id            AS handle_identifier,
                           crmj.chat_id    AS chat_id
                           {delete_select}
                    FROM chat_recoverable_message_join crmj
                    JOIN message m ON m.ROWID = crmj.message_id
                    LEFT JOIN handle h ON h.ROWID = m.handle_id
                    ORDER BY m.date ASC
                    """,
                ).fetchall()

                for r in rows:
                    deleted_raw = r["delete_date"] if delete_col else None
                    msg = _build_message(r, contacts, "recently_deleted", deleted_raw)
                    if msg is None:
                        continue  # skip messages with no recoverable text
                    chat_id = r["chat_id"]
                    recovery_id = f"recent:{chat_id}"
                    bucket = buckets.get(recovery_id)
                    if bucket is None:
                        meta = self._lookup_chat_meta(conn, chat_id, contacts)
                        meta.update({
                            "recovery_id": recovery_id,
                            "source": "recently_deleted",
                            "chat_id": chat_id,
                        })
                        bucket = {"meta": meta, "messages": []}
                        buckets[recovery_id] = bucket
                    bucket["messages"].append(msg)
                    recently_deleted_count += 1

            # ── Orphaned ────────────────────────────────────────────────────
            # iOS 16+ soft-deletes move a message out of chat_message_join into
            # chat_recoverable_message_join, so Recently Deleted messages also
            # satisfy the "no chat_message_join" condition. Exclude them here
            # so they only surface in the Recently Deleted bucket.
            orphaned_count = 0
            recoverable_exclusion = (
                " AND m.ROWID NOT IN (SELECT message_id FROM chat_recoverable_message_join)"
                if has_recoverable else ""
            )
            rows = conn.execute(
                f"""
                SELECT m.ROWID         AS message_id,
                       m.text          AS text,
                       m.attributedBody AS attributed_body,
                       m.date          AS date,
                       m.is_from_me    AS is_from_me,
                       h.id            AS handle_identifier,
                       h.service       AS handle_service
                FROM message m
                LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
                LEFT JOIN handle h ON h.ROWID = m.handle_id
                WHERE cmj.chat_id IS NULL{recoverable_exclusion}
                ORDER BY m.date ASC
                """,
            ).fetchall()

            for r in rows:
                msg = _build_message(r, contacts, "orphaned", None)
                if msg is None:
                    continue  # skip messages with no recoverable text
                handle_identifier = r["handle_identifier"] or ""
                # Key bucket by handle identifier; messages with no handle
                # (e.g. system messages without a counterparty) share a
                # single "unknown" bucket.
                bucket_key = handle_identifier or "<unknown>"
                recovery_id = f"orphan:{bucket_key}"
                bucket = buckets.get(recovery_id)
                if bucket is None:
                    display = (
                        resolve_contact(handle_identifier, contacts)
                        or handle_identifier
                        or "Unknown sender"
                    )
                    bucket = {
                        "meta": {
                            "recovery_id": recovery_id,
                            "source": "orphaned",
                            "chat_id": None,
                            "chat_identifier": handle_identifier,
                            "display_name": display,
                            "service": r["handle_service"] or "",
                            "is_group": False,
                        },
                        "messages": [],
                    }
                    buckets[recovery_id] = bucket
                bucket["messages"].append(msg)
                orphaned_count += 1

            # ── Finalise ────────────────────────────────────────────────────
            conversations = []
            messages_by_conversation = {}
            for rid, bucket in buckets.items():
                msgs = bucket["messages"]
                meta = bucket["meta"]
                if not msgs:
                    continue
                last_msg = msgs[-1]
                meta["message_count"] = len(msgs)
                meta["last_message_date"] = last_msg["date"]
                meta["last_message_preview"] = _preview(last_msg.get("text") or "")
                conversations.append(meta)
                messages_by_conversation[rid] = msgs

            # Sort conversations by most recent message, descending
            conversations.sort(
                key=lambda c: c.get("last_message_date") or "",
                reverse=True,
            )

            return {
                "conversations": conversations,
                "messages_by_conversation": messages_by_conversation,
                "scanned": {
                    "recently_deleted": recently_deleted_count,
                    "orphaned": orphaned_count,
                },
                "schema_support": {"recently_deleted": has_recoverable},
            }
        finally:
            conn.close()

    # ── Export ────────────────────────────────────────────────────────────────

    def export_recovered_messages(self, backup, contacts: dict,
                                  fmt: str, output_dir: str) -> dict:
        """Export all recovered messages to a single file.

        Formats: csv (flat), html (chat-style, grouped by conversation), pdf
        (reportlab, grouped by conversation).
        """
        data = self.recover_messages(backup, contacts)
        conversations = data["conversations"]
        messages_by_conversation = data["messages_by_conversation"]

        fmt = (fmt or "").lower()
        if fmt == "csv":
            filepath = _export_csv(conversations, messages_by_conversation, output_dir)
        elif fmt == "html":
            filepath = _export_html(conversations, messages_by_conversation, output_dir)
        elif fmt == "pdf":
            filepath = _export_pdf(conversations, messages_by_conversation, output_dir)
        else:
            return {"error": f"Unsupported format: {fmt}"}

        total = sum(len(m) for m in messages_by_conversation.values())
        return {
            "file": filepath,
            "message_count": total,
            "conversation_count": len(conversations),
        }

    def _lookup_chat_meta(self, conn: sqlite3.Connection, chat_id: int,
                          contacts: dict) -> dict:
        """Resolve chat identity. Falls back gracefully if the chat row is gone.

        Group detection mirrors ios_backup_core.extractors.messages: a chat is
        considered a group if it has >1 participant in chat_handle_join, or its
        identifier starts with "chat".
        """
        try:
            row = conn.execute(
                """
                SELECT chat_identifier, display_name, service_name
                FROM chat WHERE ROWID = ?
                """,
                (chat_id,),
            ).fetchone()
        except sqlite3.DatabaseError:
            row = None

        if row is None:
            return {
                "chat_identifier": "",
                "display_name": f"(deleted chat #{chat_id})",
                "service": "",
                "is_group": False,
            }

        try:
            handle_rows = conn.execute(
                """
                SELECT h.id
                FROM chat_handle_join chj
                JOIN handle h ON h.ROWID = chj.handle_id
                WHERE chj.chat_id = ?
                """,
                (chat_id,),
            ).fetchall()
        except sqlite3.DatabaseError:
            handle_rows = []
        participants = [r["id"] for r in handle_rows]

        chat_identifier = row["chat_identifier"] or ""
        display_name = row["display_name"] or ""
        is_group = len(participants) > 1 or "chat" in chat_identifier.lower()

        if not display_name:
            if is_group and participants:
                resolved = [(resolve_contact(h, contacts), h) for h in participants]
                resolved.sort(key=lambda x: (not x[0], x[1]))
                names = [name or handle for name, handle in resolved]
                if len(names) <= 3:
                    display_name = ", ".join(names)
                else:
                    display_name = f"{names[0]} + {len(names) - 1}"
            else:
                display_name = (
                    resolve_contact(chat_identifier, contacts)
                    or chat_identifier
                    or f"Chat #{chat_id}"
                )

        return {
            "chat_identifier": chat_identifier,
            "display_name": display_name,
            "service": row["service_name"] or "iMessage",
            "is_group": is_group,
        }


# ── Export helpers ───────────────────────────────────────────────────────────

def _source_label(source: str) -> str:
    return "Recently Deleted" if source == "recently_deleted" else "Orphaned"


def _export_csv(conversations: list, messages_by_conversation: dict,
                output_dir: str) -> str:
    filepath = os.path.join(output_dir, "recovered_messages.csv")
    with open(filepath, "w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        writer.writerow([
            "Conversation", "Source", "Date", "Sender", "Is From Me",
            "Text", "Deleted Date",
        ])
        for convo in conversations:
            name = convo["display_name"] or convo["chat_identifier"] or "Unknown"
            for msg in messages_by_conversation.get(convo["recovery_id"], []):
                sender = "Me" if msg["is_from_me"] else (msg["sender"] or msg["sender_handle"] or "")
                writer.writerow([
                    name,
                    _source_label(msg["source"]),
                    msg["date"] or "",
                    sender,
                    msg["is_from_me"],
                    msg["text"] or "",
                    msg.get("deleted_date") or "",
                ])
    return filepath


_HTML_HEAD = """<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Recovered Messages</title>
<style>
body { font-family: -apple-system, sans-serif; max-width: 720px; margin: 0 auto; padding: 20px; background: #f5f5f5; color: #111; }
h1 { font-size: 20px; margin-bottom: 4px; }
.summary { color: #666; font-size: 12px; margin-bottom: 24px; }
h2 { font-size: 15px; margin: 28px 0 4px; }
.convo-meta { font-size: 11px; color: #888; margin-bottom: 10px; }
.badge { display: inline-block; font-size: 10px; padding: 1px 6px; border-radius: 10px; border: 1px solid; margin-left: 6px; vertical-align: 2px; }
.badge.recently_deleted { color: #92400e; background: #fffbeb; border-color: #fde68a; }
.badge.orphaned { color: #075985; background: #f0f9ff; border-color: #bae6fd; }
.msg { margin: 6px 0; padding: 8px 12px; border-radius: 16px; max-width: 75%; clear: both; }
.sent { background: #10b981; color: white; float: right; border-bottom-right-radius: 4px; }
.received { background: #e9e9eb; color: #111; float: left; border-bottom-left-radius: 4px; }
.meta { font-size: 11px; color: #888; clear: both; text-align: center; margin: 10px 0 4px; }
.sender { font-size: 11px; color: #666; margin-bottom: 2px; }
hr { border: none; border-top: 1px solid #ddd; margin: 24px 0; clear: both; }
</style></head><body>
"""


def _export_html(conversations: list, messages_by_conversation: dict,
                 output_dir: str) -> str:
    filepath = os.path.join(output_dir, "recovered_messages.html")
    total_msgs = sum(len(m) for m in messages_by_conversation.values())
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(_HTML_HEAD)
        f.write("<h1>Recovered Messages</h1>\n")
        f.write(
            f'<div class="summary">{total_msgs} message(s) across '
            f'{len(conversations)} conversation(s)</div>\n'
        )
        for convo in conversations:
            name = html.escape(convo["display_name"] or convo["chat_identifier"] or "Unknown")
            source = convo["source"]
            badge = f'<span class="badge {source}">{_source_label(source)}</span>'
            f.write(f'<hr><h2>{name}{badge}</h2>\n')
            sub_bits = []
            if convo.get("is_group"):
                sub_bits.append("Group")
            if source == "orphaned":
                sub_bits.append("original chat deleted")
            sub_bits.append(f'{convo["message_count"]} recovered')
            f.write(f'<div class="convo-meta">{" · ".join(sub_bits)}</div>\n')
            for msg in messages_by_conversation.get(convo["recovery_id"], []):
                css_class = "sent" if msg["is_from_me"] else "received"
                text = html.escape(msg["text"] or "").replace("\n", "<br>")
                if not text:
                    text = f'<i>[{html.escape(msg["message_type"])}]</i>'
                date = html.escape(msg["date"] or "")
                f.write(f'<div class="meta">{date}</div>\n')
                if not msg["is_from_me"] and convo.get("is_group") and msg.get("sender"):
                    f.write(f'<div class="sender">{html.escape(msg["sender"])}</div>\n')
                f.write(f'<div class="msg {css_class}">{text}</div>\n')
        f.write("</body></html>\n")
    return filepath


def _export_pdf(conversations: list, messages_by_conversation: dict,
                output_dir: str) -> str:
    try:
        from reportlab.lib.pagesizes import letter
        from reportlab.pdfgen import canvas
    except ImportError as e:
        raise RuntimeError("reportlab is required for PDF export.") from e

    filepath = os.path.join(output_dir, "recovered_messages.pdf")
    c = canvas.Canvas(filepath, pagesize=letter)
    width, height = letter
    left = 50
    right = width - 50
    y = height - 50
    line_h = 14

    def new_page():
        nonlocal y
        c.showPage()
        y = height - 50

    def write_line(text: str, font: str = "Helvetica", size: int = 10,
                   indent: int = 0, space_after: int = 0) -> None:
        nonlocal y
        if y < 60:
            new_page()
        c.setFont(font, size)
        max_chars = max(20, int((right - left - indent) / (size * 0.55)))
        for chunk in _wrap(text, max_chars):
            if y < 60:
                new_page()
                c.setFont(font, size)
            c.drawString(left + indent, y, chunk)
            y -= line_h
        y -= space_after

    total_msgs = sum(len(m) for m in messages_by_conversation.values())
    write_line("Recovered Messages", font="Helvetica-Bold", size=16, space_after=4)
    write_line(
        f"{total_msgs} message(s) across {len(conversations)} conversation(s)",
        size=9, space_after=12,
    )

    for convo in conversations:
        name = convo["display_name"] or convo["chat_identifier"] or "Unknown"
        source = _source_label(convo["source"])
        write_line(f"{name}  ·  {source}", font="Helvetica-Bold", size=12, space_after=2)
        sub_bits = []
        if convo.get("is_group"):
            sub_bits.append("Group")
        if convo["source"] == "orphaned":
            sub_bits.append("original chat deleted")
        sub_bits.append(f'{convo["message_count"]} recovered')
        write_line(" · ".join(sub_bits), size=8, space_after=6)

        for msg in messages_by_conversation.get(convo["recovery_id"], []):
            sender = "Me" if msg["is_from_me"] else (msg["sender"] or msg["sender_handle"] or "—")
            header = f'[{msg["date"] or "?"}] {sender}:'
            write_line(header, font="Helvetica-Bold", size=9)
            text = msg["text"] or f'[{msg["message_type"]}]'
            for line in text.split("\n"):
                write_line(line, size=10, indent=12)
            y -= 4
        y -= 10

    c.save()
    return filepath


def _wrap(text: str, width: int) -> list[str]:
    """Greedy word-wrap at `width` characters. Preserves long words by hard-breaking."""
    if not text:
        return [""]
    words = text.split(" ")
    lines: list[str] = []
    current = ""
    for w in words:
        if len(w) > width:
            # hard break long word
            if current:
                lines.append(current)
                current = ""
            for i in range(0, len(w), width):
                lines.append(w[i:i + width])
            continue
        candidate = f"{current} {w}".strip() if current else w
        if len(candidate) > width:
            lines.append(current)
            current = w
        else:
            current = candidate
    if current:
        lines.append(current)
    return lines
