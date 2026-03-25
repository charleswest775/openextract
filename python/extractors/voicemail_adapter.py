"""Adapter wrapping existing voicemail extraction for the new pipeline.

Extracts voicemail metadata from voicemail.db into BaseArtifact format.
Audio binary handling stays in the legacy voicemail.py.
"""

import sqlite3
from pathlib import Path
from typing import Any, Optional

from extractors._base import ArtifactExtractor
from models.base import BaseArtifact, Provenance
from utils.timestamp import from_cocoa


class VoicemailExtractor(ArtifactExtractor):
    """Extracts voicemail metadata from voicemail.db."""

    ARTIFACT_TYPE = "voicemail"
    SUPPORTED_IOS_VERSIONS = range(5, 19)

    VM_DOMAIN = "HomeDomain"
    VM_PATH = "Library/Voicemail/voicemail.db"

    def extract(self) -> list[BaseArtifact]:
        db_path = self.resolve_db_path(self.VM_DOMAIN, self.VM_PATH)
        if not db_path:
            self.log.info("voicemail.db not found — skipping voicemails")
            return []

        conn = self.open_db(db_path)
        if not conn:
            return []

        try:
            return self._extract_voicemails(conn)
        except Exception as e:
            self.log.warning("Voicemail extraction failed: %s", e)
            return []
        finally:
            conn.close()

    def _extract_voicemails(self, conn: sqlite3.Connection) -> list[BaseArtifact]:
        artifacts: list[BaseArtifact] = []

        # Check for transcript column (iOS 17+)
        try:
            cols = {row[1] for row in conn.execute("PRAGMA table_info(voicemail)").fetchall()}
        except Exception:
            return []

        has_transcript = "transcript" in cols

        select = "ROWID, sender, date, duration, flags, trashed_date"
        if has_transcript:
            select += ", transcript"

        try:
            rows = conn.execute(f"""
                SELECT {select}
                FROM voicemail
                WHERE trashed_date = 0 OR trashed_date IS NULL
                ORDER BY date ASC
            """).fetchall()
        except Exception as e:
            self.log.warning("Failed to query voicemail: %s", e)
            return []

        for row in rows:
            ts = from_cocoa(row["date"])
            sender = row["sender"] or ""
            duration = row["duration"] or 0
            transcript = row["transcript"] if has_transcript else None

            data: dict[str, Any] = {
                "sender": sender,
                "duration_seconds": duration,
                "flags": row["flags"],
            }
            if transcript:
                data["transcript"] = transcript

            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=ts,
                provenance=Provenance(
                    source_db="voicemail.db",
                    source_table="voicemail",
                    source_row_id=row["ROWID"],
                ),
                contact_identifier=sender,
                text_content=transcript or f"Voicemail from {sender} ({duration}s)",
                data=data,
            ))

        return artifacts
