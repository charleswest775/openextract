"""App install/usage extractor.

Parses knowledgeC.db for:
- '/app/install' stream: app install and delete events (iOS 11+)
- '/app/inFocus' stream: which apps are used and for how long (iOS 11+)
"""

import sqlite3
from typing import Optional

from extractors._base import ArtifactExtractor
from models.base import BaseArtifact, Provenance
from utils.timestamp import from_cocoa


class AppsExtractor(ArtifactExtractor):
    """Extract app install events and usage data from knowledgeC.db."""

    ARTIFACT_TYPE = "app"
    SUPPORTED_IOS_VERSIONS = range(11, 19)

    KNOWLEDGEC_DOMAIN = "RootDomain"
    KNOWLEDGEC_PATH = "Library/CoreDuet/Knowledge/knowledgeC.db"

    def extract(self) -> list[BaseArtifact]:
        if not self.is_supported():
            self.log.debug("iOS %s not supported", self.ios_major)
            return []

        db_path = self.resolve_db_path(self.KNOWLEDGEC_DOMAIN, self.KNOWLEDGEC_PATH)
        if db_path is None:
            self.log.info("knowledgeC.db not found")
            return []

        conn = self.open_db(db_path)
        if conn is None:
            return []

        try:
            artifacts: list[BaseArtifact] = []
            db_name = str(db_path)

            if not self._table_exists(conn, "ZOBJECT"):
                self.log.warning("ZOBJECT table not found in knowledgeC.db")
                return []

            artifacts.extend(self._extract_app_installs(conn, db_name))
            artifacts.extend(self._extract_app_infocus(conn, db_name))

            self.log.info("Extracted %d app artifacts", len(artifacts))
            return artifacts
        except Exception as e:
            self.log.warning("Failed to extract app data: %s", e)
            return []
        finally:
            conn.close()

    def _extract_app_installs(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
        query = """
            SELECT
                ZOBJECT.Z_PK,
                ZOBJECT.ZSTARTDATE,
                ZOBJECT.ZENDDATE,
                ZOBJECT.ZVALUESTRING,
                ZOBJECT.ZVALUEINTEGER,
                ZSOURCE.ZBUNDLEID AS source_bundle_id
            FROM ZOBJECT
            LEFT JOIN ZSOURCE ON ZOBJECT.ZSOURCE = ZSOURCE.Z_PK
            WHERE ZOBJECT.ZSTREAMNAME = '/app/install'
        """

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("App install query failed: %s", e)
            return []

        artifacts: list[BaseArtifact] = []
        for row in rows:
            start_ts = from_cocoa(row["ZSTARTDATE"])
            end_ts = from_cocoa(row["ZENDDATE"])

            bundle_id = row["source_bundle_id"] or row["ZVALUESTRING"] or ""

            # ZVALUEINTEGER often indicates install (1) vs uninstall (0)
            action = "install" if row["ZVALUEINTEGER"] else "uninstall"

            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=start_ts,
                timestamp_end=end_ts,
                bundle_id=bundle_id if bundle_id else None,
                provenance=Provenance(
                    source_db=db_name,
                    source_table="ZOBJECT",
                    source_row_id=row["Z_PK"],
                ),
                data={
                    "stream": "/app/install",
                    "action": action,
                    "bundle_id": bundle_id,
                },
            ))

        return artifacts

    def _extract_app_infocus(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
        query = """
            SELECT
                ZOBJECT.Z_PK,
                ZOBJECT.ZSTARTDATE,
                ZOBJECT.ZENDDATE,
                ZOBJECT.ZVALUESTRING,
                ZOBJECT.ZVALUEINTEGER,
                ZSOURCE.ZBUNDLEID AS source_bundle_id
            FROM ZOBJECT
            LEFT JOIN ZSOURCE ON ZOBJECT.ZSOURCE = ZSOURCE.Z_PK
            WHERE ZOBJECT.ZSTREAMNAME = '/app/inFocus'
        """

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("App inFocus query failed: %s", e)
            return []

        artifacts: list[BaseArtifact] = []
        for row in rows:
            start_ts = from_cocoa(row["ZSTARTDATE"])
            end_ts = from_cocoa(row["ZENDDATE"])

            bundle_id = row["source_bundle_id"] or row["ZVALUESTRING"] or ""

            # Calculate duration if both timestamps are available
            duration = None
            if row["ZSTARTDATE"] is not None and row["ZENDDATE"] is not None:
                duration = row["ZENDDATE"] - row["ZSTARTDATE"]

            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=start_ts,
                timestamp_end=end_ts,
                bundle_id=bundle_id if bundle_id else None,
                provenance=Provenance(
                    source_db=db_name,
                    source_table="ZOBJECT",
                    source_row_id=row["Z_PK"],
                ),
                data={
                    "stream": "/app/inFocus",
                    "bundle_id": bundle_id,
                    "duration_seconds": duration,
                },
            ))

        return artifacts

    @staticmethod
    def _table_exists(conn: sqlite3.Connection, table_name: str) -> bool:
        try:
            cur = conn.execute(
                "SELECT 1 FROM sqlite_master WHERE type='table' AND name=? LIMIT 1",
                (table_name,),
            )
            return cur.fetchone() is not None
        except sqlite3.Error:
            return False
