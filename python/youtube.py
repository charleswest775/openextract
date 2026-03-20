"""
YouTube app data extraction from iOS backups.

Extracts watch history, search history, and downloaded video metadata
from the com.google.ios.youtube app container.
"""

import sqlite3
import csv
import json
import os
import datetime
from typing import Optional


YOUTUBE_DOMAIN = "AppDomain-com.google.ios.youtube"

# Known database locations within the YouTube app container
# The YouTube app has evolved its internal structure across versions;
# we probe multiple known paths and fall back gracefully.
_WATCH_HISTORY_PATHS = [
    "Library/Application Support/YouTube/watch_history.db",
    "Library/Application Support/watch_history.db",
    "Library/Databases/watch_history.db",
]

_SEARCH_HISTORY_PATHS = [
    "Library/Application Support/YouTube/search_history.db",
    "Library/Application Support/search_history.db",
    "Library/Databases/search_history.db",
]

_DOWNLOADS_PATHS = [
    "Library/Application Support/YouTube/downloads.db",
    "Library/Application Support/offline.db",
    "Library/Application Support/YouTube/offline.db",
    "Library/Databases/downloads.db",
]


def _unix_to_iso(ts) -> Optional[str]:
    """Convert a Unix timestamp (int/float) to an ISO 8601 string, or None."""
    if ts is None:
        return None
    try:
        return datetime.datetime.utcfromtimestamp(float(ts)).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (ValueError, OSError, OverflowError):
        return None


def _open_db(path: str) -> Optional[sqlite3.Connection]:
    """Open a SQLite database in read-only mode. Returns None on failure."""
    try:
        conn = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
        conn.row_factory = sqlite3.Row
        return conn
    except Exception:
        return None


def _table_exists(conn: sqlite3.Connection, table: str) -> bool:
    try:
        conn.execute(f"SELECT 1 FROM {table} LIMIT 1")
        return True
    except sqlite3.Error:
        return False


def _columns(conn: sqlite3.Connection, table: str) -> list:
    try:
        info = conn.execute(f"PRAGMA table_info({table})").fetchall()
        return [row[1] for row in info]
    except sqlite3.Error:
        return []


class YouTubeExtractor:
    """Extracts YouTube app data from an iOS backup."""

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _probe_db(self, backup, paths: list, domain: str = YOUTUBE_DOMAIN):
        """Return the first resolvable (db_path, conn) pair from a list of candidate paths."""
        for rel_path in paths:
            db_path = backup.get_file(rel_path, domain=domain)
            if db_path:
                conn = _open_db(db_path)
                if conn:
                    return db_path, conn
        return None, None

    def _read_watch_history_db(self, conn: sqlite3.Connection) -> list:
        """Try to extract watch history rows from an open SQLite connection.

        YouTube has used at least two table layouts over the years; we detect
        which columns are present and adapt accordingly.
        """
        entries = []
        candidates = ["watch_history", "history", "view_history", "WatchHistory"]
        target_table = None
        for t in candidates:
            if _table_exists(conn, t):
                target_table = t
                break
        if target_table is None:
            return entries

        cols = _columns(conn, target_table)

        # Map flexible column names to our output fields
        video_id_col   = next((c for c in cols if c.lower() in ("video_id", "videoid", "id")), None)
        title_col      = next((c for c in cols if c.lower() in ("title", "video_title")), None)
        channel_col    = next((c for c in cols if c.lower() in ("channel_name", "channel", "author")), None)
        channel_id_col = next((c for c in cols if c.lower() in ("channel_id", "channelid")), None)
        watched_col    = next((c for c in cols if c.lower() in ("watched_at", "timestamp", "date", "time", "view_time")), None)
        duration_col   = next((c for c in cols if c.lower() in ("duration", "length_seconds", "length")), None)
        progress_col   = next((c for c in cols if c.lower() in ("progress", "position", "watch_time", "progress_seconds")), None)

        select_parts = []
        for alias, col in [
            ("video_id",    video_id_col),
            ("title",       title_col),
            ("channel",     channel_col),
            ("channel_id",  channel_id_col),
            ("watched_at",  watched_col),
            ("duration",    duration_col),
            ("progress",    progress_col),
        ]:
            select_parts.append(f"{col} AS {alias}" if col else f"NULL AS {alias}")

        try:
            rows = conn.execute(
                f"SELECT {', '.join(select_parts)} FROM {target_table} ORDER BY watched_at DESC"
            ).fetchall()
        except sqlite3.Error:
            return entries

        for row in rows:
            vid = row["video_id"] or ""
            entries.append({
                "video_id":   vid,
                "title":      row["title"] or "",
                "channel":    row["channel"] or "",
                "channel_id": row["channel_id"] or "",
                "watched_at": _unix_to_iso(row["watched_at"]),
                "duration":   row["duration"],
                "progress":   row["progress"],
                "url":        f"https://www.youtube.com/watch?v={vid}" if vid else "",
            })
        return entries

    def _read_search_history_db(self, conn: sqlite3.Connection) -> list:
        """Extract search history rows from an open SQLite connection."""
        entries = []
        candidates = ["search_history", "searches", "query_history", "SearchHistory"]
        target_table = None
        for t in candidates:
            if _table_exists(conn, t):
                target_table = t
                break
        if target_table is None:
            return entries

        cols = _columns(conn, target_table)
        query_col = next((c for c in cols if c.lower() in ("query", "search_query", "term", "text")), None)
        time_col  = next((c for c in cols if c.lower() in ("timestamp", "searched_at", "date", "time")), None)

        if not query_col:
            return entries

        select_parts = [
            f"{query_col} AS query",
            f"{time_col} AS searched_at" if time_col else "NULL AS searched_at",
        ]
        try:
            rows = conn.execute(
                f"SELECT {', '.join(select_parts)} FROM {target_table} ORDER BY searched_at DESC"
            ).fetchall()
        except sqlite3.Error:
            return entries

        for row in rows:
            entries.append({
                "query":       row["query"] or "",
                "searched_at": _unix_to_iso(row["searched_at"]),
            })
        return entries

    def _read_downloads_db(self, conn: sqlite3.Connection) -> list:
        """Extract downloaded video metadata from an open SQLite connection."""
        entries = []
        candidates = ["downloads", "offline_videos", "offline", "OfflineVideo"]
        target_table = None
        for t in candidates:
            if _table_exists(conn, t):
                target_table = t
                break
        if target_table is None:
            return entries

        cols = _columns(conn, target_table)

        video_id_col   = next((c for c in cols if c.lower() in ("video_id", "videoid", "id")), None)
        title_col      = next((c for c in cols if c.lower() in ("title", "video_title")), None)
        channel_col    = next((c for c in cols if c.lower() in ("channel_name", "channel", "author")), None)
        dl_at_col      = next((c for c in cols if c.lower() in ("downloaded_at", "created_at", "date", "timestamp")), None)
        file_size_col  = next((c for c in cols if c.lower() in ("file_size", "size", "bytes")), None)
        quality_col    = next((c for c in cols if c.lower() in ("quality", "resolution", "format")), None)
        duration_col   = next((c for c in cols if c.lower() in ("duration", "length_seconds", "length")), None)
        status_col     = next((c for c in cols if c.lower() in ("status", "download_status", "state")), None)

        select_parts = []
        for alias, col in [
            ("video_id",      video_id_col),
            ("title",         title_col),
            ("channel",       channel_col),
            ("downloaded_at", dl_at_col),
            ("file_size",     file_size_col),
            ("quality",       quality_col),
            ("duration",      duration_col),
            ("status",        status_col),
        ]:
            select_parts.append(f"{col} AS {alias}" if col else f"NULL AS {alias}")

        try:
            rows = conn.execute(
                f"SELECT {', '.join(select_parts)} FROM {target_table} ORDER BY downloaded_at DESC"
            ).fetchall()
        except sqlite3.Error:
            return entries

        for row in rows:
            vid = row["video_id"] or ""
            entries.append({
                "video_id":      vid,
                "title":         row["title"] or "",
                "channel":       row["channel"] or "",
                "downloaded_at": _unix_to_iso(row["downloaded_at"]),
                "file_size":     row["file_size"],
                "quality":       row["quality"] or "",
                "duration":      row["duration"],
                "status":        row["status"] or "",
                "url":           f"https://www.youtube.com/watch?v={vid}" if vid else "",
            })
        return entries

    # ── Public API ────────────────────────────────────────────────────────────

    def check_installed(self, backup) -> dict:
        """Return whether the YouTube app data is present in this backup."""
        files = backup.list_files(domain=YOUTUBE_DOMAIN, path_like="%")
        return {"installed": bool(files)}

    def list_watch_history(self, backup,
                           offset: int = 0, limit: int = 200) -> dict:
        """
        Return locally cached YouTube watch history entries.

        Most watch history lives in Google's servers; what appears here is only
        what the app has written to its local SQLite database.
        """
        _, conn = self._probe_db(backup, _WATCH_HISTORY_PATHS)
        if conn is None:
            # Database not found — app might not be installed or data is purely cloud-based
            return {
                "entries": [],
                "total": 0,
                "offset": offset,
                "limit": limit,
                "note": (
                    "No local YouTube watch history database found. "
                    "YouTube stores most history in your Google account. "
                    "Use Google Takeout at takeout.google.com for a full export."
                ),
            }

        try:
            all_entries = self._read_watch_history_db(conn)
        finally:
            conn.close()

        total = len(all_entries)
        page = all_entries[offset: offset + limit]
        return {
            "entries": page,
            "total": total,
            "offset": offset,
            "limit": limit,
        }

    def list_search_history(self, backup,
                            offset: int = 0, limit: int = 200) -> dict:
        """Return locally cached YouTube search history entries."""
        _, conn = self._probe_db(backup, _SEARCH_HISTORY_PATHS)
        if conn is None:
            return {
                "entries": [],
                "total": 0,
                "offset": offset,
                "limit": limit,
                "note": (
                    "No local YouTube search history database found. "
                    "Search history is stored in your Google account. "
                    "Use Google Takeout at takeout.google.com for a full export."
                ),
            }

        try:
            all_entries = self._read_search_history_db(conn)
        finally:
            conn.close()

        total = len(all_entries)
        page = all_entries[offset: offset + limit]
        return {
            "entries": page,
            "total": total,
            "offset": offset,
            "limit": limit,
        }

    def list_downloads(self, backup,
                       offset: int = 0, limit: int = 200) -> dict:
        """Return metadata for videos downloaded for offline viewing."""
        _, conn = self._probe_db(backup, _DOWNLOADS_PATHS)
        if conn is None:
            return {
                "entries": [],
                "total": 0,
                "offset": offset,
                "limit": limit,
                "note": "No downloaded videos database found.",
            }

        try:
            all_entries = self._read_downloads_db(conn)
        finally:
            conn.close()

        total = len(all_entries)
        page = all_entries[offset: offset + limit]
        return {
            "entries": page,
            "total": total,
            "offset": offset,
            "limit": limit,
        }

    def list_all_files(self, backup) -> dict:
        """List all files in the YouTube app container (useful for debugging)."""
        files = backup.list_files(domain=YOUTUBE_DOMAIN, path_like="%")
        return {"files": files or []}

    def export_youtube_data(self, backup, output_dir: str,
                            fmt: str = "csv") -> dict:
        """
        Export all available YouTube data to output_dir.

        fmt: 'csv' or 'json'
        Returns a summary of what was exported.
        """
        os.makedirs(output_dir, exist_ok=True)

        watch  = self.list_watch_history(backup, limit=999999)
        search = self.list_search_history(backup, limit=999999)
        dls    = self.list_downloads(backup, limit=999999)

        exported = []
        errors = []

        if fmt == "json":
            data = {
                "watch_history":  watch.get("entries", []),
                "search_history": search.get("entries", []),
                "downloads":      dls.get("entries", []),
            }
            out_path = os.path.join(output_dir, "youtube_export.json")
            try:
                with open(out_path, "w", encoding="utf-8") as f:
                    json.dump(data, f, indent=2, ensure_ascii=False)
                exported.append({"file": out_path, "type": "all"})
            except Exception as e:
                errors.append(str(e))
        else:
            # CSV — one file per data type
            try:
                _write_csv(
                    os.path.join(output_dir, "youtube_watch_history.csv"),
                    watch.get("entries", []),
                    ["video_id", "title", "channel", "channel_id", "watched_at",
                     "duration", "progress", "url"],
                )
                exported.append({
                    "file": os.path.join(output_dir, "youtube_watch_history.csv"),
                    "type": "watch_history",
                    "count": len(watch.get("entries", [])),
                })
            except Exception as e:
                errors.append(f"watch_history: {e}")

            try:
                _write_csv(
                    os.path.join(output_dir, "youtube_search_history.csv"),
                    search.get("entries", []),
                    ["query", "searched_at"],
                )
                exported.append({
                    "file": os.path.join(output_dir, "youtube_search_history.csv"),
                    "type": "search_history",
                    "count": len(search.get("entries", [])),
                })
            except Exception as e:
                errors.append(f"search_history: {e}")

            try:
                _write_csv(
                    os.path.join(output_dir, "youtube_downloads.csv"),
                    dls.get("entries", []),
                    ["video_id", "title", "channel", "downloaded_at",
                     "file_size", "quality", "duration", "status", "url"],
                )
                exported.append({
                    "file": os.path.join(output_dir, "youtube_downloads.csv"),
                    "type": "downloads",
                    "count": len(dls.get("entries", [])),
                })
            except Exception as e:
                errors.append(f"downloads: {e}")

        result = {"success": not errors, "exported": exported}
        if errors:
            result["errors"] = errors
        return result


# ── Module-level helpers ──────────────────────────────────────────────────────

def _write_csv(path: str, rows: list, fieldnames: list) -> None:
    with open(path, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(rows)
