"""
Call history adapter.

Delegates ``list_calls`` to ``ios_backup_core.extractors.calls.CallExtractor``
and keeps openextract's CSV export wrapper.
"""

import csv
import os

from ios_backup_core.extractors.calls import CallExtractor as _CoreCallExtractor


class CallExtractor:
    """Adapter wrapping the ios-backup-core CallExtractor."""

    def __init__(self):
        self._inner = _CoreCallExtractor()

    def list_calls(self, backup, contacts: dict,
                   offset: int = 0, limit: int = 200) -> dict:
        return self._inner.list_calls(backup, contacts, offset, limit)

    # ── openextract-only: CSV export to disk ─────────────────────────────────

    def export_calls_csv(self, backup, contacts: dict, output_dir: str) -> dict:
        """Export all calls to a CSV file."""
        # Get all calls by ignoring limit
        result = self.list_calls(backup, contacts, limit=999999)
        calls = result.get("calls", [])

        if not calls:
            return {"success": False, "error": "No calls found to export."}

        try:
            os.makedirs(output_dir, exist_ok=True)
            output_path = os.path.join(output_dir, "call_history.csv")

            with open(output_path, "w", newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(["Date", "Contact Name", "Phone/Email", "Direction", "Status", "Duration (s)", "App/Service"])
                for call in calls:
                    writer.writerow([
                        call["date"],
                        call["contact_name"],
                        call["address"],
                        call["direction"].capitalize(),
                        call["status"].capitalize(),
                        call["duration"],
                        call["app"]
                    ])

            return {"success": True, "path": output_path, "count": len(calls)}
        except Exception as e:
            return {"success": False, "error": str(e)}
