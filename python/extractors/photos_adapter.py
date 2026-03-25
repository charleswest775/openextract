"""Adapter wrapping existing photo metadata extraction for the new pipeline.

Extracts photo/video metadata from Photos.sqlite into BaseArtifact format.
Does NOT handle thumbnails or binary export — that stays in the legacy photos.py.
"""

import sqlite3
from pathlib import Path
from typing import Any, Optional

from extractors._base import ArtifactExtractor
from models.base import BaseArtifact, Provenance
from utils.timestamp import from_cocoa


class PhotosExtractor(ArtifactExtractor):
    """Extracts photo and video metadata from Photos.sqlite."""

    ARTIFACT_TYPE = "photo"
    SUPPORTED_IOS_VERSIONS = range(8, 19)

    PHOTOS_DOMAIN = "CameraRollDomain"
    PHOTOS_PATH = "Media/PhotoData/Photos.sqlite"

    def extract(self) -> list[BaseArtifact]:
        db_path = self.resolve_db_path(self.PHOTOS_DOMAIN, self.PHOTOS_PATH)
        if not db_path:
            self.log.info("Photos.sqlite not found — skipping photos")
            return []

        conn = self.open_db(db_path)
        if not conn:
            return []

        try:
            return self._extract_photos(conn)
        except Exception as e:
            self.log.warning("Photos extraction failed: %s", e)
            return []
        finally:
            conn.close()

    def _extract_photos(self, conn: sqlite3.Connection) -> list[BaseArtifact]:
        artifacts: list[BaseArtifact] = []

        # Check available columns
        try:
            cols = {row[1] for row in conn.execute("PRAGMA table_info(ZASSET)").fetchall()}
        except Exception:
            return []

        has_favorite = "ZFAVORITE" in cols
        has_hidden = "ZHIDDEN" in cols
        has_trashed = "ZTRASHEDSTATE" in cols

        sql = """
            SELECT
                ZASSET.Z_PK,
                ZASSET.ZFILENAME,
                ZASSET.ZDIRECTORY,
                ZASSET.ZDATECREATED,
                ZASSET.ZMODIFICATIONDATE,
                ZASSET.ZLATITUDE,
                ZASSET.ZLONGITUDE,
                ZASSET.ZDURATION,
                ZASSET.ZKIND
        """
        if has_favorite:
            sql += ", ZASSET.ZFAVORITE"
        if has_hidden:
            sql += ", ZASSET.ZHIDDEN"
        if has_trashed:
            sql += ", ZASSET.ZTRASHEDSTATE"

        sql += " FROM ZASSET ORDER BY ZASSET.ZDATECREATED ASC"

        try:
            rows = conn.execute(sql).fetchall()
        except Exception as e:
            self.log.warning("Failed to query ZASSET: %s", e)
            return []

        for row in rows:
            ts = from_cocoa(row["ZDATECREATED"])
            lat = row["ZLATITUDE"]
            lng = row["ZLONGITUDE"]

            # Filter out invalid coordinates
            if lat is not None and (lat == 0 or lat == -180 or abs(lat) > 90):
                lat = None
            if lng is not None and (lng == 0 or lng == -180 or abs(lng) > 180):
                lng = None

            kind = row["ZKIND"]  # 0=photo, 1=video
            filename = row["ZFILENAME"] or ""
            duration = row["ZDURATION"] or 0

            data: dict[str, Any] = {
                "filename": filename,
                "directory": row["ZDIRECTORY"] or "",
                "kind": "video" if kind == 1 else "photo",
                "duration_seconds": duration if kind == 1 else None,
            }
            if has_favorite:
                data["favorite"] = bool(row["ZFAVORITE"])
            if has_hidden:
                data["hidden"] = bool(row["ZHIDDEN"])
            if has_trashed:
                data["trashed"] = bool(row["ZTRASHEDSTATE"])

            artifacts.append(BaseArtifact(
                artifact_type=self.ARTIFACT_TYPE,
                timestamp=ts,
                provenance=Provenance(
                    source_db="Photos.sqlite",
                    source_table="ZASSET",
                    source_row_id=row["Z_PK"],
                ),
                latitude=lat,
                longitude=lng,
                text_content=filename,
                data=data,
            ))

        return artifacts
