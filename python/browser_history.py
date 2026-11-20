"""
Browser history adapter.

Delegates ``has_browser_history`` and ``list_browser_history`` to
``ios_backup_core.extractors.browser_history.BrowserHistoryExtractor``.
Keeps openextract's export: a spreadsheet (CSV), a web page, plain text, or
the print-ready page Electron prints to a PDF (record_document.py). Dates are
in the computer's time zone (local_dates.py); the library gives them in UTC.
"""

import csv
import os

from ios_backup_core.extractors.browser_history import (
    BrowserHistoryExtractor as _CoreBrowserHistoryExtractor,
)

from local_dates import csv_date, readable_date
from record_document import (
    CSV_ENCODING,
    DOCUMENT_FORMATS,
    Column,
    RecordDocument,
    Section,
    csv_cell,
    date_span,
    plural,
    unused_path,
    write_document,
)

FORMATS = ("csv",) + DOCUMENT_FORMATS

# The file every format is named after ("browser_history_export.csv", then "… (2).csv")
FILE_BASE = "browser_history_export"

CSV_HEADER = ["Date", "Browser", "URL", "Title", "Domain", "Visit Count"]

_BROWSER_NAMES = {"safari": "Safari", "firefox": "Firefox"}


def _count(value) -> str:
    """"1,234", or "" when the browser didn't count."""
    if value is None or value == "":
        return ""
    return f"{value:,}" if isinstance(value, int) else str(value)


class BrowserHistoryExtractor:
    """Adapter wrapping the ios-backup-core BrowserHistoryExtractor."""

    # The time zone saved dates are written in; None is this computer's.
    local_tz = None

    def __init__(self):
        self._inner = _CoreBrowserHistoryExtractor()

    def has_browser_history(self, backup) -> dict:
        return self._inner.has_browser_history(backup)

    def list_browser_history(self, backup, browser: str = "all",
                             offset: int = 0, limit: int = 0) -> dict:
        return self._inner.list_browser_history(backup, browser, offset, limit)

    # ── openextract-only: export to disk ─────────────────────────────────────

    def export_browser_history_csv(self, backup, output_dir: str,
                                    browser: str = "all") -> dict:
        """Every visit as a spreadsheet (kept for callers from before formats)."""
        return self.export_browser_history(backup, output_dir, browser, "csv")

    def export_browser_history(self, backup, output_dir: str, browser: str = "all",
                               fmt: str = "csv") -> dict:
        """Save every visit (in ``browser``: 'all', 'safari' or 'firefox') into a
        new file in ``output_dir``.

        fmt: 'csv' (default), 'html', 'txt' or 'pdf_source'. Returns
        {success: True, path, file, count}; no history is {success: False,
        error}; an unknown format is {error}.
        """
        fmt = (fmt or "csv").lower()
        if fmt not in FORMATS:
            return {"error": f"Unsupported format: {fmt}"}

        result = self.list_browser_history(backup, browser, limit=0)
        visits = result.get("visits", [])
        if not visits:
            return {"success": False, "error": "No browser history found to export."}

        try:
            os.makedirs(output_dir, exist_ok=True)
            if fmt == "csv":
                path = self._write_csv(visits, output_dir)
            else:
                path = write_document(self._document(visits), output_dir, FILE_BASE, fmt)
            return {"success": True, "path": path, "file": path, "count": len(visits)}
        except Exception as e:  # noqa: BLE001 - the save's failure is the answer
            return {"success": False, "error": str(e)}

    def _write_csv(self, visits: list, output_dir: str) -> str:
        path = unused_path(output_dir, FILE_BASE, ".csv")
        with open(path, "w", newline="", encoding=CSV_ENCODING) as f:
            writer = csv.writer(f)
            writer.writerow(CSV_HEADER)
            for visit in visits:
                writer.writerow([
                    csv_date(visit["visit_date"], self.local_tz),
                    visit["browser"].capitalize(),
                    csv_cell(visit["url"]),
                    # A page's title is whatever the website chose
                    csv_cell(visit["title"]),
                    visit["domain"],
                    visit["visit_count"] if visit["visit_count"] is not None else "",
                ])
        return path

    def _document(self, visits: list) -> RecordDocument:
        rows = [[
            readable_date(v.get("visit_date"), self.local_tz),
            v.get("title") or v.get("domain") or v.get("url") or "",
            v.get("domain") or "",
            v.get("url") or "",
            _BROWSER_NAMES.get(v.get("browser"), (v.get("browser") or "").capitalize()),
            _count(v.get("visit_count")),
        ] for v in visits]
        span = date_span((v.get("visit_date") for v in visits), self.local_tz)
        return RecordDocument(
            title="Web history",
            summary=", ".join(filter(None, [plural(len(visits), "page visit"), span])),
            sections=[Section(
                columns=[Column("When", "when"), Column("Page"), Column("Site"), Column("Web address", "long"),
                         Column("Browser"), Column("Visits", "number", labelled=True)],
                rows=rows,
            )],
        )
