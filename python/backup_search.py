"""
Finding a backup in a folder the user chose, when it isn't the backup or the folder just above it.

"Open a backup folder" used to look only at the chosen folder and the folders directly inside it.
Choosing one level higher (MobileSync instead of MobileSync/Backup, a drive with Backup/<udid> on
it, or a folder another program keeps its backups one level deeper in) said "No iPhone backups
found", with jargon about UDIDs that didn't say what to choose instead (feedback #191, and #5 and
#9 before it).

So the chosen folder is searched a few levels down, folders whose names sound like backups (and
everything under them) first,
and the search stops after a set number of folders or seconds so choosing a whole drive can't hang
the app. It never goes into a backup or into the two-letter folders backups keep their files in.

When nothing is found, describe() says what the folder held in a sentence with no names in it, so
the app can tell the user what to do and a feedback report can say which case it was (the report
hides the folder's path).
"""

from __future__ import annotations

import os
import re
import heapq
import itertools
import time
from typing import Callable, Optional

import backup_beside

# A backup this many levels below the chosen folder is found: D:\ → Apple Computer\MobileSync\
# Backup\<udid>, or a home folder → AppData\Roaming\Apple Computer\MobileSync\Backup\<udid> isn't
# (6), but the Found list already looks there.
MAX_DEPTH = 4
MAX_DIRS = 4000
MAX_SECONDS = 5.0

_HEX2_RE = re.compile(r"[0-9a-f]{2}", re.IGNORECASE)
_HASH_RE = re.compile(r"[0-9a-f]{40}", re.IGNORECASE)
_LIKELY = ("backup", "mobilesync", "apple", "itunes", "iphone", "ipad", "3utools", "i4tools", "imazing")
# Big folders that never hold a backup. Matched without case.
_SKIP = frozenset(s.lower() for s in (
    "Windows", "Program Files", "Program Files (x86)", "ProgramData", "$Recycle.Bin",
    "System Volume Information", "node_modules", ".git", ".Trash", "Snapshot",
    "Photos Library.photoslibrary", "Caches",
))
_ARCHIVES = (".zip", ".rar", ".7z", ".tar", ".gz", ".tgz", ".imazing")
_MEDIA = (".jpg", ".jpeg", ".heic", ".png", ".gif", ".mov", ".mp4", ".m4v", ".aae", ".webp")


def _priority(name: str) -> int:
    lower = name.lower()
    return 0 if any(word in lower for word in _LIKELY) else 1


def _subdirs(path: str) -> list[str]:
    try:
        with os.scandir(path) as entries:
            names = [e.name for e in entries if _is_dir(e)]
    except OSError:
        return []
    return sorted(names, key=lambda n: (_priority(n), n.lower()))


def _is_dir(entry: os.DirEntry) -> bool:
    try:
        return entry.is_dir()
    except OSError:
        return False


def enclosing(path: str, read_info: Callable[[str], Optional[dict]]) -> Optional[dict]:
    """The backup that path is inside (one of its file folders, or its Snapshot), or None."""
    parent = os.path.dirname(os.path.abspath(path))
    for _ in range(2):
        if not parent or parent == os.path.dirname(parent):
            return None
        info = read_info(parent)
        if info:
            return info
        parent = os.path.dirname(parent)
    return None


def find_below(
    root: str,
    read_info: Callable[[str], Optional[dict]],
    *,
    max_depth: int = MAX_DEPTH,
    max_dirs: int = MAX_DIRS,
    max_seconds: float = MAX_SECONDS,
) -> tuple[list[dict], bool]:
    """
    Backups up to max_depth levels below root, and whether the search stopped before looking
    everywhere. Root itself and the folders directly in it are the caller's to check, but checking
    them again does no harm.
    """
    found: list[dict] = []
    seen = 0
    deadline = time.monotonic() + max_seconds
    # Folders under one whose name sounds like backups go first, then shallower before deeper.
    order = itertools.count()
    queue: list[tuple[int, int, int, str]] = [(1, 0, next(order), root)]
    while queue:
        likely, depth, _, folder = heapq.heappop(queue)
        for name in _subdirs(folder):
            if seen >= max_dirs or time.monotonic() > deadline:
                return found, True
            seen += 1
            path = os.path.join(folder, name)
            if backup_beside.is_work_dir(name):
                # A try that wasn't renamed: offered only if there's something in it to open,
                # as the Found list does.
                for inner in _subdirs(path):
                    info = read_info(os.path.join(path, inner))
                    if info and info.get("openable"):
                        found.append(info)
                continue
            info = read_info(path)
            if info:
                found.append(info)
                continue
            if depth + 1 < max_depth and name.lower() not in _SKIP and not _HEX2_RE.fullmatch(name):
                heapq.heappush(queue, (min(likely, _priority(name)), depth + 1, next(order), path))
    return found, False


def describe(root: str, *, stopped: bool = False) -> str:
    """What's in a folder with no backup in it, in plain words and with no names."""
    try:
        with os.scandir(root) as entries:
            items = [(e.name, _is_dir(e)) for e in entries]
    except OSError:
        return ""
    items = [(n, d) for n, d in items if n not in (".DS_Store", "desktop.ini", "Thumbs.db")]
    dirs = [n for n, d in items if d]
    files = [n for n, d in items if not d]
    lower = [f.lower() for f in files]

    archive = next((f for f in lower if f.endswith(_ARCHIVES)), None)
    if archive:
        ext = os.path.splitext(archive)[1]
        return (f"There's a compressed file ({ext}) in it. If your backup is inside that file, "
                "extract it first, then choose the folder that comes out.")

    hex_dirs = sum(1 for n in dirs if _HEX2_RE.fullmatch(n))
    if hex_dirs >= 16 or sum(1 for f in files if _HASH_RE.fullmatch(f)) >= 16:
        return ("It holds a backup's stored files but not its list of them (Manifest.db), so it "
                "can't be opened. If you copied it from somewhere, copy the whole folder again.")

    if any(f in ("info.plist", "manifest.plist", "status.plist") for f in lower):
        return ("It has some of a backup's files but not its list of them (Manifest.db), so it "
                "can't be opened. If you copied it from somewhere, copy the whole folder again.")

    if not items:
        return "That folder is empty."

    media = sum(1 for f in lower if f.endswith(_MEDIA))
    if files and media >= max(3, len(files) // 2):
        return "It holds photos or videos, not an iPhone backup."

    if stopped:
        return (f"It has a lot in it ({len(dirs)} folders, {len(files)} files at the top), and "
                f"OpenExtract stopped looking after {MAX_DIRS} folders. Choose a folder closer to "
                "the backup.")
    return (f"OpenExtract looked {MAX_DEPTH} folders deep ({len(dirs)} folders and {len(files)} "
            "files at the top) and found no backup.")
