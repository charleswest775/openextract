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
import os
import sqlite3
from typing import Optional

from ios_backup_core.contacts import resolve_contact
from ios_backup_core.db import connect_readonly, get_database
from ios_backup_core.text import parse_attributed_body
from ios_backup_core.timestamps import apple_to_iso as apple_date_to_iso

from local_dates import csv_date, readable_date
from record_document import (
    CSV_ENCODING,
    Column,
    RecordDocument,
    Section,
    csv_cell,
    plural,
    unused_path,
    write_document,
)

# 'pdf' is the old PDF drawn by reportlab in the engine, kept so older callers
# still work; the app prints 'pdf_source' with Chromium instead.
FORMATS = ("csv", "html", "txt", "pdf_source", "pdf")

# The file every format is named after ("recovered_messages.html", then "… (2).html")
FILE_BASE = "recovered_messages"


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

    # The time zone saved dates are written in; None is this computer's.
    local_tz = None

    def recover_messages(self, backup, contacts: dict) -> dict:
        db_path = get_database(backup, "Library/SMS/sms.db", "HomeDomain")
        if not db_path:
            return {
                "conversations": [],
                "messages_by_conversation": {},
                "scanned": {"recently_deleted": 0, "orphaned": 0},
                "schema_support": {"recently_deleted": False},
            }

        conn = connect_readonly(db_path, backup)
        conn.row_factory = sqlite3.Row
        if not _table_exists(conn, "chat_message_join"):
            # An iOS 5 sms.db (no chats; see ios_backup_core's is_legacy_sms_db).
            conn.close()
            return {
                "conversations": [],
                "messages_by_conversation": {},
                "scanned": {"recently_deleted": 0, "orphaned": 0},
                "schema_support": {"recently_deleted": False},
            }
        try:
            has_recoverable = _table_exists(conn, "chat_recoverable_message_join")
            # Older sms.db files have no attributedBody: the text column is all there is.
            attributed_body = (
                "m.attributedBody" if _column_exists(conn, "message", "attributedBody") else "NULL"
            )

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
                           {attributed_body} AS attributed_body,
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
                       {attributed_body} AS attributed_body,
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
        """Save every recovered message into one new file in ``output_dir``.

        Formats: csv (one row per message), html / txt / pdf_source (a
        document with a section per conversation, record_document.py; Electron
        prints pdf_source to a PDF), pdf (the old reportlab PDF). Dates are in
        the computer's time zone. Returns {file, message_count,
        conversation_count}; an unknown format is {error}.
        """
        fmt = (fmt or "").lower()
        if fmt not in FORMATS:
            return {"error": f"Unsupported format: {fmt}"}

        data = self.recover_messages(backup, contacts)
        conversations = data["conversations"]
        messages_by_conversation = data["messages_by_conversation"]

        os.makedirs(output_dir, exist_ok=True)
        if fmt == "csv":
            filepath = _export_csv(conversations, messages_by_conversation, output_dir, self.local_tz)
        elif fmt == "pdf":
            filepath = _export_pdf(conversations, messages_by_conversation, output_dir)
        else:
            doc = _document(conversations, messages_by_conversation, self.local_tz)
            filepath = write_document(doc, output_dir, FILE_BASE, fmt)

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
        # Older sms.db files have no chat.display_name.
        display_name = "display_name" if _column_exists(conn, "chat", "display_name") else "NULL"
        try:
            row = conn.execute(
                f"""
                SELECT chat_identifier, {display_name} AS display_name, service_name
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
    """The spreadsheet's word for where a message was found."""
    return "Recently Deleted" if source == "recently_deleted" else "Orphaned"


def _found_in(source: str) -> str:
    """The same in the app's words (the Recover deleted messages screen)."""
    return "Recently Deleted" if source == "recently_deleted" else "Left behind"


def _convo_name(convo: dict) -> str:
    return convo["display_name"] or convo["chat_identifier"] or "Unknown"


def _sender_label(msg: dict) -> str:
    return "Me" if msg["is_from_me"] else (msg["sender"] or msg["sender_handle"] or "")


def _export_csv(conversations: list, messages_by_conversation: dict,
                output_dir: str, tz=None) -> str:
    filepath = unused_path(output_dir, FILE_BASE, ".csv")
    with open(filepath, "w", newline="", encoding=CSV_ENCODING) as f:
        writer = csv.writer(f)
        writer.writerow([
            "Conversation", "Source", "Date", "Sender", "Is From Me",
            "Text", "Deleted Date",
        ])
        for convo in conversations:
            name = _convo_name(convo)
            for msg in messages_by_conversation.get(convo["recovery_id"], []):
                writer.writerow([
                    csv_cell(name),
                    _source_label(msg["source"]),
                    csv_date(msg["date"], tz),
                    csv_cell(_sender_label(msg)),
                    msg["is_from_me"],
                    # Somebody else may have written it: never a formula
                    csv_cell(msg["text"] or ""),
                    csv_date(msg.get("deleted_date"), tz),
                ])
    return filepath


def _document(conversations: list, messages_by_conversation: dict, tz=None) -> RecordDocument:
    """A section per conversation: where its messages were found, then each
    message with when, who and when it was deleted (Recently Deleted keeps that)."""
    total = sum(len(m) for m in messages_by_conversation.values())
    sections = []
    for convo in conversations:
        msgs = messages_by_conversation.get(convo["recovery_id"], [])
        meta = [_found_in(convo["source"])]
        if convo.get("is_group"):
            meta.append("Group")
        if convo["source"] == "orphaned":
            meta.append("original chat deleted")
        meta.append(f"{plural(len(msgs), 'message')} recovered")
        rows, lines = [], []
        for msg in msgs:
            when = readable_date(msg["date"], tz)
            text = msg["text"] or f'[{msg["message_type"]}]'
            deleted = readable_date(msg["deleted_date"], tz) if msg.get("deleted_date") else ""
            sender = _sender_label(msg)
            rows.append([when, sender, text, deleted])
            line = f"[{when}] {sender or 'Unknown'}: {text}"
            lines.append(f"{line} (deleted {deleted})" if deleted else line)
        sections.append(Section(
            heading=_convo_name(convo),
            meta=" · ".join(meta),
            columns=[Column("When", "when"), Column("From"), Column("Message"), Column("Deleted", "when")],
            rows=rows,
            text_lines=lines,
        ))
    return RecordDocument(
        title="Recovered messages",
        summary=f"{plural(total, 'message')} in {plural(len(conversations), 'conversation')}",
        sections=sections or [Section(empty="No deleted messages were found in this backup.")],
    )


def _export_pdf(conversations: list, messages_by_conversation: dict,
                output_dir: str) -> str:
    try:
        from reportlab.lib.pagesizes import letter
        from reportlab.pdfgen import canvas
    except ImportError as e:
        raise RuntimeError("reportlab is required for PDF export.") from e

    filepath = unused_path(output_dir, FILE_BASE, ".pdf")
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
