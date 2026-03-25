"""Safari browsing history extractor.

Parses Safari's History.db to extract browsing history including URLs,
page titles, visit timestamps, and visit counts.
"""

import sqlite3
from typing import Optional

from extractors._base import ArtifactExtractor
from models.base import BaseArtifact, Provenance
from utils.timestamp import from_cocoa


class SafariExtractor(ArtifactExtractor):
    """Extract Safari browsing history from History.db."""

    ARTIFACT_TYPE = "safari"
    SUPPORTED_IOS_VERSIONS = range(8, 19)

    DB_DOMAIN = "HomeDomain"
    DB_RELATIVE_PATH = "Library/Safari/History.db"

    def extract(self) -> list[BaseArtifact]:
        if not self.is_supported():
            self.log.debug("iOS %s not supported", self.ios_major)
            return []

        db_path = self.resolve_db_path(self.DB_DOMAIN, self.DB_RELATIVE_PATH)
        if db_path is None:
            self.log.info("Safari History.db not found")
            return []

        conn = self.open_db(db_path)
        if conn is None:
            return []

        try:
            return self._extract_history(conn, str(db_path))
        except Exception as e:
            self.log.warning("Failed to extract Safari history: %s", e)
            return []
        finally:
            conn.close()

    def _extract_history(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
        artifacts: list[BaseArtifact] = []

        # Check that required tables exist
        tables = self._get_tables(conn)
        if "history_items" not in tables or "history_visits" not in tables:
            self.log.warning("Required Safari history tables not found")
            return []

        query = """
            SELECT
                hv.ROWID AS visit_rowid,
                hi.url,
                hi.domain_expansion,
                hi.visit_count,
                hv.visit_time,
                hv.title
            FROM history_visits hv
            JOIN history_items hi ON hv.history_item = hi.ROWID
            ORDER BY hv.visit_time DESC
        """

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("Safari history query failed: %s", e)
            return []

        for row in rows:
            ts = from_cocoa(row["visit_time"])
            title = row["title"] or ""
            url = row["url"] or ""

            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=ts,
                provenance=Provenance(
                    source_db=db_name,
                    source_table="history_visits",
                    source_row_id=row["visit_rowid"],
                ),
                text_content=title,
                data={
                    "url": url,
                    "domain": row["domain_expansion"] or "",
                    "visit_count": row["visit_count"] or 0,
                    "title": title,
                },
            ))

        self.log.info("Extracted %d Safari history entries", len(artifacts))
        return artifacts

    @staticmethod
    def _get_tables(conn: sqlite3.Connection) -> set[str]:
        try:
            rows = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'"
            ).fetchall()
            return {row["name"] for row in rows}
        except sqlite3.Error:
            return set()
