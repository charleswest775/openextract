"""WiFi connection and known networks extractor.

Parses two sources:
- knowledgeC.db stream '/device/isWiFiConnected' for WiFi state changes
- com.apple.wifi.plist for known/saved WiFi networks
"""

import plistlib
import sqlite3
from pathlib import Path
from typing import Any, Optional

from extractors._base import ArtifactExtractor
from models.base import BaseArtifact, Provenance
from utils.timestamp import from_cocoa


class WiFiExtractor(ArtifactExtractor):
    """Extract WiFi connection data and known network lists."""

    ARTIFACT_TYPE = "wifi"
    SUPPORTED_IOS_VERSIONS = range(8, 19)

    KNOWLEDGEC_DOMAIN = "RootDomain"
    KNOWLEDGEC_PATH = "Library/CoreDuet/Knowledge/knowledgeC.db"

    WIFI_PLIST_DOMAIN = "SystemPreferencesDomain"
    WIFI_PLIST_PATH = "Library/Preferences/com.apple.wifi.plist"

    def extract(self) -> list[BaseArtifact]:
        if not self.is_supported():
            self.log.debug("iOS %s not supported", self.ios_major)
            return []

        artifacts: list[BaseArtifact] = []

        # Source 1: knowledgeC.db WiFi state (iOS 11+)
        if self.ios_major >= 11:
            artifacts.extend(self._extract_knowledgec_wifi())

        # Source 2: WiFi plist known networks
        artifacts.extend(self._extract_wifi_plist())

        self.log.info("Extracted %d wifi artifacts", len(artifacts))
        return artifacts

    # ------------------------------------------------------------------ #
    # knowledgeC.db WiFi state
    # ------------------------------------------------------------------ #

    def _extract_knowledgec_wifi(self) -> list[BaseArtifact]:
        db_path = self.resolve_db_path(self.KNOWLEDGEC_DOMAIN, self.KNOWLEDGEC_PATH)
        if db_path is None:
            self.log.info("knowledgeC.db not found")
            return []

        conn = self.open_db(db_path)
        if conn is None:
            return []

        try:
            return self._query_wifi_stream(conn, str(db_path))
        except Exception as e:
            self.log.warning("Failed to extract knowledgeC WiFi data: %s", e)
            return []
        finally:
            conn.close()

    def _query_wifi_stream(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
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
            WHERE ZOBJECT.ZSTREAMNAME = '/device/isWiFiConnected'
        """

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("WiFi stream query failed: %s", e)
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
                    "stream": "/device/isWiFiConnected",
                    "is_connected": is_connected,
                    "network_name": row["ZVALUESTRING"],
                },
            ))

        return artifacts

    # ------------------------------------------------------------------ #
    # com.apple.wifi.plist known networks
    # ------------------------------------------------------------------ #

    def _extract_wifi_plist(self) -> list[BaseArtifact]:
        plist_path = self.resolve_db_path(self.WIFI_PLIST_DOMAIN, self.WIFI_PLIST_PATH)
        if plist_path is None:
            self.log.info("com.apple.wifi.plist not found")
            return []

        try:
            with open(plist_path, "rb") as f:
                plist_data = plistlib.load(f)
        except Exception as e:
            self.log.warning("Failed to parse WiFi plist: %s", e)
            return []

        return self._parse_known_networks(plist_data, str(plist_path))

    def _parse_known_networks(self, plist_data: dict, plist_name: str) -> list[BaseArtifact]:
        artifacts: list[BaseArtifact] = []

        # Known networks are stored under various keys depending on iOS version
        known_networks = plist_data.get("List of known networks", [])
        if not isinstance(known_networks, list):
            known_networks = []

        for idx, network in enumerate(known_networks):
            if not isinstance(network, dict):
                continue

            ssid = network.get("SSID_STR", "")
            last_joined = network.get("lastJoined")
            last_auto_joined = network.get("lastAutoJoined")

            # Try to parse the timestamp if it's a datetime
            ts = None
            if last_joined is not None:
                from datetime import datetime
                if isinstance(last_joined, datetime):
                    ts = last_joined

            data: dict[str, Any] = {
                "source": "wifi_plist",
                "ssid": ssid,
                "security_mode": network.get("SecurityMode", ""),
                "was_hidden": network.get("HIDDEN_NETWORK", False),
            }
            if last_auto_joined is not None:
                data["last_auto_joined"] = str(last_auto_joined)

            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=ts,
                provenance=Provenance(
                    source_db=plist_name,
                    source_table="List of known networks",
                    source_row_id=idx,
                ),
                text_content=ssid,
                data=data,
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
