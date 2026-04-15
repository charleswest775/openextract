"""
Browser history adapter.

Delegates ``has_browser_history`` and ``list_browser_history`` to
``ios_backup_core.extractors.browser_history.BrowserHistoryExtractor``.
Keeps openextract's CSV export wrapper.
"""

import csv
import os

from ios_backup_core.extractors.browser_history import (
    BrowserHistoryExtractor as _CoreBrowserHistoryExtractor,
)


class BrowserHistoryExtractor:
    """Adapter wrapping the ios-backup-core BrowserHistoryExtractor."""

    def __init__(self):
        self._inner = _CoreBrowserHistoryExtractor()

    def has_browser_history(self, backup) -> dict:
        return self._inner.has_browser_history(backup)

    def list_browser_history(self, backup, browser: str = "all",
                             offset: int = 0, limit: int = 0) -> dict:
        return self._inner.list_browser_history(backup, browser, offset, limit)

    # ── openextract-only: CSV export to disk ─────────────────────────────────

    def export_browser_history_csv(self, backup, output_dir: str,
                                    browser: str = "all") -> dict:
        """Export browser history to a CSV file."""
        result = self.list_browser_history(backup, browser, limit=0)
        visits = result.get("visits", [])

        if not visits:
            return {"success": False, "error": "No browser history found to export."}

        try:
            os.makedirs(output_dir, exist_ok=True)
            output_path = os.path.join(output_dir, "browser_history_export.csv")

            with open(output_path, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(["Date", "Browser", "URL", "Title", "Domain", "Visit Count"])
                for visit in visits:
                    writer.writerow([
                        visit["visit_date"],
                        visit["browser"].capitalize(),
                        visit["url"],
                        visit["title"],
                        visit["domain"],
                        visit["visit_count"] if visit["visit_count"] is not None else "",
                    ])

            return {"success": True, "path": output_path, "count": len(visits)}
        except Exception as e:
            return {"success": False, "error": str(e)}
