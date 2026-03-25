"""Notification interaction extractor.

Parses two sources:
- knowledgeC.db stream '/notification/usage' for notification interactions (iOS 12+)
- PowerLog PLXPCAgent_Aggregate_Bulletins for notification aggregates (if available)
"""

import sqlite3
from typing import Optional

from extractors._base import ArtifactExtractor
from models.base import BaseArtifact, Provenance
from utils.timestamp import from_cocoa


class NotificationExtractor(ArtifactExtractor):
    """Extract notification interaction data."""

    ARTIFACT_TYPE = "notification"
    SUPPORTED_IOS_VERSIONS = range(12, 19)

    KNOWLEDGEC_DOMAIN = "RootDomain"
    KNOWLEDGEC_PATH = "Library/CoreDuet/Knowledge/knowledgeC.db"

    POWERLOG_PATHS = [
        ("HomeDomain", "Library/BatteryLife/CurrentPowerlog.PLSQL"),
        (
            "HomeDomain",
            "Library/Containers/com.apple.systemgroup.com.apple.powerlog/"
            "Library/BatteryLife/CurrentPowerlog.PLSQL",
        ),
    ]

    BULLETINS_TABLE = "PLXPCAgent_Aggregate_Bulletins"

    def extract(self) -> list[BaseArtifact]:
        if not self.is_supported():
            self.log.debug("iOS %s not supported", self.ios_major)
            return []

        artifacts: list[BaseArtifact] = []

        # Source 1: knowledgeC.db notification stream
        artifacts.extend(self._extract_knowledgec_notifications())

        # Source 2: PowerLog bulletins
        artifacts.extend(self._extract_powerlog_bulletins())

        self.log.info("Extracted %d notification artifacts", len(artifacts))
        return artifacts

    # ------------------------------------------------------------------ #
    # knowledgeC.db notification stream
    # ------------------------------------------------------------------ #

    def _extract_knowledgec_notifications(self) -> list[BaseArtifact]:
        db_path = self.resolve_db_path(self.KNOWLEDGEC_DOMAIN, self.KNOWLEDGEC_PATH)
        if db_path is None:
            self.log.info("knowledgeC.db not found")
            return []

        conn = self.open_db(db_path)
        if conn is None:
            return []

        try:
            return self._query_notification_stream(conn, str(db_path))
        except Exception as e:
            self.log.warning("Failed to extract knowledgeC notifications: %s", e)
            return []
        finally:
            conn.close()

    def _query_notification_stream(
        self, conn: sqlite3.Connection, db_name: str
    ) -> list[BaseArtifact]:
        if not self._table_exists(conn, "ZOBJECT"):
            return []

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
            WHERE ZOBJECT.ZSTREAMNAME = '/notification/usage'
        """

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("Notification stream query failed: %s", e)
            return []

        artifacts: list[BaseArtifact] = []
        for row in rows:
            start_ts = from_cocoa(row["ZSTARTDATE"])
            end_ts = from_cocoa(row["ZENDDATE"])

            bundle_id = row["source_bundle_id"] or row["ZVALUESTRING"]

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
                data={
                    "source": "knowledgec",
                    "stream": "/notification/usage",
                    "value_string": row["ZVALUESTRING"],
                    "value_integer": row["ZVALUEINTEGER"],
                },
            ))

        return artifacts

    # ------------------------------------------------------------------ #
    # PowerLog bulletin aggregates
    # ------------------------------------------------------------------ #

    def _extract_powerlog_bulletins(self) -> list[BaseArtifact]:
        db_path = None
        for domain, rel_path in self.POWERLOG_PATHS:
            db_path = self.resolve_db_path(domain, rel_path)
            if db_path is not None:
                break

        if db_path is None:
            self.log.info("PowerLog database not found for notifications")
            return []

        conn = self.open_db(db_path)
        if conn is None:
            return []

        try:
            return self._query_bulletins(conn, str(db_path))
        except Exception as e:
            self.log.warning("Failed to extract PowerLog bulletins: %s", e)
            return []
        finally:
            conn.close()

    def _query_bulletins(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
        if not self._table_exists(conn, self.BULLETINS_TABLE):
            self.log.info("%s table not found", self.BULLETINS_TABLE)
            return []

        query = f"""
            SELECT *
            FROM {self.BULLETINS_TABLE}
        """

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("Bulletins query failed: %s", e)
            return []

        artifacts: list[BaseArtifact] = []
        for row in rows:
            row_dict = dict(row)

            ts_val = row_dict.get("timestamp") or row_dict.get("Timestamp") or row_dict.get("TIMESTAMP")
            ts = from_cocoa(ts_val) if ts_val is not None else None

            bundle_id = (
                row_dict.get("BulletinBundleID")
                or row_dict.get("BundleID")
                or row_dict.get("bundleID")
                or ""
            )
            count = row_dict.get("PostCount") or row_dict.get("Count") or 0

            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=ts,
                bundle_id=bundle_id if bundle_id else None,
                provenance=Provenance(
                    source_db=db_name,
                    source_table=self.BULLETINS_TABLE,
                    source_row_id=row_dict.get("ROWID"),
                ),
                data={
                    "source": "powerlog",
                    "bundle_id": bundle_id,
                    "count": count,
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
