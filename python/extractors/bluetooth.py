"""Bluetooth connection extractor.

Parses two sources:
- knowledgeC.db stream '/bluetooth/isConnected' for BT state changes (iOS 12+)
- PowerLog PLBluetoothAgent_EventPoint_BTDevice for device events (if available)
"""

import sqlite3
from typing import Optional

from extractors._base import ArtifactExtractor
from models.base import BaseArtifact, Provenance
from utils.timestamp import from_cocoa


class BluetoothExtractor(ArtifactExtractor):
    """Extract Bluetooth connection data."""

    ARTIFACT_TYPE = "bluetooth"
    SUPPORTED_IOS_VERSIONS = range(11, 19)

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

    BT_DEVICE_TABLE = "PLBluetoothAgent_EventPoint_BTDevice"

    def extract(self) -> list[BaseArtifact]:
        if not self.is_supported():
            self.log.debug("iOS %s not supported", self.ios_major)
            return []

        artifacts: list[BaseArtifact] = []

        # Source 1: knowledgeC.db Bluetooth state (iOS 12+)
        if self.ios_major >= 12:
            artifacts.extend(self._extract_knowledgec_bt())

        # Source 2: PowerLog Bluetooth device events
        artifacts.extend(self._extract_powerlog_bt())

        self.log.info("Extracted %d bluetooth artifacts", len(artifacts))
        return artifacts

    # ------------------------------------------------------------------ #
    # knowledgeC.db Bluetooth stream
    # ------------------------------------------------------------------ #

    def _extract_knowledgec_bt(self) -> list[BaseArtifact]:
        db_path = self.resolve_db_path(self.KNOWLEDGEC_DOMAIN, self.KNOWLEDGEC_PATH)
        if db_path is None:
            self.log.info("knowledgeC.db not found")
            return []

        conn = self.open_db(db_path)
        if conn is None:
            return []

        try:
            return self._query_bt_stream(conn, str(db_path))
        except Exception as e:
            self.log.warning("Failed to extract knowledgeC Bluetooth: %s", e)
            return []
        finally:
            conn.close()

    def _query_bt_stream(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
        if not self._table_exists(conn, "ZOBJECT"):
            return []

        query = """
            SELECT
                ZOBJECT.Z_PK,
                ZOBJECT.ZSTARTDATE,
                ZOBJECT.ZENDDATE,
                ZOBJECT.ZVALUEINTEGER,
                ZOBJECT.ZVALUESTRING
            FROM ZOBJECT
            WHERE ZOBJECT.ZSTREAMNAME = '/bluetooth/isConnected'
        """

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("Bluetooth stream query failed: %s", e)
            return []

        artifacts: list[BaseArtifact] = []
        for row in rows:
            start_ts = from_cocoa(row["ZSTARTDATE"])
            end_ts = from_cocoa(row["ZENDDATE"])

            is_connected = bool(row["ZVALUEINTEGER"]) if row["ZVALUEINTEGER"] is not None else None

            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=start_ts,
                timestamp_end=end_ts,
                provenance=Provenance(
                    source_db=db_name,
                    source_table="ZOBJECT",
                    source_row_id=row["Z_PK"],
                ),
                data={
                    "source": "knowledgec",
                    "stream": "/bluetooth/isConnected",
                    "is_connected": is_connected,
                    "device_name": row["ZVALUESTRING"],
                },
            ))

        return artifacts

    # ------------------------------------------------------------------ #
    # PowerLog Bluetooth device events
    # ------------------------------------------------------------------ #

    def _extract_powerlog_bt(self) -> list[BaseArtifact]:
        db_path = None
        for domain, rel_path in self.POWERLOG_PATHS:
            db_path = self.resolve_db_path(domain, rel_path)
            if db_path is not None:
                break

        if db_path is None:
            self.log.info("PowerLog database not found for Bluetooth")
            return []

        conn = self.open_db(db_path)
        if conn is None:
            return []

        try:
            return self._query_bt_device(conn, str(db_path))
        except Exception as e:
            self.log.warning("Failed to extract PowerLog Bluetooth: %s", e)
            return []
        finally:
            conn.close()

    def _query_bt_device(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
        if not self._table_exists(conn, self.BT_DEVICE_TABLE):
            self.log.info("%s table not found", self.BT_DEVICE_TABLE)
            return []

        # Column names may vary; query what we can
        query = f"""
            SELECT *
            FROM {self.BT_DEVICE_TABLE}
        """

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("BT device query failed: %s", e)
            return []

        # Get column names from the cursor description
        artifacts: list[BaseArtifact] = []
        for row in rows:
            row_dict = dict(row)
            # Look for timestamp column (case-insensitive)
            ts_val = row_dict.get("timestamp") or row_dict.get("Timestamp") or row_dict.get("TIMESTAMP")
            ts = from_cocoa(ts_val) if ts_val is not None else None

            # Look for device name or address
            device_name = (
                row_dict.get("DeviceName")
                or row_dict.get("deviceName")
                or row_dict.get("Name")
                or ""
            )
            device_address = (
                row_dict.get("DeviceAddress")
                or row_dict.get("deviceAddress")
                or row_dict.get("Address")
                or ""
            )

            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=ts,
                provenance=Provenance(
                    source_db=db_name,
                    source_table=self.BT_DEVICE_TABLE,
                    source_row_id=row_dict.get("ROWID"),
                ),
                data={
                    "source": "powerlog",
                    "device_name": device_name,
                    "device_address": device_address,
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
