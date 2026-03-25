"""Adapter wrapping the existing v0.3.0 MessageExtractor for the new extraction pipeline.

Preserves all existing extraction logic from messages.py and converts output
to BaseArtifact format with provenance metadata.
"""

import logging
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from extractors._base import ArtifactExtractor
from models.base import BaseArtifact, Provenance
from utils.timestamp import from_cocoa

log = logging.getLogger("openextract.messages")

# Cocoa epoch offset
COCOA_OFFSET = 978307200
NANOSECOND_THRESHOLD = 1_000_000_000_000


def _apple_ts_to_dt(ts: Optional[float]) -> Optional[datetime]:
    """Convert Apple timestamp (seconds or nanoseconds from Cocoa epoch) to UTC datetime."""
    if ts is None or ts == 0:
        return None
    if abs(ts) > NANOSECOND_THRESHOLD:
        ts = ts / 1_000_000_000
    return from_cocoa(ts)


class MessagesExtractor(ArtifactExtractor):
    """Extracts SMS/iMessage conversations using the new base class pattern.

    Reads sms.db directly rather than delegating to the legacy class, but
    uses the same SQL queries and column handling.
    """

    ARTIFACT_TYPE = "message"
    SUPPORTED_IOS_VERSIONS = range(5, 19)

    SMS_DB_DOMAIN = "HomeDomain"
    SMS_DB_PATH = "Library/SMS/sms.db"

    def extract(self) -> list[BaseArtifact]:
        db_path = self.resolve_db_path(self.SMS_DB_DOMAIN, self.SMS_DB_PATH)
        if not db_path:
            self.log.info("sms.db not found — skipping messages")
            return []

        conn = self.open_db(db_path)
        if not conn:
            return []

        try:
            return self._extract_messages(conn, db_path)
        except Exception as e:
            self.log.warning("Messages extraction failed: %s", e)
            return []
        finally:
            conn.close()

    def _extract_messages(self, conn: sqlite3.Connection, db_path: Path) -> list[BaseArtifact]:
        artifacts: list[BaseArtifact] = []

        # Check available columns
        try:
            cols = {row[1] for row in conn.execute("PRAGMA table_info(message)").fetchall()}
        except Exception:
            return []

        has_associated = "associated_message_type" in cols
        has_balloon = "balloon_bundle_id" in cols
        has_roomname = "cache_roomnames" in cols

        select_cols = [
            "m.ROWID",
            "m.text",
            "m.date",
            "m.date_read",
            "m.date_delivered",
            "m.is_from_me",
            "m.handle_id",
            "h.id as handle_value",
        ]
        if has_roomname:
            select_cols.append("m.cache_roomnames")
        if has_associated:
            select_cols.append("m.associated_message_type")
        if has_balloon:
            select_cols.append("m.balloon_bundle_id")

        sql = f"""
            SELECT {', '.join(select_cols)}
            FROM message m
            LEFT JOIN handle h ON m.handle_id = h.ROWID
            ORDER BY m.date ASC
        """

        try:
            rows = conn.execute(sql).fetchall()
        except Exception as e:
            self.log.warning("Failed to query messages: %s", e)
            return []

        for row in rows:
            ts = _apple_ts_to_dt(row["date"])
            text = row["text"] or ""
            handle = row["handle_value"] or ""
            is_from_me = bool(row["is_from_me"])

            data: dict[str, Any] = {
                "is_from_me": is_from_me,
                "handle": handle,
            }
            if has_roomname:
                data["group_chat"] = row["cache_roomnames"] or None
            if has_associated:
                data["associated_message_type"] = row["associated_message_type"]
            if has_balloon:
                data["balloon_bundle_id"] = row["balloon_bundle_id"]

            date_read = _apple_ts_to_dt(row["date_read"]) if "date_read" in row.keys() else None
            if date_read:
                data["date_read"] = date_read.isoformat()

            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=ts,
                provenance=Provenance(
                    source_db="sms.db",
                    source_table="message",
                    source_row_id=row["ROWID"],
                ),
                contact_identifier=handle if not is_from_me else None,
                text_content=text[:500] if text else None,  # Truncate for search index
                data=data,
            ))

        return artifacts
