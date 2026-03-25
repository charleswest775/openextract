"""Calendar events extractor.

Parses Calendar.sqlitedb to extract calendar events including summaries,
descriptions, start/end times, and associated calendar names.
"""

import sqlite3
from typing import Optional

from extractors._base import ArtifactExtractor
from models.base import BaseArtifact, Provenance
from utils.timestamp import from_cocoa


class CalendarExtractor(ArtifactExtractor):
    """Extract calendar events from Calendar.sqlitedb."""

    ARTIFACT_TYPE = "calendar"
    SUPPORTED_IOS_VERSIONS = range(8, 19)

    DB_DOMAIN = "HomeDomain"
    DB_RELATIVE_PATH = "Library/Calendar/Calendar.sqlitedb"

    def extract(self) -> list[BaseArtifact]:
        if not self.is_supported():
            self.log.debug("iOS %s not supported", self.ios_major)
            return []

        db_path = self.resolve_db_path(self.DB_DOMAIN, self.DB_RELATIVE_PATH)
        if db_path is None:
            self.log.info("Calendar.sqlitedb not found")
            return []

        conn = self.open_db(db_path)
        if conn is None:
            return []

        try:
            return self._extract_events(conn, str(db_path))
        except Exception as e:
            self.log.warning("Failed to extract calendar events: %s", e)
            return []
        finally:
            conn.close()

    def _extract_events(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
        artifacts: list[BaseArtifact] = []

        tables = self._get_tables(conn)
        if "CalendarItem" not in tables:
            self.log.warning("CalendarItem table not found")
            return []

        has_calendar_table = "Calendar" in tables

        if has_calendar_table:
            query = """
                SELECT
                    ci.ROWID AS item_rowid,
                    ci.summary,
                    ci.description,
                    ci.start_date,
                    ci.end_date,
                    ci.all_day,
                    ci.calendar_id,
                    c.title AS calendar_title
                FROM CalendarItem ci
                LEFT JOIN Calendar c ON ci.calendar_id = c.ROWID
                ORDER BY ci.start_date DESC
            """
        else:
            query = """
                SELECT
                    ci.ROWID AS item_rowid,
                    ci.summary,
                    ci.description,
                    ci.start_date,
                    ci.end_date,
                    ci.all_day,
                    ci.calendar_id,
                    NULL AS calendar_title
                FROM CalendarItem ci
                ORDER BY ci.start_date DESC
            """

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("Calendar query failed: %s", e)
            return []

        for row in rows:
            start_ts = from_cocoa(row["start_date"])
            end_ts = from_cocoa(row["end_date"])
            summary = row["summary"] or ""
            description = row["description"] or ""

            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=start_ts,
                timestamp_end=end_ts,
                provenance=Provenance(
                    source_db=db_name,
                    source_table="CalendarItem",
                    source_row_id=row["item_rowid"],
                ),
                text_content=summary,
                data={
                    "summary": summary,
                    "description": description,
                    "all_day": bool(row["all_day"]),
                    "calendar_title": row["calendar_title"] or "",
                },
            ))

        self.log.info("Extracted %d calendar events", len(artifacts))
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
