"""Adapter wrapping the existing v0.3.0 CallExtractor for the new extraction pipeline.

Extracts call history from CallHistory.storedata and converts to BaseArtifact format.
"""

import sqlite3
from datetime import timedelta
from pathlib import Path
from typing import Any, Optional

from extractors._base import ArtifactExtractor
from models.base import BaseArtifact, Provenance
from utils.timestamp import from_cocoa

# Call type constants from ZCALLRECORD
CALL_TYPES = {1: "incoming", 2: "outgoing", 3: "missed", 4: "blocked"}


class CallsExtractor(ArtifactExtractor):
    """Extracts call history from CallHistory.storedata (iOS 8+)."""

    ARTIFACT_TYPE = "call"
    SUPPORTED_IOS_VERSIONS = range(8, 19)

    CH_DOMAIN = "WirelessDomain"
    CH_PATH = "Library/CallHistoryDB/CallHistory.storedata"

    def extract(self) -> list[BaseArtifact]:
        db_path = self.resolve_db_path(self.CH_DOMAIN, self.CH_PATH)
        if not db_path:
            self.log.info("CallHistory.storedata not found — skipping calls")
            return []

        conn = self.open_db(db_path)
        if not conn:
            return []

        try:
            return self._extract_calls(conn)
        except Exception as e:
            self.log.warning("Call history extraction failed: %s", e)
            return []
        finally:
            conn.close()

    def _extract_calls(self, conn: sqlite3.Connection) -> list[BaseArtifact]:
        artifacts: list[BaseArtifact] = []

        # Check what columns exist (schema varies by iOS version)
        try:
            cols = {row[1] for row in conn.execute("PRAGMA table_info(ZCALLRECORD)").fetchall()}
        except Exception:
            self.log.warning("ZCALLRECORD table not found")
            return []

        has_facetime = "ZFACE_TIME_DATA" in cols

        try:
            rows = conn.execute("""
                SELECT Z_PK, ZADDRESS, ZDATE, ZDURATION,
                       ZCALLTYPE, ZANSWERED, ZORIGINATED
                FROM ZCALLRECORD
                ORDER BY ZDATE ASC
            """).fetchall()
        except Exception as e:
            self.log.warning("Failed to query ZCALLRECORD: %s", e)
            return []

        for row in rows:
            ts = from_cocoa(row["ZDATE"])
            duration = row["ZDURATION"] or 0
            call_type_id = row["ZCALLTYPE"] or 0
            call_type = CALL_TYPES.get(call_type_id, "unknown")
            address = row["ZADDRESS"] or ""
            answered = bool(row["ZANSWERED"])

            ts_end = None
            if ts and duration > 0:
                ts_end = ts + timedelta(seconds=duration)

            data: dict[str, Any] = {
                "address": address,
                "call_type": call_type,
                "call_type_id": call_type_id,
                "duration_seconds": duration,
                "answered": answered,
                "originated": bool(row["ZORIGINATED"]),
            }

            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=ts,
                timestamp_end=ts_end,
                provenance=Provenance(
                    source_db="CallHistory.storedata",
                    source_table="ZCALLRECORD",
                    source_row_id=row["Z_PK"],
                ),
                contact_identifier=address,
                text_content=f"{call_type} call {'from' if not answered else 'to'} {address}",
                data=data,
            ))

        return artifacts
