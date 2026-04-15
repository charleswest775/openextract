"""
Voicemail adapter.

Delegates ``list_voicemails`` to ``ios_backup_core.extractors.voicemail.VoicemailExtractor``.
Wraps ``get_audio_path`` (path-only) into ``get_audio`` returning base64 — the
shape openextract's ``get_voicemail_audio`` RPC has historically returned.
Keeps openextract's CSV + audio-folder export wrapper.
"""

import base64
import csv
import os
import shutil

from ios_backup_core.extractors.voicemail import (
    VoicemailExtractor as _CoreVoicemailExtractor,
)


class VoicemailExtractor:
    """Adapter wrapping the ios-backup-core VoicemailExtractor."""

    def __init__(self):
        self._inner = _CoreVoicemailExtractor()

    def list_voicemails(self, backup, contacts: dict) -> dict:
        return self._inner.list_voicemails(backup, contacts)

    def get_audio(self, backup, voicemail_id: int) -> dict:
        """Extract voicemail audio file as base64 (RPC ``get_voicemail_audio``)."""
        file_path = self._inner.get_audio_path(backup, voicemail_id)

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

    # ── openextract-only: bulk export to disk (CSV + audio folder) ───────────

    def export_voicemails(self, backup, contacts: dict, output_dir: str) -> dict:
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

                    # Copy audio file if present
                    src = self._inner.get_audio_path(backup, vm["id"])
                    if src and os.path.exists(src):
                        filename = f"{vm['contact_name'].replace('/', '_')}_{vm['date_received'][:10]}_{vm['id']}.amr"
                        shutil.copy2(src, os.path.join(audio_dir, filename))

                    exported_count += 1

            return {"status": "success", "exported": exported_count, "path": output_dir}
        except Exception as e:
            return {"error": f"Export failed: {e}"}
