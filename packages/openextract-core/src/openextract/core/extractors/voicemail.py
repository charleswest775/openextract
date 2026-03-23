"""Voicemail extraction from voicemail.db."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from ..backup import BackupReader
from ..models.voicemail import Voicemail
from .contacts import ContactExtractor

_VM_DB_PATHS = [
    "Library/Voicemail/voicemail.db",
    "HomeDomain/Library/Voicemail/voicemail.db",
]


class VoicemailExtractor:
    def __init__(self, reader: BackupReader, contacts: ContactExtractor | None = None):
        self._reader = reader
        self._contacts = contacts
        self._db_path: Path | None = None

    def _open_db(self) -> Path:
        if self._db_path and self._db_path.exists():
            return self._db_path
        for rel_path in _VM_DB_PATHS:
            try:
                self._db_path = self._reader.extract_to_temp(rel_path)
                return self._db_path
            except FileNotFoundError:
                continue
        raise FileNotFoundError("voicemail.db not found in backup")

    def list_voicemails(self) -> list[Voicemail]:
        conn = sqlite3.connect(str(self._open_db()))
        conn.row_factory = sqlite3.Row

        cols = {r[1] for r in conn.execute("PRAGMA table_info(voicemail)").fetchall()}
        transcript_col = "transcript" if "transcript" in cols else "NULL"

        rows = conn.execute(
            f"""
            SELECT ROWID, sender, duration, date, trashed_date,
                   flags, {transcript_col} as transcript
            FROM voicemail
            WHERE trashed_date IS NULL OR trashed_date = 0
            ORDER BY date DESC
            """
        ).fetchall()

        voicemails = []
        for row in rows:
            sender = row["sender"] or "Unknown"
            contact_name = None
            if self._contacts:
                contact_name = self._contacts.display_name(sender)

            # date is Unix timestamp
            ts = datetime.fromtimestamp(row["date"] or 0, tz=timezone.utc)
            flags = row["flags"] or 0
            is_read = bool(flags & 1)

            voicemails.append(
                Voicemail(
                    id=row["ROWID"],
                    sender=sender,
                    sender_name=contact_name,
                    duration_seconds=row["duration"] or 0.0,
                    timestamp=ts,
                    is_read=is_read,
                    transcript=row["transcript"],
                )
            )

        conn.close()
        return voicemails

    def get_audio_bytes(self, voicemail_id: int) -> bytes | None:
        """Return raw audio bytes for a voicemail."""
        # Audio stored at Library/Voicemail/<id>.amr
        for ext in ("amr", "m4a"):
            rel = f"Library/Voicemail/{voicemail_id}.{ext}"
            try:
                path = self._reader.get_file_path(rel)
                if path:
                    return path.read_bytes()
            except Exception:
                continue
        return None
