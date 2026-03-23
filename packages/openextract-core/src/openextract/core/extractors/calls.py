"""Call history extraction from CallHistory.storedata."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from ..backup import BackupReader
from ..models.call import Call, CallDirection
from .contacts import ContactExtractor

_CALL_DB_PATHS = [
    "Library/CallHistoryDB/CallHistory.storedata",
    "HomeDomain/Library/CallHistoryDB/CallHistory.storedata",
]


class CallExtractor:
    def __init__(self, reader: BackupReader, contacts: ContactExtractor | None = None):
        self._reader = reader
        self._contacts = contacts
        self._db_path: Path | None = None

    def _open_db(self) -> Path:
        if self._db_path and self._db_path.exists():
            return self._db_path
        for rel_path in _CALL_DB_PATHS:
            try:
                self._db_path = self._reader.extract_to_temp(rel_path)
                return self._db_path
            except FileNotFoundError:
                continue
        raise FileNotFoundError(
            "CallHistory.storedata not found. Call history requires an encrypted backup."
        )

    def _detect_direction(self, answered: int, originated: int, disconnected_cause: int) -> CallDirection:
        if originated:
            return CallDirection.OUTGOING
        if not answered:
            return CallDirection.MISSED
        return CallDirection.INCOMING

    def list_calls(self, offset: int = 0, limit: int = 200) -> list[Call]:
        conn = sqlite3.connect(str(self._open_db()))
        conn.row_factory = sqlite3.Row

        # Schema varies by iOS version — check available columns
        cols = {r[1] for r in conn.execute("PRAGMA table_info(ZCALLRECORD)").fetchall()}

        service_col = "ZSERVICE_PROVIDER" if "ZSERVICE_PROVIDER" in cols else "NULL"
        country_col = "ZISO_COUNTRY_CODE" if "ZISO_COUNTRY_CODE" in cols else "NULL"

        rows = conn.execute(
            f"""
            SELECT ROWID, ZADDRESS, ZDURATION, ZDATE, ZANSWERED, ZORIGINATED,
                   ZDISCONNECTED_CAUSE, {service_col} as service, {country_col} as country
            FROM ZCALLRECORD
            ORDER BY ZDATE DESC
            LIMIT ? OFFSET ?
            """,
            (limit, offset),
        ).fetchall()

        calls = []
        for row in rows:
            address = row["ZADDRESS"] or "Unknown"
            direction = self._detect_direction(
                row["ZANSWERED"] or 0,
                row["ZORIGINATED"] or 0,
                row["ZDISCONNECTED_CAUSE"] or 0,
            )
            # ZDATE is seconds since 2001-01-01
            ts = datetime.fromtimestamp(
                (row["ZDATE"] or 0) + 978307200, tz=timezone.utc
            )
            contact_name = None
            if self._contacts:
                contact_name = self._contacts.display_name(address)

            calls.append(
                Call(
                    id=row["ROWID"],
                    address=address,
                    contact_name=contact_name,
                    direction=direction,
                    duration_seconds=row["ZDURATION"] or 0.0,
                    timestamp=ts,
                    service=row["service"],
                    country_code=row["country"],
                )
            )

        conn.close()
        return calls
