"""SMS/iMessage extraction from sms.db."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from ..backup import BackupReader
from ..models.message import Attachment, Conversation, Message, MessageType
from .contacts import ContactExtractor

_SMS_DB_PATHS = [
    "Library/SMS/sms.db",
    "HomeDomain/Library/SMS/sms.db",
]

# Apple's epoch starts 2001-01-01 (seconds since)
_APPLE_EPOCH_OFFSET = 978307200


def _apple_ts(ts: int | float | None) -> datetime | None:
    if ts is None:
        return None
    # iOS 11+ uses nanoseconds
    if ts > 1e12:
        ts = ts / 1e9
    return datetime.fromtimestamp(ts + _APPLE_EPOCH_OFFSET, tz=timezone.utc)


_BALLOON_TYPE_MAP = {
    "com.apple.messages.URLBalloonProvider": MessageType.LINK,
    "com.apple.messages.MSMessageExtensionBalloonPlugin:0000000000:com.apple.SafariSharedLinks.app-extension": MessageType.LINK,
    "com.apple.Digital Touch": MessageType.DIGITAL_TOUCH,
    "com.apple.Handwriting": MessageType.HANDWRITING,
    "com.apple.messages.MSMessageExtensionBalloonPlugin:243B9A50-10B6-4E03-AEB6-BEBFD1E09947:com.apple.iMessage.MSMessagesAppExtension": MessageType.PAYMENT,
    "com.apple.PassbookUIKit.PBBalloonPlugin": MessageType.PAYMENT,
    "com.apple.messages.MSMessageExtensionBalloonPlugin:04F4E476-E72D-4BA8-BC1E-6B61B8DEE9A3:com.apple.WorkoutSharingApp": MessageType.FITNESS,
    "com.apple.maps.messagesextension": MessageType.LOCATION,
}


def _detect_type(balloon_id: str | None, has_attachments: bool) -> MessageType:
    if balloon_id:
        for key, mtype in _BALLOON_TYPE_MAP.items():
            if key in balloon_id:
                return mtype
        if "game" in balloon_id.lower():
            return MessageType.GAME
        return MessageType.APP
    if has_attachments:
        return MessageType.AUDIO  # default non-text attachment
    return MessageType.TEXT


class MessageExtractor:
    def __init__(self, reader: BackupReader, contacts: ContactExtractor | None = None):
        self._reader = reader
        self._contacts = contacts
        self._db_path: Path | None = None

    def _open_db(self) -> Path:
        if self._db_path and self._db_path.exists():
            return self._db_path
        for rel_path in _SMS_DB_PATHS:
            try:
                self._db_path = self._reader.extract_to_temp(rel_path)
                return self._db_path
            except FileNotFoundError:
                continue
        raise FileNotFoundError("sms.db not found in backup")

    def _conn(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self._open_db()))
        conn.row_factory = sqlite3.Row
        return conn

    def _resolve(self, identifier: str | None) -> str | None:
        if not identifier or not self._contacts:
            return identifier
        return self._contacts.display_name(identifier) or identifier

    # ------------------------------------------------------------------

    def list_conversations(self) -> list[Conversation]:
        conn = self._conn()
        rows = conn.execute(
            """
            SELECT
                chat.ROWID as id,
                chat.guid,
                chat.display_name,
                chat.chat_identifier,
                COUNT(DISTINCT cm.handle_id) as participant_count,
                MAX(message.date) as last_date,
                (SELECT text FROM message m2
                 JOIN chat_message_join cmj ON cmj.message_id = m2.ROWID
                 WHERE cmj.chat_id = chat.ROWID
                 ORDER BY m2.date DESC LIMIT 1) as last_text,
                COUNT(message.ROWID) as msg_count
            FROM chat
            LEFT JOIN chat_message_join cmj ON cmj.chat_id = chat.ROWID
            LEFT JOIN message ON message.ROWID = cmj.message_id
            LEFT JOIN chat_handle_join cm ON cm.chat_id = chat.ROWID
            GROUP BY chat.ROWID
            ORDER BY last_date DESC NULLS LAST
            """
        ).fetchall()

        conversations = []
        for row in rows:
            # Get participant handles
            handles = conn.execute(
                """
                SELECT handle.id FROM handle
                JOIN chat_handle_join ON chat_handle_join.handle_id = handle.ROWID
                WHERE chat_handle_join.chat_id = ?
                """,
                (row["id"],),
            ).fetchall()
            participants = [h[0] for h in handles]
            participant_names = [self._resolve(p) or p for p in participants]

            conversations.append(
                Conversation(
                    id=row["id"],
                    guid=row["guid"],
                    display_name=row["display_name"] or None,
                    participants=participants,
                    participant_names=participant_names,
                    message_count=row["msg_count"] or 0,
                    last_message_at=_apple_ts(row["last_date"]),
                    last_message_text=row["last_text"],
                    is_group=(row["participant_count"] or 0) > 1,
                )
            )
        conn.close()
        return conversations

    def get_messages(
        self,
        chat_id: int,
        offset: int = 0,
        limit: int = 100,
        date_from: datetime | None = None,
        date_to: datetime | None = None,
    ) -> list[Message]:
        conn = self._conn()

        clauses = ["cmj.chat_id = ?"]
        params: list = [chat_id]

        if date_from:
            apple_from = (date_from.timestamp() - _APPLE_EPOCH_OFFSET) * 1e9
            clauses.append("message.date >= ?")
            params.append(int(apple_from))
        if date_to:
            apple_to = (date_to.timestamp() - _APPLE_EPOCH_OFFSET) * 1e9
            clauses.append("message.date <= ?")
            params.append(int(apple_to))

        where = " AND ".join(clauses)
        params += [limit, offset]

        rows = conn.execute(
            f"""
            SELECT
                message.ROWID as id,
                message.guid,
                message.text,
                message.is_from_me,
                message.date,
                message.service,
                message.handle_id,
                message.balloon_bundle_id,
                handle.id as sender_id
            FROM message
            JOIN chat_message_join cmj ON cmj.message_id = message.ROWID
            LEFT JOIN handle ON handle.ROWID = message.handle_id
            WHERE {where}
            ORDER BY message.date ASC
            LIMIT ? OFFSET ?
            """,
            params,
        ).fetchall()

        messages = []
        for row in rows:
            sender = row["sender_id"] or "me"
            attachments = self._get_attachments(conn, row["id"])
            msg_type = _detect_type(row["balloon_bundle_id"], bool(attachments))
            messages.append(
                Message(
                    id=row["id"],
                    chat_id=chat_id,
                    guid=row["guid"],
                    text=row["text"],
                    sender=sender,
                    sender_name=self._resolve(sender) if sender != "me" else "Me",
                    timestamp=_apple_ts(row["date"]) or datetime.now(tz=timezone.utc),
                    is_from_me=bool(row["is_from_me"]),
                    type=msg_type,
                    attachments=attachments,
                )
            )
        conn.close()
        return messages

    def search_messages(
        self,
        query: str,
        chat_id: int | None = None,
        limit: int = 100,
    ) -> list[Message]:
        conn = self._conn()
        clauses = ["(message.text LIKE ? OR message.attributedBody LIKE ?)"]
        params: list = [f"%{query}%", f"%{query}%"]
        if chat_id is not None:
            clauses.append("cmj.chat_id = ?")
            params.append(chat_id)
        params.append(limit)

        rows = conn.execute(
            f"""
            SELECT message.ROWID as id, message.guid, message.text,
                   message.is_from_me, message.date, message.balloon_bundle_id,
                   handle.id as sender_id,
                   COALESCE(cmj.chat_id, 0) as chat_id
            FROM message
            LEFT JOIN chat_message_join cmj ON cmj.message_id = message.ROWID
            LEFT JOIN handle ON handle.ROWID = message.handle_id
            WHERE {" AND ".join(clauses)}
            ORDER BY message.date DESC
            LIMIT ?
            """,
            params,
        ).fetchall()

        messages = []
        for row in rows:
            sender = row["sender_id"] or "me"
            messages.append(
                Message(
                    id=row["id"],
                    chat_id=row["chat_id"],
                    guid=row["guid"],
                    text=row["text"],
                    sender=sender,
                    sender_name=self._resolve(sender) if sender != "me" else "Me",
                    timestamp=_apple_ts(row["date"]) or datetime.now(tz=timezone.utc),
                    is_from_me=bool(row["is_from_me"]),
                    type=_detect_type(row["balloon_bundle_id"], False),
                )
            )
        conn.close()
        return messages

    def get_attachment_bytes(self, attachment_id: int) -> bytes | None:
        conn = self._conn()
        row = conn.execute(
            "SELECT filename FROM attachment WHERE ROWID=?", (attachment_id,)
        ).fetchone()
        conn.close()
        if not row:
            return None
        # filename is relative to home dir, e.g. ~/Library/SMS/Attachments/...
        rel = row[0].replace("~/", "")
        try:
            path = self._reader.get_file_path(rel)
            return path.read_bytes() if path else None
        except Exception:
            return None

    def _get_attachments(self, conn: sqlite3.Connection, message_id: int) -> list[Attachment]:
        rows = conn.execute(
            """
            SELECT attachment.ROWID, attachment.filename, attachment.mime_type,
                   attachment.total_bytes, attachment.transfer_name
            FROM attachment
            JOIN message_attachment_join ON message_attachment_join.attachment_id = attachment.ROWID
            WHERE message_attachment_join.message_id = ?
            """,
            (message_id,),
        ).fetchall()
        return [
            Attachment(
                id=r[0],
                filename=r[1],
                mime_type=r[2],
                size_bytes=r[3],
                transfer_name=r[4],
            )
            for r in rows
        ]
