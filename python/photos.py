"""
Photo extraction from CameraRollDomain.
Handles photo listing, thumbnail generation, album browsing, and export.
Reads Photos.sqlite for rich metadata; falls back to DCIM directory scan.
"""

import os
import sys
import base64
import io
import sqlite3
import shutil
import datetime
import json
from typing import Optional

HAS_HEIF = False
try:
    from PIL import Image
    HAS_PIL = True
    # Register HEIC/HEIF support when pillow-heif is installed.
    # This lets Pillow open .heic / .heif files that modern iPhones produce.
    try:
        from pillow_heif import register_heif_opener
        register_heif_opener()
        HAS_HEIF = True
    except Exception:
        pass  # pillow-heif not installed or failed; HEIC thumbnails will fail
except ImportError:
    HAS_PIL = False

print(f"[photos] PIL={HAS_PIL} HEIF={HAS_HEIF}", file=sys.stderr, flush=True)

# Apple CoreData epoch: Jan 1, 2001 00:00:00 UTC
_APPLE_EPOCH = datetime.datetime(2001, 1, 1, tzinfo=datetime.timezone.utc)

# ZASSET.ZKIND → kind label
_KIND_MAP = {
    0: "photo",
    1: "video",
    2: "live_photo",
    3: "live_photo",  # Some iOS versions use 3
}

PHOTO_EXTENSIONS = {".jpg", ".jpeg", ".png", ".heic", ".heif", ".gif", ".tiff", ".bmp"}
VIDEO_EXTENSIONS = {".mov", ".mp4", ".m4v", ".avi"}

_MIME_MAP = {
    ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".png": "image/png", ".gif": "image/gif",
    ".heic": "image/heic", ".heif": "image/heif",
    ".mov": "video/quicktime", ".mp4": "video/mp4",
    ".m4v": "video/mp4",
}


def _apple_ts_to_iso(ts) -> Optional[str]:
    """Convert Apple CoreData timestamp (seconds since 2001-01-01) to ISO 8601."""
    if ts is None:
        return None
    try:
        dt = _APPLE_EPOCH + datetime.timedelta(seconds=float(ts))
        return dt.isoformat()
    except Exception:
        return None


class PhotoExtractor:
    """Extracts photos and videos from iOS backups."""

    def __init__(self):
        # Simple in-memory thumbnail cache (file_hash:size → base64 string)
        self._thumb_cache: dict = {}

    # ─── Photos.sqlite helpers ────────────────────────────────────────────────

    def _open_photos_db(self, backup) -> Optional[sqlite3.Connection]:
        """Open Photos.sqlite from the backup. Returns a connection or None."""
        # In CameraRollDomain, the relativePath includes the "Media/" prefix on real backups.
        # Try both forms to handle different iOS versions.
        db_path = backup.get_file("Media/PhotoData/Photos.sqlite", domain="CameraRollDomain")
        if not db_path or not os.path.exists(db_path):
            db_path = backup.get_file("PhotoData/Photos.sqlite", domain="CameraRollDomain")
        if not db_path or not os.path.exists(db_path):
            print("[photos] _open_photos_db: Photos.sqlite not found in backup", file=sys.stderr, flush=True)
            return None
        try:
            conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
            conn.row_factory = sqlite3.Row
            return conn
        except Exception:
            try:
                # Fallback without read-only URI (some SQLite builds)
                conn = sqlite3.connect(db_path)
                conn.row_factory = sqlite3.Row
                return conn
            except Exception:
                return None

    def _find_album_junction(self, conn: sqlite3.Connection):
        """
        Dynamically locate the junction table between ZGENERICALBUM and ZASSET.
        Returns (table_name, albums_col, assets_col) or (None, None, None).
        iOS stores this as Z_<N>ASSETS where N is the album entity number.
        """
        try:
            cursor = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Z_%ASSETS'"
            )
            tables = [row[0] for row in cursor.fetchall()]
            for table in tables:
                pragma = conn.execute(f"PRAGMA table_info('{table}')").fetchall()
                col_names = [col[1] for col in pragma]
                albums_col = next((c for c in col_names if c.endswith("ALBUMS")), None)
                assets_col = next((c for c in col_names if c.endswith("ASSETS")), None)
                if albums_col and assets_col:
                    return table, albums_col, assets_col
        except Exception:
            pass
        return None, None, None

    def _asset_row_to_dict(self, row, album_ids: list, file_hash: str) -> dict:
        """Convert a ZASSET sqlite3.Row to a PhotoAsset dict."""
        filename = row["ZFILENAME"] or ""
        kind_int = row["ZKIND"] if row["ZKIND"] is not None else 0
        kind = _KIND_MAP.get(kind_int, "unknown")

        return {
            "uuid": row["ZUUID"] or "",
            "filename": filename,
            "file_hash": file_hash,
            "kind": kind,
            "date_created": _apple_ts_to_iso(row["ZDATECREATED"]),
            "date_modified": _apple_ts_to_iso(row["ZDATEMODIFIED"]),
            "width": row["ZWIDTH"] if row["ZWIDTH"] is not None else 0,
            "height": row["ZHEIGHT"] if row["ZHEIGHT"] is not None else 0,
            "duration": float(row["ZDURATION"]) if row["ZDURATION"] is not None else 0.0,
            "favorite": bool(row["ZFAVORITE"]),
            "hidden": bool(row["ZHIDDEN"]),
            "has_adjustments": bool(row["ZHASADJUSTMENTS"]),
            "burst_uuid": row["ZBURSTUUID"],
            "latitude": float(row["ZLATITUDE"]) if row["ZLATITUDE"] is not None else None,
            "longitude": float(row["ZLONGITUDE"]) if row["ZLONGITUDE"] is not None else None,
            "album_ids": album_ids,
        }

    # ─── Public API ───────────────────────────────────────────────────────────

    def list_albums(self, backup) -> dict:
        """List all photo albums from Photos.sqlite."""
        conn = self._open_photos_db(backup)
        if not conn:
            return {"albums": [], "source": "unavailable"}

        try:
            junc_table, albums_col, assets_col = self._find_album_junction(conn)

            # Count total non-trashed assets for "All Photos" album
            try:
                total_row = conn.execute(
                    "SELECT COUNT(*) FROM ZASSET WHERE ZTRASHEDSTATE = 0"
                ).fetchone()
                total_assets = total_row[0] if total_row else 0
            except sqlite3.OperationalError:
                total_row = conn.execute("SELECT COUNT(*) FROM ZASSET").fetchone()
                total_assets = total_row[0] if total_row else 0

            # Per-album asset counts via junction table
            album_counts: dict = {}
            if junc_table and albums_col and assets_col:
                try:
                    count_rows = conn.execute(
                        f"SELECT {albums_col}, COUNT(*) FROM '{junc_table}' "
                        f"WHERE {albums_col} IS NOT NULL GROUP BY {albums_col}"
                    ).fetchall()
                    album_counts = {r[0]: r[1] for r in count_rows}
                except Exception:
                    pass

            # Fetch album rows
            try:
                rows = conn.execute(
                    "SELECT Z_PK, ZTITLE, ZKIND FROM ZGENERICALBUM "
                    "WHERE ZTITLE IS NOT NULL ORDER BY ZTITLE ASC"
                ).fetchall()
            except sqlite3.OperationalError:
                conn.close()
                return {"albums": [], "source": "unavailable"}

            def album_kind(k):
                if k in (None, 2):
                    return "user"
                if k == 3:
                    return "smart"
                if k == 1505:
                    return "shared"
                return "user"

            albums = [{
                "id": "__all__",
                "title": "All Photos",
                "asset_count": total_assets,
                "kind": "smart",
            }]
            for row in rows:
                albums.append({
                    "id": str(row["Z_PK"]),
                    "title": row["ZTITLE"],
                    "asset_count": album_counts.get(row["Z_PK"], 0),
                    "kind": album_kind(row["ZKIND"]),
                })

            conn.close()
            return {"albums": albums, "source": "photos_sqlite"}

        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return {"albums": [], "error": str(e), "source": "error"}

    def list_photos(self, backup, offset: int = 0, limit: int = 100,
                    album_id: Optional[str] = None) -> dict:
        """
        List photo assets with rich metadata.
        Reads Photos.sqlite when available; falls back to DCIM directory scan.
        """
        conn = self._open_photos_db(backup)
        if conn:
            try:
                result = self._list_photos_from_db(backup, conn, offset, limit, album_id)
                conn.close()
                return result
            except Exception:
                try:
                    conn.close()
                except Exception:
                    pass
        return self._list_photos_from_dcim(backup, offset, limit)

    def _list_photos_from_db(self, backup, conn: sqlite3.Connection,
                              offset: int, limit: int,
                              album_id: Optional[str]) -> dict:
        """Query Photos.sqlite for a page of assets."""
        junc_table, albums_col, assets_col = self._find_album_junction(conn)

        asset_cols = (
            "a.ZUUID, a.ZDIRECTORY, a.ZFILENAME, a.ZKIND, "
            "a.ZDATECREATED, a.ZDATEMODIFIED, "
            "a.ZWIDTH, a.ZHEIGHT, a.ZDURATION, "
            "a.ZFAVORITE, a.ZHIDDEN, a.ZHASADJUSTMENTS, "
            "a.ZBURSTUUID, a.ZLATITUDE, a.ZLONGITUDE, a.Z_PK"
        )

        # Build query based on album filter
        if album_id and album_id != "__all__" and junc_table and albums_col and assets_col:
            where_trashed = "AND a.ZTRASHEDSTATE = 0"
            query = (
                f"SELECT {asset_cols} FROM ZASSET a "
                f"INNER JOIN '{junc_table}' j ON j.{assets_col} = a.Z_PK "
                f"WHERE j.{albums_col} = ? {where_trashed} "
                f"ORDER BY a.ZDATECREATED DESC LIMIT ? OFFSET ?"
            )
            count_query = (
                f"SELECT COUNT(*) FROM ZASSET a "
                f"INNER JOIN '{junc_table}' j ON j.{assets_col} = a.Z_PK "
                f"WHERE j.{albums_col} = ? {where_trashed}"
            )
            params = [int(album_id), limit, offset]
            count_params = [int(album_id)]
        else:
            query = (
                f"SELECT {asset_cols} FROM ZASSET a "
                f"WHERE a.ZTRASHEDSTATE = 0 "
                f"ORDER BY a.ZDATECREATED DESC LIMIT ? OFFSET ?"
            )
            count_query = "SELECT COUNT(*) FROM ZASSET WHERE ZTRASHEDSTATE = 0"
            params = [limit, offset]
            count_params = []

        # Try query; retry without ZTRASHEDSTATE if column missing (older iOS)
        try:
            rows = conn.execute(query, params).fetchall()
            total = conn.execute(count_query, count_params).fetchone()[0]
        except sqlite3.OperationalError:
            query = query.replace("a.ZTRASHEDSTATE = 0 AND ", "").replace(
                "WHERE a.ZTRASHEDSTATE = 0 ", "WHERE 1=1 "
            )
            count_query = count_query.replace(
                " WHERE a.ZTRASHEDSTATE = 0", ""
            ).replace("WHERE ZTRASHEDSTATE = 0", "")
            rows = conn.execute(query, params).fetchall()
            total = conn.execute(count_query, count_params).fetchone()[0]

        # Build asset PK → album IDs map for this page
        asset_pks = [row["Z_PK"] for row in rows]
        album_map: dict = {pk: [] for pk in asset_pks}
        if junc_table and albums_col and assets_col and asset_pks:
            placeholders = ",".join("?" * len(asset_pks))
            try:
                junc_rows = conn.execute(
                    f"SELECT {assets_col}, {albums_col} FROM '{junc_table}' "
                    f"WHERE {assets_col} IN ({placeholders})",
                    asset_pks
                ).fetchall()
                for jr in junc_rows:
                    a_pk, alb_pk = jr[0], jr[1]
                    if a_pk in album_map and alb_pk is not None:
                        album_map[a_pk].append(str(alb_pk))
            except Exception:
                pass

        # Resolve file_hash for each asset
        photos = []
        for row in rows:
            directory = row["ZDIRECTORY"] or ""
            filename = row["ZFILENAME"] or ""
            if directory:
                dcim_path = f"Media/DCIM/{directory}/{filename}"
            else:
                dcim_path = f"Media/DCIM/{filename}"

            if backup.encrypted:
                # Manifest.db is encrypted — cannot look up hash directly.
                # Use a path-based synthetic key; _resolve_file() understands it.
                file_hash = f"dcim:{dcim_path}"
            else:
                file_hash = backup._lookup_file_hash(dcim_path, "CameraRollDomain")
                if not file_hash:
                    continue  # Cannot resolve — skip

            asset = self._asset_row_to_dict(row, album_map.get(row["Z_PK"], []), file_hash)
            photos.append(asset)

        return {
            "photos": photos,
            "total": total,
            "offset": offset,
            "limit": limit,
            "source": "photos_sqlite",
        }

    def _list_photos_from_dcim(self, backup, offset: int, limit: int) -> dict:
        """Fallback: enumerate files directly from DCIM via Manifest.db."""
        files = backup.list_files(domain="CameraRollDomain", path_like="Media/DCIM/%")
        media_files = []
        for f in files:
            ext = os.path.splitext(f["path"])[1].lower()
            if ext in PHOTO_EXTENSIONS:
                kind = "photo"
            elif ext in VIDEO_EXTENSIONS:
                kind = "video"
            else:
                continue
            # For encrypted backups, use a path-based key so _resolve_file can
            # call backup.get_file() to decrypt on demand.
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
            "offset": offset,
            "limit": limit,
            "source": "dcim_scan",
        }

    def get_photo_metadata(self, backup, asset_uuid: str) -> dict:
        """Return full metadata for a single asset by UUID, including album names."""
        conn = self._open_photos_db(backup)
        if not conn:
            return {"error": "Photos.sqlite not available"}
        try:
            junc_table, albums_col, assets_col = self._find_album_junction(conn)

            row = conn.execute(
                "SELECT a.ZUUID, a.ZDIRECTORY, a.ZFILENAME, a.ZKIND, "
                "a.ZDATECREATED, a.ZDATEMODIFIED, "
                "a.ZWIDTH, a.ZHEIGHT, a.ZDURATION, "
                "a.ZFAVORITE, a.ZHIDDEN, a.ZHASADJUSTMENTS, "
                "a.ZBURSTUUID, a.ZLATITUDE, a.ZLONGITUDE, a.Z_PK "
                "FROM ZASSET a WHERE a.ZUUID = ?",
                (asset_uuid,)
            ).fetchone()

            if not row:
                conn.close()
                return {"error": "Asset not found"}

            album_ids = []
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
            dcim_path = (
                f"Media/DCIM/{directory}/{filename}" if directory
                else f"Media/DCIM/{filename}"
            )
            if backup.encrypted:
                file_hash = f"dcim:{dcim_path}"
            else:
                file_hash = backup._lookup_file_hash(dcim_path, "CameraRollDomain") or ""

            asset = self._asset_row_to_dict(row, album_ids, file_hash)
            asset["album_names"] = album_names
            conn.close()
            return asset

        except Exception as e:
            try:
                conn.close()
            except Exception:
                pass
            return {"error": str(e)}

    def get_thumbnail(self, backup, file_hash: str, size: int = 200) -> dict:
        """Generate a thumbnail as base64 JPEG. Results are in-memory cached."""
        cache_key = f"{file_hash}:{size}"
        if cache_key in self._thumb_cache:
            return {"data": self._thumb_cache[cache_key], "mime_type": "image/jpeg",
                    "cached": True}

        if not HAS_PIL:
            print(f"[THUMB] Pillow not installed — cannot generate thumbnail for {file_hash[:12]}", file=sys.stderr, flush=True)
            return {"error": "Pillow not installed"}

        file_path = self._resolve_file(backup, file_hash)
        if not file_path:
            print(f"[THUMB] File not found on disk for hash {file_hash[:12]}", file=sys.stderr, flush=True)
            return {"error": "Photo not found"}

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

    def get_photo(self, backup, file_hash: str) -> dict:
        """Return full-resolution photo as base64.

        Backup files are stored without extensions (named by SHA-1 hash), so
        we cannot rely on os.path.splitext for format detection.  Instead we
        try PIL first — it reads magic bytes and handles JPEG/PNG/HEIC (via
        pillow-heif) transparently.  Non-image files (videos) fall through to
        raw-bytes delivery with a mime_type detected from the file header.
        """
        file_path = self._resolve_file(backup, file_hash)
        if not file_path:
            return {"error": "Photo not found"}

        try:
            # ── Try PIL (format-agnostic, magic-byte based) ──────────────────
            # This handles JPEG, PNG, HEIC/HEIF (via pillow-heif), GIF, TIFF…
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
                    pass  # Not an image PIL recognises (e.g. video) → fall through

            # ── Fallback: raw bytes with magic-byte mime_type detection ───────
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

    def export_photos(self, backup, output_dir: str, options: dict = None) -> dict:
        """
        Export photos with configurable format, folder structure, and metadata sidecars.
        Options:
          include_videos (bool)         - default True
          include_live_photo_videos (bool) - default True
          format (str)                  - "original" | "jpeg"
          jpeg_quality (int)            - 60-100, default 90
          folder_structure (str)        - "flat" | "by_date" | "by_album"
          export_originals_if_edited (bool) - default False
          include_metadata_sidecar (bool)   - default False
        """
        if options is None:
            options = {}

        include_videos = options.get("include_videos", True)
        include_live = options.get("include_live_photo_videos", True)
        fmt = options.get("format", "original")
        jpeg_quality = max(60, min(100, int(options.get("jpeg_quality", 90))))
        folder_structure = options.get("folder_structure", "flat")
        include_sidecar = options.get("include_metadata_sidecar", False)

        os.makedirs(output_dir, exist_ok=True)

        # Load all assets in batches
        all_photos = []
        offset = 0
        batch = 200
        while True:
            result = self.list_photos(backup, offset=offset, limit=batch)
            all_photos.extend(result["photos"])
            if offset + batch >= result["total"]:
                break
            offset += batch

        exported = 0
        errors = 0

        for photo in all_photos:
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

                if fmt == "jpeg" and ext.lower() in (".heic", ".heif") and HAS_PIL:
                    dest_filename = base + ".jpg"
                    dest_path = os.path.join(dest_dir, dest_filename)
                    img = Image.open(source)
                    if img.mode in ("RGBA", "P", "LA"):
                        img = img.convert("RGB")
                    img.save(dest_path, format="JPEG", quality=jpeg_quality)
                else:
                    dest_path = os.path.join(dest_dir, filename)
                    shutil.copy2(source, dest_path)

                exported += 1

                if include_sidecar:
                    meta = {k: v for k, v in photo.items() if k != "file_hash"}
                    with open(dest_path + ".json", "w", encoding="utf-8") as f:
                        json.dump(meta, f, indent=2, default=str)

            except Exception:
                errors += 1

        return {
            "exported": exported,
            "errors": errors,
            "output_dir": output_dir,
        }

    # ─── Private helpers ──────────────────────────────────────────────────────

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

    def _resolve_file(self, backup, file_hash: str) -> Optional[str]:
        """Resolve a file hash (or path-based key) to an absolute path on disk.

        For unencrypted backups, files sit at backup_dir/XX/XXXX... and can
        be read directly.  For encrypted backups the Manifest.db is also
        encrypted, so _list_photos_from_db stores "dcim:<relative_path>"
        as the file_hash. We detect that prefix here and call backup.get_file()
        directly instead of going through the manifest.
        """
        if file_hash.startswith("dcim:"):
            # Path-based key written for encrypted backups — decrypt on demand.
            return backup.get_file(file_hash[len("dcim:"):], domain="CameraRollDomain")

        if not backup.encrypted:
            # Plain backup — file is readable at the hash-based path
            source = os.path.join(backup.backup_dir, file_hash[:2], file_hash)
            if os.path.exists(source):
                return source

        # Look up the logical path by fileID hash then let backup.get_file() handle
        # extraction / decryption into a temp file.
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
                    conn = sqlite3.connect(manifest)
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
