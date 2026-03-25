"""Apple Health data extractor.

Parses healthdb_secure.sqlite to extract health samples (steps, heart rate,
distance, etc.) and workout data. This database is only available in
encrypted backups.
"""

import sqlite3
from typing import Optional

from extractors._base import ArtifactExtractor
from models.base import BaseArtifact, Provenance
from utils.timestamp import from_cocoa


# Map of known data type IDs to human-readable names
SAMPLE_TYPE_NAMES = {
    7: "StepCount",
    8: "Distance",
    10: "FlightsClimbed",
    12: "HeartRate",
    29: "BodyMass",
    70: "StandHour",
}


class HealthExtractor(ArtifactExtractor):
    """Extract Apple Health data from healthdb_secure.sqlite.

    This database is only present in encrypted iPhone backups.
    """

    ARTIFACT_TYPE = "health"
    SUPPORTED_IOS_VERSIONS = range(9, 19)

    DB_DOMAIN = "HealthDomain"
    DB_RELATIVE_PATH = "Library/Health/healthdb_secure.sqlite"

    def extract(self) -> list[BaseArtifact]:
        if not self.is_supported():
            self.log.debug("iOS %s not supported", self.ios_major)
            return []

        db_path = self.resolve_db_path(self.DB_DOMAIN, self.DB_RELATIVE_PATH)
        if db_path is None:
            self.log.info(
                "healthdb_secure.sqlite not found — this database is only "
                "available in encrypted backups"
            )
            return []

        conn = self.open_db(db_path)
        if conn is None:
            return []

        try:
            artifacts: list[BaseArtifact] = []
            db_name = str(db_path)
            artifacts.extend(self._extract_samples(conn, db_name))
            artifacts.extend(self._extract_workouts(conn, db_name))
            self.log.info("Extracted %d health artifacts", len(artifacts))
            return artifacts
        except Exception as e:
            self.log.warning("Failed to extract health data: %s", e)
            return []
        finally:
            conn.close()

    def _extract_samples(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
        if not self._table_exists(conn, "samples"):
            self.log.warning("samples table not found")
            return []

        has_quantity = self._table_exists(conn, "quantity_samples")

        if has_quantity:
            query = """
                SELECT
                    s.ROWID AS sample_rowid,
                    s.data_type,
                    s.start_date,
                    s.end_date,
                    qs.quantity
                FROM samples s
                LEFT JOIN quantity_samples qs ON s.data_id = qs.data_id
                ORDER BY s.start_date DESC
            """
        else:
            query = """
                SELECT
                    s.ROWID AS sample_rowid,
                    s.data_type,
                    s.start_date,
                    s.end_date,
                    NULL AS quantity
                FROM samples s
                ORDER BY s.start_date DESC
            """

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("Health samples query failed: %s", e)
            return []

        artifacts: list[BaseArtifact] = []
        for row in rows:
            start_ts = from_cocoa(row["start_date"])
            end_ts = from_cocoa(row["end_date"])
            data_type = row["data_type"]
            type_name = SAMPLE_TYPE_NAMES.get(data_type, f"type_{data_type}")

            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=start_ts,
                timestamp_end=end_ts,
                provenance=Provenance(
                    source_db=db_name,
                    source_table="samples",
                    source_row_id=row["sample_rowid"],
                ),
                data={
                    "category": "sample",
                    "data_type_id": data_type,
                    "data_type_name": type_name,
                    "quantity": row["quantity"],
                },
            ))

        return artifacts

    def _extract_workouts(self, conn: sqlite3.Connection, db_name: str) -> list[BaseArtifact]:
        if not self._table_exists(conn, "workouts"):
            self.log.info("workouts table not found")
            return []

        query = """
            SELECT
                ROWID,
                workout_type,
                duration,
                total_distance,
                total_energy_burned,
                start_date,
                end_date
            FROM workouts
            ORDER BY start_date DESC
        """

        try:
            rows = conn.execute(query).fetchall()
        except sqlite3.Error as e:
            self.log.warning("Workouts query failed: %s", e)
            return []

        artifacts: list[BaseArtifact] = []
        for row in rows:
            start_ts = from_cocoa(row["start_date"])
            end_ts = from_cocoa(row["end_date"])

            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=start_ts,
                timestamp_end=end_ts,
                provenance=Provenance(
                    source_db=db_name,
                    source_table="workouts",
                    source_row_id=row["ROWID"],
                ),
                data={
                    "category": "workout",
                    "workout_type": row["workout_type"],
                    "duration": row["duration"],
                    "total_distance": row["total_distance"],
                    "total_energy_burned": row["total_energy_burned"],
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
