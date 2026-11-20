"""
Call history adapter.

Delegates ``list_calls`` to ``ios_backup_core.extractors.calls.CallExtractor``
and keeps openextract's export: a spreadsheet (CSV), a web page, plain text,
or the print-ready page Electron prints to a PDF (record_document.py). Dates
are in the computer's time zone (local_dates.py); the library gives them in UTC.
"""

import csv
import os

from ios_backup_core.extractors.calls import CallExtractor as _CoreCallExtractor

from local_dates import csv_date, readable_date
from record_document import (
    CSV_ENCODING,
    DOCUMENT_FORMATS,
    Column,
    RecordDocument,
    Section,
    date_span,
    plural,
    unused_path,
    write_document,
)

FORMATS = ("csv",) + DOCUMENT_FORMATS

# The file every format is named after ("call_history.csv", "call_history (2).csv" beside it)
FILE_BASE = "call_history"

CSV_HEADER = ["Date", "Contact Name", "Phone/Email", "Direction", "Status", "Duration (s)", "App/Service"]


def call_kind(call: dict) -> str:
    """What the Calls screen says in its Call column."""
    if call.get("status") == "missed":
        return "Missed"
    return {"incoming": "Incoming", "outgoing": "Outgoing"}.get(call.get("direction"), "Unknown")


def call_duration(seconds) -> str:
    """"0s", "45s", "4m 2s", "1h 2m": as the Calls screen shows it."""
    try:
        total = int(round(float(seconds or 0)))
    except (TypeError, ValueError, OverflowError):
        return ""
    if total <= 0:
        return "0s"
    h, rest = divmod(total, 3600)
    m, s = divmod(rest, 60)
    parts = [f"{h}h"] if h else []
    if m:
        parts.append(f"{m}m")
    if s or not parts:
        parts.append(f"{s}s")
    return " ".join(parts)


class CallExtractor:
    """Adapter wrapping the ios-backup-core CallExtractor."""

    # The time zone saved dates are written in; None is this computer's.
    local_tz = None

    def __init__(self):
        self._inner = _CoreCallExtractor()

    def list_calls(self, backup, contacts: dict,
                   offset: int = 0, limit: int = 200) -> dict:
        return self._inner.list_calls(backup, contacts, offset, limit)

    # ── openextract-only: export to disk ─────────────────────────────────────

    def export_calls_csv(self, backup, contacts: dict, output_dir: str) -> dict:
        """Every call as a spreadsheet (kept for callers from before formats)."""
        return self.export_calls(backup, contacts, output_dir, "csv")

    def export_calls(self, backup, contacts: dict, output_dir: str, fmt: str = "csv") -> dict:
        """Save every call into a new file in ``output_dir``.

        fmt: 'csv' (default), 'html', 'txt' or 'pdf_source'. Returns
        {success: True, path, file, count}; no calls is {success: False,
        error}; an unknown format is {error}.
        """
        fmt = str(fmt or "csv").lower()
        if fmt not in FORMATS:
            return {"error": f"Unsupported format: {fmt}"}

        # Every call: no page limit
        result = self.list_calls(backup, contacts, limit=999999)
        calls = result.get("calls", [])
        if not calls:
            return {"success": False, "error": "No calls found to export."}

        try:
            os.makedirs(output_dir, exist_ok=True)
            if fmt == "csv":
                path = self._write_csv(calls, output_dir)
            else:
                path = write_document(self._document(calls), output_dir, FILE_BASE, fmt)
            return {"success": True, "path": path, "file": path, "count": len(calls)}
        except Exception as e:  # noqa: BLE001 - the save's failure is the answer
            return {"success": False, "error": str(e)}

    def _write_csv(self, calls: list, output_dir: str) -> str:
        path = unused_path(output_dir, FILE_BASE, ".csv")
        with open(path, "w", newline="", encoding=CSV_ENCODING) as f:
            writer = csv.writer(f)
            writer.writerow(CSV_HEADER)
            for call in calls:
                writer.writerow([
                    csv_date(call["date"], self.local_tz),
                    call["contact_name"],
                    call["address"],
                    call["direction"].capitalize(),
                    call["status"].capitalize(),
                    call["duration"],
                    call["app"]
                ])
        return path

    def _document(self, calls: list) -> RecordDocument:
        rows = []
        for call in calls:
            address = call.get("address") or ""
            who = call.get("contact_name") or address or "Unknown"
            rows.append([
                readable_date(call.get("date"), self.local_tz),
                who,
                address if address != who else "",
                call_kind(call),
                call_duration(call.get("duration")),
                call.get("app") or "Phone",
            ])
        span = date_span((c.get("date") for c in calls), self.local_tz)
        return RecordDocument(
            title="Call history",
            summary=", ".join(filter(None, [plural(len(calls), "call"), span])),
            sections=[Section(
                columns=[Column("When", "when"), Column("Who"), Column("Number or email"), Column("Call"),
                         Column("How long", "number"), Column("App")],
                rows=rows,
            )],
        )
