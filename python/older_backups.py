"""
Older backups that can be moved to the Trash from inside a newer one.

Back up my iPhone keeps every backup (backup_beside.py), so someone needs a way to get the room
back. Nothing here deletes or moves anything: it says what may go, and electron/olderBackups.ts
asks the person and moves that one folder to the Trash, then only if a second check agrees.

A backup may go only if all of these hold:

  - The one that stays is open, so it unlocked, and is still exactly what was opened (identity):
    the keys and list of files an open backup reads with are copies from then. OpenExtract saw
    the iPhone finish it (backup_status: confirmed), and every file it lists is there, as a file
    of its own, not a link (backup_files.stored_whole).
  - The one to go is in the same folder, named as that iPhone's backups are, says it's that
    iPhone's, finished, can still be unlocked, and is older by the iPhone's dates and by this
    computer's. So the newest can never go. One that didn't finish or has lost its keys is never
    offered: its folder may be the only way back to what's in it. Nor is one still in a work
    folder, whose place the next try takes: put back, it would mix with that one.
  - It holds only what a backup holds, all of it on this computer. Someone may have saved photos
    into it, or backed up into it, and those would go to the Trash with it.
  - The Trash will really keep it (trash_room.py).

What this can't know: whether the folder came from someone who forged all of that. The question
the person is asked shows both folders, and says first when the newer one is smaller.
"""

from __future__ import annotations

import hashlib
import math
import os
import plistlib
import re
import stat
import sys
from datetime import datetime, timezone
from typing import Callable, Optional

import backup_beside
import backup_files
import backup_status
import trash_room

ReadInfo = Callable[[str], Optional[dict]]

_FILES = frozenset({
    "Info.plist", "Status.plist", "Manifest.plist",
    "Manifest.db", "Manifest.db-wal", "Manifest.db-shm", "Manifest.db-journal",
    "Manifest.mbdb", "Manifest.mbdx",
    backup_status.MARKER_FILE, backup_status.MARKER_FILE + ".tmp",
})
# What says whose a backup is, that it finished, and how it unlocks.
_IDENTIFYING = ("Info.plist", "Status.plist", "Manifest.plist", "Manifest.db", "Manifest.mbdb",
                backup_status.MARKER_FILE)
_CLUTTER = frozenset({".DS_Store", "desktop.ini", "Thumbs.db"})
_STORED_RE = re.compile(r"[0-9a-fA-F]{40}")
_STORED_DIR_RE = re.compile(r"[0-9a-fA-F]{2}")
_NAMED_RE = re.compile(r"(.+?)(?:-\d{8}-\d{6}(?:-\d+)?)?")
_IN_A_TRASH = frozenset({".trash", ".trashes", "$recycle.bin"})
_MBDB_HEADER = b"mbdb\x05\x00"
_LONGEST_TEXT = 200

NOT_OFFERED = (
    "OpenExtract can't move that backup. It only moves a finished backup that's older than the "
    "one you have open, of the same iPhone and in the same folder."
)
KEPT_CHANGED = (
    "The backup you have open has changed or been disconnected since you opened it, so "
    "OpenExtract won't move an older one. Open it again first."
)
KEPT_NOT_WHOLE = (
    "OpenExtract couldn't confirm that the backup you have open has all its files, so it won't "
    "move an older one. The older one may be the only whole copy."
)
OTHER_THINGS = (
    "That backup's folder has other files or folders in it, which would go with it, so "
    "OpenExtract won't move it. Look inside it first."
)
ONLINE_ONLY = (
    "Some of that backup is only online, for example in OneDrive or iCloud Drive, where removing "
    "it works differently, so OpenExtract won't move it."
)
CANT_READ = "OpenExtract couldn't read all of that backup's folder, so it won't move it."
CANT_CHECK = "OpenExtract couldn't check that backup, so it won't move it."


class _Refused(Exception):
    pass


def identity(folder: str) -> Optional[dict]:
    """What a backup's folder is, taken as it's opened. None if it can't be read."""
    try:
        real = os.path.realpath(folder)
        st = os.stat(real)
        found: dict = {"folder": (real, st.st_dev, st.st_ino)}
        for name in _IDENTIFYING:
            try:
                file = os.lstat(os.path.join(real, name))
            except FileNotFoundError:
                continue
            found[name] = (file.st_mode, file.st_ino, file.st_size, file.st_mtime_ns)
        if "Manifest.plist" in found:
            with open(os.path.join(real, "Manifest.plist"), "rb") as f:
                found["keys"] = hashlib.sha256(f.read()).hexdigest()
    except OSError:
        return None
    return found


def _as_opened(kept) -> bool:
    then = getattr(kept, "opened_as", None)
    return then is not None and then == identity(kept.backup_dir)


def _when(info: dict) -> Optional[datetime]:
    try:
        when = datetime.fromisoformat(info.get("last_backup") or "")
        if when.tzinfo is None:
            when = when.replace(tzinfo=timezone.utc)
        return when.astimezone(timezone.utc)
    except (TypeError, ValueError, OverflowError):
        return None


def _finished_at(folder: str) -> Optional[float]:
    marker = backup_status.read_marker(folder) or {}
    at = marker.get("finished_at")
    if marker.get("state") == "finished" and isinstance(at, (int, float)) and math.isfinite(at):
        return float(at)
    return None


def _norm(udid) -> str:
    return udid.replace("-", "").lower() if isinstance(udid, str) else ""


def _named_for(name: str, udid: str) -> bool:
    """name is <udid> or <udid>-<date>-<time>, as backup_beside and Finder name backups."""
    match = _NAMED_RE.fullmatch(name)
    return bool(udid and match and _norm(match.group(1)) == udid)


def _in_a_trash(path: str) -> bool:
    parts = path.replace("\\", "/").lower().split("/")
    return any(part in _IN_A_TRASH or part.startswith(".trash-") for part in parts)


def _can_be_unlocked(folder: str) -> bool:
    """Its keys are there, or it needs none."""
    try:
        with open(os.path.join(folder, "Manifest.plist"), "rb") as f:
            manifest = plistlib.load(f)
        if manifest.get("IsEncrypted"):
            return bool(manifest.get("BackupKeyBag"))
        db = os.path.join(folder, "Manifest.db")
        if os.path.exists(db):
            return backup_status.is_plain_sqlite(db)
        with open(os.path.join(folder, "Manifest.mbdb"), "rb") as f:
            return f.read(len(_MBDB_HEADER)) == _MBDB_HEADER
    except Exception:  # plistlib raises many kinds for a damaged file
        return False


def _index_written(folder: str) -> Optional[float]:
    for name in ("Manifest.db", "Manifest.mbdb"):
        try:
            return os.stat(os.path.join(folder, name)).st_mtime
        except FileNotFoundError:
            continue
    return None


def _find(kept, read_info: ReadInfo) -> tuple[str, Optional[dict], list[dict]]:
    """The open backup's real folder, what it says now, and the older backups beside it."""
    kept_dir = os.path.realpath(kept.backup_dir)
    if _in_a_trash(kept_dir) or not _as_opened(kept):
        return kept_dir, None, []
    status = backup_status.check(kept_dir)
    if not status.confirmed or not status.openable:
        return kept_dir, None, []
    kept_info = read_info(kept_dir)
    if not kept_info:
        return kept_dir, None, []
    udid = _norm(kept_info.get("udid"))
    kept_when, kept_at = _when(kept_info), _finished_at(kept_dir)
    folder, name = os.path.split(kept_dir)
    if backup_beside.is_work_dir(os.path.basename(folder)) and _norm(name) == udid:
        folder = os.path.dirname(folder)
    elif not _named_for(name, udid):
        # One renamed by hand isn't seen by the next backup (backup_beside.Destination), which
        # could then take the older one's place, to be merged with it if that's put back.
        return kept_dir, kept_info, []
    if not kept_when or kept_at is None:
        return kept_dir, kept_info, []
    try:
        with os.scandir(folder) as entries:
            # Nothing else is even looked at: the folder may be the person's home.
            paths = [entry.path for entry in entries if _named_for(entry.name, udid)]
    except OSError:
        return kept_dir, kept_info, []

    found = []
    for path in paths:
        try:
            st = os.lstat(path)
            if not stat.S_ISDIR(st.st_mode) or backup_files.is_link(st) or os.path.samefile(path, kept_dir):
                continue
            info = read_info(path)
            if not info or _norm(info.get("udid")) != udid:
                continue
            status = backup_status.check(path)
            if not status.finished or not status.openable or not _can_be_unlocked(path):
                continue
            when, at, written = _when(info), _finished_at(path), _index_written(path)
            if not when or when >= kept_when:
                continue
            # And by this computer's clock, in case the iPhone's was wrong.
            if written is None or written >= kept_at or (at is not None and at >= kept_at):
                continue
        except Exception as e:  # one odd folder mustn't hide the others
            print(f"[older] skipped a backup that couldn't be read: {type(e).__name__}", file=sys.stderr, flush=True)
            continue
        found.append({**info, "backup_dir": path, "when": when})
    found.sort(key=lambda info: info["when"], reverse=True)
    return kept_dir, kept_info, found


def list_older(kept, read_info: ReadInfo) -> dict:
    """What Backup details lists. Cheap: check() does the slow part when one is picked."""
    # Only these: the rest of Info.plist can hold anything, of any type.
    return {"backups": [{"backup_dir": info["backup_dir"], "last_backup": info["when"].isoformat(),
                         "encrypted": bool(info.get("encrypted"))}
                        for info in _find(kept, read_info)[2]]}


def _measure(folder: str, cluster: int = 1) -> dict:
    """
    What's in a backup's folder, refusing one that holds anything else. `bytes`, `files` and
    `latest` leave out clutter, which Finder writes just from showing the folder. `room` is all
    of it, each file rounded up to `cluster`.
    """
    found = {"bytes": 0, "room": 0, "files": 0, "latest": 0, "longest": len(folder)}
    flat = not os.path.lexists(os.path.join(folder, "Manifest.db"))  # iOS 9 and earlier

    def stored_name(name: str, within: str) -> bool:
        if not _STORED_RE.fullmatch(name):
            return False
        return name[:2].lower() == within.lower() if within else flat

    def add(entry: os.DirEntry, st: os.stat_result, within: str) -> None:
        name = entry.name
        # macOS keeps a file's attributes in ._<name> on drives that can't hold them.
        about = name[2:] if name.startswith("._") else name
        clutter = about != name or name in _CLUTTER
        known = (about in _CLUTTER or stored_name(about, within)
                 or (not within and (about in _FILES or (
                     about != name and (about == backup_status.SNAPSHOT_DIR or _STORED_DIR_RE.fullmatch(about))))))
        if not known:
            raise _Refused(OTHER_THINGS)
        found["room"] += -(-st.st_size // cluster) * cluster
        found["longest"] = max(found["longest"], len(entry.path))
        if not clutter:
            found["bytes"] += st.st_size
            found["files"] += 1
            found["latest"] = max(found["latest"], st.st_mtime_ns)

    def look(entry: os.DirEntry) -> os.stat_result:
        st = entry.stat(follow_symlinks=False)
        if backup_files.is_link(st):
            raise _Refused(OTHER_THINGS)
        if backup_files.is_online_only(st):
            raise _Refused(ONLINE_ONLY)
        return st

    try:
        with os.scandir(folder) as entries:
            for entry in entries:
                st = look(entry)
                if stat.S_ISREG(st.st_mode):
                    add(entry, st, "")
                elif not stat.S_ISDIR(st.st_mode) or os.path.ismount(entry.path):
                    raise _Refused(OTHER_THINGS)
                elif entry.name == backup_status.SNAPSHOT_DIR:
                    if not backup_status.holds_only_empty_folders(entry.path):
                        raise _Refused(OTHER_THINGS)
                elif _STORED_DIR_RE.fullmatch(entry.name):
                    found["room"] += cluster
                    with os.scandir(entry.path) as stored:
                        for item in stored:
                            item_st = look(item)
                            if not stat.S_ISREG(item_st.st_mode):
                                raise _Refused(OTHER_THINGS)
                            add(item, item_st, entry.name)
                else:
                    raise _Refused(OTHER_THINGS)
    except OSError as e:
        raise _Refused(CANT_READ) from e
    return found


def _text(value) -> str:
    return value[:_LONGEST_TEXT] if isinstance(value, str) else ""


def check(kept, wanted: str, read_info: ReadInfo) -> dict:
    """
    Whether `wanted`, one of list_older()'s folders, may go to the Trash now:

        {"allowed": False, "reason": <words for the person>}
        {"allowed": True, "older": {...}, "newer": {...}, "stamp": <changes if the folder does>}

    older and newer hold what the confirmation needs to say. The one that stays is read first
    and again last, and the one to go as late as can be, as either read can take minutes.
    """
    try:
        if not _as_opened(kept):
            raise _Refused(KEPT_CHANGED)
        kept_dir, kept_info, found = _find(kept, read_info)
        target = next((info for info in found if info["backup_dir"] == wanted), None)
        if target is None or os.path.ismount(wanted):
            raise _Refused(NOT_OFFERED)
        whole = backup_files.stored_whole(kept)
        if whole is None:
            raise _Refused(KEPT_NOT_WHOLE)
        size = _measure(wanted, trash_room.cluster_size(wanted))
        problem = trash_room.problem(wanted, size["room"], size["longest"])
        if problem:
            raise _Refused(problem)
        st = os.lstat(wanted)
        index = [os.stat(os.path.join(wanted, name)).st_mtime_ns
                 for name in ("Manifest.db", "Manifest.mbdb", "Manifest.plist", "Status.plist")
                 if os.path.exists(os.path.join(wanted, name))]
        if not backup_files.names_still_there(kept, whole["ids"]):
            raise _Refused(KEPT_NOT_WHOLE)
        if not _as_opened(kept):
            raise _Refused(KEPT_CHANGED)
    except _Refused as e:
        return {"allowed": False, "reason": str(e)}
    except OSError:
        return {"allowed": False, "reason": CANT_READ}
    except Exception as e:
        print(f"[older] the check failed: {type(e).__name__}", file=sys.stderr, flush=True)
        return {"allowed": False, "reason": CANT_CHECK}

    def facts(info: dict, folder: str, when: datetime, total: int) -> dict:
        return {
            "backup_dir": folder,
            "device_name": _text(info.get("device_name")),
            "phone_number": _text(info.get("phone_number")),
            "last_backup": when.isoformat(),
            "encrypted": bool(info.get("encrypted")),
            "bytes": total,
        }

    stamp = (st.st_dev, st.st_ino, size["files"], size["bytes"], size["latest"], *index)
    return {
        "allowed": True,
        "older": facts(target, wanted, target["when"], size["bytes"]),
        "newer": facts(kept_info, kept_dir, _when(kept_info), whole["bytes"]),
        "stamp": ":".join(str(part) for part in stamp),
    }
