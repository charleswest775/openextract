"""
Photo extraction adapter.

Delegates ``list_albums`` directly to ``ios_backup_core.extractors.photos.PhotoExtractor``.
For ``list_photos`` and ``get_photo_metadata`` the library returns assets with a
``relative_path`` field but no ``file_hash``; openextract's frontend addresses
photos by hash (so it can call ``get_photo``/``get_thumbnail``/``get_photo_path``
later without re-reading Photos.sqlite). This adapter post-processes the
library's output to add ``file_hash`` and filter iCloud-shared assets.

Kept openextract-local because the library intentionally omits them as
"UI concerns":
  * ``get_thumbnail``  — PIL/pillow-heif thumbnail generation, in-memory cache
  * ``get_photo``      — full-res JPEG re-encoding for HEIC, base64
  * ``get_photo_path`` (handler in main.py uses ``_resolve_file``)
  * ``export_photos``  — disk export (originals or transcoded JPEG, by-date subfolders)
  * DCIM directory-scan fallback for backups where Photos.sqlite is missing
"""

import base64
import datetime
import io
import json
import os
import shutil
import sqlite3
import sys
from typing import Optional

from ios_backup_core.extractors.photos import (
    PhotoExtractor as _CorePhotoExtractor,
    PHOTO_EXTENSIONS,
    VIDEO_EXTENSIONS,
    _build_dcim_path,
)

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


class PhotoExtractor:
    """Adapter wrapping the ios-backup-core PhotoExtractor."""

    def __init__(self):
        self._inner = _CorePhotoExtractor()
        # In-memory thumbnail cache (file_hash:size → base64 string)
        self._thumb_cache: dict = {}
        self._thumb_fail_count: int = 0

    # ── Delegated raw-extraction methods ─────────────────────────────────────

    def list_albums(self, backup) -> dict:
        return self._inner.list_albums(backup)

    def list_photos(self, backup, offset: int = 0, limit: int = 100,
                    album_id: Optional[str] = None) -> dict:
        """List photo assets, post-processed to add file_hash for downstream RPCs."""
        result = self._inner.list_photos(backup, offset, limit, album_id)

        # If the library returned nothing because Photos.sqlite is unavailable
        # (older iOS, corrupted backup), fall back to direct DCIM enumeration.
        if result.get("source") == "unavailable" or (
            not result.get("photos") and result.get("total", 0) == 0
        ):
            print("[photos] list_photos: using DCIM fallback (no album filter)",
                  file=sys.stderr, flush=True)
            return self._list_photos_from_dcim(backup, offset, limit)

        photos_out = []
        for asset in result.get("photos", []):
            adapted = self._add_file_hash(asset, backup)
            if adapted is not None:
                photos_out.append(adapted)

        return {
            "photos": photos_out,
            "total": result.get("total", len(photos_out)),
            "offset": result.get("offset", offset),
            "limit": result.get("limit", limit),
            "source": result.get("source", "photos_sqlite"),
        }

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

            zasset_cols = {
                col[1] for col in conn.execute("PRAGMA table_info('ZASSET')").fetchall()
            }

            def _col_or_null(name: str) -> str:
                return f"a.{name}" if name in zasset_cols else f"NULL AS {name}"

            meta_cols = ", ".join([
                _col_or_null("ZUUID"), _col_or_null("ZDIRECTORY"),
                _col_or_null("ZFILENAME"), _col_or_null("ZKIND"),
                _col_or_null("ZDATECREATED"), _col_or_null("ZDATEMODIFIED"),
                _col_or_null("ZWIDTH"), _col_or_null("ZHEIGHT"),
                _col_or_null("ZDURATION"), _col_or_null("ZFAVORITE"),
                _col_or_null("ZHIDDEN"), _col_or_null("ZHASADJUSTMENTS"),
                _col_or_null("ZBURSTUUID"), _col_or_null("ZLATITUDE"),
                _col_or_null("ZLONGITUDE"), "a.Z_PK",
            ])

            row = conn.execute(
                f"SELECT {meta_cols} FROM ZASSET a WHERE a.ZUUID = ?",
                (asset_uuid,)
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

        Returns None when the asset is unaddressable (no relative_path, iCloud
        shared, or — for unencrypted backups — its hash isn't in Manifest.db).
        """
        rel = asset.get("relative_path")
        filename = asset.get("filename") or ""
        if not rel:
            return None
        if "PhotoCloudSharingData" in rel or "PhotoCloudSharingData" in filename:
            return None

        if backup.encrypted:
            file_hash = f"dcim:{rel}"
        else:
            file_hash = backup._lookup_file_hash(rel, "CameraRollDomain")
            if not file_hash:
                return None

        asset = dict(asset)
        asset["file_hash"] = file_hash
        # Drop relative_path — openextract's frontend addresses by hash and
        # leaving the path adds ~50 bytes per asset to RPC payloads.
        asset.pop("relative_path", None)
        return asset

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

    def export_photos(self, backup, output_dir: str, options: dict = None) -> dict:
        """Export photos with configurable format, folder structure, and metadata sidecars.

        Options:
          include_videos (bool)             - default True
          include_live_photo_videos (bool)  - default True
          format (str)                      - "original" | "jpeg"
          jpeg_quality (int)                - 60-100, default 90
          folder_structure (str)            - "flat" | "by_date"
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

        # Load all assets in batches via this adapter (so file_hash is populated)
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

    def _resolve_file(self, backup, file_hash: str) -> Optional[str]:
        """Resolve a file hash (or path-based key) to an absolute path on disk.

        For unencrypted backups, files sit at backup_dir/XX/XXXX... and can
        be read directly. For encrypted backups the Manifest.db is also
        encrypted, so list_photos stores ``dcim:<relative_path>`` as the
        file_hash. We detect that prefix here and call backup.get_file()
        directly instead of going through the manifest.

        ``main.py:get_photo_path`` calls this method on the PhotoExtractor.
        """
        if file_hash.startswith("dcim:"):
            return backup.get_file(file_hash[len("dcim:"):], domain="CameraRollDomain")

        if not backup.encrypted:
            source = os.path.join(backup.backup_dir, file_hash[:2], file_hash)
            if os.path.exists(source):
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
