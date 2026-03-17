"""
Voicemail extraction from voicemail.db.
"""

import sqlite3
import os
import base64


class VoicemailExtractor:
    """Extracts voicemails from iOS backups."""

    VOICEMAIL_DB_PATH = "Library/Voicemail/voicemail.db"

    def list_voicemails(self, backup, contacts: dict) -> dict:
        """List all voicemails with metadata."""
        db_path = backup.get_file(self.VOICEMAIL_DB_PATH, domain="HomeDomain")
        if not db_path:
            return {"voicemails": [], "error": "voicemail.db not found"}

        voicemails = []
        try:
            conn = sqlite3.connect(db_path)
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            
            # Check if transcript column exists
            cursor.execute("PRAGMA table_info(voicemail)")
            columns = [col["name"] for col in cursor.fetchall()]
            transcript_col = "transcript" if "transcript" in columns else "'' as transcript"

            rows = cursor.execute(f"""
                SELECT
                    ROWID,
                    sender,
                    date,
                    duration,
                    flags,
                    trashed_date,
                    token,
                    {transcript_col}
                FROM voicemail
                WHERE trashed_date = 0 OR trashed_date IS NULL
                ORDER BY date DESC
            """).fetchall()

            from datetime import datetime, timezone
            for row in rows:
                sender = row["sender"] or ""
                caller_name = contacts.get(sender, sender)
                
                # Convert unix timestamp to ISO
                date_ts = int(row["date"]) if row["date"] else 0
                iso_date = datetime.fromtimestamp(date_ts, timezone.utc).isoformat() if date_ts else ""

                voicemails.append({
                    "id": row["ROWID"],
                    "phone_number": sender,
                    "contact_name": caller_name,
                    "date_received": iso_date,
                    "duration": row["duration"],
                    "is_read": bool(row["flags"] & 1) if row["flags"] else False,
                    "transcript": row["transcript"] if "transcript" in list(row.keys()) else "",
                })

            conn.close()
        except Exception as e:
            import traceback
            traceback.print_exc()
            with open("C:\\dev\\openextract\\debug_voicemails.log", "a") as f:
                f.write(f"ERROR: {str(e)}\n")
            return {"voicemails": [], "error": str(e)}

        with open("C:\\dev\\openextract\\debug_voicemails.log", "a") as f:
            f.write(f"DEBUG: Returning {len(voicemails)} voicemails. First: {voicemails[0] if voicemails else 'None'}\n")
        
        return {"voicemails": voicemails}

    def get_audio(self, backup, voicemail_id: int) -> dict:
        """Extract voicemail audio file as base64."""
        # Voicemail audio files are stored as .amr files in Library/Voicemail/
        # The filename corresponds to the ROWID
        audio_path = f"Library/Voicemail/{voicemail_id}.amr"
        file_path = backup.get_file(audio_path, domain="HomeDomain")

        if not file_path or not os.path.exists(file_path):
            return {"error": f"Voicemail audio not found: {voicemail_id}"}

        try:
            with open(file_path, "rb") as f:
                data = base64.b64encode(f.read()).decode("ascii")

            return {
                "data": data,
                "mime_type": "audio/amr",
                "voicemail_id": voicemail_id,
                "file_path": file_path,
            }
        except Exception as e:
            return {"error": f"Failed to read voicemail: {e}"}

    def export_voicemails(self, backup, contacts: dict, output_dir: str) -> dict:
        import csv
        import shutil
        
        voicemails_data = self.list_voicemails(backup, contacts)
        if "error" in voicemails_data:
            return voicemails_data
            
        voicemails = voicemails_data.get("voicemails", [])
        if not voicemails:
            return {"status": "success", "exported": 0}
            
        os.makedirs(output_dir, exist_ok=True)
        audio_dir = os.path.join(output_dir, "audio")
        os.makedirs(audio_dir, exist_ok=True)
        
        csv_path = os.path.join(output_dir, "voicemails.csv")
        exported_count = 0
        
        try:
            with open(csv_path, 'w', newline='', encoding='utf-8') as f:
                writer = csv.writer(f)
                writer.writerow(["ID", "Date", "Contact/Number", "Duration", "Is Read", "Transcript"])
                
                for vm in voicemails:
                    writer.writerow([
                        vm["id"], 
                        vm["date_received"],
                        vm["contact_name"],
                        vm["duration"],
                        vm["is_read"],
                        vm["transcript"]
                    ])
                    
                    # Copy audio file if exists
                    audio_info = self.get_audio(backup, vm["id"])
                    if "file_path" in audio_info and os.path.exists(audio_info["file_path"]):
                        filename = f"{vm['contact_name'].replace('/', '_')}_{vm['date_received'][:10]}_{vm['id']}.amr"
                        shutil.copy2(audio_info["file_path"], os.path.join(audio_dir, filename))
                    
                    exported_count += 1
                    
            return {"status": "success", "exported": exported_count, "path": output_dir}
        except Exception as e:
            return {"error": f"Export failed: {e}"}
