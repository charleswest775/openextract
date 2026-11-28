"""
Whether a backup on the app's list may go to the Trash, and what the question has to say.

The home screen's list of backups offers Move to Trash for each one, for someone who wants the
room back. Nothing here deletes or moves anything: electron/olderBackups.ts asks the person and
moves that one folder, and only after a second check agrees with the first.

Unlike an older backup moved from inside a newer one (older_backups.py), this one may be the only
copy of what's in it, which is the person's call to make. So the checks are about taking nothing
else with it, and the Trash really keeping it; what the question must say comes back with them:

  - It's a backup's own folder: a real folder, not a link or a whole drive, with what says it's
    a backup, and not already in a Trash.
  - It holds only what a backup holds, all of it on this computer (older_backups._measure):
    someone may have saved photos into it, and those would go to the Trash with it.
  - The Trash will really keep it (trash_room.py).
  - Other backups of the same iPhone, in the usual folders and beside this one, so the question
    can say whether this is the only one, or the newest.

OpenExtract making a backup at the time is the main process's to refuse; it knows.
"""

from __future__ import annotations

import os
import sys
from datetime import datetime, timezone
from typing import Callable, Optional

import backup_files
import backup_status
import older_backups
import trash_room

ReadInfo = Callable[[str], Optional[dict]]
ListBackups = Callable[[], dict]

# The question names a few of the others; more than that wouldn't fit.
_MOST_OTHERS = 3
_LONGEST_TEXT = 200


def _bin() -> str:
    return "Recycle Bin" if sys.platform == "win32" else "Trash"


NOT_A_BACKUP = "There's no iPhone backup in that folder now, so OpenExtract won't move it."
A_LINK = (
    "That backup's folder is a link to another folder, so OpenExtract won't move it. "
    "Look at where it leads first."
)


def already_in_bin() -> str:
    return f"That backup is already in the {_bin()}."


def _text(value) -> str:
    return value[:_LONGEST_TEXT] if isinstance(value, str) else ""


def _norm(udid) -> str:
    return udid.replace("-", "").lower() if isinstance(udid, str) else ""


def _when(info: dict) -> str:
    """The backup's date as ISO with its zone, or "" when it has none that reads."""
    try:
        when = datetime.fromisoformat(info.get("last_backup") or "")
    except (TypeError, ValueError, OverflowError):
        return ""
    if when.tzinfo is None:
        when = when.replace(tzinfo=timezone.utc)
    return when.astimezone(timezone.utc).isoformat()


def _same(a: str, b: str) -> bool:
    try:
        return os.path.samefile(a, b)
    except OSError:
        return os.path.normcase(os.path.realpath(a)) == os.path.normcase(os.path.realpath(b))


def others(folder: str, udid: str, read_info: ReadInfo, list_backups: ListBackups) -> list[dict]:
    """Other backups of the iPhone `udid`: in the usual folders, and beside `folder`. Newest first."""
    seen: list[str] = []
    found: list[dict] = []

    def consider(path: str, info: Optional[dict]) -> None:
        if not info or _norm(info.get("udid")) != udid or _same(path, folder):
            return
        if any(_same(path, other) for other in seen):
            return
        seen.append(path)
        found.append({
            "backup_dir": path,
            "device_name": _text(info.get("device_name")),
            "last_backup": _when(info),
            "encrypted": bool(info.get("encrypted")),
            "unfinished": bool(info.get("unfinished")),
        })

    try:
        for info in list_backups().get("backups", []):
            if isinstance(info, dict) and isinstance(info.get("backup_dir"), str):
                consider(info["backup_dir"], info)
    except Exception as e:  # a usual folder that can't be read mustn't stop the question
        print(f"[trash] couldn't look in the usual folders: {type(e).__name__}", file=sys.stderr, flush=True)

    parent = os.path.dirname(folder)
    try:
        with os.scandir(parent) as entries:
            # Only folders named for this iPhone: the folder may be the person's home.
            paths = [e.path for e in entries if older_backups._named_for(e.name, udid)]
    except OSError:
        paths = []
    for path in paths:
        try:
            if os.path.isdir(path) and not os.path.islink(path):
                consider(path, read_info(path))
        except Exception as e:  # one odd folder mustn't hide the others
            print(f"[trash] skipped a folder that couldn't be read: {type(e).__name__}", file=sys.stderr, flush=True)

    found.sort(key=lambda o: o["last_backup"], reverse=True)
    return found


def check(backup_dir: str, read_info: ReadInfo, list_backups: ListBackups) -> dict:
    """
    Whether `backup_dir` may go to the Trash now:

        {"allowed": False, "reason": <words for the person>}
        {"allowed": True, "backup": {...}, "others": [{...}], "more_others": int,
         "stamp": <changes if the folder does>}

    `backup` and `others` hold what the question needs to say. The Trash's room is asked before
    reading the folder through, to refuse quickly, and again after, with its real size.
    """
    try:
        if not isinstance(backup_dir, str) or not backup_dir:
            raise older_backups._Refused(NOT_A_BACKUP)
        if os.path.islink(backup_dir) or backup_files.is_link(os.lstat(backup_dir)):
            raise older_backups._Refused(A_LINK)
        folder = os.path.realpath(backup_dir)
        if older_backups._in_a_trash(folder):
            raise older_backups._Refused(already_in_bin())
        if not os.path.isdir(folder) or os.path.ismount(folder):
            raise older_backups._Refused(NOT_A_BACKUP)
        info = read_info(folder)
        if not info:
            raise older_backups._Refused(NOT_A_BACKUP)
        problem = trash_room.problem(folder, 0, len(folder))
        if problem:
            raise older_backups._Refused(problem)
        size = older_backups._measure(folder, trash_room.cluster_size(folder))
        st = os.lstat(folder)
        index = [os.stat(os.path.join(folder, name)).st_mtime_ns
                 for name in ("Manifest.db", "Manifest.mbdb", "Manifest.plist", "Status.plist")
                 if os.path.exists(os.path.join(folder, name))]
        problem = trash_room.problem(folder, size["room"], size["longest"])
        if problem:
            raise older_backups._Refused(problem)
    except older_backups._Refused as e:
        return {"allowed": False, "reason": str(e)}
    except FileNotFoundError:
        return {"allowed": False, "reason": NOT_A_BACKUP}
    except OSError:
        return {"allowed": False, "reason": older_backups.CANT_READ}
    except Exception as e:
        print(f"[trash] the check failed: {type(e).__name__}", file=sys.stderr, flush=True)
        return {"allowed": False, "reason": older_backups.CANT_CHECK}

    udid = _norm(info.get("udid"))
    found = others(folder, udid, read_info, list_backups) if udid else []
    status = backup_status.check(folder)
    stamp = (st.st_dev, st.st_ino, size["files"], size["bytes"], size["latest"], *index)
    return {
        "allowed": True,
        "backup": {
            "backup_dir": folder,
            "device_name": _text(info.get("device_name")),
            "phone_number": _text(info.get("phone_number")),
            "last_backup": _when(info),
            "encrypted": bool(info.get("encrypted")),
            "unfinished": not status.finished,
            "bytes": size["bytes"],
        },
        "others": found[:_MOST_OTHERS],
        "more_others": max(0, len(found) - _MOST_OTHERS),
        "stamp": ":".join(str(part) for part in stamp),
    }
