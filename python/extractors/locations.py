"""Location data extractor.

The most complex extractor. Parses multiple databases for location artifacts:
- Local.sqlite: learned locations of interest and visits (iOS 10+)
- cache_encryptedA.db: cell tower and WiFi location harvests (encrypted backups only)
- knowledgeC.db: inferred motion and microlocation visit streams (iOS 11+)
"""

import sqlite3
from typing import Optional

from extractors._base import ArtifactExtractor
from models.base import BaseArtifact, Provenance
from utils.timestamp import from_cocoa


class LocationExtractor(ArtifactExtractor):
    """Extract location data from multiple iOS databases."""

    ARTIFACT_TYPE = "location"
    SUPPORTED_IOS_VERSIONS = range(8, 19)

    # Database paths
    LOCAL_SQLITE_DOMAIN = "HomeDomain"
    LOCAL_SQLITE_PATH = "Library/Caches/com.apple.routined/Local.sqlite"

    CACHE_ENCRYPTED_DOMAIN = "RootDomain"
    CACHE_ENCRYPTED_PATH = "Library/Caches/locationd/cache_encryptedA.db"

    KNOWLEDGEC_DOMAIN = "RootDomain"
    KNOWLEDGEC_PATH = "Library/CoreDuet/Knowledge/knowledgeC.db"

    def extract(self) -> list[BaseArtifact]:
        if not self.is_supported():
            self.log.debug("iOS %s not supported", self.ios_major)
            return []

        artifacts: list[BaseArtifact] = []

        # Source 1: Local.sqlite (iOS 10+)
        if self.ios_major >= 10:
            artifacts.extend(self._extract_local_sqlite())

        # Source 2: cache_encryptedA.db (encrypted backups only)
        artifacts.extend(self._extract_cache_encrypted())

        # Source 3: knowledgeC.db location streams (iOS 11+)
        if self.ios_major >= 11:
            artifacts.extend(self._extract_knowledgec_locations())

        self.log.info("Extracted %d location artifacts total", len(artifacts))
        return artifacts

    # ------------------------------------------------------------------ #
    # Local.sqlite — learned places and visits
    # ------------------------------------------------------------------ #

    def _extract_local_sqlite(self) -> list[BaseArtifact]:
        db_path = self.resolve_db_path(self.LOCAL_SQLITE_DOMAIN, self.LOCAL_SQLITE_PATH)
        if db_path is None:
            self.log.info("Local.sqlite not found")
            return []

        conn = self.open_db(db_path)
        if conn is None:
            return []

        try:
            artifacts: list[BaseArtifact] = []
            artifacts.extend(self._extract_learned_locations(conn, str(db_path)))
            artifacts.extend(self._extract_visits(conn, str(db_path)))
            return artifacts
        except Exception as e:
            self.log.warning("Failed to extract Local.sqlite: %s", e)
            return []
        finally:
            conn.close()

    def _extract_learned_locations(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
        if not self._table_exists(conn, "ZRTLEARNEDLOCATIONOFINTERESTMO"):
            return []

        query = """
            SELECT
                Z_PK,
                ZLATITUDE,
                ZLONGITUDE,
                ZRADIUS,
                ZPLACETYPE,
                ZCREATIONDATE
            FROM ZRTLEARNEDLOCATIONOFINTERESTMO
        """

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("Learned locations query failed: %s", e)
            return []

        artifacts: list[BaseArtifact] = []
        for row in rows:
            ts = from_cocoa(row["ZCREATIONDATE"])
            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=ts,
                latitude=row["ZLATITUDE"],
                longitude=row["ZLONGITUDE"],
                provenance=Provenance(
                    source_db=db_name,
                    source_table="ZRTLEARNEDLOCATIONOFINTERESTMO",
                    source_row_id=row["Z_PK"],
                ),
                data={
                    "source": "learned_location",
                    "radius": row["ZRADIUS"],
                    "place_type": row["ZPLACETYPE"],
                },
            ))
        return artifacts

    def _extract_visits(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
        if not self._table_exists(conn, "ZRTVISITMO"):
            return []

        query = """
            SELECT
                Z_PK,
                ZLATITUDE,
                ZLONGITUDE,
                ZENTRYDATE,
                ZEXITDATE,
                ZCONFIDENCE
            FROM ZRTVISITMO
        """

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("Visits query failed: %s", e)
            return []

        artifacts: list[BaseArtifact] = []
        for row in rows:
            entry_ts = from_cocoa(row["ZENTRYDATE"])
            exit_ts = from_cocoa(row["ZEXITDATE"])
            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=entry_ts,
                timestamp_end=exit_ts,
                latitude=row["ZLATITUDE"],
                longitude=row["ZLONGITUDE"],
                provenance=Provenance(
                    source_db=db_name,
                    source_table="ZRTVISITMO",
                    source_row_id=row["Z_PK"],
                ),
                data={
                    "source": "visit",
                    "confidence": row["ZCONFIDENCE"],
                },
            ))
        return artifacts

    # ------------------------------------------------------------------ #
    # cache_encryptedA.db — cell and WiFi location harvests
    # ------------------------------------------------------------------ #

    def _extract_cache_encrypted(self) -> list[BaseArtifact]:
        db_path = self.resolve_db_path(self.CACHE_ENCRYPTED_DOMAIN, self.CACHE_ENCRYPTED_PATH)
        if db_path is None:
            self.log.info("cache_encryptedA.db not found (encrypted backups only)")
            return []

        conn = self.open_db(db_path)
        if conn is None:
            return []

        try:
            artifacts: list[BaseArtifact] = []
            artifacts.extend(self._extract_cell_locations(conn, str(db_path)))
            artifacts.extend(self._extract_wifi_harvests(conn, str(db_path)))
            return artifacts
        except Exception as e:
            self.log.warning("Failed to extract cache_encryptedA.db: %s", e)
            return []
        finally:
            conn.close()

    def _extract_cell_locations(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
        if not self._table_exists(conn, "CellLocation"):
            return []

        query = """
            SELECT
                ROWID,
                Latitude,
                Longitude,
                HorizontalAccuracy,
                Timestamp,
                Speed,
                Course,
                Confidence
            FROM CellLocation
        """

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("CellLocation query failed: %s", e)
            return []

        artifacts: list[BaseArtifact] = []
        for row in rows:
            ts = from_cocoa(row["Timestamp"])
            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=ts,
                latitude=row["Latitude"],
                longitude=row["Longitude"],
                provenance=Provenance(
                    source_db=db_name,
                    source_table="CellLocation",
                    source_row_id=row["ROWID"],
                ),
                data={
                    "source": "cell_tower",
                    "accuracy": row["HorizontalAccuracy"],
                    "speed": row["Speed"],
                    "course": row["Course"],
                    "confidence": row["Confidence"],
                },
            ))
        return artifacts

    def _extract_wifi_harvests(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
        if not self._table_exists(conn, "WifiLocationHarvest"):
            return []

        query = """
            SELECT
                ROWID,
                MAC,
                Latitude,
                Longitude,
                Channel,
                RSSI,
                Timestamp
            FROM WifiLocationHarvest
        """

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("WifiLocationHarvest query failed: %s", e)
            return []

        artifacts: list[BaseArtifact] = []
        for row in rows:
            ts = from_cocoa(row["Timestamp"])
            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=ts,
                latitude=row["Latitude"],
                longitude=row["Longitude"],
                provenance=Provenance(
                    source_db=db_name,
                    source_table="WifiLocationHarvest",
                    source_row_id=row["ROWID"],
                ),
                data={
                    "source": "wifi_harvest",
                    "mac": row["MAC"],
                    "channel": row["Channel"],
                    "rssi": row["RSSI"],
                },
            ))
        return artifacts

    # ------------------------------------------------------------------ #
    # knowledgeC.db — inferred motion and microlocation visits
    # ------------------------------------------------------------------ #

    def _extract_knowledgec_locations(self) -> list[BaseArtifact]:
        db_path = self.resolve_db_path(self.KNOWLEDGEC_DOMAIN, self.KNOWLEDGEC_PATH)
        if db_path is None:
            self.log.info("knowledgeC.db not found")
            return []

        conn = self.open_db(db_path)
        if conn is None:
            return []

        try:
            artifacts: list[BaseArtifact] = []
            artifacts.extend(self._extract_inferred_motion(conn, str(db_path)))
            artifacts.extend(self._extract_microlocation_visits(conn, str(db_path)))
            return artifacts
        except Exception as e:
            self.log.warning("Failed to extract knowledgeC.db locations: %s", e)
            return []
        finally:
            conn.close()

    def _extract_inferred_motion(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
        if not self._table_exists(conn, "ZOBJECT"):
            return []

        query = """
            SELECT
                ZOBJECT.Z_PK,
                ZOBJECT.ZSTARTDATE,
                ZOBJECT.ZENDDATE,
                ZOBJECT.ZVALUESTRING
            FROM ZOBJECT
            WHERE ZOBJECT.ZSTREAMNAME = '/activity/inferredMotion'
        """

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("Inferred motion query failed: %s", e)
            return []

        artifacts: list[BaseArtifact] = []
        for row in rows:
            start_ts = from_cocoa(row["ZSTARTDATE"])
            end_ts = from_cocoa(row["ZENDDATE"])
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
                    "source": "inferred_motion",
                    "stream": "/activity/inferredMotion",
                    "motion_state": row["ZVALUESTRING"],
                },
            ))
        return artifacts

    def _extract_microlocation_visits(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
        if not self._table_exists(conn, "ZOBJECT"):
            return []

        query = """
            SELECT
                ZOBJECT.Z_PK,
                ZOBJECT.ZSTARTDATE,
                ZOBJECT.ZENDDATE,
                ZOBJECT.ZVALUESTRING
            FROM ZOBJECT
            WHERE ZOBJECT.ZSTREAMNAME = '/microlocation/visits'
        """

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("Microlocation visits query failed: %s", e)
            return []

        artifacts: list[BaseArtifact] = []
        for row in rows:
            start_ts = from_cocoa(row["ZSTARTDATE"])
            end_ts = from_cocoa(row["ZENDDATE"])
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
                    "source": "microlocation_visit",
                    "stream": "/microlocation/visits",
                    "value": row["ZVALUESTRING"],
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
