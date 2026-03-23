"""Photo/video asset extraction from Photos.sqlite."""
from __future__ import annotations

import sqlite3
from datetime import datetime, timezone
from pathlib import Path

from ..backup import BackupReader
from ..models.photo import Album, Asset, AssetType

_PHOTOS_DB_PATHS = [
    "Media/PhotoData/Photos.sqlite",
    "CameraRollDomain/Media/PhotoData/Photos.sqlite",
]

_APPLE_EPOCH = 978307200


def _apple_ts(val: float | None) -> datetime | None:
    if val is None:
        return None
    return datetime.fromtimestamp(val + _APPLE_EPOCH, tz=timezone.utc)


def _detect_asset_type(kind: int | None, filename: str | None) -> AssetType:
    if kind == 1:
        return AssetType.VIDEO
    if filename:
        low = filename.lower()
        if low.endswith((".mov", ".mp4", ".m4v", ".avi")):
            return AssetType.VIDEO
        if "screenshot" in low:
            return AssetType.SCREENSHOT
    return AssetType.PHOTO


class PhotoExtractor:
    def __init__(self, reader: BackupReader):
        self._reader = reader
        self._db_path: Path | None = None

    def _open_db(self) -> Path:
        if self._db_path and self._db_path.exists():
            return self._db_path
        for rel_path in _PHOTOS_DB_PATHS:
            try:
                self._db_path = self._reader.extract_to_temp(rel_path)
                return self._db_path
            except FileNotFoundError:
                continue
        raise FileNotFoundError("Photos.sqlite not found in backup")

    def list_albums(self) -> list[Album]:
        conn = sqlite3.connect(str(self._open_db()))
        conn.row_factory = sqlite3.Row
        try:
            rows = conn.execute(
                """
                SELECT
                    a.Z_PK as id,
                    a.ZTITLE as title,
                    a.ZCREATIONDATE as created,
                    a.ZKIND as kind,
                    COUNT(al.ZASSETS) as asset_count
                FROM ZGENERICALBUM a
                LEFT JOIN Z_26ASSETS al ON al.Z_26ALBUMS = a.Z_PK
                WHERE a.ZTITLE IS NOT NULL
                GROUP BY a.Z_PK
                ORDER BY a.ZSTARTDATE DESC NULLS LAST
                """
            ).fetchall()
        except sqlite3.OperationalError:
            conn.close()
            return []

        albums = []
        for row in rows:
            albums.append(
                Album(
                    id=row["id"],
                    title=row["title"] or "Untitled",
                    asset_count=row["asset_count"] or 0,
                    created_at=_apple_ts(row["created"]),
                    is_smart_album=bool((row["kind"] or 0) != 2),
                )
            )
        conn.close()
        return albums

    def list_assets(
        self,
        offset: int = 0,
        limit: int = 100,
        album_id: int | None = None,
    ) -> list[Asset]:
        conn = sqlite3.connect(str(self._open_db()))
        conn.row_factory = sqlite3.Row

        base = """
            SELECT
                a.ZUUID as uuid,
                a.ZFILENAME as filename,
                a.ZKIND as kind,
                a.ZPIXELWIDTH as width,
                a.ZPIXELHEIGHT as height,
                a.ZDURATION as duration,
                a.ZDATECREATED as created,
                a.ZMODIFICATIONDATE as modified,
                a.ZLATITUDE as latitude,
                a.ZLONGITUDE as longitude,
                a.ZFAVORITE as favorite,
                a.ZHIDDEN as hidden,
                a.ZTRASHEDSTATE as trashed,
                a.ZDIRECTORY as directory
            FROM ZASSET a
        """
        params: list = []

        if album_id is not None:
            base += " JOIN Z_26ASSETS al ON al.Z_3ASSETS = a.Z_PK AND al.Z_26ALBUMS = ?"
            params.append(album_id)

        base += " WHERE (a.ZTRASHEDSTATE IS NULL OR a.ZTRASHEDSTATE = 0)"
        base += " ORDER BY a.ZDATECREATED DESC LIMIT ? OFFSET ?"
        params += [limit, offset]

        rows = conn.execute(base, params).fetchall()
        conn.close()

        assets = []
        for row in rows:
            filename = row["filename"] or ""
            # Build the backup-relative path for raw file access
            directory = row["directory"] or ""
            if directory and filename:
                file_path = f"Media/{directory}/{filename}"
            else:
                file_path = f"Media/DCIM/{filename}"

            assets.append(
                Asset(
                    uuid=row["uuid"] or "",
                    filename=filename,
                    file_hash=self._lookup_hash(file_path),
                    asset_type=_detect_asset_type(row["kind"], filename),
                    width=row["width"],
                    height=row["height"],
                    duration_seconds=row["duration"],
                    created_at=_apple_ts(row["created"]),
                    modified_at=_apple_ts(row["modified"]),
                    latitude=row["latitude"],
                    longitude=row["longitude"],
                    is_favorite=bool(row["favorite"]),
                    is_hidden=bool(row["hidden"]),
                    is_deleted=bool(row["trashed"]),
                )
            )
        return assets

    def _lookup_hash(self, file_path: str) -> str | None:
        files = self._reader.find_files(path_like=file_path.split("/")[-1])
        for f in files:
            if f["path"].endswith(file_path.split("/")[-1]):
                return f["hash"]
        return None

    def get_asset_bytes(self, file_hash: str) -> bytes | None:
        """Return raw bytes for an asset given its manifest hash."""
        hashed_path = self._reader._path / file_hash[:2] / file_hash
        if hashed_path.exists():
            return hashed_path.read_bytes()
        return None

    def get_thumbnail_bytes(self, file_hash: str, size: int = 256) -> bytes | None:
        """Generate a thumbnail as JPEG bytes. Requires Pillow + pillow-heif."""
        raw = self.get_asset_bytes(file_hash)
        if not raw:
            return None
        try:
            import io

            from PIL import Image

            try:
                import pillow_heif
                pillow_heif.register_heif_opener()
            except ImportError:
                pass

            img = Image.open(io.BytesIO(raw))
            img.thumbnail((size, size), Image.LANCZOS)
            buf = io.BytesIO()
            img.convert("RGB").save(buf, "JPEG", quality=80)
            return buf.getvalue()
        except Exception:
            return None
