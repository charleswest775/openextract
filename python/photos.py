"""
Photo extraction adapter.

Delegates ``list_albums`` to ``ios_backup_core.extractors.photos.PhotoExtractor``.
For ``list_photos`` and ``get_photo_metadata`` the library returns assets with a
``relative_path`` field but no ``file_hash``; openextract's frontend addresses
photos by hash (so it can call ``get_photo``/``get_thumbnail``/``get_photo_path``
later without re-reading Photos.sqlite). This adapter post-processes the
library's output to add ``file_hash`` and leave out assets whose original isn't
in the backup (iCloud Photos with "Optimize iPhone Storage", Shared Albums).
``list_photos`` and ``list_albums`` also say how many assets are in the backup,
because the library's counts include the ones left out.

Kept openextract-local because the library intentionally omits them as
"UI concerns":
  * ``get_thumbnail``  — PIL/pillow-heif thumbnail generation, in-memory cache
  * ``get_photo``      — full-res JPEG re-encoding for HEIC, base64
  * ``get_file_for_app`` (main.py's ``get_photo_path``) — a video as a file the computer's
    video player can open: a copy under its own name, never the backup's hash-named file
  * ``export_photos``  — disk export (originals or transcoded JPEG, by-date subfolders)
  * DCIM directory-scan fallback for backups where Photos.sqlite is missing
"""

import base64
import datetime
import hashlib
import io
import json
import os
import sqlite3
import sys
import uuid
import weakref
from typing import Optional

import backup_files
from app_copies import AppCopies, NotEnoughSpace, is_openable, join_name, split_name
from app_copies import ProgressCallback as CopyProgress
from export_progress import ExportProgress, ProgressCallback
from save_names import SaveNames, copy_new, holds, same_file, write_new
from ios_backup_core.db import connect_readonly
from ios_backup_core.extractors.photos import (
    PhotoExtractor as _CorePhotoExtractor,
    PHOTO_EXTENSIONS,
    VIDEO_EXTENSIONS,
    _build_dcim_path,
    uuid_text,
)

try:  # Favorites and Hidden (ios-backup-core from November 2026); without them, only albums.
    from ios_backup_core.extractors.photos import FAVORITES, HIDDEN, smart_album_where
    SMART_ALBUMS: tuple = (FAVORITES, HIDDEN)
except ImportError:
    smart_album_where = None
    HIDDEN = None
    SMART_ALBUMS = ()

# list_photos' album_id for every photo, hidden ones too: what Save to this computer saves.
# All Photos (no album_id) leaves hidden photos out, as the iPhone does.
LIBRARY = "__library__"
try:  # ios-backup-core with All Photos leaving hidden photos out; older ones list them there.
    from ios_backup_core.extractors.photos import LIBRARY as _CORE_LIBRARY
except ImportError:
    _CORE_LIBRARY = None


def not_hidden_filter(columns: set) -> str:
    """An asset-table condition that leaves out hidden photos, as All Photos does; "1 = 1" when it doesn't.

    For the counts that describe All Photos: the Overview's Photos card and the Year view.
    """
    if _CORE_LIBRARY is None or "ZHIDDEN" not in columns:
        return "1 = 1"
    return "COALESCE(ZHIDDEN, 0) = 0"

HAS_HEIF = False
try:
    from PIL import Image
    HAS_PIL = True
    try:
        from pillow_heif import register_heif_opener
        register_heif_opener()
        HAS_HEIF = True
    except Exception:
        pass
except ImportError:
    HAS_PIL = False

print(f"[photos] PIL={HAS_PIL} HEIF={HAS_HEIF}", file=sys.stderr, flush=True)


# Where Photos keeps originals in CameraRollDomain: DCIM for photos taken or
# saved on this iPhone, PhotoData/CPLAssets for ones iCloud Photos brought in
# from other devices.
_ORIGINALS_PREFIXES = ("Media/DCIM/", "Media/PhotoData/CPLAssets/")
# Where the iPhone's Photos app keeps the thumbnails it made of each photo (_iphone_thumbnails).
_IPHONE_THUMBNAILS = "Media/PhotoData/Thumbnails/V2/"
# Video files get_thumbnail knows by name besides the library's VIDEO_EXTENSIONS (its _VIDEO_EXTS).
_MORE_VIDEO_EXTENSIONS = {".mkv", ".3gp", ".webm"}

# Photos.sqlite's ZDATECREATED counts seconds from 2001-01-01 UTC, this many seconds after 1970's.
_APPLE_EPOCH_UNIX = 978307200
# ZUUIDs looked up at once: each can be asked for as text and as iOS 6's 16 bytes, and
# older SQLite allows 999 values in one query.
_UUID_CHUNK = 400

# What the app is told when a video can't be handed to the computer's video player
# (get_file_for_app), in words for people. The Photos screen shows them under "This video
# couldn't be opened". FILE_NOT_FOUND is matched by the app and by a known fix
# (website/static/api/_lib/known-fixes.js), so it keeps its words.
FILE_NOT_FOUND = "File not found"
NOT_COPIED = ("OpenExtract couldn't copy it out of the backup to open it. If the backup is on an external "
              "drive, check that the drive is still connected, then try again.")
NO_ROOM_TO_COPY = ("This computer doesn't have enough free space. OpenExtract copies a video out of the backup "
                   "before your video player opens it: this one is {size}, and {free} is free. Free up some "
                   "space and try again, or use Save all to save your photos and videos to a drive with more room.")


def _size_words(size: int) -> str:
    """A file size as people say it: "4.2 GB", "310 MB"."""
    if size >= 1000 ** 3:
        return f"{size / 1000 ** 3:.1f} GB"
    return f"{max(1, round(size / 1000 ** 2))} MB"


def _is_inside(path: str, folder: Optional[str]) -> bool:
    """Whether ``path`` is in ``folder`` or a folder under it; False when that can't be told."""
    if not folder:
        return False
    try:
        folder = os.path.realpath(folder)
        return os.path.commonpath([os.path.realpath(path), folder]) == folder
    except (ValueError, OSError):  # on Windows, paths on different drives
        return False


def _original_paths(rel: str) -> tuple:
    """Where an asset's original can be: the library's path, then Media/<ZDIRECTORY>/<file>.

    The library puts every asset under Media/DCIM/, but iCloud Photos assets
    have a ZDIRECTORY like "PhotoData/CPLAssets/group79", and their files are
    at Media/PhotoData/CPLAssets/group79/.
    """
    if rel.startswith("Media/DCIM/"):
        return (rel, "Media/" + rel[len("Media/DCIM/"):])
    return (rel,)


def _selection_count(part: dict, has_albums: bool, album_id: Optional[str]) -> Optional[int]:
    """The count in ``part`` ({"library", "albums", "smart"}) for what list_photos(album_id=...) lists."""
    if album_id in part["smart"]:
        return part["smart"][album_id]
    if album_id == LIBRARY:
        # Every photo: All Photos plus Hidden, which All Photos leaves out.
        hidden = part["smart"].get(HIDDEN, 0) if HIDDEN is not None and _CORE_LIBRARY is not None else 0
        return part["library"] + hidden
    # Same choice as the library's list_photos: an album it can't filter by
    # (no album junction table, "__all__") lists the whole library.
    if album_id and album_id != "__all__" and has_albums:
        try:
            return part["albums"].get(str(int(album_id)), 0)
        except ValueError:
            return None
    return part["library"]


# A face box smaller than this (a fraction of the photo's shorter side) isn't used for a
# face thumbnail: Photos keeps some faces with no box at all (size 0).
MIN_FACE_SIZE = 0.01
# A face thumbnail is cut from at least this many pixels of the photo, so a small face
# shows with what's around it instead of as a few blurred pixels.
MIN_FACE_CROP = 96


def face_crop_box(width: int, height: int, center_x: float, center_y: float, size: float,
                  scale: float = 2.0) -> tuple:
    """(left, top, right, bottom) in pixels: a square ``scale`` times Photos' face box, kept inside the photo.

    Photos measures the box's centre from the photo's bottom-left corner, as fractions
    of its width and height, and its size as a fraction of the shorter side. The square
    is at least MIN_FACE_CROP pixels (or the whole shorter side of a smaller photo).
    """
    short = min(width, height)
    side = max(1, min(short, max(MIN_FACE_CROP, round(size * short * scale))))
    left = min(max(round(center_x * width - side / 2), 0), width - side)
    top = min(max(round((1 - center_y) * height - side / 2), 0), height - side)
    return left, top, left + side, top + side


# A body box narrower than this (a fraction of the photo's width) isn't used.
MIN_BODY_WIDTH = 0.02


def body_crop_box(width: int, height: int, center_x: float, center_y: float, body_w: float, body_h: float) -> tuple:
    """(left, top, right, bottom) in pixels: a square over the top of Photos' body box (head and shoulders).

    The body box is measured like the face box, from the bottom-left corner, with its width
    and height as fractions of the photo's width and height. The square is as wide as the body
    (at least MIN_FACE_CROP pixels), starts just above its top, and stays inside the photo.
    """
    short = min(width, height)
    side = max(1, min(short, max(MIN_FACE_CROP, round(body_w * width * 1.1))))
    top_of_body = (1 - center_y - body_h / 2) * height
    left = min(max(round(center_x * width - side / 2), 0), width - side)
    top = min(max(round(top_of_body - side * 0.05), 0), height - side)
    return left, top, left + side, top + side


def choose_face(faces: list, key_face, stills: dict, posters: dict) -> Optional[dict]:
    """The face list_photo_people shows for someone, from their face rows (_faces_by_person), or None.

    In order: Photos' key face, else their biggest face, on a still photo in the backup
    (``stills``: uuid -> file_hash); else their biggest body box on one (Photos keeps some
    people's faces with no face box, only a body box: someone seen from the side or behind);
    else a face or body box, or just the picture, from the iPhone's own thumbnail of a video
    they're in (``posters``: video uuid -> thumbnail key), since a face can't be cut from the
    video itself. Faces with no box (centre 0, 0, size 0) came out as a single colour.
    """
    def has_face(f):
        return (f.get("size") or 0) >= MIN_FACE_SIZE and f.get("center_x") is not None and f.get("center_y") is not None

    def has_body(f):
        return (f.get("body_w") or 0) >= MIN_BODY_WIDTH and (f.get("body_h") or 0) > 0 and f.get("body_x") is not None

    def face_out(f, file_hash):
        return {"file_hash": file_hash, "center_x": f["center_x"], "center_y": f["center_y"], "size": f["size"]}

    def body_out(f, file_hash):
        return {"file_hash": file_hash, "center_x": None, "center_y": None, "size": None,
                "body": {"center_x": f["body_x"], "center_y": f["body_y"], "width": f["body_w"], "height": f["body_h"]}}

    on_stills = [f for f in faces if not f["video"] and f["asset_uuid"] in stills]
    boxed = sorted((f for f in on_stills if has_face(f)), key=lambda f: (f["face"] != key_face, -f["size"]))
    if boxed:
        return face_out(boxed[0], stills[boxed[0]["asset_uuid"]])
    bodies = sorted((f for f in on_stills if has_body(f)), key=lambda f: -(f["body_w"] * f["body_h"]))
    if bodies:
        return body_out(bodies[0], stills[bodies[0]["asset_uuid"]])
    in_videos = [f for f in faces if f["video"] and f["asset_uuid"] in posters]
    for usable, out in ((has_face, face_out), (has_body, body_out)):
        found = sorted((f for f in in_videos if usable(f)),
                       key=lambda f: -((f["size"] or 0) if usable is has_face else f["body_w"] * f["body_h"]))
        if found:
            return {**out(found[0], posters[found[0]["asset_uuid"]]), "poster": True}
    if in_videos:
        return {"file_hash": posters[in_videos[0]["asset_uuid"]], "center_x": None, "center_y": None,
                "size": None, "poster": True}
    return None


def asset_table(conn) -> str:
    """The assets table: ZASSET from iOS 14, ZGENERICASSET before that. Also used by stats.py."""
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type = 'table'")}
    return "ZGENERICASSET" if "ZASSET" not in tables and "ZGENERICASSET" in tables else "ZASSET"


# EXIF tags export_photos writes on a JPEG made from a HEIC.
_EXIF_ORIENTATION = 0x0112
_EXIF_IFD = 0x8769
_EXIF_DATE_TAKEN = 0x9003         # DateTimeOriginal
_EXIF_DATE_TAKEN_OFFSET = 0x9011  # OffsetTimeOriginal
_JPEG_MAX_EXIF = 65533            # bytes in one JPEG marker segment


def _date_taken(photo: dict) -> Optional[datetime.datetime]:
    """When the photo was taken, as an aware datetime, or None without a usable date.

    ios-backup-core gives ZDATECREATED as a UTC ISO string ("2024-07-13T23:10:37+00:00").
    One without a zone is UTC too: read as local time, it would be off by the
    computer's offset from UTC.
    """
    value = photo.get("date_created")
    if not value:
        return None
    try:
        taken = datetime.datetime.fromisoformat(str(value))
    except ValueError:
        return None
    return taken if taken.tzinfo else taken.replace(tzinfo=datetime.timezone.utc)


def _set_file_date(path: str, taken: Optional[datetime.datetime]) -> None:
    """Give a saved file the date its photo was taken, so Finder, Explorer and photo apps sort by it.

    Otherwise a copy has the backup's date and a converted JPEG or .json the
    time of saving. Sets the modified and accessed times (on a Mac, an earlier
    modified time moves the created date back too). Skips a missing date, and
    one the drive can't store.
    """
    if taken is None:
        return
    try:
        stamp = taken.timestamp()
        os.utime(path, (stamp, stamp))
    except (OSError, OverflowError, ValueError):
        pass


def _jpeg_exif(img, taken: Optional[datetime.datetime]) -> bytes:
    """EXIF for the JPEG made from a HEIC: the HEIC's own (date taken, place, camera).

    pillow-heif has already turned the pixels upright, so the orientation says
    so. A HEIC without a date taken gets Photos.sqlite's, in this computer's
    time zone with its offset, the way a camera writes it. Returns b"" (no
    EXIF, as before) when the HEIC's EXIF can't be read or won't fit in a JPEG.
    """
    try:
        exif = img.getexif()
        if exif.get(_EXIF_ORIENTATION, 1) != 1:
            exif[_EXIF_ORIENTATION] = 1
        details = exif.get_ifd(_EXIF_IFD)
        if taken is not None and not details.get(_EXIF_DATE_TAKEN):
            try:
                local = taken.astimezone()
            except (OSError, OverflowError, ValueError):
                local = None  # Windows can't give local time before 1970
            if local is not None:
                offset = local.strftime("%z")
                details[_EXIF_DATE_TAKEN] = local.strftime("%Y:%m:%d %H:%M:%S")
                details[_EXIF_DATE_TAKEN_OFFSET] = f"{offset[:3]}:{offset[3:5]}"
        data = exif.tobytes()
    except Exception:
        return b""
    return data if len(data) <= _JPEG_MAX_EXIF else b""


class PhotoExtractor:
    """Adapter wrapping the ios-backup-core PhotoExtractor."""

    def __init__(self):
        self._inner = _CorePhotoExtractor()
        # In-memory thumbnail cache (file_hash:size → base64 string)
        self._thumb_cache: dict = {}
        self._thumb_fail_count: int = 0
        # Per open backup, so paging doesn't re-read Manifest.db and Photos.sqlite:
        # its originals (relative path → fileID) and its in-backup counts.
        self._originals_cache: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()
        self._in_backup_cache: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()
        # The date of every photo in each listing a date range has been asked of (_listing_dates).
        self._listing_cache: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()
        # The library's People list with each person's photo uuids, per open backup.
        self._people_cache: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()
        # The thumbnails the iPhone's Photos app made, by the photo they're of, and the
        # originals' paths by file id (an unencrypted backup's file_hash), per open backup.
        self._iphone_thumbs_cache: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()
        self._original_paths_cache: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()
        # Every face People counts, by person, for picking the face each one shows.
        self._faces_cache: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()
        # Copies of videos for the computer's video player (get_file_for_app). Made as the
        # engine starts, which is when the copies an earlier engine left behind are removed.
        self._copies = AppCopies("photos")

    # ── Delegated raw-extraction methods ─────────────────────────────────────

    def list_albums(self, backup) -> dict:
        """List albums. Each also gets ``in_backup``: how many of its
        ``asset_count`` assets the backup has a file for."""
        result = self._inner.list_albums(backup)
        counts = self._in_backup_counts(backup) if result.get("albums") else None
        if counts is None:
            return result
        def in_backup(album: dict) -> int:
            if album["id"] == "__all__":
                return counts["library"]
            if album["id"] in counts["smart"]:
                return counts["smart"][album["id"]]
            return counts["albums"].get(album["id"], 0)

        return {**result, "albums": [{**a, "in_backup": in_backup(a)} for a in result["albums"]]}

    def list_photos(self, backup, offset: int = 0, limit: int = 100,
                    album_id: Optional[str] = None, date_from: Optional[float] = None,
                    date_to: Optional[float] = None, person_ids: Optional[list] = None,
                    person_match: str = "any") -> dict:
        """List photo assets, post-processed to add file_hash for downstream RPCs.

        ``total``, ``offset`` and ``limit`` count rows in the Photos library, so
        a page can hold fewer photos than ``limit`` (or none) with more after it.
        ``in_backup`` is how many photos the pages hold in all, and
        ``not_in_backup`` how many library rows have no file in the backup (only in
        iCloud). ``missing_from_folder`` is how many the backup lists but its folder
        doesn't have (OE-102); they're left out too, and not counted as iCloud-only.

        ``date_from`` and ``date_to`` (Unix seconds; ``date_to`` itself is left out) keep
        the photos taken in that time, and every count is then of those (see
        _list_photos_between). A backup with no Photos library has no dates, so a date
        range finds nothing there; its listing without one says ``source`` "dcim_scan".

        ``person_ids`` (ids from list_photo_people) keeps All Photos' photos with any
        of those people on, or all of them with ``person_match`` "all".
        """
        person_ids = [str(p) for p in person_ids or []]
        if person_ids and not self._has_people():
            return {"photos": [], "total": 0, "offset": offset, "limit": limit, "source": "unavailable"}
        if date_from is not None or date_to is not None:
            return self._list_photos_between(backup, offset, limit, album_id, date_from, date_to,
                                             person_ids, person_match)

        # An older ios-backup-core has no LIBRARY, and its All Photos already holds every photo.
        core_album_id = None if album_id == LIBRARY and _CORE_LIBRARY is None else album_id
        if person_ids:
            result = self._inner.list_photos(backup, offset, limit, core_album_id,
                                             person_ids=person_ids, person_match=person_match)
        else:
            result = self._inner.list_photos(backup, offset, limit, core_album_id)

        # If the library returned nothing because Photos.sqlite is unavailable
        # (older iOS, corrupted backup), fall back to direct DCIM enumeration.
        # An empty album is just empty: the DCIM scan can't filter by album, nor by person.
        whole_library = not person_ids and (not album_id or album_id in ("__all__", LIBRARY))
        if result.get("source") == "unavailable" or (
            whole_library and not result.get("photos") and result.get("total", 0) == 0
        ):
            reason = result.get("error") or (
                "Photos.sqlite unavailable" if result.get("source") == "unavailable"
                else "Photos.sqlite lists no assets"
            )
            print(f"[photos] list_photos: using DCIM fallback (no album filter): {reason}",
                  file=sys.stderr, flush=True)
            # Say why we fell back: the DCIM scan has no dates, places or
            # albums, so a silent fallback hides real extraction bugs.
            return {**self._list_photos_from_dcim(backup, offset, limit), "fallback_reason": reason}

        photos_out = []
        for asset in result.get("photos", []):
            adapted = self._add_file_hash(asset, backup)
            if adapted is not None:
                photos_out.append(adapted)

        total = result.get("total", len(photos_out))
        out = {
            "photos": photos_out,
            "total": total,
            "offset": result.get("offset", offset),
            "limit": result.get("limit", limit),
            "source": result.get("source", "photos_sqlite"),
        }
        if person_ids:
            in_backup, missing = self._people_in_backup(backup, album_id, person_ids, person_match)
        else:
            in_backup = self._selection_in_backup(backup, album_id)
            missing = self._selection_missing(backup, album_id) if in_backup is not None else None
        if in_backup is not None:
            missing = missing or 0
            out["in_backup"] = in_backup
            out["not_in_backup"] = max(total - in_backup - missing, 0)
            out["missing_from_folder"] = missing
        return out

    def _list_photos_between(self, backup, offset: int, limit: int, album_id: Optional[str],
                             date_from: Optional[float], date_to: Optional[float],
                             person_ids: Optional[list] = None, person_match: str = "any") -> dict:
        """list_photos for the photos taken from ``date_from`` up to (not including) ``date_to``.

        The library lists photos newest first, so the ones in a date range are one run
        of its rows: after the rows newer than the range, as long as the rows in it.
        The library is asked for that run, and ``total`` and ``offset`` count rows in it.
        Photos with no date are in no range. ``person_ids`` narrows the listing first,
        as list_photos does without dates.
        """
        low = None if date_from is None else float(date_from) - _APPLE_EPOCH_UNIX
        high = None if date_to is None else float(date_to) - _APPLE_EPOCH_UNIX
        out = {"photos": [], "total": 0, "offset": offset, "limit": limit, "source": "photos_sqlite"}
        people = {"person_ids": person_ids, "person_match": person_match} if person_ids else {}
        rows = self._listing_dates(backup, album_id, **people)
        if rows is None:
            return {**out, "source": "dcim_scan", "in_backup": 0, "not_in_backup": 0, "missing_from_folder": 0}

        def dated(ts) -> bool:
            return isinstance(ts, (int, float)) and not isinstance(ts, bool)

        newer = 0 if high is None else sum(1 for _, ts in rows if dated(ts) and ts >= high)
        between = frozenset(pk for pk, ts in rows
                            if dated(ts) and (low is None or ts >= low) and (high is None or ts < high))
        total = len(between)
        if offset < total and limit > 0:
            core_album_id = None if album_id == LIBRARY and _CORE_LIBRARY is None else album_id
            page = self._inner.list_photos(backup, newer + offset, min(limit, total - offset), core_album_id,
                                           **people)
            for asset in page.get("photos", []):
                adapted = self._add_file_hash(asset, backup)
                if adapted is not None:
                    out["photos"].append(adapted)
        out["total"] = total

        counts = self._in_backup_counts(backup)
        if counts is not None:
            in_backup = len(between & counts["present"])
            missing = len(between & counts["missing_ids"])
            out["in_backup"] = in_backup
            out["not_in_backup"] = max(total - in_backup - missing, 0)
            out["missing_from_folder"] = missing
        return out

    def _listing_dates(self, backup, album_id: Optional[str], person_ids: Optional[list] = None,
                       person_match: str = "any") -> Optional[list]:
        """(Z_PK, ZDATECREATED) of each row the library's list_photos(album_id, person_ids)
        lists, in no order.

        The same rows as that listing (an album's, Favorites', Hidden's or All Photos',
        narrowed to some people with the library's own condition for them), so
        _list_photos_between can find a date range's run in it; the photo counts mirror
        it the same way (_count_in_backup). Read once per backup and listing. None when
        the backup has no Photos library to read, or a library from before Favorites and
        Hidden (whose rows this can't mirror).
        """
        per_backup = self._listing_cache.setdefault(backup, {})
        match = "all" if person_match == "all" else "any"
        key = (album_id or "", tuple(person_ids or ()), match if person_ids else "")
        if key in per_backup:
            return per_backup[key]
        rows = None
        conn = self._inner._open_photos_db(backup) if smart_album_where is not None else None
        if conn is not None:
            try:
                assets = asset_table(conn)
                columns = {col[1] for col in conn.execute(f"PRAGMA table_info('{assets}')")}
                core_album_id = None if album_id == LIBRARY and _CORE_LIBRARY is None else album_id
                where = smart_album_where(columns, core_album_id)
                junc_table, albums_col, assets_col = self._inner._find_album_junction(conn)
                params: list = []
                if where is None and junc_table and albums_col and assets_col:
                    sql = (f"SELECT a.Z_PK, a.ZDATECREATED FROM {assets} a "
                           f"JOIN '{junc_table}' j ON j.{assets_col} = a.Z_PK WHERE j.{albums_col} = ?")
                    params.append(int(album_id))
                else:
                    # The whole library when the backup's albums can't be read, as the listing does.
                    sql = (f"SELECT a.Z_PK, a.ZDATECREATED FROM {assets} a "
                           f"WHERE {where or smart_album_where(columns, None)}")
                if person_ids:
                    people_where, people_params = self._inner._people_condition(conn, list(person_ids), match)
                    sql += f" AND {people_where}"
                    params += people_params
                rows = [(pk, ts) for pk, ts in conn.execute(sql, params).fetchall()]
            except (sqlite3.Error, ValueError) as e:
                print(f"[photos] couldn't read the dates of {album_id or 'All Photos'}: {e}",
                      file=sys.stderr, flush=True)
                rows = None
            finally:
                conn.close()
        per_backup[key] = rows
        return rows

    def photos_by_uuid(self, backup, uuids: list) -> list:
        """The photos with these uuids, as list_photos gives them, newest first.

        For saving the photos someone picked on the Photos screen, without listing a
        whole library to find them. Leaves out any the backup has no file for, and
        uuids it doesn't know. A backup with no Photos library lists the DCIM scan's
        photos, whose uuid is their file's id, so those are found in that scan.
        """
        wanted = list(dict.fromkeys(str(u) for u in uuids if u))
        found: dict = {}
        conn = self._inner._open_photos_db(backup) if wanted else None
        if conn is not None:
            try:
                assets = asset_table(conn)
                for start in range(0, len(wanted), _UUID_CHUNK):
                    chunk = wanted[start:start + _UUID_CHUNK]
                    keys: list = list(chunk)
                    for value in chunk:  # iOS 6 keeps ZUUID as the UUID's 16 bytes
                        try:
                            keys.append(uuid.UUID(value).bytes)
                        except ValueError:
                            pass
                    marks = ", ".join("?" * len(keys))
                    for row in conn.execute(f"SELECT * FROM {assets} WHERE ZUUID IN ({marks})", keys):
                        asset = self._inner._asset_row_to_dict(row, [], "")
                        directory, filename = row["ZDIRECTORY"] or "", row["ZFILENAME"] or ""
                        asset["relative_path"] = (
                            _build_dcim_path(directory, filename) if directory and filename else None)
                        adapted = self._add_file_hash(asset, backup)
                        if adapted is not None:
                            found[adapted["uuid"]] = adapted
            except sqlite3.Error as e:
                print(f"[photos] couldn't look up the photos picked: {e}", file=sys.stderr, flush=True)
            finally:
                conn.close()
        left = set(wanted) - set(found)
        if left:
            for photo in self._list_photos_from_dcim(backup, 0, sys.maxsize)["photos"]:
                if photo["uuid"] in left:
                    found[photo["uuid"]] = photo

        def newest_first(photo: dict) -> tuple:
            taken = _date_taken(photo)
            return (taken is not None, taken.timestamp() if taken else 0.0)

        return sorted(found.values(), key=newest_first, reverse=True)
    # ── People: the groups the iPhone's Photos app made of the faces it found ──

    def _has_people(self) -> bool:
        """Whether this ios-backup-core reads the People album (from November 2026)."""
        return hasattr(self._inner, "list_people")

    def _people(self, backup) -> dict:
        """The library's People list (with each person's photo uuids), read once per backup."""
        cached = self._people_cache.get(backup)
        if cached is None:
            cached = (self._inner.list_people(backup, include_assets=True) if self._has_people()
                      else {"people": [], "source": "unavailable"})
            self._people_cache[backup] = cached
        return cached

    def _people_in_backup(self, backup, album_id, person_ids: list, match: str) -> tuple:
        """(in_backup, missing_from_folder) for list_photos with these people, or (None, None)
        when that can't be counted: the backup couldn't be, or an album narrows the people."""
        counts = self._in_backup_counts(backup)
        if counts is None or (album_id and album_id != "__all__"):
            return None, None
        groups = {p["id"]: set(p.get("asset_uuids") or ()) for p in self._people(backup).get("people", [])}
        chosen = [groups.get(person_id, set()) for person_id in person_ids]
        selected = set.intersection(*chosen) if match == "all" else set().union(*chosen)
        return len(selected & counts["present_uuids"]), len(selected & counts["missing_uuids"])

    def list_photo_people(self, backup) -> dict:
        """The People album for the Photos screen: ``{"people": [...], "source"}``.

        Each person, named or not (most groups are never named): ``id``, ``name``,
        ``contact_uri``, ``photo_count`` (photos All Photos shows with their face on),
        ``in_backup`` (how many of those the backup has; the ones list_photos with this
        person lists), ``not_in_backup`` (only in iCloud), ``missing_from_folder``
        (OE-102), and ``face``: a face of theirs on a still photo in the backup, as
        ``{file_hash, center_x, center_y, size}`` for get_face_thumbnail, else None.
        Most photos in the backup first. Only what the iPhone's Photos app worked
        out: nothing here compares faces.
        """
        result = self._people(backup)
        counts = self._in_backup_counts(backup)
        people = []
        for person in result.get("people", []):
            uuids = set(person.get("asset_uuids") or ())
            if counts is None:
                in_backup, missing = person["photo_count"], 0
            else:
                in_backup = len(uuids & counts["present_uuids"])
                missing = len(uuids & counts["missing_uuids"])
            people.append({
                "id": person["id"],
                "name": person.get("name"),
                "contact_uri": person.get("contact_uri"),
                "photo_count": person["photo_count"],
                "in_backup": in_backup,
                "not_in_backup": max(person["photo_count"] - in_backup - missing, 0),
                "missing_from_folder": missing,
                "face": self._face_in_backup(backup, person, counts),
            })
        people.sort(key=lambda p: (-p["in_backup"], -p["photo_count"], p["name"] is None,
                                   (p["name"] or "").casefold(), p["id"]))
        out = {"people": people, "source": result.get("source", "unavailable")}
        if result.get("error"):
            out["error"] = result["error"]
        return out

    def _faces_by_person(self, backup) -> Optional[dict]:
        """{person id: {"key": their key face's Z_PK, "faces": [face rows]}} for every face People
        counts, read once per backup; None without the People tables or with an older ios-backup-core.

        A face row is a dict: ``face`` (Z_PK), ``asset_uuid``, ``video``, ``center_x``, ``center_y``,
        ``size`` (Photos' face box) and ``body_x``, ``body_y``, ``body_w``, ``body_h`` (its body box).
        Groups merged into someone count as them, as list_people counts them.
        """
        if backup in self._faces_cache:
            return self._faces_cache[backup]
        result = None
        conn = self._inner._open_photos_db(backup)
        if conn is not None:
            try:
                from ios_backup_core.extractors import photos as core

                cols = core._face_columns(conn)
                if cols is not None:
                    people = core._people_rows(conn, cols)
                    assets = asset_table(conn)
                    asset_columns = {c[1] for c in conn.execute(f"PRAGMA table_info('{assets}')")}
                    visible = smart_album_where(asset_columns, None)

                    def column(name: str) -> str:
                        return f"f.{name}" if name in cols["faces"] else "NULL"

                    where = " AND ".join([f"f.{cols['person']} IS NOT NULL",
                                          f"f.{cols['asset']} IN (SELECT Z_PK FROM {assets} WHERE {visible})",
                                          *core._face_conditions(cols)])
                    result = {}
                    for row in conn.execute(
                        f"SELECT f.Z_PK, f.{cols['person']}, a.ZUUID, a.ZKIND, {column('ZCENTERX')}, "
                        f"{column('ZCENTERY')}, {column('ZSIZE')}, {column('ZBODYCENTERX')}, "
                        f"{column('ZBODYCENTERY')}, {column('ZBODYWIDTH')}, {column('ZBODYHEIGHT')} "
                        f"FROM ZDETECTEDFACE f JOIN {assets} a ON a.Z_PK = f.{cols['asset']} WHERE {where}"
                    ):
                        target = core._merged_into(people, row[1])
                        if target not in people:
                            continue
                        entry = result.setdefault(str(target), {"key": people[target]["KEYFACE"], "faces": []})
                        entry["faces"].append({
                            "face": row[0], "asset_uuid": uuid_text(row[2]) or "", "video": row[3] == 1,
                            "center_x": row[4], "center_y": row[5], "size": row[6],
                            "body_x": row[7], "body_y": row[8], "body_w": row[9], "body_h": row[10],
                        })
            except (ImportError, AttributeError, sqlite3.Error) as e:
                print(f"[photos] couldn't read the People faces: {e}", file=sys.stderr, flush=True)
                result = None
            finally:
                conn.close()
        self._faces_cache[backup] = result
        return result

    def _face_in_backup(self, backup, person: dict, counts: Optional[dict]) -> Optional[dict]:
        """A face to show for the person (see choose_face), or None to show an empty circle."""
        if counts is None:
            return None
        faces = (self._faces_by_person(backup) or {}).get(person["id"])
        if not faces:
            return None
        thumbnails = self._iphone_thumbnails(backup)
        posters = {uuid: thumbnails[path[len("Media/"):]] for uuid, path in counts.get("videos", {}).items()
                   if path.startswith("Media/") and path[len("Media/"):] in thumbnails}
        return choose_face(faces["faces"], faces["key"], counts["stills"], posters)

    def get_face_thumbnail(self, backup, file_hash: str, center_x: Optional[float] = None,
                           center_y: Optional[float] = None, size: Optional[float] = None, px: int = 96,
                           body: Optional[dict] = None) -> dict:
        """A square JPEG of someone, from list_photo_people's ``face``: ``{data, mime_type}``.

        Cut around Photos' face box when there is one (twice the box, so the whole head
        shows), else around the top of their body box (head and shoulders), else from the
        middle of the picture. Photos keeps both boxes as fractions of the photo as it's
        shown (turned upright), measured from the bottom-left corner: the face box's size is
        a fraction of the shorter side, the body box's width and height of the width and
        height. Checked against public test backups (iOS 15–17). ``file_hash`` may be the
        iPhone's own thumbnail of a video (``face.poster``), which has the video's proportions.
        """
        cache_key = f"face:{file_hash}:{center_x}:{center_y}:{size}:{json.dumps(body, sort_keys=True)}:{px}"
        if cache_key in self._thumb_cache:
            return {"data": self._thumb_cache[cache_key], "mime_type": "image/jpeg", "cached": True}
        if not HAS_PIL:
            return {"error": "Pillow not installed"}
        file_path = self._resolve_file(backup, file_hash)
        if not file_path:
            return {"error": "Photo not found"}
        try:
            from PIL import ImageOps

            img = Image.open(file_path)
            if min(img.size) > 2000:
                img.draft("RGB", (img.width // 4, img.height // 4))  # a big JPEG decodes smaller; others ignore it
            img = ImageOps.exif_transpose(img).convert("RGB")
            if center_x is not None and center_y is not None and (size or 0) >= MIN_FACE_SIZE:
                box = face_crop_box(img.width, img.height, center_x, center_y, size)
            elif body and (body.get("width") or 0) > 0 and (body.get("height") or 0) > 0:
                box = body_crop_box(img.width, img.height, body["center_x"], body["center_y"],
                                    body["width"], body["height"])
            else:
                side = min(img.size)
                box = ((img.width - side) // 2, (img.height - side) // 2,
                       (img.width - side) // 2 + side, (img.height - side) // 2 + side)
            face = img.crop(box).resize((px, px), Image.LANCZOS)
            buf = io.BytesIO()
            face.save(buf, format="JPEG", quality=85)
            data = base64.b64encode(buf.getvalue()).decode("ascii")
            if len(self._thumb_cache) >= 500:
                del self._thumb_cache[next(iter(self._thumb_cache))]
            self._thumb_cache[cache_key] = data
            return {"data": data, "mime_type": "image/jpeg", "cached": False}
        except Exception as e:
            print(f"[photos] face thumbnail failed for {file_hash[:40]}: {e}", file=sys.stderr, flush=True)
            return {"error": f"Failed to make the face thumbnail: {e}"}

    def library_in_backup(self, backup) -> int:
        """The count the Photos screen shows for All Photos, for the Overview tile.

        That is list_photos' ``in_backup`` (including the DCIM fallback), or its
        ``total`` when the library couldn't be counted, as the Photos screen does.
        """
        page = self.list_photos(backup, 0, 1)
        return page.get("in_backup", page.get("total", 0))

    def library_missing_from_folder(self, backup) -> int:
        """All Photos rows whose original the backup lists but its folder doesn't have (OE-102):
        list_photos' ``missing_from_folder`` for All Photos. 0 when the library can't be counted."""
        counts = self._in_backup_counts(backup)
        return 0 if counts is None else counts["missing"]["library"]

    def hidden_in_backup(self, backup) -> int:
        """How many hidden photos and videos the backup has a file for: the Hidden album's count.

        All Photos leaves them out, so Save to this computer, which saves them too,
        adds this to library_in_backup. 0 when the library records no hidden photos
        or can't be counted.
        """
        counts = self._in_backup_counts(backup)
        if counts is None or HIDDEN is None or _CORE_LIBRARY is None:
            return 0
        return counts["smart"].get(HIDDEN, 0)

    def ids_in_backup(self, backup) -> Optional[frozenset]:
        """Z_PKs of the assets whose original is in the backup, trashed and hidden ones too.

        For the Overview's Photos card, so it describes the photos list_photos
        lists. None when Photos.sqlite can't be counted (list_photos then lists
        every row).
        """
        counts = self._in_backup_counts(backup)
        return None if counts is None else counts["present"]

    def get_photo_metadata(self, backup, asset_uuid: str) -> dict:
        """Return full metadata for a single asset by UUID, including album names.

        Implemented locally because ios-backup-core only exposes per-asset
        metadata via list_photos (slow scan). Mirrors the original openextract
        query but reuses the library's _open_photos_db / _find_album_junction
        / _asset_row_to_dict helpers so we don't duplicate the schema-probing
        logic.
        """
        conn = self._inner._open_photos_db(backup)
        if not conn:
            return {"error": "Photos.sqlite not available"}
        try:
            junc_table, albums_col, assets_col = self._inner._find_album_junction(conn)

            assets = asset_table(conn)
            zasset_cols = {
                col[1] for col in conn.execute(f"PRAGMA table_info('{assets}')").fetchall()
            }

            def _col_or_null(name: str) -> str:
                return f"a.{name}" if name in zasset_cols else f"NULL AS {name}"

            def _renamed(*names: str) -> str:
                # Fields renamed between iOS releases (iOS 15 has ZMODIFICATIONDATE /
                # ZAVALANCHEUUID). Select whichever exists under every name: the
                # library's row mapper takes the first name present in the row, so
                # a NULL placeholder for a missing new name would hide the old one.
                present = next((f"a.{n}" for n in names if n in zasset_cols), "NULL")
                return ", ".join(f"{present} AS {n}" for n in names)

            meta_cols = ", ".join([
                _col_or_null("ZUUID"), _col_or_null("ZDIRECTORY"),
                _col_or_null("ZFILENAME"), _col_or_null("ZKIND"),
                _col_or_null("ZDATECREATED"), _renamed("ZMODIFICATIONDATE", "ZDATEMODIFIED"),
                _col_or_null("ZWIDTH"), _col_or_null("ZHEIGHT"),
                _col_or_null("ZDURATION"), _col_or_null("ZFAVORITE"),
                _col_or_null("ZHIDDEN"), _col_or_null("ZHASADJUSTMENTS"),
                _renamed("ZAVALANCHEUUID", "ZBURSTUUID"),
                _col_or_null("ZLATITUDE"), _col_or_null("ZLONGITUDE"), "a.Z_PK",
            ])

            # iOS 6 keeps ZUUID as the UUID's 16 raw bytes (a BLOB column there),
            # which list_photos gives as the uppercase string; match either form.
            try:
                uuid_bytes = uuid.UUID(str(asset_uuid)).bytes
            except ValueError:
                uuid_bytes = None
            row = conn.execute(
                f"SELECT {meta_cols} FROM {assets} a WHERE a.ZUUID = ? OR a.ZUUID = ?",
                (asset_uuid, uuid_bytes)
            ).fetchone()

            if not row:
                conn.close()
                return {"error": "Asset not found"}

            album_ids: list[str] = []
            if junc_table and albums_col and assets_col:
                try:
                    junc_rows = conn.execute(
                        f"SELECT {albums_col} FROM '{junc_table}' WHERE {assets_col} = ?",
                        (row["Z_PK"],)
                    ).fetchall()
                    album_ids = [str(r[0]) for r in junc_rows if r[0] is not None]
                except Exception:
                    pass

            album_names = []
            for aid in album_ids:
                try:
                    arow = conn.execute(
                        "SELECT ZTITLE FROM ZGENERICALBUM WHERE Z_PK = ?", (int(aid),)
                    ).fetchone()
                    if arow and arow[0]:
                        album_names.append(arow[0])
                except Exception:
                    pass

            directory = row["ZDIRECTORY"] or ""
            filename = row["ZFILENAME"] or ""
            dcim_path = _build_dcim_path(directory, filename)
            if backup.encrypted:
                file_hash = f"dcim:{dcim_path}"
            else:
                file_hash = backup._lookup_file_hash(dcim_path, "CameraRollDomain") or ""

            asset = self._inner._asset_row_to_dict(row, album_ids, file_hash)
            asset["album_names"] = album_names
            conn.close()
            return asset

        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return {"error": str(e)}

    # ── Adapter helpers ──────────────────────────────────────────────────────

    def _add_file_hash(self, asset: dict, backup) -> Optional[dict]:
        """Translate the library's relative_path-keyed asset into a hash-keyed one.

        Returns None when the backup has no file for the asset (see _file_hash_for).
        """
        file_hash = self._file_hash_for(backup, asset.get("relative_path"), asset.get("filename") or "")
        if file_hash is None:
            return None

        asset = dict(asset)
        asset["file_hash"] = file_hash
        # Drop relative_path — openextract's frontend addresses by hash and
        # leaving the path adds ~50 bytes per asset to RPC payloads.
        asset.pop("relative_path", None)
        return asset

    def _file_hash_for(self, backup, rel: Optional[str], filename: str) -> Optional[str]:
        """The file_hash list_photos gives an asset, or None when its original isn't in the backup.

        That happens with iCloud Photos and "Optimize iPhone Storage" (the
        original is only in iCloud), for Shared Album items (the backup has only
        their thumbnails), and for rows with no file name. Encrypted backups
        get ``dcim:<path>`` because their Manifest.db fileIDs aren't usable
        outside the decryption library (see _resolve_file).
        """
        if not rel:
            return None
        if "PhotoCloudSharingData" in rel or "PhotoCloudSharingData" in filename:
            return None
        files, _ = self._original_files(backup)
        for path in _original_paths(rel):
            file_id = files.get(path)
            if file_id is not None:
                return f"dcim:{path}" if backup.encrypted else file_id
        return None

    def _missing_from_folder(self, backup, rel: Optional[str]) -> bool:
        """Whether the backup lists the asset's original but its folder doesn't have the file (OE-102)."""
        if not rel:
            return False
        _, missing = self._original_files(backup)
        return any(path in missing for path in _original_paths(rel))

    def _original_files(self, backup) -> tuple:
        """CameraRollDomain files where Photos keeps originals: (relative path → fileID for
        those in the backup's folder, relative paths the backup lists but its folder doesn't have).

        A file is in the backup only if its folder has it: OE-102's Manifest.db listed
        photos whose files weren't there (backup_files.py). Read once per backup: a
        Manifest.db query per folder instead of a lookup per asset, and it works on
        encrypted backups too (list_files reads their decrypted manifest).
        """
        cached = self._originals_cache.get(backup)
        if cached is None:
            files, missing = {}, set()
            for prefix in _ORIGINALS_PREFIXES:
                for f in backup.list_files(domain="CameraRollDomain", path_like=prefix + "%"):
                    if backup_files.is_stored(backup, f["hash"]):
                        files[f["path"]] = f["hash"]
                    else:
                        missing.add(f["path"])
            cached = (files, frozenset(missing))
            self._originals_cache[backup] = cached
        return cached

    def _selection_in_backup(self, backup, album_id: Optional[str]) -> Optional[int]:
        """How many photos list_photos(album_id=...) holds across all its pages."""
        counts = self._in_backup_counts(backup)
        return None if counts is None else _selection_count(counts, counts["has_albums"], album_id)

    def _selection_missing(self, backup, album_id: Optional[str]) -> Optional[int]:
        """How many of the photos list_photos(album_id=...) would show the backup lists but its
        folder doesn't have (OE-102). list_photos leaves them out, as it does iCloud-only ones."""
        counts = self._in_backup_counts(backup)
        return None if counts is None else _selection_count(counts["missing"], counts["has_albums"], album_id)

    def _in_backup_counts(self, backup) -> Optional[dict]:
        """In-backup counts for the library and each album, computed once per backup.

        Mirrors the library's list_photos filters, so each count equals what
        paging through that listing returns: the library view (All Photos) leaves
        out trashed and hidden assets, an album view lists every asset joined to the album.
        Returns ``{"library": n, "albums": {album id: n}, "smart": {Favorites or
        Hidden id: n}, "has_albums": bool, "present": Z_PKs in the backup, "missing":
        {"library", "albums", "smart"} for the assets the backup lists but its folder
        doesn't have, "missing_ids": their Z_PKs}``, or None when Photos.sqlite can't
        be read (list_photos then reports only ``total``).
        """
        if backup in self._in_backup_cache:
            return self._in_backup_cache[backup]
        counts = None
        conn = self._inner._open_photos_db(backup)
        if conn is not None:
            try:
                counts = self._count_in_backup(conn, backup)
            except sqlite3.Error as e:
                print(f"[photos] couldn't count photos in the backup: {e}", file=sys.stderr, flush=True)
            finally:
                conn.close()
        self._in_backup_cache[backup] = counts
        return counts

    def _count_in_backup(self, conn, backup) -> dict:
        assets = asset_table(conn)
        columns = {col[1] for col in conn.execute(f"PRAGMA table_info('{assets}')")}
        trashed = "ZTRASHEDSTATE" if "ZTRASHEDSTATE" in columns else "0"
        # Only an ios-backup-core whose All Photos leaves hidden photos out (it has LIBRARY).
        hidden = "COALESCE(ZHIDDEN, 0)" if "ZHIDDEN" in columns and _CORE_LIBRARY else "0"
        kind = "ZKIND" if "ZKIND" in columns else "0"
        present: set = set()
        missing: set = set()  # listed in the backup, but not in its folder (OE-102)
        in_library: set = set()
        # By uuid, for the People list: which photos are in the backup or only listed
        # there, and the file_hash of each still photo (a face thumbnail can't come from a video).
        present_uuids: set = set()
        missing_uuids: set = set()
        stills: dict = {}
        videos: dict = {}  # uuid -> path, for the iPhone's thumbnail of each video (a face from it)
        for pk, asset_uuid, directory, filename, is_trashed, is_hidden, asset_kind in conn.execute(
            f"SELECT Z_PK, ZUUID, ZDIRECTORY, ZFILENAME, {trashed}, {hidden}, {kind} FROM {assets}"
        ):
            if is_trashed == 0 and is_hidden == 0:
                in_library.add(pk)
            asset_uuid = uuid_text(asset_uuid) or ""
            rel = _build_dcim_path(directory, filename) if directory and filename else None
            if asset_kind == 1 and rel:
                videos[asset_uuid] = rel
            file_hash = self._file_hash_for(backup, rel, filename or "")
            if file_hash is not None:
                present.add(pk)
                present_uuids.add(asset_uuid)
                if asset_kind != 1:  # ZKIND 1 is a video
                    stills[asset_uuid] = file_hash
            elif self._missing_from_folder(backup, rel):
                missing.add(pk)
                missing_uuids.add(asset_uuid)

        def tally(pks: set) -> dict:
            return {"library": len(pks & in_library), "albums": {}, "smart": {}}

        found, lost = tally(present), tally(missing)
        junc_table, albums_col, assets_col = self._inner._find_album_junction(conn)
        if junc_table:
            for album, asset in conn.execute(
                f"SELECT {albums_col}, {assets_col} FROM '{junc_table}' WHERE {albums_col} IS NOT NULL"
            ):
                for pks, part in ((present, found), (missing, lost)):
                    if asset in pks:
                        part["albums"][str(album)] = part["albums"].get(str(album), 0) + 1

        # Favorites and Hidden, with the library's own filters, so these counts match their listings too.
        for album_id in SMART_ALBUMS:
            where = smart_album_where(columns, album_id)
            pks = [pk for (pk,) in conn.execute(f"SELECT Z_PK FROM {assets} WHERE {where}")]
            found["smart"][album_id] = sum(1 for pk in pks if pk in present)
            lost["smart"][album_id] = sum(1 for pk in pks if pk in missing)
        return {**found, "has_albums": bool(junc_table), "present": frozenset(present), "missing": lost,
                "missing_ids": frozenset(missing),
                "present_uuids": frozenset(present_uuids), "missing_uuids": frozenset(missing_uuids),
                "stills": stills, "videos": videos}

    def _list_photos_from_dcim(self, backup, offset: int, limit: int) -> dict:
        """Fallback: enumerate files directly from DCIM via Manifest.db."""
        files = backup.list_files(domain="CameraRollDomain", path_like="Media/DCIM/%")
        media_files = []
        missing = 0
        for f in files:
            ext = os.path.splitext(f["path"])[1].lower()
            if ext in PHOTO_EXTENSIONS:
                kind = "photo"
            elif ext in VIDEO_EXTENSIONS:
                kind = "video"
            else:
                continue
            if not backup_files.is_stored(backup, f["hash"]):
                missing += 1
                continue
            file_hash = f"dcim:{f['path']}" if backup.encrypted else f["hash"]
            media_files.append({
                "uuid": f["hash"],
                "filename": os.path.basename(f["path"]),
                "file_hash": file_hash,
                "kind": kind,
                "date_created": None,
                "date_modified": None,
                "width": 0,
                "height": 0,
                "duration": 0.0,
                "favorite": False,
                "hidden": False,
                "has_adjustments": False,
                "burst_uuid": None,
                "latitude": None,
                "longitude": None,
                "album_ids": [],
            })

        media_files.sort(key=lambda x: x["filename"], reverse=True)
        total = len(media_files)
        return {
            "photos": media_files[offset:offset + limit],
            "total": total,
            "in_backup": total,
            "not_in_backup": 0,
            "missing_from_folder": missing,
            "offset": offset,
            "limit": limit,
            "source": "dcim_scan",
        }

    # ── openextract-only: thumbnail / full / path / export ──────────────────

    def get_thumbnail(self, backup, file_hash: str, size: int = 200) -> dict:
        """Generate a thumbnail as base64 JPEG. Results are in-memory cached."""
        cache_key = f"{file_hash}:{size}"
        if cache_key in self._thumb_cache:
            return {"data": self._thumb_cache[cache_key], "mime_type": "image/jpeg",
                    "cached": True}

        if not HAS_PIL:
            print(f"[THUMB] Pillow not installed — cannot generate thumbnail for {file_hash[:12]}", file=sys.stderr, flush=True)
            return {"error": "Pillow not installed"}

        # A video by its name, before anything is read: finding that out from the file meant
        # copying a whole video out of an encrypted backup first, seconds for a long one, while
        # every thumbnail after it waited (the engine answers one request at a time).
        original = self._original_path(backup, file_hash)
        if original and os.path.splitext(original)[1].lower() in VIDEO_EXTENSIONS | _MORE_VIDEO_EXTENSIONS:
            return {"error": "video", "is_video": True}

        # The iPhone's own thumbnail when the backup has it: a small JPEG, read in a few
        # milliseconds, where decoding a full-size HEIC from a recent iPhone takes a few
        # hundred (one at a time, so a grid of them filled slowly).
        own = self._iphone_thumbnail(backup, file_hash, size)
        if own is not None:
            if len(self._thumb_cache) >= 500:
                del self._thumb_cache[next(iter(self._thumb_cache))]
            self._thumb_cache[cache_key] = own["data"]
            return {**own, "cached": False}

        file_path = self._resolve_file(backup, file_hash)
        if not file_path:
            self._thumb_fail_count += 1
            if self._thumb_fail_count <= 5:
                print(f"[THUMB] File not found on disk for hash {file_hash[:40]}", file=sys.stderr, flush=True)
                if self._thumb_fail_count == 5:
                    print("[THUMB] Suppressing further 'not found' warnings", file=sys.stderr, flush=True)
            return {"error": "Photo not found"}

        # Skip video files early — PIL cannot open them
        _VIDEO_EXTS = {".mov", ".mp4", ".m4v", ".avi", ".mkv", ".3gp", ".m4a", ".webm"}
        ext = os.path.splitext(file_path)[1].lower()
        if ext in _VIDEO_EXTS:
            return {"error": "video", "is_video": True}

        try:
            img = Image.open(file_path)
            img.thumbnail((size, size), Image.LANCZOS)
            if img.mode in ("RGBA", "P", "LA"):
                img = img.convert("RGB")

            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=80, optimize=True)
            data = base64.b64encode(buf.getvalue()).decode("ascii")

            # Cap cache at 500 entries (simple FIFO eviction)
            if len(self._thumb_cache) >= 500:
                del self._thumb_cache[next(iter(self._thumb_cache))]
            self._thumb_cache[cache_key] = data

            return {
                "data": data,
                "mime_type": "image/jpeg",
                "width": img.width,
                "height": img.height,
                "cached": False,
            }
        except Exception as e:
            # Probe magic bytes to give a specific, actionable error
            fmt = "unknown"
            try:
                with open(file_path, "rb") as _f:
                    hdr = _f.read(16)
                if hdr[:3] == b"\xff\xd8\xff":
                    fmt = "jpeg"
                elif hdr[:8] == b"\x89PNG\r\n\x1a\n":
                    fmt = "png"
                elif hdr[4:8] == b"ftyp":
                    brand = hdr[8:12]
                    if brand in (b"heic", b"heix", b"mif1", b"hevc", b"hevx",
                                 b"heim", b"heis", b"hevm", b"hevs"):
                        fmt = "heic"
                    elif brand in (b"qt  ", b"mp41", b"mp42", b"isom",
                                   b"M4V ", b"M4A ", b"f4v ", b"avc1"):
                        fmt = "video"
                    else:
                        fmt = f"ftyp({brand.decode(errors='replace')})"
            except Exception:
                pass
            print(f"[THUMB] PIL fail — detected format={fmt} file={file_path} err={e}",
                  file=sys.stderr, flush=True)
            if fmt == "video":
                return {"error": "video", "is_video": True}
            return {"error": f"Failed to generate thumbnail: {e}"}

    def _iphone_thumbnails(self, backup) -> dict:
        """{photo's path under Media/ ("DCIM/100APPLE/IMG_0001.HEIC"): thumbnail key for _resolve_file},
        for the thumbnails the iPhone's Photos app made, read once per backup.

        Photos keeps them at Media/PhotoData/Thumbnails/V2/<photo's path under Media/>/<n>.JPG
        (5005.JPG on iOS 17, 480 pixels on the long side, upright; 5003.JPG on iOS 13).
        Where several are kept for one photo, the highest-numbered. Only files the backup's
        folder has (OE-102). The key is ``dcim:<path>`` for an encrypted backup, as list_photos
        gives originals, else the file's id.
        """
        cached = self._iphone_thumbs_cache.get(backup)
        if cached is None:
            found: dict = {}
            try:
                files = backup.list_files(domain="CameraRollDomain", path_like=_IPHONE_THUMBNAILS + "%")
            except Exception as e:  # noqa: BLE001  no thumbnails is fine: the originals are used
                print(f"[photos] couldn't list the iPhone's thumbnails: {e}", file=sys.stderr, flush=True)
                files = []
            for f in files:
                photo, _, name = f["path"][len(_IPHONE_THUMBNAILS):].rpartition("/")
                stem, ext = os.path.splitext(name)
                if not photo or ext.upper() != ".JPG" or not stem.isdigit() or not backup_files.is_stored(backup, f["hash"]):
                    continue
                if photo not in found or int(stem) > found[photo][0]:
                    found[photo] = (int(stem), f"dcim:{f['path']}" if backup.encrypted else f["hash"])
            cached = {photo: key for photo, (_, key) in found.items()}
            self._iphone_thumbs_cache[backup] = cached
        return cached

    def _original_path(self, backup, file_hash: str) -> Optional[str]:
        """The CameraRollDomain path of the original list_photos gave ``file_hash`` for, or None if unknown."""
        if file_hash.startswith("dcim:"):
            return file_hash[len("dcim:"):]
        paths = self._original_paths_cache.get(backup)
        if paths is None:
            paths = {h: p for p, h in self._original_files(backup)[0].items()}
            self._original_paths_cache[backup] = paths
        return paths.get(file_hash)

    def _iphone_thumbnail(self, backup, file_hash: str, size: int) -> Optional[dict]:
        """get_thumbnail's answer from the iPhone's own thumbnail of a still photo, or None to use the original.

        None too when that thumbnail is smaller than ``size`` or can't be read.
        """
        thumbnails = self._iphone_thumbnails(backup)
        if not thumbnails:
            return None
        path = self._original_path(backup, file_hash)
        if not path or not path.startswith("Media/") or os.path.splitext(path)[1].lower() in VIDEO_EXTENSIONS:
            return None
        key = thumbnails.get(path[len("Media/"):])
        thumb_path = key and self._resolve_file(backup, key)
        if not thumb_path:
            return None
        try:
            from PIL import ImageOps

            img = ImageOps.exif_transpose(Image.open(thumb_path))
            if max(img.size) < size:
                return None
            img.thumbnail((size, size), Image.LANCZOS)
            img = img.convert("RGB")
            buf = io.BytesIO()
            img.save(buf, format="JPEG", quality=80, optimize=True)
            return {"data": base64.b64encode(buf.getvalue()).decode("ascii"), "mime_type": "image/jpeg",
                    "width": img.width, "height": img.height}
        except Exception as e:  # noqa: BLE001  the original is used instead
            print(f"[THUMB] the iPhone's thumbnail of {path} couldn't be read: {e}", file=sys.stderr, flush=True)
            return None

    def get_photo(self, backup, file_hash: str) -> dict:
        """Return full-resolution photo as base64.

        Backup files are stored without extensions (named by SHA-1 hash), so
        we cannot rely on os.path.splitext for format detection. Try PIL
        first — it reads magic bytes and handles JPEG/PNG/HEIC (via
        pillow-heif) transparently. Non-image files (videos) fall through to
        raw-bytes delivery with a mime_type detected from the file header.
        """
        file_path = self._resolve_file(backup, file_hash)
        if not file_path:
            return {"error": "Photo not found"}

        try:
            if HAS_PIL:
                try:
                    img = Image.open(file_path)
                    if img.mode in ("RGBA", "P", "LA"):
                        img = img.convert("RGB")
                    buf = io.BytesIO()
                    img.save(buf, format="JPEG", quality=92)
                    data = base64.b64encode(buf.getvalue()).decode("ascii")
                    return {
                        "data": data,
                        "mime_type": "image/jpeg",
                        "filename": file_hash[:12] + ".jpg",
                        "converted": True,
                    }
                except Exception:
                    pass  # Not an image PIL recognises (e.g. video) — fall through

            with open(file_path, "rb") as f:
                raw = f.read()

            hdr = raw[:16]
            if hdr[:3] == b"\xff\xd8\xff":
                mime_type = "image/jpeg"
            elif hdr[:8] == b"\x89PNG\r\n\x1a\n":
                mime_type = "image/png"
            elif hdr[4:8] == b"ftyp":
                brand = hdr[8:12]
                if brand in (b"heic", b"heix", b"mif1", b"hevc", b"hevx"):
                    mime_type = "image/heic"
                elif brand in (b"qt  ", b"mp41", b"mp42", b"isom"):
                    mime_type = "video/mp4"
                else:
                    mime_type = "video/mp4"
            elif hdr[:4] in (b"ftyp", b"moov", b"mdat"):
                mime_type = "video/mp4"
            else:
                mime_type = "application/octet-stream"

            return {
                "data": base64.b64encode(raw).decode("ascii"),
                "mime_type": mime_type,
                "filename": file_hash[:12],
                "converted": False,
            }
        except Exception as e:
            return {"error": f"Failed to read photo: {e}"}

    def export_photos(self, backup, output_dir: str, options: dict = None,
                      on_progress: Optional[ProgressCallback] = None) -> dict:
        """Export photos with configurable format, folder structure, and metadata sidecars.

        Options:
          include_videos (bool)             - default True
          include_live_photo_videos (bool)  - default True
          format (str)                      - "original" | "jpeg"
          jpeg_quality (int)                - 60-100, default 90
          folder_structure (str)            - "flat" | "by_date"
          include_metadata_sidecar (bool)   - default False
          album_id (str)                    - save what list_photos lists for this album
                                              (an album, Favorites or Hidden, or LIBRARY
                                              for every photo with the hidden ones);
                                              default All Photos, without hidden photos
          date_from, date_to (number)       - only the photos list_photos lists for
                                              these dates (Unix seconds, date_to left out)
          person_ids (list), person_match   - save what list_photos lists for these people
                                              ("any", the default, or "all")
          kind (str)                        - only photos of this kind ("video", ...)
          uuids (list)                      - only these photos, whatever album_id, the
                                              people and the dates say: the ones someone
                                              picked. One the backup has no file for is an error

        on_progress(done, total, failed) is told how far the save has got, a few
        times a second at most (see export_progress.py).
        Every file it writes gets the photo's date taken as its modified time;
        one that was already there is left entirely as it was.
        No photo or .json is written over another file: see save_names.py.
        ``exported`` counts the photos now in the folder, ``already_there`` the ones
        among them an earlier save had put there, which weren't copied again.
        """
        if options is None:
            options = {}

        include_videos = options.get("include_videos", True)
        include_live = options.get("include_live_photo_videos", True)
        fmt = options.get("format", "original")
        jpeg_quality = max(60, min(100, int(options.get("jpeg_quality", 90))))
        folder_structure = options.get("folder_structure", "flat")
        include_sidecar = options.get("include_metadata_sidecar", False)
        album_id = options.get("album_id") or None
        date_from, date_to = options.get("date_from"), options.get("date_to")
        person_ids = options.get("person_ids") or None
        person_match = options.get("person_match") or "any"
        only_kind = options.get("kind") or None
        uuids = options.get("uuids")

        os.makedirs(output_dir, exist_ok=True)

        errors = 0
        result: dict = {}
        if uuids is not None:
            all_photos = self.photos_by_uuid(backup, uuids)
            errors = len({str(u) for u in uuids if u}) - len(all_photos)
        else:
            # Load all assets in batches via this adapter (so file_hash is populated)
            all_photos = []
            offset = 0
            batch = 200
            # Only the filters that are set, so a list_photos without them still works.
            narrow = {k: v for k, v in (("date_from", date_from), ("date_to", date_to)) if v is not None}
            if person_ids:
                narrow.update(person_ids=person_ids, person_match=person_match)
            while True:
                result = self.list_photos(backup, offset=offset, limit=batch, album_id=album_id, **narrow)
                all_photos.extend(result["photos"])
                if offset + batch >= result["total"]:
                    break
                offset += batch
        if only_kind:
            all_photos = [p for p in all_photos if p.get("kind") == only_kind]

        exported = 0
        already_there = 0
        names = SaveNames()
        # Picked photos it couldn't find count as failed from the start, so they're in the total too.
        progress = ExportProgress(on_progress, errors + sum(
            1 for p in all_photos
            if (include_videos or p.get("kind") != "video") and (include_live or p.get("kind") != "live_photo")
        ))

        for photo in all_photos:
            progress.update(exported + errors, errors)
            file_hash = photo.get("file_hash")
            if not file_hash:
                errors += 1
                continue

            kind = photo.get("kind", "photo")
            if kind == "video" and not include_videos:
                continue
            if kind == "live_photo" and not include_live:
                continue

            try:
                subfolder = self._export_subfolder(photo, folder_structure)
                dest_dir = os.path.join(output_dir, subfolder) if subfolder else output_dir
                os.makedirs(dest_dir, exist_ok=True)

                source = self._resolve_file(backup, file_hash)
                if not source or not os.path.exists(source):
                    errors += 1
                    continue

                filename = photo.get("filename") or file_hash
                base, ext = os.path.splitext(filename)
                taken = _date_taken(photo)

                if fmt == "jpeg" and ext.lower() in (".heic", ".heif") and HAS_PIL:
                    with Image.open(source) as img:
                        exif = _jpeg_exif(img, taken)
                        rgb = img.convert("RGB") if img.mode in ("RGBA", "P", "LA") else img
                        buf = io.BytesIO()
                        rgb.save(buf, format="JPEG", quality=jpeg_quality, exif=exif)
                    jpeg = buf.getvalue()
                    dest_path, there = names.place(dest_dir, base + ".jpg", lambda p: holds(p, jpeg))
                    if not there:
                        write_new(dest_path, jpeg)
                else:
                    dest_path, there = names.place(dest_dir, filename, lambda p: same_file(p, source))
                    if not there:
                        copy_new(source, dest_path)
                if not there:
                    _set_file_date(dest_path, taken)
                else:
                    already_there += 1

                exported += 1

                if include_sidecar:
                    meta = {k: v for k, v in photo.items() if k != "file_hash"}
                    # os.linesep, as earlier saves wrote it, so saving again finds those the same
                    sidecar = json.dumps(meta, indent=2, default=str).replace("\n", os.linesep).encode("utf-8")
                    sidecar_path, there = names.place(
                        dest_dir, os.path.basename(dest_path) + ".json", lambda p: holds(p, sidecar))
                    if not there:
                        write_new(sidecar_path, sidecar)
                        _set_file_date(sidecar_path, taken)

            except Exception:
                errors += 1

        progress.update(exported + errors, errors)
        return {
            "exported": exported,
            "already_there": already_there,
            "errors": errors,
            # Library items left out because the backup has no file for them
            # (only in iCloud). list_photos never returns them, so they aren't errors.
            "not_in_backup": result.get("not_in_backup", 0),
            # Left out because the backup lists them but its folder doesn't have them (OE-102).
            "missing_from_folder": result.get("missing_from_folder", 0),
            "output_dir": output_dir,
        }

    # ── Private helpers ──────────────────────────────────────────────────────

    def _export_subfolder(self, photo: dict, folder_structure: str) -> str:
        """Return the relative subfolder path for a photo based on folder_structure."""
        if folder_structure == "by_date":
            date_str = photo.get("date_created")
            if date_str:
                try:
                    dt = datetime.datetime.fromisoformat(date_str)
                    return os.path.join(str(dt.year), f"{dt.month:02d}")
                except Exception:
                    pass
            return "Unknown Date"
        return ""

    def get_file_for_app(self, backup, file_hash: str, on_progress: Optional[CopyProgress] = None) -> dict:
        """A photo or video as a file another app can open: ``{path, filename, openable}``, or ``{error}``.

        Never the file where it lies in an unencrypted backup. There it is
        named by its hash, with no extension, so the computer can't tell what
        opens it, and from a drive that marks every file executable macOS runs
        it: clicking a video opened Terminal (issue #297). It is copied out
        under the name the iPhone gave it (app_copies.py). An encrypted
        backup's file has already been decrypted to a temp file that keeps its
        extension, and that file is the answer.

        ``openable`` is True only when the name's extension is a photo's or a
        video's (app_copies.OPENABLE_EXTENSIONS): the app opens nothing else,
        it only shows it in its folder. ``on_progress(bytes copied, bytes in
        all)`` is called while a copy is made.
        """
        src = self._resolve_file(backup, file_hash)
        if not src:
            return {"error": FILE_NOT_FOUND}
        own_name = self._name_in_backup(backup, file_hash) or os.path.basename(src)
        name = join_name(*split_name(own_name), "Video")
        if os.path.splitext(src)[1] and not _is_inside(src, getattr(backup, "backup_dir", None)):
            return {"path": src, "filename": name, "openable": is_openable(src)}
        try:
            # A folder per backup and file: two videos can have one name. A short
            # digest of the file's key tells them apart and keeps the path short for Windows.
            key = hashlib.sha1(file_hash.encode("utf-8", "replace")).hexdigest()[:16]
            path = self._copies.copy(src, (getattr(backup, "udid", ""), key), name, on_progress)
        except NotEnoughSpace as e:
            print(f"[photos] no room to copy {file_hash} to open it: {e}", file=sys.stderr, flush=True)
            return {"error": NO_ROOM_TO_COPY.format(size=_size_words(e.needed), free=_size_words(e.free))}
        except OSError as e:
            print(f"[photos] could not copy {file_hash} to open it: {e}", file=sys.stderr, flush=True)
            return {"error": NOT_COPIED}
        return {"path": path, "filename": name, "openable": is_openable(name)}

    def _name_in_backup(self, backup, file_hash: str) -> str:
        """Where the iPhone kept the file stored under ``file_hash`` ("Media/DCIM/100APPLE/IMG_0042.MOV"),
        which ends in its own name; "" when the backup doesn't say."""
        if file_hash.startswith("dcim:"):
            return file_hash[len("dcim:"):]
        if getattr(backup, "encrypted", False):
            return ""  # its temp file keeps the extension (see get_file_for_app)
        try:
            manifest = backup.get_manifest_db()
            if not manifest:
                return ""
            conn = connect_readonly(manifest, backup)
            try:
                row = conn.execute("SELECT relativePath FROM Files WHERE fileID = ?", (file_hash,)).fetchone()
            finally:
                conn.close()
        except Exception as e:
            print(f"[photos] could not look up the name of {file_hash}: {e}", file=sys.stderr, flush=True)
            return ""
        return (row[0] or "") if row else ""

    def _resolve_file(self, backup, file_hash: str) -> Optional[str]:
        """Resolve a file hash (or path-based key) to an absolute path on disk.

        For unencrypted backups, files sit at backup_dir/XX/XXXX... (directly
        in backup_dir for iOS 9 and earlier) and can be read directly. For
        encrypted backups the Manifest.db is also
        encrypted, so list_photos stores ``dcim:<relative_path>`` as the
        file_hash. We detect that prefix here and call backup.get_file()
        directly instead of going through the manifest.

        For reading the file here in the engine. A path for another app to
        open comes from get_file_for_app, never straight from this.
        """
        if file_hash.startswith("dcim:"):
            return backup.get_file(file_hash[len("dcim:"):], domain="CameraRollDomain")

        if not backup.encrypted:
            for source in (os.path.join(backup.backup_dir, file_hash[:2], file_hash),
                           os.path.join(backup.backup_dir, file_hash)):  # iOS 9 and earlier
                if os.path.isfile(source):
                    return source

        # Look up the logical path by fileID hash, then let backup.get_file()
        # handle extraction / decryption into a temp file.
        if backup.encrypted and backup._decrypted_backup:
            try:
                with backup._decrypted_backup.manifest_db_cursor() as cur:
                    cur.execute(
                        "SELECT domain, relativePath FROM Files WHERE fileID = ?",
                        (file_hash,)
                    )
                    row = cur.fetchone()
                if row:
                    extracted = backup.get_file(row[1], domain=row[0])
                    if extracted:
                        return extracted
            except Exception:
                pass
        else:
            manifest = backup.get_manifest_db()
            if manifest:
                try:
                    conn = connect_readonly(manifest, backup)
                    row = conn.execute(
                        "SELECT domain, relativePath FROM Files WHERE fileID = ?",
                        (file_hash,)
                    ).fetchone()
                    conn.close()
                    if row:
                        extracted = backup.get_file(row[1], domain=row[0])
                        if extracted:
                            return extracted
                except Exception:
                    pass

        return None
