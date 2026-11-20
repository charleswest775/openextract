"""
Notes adapter.

Delegates ``list_notes`` to ``ios_backup_core.extractors.notes.NoteExtractor``
and keeps openextract's export: one file per note, or every note asked for in
one file, as plain text, a web page, or the print-ready page Electron prints
to a PDF (record_document.py). A saved note's Created and Modified dates read
"Jul 5, 2024, 9:10 AM" in the computer's time zone (local_dates.py); the
library gives them in UTC.
"""

import os

from ios_backup_core.extractors.notes import NoteExtractor as _CoreNoteExtractor

from local_dates import readable_date
from record_document import (
    RecordDocument,
    Section,
    file_base,
    plural,
    unused_path,
    write_document,
)

# 'pdf' is the old PDF drawn by reportlab in the engine, kept so older callers
# still work; the app prints 'pdf_source' with Chromium instead (one look with
# every other PDF, every alphabet and emoji, lines wrapped between words).
FORMATS = ("pdf_source", "html", "txt", "pdf")
MODES = ("separate", "merged")

# The one file a merged save writes ("Notes.txt", or "Notes (2).txt" beside an earlier one)
MERGED_NAME = "Notes"


class NoteExtractor:
    """Adapter wrapping the ios-backup-core NoteExtractor."""

    # The time zone saved notes' dates are shown in; None is this computer's.
    local_tz = None

    def __init__(self):
        self._inner = _CoreNoteExtractor()

    def list_notes(self, backup) -> dict:
        return self._inner.list_notes(backup)

    # ── openextract-only: export ─────────────────────────────────────────────

    def export_notes(self, backup, note_ids, format: str, output_dir: str, mode: str = "separate"):
        """Save notes into ``output_dir``: those in ``note_ids`` (every note when
        it's None), one file each ('separate') or all in one ('merged').

        format: 'txt', 'html', 'pdf_source' or 'pdf' (reportlab). Returns
        {status: 'ok', exported: [paths], files: [paths], count} plus, merged,
        file; an unknown format or mode is {error}; no matching note is
        {status: 'error', message}. Never overwrites a file.
        """
        fmt = (format or "").lower()
        if fmt not in FORMATS:
            return {"error": f"Unsupported format: {format}"}
        if mode not in MODES:
            return {"error": f"Unsupported mode: {mode}"}

        all_notes_res = self.list_notes(backup)
        all_notes = all_notes_res.get("notes", []) if isinstance(all_notes_res, dict) else all_notes_res
        if note_ids is None:
            notes = list(all_notes)
        else:
            wanted = set(note_ids)
            notes = [n for n in all_notes if n["note_id"] in wanted]
        if not notes:
            return {"status": "error", "message": "No matching notes found."}

        os.makedirs(output_dir, exist_ok=True)
        try:
            if mode == "merged":
                files = [self._write(notes, output_dir, MERGED_NAME, fmt, merged=True)]
            else:
                files = [
                    self._write([note], output_dir, file_base(note.get("title"), f"Note_{note['note_id']}", 50), fmt)
                    for note in notes
                ]
        except ImportError:
            return {"status": "error", "message": "reportlab is required for PDF export."}
        except Exception as e:  # noqa: BLE001 - the save's failure is the answer
            return {"status": "error", "message": f"Export failed: {e}"}

        result = {"status": "ok", "exported": files, "files": files, "count": len(notes)}
        if mode == "merged":
            result["file"] = files[0]
        return result

    # ── Writers ──────────────────────────────────────────────────────────────

    def _dates(self, note) -> tuple:
        return (readable_date(note.get("created"), self.local_tz),
                readable_date(note.get("modified"), self.local_tz))

    def _write(self, notes: list, output_dir: str, base: str, fmt: str, merged: bool = False) -> str:
        if fmt == "txt":
            path = unused_path(output_dir, base, ".txt")
            with open(path, "w", encoding="utf-8") as f:
                f.write(("\n\n" + "-" * 60 + "\n\n").join(self._note_text(n) for n in notes))
            return path
        if fmt == "pdf":
            path = unused_path(output_dir, base, ".pdf")
            self._write_reportlab_pdf(path, notes)
            return path
        return write_document(self._document(notes, merged), output_dir, base, fmt)

    def _note_text(self, note) -> str:
        """The plain-text layout every saved note has had (and the app's own
        notes file had): a header, a rule, then the note as written."""
        created, modified = self._dates(note)
        return (f"Title: {note['title']}\nCreated: {created}\nModified: {modified}\n"
                + "=" * 40 + "\n\n" + (note.get("body") or ""))

    def _document(self, notes: list, merged: bool) -> RecordDocument:
        """One note: its title on top, its dates, its text. Several: "Notes",
        then each under its own title."""
        def body(note) -> str:
            # A note starts with its title, which is already the heading (the Notes screen skips it too)
            text = note.get("body") or ""
            title = note.get("title") or ""
            return text[len(title):].lstrip("\n") if title and text.startswith(title) else text

        def dates(note) -> str:
            created, modified = self._dates(note)
            return f"Created {created} · Edited {modified}"

        if not merged:
            note = notes[0]
            return RecordDocument(title=note.get("title") or "Untitled", summary=dates(note),
                                  sections=[Section(text=body(note))])
        return RecordDocument(
            title="Notes",
            summary=plural(len(notes), "note"),
            sections=[Section(heading=n.get("title") or "Untitled", meta=dates(n), text=body(n)) for n in notes],
        )

    def _write_reportlab_pdf(self, path: str, notes: list) -> None:
        """The old engine-drawn PDF: Helvetica, one page or more per note."""
        from reportlab.lib.pagesizes import letter
        from reportlab.pdfgen import canvas

        c = canvas.Canvas(path, pagesize=letter)
        width, height = letter
        for i, note in enumerate(notes):
            if i:
                c.showPage()
            created, modified = self._dates(note)
            c.setFont("Helvetica-Bold", 14)
            c.drawString(50, height - 50, note["title"])

            c.setFont("Helvetica", 10)
            c.drawString(50, height - 70, f"Created: {created}")
            c.drawString(50, height - 85, f"Modified: {modified}")

            c.setFont("Helvetica", 11)
            y = height - 120
            for line in (note.get("body") or "").split("\n"):
                wrapped = [line[i:i + 80] for i in range(0, len(line) or 1, 80)]
                for wline in wrapped:
                    if y < 50:
                        c.showPage()
                        c.setFont("Helvetica", 11)
                        y = height - 50
                    c.drawString(50, y, wline)
                    y -= 15
        c.save()
