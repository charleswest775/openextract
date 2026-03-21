"""
Chrome browser data extraction from iOS backups.

Chrome for iOS stores its profile data under:
  AppDomain-com.google.chrome.ios / Library/Application Support/Google/Chrome/Default/

Supported data:
  - Browsing history  (History SQLite DB, tables: urls, visits)
  - Bookmarks         (Bookmarks JSON file)
"""

import sqlite3
import json
import csv
import os
from datetime import datetime, timezone
from typing import Optional

# Chrome timestamps are microseconds since 1601-01-01 00:00:00 UTC (Windows FILETIME epoch).
# Unix epoch starts at 1970-01-01 so we subtract the delta in seconds.
_CHROME_EPOCH_DELTA_S = 11_644_473_600


def _chrome_ts_to_iso(chrome_ts: Optional[int]) -> Optional[str]:
    """Convert a Chrome microsecond timestamp to an ISO-8601 string (UTC)."""
    if not chrome_ts:
        return None
    try:
        unix_s = chrome_ts / 1_000_000 - _CHROME_EPOCH_DELTA_S
        return datetime.fromtimestamp(unix_s, tz=timezone.utc).isoformat()
    except (OSError, OverflowError, ValueError):
        return None


def _flatten_bookmarks(node: dict, folder_path: str = "") -> list:
    """
    Recursively walk a Chrome bookmarks node and return a flat list of
    bookmark dicts (type == "url" only).

    Each returned dict has:
        id, name, url, folder, date_added (ISO)
    """
    results = []
    node_type = node.get("type")

    if node_type == "url":
        results.append({
            "id": node.get("id"),
            "name": node.get("name", ""),
            "url": node.get("url", ""),
            "folder": folder_path or "/",
            "date_added": _chrome_ts_to_iso(int(node["date_added"])) if node.get("date_added") else None,
        })
    elif node_type == "folder":
        folder_name = node.get("name", "")
        child_path = f"{folder_path}/{folder_name}" if folder_path else folder_name
        for child in node.get("children", []):
            results.extend(_flatten_bookmarks(child, child_path))

    return results


class ChromeExtractor:
    """Extracts Chrome browsing data from iOS backups."""

    CHROME_DOMAIN = "AppDomain-com.google.chrome.ios"
    _PROFILE_BASE = "Library/Application Support/Google/Chrome/Default"

    HISTORY_PATH = f"{_PROFILE_BASE}/History"
    BOOKMARKS_PATH = f"{_PROFILE_BASE}/Bookmarks"

    # ── History ───────────────────────────────────────────────────────────────

    def list_history(
        self,
        backup,
        offset: int = 0,
        limit: int = 500,
        query: Optional[str] = None,
    ) -> dict:
        """
        Return browsing history rows.

        Each row:
            url_id, url, title, visit_count, last_visit_time (ISO), typed_count
        """
        db_path = backup.get_file(self.HISTORY_PATH, domain=self.CHROME_DOMAIN)
        if not db_path:
            return {
                "history": [],
                "total": 0,
                "error": (
                    "Chrome history not found. "
                    "Make sure Google Chrome is installed on the device and "
                    "that the backup was created after Chrome was used."
                ),
            }

        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row

            # Build WHERE clause for optional full-text search
            where_clause = ""
            bind_params: list = []
            if query:
                where_clause = "WHERE u.url LIKE ? OR u.title LIKE ?"
                like = f"%{query}%"
                bind_params = [like, like]

            total_row = conn.execute(
                f"SELECT COUNT(*) FROM urls u {where_clause}", bind_params
            ).fetchone()
            total = total_row[0] if total_row else 0

            rows = conn.execute(
                f"""
                SELECT
                    u.id          AS url_id,
                    u.url,
                    u.title,
                    u.visit_count,
                    u.last_visit_time,
                    u.typed_count
                FROM urls u
                {where_clause}
                ORDER BY u.last_visit_time DESC
                LIMIT ? OFFSET ?
                """,
                bind_params + [limit, offset],
            ).fetchall()

            history = [
                {
                    "url_id": row["url_id"],
                    "url": row["url"],
                    "title": row["title"] or "",
                    "visit_count": row["visit_count"] or 0,
                    "last_visit_time": _chrome_ts_to_iso(row["last_visit_time"]),
                    "typed_count": row["typed_count"] or 0,
                }
                for row in rows
            ]
            conn.close()
        except sqlite3.Error as e:
            return {"history": [], "total": 0, "error": f"Failed to read Chrome history: {e}"}

        return {
            "history": history,
            "total": total,
            "offset": offset,
            "limit": limit,
        }

    def export_history_csv(self, backup, output_dir: str) -> dict:
        """Export all Chrome history to a CSV file."""
        result = self.list_history(backup, offset=0, limit=9_999_999)
        if result.get("error") and not result["history"]:
            return {"success": False, "error": result["error"]}

        history = result["history"]
        if not history:
            return {"success": False, "error": "No Chrome history found to export."}

        try:
            os.makedirs(output_dir, exist_ok=True)
            output_path = os.path.join(output_dir, "chrome_history.csv")
            with open(output_path, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(["Last Visit", "Title", "URL", "Visit Count", "Typed Count"])
                for row in history:
                    writer.writerow([
                        row["last_visit_time"] or "",
                        row["title"],
                        row["url"],
                        row["visit_count"],
                        row["typed_count"],
                    ])
            return {"success": True, "path": output_path, "count": len(history)}
        except OSError as e:
            return {"success": False, "error": str(e)}

    # ── Bookmarks ─────────────────────────────────────────────────────────────

    def list_bookmarks(self, backup) -> dict:
        """
        Return a flat list of all Chrome bookmarks.

        Each entry:
            id, name, url, folder, date_added (ISO)
        """
        bm_path = backup.get_file(self.BOOKMARKS_PATH, domain=self.CHROME_DOMAIN)
        if not bm_path:
            return {
                "bookmarks": [],
                "error": (
                    "Chrome bookmarks file not found. "
                    "Make sure Google Chrome is installed and has bookmarks saved."
                ),
            }

        try:
            with open(bm_path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            return {"bookmarks": [], "error": f"Failed to read Chrome bookmarks: {e}"}

        roots = data.get("roots", {})
        bookmarks: list = []
        for root_name, root_node in roots.items():
            # Skip meta/sync roots that aren't user-facing
            if root_name in ("sync_transaction_version",):
                continue
            bookmarks.extend(_flatten_bookmarks(root_node))

        return {"bookmarks": bookmarks, "total": len(bookmarks)}

    def export_bookmarks_json(self, backup, output_dir: str) -> dict:
        """Export all Chrome bookmarks to a JSON file."""
        result = self.list_bookmarks(backup)
        if result.get("error") and not result["bookmarks"]:
            return {"success": False, "error": result["error"]}

        bookmarks = result["bookmarks"]
        if not bookmarks:
            return {"success": False, "error": "No Chrome bookmarks found to export."}

        try:
            os.makedirs(output_dir, exist_ok=True)
            output_path = os.path.join(output_dir, "chrome_bookmarks.json")
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(bookmarks, f, indent=2, ensure_ascii=False)
            return {"success": True, "path": output_path, "count": len(bookmarks)}
        except OSError as e:
            return {"success": False, "error": str(e)}
