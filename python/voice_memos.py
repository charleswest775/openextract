"""
Voice Memos adapter.

Delegates reading to ``ios_backup_core.extractors.voice_memos``: the
recordings in the Voice Memos app's CloudRecordings.db (or the older
Recordings.db), their folders, where each recording's audio file is, and the
transcript iOS 18 and later keep inside the audio file. Keeps what is
openextract's own:

  * ``get_audio``: the library hands back a path on disk (in an unencrypted
    backup, a file stored under its hash, with no extension). The app wants
    the bytes (base64) to play in its own player, or, to open in another app
    (``as_file``), a copy under the recording's own name. A file too big to
    send in one JSON-RPC line comes back as ``too_large`` instead.
  * ``get_transcript``: the transcript in the app's shape.
  * the saves:
      - ``recordings``: a "Voice Memos" folder holding each recording's audio
        as recorded ("2026-05-13 14.15 Site walk.m4a", dated when it was
        recorded), its transcript beside it as a .txt, the ones in Recently
        Deleted in a folder of that name, and "Voice Memos.csv";
      - ``recordings`` with ``memo_ids``: just those recordings (and their
        transcripts), straight into the folder picked, for a screen's Save
        on one recording;
      - ``csv``: "Voice Memos.csv" alone, dates in local time.

A save never overwrites a file: a second one is "Voice Memos (2)". When there
is nothing to save, nothing is written and the answer is an error with an
``empty_reason``, which the app shows as a calm notice.

A recording whose audio isn't in the backup is common: Voice Memos can keep a
recording in iCloud only, and a backup never holds iCloud's copy. That is
said calmly ("kept in iCloud only"), never as a failure. Listing never opens
an audio file; in an encrypted backup, playing or saving a recording decrypts
it to a temp file first.

Which iOS versions write which columns is only partly known: the library
reads what each version has (see its module docstring). None of this has been
checked against a backup with recordings newer than iOS 13 yet.
"""

import base64
import csv
import os
import re
import sys
from datetime import datetime

from app_copies import AppCopies, is_openable, title_stem
from export_progress import ExportProgress
from local_dates import csv_date, local_datetime
from podcasts import _csv_cell, _unused_name

try:
    from ios_backup_core.extractors.voice_memos import VoiceMemoExtractor as _CoreVoiceMemoExtractor
except ImportError:
    # An ios-backup-core from before Voice Memos support. The engine must still
    # start and every other section still work, so Voice Memos answers as if it
    # weren't in the backup (see _NoVoiceMemoSupport).
    _CoreVoiceMemoExtractor = None

try:
    from ios_backup_core import mp4 as _mp4
except ImportError:
    _mp4 = None

__all__ = ["VoiceMemoExtractor", "NOTHING_TO_SAVE", "MAX_INLINE_BYTES"]

# What the app is told, in words for people.
NOTHING_TO_SAVE = "There are no voice memos in this backup to save."
NOT_FOUND = "Recording not found."
AUDIO_NOT_IN_BACKUP = "This recording isn't in the backup."
AUDIO_IN_ICLOUD = "This recording was kept in iCloud only, so it isn't in the backup."
NO_AUDIO_TO_SAVE = ("None of these recordings' audio is in the backup, so there are no audio files to save. "
                    "Save them as a spreadsheet to get the list.")
FILE_UNREADABLE = "This recording couldn't be read from the backup."
FILE_NOT_COPIED = "This recording couldn't be copied to open it."

FORMATS = ("recordings", "csv")

FOLDER_NAME = "Voice Memos"
CSV_NAME = "Voice Memos"
DELETED_FOLDER = "Recently Deleted"
DEFAULT_TITLE = "Recording"

CSV_HEADER = ["Title", "Date", "Duration", "Folder", "Favorite", "Recently Deleted", "Deleted Date",
              "Recorded on Watch", "Audio File", "Transcript"]

# The Audio File column when there is no file to name.
_MISSING_WORDS = {"in_icloud_only": "Kept in iCloud only", "not_in_backup": "Not in the backup"}
_NOT_COPIED_WORDS = "Couldn't be saved"

# Biggest recording sent inline as base64 (as WhatsApp's media). Base64 makes it a
# third bigger, and the whole thing travels as one JSON line that Electron reads
# into memory, so a longer one is opened in another app instead.
MAX_INLINE_BYTES = 25 * 1024 * 1024

# Voice Memos writes AAC or Apple Lossless in .m4a, and layered recordings as
# QuickTime .qta. All are MPEG-4 containers; the app falls back to opening the
# file in another app when its player can't play one.
_MIME = "audio/mp4"

_COPY_CHUNK = 1024 * 1024

_DIGITS = re.compile(r"[0-9]+")
_MAX_ID = 2**63 - 1

# Said once per engine, however many extractors are made.
_told_no_support = False


class _NoVoiceMemoSupport:
    """Stands in for the library's extractor when ios-backup-core has none."""

    def __init__(self):
        global _told_no_support
        if not _told_no_support:
            _told_no_support = True
            print("[voice_memos] this ios-backup-core has no Voice Memos extractor; Voice Memos shows as not in "
                  "the backup", file=sys.stderr, flush=True)

    def list_voice_memos(self, backup):
        return {"voice_memos": [], "empty_reason": "not_in_backup"}

    def get_audio_path(self, backup, memo_id):
        return None

    def get_transcript(self, backup, memo_id):
        return None


def memo_id(value):
    """A recording id as an int, or None when it isn't one: an int or a string of digits, never a bool."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        number = value
    elif isinstance(value, str) and _DIGITS.fullmatch(value.strip()):
        try:
            number = int(value.strip())
        except ValueError:  # more digits than Python makes a number of (4300): no recording's id
            return None
    else:
        return None
    return number if 0 <= number <= _MAX_ID else None


def _unused_stem(folder: str, stem: str, extensions: tuple) -> str:
    """``stem``, or "stem (2)" and so on, so that none of ``stem + ext`` for ``extensions`` exists in ``folder``."""
    candidate, n = stem, 2
    while any(os.path.exists(os.path.join(folder, candidate + ext)) for ext in extensions):
        candidate = f"{stem} ({n})"
        n += 1
    return candidate


def _yes_no(value) -> str:
    """"Yes", "No", or "" when the backup doesn't say (an older version has no such column)."""
    if value is None:
        return ""
    return "Yes" if value else "No"


def _duration(seconds) -> str:
    """"0:01:23" for a recording's length, or "" when it isn't known."""
    if seconds is None or isinstance(seconds, bool):
        return ""
    try:
        total = int(round(float(seconds)))
    except (TypeError, ValueError, OverflowError):
        return ""
    if total < 0:
        return ""
    hours, rest = divmod(total, 3600)
    minutes, secs = divmod(rest, 60)
    return f"{hours}:{minutes:02d}:{secs:02d}"


def _set_file_date(path: str, iso) -> None:
    """Give a saved file the date its recording was made, so Finder and Explorer sort by it.

    Sets the modified and accessed times (on a Mac an earlier modified time
    moves the created date back too). Skips a missing date, and one the drive
    can't store.
    """
    if not iso:
        return
    try:
        stamp = datetime.fromisoformat(iso).timestamp()
        os.utime(path, (stamp, stamp))
    except (TypeError, ValueError, OverflowError, OSError):
        pass


def _copy_new(src: str, dest: str) -> None:
    """Copy the bytes of ``src`` to a new file ``dest``; never overwrites, never leaves half a file.

    Only the bytes: not the permissions, which on a backup from an exFAT or
    NTFS drive mark every file executable (app_copies.py).
    """
    try:
        with open(src, "rb") as fin, open(dest, "xb") as fout:
            while True:
                chunk = fin.read(_COPY_CHUNK)
                if not chunk:
                    break
                fout.write(chunk)
    except BaseException:
        if os.path.exists(dest):
            try:
                os.remove(dest)
            except OSError:
                pass
        raise


def _problem(result: dict) -> dict:
    """The error to return for a list that couldn't be read, with its empty_reason (an older
    layout's "unsupported_format") when it has one."""
    problem = {"error": result["error"]}
    if result.get("empty_reason"):
        problem["empty_reason"] = result["empty_reason"]
    return problem


def _missing_error(memo: dict) -> dict:
    """What the app is told about a recording whose audio isn't in the backup."""
    if memo.get("audio_missing_reason") == "in_icloud_only":
        return {"error": AUDIO_IN_ICLOUD, "empty_reason": "in_icloud_only"}
    return {"error": AUDIO_NOT_IN_BACKUP, "empty_reason": "not_in_backup"}


def _transcript_shape(found) -> dict:
    """The library's transcript (or None) as the app's: text, segments, locale."""
    if not isinstance(found, dict):
        return {"text": None, "segments": [], "locale": None}
    segments = []
    for segment in found.get("segments") or []:
        if isinstance(segment, dict) and isinstance(segment.get("text"), str):
            segments.append({"text": segment["text"], "start": segment.get("start"), "end": segment.get("end")})
    text = found.get("text")
    text = text if isinstance(text, str) and text.strip() else None
    locale = found.get("locale")
    return {"text": text, "segments": segments if text else [],
            "locale": locale if isinstance(locale, str) and text else None}


class VoiceMemoExtractor:
    """Adapter wrapping the ios-backup-core VoiceMemoExtractor."""

    # The time zone saves show dates in (the CSV, file names); None is this
    # computer's, as the app and the other saves use (local_dates.py).
    local_tz = None

    def __init__(self):
        self._inner = _CoreVoiceMemoExtractor() if _CoreVoiceMemoExtractor is not None else _NoVoiceMemoSupport()
        self._copies = AppCopies("voice-memos")

    # ── Reading ──────────────────────────────────────────────────────────────

    def list_voice_memos(self, backup) -> dict:
        """Every recording, newest first, and the user's folders (the library's answer, unchanged)."""
        return self._inner.list_voice_memos(backup)

    def _find(self, backup, value):
        """(the recording with this id, None), or (None, the error to return)."""
        wanted = memo_id(value)
        if wanted is None:
            return None, {"error": NOT_FOUND}
        listed = self.list_voice_memos(backup)
        if listed.get("error"):
            return None, {"error": listed["error"]}
        memo = next((m for m in listed.get("voice_memos") or [] if m.get("id") == wanted), None)
        if memo is None:
            return None, {"error": NOT_FOUND}
        return memo, None

    def get_audio(self, backup, value, as_file: bool = False, on_progress=None) -> dict:
        """One recording's audio for the app.

        Default: ``{data (base64), mime_type, memo_id, filename, size}``. Over
        MAX_INLINE_BYTES: ``{too_large: True, mime_type, memo_id, filename,
        size}`` with no data. ``as_file``: ``{path, mime_type, filename, size,
        openable}``, a copy under the recording's own name for another app.
        Audio that isn't in the backup is ``{error, empty_reason}``
        ("in_icloud_only" or "not_in_backup"); an id that matches nothing is
        ``{error: "Recording not found."}``.
        """
        memo, problem = self._find(backup, value)
        if problem:
            return problem
        if not memo.get("audio_available"):
            return _missing_error(memo)
        path = self._inner.get_audio_path(backup, memo["id"])
        try:
            size = os.path.getsize(path) if path else None
        except OSError:
            size = None
        if size is None:
            # Listed in the backup's manifest, but the file isn't in its folder.
            return {"error": AUDIO_NOT_IN_BACKUP, "empty_reason": "not_in_backup"}
        filename = self.app_file_name(memo)
        if as_file:
            try:
                dest = self._copies.copy(path, (getattr(backup, "udid", ""), str(memo["id"])), filename, on_progress)
            except OSError as e:
                print(f"[voice_memos] could not copy recording {memo['id']}: {e}", file=sys.stderr, flush=True)
                return {"error": FILE_NOT_COPIED}
            return {"path": dest, "mime_type": _MIME, "filename": filename, "size": size,
                    "openable": is_openable(filename)}
        if size > MAX_INLINE_BYTES:
            return {"too_large": True, "mime_type": _MIME, "memo_id": memo["id"], "filename": filename, "size": size}
        try:
            with open(path, "rb") as f:
                raw = f.read()
        except OSError as e:
            print(f"[voice_memos] could not read recording {memo['id']}: {e}", file=sys.stderr, flush=True)
            return {"error": FILE_UNREADABLE}
        return {"data": base64.b64encode(raw).decode("ascii"), "mime_type": _MIME, "memo_id": memo["id"],
                "filename": filename, "size": size}

    def get_transcript(self, backup, value) -> dict:
        """``{memo_id, text, segments, locale}``; text is None (and segments []) when the recording has none."""
        memo, problem = self._find(backup, value)
        if problem:
            return problem
        found = None
        if memo.get("has_transcript") is not False and memo.get("audio_available"):
            try:
                found = self._inner.get_transcript(backup, memo["id"])
            except Exception as e:  # noqa: BLE001  a transcript is extra: its failure is never the call's
                print(f"[voice_memos] could not read the transcript of {memo['id']}: {e}", file=sys.stderr, flush=True)
        return {"memo_id": memo["id"], **_transcript_shape(found)}

    def _transcript_from(self, backup, memo, path=None):
        """The transcript text of a recording whose audio is at ``path`` (or found here), or None."""
        if memo.get("has_transcript") is False or not memo.get("audio_available"):
            return None
        try:
            if path and _mp4 is not None:
                found = _mp4.read_transcript(path)
            else:
                found = self._inner.get_transcript(backup, memo["id"])
        except Exception:  # noqa: BLE001
            return None
        return _transcript_shape(found)["text"]

    # ── Names ────────────────────────────────────────────────────────────────

    def _stamp(self, iso) -> str:
        """"2026-05-13 14.15": when it was recorded, in local time, for a file name."""
        dt = local_datetime(iso, self.local_tz)
        return f"{dt:%Y-%m-%d %H.%M}" if dt is not None else ""

    def app_file_name(self, memo: dict) -> str:
        """"Site walk 2026-05-13 14.15.m4a": the name another app shows for a recording opened from here."""
        base = f"{memo.get('title') or DEFAULT_TITLE} {self._stamp(memo.get('date'))}"
        return title_stem(base, DEFAULT_TITLE) + "." + (memo.get("format") or "m4a")

    def _save_stem(self, memo: dict) -> str:
        """"2026-05-13 14.15 Site walk": a saved recording's name, so a folder of them sorts by date."""
        base = f"{self._stamp(memo.get('date'))} {memo.get('title') or DEFAULT_TITLE}"
        return title_stem(base, DEFAULT_TITLE)

    # ── Saving ───────────────────────────────────────────────────────────────

    def export_voice_memos(self, backup, output_dir: str, fmt: str = "recordings", memo_ids=None,
                           on_progress=None) -> dict:
        """Save the recordings (see the module docstring) into ``output_dir``.

        Returns ``{"status": "success", "count", "path", "files",
        "not_in_backup", "failed"}``: count is the recordings copied (or the
        CSV's rows), path the "Voice Memos" folder, the CSV or the one
        recording saved, files every file written, not_in_backup the
        recordings whose audio isn't in the backup, failed those that couldn't
        be copied. Nothing to save is an error with ``empty_reason`` and
        writes nothing; a library that can't be read passes its error through.
        """
        if fmt not in FORMATS:
            return {"error": f"Unsupported format: {fmt}"}
        listed = self.list_voice_memos(backup)
        if listed.get("error"):
            return _problem(listed)
        memos = listed.get("voice_memos") or []
        if not memos:
            return {"error": NOTHING_TO_SAVE, "empty_reason": listed.get("empty_reason") or "no_records"}
        if memo_ids is not None:
            if not isinstance(memo_ids, (list, tuple)):
                memo_ids = [memo_ids]
            wanted = {n for n in (memo_id(v) for v in memo_ids) if n is not None}
            memos = [m for m in memos if m.get("id") in wanted]
            if not memos:
                return {"error": NOT_FOUND}
        try:
            if fmt == "csv":
                return self._write_csv_only(backup, memos, output_dir)
            if memo_ids is not None:
                return self._write_chosen(backup, memos, output_dir, on_progress)
            return self._write_folder(backup, memos, output_dir, on_progress)
        except OSError as e:
            return {"error": f"Voice memos couldn't be saved there: {e.strerror or e}"}

    def _copy_each(self, backup, memos, folder, deleted_apart: bool, on_progress) -> dict:
        """Copy each recording whose audio is in the backup into ``folder`` (Recently Deleted
        ones into a subfolder when ``deleted_apart``), with its transcript beside it.

        Returns what happened: files written, each recording's Audio File cell
        and transcript text, and the counts.
        """
        done = {"files": [], "audio": {}, "transcripts": {}, "exported": 0, "not_in_backup": 0, "failed": 0,
                "first_error": None}
        available = [m for m in memos if m.get("audio_available")]
        for memo in memos:
            if not memo.get("audio_available"):
                done["audio"][memo["id"]] = _MISSING_WORDS.get(memo.get("audio_missing_reason"), _MISSING_WORDS["not_in_backup"])
                done["not_in_backup"] += 1
        progress = ExportProgress(on_progress, len(available))
        handled = 0
        if available:
            progress.update(0, 0)
        for memo in available:
            handled += 1
            src = self._inner.get_audio_path(backup, memo["id"])
            if not src or not os.path.isfile(src):
                # Listed in the manifest, but not in the backup's folder.
                done["audio"][memo["id"]] = _MISSING_WORDS["not_in_backup"]
                done["not_in_backup"] += 1
                progress.update(handled, done["failed"])
                continue
            target = folder
            if deleted_apart and memo.get("is_deleted"):
                target = os.path.join(folder, DELETED_FOLDER)
            ext = "." + (memo.get("format") or "m4a")
            transcript = self._transcript_from(backup, memo, src)
            extensions = (ext, ".txt") if transcript else (ext,)
            dest = None
            try:
                os.makedirs(target, exist_ok=True)
                stem = _unused_stem(target, self._save_stem(memo), extensions)
                dest = os.path.join(target, stem + ext)
                _copy_new(src, dest)
                _set_file_date(dest, memo.get("date"))
                done["files"].append(dest)
                done["exported"] += 1
                relative = os.path.relpath(dest, folder).replace(os.sep, "/")
                done["audio"][memo["id"]] = relative
                if transcript:
                    done["transcripts"][memo["id"]] = transcript
                    text_path = os.path.join(target, stem + ".txt")
                    with open(text_path, "x", encoding="utf-8", errors="replace", newline="\n") as f:
                        f.write(transcript.rstrip("\n") + "\n")
                    _set_file_date(text_path, memo.get("date"))
                    done["files"].append(text_path)
            except OSError as e:
                print(f"[voice_memos] could not save recording {memo['id']}: {e}", file=sys.stderr, flush=True)
                if dest is None or dest not in done["files"]:
                    done["failed"] += 1
                    done["audio"][memo["id"]] = _NOT_COPIED_WORDS
                    done["first_error"] = done["first_error"] or e
            progress.update(handled, done["failed"])
        return done

    def _write_folder(self, backup, memos, output_dir, on_progress) -> dict:
        if not any(m.get("audio_available") for m in memos):
            return {"error": NO_AUDIO_TO_SAVE, "empty_reason": "not_in_backup"}
        os.makedirs(output_dir, exist_ok=True)
        folder = os.path.join(output_dir, _unused_name(output_dir, FOLDER_NAME, ""))
        os.mkdir(folder)
        done = self._copy_each(backup, memos, folder, True, on_progress)
        csv_path = os.path.join(folder, _unused_name(folder, CSV_NAME, ".csv"))
        self._write_rows(csv_path, (self._row(m, done["audio"].get(m["id"], ""), done["transcripts"].get(m["id"]))
                                    for m in memos))
        return {"status": "success", "count": done["exported"], "path": folder, "files": done["files"] + [csv_path],
                "not_in_backup": done["not_in_backup"], "failed": done["failed"]}

    def _write_chosen(self, backup, memos, output_dir, on_progress) -> dict:
        if not any(m.get("audio_available") for m in memos):
            if len(memos) == 1:
                return _missing_error(memos[0])
            return {"error": NO_AUDIO_TO_SAVE, "empty_reason": "not_in_backup"}
        done = self._copy_each(backup, memos, output_dir, False, on_progress)
        if not done["exported"]:
            if done["first_error"] is not None:
                e = done["first_error"]
                return {"error": f"Voice memos couldn't be saved there: {e.strerror or e}"}
            if len(memos) == 1:
                return {"error": AUDIO_NOT_IN_BACKUP, "empty_reason": "not_in_backup"}
            return {"error": NO_AUDIO_TO_SAVE, "empty_reason": "not_in_backup"}
        return {"status": "success", "count": done["exported"], "path": done["files"][0], "files": done["files"],
                "not_in_backup": done["not_in_backup"], "failed": done["failed"]}

    def _write_csv_only(self, backup, memos, output_dir) -> dict:
        # Read everything before writing, so a failure leaves no half-written file.
        rows = []
        for memo in memos:
            if memo.get("audio_available"):
                audio = memo.get("file_name") or ""
            else:
                audio = _MISSING_WORDS.get(memo.get("audio_missing_reason"), _MISSING_WORDS["not_in_backup"])
            transcript = None
            if memo.get("has_transcript"):
                transcript = self._transcript_from(backup, memo)
            rows.append(self._row(memo, audio, transcript))
        os.makedirs(output_dir, exist_ok=True)
        path = os.path.join(output_dir, _unused_name(output_dir, CSV_NAME, ".csv"))
        self._write_rows(path, rows)
        missing = sum(1 for m in memos if not m.get("audio_available"))
        return {"status": "success", "count": len(memos), "path": path, "files": [path],
                "not_in_backup": missing, "failed": 0}

    @staticmethod
    def _write_rows(path, rows) -> None:
        # utf-8-sig: Excel reads the file as UTF-8 only with the BOM in front.
        with open(path, "x", newline="", encoding="utf-8-sig", errors="replace") as f:
            writer = csv.writer(f)
            writer.writerow(CSV_HEADER)
            for row in rows:
                writer.writerow([_csv_cell(cell) for cell in row])

    def _row(self, memo: dict, audio: str, transcript) -> list:
        return [
            memo.get("title") or "",
            self._csv_date(memo.get("date")),
            _duration(memo.get("duration_seconds")),
            memo.get("folder") or "",
            _yes_no(memo.get("is_favorite")),
            _yes_no(memo.get("is_deleted")),
            self._csv_date(memo.get("deleted_date")),
            _yes_no(memo.get("recorded_on_watch")),
            audio,
            transcript or "",
        ]

    def _csv_date(self, iso) -> str:
        """The date as ISO 8601 in local time with its offset, e.g.
        "2024-07-05T09:10:09-07:00": the same moment as the library's UTC
        value, and the clock time people expect (local_dates.py)."""
        return csv_date(iso, self.local_tz)
