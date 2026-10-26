"""
Voice Memos adapter.

Delegates listing to ``ios_backup_core.extractors.voice_memos.VoiceMemoExtractor``.
Adds the openextract pieces: audio as base64 for the in-app player (the same
shape as ``get_voicemail_audio``), a copy with a real file extension for
"Open in default app", and export to a folder.
"""

import atexit
import base64
import csv
import os
import shutil
import tempfile
from datetime import datetime

from export_files import safe_filename, unique_path

try:
    from ios_backup_core.extractors.voice_memos import (
        VoiceMemoExtractor as _CoreVoiceMemoExtractor,
    )
except ImportError:  # an ios-backup-core checkout from before Voice Memos support
    _CoreVoiceMemoExtractor = None

OUTDATED_CORE_MESSAGE = (
    "Voice Memos needs a newer version of ios-backup-core. "
    "Update it and restart OpenExtract."
)

# Larger recordings aren't sent over JSON-RPC as base64; the UI offers
# "Open in default app" instead.
MAX_INLINE_AUDIO_BYTES = 50 * 1024 * 1024


def export_file_name(memo: dict) -> str:
    """e.g. "2024-01-01 12.00 Standup.m4a" — sorts by date in a file browser."""
    ext = os.path.splitext(memo.get("file_name") or "")[1] or ".m4a"
    stamp = ""
    if memo.get("date"):
        try:
            local = datetime.fromisoformat(memo["date"]).astimezone()
            stamp = local.strftime("%Y-%m-%d %H.%M")
        except ValueError:
            pass
    title = memo.get("title") or "Recording"
    return safe_filename(" ".join(p for p in (stamp, title) if p)) + ext


class VoiceMemoExtractor:
    """Adapter wrapping the ios-backup-core VoiceMemoExtractor."""

    def __init__(self):
        self._inner = _CoreVoiceMemoExtractor() if _CoreVoiceMemoExtractor else None
        self._playable_dir = None

    def list_voice_memos(self, backup) -> dict:
        if self._inner is None:
            return {"voice_memos": [], "errors": [{"message": OUTDATED_CORE_MESSAGE}]}
        return self._inner.list_voice_memos(backup)

    def get_audio(self, backup, memo_id: int) -> dict:
        """Audio as base64 for the in-app player (RPC ``get_voice_memo_audio``)."""
        if self._inner is None:
            return {"error": OUTDATED_CORE_MESSAGE}
        audio = self._inner.get_audio_file(backup, memo_id)
        if not audio:
            return {"error": "This recording's audio isn't in the backup."}
        size = os.path.getsize(audio["path"])
        if size > MAX_INLINE_AUDIO_BYTES:
            return {
                "error": "This recording is too long to play here.",
                "too_large": True,
                "size": size,
            }
        with open(audio["path"], "rb") as f:
            data = base64.b64encode(f.read()).decode("ascii")
        return {"data": data, "mime_type": audio["mime_type"], "memo_id": memo_id, "size": size}

    def get_playable_file(self, backup, memo_id: int) -> dict:
        """Path to the audio with its real extension, for opening in another app.

        Unencrypted backups store files under extension-less hash names, which
        the OS can't open by type, so those are copied to a temp folder.
        """
        if self._inner is None:
            return {"error": OUTDATED_CORE_MESSAGE}
        audio = self._inner.get_audio_file(backup, memo_id)
        if not audio:
            return {"error": "This recording's audio isn't in the backup."}
        ext = os.path.splitext(audio["file_name"])[1].lower()
        if audio["path"].lower().endswith(ext):
            return {"path": audio["path"]}
        if self._playable_dir is None:
            self._playable_dir = tempfile.mkdtemp(prefix="openextract_voice_memos_")
            atexit.register(shutil.rmtree, self._playable_dir, True)
        dest = os.path.join(self._playable_dir, safe_filename(f"{memo_id}-{audio['file_name']}"))
        if not os.path.exists(dest):
            shutil.copyfile(audio["path"], dest)
        return {"path": dest}

    # ── openextract-only: export to disk ─────────────────────────────────────

    def export_voice_memos(self, backup, output_dir: str, include_deleted: bool = True) -> dict:
        """Copy each recording into *output_dir* with a readable name, plus a CSV index."""
        if self._inner is None:
            return {"success": False, "error": OUTDATED_CORE_MESSAGE}
        memos = self.list_voice_memos(backup).get("voice_memos", [])
        if not include_deleted:
            memos = [m for m in memos if not m["deleted"]]
        if not memos:
            return {"success": False, "error": "No voice memos found to export."}

        try:
            os.makedirs(output_dir, exist_ok=True)
            exported, missing = 0, 0
            rows = []
            for memo in memos:
                file_cell = ""
                audio = self._inner.get_audio_file(backup, memo["id"]) if memo["has_audio"] else None
                if audio:
                    dest = unique_path(output_dir, export_file_name(memo))
                    shutil.copyfile(audio["path"], dest)
                    _set_file_time(dest, memo.get("date"))
                    file_cell = os.path.basename(dest)
                    exported += 1
                else:
                    missing += 1
                rows.append([
                    memo.get("date") or "",
                    memo.get("title") or "",
                    round(memo.get("duration") or 0, 1),
                    memo.get("folder") or "",
                    "Yes" if memo["deleted"] else "",
                    file_cell,
                ])

            with open(os.path.join(output_dir, "voice_memos.csv"), "w",
                      newline="", encoding="utf-8") as f:
                writer = csv.writer(f)
                writer.writerow(["Date", "Title", "Duration (seconds)", "Folder",
                                 "Recently Deleted", "File"])
                writer.writerows(rows)

            return {"success": True, "path": output_dir, "exported": exported,
                    "missing": missing, "total": len(memos)}
        except OSError as e:
            return {"success": False, "error": f"Export failed: {e}"}


def _set_file_time(path: str, iso_date) -> None:
    """Give an exported file the recording's date, so it sorts naturally."""
    if not iso_date:
        return
    try:
        ts = datetime.fromisoformat(iso_date).timestamp()
        os.utime(path, (ts, ts))
    except (ValueError, OSError):
        pass
