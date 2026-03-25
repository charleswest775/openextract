"""Extraction database manager.

Stores extracted artifacts in a local SQLite database with full-text search
support. Each extraction run is tracked with metadata (backup UDID, iOS
version, timestamps, status) and all artifacts are indexed for efficient
querying by type, time range, contact, location, and free text.
"""

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from models.base import BaseArtifact

SCHEMA = """
CREATE TABLE IF NOT EXISTS extraction_runs (
    id INTEGER PRIMARY KEY,
    backup_udid TEXT NOT NULL,
    backup_date TEXT NOT NULL,
    ios_version TEXT,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    artifact_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'running'
);

CREATE TABLE IF NOT EXISTS artifacts (
    id INTEGER PRIMARY KEY,
    extraction_id INTEGER REFERENCES extraction_runs(id),
    artifact_type TEXT NOT NULL,
    timestamp TEXT,
    timestamp_end TEXT,
    source_db TEXT NOT NULL,
    source_table TEXT NOT NULL,
    source_row_id INTEGER,
    data TEXT NOT NULL,
    contact_name TEXT,
    contact_identifier TEXT,
    text_content TEXT,
    latitude REAL,
    longitude REAL,
    bundle_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_artifacts_type ON artifacts(artifact_type);
CREATE INDEX IF NOT EXISTS idx_artifacts_timestamp ON artifacts(timestamp);
CREATE INDEX IF NOT EXISTS idx_artifacts_contact ON artifacts(contact_identifier);
CREATE INDEX IF NOT EXISTS idx_artifacts_location ON artifacts(latitude, longitude);
CREATE INDEX IF NOT EXISTS idx_artifacts_bundle ON artifacts(bundle_id);
"""

FTS_SCHEMA = """
CREATE VIRTUAL TABLE IF NOT EXISTS artifacts_fts USING fts5(
    text_content, contact_name, artifact_type,
    content='artifacts', content_rowid='id'
);
"""


class ExtractionDB:
    """Manages the local extraction results database.

    Provides methods to create extraction runs, store artifacts, and query
    results by type, time range, or free-text search.
    """

    def __init__(self, db_path: Path):
        """Initialize the extraction database.

        Creates the database file and schema if they don't already exist.

        Args:
            db_path: Path where the SQLite database should be stored.
        """
        self.db_path = db_path
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(db_path))
        self.conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self) -> None:
        """Create tables and indexes if they don't already exist."""
        self.conn.executescript(SCHEMA)
        try:
            self.conn.executescript(FTS_SCHEMA)
        except Exception:
            pass  # FTS may already exist
        self.conn.commit()

    def clear_device(self, backup_udid: str) -> int:
        """Delete all previous extraction data for a device.

        Removes artifacts, FTS entries, and extraction runs for the given UDID
        so a fresh extraction starts clean without duplicates.

        Args:
            backup_udid: The UDID whose data should be cleared.

        Returns:
            Number of artifacts deleted.
        """
        # Get all run IDs for this device
        run_ids = [
            row[0]
            for row in self.conn.execute(
                "SELECT id FROM extraction_runs WHERE backup_udid = ?",
                (backup_udid,),
            )
        ]
        if not run_ids:
            return 0

        placeholders = ",".join("?" for _ in run_ids)

        # Delete FTS entries for these artifacts
        try:
            self.conn.execute(
                f"DELETE FROM artifacts_fts WHERE rowid IN "
                f"(SELECT id FROM artifacts WHERE extraction_id IN ({placeholders}))",
                run_ids,
            )
        except Exception:
            pass  # FTS table may not exist

        # Delete artifacts
        cur = self.conn.execute(
            f"DELETE FROM artifacts WHERE extraction_id IN ({placeholders})",
            run_ids,
        )
        deleted = cur.rowcount

        # Delete runs
        self.conn.execute(
            f"DELETE FROM extraction_runs WHERE id IN ({placeholders})",
            run_ids,
        )
        self.conn.commit()
        return deleted

    def create_run(
        self,
        backup_udid: str,
        backup_date: str,
        ios_version: Optional[str] = None,
    ) -> int:
        """Create a new extraction run record.

        Args:
            backup_udid: The UDID of the backup being extracted.
            backup_date: The date of the backup (ISO format string).
            ios_version: The iOS version of the device, if known.

        Returns:
            The row ID of the new extraction run.
        """
        now = datetime.now(timezone.utc).isoformat()
        cur = self.conn.execute(
            "INSERT INTO extraction_runs (backup_udid, backup_date, ios_version, started_at) VALUES (?, ?, ?, ?)",
            (backup_udid, backup_date, ios_version, now),
        )
        self.conn.commit()
        return cur.lastrowid

    def complete_run(self, run_id: int, artifact_count: int, status: str = "completed") -> None:
        """Mark an extraction run as complete.

        Args:
            run_id: The ID of the extraction run to update.
            artifact_count: Total number of artifacts extracted.
            status: Final status string (default "completed").
        """
        now = datetime.now(timezone.utc).isoformat()
        self.conn.execute(
            "UPDATE extraction_runs SET completed_at=?, artifact_count=?, status=? WHERE id=?",
            (now, artifact_count, status, run_id),
        )
        self.conn.commit()

    def store_artifacts(self, run_id: int, artifacts: list[BaseArtifact]) -> None:
        """Store a batch of extracted artifacts.

        Args:
            run_id: The extraction run these artifacts belong to.
            artifacts: List of BaseArtifact instances to store.
        """
        inserted_ids: list[int] = []
        for a in artifacts:
            cur = self.conn.execute(
                """INSERT INTO artifacts
                (extraction_id, artifact_type, timestamp, timestamp_end,
                 source_db, source_table, source_row_id, data,
                 contact_name, contact_identifier, text_content,
                 latitude, longitude, bundle_id)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    run_id,
                    a.artifact_type,
                    a.timestamp.isoformat() if a.timestamp else None,
                    a.timestamp_end.isoformat() if a.timestamp_end else None,
                    a.provenance.source_db,
                    a.provenance.source_table,
                    a.provenance.source_row_id,
                    json.dumps(a.data, default=str),
                    a.contact_name,
                    a.contact_identifier,
                    a.text_content,
                    a.latitude,
                    a.longitude,
                    a.bundle_id,
                ),
            )
            inserted_ids.append(cur.lastrowid)

        # Update FTS index using the correct rowid for each artifact
        for rowid, a in zip(inserted_ids, artifacts):
            if a.text_content or a.contact_name:
                try:
                    self.conn.execute(
                        "INSERT INTO artifacts_fts(rowid, text_content, contact_name, artifact_type) "
                        "VALUES (?, ?, ?, ?)",
                        (rowid, a.text_content, a.contact_name, a.artifact_type),
                    )
                except Exception:
                    pass
        self.conn.commit()

    def search(
        self,
        query: str,
        artifact_type: Optional[str] = None,
        limit: int = 100,
    ) -> list[dict]:
        """Full-text search across artifacts.

        Args:
            query: FTS5 match expression (e.g. a word or phrase).
            artifact_type: Optional filter to a specific artifact type.
            limit: Maximum number of results to return.

        Returns:
            A list of artifact dicts matching the query.
        """
        sql = (
            "SELECT a.* FROM artifacts_fts f "
            "JOIN artifacts a ON f.rowid = a.id "
            "WHERE artifacts_fts MATCH ?"
        )
        params: list = [query]
        if artifact_type:
            sql += " AND a.artifact_type = ?"
            params.append(artifact_type)
        sql += f" LIMIT {limit}"
        return [dict(row) for row in self.conn.execute(sql, params)]

    def query_artifacts(
        self,
        artifact_type: Optional[str] = None,
        start: Optional[str] = None,
        end: Optional[str] = None,
        limit: int = 1000,
    ) -> list[dict]:
        """Query artifacts with optional filters.

        Args:
            artifact_type: Filter to a specific artifact type.
            start: ISO timestamp lower bound (inclusive).
            end: ISO timestamp upper bound (inclusive).
            limit: Maximum number of results to return.

        Returns:
            A list of artifact dicts ordered by timestamp descending.
        """
        sql = "SELECT * FROM artifacts WHERE 1=1"
        params: list = []
        if artifact_type:
            sql += " AND artifact_type = ?"
            params.append(artifact_type)
        if start:
            sql += " AND timestamp >= ?"
            params.append(start)
        if end:
            sql += " AND timestamp <= ?"
            params.append(end)
        sql += " ORDER BY timestamp DESC LIMIT ?"
        params.append(limit)
        return [dict(row) for row in self.conn.execute(sql, params)]

    def close(self) -> None:
        """Close the database connection."""
        self.conn.close()
