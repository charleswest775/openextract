from __future__ import annotations

from datetime import datetime
from enum import Enum

from pydantic import BaseModel


class AssetType(str, Enum):
    PHOTO = "photo"
    VIDEO = "video"
    LIVE_PHOTO = "live_photo"
    SCREENSHOT = "screenshot"
    PORTRAIT = "portrait"
    PANORAMA = "panorama"
    UNKNOWN = "unknown"


class Album(BaseModel):
    id: int
    title: str
    asset_count: int = 0
    created_at: datetime | None = None
    is_smart_album: bool = False


class Asset(BaseModel):
    uuid: str
    filename: str
    file_hash: str | None = None
    """Manifest hash for locating the raw file."""
    asset_type: AssetType = AssetType.UNKNOWN
    width: int | None = None
    height: int | None = None
    duration_seconds: float | None = None
    """Video/Live Photo duration."""
    created_at: datetime | None = None
    modified_at: datetime | None = None
    latitude: float | None = None
    longitude: float | None = None
    album_ids: list[int] = []
    is_favorite: bool = False
    is_hidden: bool = False
    is_deleted: bool = False
    camera_make: str | None = None
    camera_model: str | None = None
