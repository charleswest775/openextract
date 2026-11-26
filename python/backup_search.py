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
the app. It never goes into a backup or into the two-letter folders a backup keeps its files in.
It follows links (people link MobileSync/Backup to an external drive), but goes into each real
folder once and offers each backup once, however many links lead to it.

When nothing is found, describe() says what the folder held in a sentence with no names in it, so
the app can tell the user what to do and a feedback report can say which case it was (the report
hides the folder's path).
"""

from __future__ import annotations

import os
import re
import heapq
import itertools
import stat
import time
from typing import Callable, NamedTuple, Optional

import backup_beside

# A backup this many levels below the chosen folder is found: D:\ → Apple Computer\MobileSync\
# Backup\<udid>, or a home folder → AppData\Roaming\Apple Computer\MobileSync\Backup\<udid> isn't
# (6), but the Found list already looks there.
MAX_DEPTH = 4
MAX_DIRS = 4000
MAX_SECONDS = 5.0

_HEX2_RE = re.compile(r"[0-9a-f]{2}", re.IGNORECASE)
_HASH_RE = re.compile(r"[0-9a-f]{40}", re.IGNORECASE)
# A folder with this many two-letter folders in it holds a backup's stored files.
_STORE_HEX_DIRS = 16
_LIKELY = ("backup", "mobilesync", "apple", "itunes", "iphone", "ipad", "3utools", "i4tools", "imazing")
# Big folders that never hold a backup. Matched without case.
_SKIP = frozenset(s.lower() for s in (
    "Windows", "Program Files", "Program Files (x86)", "ProgramData", "$Recycle.Bin",
    "System Volume Information", "node_modules", ".git", ".Trash", "Snapshot",
    "Photos Library.photoslibrary", "Caches",
    # A Mac's app data: other apps' folders in here make macOS ask "would like to access data
    # from other apps?", and the search waits for the answer.
    "Containers", "Group Containers",
))
_ARCHIVES = (".zip", ".rar", ".7z", ".tar", ".gz", ".tgz", ".imazing")
_MEDIA = (".jpg", ".jpeg", ".heic", ".png", ".gif", ".mov", ".mp4", ".m4v", ".aae", ".webp")
# Windows links that lead to another folder: junctions (C:\Documents and Settings) and symlinks.
_LINK_TAGS = frozenset(getattr(stat, t) for t in ("IO_REPARSE_TAG_MOUNT_POINT", "IO_REPARSE_TAG_SYMLINK")
                       if hasattr(stat, t))


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


def _is_link(entry: os.DirEntry) -> bool:
    """A symlink, or on Windows a junction, which is_symlink() doesn't count before Python 3.12."""
    try:
        if entry.is_symlink():
            return True
        if os.name == "nt":
            # Read from the folder listing on Windows, so it costs nothing.
            return getattr(entry.stat(follow_symlinks=False), "st_reparse_tag", 0) in _LINK_TAGS
    except OSError:
        pass
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


def _real(path: str) -> str:
    """Where path really is, with links resolved."""
    try:
        return os.path.realpath(path)
    except (OSError, ValueError):
        return os.path.abspath(path)


def _key(path: str) -> str:
    return os.path.normcase(path)


class _Item(NamedTuple):
    """
    A folder to look at, or one to list. The first five fields order them: folders under one
    whose name sounds like backups first, then shallower before deeper, then in the order they
    were found. A folder's list comes just before what was in it, so folders are listed as late
    as they can be and no more are listed than are looked at.
    """
    likely: int    # 0 if its name, or a folder it's in, sounds like backups
    depth: int     # levels below the chosen folder (for a list, of what's in it)
    via_link: int  # 1 if a link is on the way: the same folder by its own path goes first
    order: int     # when the folder (or the one it's in) was looked at
    index: int     # -1 to list the folder; else its place in that list
    path: str
    real: str      # where it really is, links resolved
    descend: bool  # False for a big folder that never holds a backup: only it is checked


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

    A folder whose name sounds like backups is looked inside as soon as it's found, before the
    other folders beside it are counted toward max_dirs, so Backup is looked inside even beside
    thousands of others.
    """
    found: list[dict] = []
    found_real: set[str] = set()
    deadline = time.monotonic() + max_seconds
    order = itertools.count()
    root_real = _real(root)
    looked: set[str] = {_key(root_real)}
    queue = [_Item(1, 1, 0, next(order), -1, root, root_real, True)]

    def add_found(info: dict, path: str) -> None:
        real = _key(_real(path))
        if real not in found_real:
            found_real.add(real)
            found.append(info)

    def list_folder(item: _Item) -> None:
        dirs: list[os.DirEntry] = []
        hex_dirs = 0
        manifest = False
        try:
            with os.scandir(item.path) as entries:
                for e in entries:
                    if _is_dir(e):
                        dirs.append(e)
                        hex_dirs += bool(_HEX2_RE.fullmatch(e.name))
                    elif e.name.lower() in ("manifest.db", "manifest.mbdb"):
                        manifest = True
        except OSError:
            return
        # The two-letter folders a backup keeps its files in hold thousands of files and never a
        # backup. Told by how many there are, or the backup's list of them beside them, so a
        # folder of the user's that happens to be called "de" or "ca" is still looked in.
        store = hex_dirs >= _STORE_HEX_DIRS or manifest
        for i, e in enumerate(sorted(dirs, key=lambda d: d.name.lower())):
            if store and _HEX2_RE.fullmatch(e.name):
                continue
            link = _is_link(e)
            heapq.heappush(queue, _Item(
                likely=min(item.likely, _priority(e.name)),
                depth=item.depth,
                via_link=int(link or bool(item.via_link)),
                order=item.order,
                index=i,
                path=e.path,
                real=_real(e.path) if link else os.path.join(item.real, e.name),
                descend=e.name.lower() not in _SKIP,
            ))

    while queue:
        item = heapq.heappop(queue)
        if item.index < 0:
            list_folder(item)
            continue
        key = _key(item.real)
        if key in looked:
            continue  # reached again through a link
        if len(looked) > max_dirs or time.monotonic() > deadline:
            return found, True
        looked.add(key)
        name = os.path.basename(item.path)
        if backup_beside.is_work_dir(name):
            # A try that wasn't renamed: offered only if there's something in it to open,
            # as the Found list does.
            for inner in _subdirs(item.path):
                inner_path = os.path.join(item.path, inner)
                info = read_info(inner_path)
                if info and info.get("openable"):
                    add_found(info, inner_path)
            continue
        info = read_info(item.path)
        if info:
            add_found(info, item.path)
            continue
        if item.depth < max_depth and item.descend and not _above(item.real, root_real):
            heapq.heappush(queue, item._replace(depth=item.depth + 1, order=next(order), index=-1))
    return found, False


def _above(real: str, root_real: str) -> bool:
    """A link back up to a folder the chosen one is in, which would search beside it."""
    real, root_real = _key(real), _key(root_real)
    return root_real == real or root_real.startswith(real.rstrip(os.sep) + os.sep)


def _plural(n: int, one: str, many: str) -> str:
    return f"{n} {one if n == 1 else many}"


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
    if hex_dirs >= _STORE_HEX_DIRS or sum(1 for f in files if _HASH_RE.fullmatch(f)) >= 16:
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

    folders, files_ = _plural(len(dirs), "folder", "folders"), _plural(len(files), "file", "files")
    if stopped:
        return (f"It has a lot in it ({folders}, {files_} at the top), and OpenExtract stopped "
                f"looking after {MAX_DIRS} folders. Choose a folder closer to the backup.")
    return (f"OpenExtract looked {MAX_DEPTH} folders deep ({folders} and {files_} at the top) "
            "and found no backup.")
