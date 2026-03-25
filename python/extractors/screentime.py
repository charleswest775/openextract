"""Screen Time and device usage extractor.

Parses two database sources:
- knowledgeC.db: app focus, activity, device lock state, display, battery streams (iOS 11+)
- RMAdminStore-Local.sqlite: managed screen time usage data (iOS 12+)
"""

import sqlite3
from typing import Optional

from extractors._base import ArtifactExtractor
from models.base import BaseArtifact, Provenance
from utils.timestamp import from_cocoa


class ScreenTimeExtractor(ArtifactExtractor):
    """Extract Screen Time and device usage data."""

    ARTIFACT_TYPE = "screentime"
    SUPPORTED_IOS_VERSIONS = range(11, 19)

    KNOWLEDGEC_DOMAIN = "RootDomain"
    KNOWLEDGEC_PATH = "Library/CoreDuet/Knowledge/knowledgeC.db"

    RMADMIN_DOMAIN = "HomeDomain"
    RMADMIN_PATH = "Library/Application Support/com.apple.remotemanagementd/RMAdminStore-Local.sqlite"

    # Key knowledgeC streams to extract
    KNOWLEDGEC_STREAMS = [
        "/app/inFocus",
        "/app/activity",
        "/device/isLocked",
        "/display/isBacklit",
        "/device/isPluggedIn",
        "/device/batteryPercentage",
    ]

    def extract(self) -> list[BaseArtifact]:
        if not self.is_supported():
            self.log.debug("iOS %s not supported", self.ios_major)
            return []

        artifacts: list[BaseArtifact] = []

        # Source 1: knowledgeC.db streams (iOS 11+)
        artifacts.extend(self._extract_knowledgec())

        # Source 2: RMAdminStore (iOS 12+)
        if self.ios_major >= 12:
            artifacts.extend(self._extract_rmadmin())

        self.log.info("Extracted %d screen time artifacts", len(artifacts))
        return artifacts

    # ------------------------------------------------------------------ #
    # knowledgeC.db streams
    # ------------------------------------------------------------------ #

    def _extract_knowledgec(self) -> list[BaseArtifact]:
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

            for stream in self.KNOWLEDGEC_STREAMS:
                artifacts.extend(self._extract_stream(conn, db_name, stream))

            return artifacts
        except Exception as e:
            self.log.warning("Failed to extract knowledgeC.db: %s", e)
            return []
        finally:
            conn.close()

    def _extract_stream(
        self, conn: sqlite3.Connection, db_name: str, stream_name: str
    ) -> list[BaseArtifact]:
        query = """
            SELECT
                ZOBJECT.Z_PK,
                ZOBJECT.ZSTARTDATE,
                ZOBJECT.ZENDDATE,
                ZOBJECT.ZVALUESTRING,
                ZOBJECT.ZVALUEINTEGER,
                ZOBJECT.ZVALUEDOUBLE,
                ZSTRUCTUREDMETADATA.Z_PK AS meta_pk,
                ZSTRUCTUREDMETADATA.Z_DKAPPLICATIONACTIVITYMETADATAKEY__ACTIVITYTYPE AS activity_type,
                ZSTRUCTUREDMETADATA.Z_DKAPPLICATIONACTIVITYMETADATAKEY__TITLE AS activity_title,
                ZSOURCE.ZBUNDLEID AS source_bundle_id
            FROM ZOBJECT
            LEFT JOIN ZSTRUCTUREDMETADATA
                ON ZOBJECT.ZSTRUCTUREDMETADATA = ZSTRUCTUREDMETADATA.Z_PK
            LEFT JOIN ZSOURCE
                ON ZOBJECT.ZSOURCE = ZSOURCE.Z_PK
            WHERE ZOBJECT.ZSTREAMNAME = ?
        """

        try:
            rows = conn.execute(query, (stream_name,)).fetchall()
        except sqlite3.Error as e:
            self.log.warning("Stream query failed for %s: %s", stream_name, e)
            return []

        artifacts: list[BaseArtifact] = []
        for row in rows:
            start_ts = from_cocoa(row["ZSTARTDATE"])
            end_ts = from_cocoa(row["ZENDDATE"])

            bundle_id = row["source_bundle_id"] or row["ZVALUESTRING"]

            data: dict = {
                "stream": stream_name,
            }

            # Include numeric values when present
            if row["ZVALUEINTEGER"] is not None:
                data["value_integer"] = row["ZVALUEINTEGER"]
            if row["ZVALUEDOUBLE"] is not None:
                data["value_double"] = row["ZVALUEDOUBLE"]
            if row["ZVALUESTRING"]:
                data["value_string"] = row["ZVALUESTRING"]
            if row["activity_type"]:
                data["activity_type"] = row["activity_type"]
            if row["activity_title"]:
                data["activity_title"] = row["activity_title"]

            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=start_ts,
                timestamp_end=end_ts,
                bundle_id=bundle_id if isinstance(bundle_id, str) else None,
                provenance=Provenance(
                    source_db=db_name,
                    source_table="ZOBJECT",
                    source_row_id=row["Z_PK"],
                ),
                data=data,
            ))

        return artifacts

    # ------------------------------------------------------------------ #
    # RMAdminStore-Local.sqlite
    # ------------------------------------------------------------------ #

    def _extract_rmadmin(self) -> list[BaseArtifact]:
        db_path = self.resolve_db_path(self.RMADMIN_DOMAIN, self.RMADMIN_PATH)
        if db_path is None:
            self.log.info("RMAdminStore-Local.sqlite not found")
            return []

        conn = self.open_db(db_path)
        if conn is None:
            return []

        try:
            return self._extract_usage_time(conn, str(db_path))
        except Exception as e:
            self.log.warning("Failed to extract RMAdminStore: %s", e)
            return []
        finally:
            conn.close()

    def _extract_usage_time(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
        if not self._table_exists(conn, "ZUSAGETIMEDITEM"):
            self.log.info("ZUSAGETIMEDITEM table not found")
            return []

        query = """
            SELECT
                Z_PK,
                ZBUNDLEIDENTIFIER,
                ZTOTALTIME
            FROM ZUSAGETIMEDITEM
        """

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("Usage time query failed: %s", e)
            return []

        artifacts: list[BaseArtifact] = []
        for row in rows:
            bundle_id = row["ZBUNDLEIDENTIFIER"] or ""

            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                bundle_id=bundle_id,
                provenance=Provenance(
                    source_db=db_name,
                    source_table="ZUSAGETIMEDITEM",
                    source_row_id=row["Z_PK"],
                ),
                data={
                    "source": "rmadmin",
                    "bundle_identifier": bundle_id,
                    "total_time_seconds": row["ZTOTALTIME"],
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
