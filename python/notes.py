"""
Notes adapter.

Delegates ``list_notes`` to ``ios_backup_core.extractors.notes.NoteExtractor``
and keeps openextract's PDF/TXT export wrapper.
"""

import os
import re

from ios_backup_core.extractors.notes import NoteExtractor as _CoreNoteExtractor


class NoteExtractor:
    """Adapter wrapping the ios-backup-core NoteExtractor."""

    def __init__(self):
        self._inner = _CoreNoteExtractor()

    def list_notes(self, backup) -> dict:
        return self._inner.list_notes(backup)

    # ── openextract-only: per-id PDF/TXT export ──────────────────────────────

    def export_notes(self, backup, note_ids: list, format: str, output_dir: str):
        """Export notes to PDF or TXT."""
        all_notes_res = self.list_notes(backup)
        all_notes = all_notes_res.get("notes", []) if isinstance(all_notes_res, dict) else all_notes_res

        notes_to_export = [n for n in all_notes if n["note_id"] in note_ids]

        if not notes_to_export:
            return {"status": "error", "message": "No matching notes found."}

        os.makedirs(output_dir, exist_ok=True)
        exported_files = []

        for note in notes_to_export:
            safe_title = re.sub(r'[\\/*?:"<>|]', "", note["title"])[:50]
            if not safe_title.strip():
                safe_title = f"Note_{note['note_id']}"

            if format.lower() == "txt":
                filename = f"{safe_title}.txt"
                filepath = os.path.join(output_dir, filename)
                with open(filepath, "w", encoding="utf-8") as f:
                    f.write(f"Title: {note['title']}\n")
                    f.write(f"Created: {note['created']}\n")
                    f.write(f"Modified: {note['modified']}\n")
                    f.write("=" * 40 + "\n\n")
                    f.write(note["body"])
                exported_files.append(filepath)
            elif format.lower() == "pdf":
                filename = f"{safe_title}.pdf"
                filepath = os.path.join(output_dir, filename)
                try:
                    try:
                        from reportlab.lib.pagesizes import letter
                        from reportlab.pdfgen import canvas

                        c = canvas.Canvas(filepath, pagesize=letter)
                        width, height = letter
                        c.setFont("Helvetica-Bold", 14)
                        c.drawString(50, height - 50, note["title"])

                        c.setFont("Helvetica", 10)
                        c.drawString(50, height - 70, f"Created: {note['created']}")
                        c.drawString(50, height - 85, f"Modified: {note['modified']}")

                        c.setFont("Helvetica", 11)
                        y = height - 120

                        for line in note["body"].split("\n"):
                            wrapped = [line[i:i+80] for i in range(0, len(line) or 1, 80)]
                            for wline in wrapped:
                                if y < 50:
                                    c.showPage()
                                    c.setFont("Helvetica", 11)
                                    y = height - 50
                                c.drawString(50, y, wline)
                                y -= 15
                        c.save()
                        exported_files.append(filepath)
                    except ImportError:
                        return {"status": "error", "message": "reportlab is required for PDF export."}
                except Exception as e:
                    return {"status": "error", "message": f"PDF Export failed: {e}"}

        return {"status": "ok", "exported": exported_files}
