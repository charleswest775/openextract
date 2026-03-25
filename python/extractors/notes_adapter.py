"""Adapter wrapping existing notes extraction for the new pipeline.

Extracts notes from NoteStore.sqlite into BaseArtifact format.
"""

import sqlite3
from pathlib import Path
from typing import Any, Optional

from extractors._base import ArtifactExtractor
from models.base import BaseArtifact, Provenance
from utils.timestamp import from_cocoa


class NotesExtractor(ArtifactExtractor):
    """Extracts notes from NoteStore.sqlite (iOS 9+) and legacy notes.sqlite."""

    ARTIFACT_TYPE = "note"
    SUPPORTED_IOS_VERSIONS = range(9, 19)

    # NoteStore.sqlite is in various locations depending on iOS version
    NOTESTORE_DOMAIN = "AppDomainGroup-group.com.apple.notes"
    NOTESTORE_PATH = "NoteStore.sqlite"
    LEGACY_DOMAIN = "HomeDomain"
    LEGACY_PATH = "Library/Notes/notes.sqlite"

    def extract(self) -> list[BaseArtifact]:
        # Try modern NoteStore.sqlite first
        artifacts = self._try_notestore()
        if artifacts:
            return artifacts

        # Fall back to legacy notes.sqlite
        return self._try_legacy()

    def _try_notestore(self) -> list[BaseArtifact]:
        db_path = self.resolve_db_path(self.NOTESTORE_DOMAIN, self.NOTESTORE_PATH)
        if not db_path:
            # Also try HomeDomain path
            db_path = self.resolve_db_path(self.LEGACY_DOMAIN, "Library/Notes/NoteStore.sqlite")
        if not db_path:
            return []

        conn = self.open_db(db_path)
        if not conn:
            return []

        try:
            return self._extract_notestore(conn)
        except Exception as e:
            self.log.warning("NoteStore extraction failed: %s", e)
            return []
        finally:
            conn.close()

    def _extract_notestore(self, conn: sqlite3.Connection) -> list[BaseArtifact]:
        artifacts: list[BaseArtifact] = []

        # Check for ZICCLOUDSYNCINGOBJECT table (iOS 9+)
        try:
            tables = {row[0] for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()}
        except Exception:
            return []

        if "ZICCLOUDSYNCINGOBJECT" not in tables:
            return []

        try:
            rows = conn.execute("""
                SELECT
                    n.Z_PK,
                    n.ZTITLE1 as title,
                    n.ZSNIPPET as snippet,
                    n.ZCREATIONDATE1 as creation_date,
                    n.ZMODIFICATIONDATE1 as modification_date,
                    n.ZIDENTIFIER as identifier
                FROM ZICCLOUDSYNCINGOBJECT n
                WHERE n.ZTITLE1 IS NOT NULL
                  AND n.ZMARKEDFORDELETION != 1
                ORDER BY n.ZMODIFICATIONDATE1 DESC
            """).fetchall()
        except Exception as e:
            # Column names vary; try alternative
            try:
                rows = conn.execute("""
                    SELECT
                        Z_PK,
                        ZTITLE as title,
                        ZSNIPPET as snippet,
                        ZCREATIONDATE as creation_date,
                        ZMODIFICATIONDATE as modification_date,
                        ZIDENTIFIER as identifier
                    FROM ZICCLOUDSYNCINGOBJECT
                    WHERE ZTITLE IS NOT NULL
                    ORDER BY ZMODIFICATIONDATE DESC
                """).fetchall()
            except Exception as e2:
                self.log.warning("Failed to query NoteStore: %s / %s", e, e2)
                return []

        for row in rows:
            ts = from_cocoa(row["creation_date"])
            title = row["title"] or "Untitled"
            snippet = row["snippet"] or ""

            data: dict[str, Any] = {
                "title": title,
                "snippet": snippet[:500],
                "identifier": row["identifier"],
            }

            mod_date = from_cocoa(row["modification_date"])
            if mod_date:
                data["modification_date"] = mod_date.isoformat()

            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=ts,
                provenance=Provenance(
                    source_db="NoteStore.sqlite",
                    source_table="ZICCLOUDSYNCINGOBJECT",
                    source_row_id=row["Z_PK"],
                ),
                text_content=f"{title}\n{snippet[:200]}" if snippet else title,
                data=data,
            ))

        return artifacts

    def _try_legacy(self) -> list[BaseArtifact]:
        db_path = self.resolve_db_path(self.LEGACY_DOMAIN, self.LEGACY_PATH)
        if not db_path:
            self.log.info("No notes database found — skipping notes")
            return []

        conn = self.open_db(db_path)
        if not conn:
            return []

        try:
            return self._extract_legacy(conn)
        except Exception as e:
            self.log.warning("Legacy notes extraction failed: %s", e)
            return []
        finally:
            conn.close()

    def _extract_legacy(self, conn: sqlite3.Connection) -> list[BaseArtifact]:
        artifacts: list[BaseArtifact] = []

        try:
            rows = conn.execute("""
                SELECT
                    n.ROWID,
                    n.title,
                    n.creation_date,
                    n.modification_date,
                    b.data as body
                FROM note_bodies b
                JOIN note n ON b.note_id = n.ROWID
                ORDER BY n.creation_date DESC
            """).fetchall()
        except Exception:
            try:
                rows = conn.execute("""
                    SELECT ROWID, title, creation_date, modification_date
                    FROM note
                    ORDER BY creation_date DESC
                """).fetchall()
            except Exception as e:
                self.log.warning("Failed to query legacy notes: %s", e)
                return []

        for row in rows:
            ts = from_cocoa(row["creation_date"])
            title = row["title"] or "Untitled"

            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=ts,
                provenance=Provenance(
                    source_db="notes.sqlite",
                    source_table="note",
                    source_row_id=row["ROWID"],
                ),
                text_content=title,
                data={"title": title},
            ))

        return artifacts
