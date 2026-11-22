"""
Older backups that can be moved to the Trash from inside a newer one.

Back up my iPhone keeps every backup (backup_beside.py), so someone needs a way to get the room
back. Nothing here deletes or moves anything: it says what may go, and electron/olderBackups.ts
asks the person and moves that one folder to the Trash, then only if a second check agrees.

A backup may go only if all of these hold:

  - The backup it's asked from is open now, so it unlocked, and it's one OpenExtract saw the
    iPhone finish (backup_status: confirmed), with every file it lists still in its folder.
  - The one to go is of the same iPhone, in the same folder, finished, openable and older. So the
    newest can never go. One that didn't finish or can't be unlocked is never offered: its folder
    may be the only way back to what's in it.
  - It holds only what a backup holds. Someone may have saved photos into it, or backed up into
    it, and those would go to the Trash with it.
  - The Trash will really keep it (trash_room.py).
"""

from __future__ import annotations

import os
import re
import stat
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
_CLUTTER = frozenset({".DS_Store", "desktop.ini", "Thumbs.db"})
_STORED_RE = re.compile(r"[0-9a-fA-F]{40}")
_STORED_DIR_RE = re.compile(r"[0-9a-fA-F]{2}")
_JUNCTION = 0xA0000003  # IO_REPARSE_TAG_MOUNT_POINT, which lstat calls a folder

NOT_OFFERED = (
    "OpenExtract can't move that backup. It only moves a finished backup that's older than the "
    "one you have open, of the same iPhone and in the same folder."
)
KEPT_NOT_WHOLE = (
    "OpenExtract couldn't confirm that the backup you have open has all its files, so it won't "
    "move an older one. The older one may be the only whole copy."
)
OTHER_THINGS = (
    "That backup's folder has other files or folders in it, which would go with it, so "
    "OpenExtract won't move it. Look inside it first."
)
CANT_READ = "OpenExtract couldn't read all of that backup's folder, so it won't move it."


class _Refused(Exception):
    pass


def _is_link(st: os.stat_result) -> bool:
    return stat.S_ISLNK(st.st_mode) or getattr(st, "st_reparse_tag", 0) == _JUNCTION


def _when(info: dict) -> Optional[datetime]:
    try:
        when = datetime.fromisoformat(info.get("last_backup") or "")
    except (TypeError, ValueError):
        return None
    return when if when.tzinfo else when.replace(tzinfo=timezone.utc)


def _finished_at(folder: str) -> Optional[float]:
    marker = backup_status.read_marker(folder) or {}
    at = marker.get("finished_at")
    return at if marker.get("state") == "finished" and isinstance(at, (int, float)) else None


def _same_iphone(a: dict, b: dict) -> bool:
    def norm(info: dict) -> str:
        return str(info.get("udid") or "").replace("-", "").lower()
    return norm(a) != "" and norm(a) == norm(b)


def _folder_of(kept_dir: str) -> str:
    """The folder that was backed up into: one up, or two if the backup is still in a work folder."""
    parent = os.path.dirname(kept_dir)
    return os.path.dirname(parent) if backup_beside.is_work_dir(os.path.basename(parent)) else parent


def _find(kept, read_info: ReadInfo) -> tuple[str, Optional[dict], list[dict]]:
    """The open backup's real folder, what it says now, and the older backups beside it."""
    kept_dir = os.path.realpath(kept.backup_dir)
    if not backup_status.check(kept_dir).confirmed:
        return kept_dir, None, []
    kept_info = read_info(kept_dir)
    kept_when = kept_info and _when(kept_info)
    if not kept_when:
        return kept_dir, kept_info, []
    kept_at = _finished_at(kept_dir)
    folder = _folder_of(kept_dir)
    try:
        with os.scandir(folder) as entries:
            paths = [entry.path for entry in entries]
    except OSError:
        return kept_dir, kept_info, []

    found = []
    for path in paths + backup_beside.unplaced(folder):
        try:
            st = os.lstat(path)
            if not stat.S_ISDIR(st.st_mode) or _is_link(st) or os.path.samefile(path, kept_dir):
                continue
            info = read_info(path)
            if not info or not _same_iphone(info, kept_info):
                continue
            status = backup_status.check(path)
        except OSError:
            continue
        if not status.finished or not status.openable:
            continue
        when, at = _when(info), _finished_at(path)
        if not when or when >= kept_when or (at and kept_at and at >= kept_at):
            continue
        found.append({**info, "backup_dir": path})
    found.sort(key=_when, reverse=True)
    return kept_dir, kept_info, found


def list_older(kept, read_info: ReadInfo) -> dict:
    """What Backup details lists. Cheap: check() does the slow part when one is picked."""
    fields = ("backup_dir", "device_name", "product_version", "last_backup", "encrypted")
    return {"backups": [{f: info.get(f) for f in fields} for info in _find(kept, read_info)[2]]}


def _measure(folder: str, cluster: int = 1) -> dict:
    """
    What's in a backup's folder, refusing one that holds anything else. `room` rounds each file
    up to `cluster`, the most it can take up.
    """
    found = {"bytes": 0, "room": 0, "files": 0, "longest": len(folder)}

    def add(entry: os.DirEntry, st: os.stat_result) -> None:
        found["bytes"] += st.st_size
        found["room"] += -(-st.st_size // cluster) * cluster
        found["files"] += 1
        found["longest"] = max(found["longest"], len(entry.path))

    def clutter(name: str) -> bool:
        return name in _CLUTTER or name.startswith("._")

    try:
        with os.scandir(folder) as entries:
            for entry in entries:
                name, st = entry.name, entry.stat(follow_symlinks=False)
                if _is_link(st):
                    raise _Refused(OTHER_THINGS)
                if stat.S_ISREG(st.st_mode):
                    if not (name in _FILES or clutter(name) or _STORED_RE.fullmatch(name)):
                        raise _Refused(OTHER_THINGS)
                    add(entry, st)
                elif stat.S_ISDIR(st.st_mode) and name == backup_status.SNAPSHOT_DIR:
                    if not backup_status.holds_only_empty_folders(entry.path):
                        raise _Refused(OTHER_THINGS)
                elif stat.S_ISDIR(st.st_mode) and _STORED_DIR_RE.fullmatch(name):
                    found["room"] += cluster
                    with os.scandir(entry.path) as stored:
                        for item in stored:
                            item_st = item.stat(follow_symlinks=False)
                            if _is_link(item_st) or not stat.S_ISREG(item_st.st_mode):
                                raise _Refused(OTHER_THINGS)
                            if not (clutter(item.name) or _STORED_RE.fullmatch(item.name)):
                                raise _Refused(OTHER_THINGS)
                            add(item, item_st)
                else:
                    raise _Refused(OTHER_THINGS)
    except OSError as e:
        raise _Refused(CANT_READ) from e
    return found


def _folder_bytes(folder: str) -> int:
    """The open backup's size, for comparison only: nothing in it is refused."""
    total = 0
    with os.scandir(folder) as entries:
        for entry in entries:
            if entry.is_file():
                total += entry.stat().st_size
            elif _STORED_DIR_RE.fullmatch(entry.name) and entry.is_dir():
                with os.scandir(entry.path) as stored:
                    total += sum(f.stat().st_size for f in stored)
    return total


def check(kept, wanted: str, read_info: ReadInfo) -> dict:
    """
    Whether `wanted`, one of list_older()'s folders, may go to the Trash now:

        {"allowed": False, "reason": <words for the person>}
        {"allowed": True, "older": {...}, "newer": {...}, "stamp": <changes if the folder does>}

    older and newer hold what the confirmation needs to say.
    """
    try:
        kept_dir, kept_info, found = _find(kept, read_info)
        target = next((info for info in found if info["backup_dir"] == wanted), None)
        if target is None:
            raise _Refused(NOT_OFFERED)
        if not backup_files.has_every_file(kept):
            raise _Refused(KEPT_NOT_WHOLE)
        if os.path.ismount(wanted):
            raise _Refused(NOT_OFFERED)
        size = _measure(wanted, trash_room.cluster_size(wanted))
        problem = trash_room.problem(wanted, size["room"], size["longest"])
        if problem:
            raise _Refused(problem)
        st = os.lstat(wanted)
        index = [os.stat(os.path.join(wanted, name)).st_mtime_ns
                 for name in ("Manifest.db", "Manifest.mbdb", "Manifest.plist", "Status.plist")
                 if os.path.exists(os.path.join(wanted, name))]
        newer_bytes = _folder_bytes(kept_dir)
    except _Refused as e:
        return {"allowed": False, "reason": str(e)}
    except OSError:
        return {"allowed": False, "reason": CANT_READ}

    def facts(info: dict, folder: str, total: int) -> dict:
        return {
            "backup_dir": folder,
            "device_name": info.get("device_name") or "",
            "phone_number": str(info.get("phone_number") or ""),
            "last_backup": info.get("last_backup") or "",
            "encrypted": bool(info.get("encrypted")),
            "bytes": total,
        }

    return {
        "allowed": True,
        "older": facts(target, wanted, size["bytes"]),
        "newer": facts(kept_info, kept_dir, newer_bytes),
        "stamp": ":".join(str(v) for v in (st.st_dev, st.st_ino, size["files"], size["bytes"], *index)),
    }
