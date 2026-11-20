"""
Saved documents for lists of records: call history, web history, notes and
recovered messages.

Each is written as a web page ('html'), as the print-ready page Electron
prints to a PDF ('pdf_source', electron/pdfExport.ts), or as plain text
('txt'), and they all look alike: the conversation exports' typography, page
width, grey background and footer (messages.py), with the records in a table
or, for a note, as its text. These documents hold no pictures, so the
print-ready page is the web page itself; its @media print rules lay it out on
paper.

A RecordDocument is a title, a one-line summary and sections. A section has an
optional heading and a small line under it, then either a table (columns and
rows of plain text) or a block of text kept as written. Everything is escaped
here, so callers pass the backup's text as it is.

Spreadsheets stay with each kind (their columns differ) but share CSV_ENCODING
and csv_cell, so every record CSV opens right in Excel and no cell runs as a
formula.
"""

from __future__ import annotations

import html
import os
import re
from dataclasses import dataclass, field
from datetime import tzinfo
from typing import Iterable, Optional

from local_dates import format_day, local_datetime
from messages import EXPORT_FOOTER_HTML

# The formats a document is written in, besides each kind's CSV.
DOCUMENT_FORMATS = ("html", "pdf_source", "txt")

# A byte-order mark first: Excel on Windows reads a CSV without one in the
# computer's old code page, which garbles accents, other alphabets and emoji.
CSV_ENCODING = "utf-8-sig"

# A cell starting with one of these is a formula to a spreadsheet. Page titles
# and message texts come from other people, so "=HYPERLINK(...)" would become
# a live link: such a cell gets a ' in front, which means "this is text" (as
# whatsapp.py and podcasts.py do).
FORMULA_START = ("=", "+", "-", "@", "\t", "\r")

# What can't go in a file name: characters Windows refuses, control
# characters, and the marks that reverse the direction of text (messages.py's
# rule for conversation file names).
_FILE_NAME_UNSAFE = re.compile(r'[<>:"/\\|?*\x00-\x1f\x7f‪-‮⁦-⁩]')
_WINDOWS_DEVICE_NAMES = {"CON", "PRN", "AUX", "NUL",
                         *(f"COM{n}" for n in range(1, 10)), *(f"LPT{n}" for n in range(1, 10))}

_CSS = """
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 960px; margin: 0 auto; padding: 20px; background: #f5f5f5; color: #111; }
h1 { font-size: 20px; color: #333; margin: 0 0 4px; }
.summary { font-size: 12px; color: #666; margin: 0 0 20px; }
h2 { font-size: 15px; color: #333; margin: 28px 0 2px; }
.meta { font-size: 11px; color: #888; margin: 0 0 8px; }
table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 8px; overflow: hidden; font-size: 13px; }
th { text-align: left; font-size: 11px; font-weight: 600; color: #666; background: #fafafa; padding: 8px 10px; border-bottom: 1px solid #e5e5e5; }
td { padding: 7px 10px; border-bottom: 1px solid #eee; vertical-align: top; overflow-wrap: anywhere; }
tr:last-child td { border-bottom: none; }
td.when { white-space: nowrap; color: #555; }
th.number, td.number { text-align: right; white-space: nowrap; font-variant-numeric: tabular-nums; }
td.long { word-break: break-all; color: #555; }
.text { background: #fff; border-radius: 8px; padding: 14px 16px; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 14px; line-height: 1.55; }
.empty { font-size: 13px; color: #888; font-style: italic; }
@media print {
  body { background: #fff; max-width: none; padding: 0; }
  table { border: 1px solid #e5e5e5; }
  thead { display: table-header-group; }
  tr { break-inside: avoid; }
  h2, .meta { break-after: avoid; }
  .text { border: 1px solid #e5e5e5; }
}
"""


@dataclass
class Column:
    """One column of a table: its heading, and how its cells are laid out.

    kind: "text"; "when" (a date, never wrapped); "number" (right-aligned);
    "long" (breaks anywhere, for web addresses). ``labelled`` puts the heading
    before the value in plain text ("Visits 3"), for values that don't say
    what they are.
    """
    label: str
    kind: str = "text"
    labelled: bool = False


@dataclass
class Section:
    """A heading (may be empty), a line under it, and a table or a text."""
    heading: str = ""
    meta: str = ""
    columns: list = field(default_factory=list)
    rows: list = field(default_factory=list)
    text: Optional[str] = None
    # Plain-text lines for the rows, when the default ("[when] a · b") won't read well
    text_lines: Optional[list] = None
    # Said instead of an empty table
    empty: str = "Nothing to show."


@dataclass
class RecordDocument:
    title: str
    summary: str = ""
    sections: list = field(default_factory=list)


# ── Names and cells ──────────────────────────────────────────────────────────

def unused_path(output_dir: str, base: str, ext: str) -> str:
    """<output_dir>/<base><ext>, or "<base> (2)<ext>" and so on when that
    exists, so saving again never overwrites a file (as every other save does)."""
    name = f"{base}{ext}"
    n = 2
    while os.path.exists(os.path.join(output_dir, name)):
        name = f"{base} ({n}){ext}"
        n += 1
    return os.path.join(output_dir, name)


def file_base(name, fallback: str, max_length: int = 60) -> str:
    """A file name (without extension) from text the backup gave, safe on
    Windows and macOS, or ``fallback`` when nothing usable is left."""
    cleaned = " ".join(_FILE_NAME_UNSAFE.sub(" ", str(name or "")).split())
    # A leading dot hides a file on a Mac; Windows drops trailing dots and spaces
    cleaned = cleaned[:max_length].lstrip(". ").rstrip(" .")
    if not cleaned:
        return fallback
    if cleaned.split(".")[0].rstrip().upper() in _WINDOWS_DEVICE_NAMES:
        cleaned = f"_{cleaned}"
    return cleaned


def csv_cell(value):
    """A CSV cell a spreadsheet won't run as a formula (see FORMULA_START)."""
    if value is None:
        return ""
    if isinstance(value, str) and value.startswith(FORMULA_START):
        return "'" + value
    return value


def plural(n: int, one: str, many: Optional[str] = None) -> str:
    """"1 call", "1,234 calls"."""
    return f"{n:,} {one if n == 1 else (many or one + 's')}"


def date_span(isos: Iterable, tz: Optional[tzinfo] = None) -> str:
    """"Jul 5, 2024 to Jun 21, 2026", "Jul 5, 2024" for one day, or "" when
    there's no date to go by. Days are the computer's local ones."""
    days = sorted(dt for dt in (local_datetime(iso, tz) for iso in isos) if dt is not None)
    if not days:
        return ""
    first, last = format_day(days[0]), format_day(days[-1])
    return first if first == last else f"{first} to {last}"


# ── Writing ──────────────────────────────────────────────────────────────────

def write_document(doc: RecordDocument, output_dir: str, base: str, fmt: str) -> str:
    """Write ``doc`` as 'html', 'pdf_source' or 'txt' into a new file in
    ``output_dir`` named after ``base``; returns its path."""
    if fmt not in DOCUMENT_FORMATS:
        raise ValueError(f"Unsupported format: {fmt}")
    os.makedirs(output_dir, exist_ok=True)
    if fmt == "txt":
        path = unused_path(output_dir, base, ".txt")
        with open(path, "w", encoding="utf-8-sig") as f:
            f.write(document_text(doc))
    else:
        path = unused_path(output_dir, base, ".html")
        with open(path, "w", encoding="utf-8") as f:
            f.write(document_html(doc))
    return path


def _escape(text) -> str:
    return html.escape(str(text if text is not None else "")).replace("\n", "<br>")


def _section_html(section: Section) -> str:
    out = []
    if section.heading:
        out.append(f"<h2>{_escape(section.heading)}</h2>\n")
    if section.meta:
        out.append(f'<div class="meta">{_escape(section.meta)}</div>\n')
    if section.text is not None:
        out.append(f'<div class="text">{html.escape(section.text)}</div>\n')
    elif not section.rows:
        out.append(f'<p class="empty">{_escape(section.empty)}</p>\n')
    else:
        kinds = [c.kind for c in section.columns]
        head = "".join(
            f'<th class="{c.kind}">{_escape(c.label)}</th>' if c.kind == "number" else f"<th>{_escape(c.label)}</th>"
            for c in section.columns)
        out.append(f"<table>\n<thead><tr>{head}</tr></thead>\n<tbody>\n")
        for row in section.rows:
            cells = "".join(
                f'<td class="{kind}">{_escape(cell)}</td>' if kind != "text" else f"<td>{_escape(cell)}</td>"
                for kind, cell in zip(kinds, row))
            out.append(f"<tr>{cells}</tr>\n")
        out.append("</tbody>\n</table>\n")
    return "".join(out)


def document_html(doc: RecordDocument) -> str:
    """The whole page: escaped, no scripts, nothing fetched from the network."""
    title = _escape(doc.title)
    parts = [
        f'<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">'
        f'<meta name="viewport" content="width=device-width, initial-scale=1">'
        f"<title>{title}</title>\n<style>{_CSS}</style></head><body>\n",
        f"<h1>{title}</h1>\n",
    ]
    if doc.summary:
        parts.append(f'<div class="summary">{_escape(doc.summary)}</div>\n')
    parts.extend(_section_html(s) for s in doc.sections)
    parts.append(EXPORT_FOOTER_HTML)
    parts.append("</body></html>\n")
    return "".join(parts)


def _default_line(columns: list, row: list) -> str:
    """"[Jul 5, 2024, 9:10 AM] Incoming · Riley · 4m 2s": the first date in
    brackets, then every other value that isn't empty."""
    when = next((i for i, c in enumerate(columns) if c.kind == "when"), None)
    values = [" ".join(str(cell if cell is not None else "").split()) for cell in row]
    rest = [
        f"{column.label} {value}" if column.labelled else value
        for i, (column, value) in enumerate(zip(columns, values))
        if i != when and value
    ]
    line = " · ".join(rest)
    return f"[{values[when]}] {line}".rstrip() if when is not None else line


def document_text(doc: RecordDocument) -> str:
    """The same document as plain text."""
    lines = [doc.title]
    if doc.summary:
        lines.append(doc.summary)
    for section in doc.sections:
        lines.append("")
        if section.heading:
            lines.append(section.heading)
            lines.append("=" * min(60, max(10, len(section.heading))))
        if section.meta:
            lines.append(section.meta)
        if section.heading or section.meta:
            lines.append("")
        if section.text is not None:
            lines.append(section.text)
        elif not section.rows:
            lines.append(section.empty)
        elif section.text_lines is not None:
            lines.extend(section.text_lines)
        else:
            lines.extend(_default_line(section.columns, row) for row in section.rows)
    return "\n".join(lines).rstrip("\n") + "\n"
