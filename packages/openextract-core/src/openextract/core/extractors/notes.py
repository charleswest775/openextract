"""Notes extraction from NoteStore.sqlite (iOS 11+) and legacy notes.sqlite."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from ..backup import BackupReader
from ..models.note import Note

# iOS 11+ NoteStore path candidates
_NOTE_STORE_PATHS = [
    "Library/Group Containers/group.com.apple.notes/NoteStore.sqlite",
    "AppDomainGroup-group.com.apple.notes/NoteStore.sqlite",
]

# Legacy iOS 9
_LEGACY_PATHS = [
    "Library/Notes/notes.sqlite",
    "HomeDomain/Library/Notes/notes.sqlite",
]

_APPLE_EPOCH = 978307200


def _apple_ts(val: float | None) -> datetime | None:
    if val is None:
        return None
    return datetime.fromtimestamp(val + _APPLE_EPOCH, tz=timezone.utc)


class NoteExtractor:
    def __init__(self, reader: BackupReader):
        self._reader = reader
        self._db_path: Path | None = None
        self._is_legacy = False

    def _open_db(self) -> Path:
        if self._db_path and self._db_path.exists():
            return self._db_path

        # Try modern NoteStore first
        for rel_path in _NOTE_STORE_PATHS:
            try:
                self._db_path = self._reader.extract_to_temp(rel_path)
                self._is_legacy = False
                return self._db_path
            except FileNotFoundError:
                continue

        # Scan manifest for NoteStore.sqlite
        matches = self._reader.find_files(path_like="NoteStore.sqlite")
        for match in matches:
            try:
                self._db_path = self._reader.extract_to_temp(match["path"])
                self._is_legacy = False
                return self._db_path
            except FileNotFoundError:
                continue

        # Fall back to legacy
        for rel_path in _LEGACY_PATHS:
            try:
                self._db_path = self._reader.extract_to_temp(rel_path)
                self._is_legacy = True
                return self._db_path
            except FileNotFoundError:
                continue

        raise FileNotFoundError("Notes database not found in backup")

    def list_notes(self) -> list[Note]:
        self._open_db()
        if self._is_legacy:
            return self._list_legacy()
        return self._list_modern()

    def _list_modern(self) -> list[Note]:
        conn = sqlite3.connect(str(self._db_path))
        conn.row_factory = sqlite3.Row

        # Check for pinned column
        cols = {r[1] for r in conn.execute("PRAGMA table_info(ZICNOTEDATA)").fetchall()}

        try:
            rows = conn.execute(
                """
                SELECT
                    n.Z_PK as id,
                    n.ZTITLE as title,
                    n.ZCREATIONDATE as created,
                    n.ZMODIFICATIONDATE as modified,
                    n.ZISPINNED as pinned,
                    nd.ZPLAINTEXT as body,
                    f.ZTITLE as folder
                FROM ZICCLOUDSYNCINGOBJECT n
                LEFT JOIN ZICNOTEDATA nd ON nd.ZNOTE = n.Z_PK
                LEFT JOIN ZICCLOUDSYNCINGOBJECT f ON f.Z_PK = n.ZFOLDER
                WHERE n.ZNOTEDATA IS NOT NULL
                   OR nd.ZPLAINTEXT IS NOT NULL
                ORDER BY n.ZMODIFICATIONDATE DESC
                """
            ).fetchall()
        except sqlite3.OperationalError:
            conn.close()
            return []

        notes = []
        for row in rows:
            body = row["body"] or ""
            notes.append(
                Note(
                    id=row["id"],
                    title=row["title"],
                    body=body,
                    created_at=_apple_ts(row["created"]),
                    modified_at=_apple_ts(row["modified"]),
                    folder=row["folder"],
                    is_pinned=bool(row["pinned"]),
                    word_count=len(body.split()) if body else 0,
                )
            )

        conn.close()
        return notes

    def _list_legacy(self) -> list[Note]:
        conn = sqlite3.connect(str(self._db_path))
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                """
                SELECT ROWID as id, title, summary as body,
                       creation_date as created, modification_date as modified
                FROM Note ORDER BY modification_date DESC
                """
            ).fetchall()
        except sqlite3.OperationalError:
            conn.close()
            return []

        notes = []
        for row in rows:
            body = row["body"] or ""
            notes.append(
                Note(
                    id=row["id"],
                    title=row["title"],
                    body=body,
                    created_at=_apple_ts(row["created"]),
                    modified_at=_apple_ts(row["modified"]),
                    word_count=len(body.split()) if body else 0,
                )
            )
        conn.close()
        return notes
