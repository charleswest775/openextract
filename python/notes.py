"""
Notes extraction from NoteStore.sqlite.
"""

import sqlite3
from typing import Optional
from messages import apple_date_to_iso


class NoteExtractor:
    """Extracts notes from iOS backups."""

    # iOS 9+ uses NoteStore.sqlite
    NOTES_DB_PATH = "Library/Notes/notes.sqlite"
    # iOS 11+ uses a different location
    NOTESTORE_PATH = "NoteStore.sqlite"

    def list_notes(self, backup) -> dict:
        """List all notes with content."""
        # Try newer NoteStore format first (iOS 9+)
        db_path = backup.get_file(self.NOTES_DB_PATH, domain="HomeDomain")

        notes = []

        if db_path:
            notes = self._parse_legacy_notes(db_path)

        if not notes:
            # Try the group container path for newer iOS via manifest scan.
            # For unencrypted backups this finds paths dynamically; for encrypted
            # backups list_files() returns [] (manifest is encrypted) so we fall
            # through to the hardcoded path below.
            files = backup.list_files(path_like="%NoteStore.sqlite")
            for f in files:
                extracted = backup.get_file(f["path"], domain=f["domain"])
                if extracted:
                    notes = self._parse_notestore(extracted)
                    if notes:
                        break

        if not notes:
            # Encrypted backups: Manifest.db is encrypted so list_files() returns
            # nothing. Try the well-known iOS 11+ group container path directly.
            notestore_path = backup.get_file(
                "NoteStore.sqlite",
                domain="AppDomainGroup-group.com.apple.notes",
            )
            if notestore_path:
                notes = self._parse_notestore(notestore_path)

        return {"notes": notes}

    def _parse_legacy_notes(self, db_path: str) -> list:
        """Parse the older notes.sqlite format."""
        notes = []
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row

            rows = conn.execute("""
                SELECT
                    n.ROWID,
                    n.creation_date,
                    n.modification_date,
                    n.title,
                    nb.data AS body_data
                FROM note n
                LEFT JOIN note_bodies nb ON nb.note_id = n.ROWID
                ORDER BY n.modification_date DESC
            """).fetchall()

            for row in rows:
                body = ""
                if row["body_data"]:
                    if isinstance(row["body_data"], bytes):
                        body = row["body_data"].decode("utf-8", errors="replace")
                    else:
                        body = str(row["body_data"])

                notes.append({
                    "note_id": row["ROWID"],
                    "title": row["title"] or "Untitled",
                    "body": body[:5000],  # Truncate very long notes
                    "created": apple_date_to_iso(row["creation_date"]),
                    "modified": apple_date_to_iso(row["modification_date"]),
                })

            conn.close()
        except Exception:
            pass

        return notes

    def _extract_pb_strings(self, data: bytes, depth: int = 0) -> list:
        """Walk a protobuf blob and collect all UTF-8 string field values."""
        if depth > 8:
            return []

        strings = []
        pos = 0
        data_len = len(data)

        while pos < data_len:
            # Decode tag varint
            tag = 0
            shift = 0
            valid = False
            while pos < data_len:
                b = data[pos]; pos += 1
                tag |= (b & 0x7F) << shift
                if not (b & 0x80):
                    valid = True
                    break
                shift += 7
                if shift >= 64:
                    return strings
            if not valid:
                break

            wire_type = tag & 0x7

            if wire_type == 0:  # varint — skip
                while pos < data_len:
                    b = data[pos]; pos += 1
                    if not (b & 0x80):
                        break
            elif wire_type == 1:  # 64-bit — skip
                pos += 8
            elif wire_type == 2:  # length-delimited
                length = 0
                shift = 0
                valid = False
                while pos < data_len:
                    b = data[pos]; pos += 1
                    length |= (b & 0x7F) << shift
                    if not (b & 0x80):
                        valid = True
                        break
                    shift += 7
                    if shift >= 64:
                        return strings
                if not valid or length < 0 or pos + length > data_len:
                    break

                chunk = data[pos:pos + length]
                pos += length

                try:
                    text = chunk.decode('utf-8')
                    # Keep if it contains meaningful alphabetic content
                    stripped = text.strip()
                    if stripped and sum(1 for c in stripped if c.isalpha()) > 2:
                        strings.append(text)
                    else:
                        # Short/non-alpha chunk may be a nested message — recurse
                        strings.extend(self._extract_pb_strings(chunk, depth + 1))
                except UnicodeDecodeError:
                    # Binary data — try as nested protobuf
                    strings.extend(self._extract_pb_strings(chunk, depth + 1))
            elif wire_type == 5:  # 32-bit — skip
                pos += 4
            else:
                break

        return strings

    def _parse_notestore(self, db_path: str) -> list:
        """Parse the newer NoteStore.sqlite format (iOS 11+)."""
        notes = []
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row

            rows = conn.execute("""
                SELECT
                    n.Z_PK,
                    n.ZTITLE1 AS title,
                    n.ZCREATIONDATE AS created,
                    n.ZMODIFICATIONDATE1 AS modified,
                    n.ZSNIPPET AS snippet,
                    nd.ZDATA AS body_data
                FROM ZICCLOUDSYNCINGOBJECT n
                LEFT JOIN ZICNOTEDATA nd ON nd.ZNOTE = n.Z_PK
                WHERE n.ZTITLE1 IS NOT NULL
                ORDER BY n.ZMODIFICATIONDATE1 DESC
            """).fetchall()

            for row in rows:
                body = row["snippet"] or ""
                if row["body_data"]:
                    import gzip
                    data = row["body_data"]
                    # Find gzip magic number
                    idx = data.find(b'\x1f\x8b\x08')
                    if idx != -1:
                        try:
                            decompressed = gzip.decompress(data[idx:])
                            # Properly parse the protobuf wire format to extract
                            # only actual string fields — avoids garbling from
                            # protobuf length prefixes/tags leaking into the output.
                            pb_strings = self._extract_pb_strings(decompressed)
                            if pb_strings:
                                # Use the longest string as the note body
                                text = max(pb_strings, key=len)
                                if len(text) > len(body):
                                    body = text.strip()
                        except Exception:
                            pass

                notes.append({
                    "note_id": row["Z_PK"],
                    "title": row["title"] or "Untitled",
                    "body": body[:20000],  # Increase limit
                    "created": apple_date_to_iso(row["created"]),
                    "modified": apple_date_to_iso(row["modified"]),
                })

            conn.close()
        except Exception:
            pass

        return notes

    def export_notes(self, backup, note_ids: list, format: str, output_dir: str):
        """Export notes to PDF or TXT."""
        import os
        import re
        
        # Get all notes and filter
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
                    # Very simple PDF generation if reportlab is available
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
                        
                        # Process body
                        for line in note["body"].split("\n"):
                            # Wrap long lines is complex without proper functions, 
                            # we'll do simple wrapping character count
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
