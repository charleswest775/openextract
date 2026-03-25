"""Power and battery usage extractor.

Parses CurrentPowerlog.PLSQL for battery level, charging state, screen state,
app lifecycle, and timezone change events.
"""

import sqlite3
from typing import Optional

from extractors._base import ArtifactExtractor
from models.base import BaseArtifact, Provenance
from utils.timestamp import from_cocoa


class PowerExtractor(ArtifactExtractor):
    """Extract power/battery data from CurrentPowerlog.PLSQL."""

    ARTIFACT_TYPE = "power"
    SUPPORTED_IOS_VERSIONS = range(9, 19)

    # The PowerLog database location varies; try multiple paths
    POWERLOG_PATHS = [
        ("HomeDomain", "Library/BatteryLife/CurrentPowerlog.PLSQL"),
        (
            "HomeDomain",
            "Library/Containers/com.apple.systemgroup.com.apple.powerlog/"
            "Library/BatteryLife/CurrentPowerlog.PLSQL",
        ),
    ]

    # Tables to extract, each with its column mappings
    BATTERY_TABLE = "PLBatteryAgent_EventPoint_BatteryUI"
    SCREEN_TABLE = "PLScreenStateAgent_EventPoint_ScreenState"
    APP_TABLE = "PLApplicationAgent_EventPoint_Application"
    TIMEZONE_TABLE = "PLConfigAgent_EventPoint_TimeZone"

    def extract(self) -> list[BaseArtifact]:
        if not self.is_supported():
            self.log.debug("iOS %s not supported", self.ios_major)
            return []

        # Try multiple paths to find the PowerLog database
        db_path = None
        for domain, rel_path in self.POWERLOG_PATHS:
            db_path = self.resolve_db_path(domain, rel_path)
            if db_path is not None:
                break

        if db_path is None:
            self.log.info("CurrentPowerlog.PLSQL not found")
            return []

        conn = self.open_db(db_path)
        if conn is None:
            return []

        try:
            artifacts: list[BaseArtifact] = []
            db_name = str(db_path)

            artifacts.extend(self._extract_battery(conn, db_name))
            artifacts.extend(self._extract_screen_state(conn, db_name))
            artifacts.extend(self._extract_app_events(conn, db_name))
            artifacts.extend(self._extract_timezone(conn, db_name))

            self.log.info("Extracted %d power artifacts", len(artifacts))
            return artifacts
        except Exception as e:
            self.log.warning("Failed to extract power data: %s", e)
            return []
        finally:
            conn.close()

    def _extract_battery(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
        if not self._table_exists(conn, self.BATTERY_TABLE):
            return []

        query = f"""
            SELECT
                ROWID,
                timestamp AS TIMESTAMP,
                Level,
                IsCharging
            FROM {self.BATTERY_TABLE}
            ORDER BY timestamp
        """

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("Battery query failed: %s", e)
            return []

        artifacts: list[BaseArtifact] = []
        for row in rows:
            ts = from_cocoa(row["TIMESTAMP"])
            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=ts,
                provenance=Provenance(
                    source_db=db_name,
                    source_table=self.BATTERY_TABLE,
                    source_row_id=row["ROWID"],
                ),
                data={
                    "event": "battery",
                    "level": row["Level"],
                    "is_charging": bool(row["IsCharging"]) if row["IsCharging"] is not None else None,
                },
            ))
        return artifacts

    def _extract_screen_state(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
        if not self._table_exists(conn, self.SCREEN_TABLE):
            return []

        query = f"""
            SELECT
                ROWID,
                timestamp AS TIMESTAMP,
                OffReason
            FROM {self.SCREEN_TABLE}
            ORDER BY timestamp
        """

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("Screen state query failed: %s", e)
            return []

        artifacts: list[BaseArtifact] = []
        for row in rows:
            ts = from_cocoa(row["TIMESTAMP"])
            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=ts,
                provenance=Provenance(
                    source_db=db_name,
                    source_table=self.SCREEN_TABLE,
                    source_row_id=row["ROWID"],
                ),
                data={
                    "event": "screen_state",
                    "off_reason": row["OffReason"],
                },
            ))
        return artifacts

    def _extract_app_events(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
        if not self._table_exists(conn, self.APP_TABLE):
            return []

        query = f"""
            SELECT
                ROWID,
                timestamp AS TIMESTAMP,
                BundleID
            FROM {self.APP_TABLE}
            ORDER BY timestamp
        """

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("App events query failed: %s", e)
            return []

        artifacts: list[BaseArtifact] = []
        for row in rows:
            ts = from_cocoa(row["TIMESTAMP"])
            bundle_id = row["BundleID"] or ""
            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=ts,
                bundle_id=bundle_id,
                provenance=Provenance(
                    source_db=db_name,
                    source_table=self.APP_TABLE,
                    source_row_id=row["ROWID"],
                ),
                data={
                    "event": "app_lifecycle",
                    "bundle_id": bundle_id,
                },
            ))
        return artifacts

    def _extract_timezone(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
        if not self._table_exists(conn, self.TIMEZONE_TABLE):
            return []

        query = f"""
            SELECT
                ROWID,
                timestamp AS TIMESTAMP,
                TimeZoneName
            FROM {self.TIMEZONE_TABLE}
            ORDER BY timestamp
        """

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("Timezone query failed: %s", e)
            return []

        artifacts: list[BaseArtifact] = []
        for row in rows:
            ts = from_cocoa(row["TIMESTAMP"])
            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=ts,
                provenance=Provenance(
                    source_db=db_name,
                    source_table=self.TIMEZONE_TABLE,
                    source_row_id=row["ROWID"],
                ),
                data={
                    "event": "timezone_change",
                    "timezone_name": row["TimeZoneName"],
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
