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

from local_dates import csv_date, local_datetime


class VoicemailExtractor:
    """Adapter wrapping the ios-backup-core VoicemailExtractor."""

    # The time zone saves show dates in; None is this computer's, as the app
    # and the other saves use (local_dates.py). Tests set a fixed one.
    local_tz = None

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
        is in, and the audio in audio/ (spam in audio/Spam, deleted in audio/Deleted).

        The CSV names the caller twice: Contact is their address-book name (the
        number when they aren't in it), Phone Number is always the number, so a
        saved contact's number isn't lost. Spam is True for every voicemail
        marked spam, including one that was then deleted (its List is Deleted).
        Dates are in the computer's time zone, as message saves are: the CSV's
        as ISO 8601 with the offset, the audio file names by the local day, so
        a voicemail left in the evening isn't filed under the next day.
        """
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
            # A byte-order mark, so Excel reads names and transcripts in any alphabet right
            with open(csv_path, 'w', newline='', encoding='utf-8-sig') as f:
                writer = csv.writer(f)
                writer.writerow(CSV_HEADER)

                for vm in voicemails:
                    folder = vm.get("folder", "voicemail")
                    writer.writerow([
                        vm["id"],
                        _LIST_NAMES.get(folder, folder),
                        self._csv_date(vm["date_received"]),
                        vm["contact_name"],
                        vm.get("phone_number") or "",
                        # An older ios-backup-core has no is_spam: then only the Spam list is known
                        bool(vm.get("is_spam", folder == "spam")),
                        vm["duration"],
                        vm["is_read"],
                        vm["transcript"]
                    ])

                    # Copy audio file if present
                    src = self._inner.get_audio_path(backup, vm["id"])
                    if src and os.path.exists(src):
                        dest_dir = audio_dir if folder == "voicemail" else os.path.join(audio_dir, _LIST_NAMES[folder])
                        os.makedirs(dest_dir, exist_ok=True)
                        name = _safe_name(f"{vm['contact_name']}_{self._file_day(vm['date_received'])}_{vm['id']}")
                        shutil.copy2(src, os.path.join(dest_dir, f"{name}.amr"))

                    exported_count += 1

            return {"status": "success", "exported": exported_count, "path": output_dir}
        except Exception as e:
            return {"error": f"Export failed: {e}"}

    # ── Dates in saves ───────────────────────────────────────────────────────
    # The library gives each voicemail's date in UTC ("2024-07-06T00:48:12+00:00").
    # Saves show it in local time, like the other saves (local_dates.py).

    def _csv_date(self, iso) -> str:
        """ISO 8601 in local time with its offset, e.g. "2024-07-05T17:48:12-07:00":
        the same moment as the library's UTC value, and the clock time people expect."""
        return csv_date(iso, self.local_tz)

    def _file_day(self, iso) -> str:
        """The local day, "2024-07-05", for an audio file's name."""
        dt = local_datetime(iso, self.local_tz)
        return dt.date().isoformat() if dt is not None else (iso or "")[:10]


_LIST_NAMES = {"voicemail": "Voicemail", "spam": "Spam", "deleted": "Deleted"}

CSV_HEADER = ["ID", "List", "Date", "Contact", "Phone Number", "Spam", "Duration", "Is Read", "Transcript"]


def _safe_name(name: str) -> str:
    """A file name that works on Windows, macOS and Linux."""
    return "".join("_" if c in '<>:"/\\|?*' or ord(c) < 32 else c for c in name).strip(" .") or "voicemail"
