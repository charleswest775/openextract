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

    def list_voicemails(self, backup, contacts: dict, include_deleted: bool = False) -> dict:
        return self._inner.list_voicemails(backup, contacts, include_deleted=include_deleted)

    def get_audio(self, backup, voicemail_id) -> dict:
        """Extract voicemail audio file as base64 (RPC ``get_voicemail_audio``)."""
        file_path = self._inner.get_audio_path(backup, voicemail_id)

        if not file_path or not os.path.exists(file_path):
            return {"error": "This voicemail's audio isn't in the backup."}

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
        """Every voicemail, spam and deleted ones too: a CSV saying which list each
        is in, and the audio in audio/ (spam in audio/Spam, deleted in audio/Deleted)."""
        voicemails_data = self.list_voicemails(backup, contacts, include_deleted=True)
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
                writer.writerow(["ID", "List", "Date", "Contact/Number", "Duration", "Is Read", "Transcript"])

                for vm in voicemails:
                    folder = vm.get("folder", "voicemail")
                    writer.writerow([
                        vm["id"],
                        _LIST_NAMES.get(folder, folder),
                        vm["date_received"],
                        vm["contact_name"],
                        vm["duration"],
                        vm["is_read"],
                        vm["transcript"]
                    ])

                    # Copy audio file if present
                    src = self._inner.get_audio_path(backup, vm["id"])
                    if src and os.path.exists(src):
                        dest_dir = audio_dir if folder == "voicemail" else os.path.join(audio_dir, _LIST_NAMES[folder])
                        os.makedirs(dest_dir, exist_ok=True)
                        name = _safe_name(f"{vm['contact_name']}_{vm['date_received'][:10]}_{vm['id']}")
                        shutil.copy2(src, os.path.join(dest_dir, f"{name}.amr"))

                    exported_count += 1

            return {"status": "success", "exported": exported_count, "path": output_dir}
        except Exception as e:
            return {"error": f"Export failed: {e}"}


_LIST_NAMES = {"voicemail": "Voicemail", "spam": "Spam", "deleted": "Deleted"}


def _safe_name(name: str) -> str:
    """A file name that works on Windows, macOS and Linux."""
    return "".join("_" if c in '<>:"/\\|?*' or ord(c) < 32 else c for c in name).strip(" .") or "voicemail"
