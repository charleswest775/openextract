"""
Whether moving a folder to the Trash loses nothing: not that folder, and nothing already there.

Electron's shell.trashItem never falls back to deleting (shell/common/platform_util_*, 30.5.1),
but that isn't enough on Windows. Measured on Windows 11 with a drive whose Recycle Bin held
299 MB (2026-11-21):

  - A folder bigger than the Recycle Bin: refused, left whole.
  - A folder that fits only without what's already in it: Windows deletes the older items for
    good, without asking, and trashItem reports success. A second backup moved there would
    destroy the first.
  - A folder with a file open: refused, left whole.

So on Windows a folder goes only if it fits beside everything already in that drive's Recycle
Bin. Anything that can't be read counts as no room.

Windows counts the files' own sizes against that limit, not the room they take on the drive
(measured with 12,000 small files), so rounding a folder up to clusters errs toward refusing.

On a Mac the Trash has no limit and the move is one rename (APFS, HFS+ and exFAT were tried).
Network drives may have no Trash, so only the computer's own drives and drives plugged into it.
Linux's Trash differs by desktop and inside Flatpak, and hasn't been tried, so never there.
"""

from __future__ import annotations

import os
import sys
from typing import Optional

_MIB = 1024 * 1024
_MARGIN = 1 * _MIB
_WINDOWS_PATH_MAX = 259
_DRIVE_FIXED = 3
_MNT_LOCAL = 0x1000
_STATFS_FLAGS_AT = 64  # struct statfs's f_flags, with 64-bit inodes

_BIT_BUCKET = r"Software\Microsoft\Windows\CurrentVersion\Explorer\BitBucket"
_POLICIES = (r"Software\Microsoft\Windows\CurrentVersion\Policies\Explorer",
             r"Software\Policies\Microsoft\Windows\Explorer")

NOT_HERE = "OpenExtract doesn't move backups to the Trash on Linux. Check what's in one before you remove it yourself."
NOT_LOCAL = (
    "That backup is on a network drive, which may not have a Trash, so OpenExtract won't move it. "
    "Removing it yourself in Finder may delete it at once, for good, so check what's in it first."
)
NO_BIN = (
    "OpenExtract couldn't confirm that the Recycle Bin on this drive would keep that backup, so "
    "it won't move it. Deleting it yourself may delete it for good, so check what's in it first."
)
TOO_BIG = (
    "That backup is bigger than the Recycle Bin on this drive allows, so OpenExtract won't move "
    "it. Deleting it yourself deletes it for good, so open it and check what's in it first."
)
BIN_TOO_FULL = (
    "There isn't room for that backup in the Recycle Bin beside what's already there. Windows "
    "would permanently delete older things in it to make room, so OpenExtract won't move it. "
    "Check what's in the Recycle Bin before you empty it or delete this backup yourself."
)
PATH_TOO_LONG = (
    "That backup's folder path is too long for the Recycle Bin, so OpenExtract won't move it. "
    "You can look at it in File Explorer."
)


def cluster_size(path: str) -> int:
    """The smallest room a file takes on path's drive, for Windows' sums. 1 elsewhere."""
    if sys.platform != "win32":
        return 1
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    root = ctypes.create_unicode_buffer(1024)
    if not kernel32.GetVolumePathNameW(path, root, len(root)):
        raise ctypes.WinError(ctypes.get_last_error())
    sectors, sector, free, total = (wintypes.DWORD() for _ in range(4))
    if not kernel32.GetDiskFreeSpaceW(root, ctypes.byref(sectors), ctypes.byref(sector),
                                      ctypes.byref(free), ctypes.byref(total)):
        raise ctypes.WinError(ctypes.get_last_error())
    return max(1, sectors.value * sector.value)


def problem(path: str, room: int, longest_path: int) -> Optional[str]:
    """Why path mustn't go to the Trash, in the app's words, or None if it may."""
    if sys.platform == "darwin":
        return None if _is_local(path) else NOT_LOCAL
    if sys.platform != "win32":
        return NOT_HERE
    if longest_path > _WINDOWS_PATH_MAX:
        return PATH_TOO_LONG
    try:
        limit, used = _recycle_bin(path)
    except OSError:
        return NO_BIN
    return fits(room, limit, used)


def fits(room: int, limit: Optional[int], used: int) -> Optional[str]:
    """limit is None when the Recycle Bin is off or its limit isn't known."""
    if limit is None:
        return NO_BIN
    if room + _MARGIN > limit:
        return TOO_BIG
    if used + room + _MARGIN > limit:
        return BIN_TOO_FULL
    return None


def _is_local(path: str) -> bool:
    import ctypes

    try:
        libc = ctypes.CDLL(None, use_errno=True)
        try:
            statfs = getattr(libc, "statfs$INODE64")  # Intel Macs
        except AttributeError:
            statfs = libc.statfs
        found = ctypes.create_string_buffer(4096)
        if statfs(os.fsencode(path), found) != 0:
            return False
        flags = ctypes.c_uint32.from_buffer(found, _STATFS_FLAGS_AT).value
    except (OSError, AttributeError):
        return False
    return bool(flags & _MNT_LOCAL)


def _recycle_bin(path: str) -> tuple[Optional[int], int]:
    """(the most the Recycle Bin on path's drive keeps, what's in it now), in bytes."""
    import ctypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    shell32 = ctypes.WinDLL("shell32", use_last_error=True)

    class Info(ctypes.Structure):
        _fields_ = [("cbSize", ctypes.c_uint32), ("size", ctypes.c_int64), ("items", ctypes.c_int64)]

    root = ctypes.create_unicode_buffer(1024)
    if not kernel32.GetVolumePathNameW(path, root, len(root)):
        raise ctypes.WinError(ctypes.get_last_error())
    # Network drives and memory sticks have no Recycle Bin.
    if kernel32.GetDriveTypeW(root) != _DRIVE_FIXED:
        return None, 0
    volume = ctypes.create_unicode_buffer(100)
    if not kernel32.GetVolumeNameForVolumeMountPointW(root, volume, len(volume)):
        raise ctypes.WinError(ctypes.get_last_error())
    # This comes first: on a drive that has never had a Recycle Bin, asking makes Windows set
    # the limit that's read below.
    info = Info(cbSize=ctypes.sizeof(Info))
    if shell32.SHQueryRecycleBinW(root, ctypes.byref(info)) != 0:
        return None, 0
    volume_id = volume.value[volume.value.index("{"):volume.value.index("}") + 1]
    return _limit(volume_id), info.size


def _limit(volume_id: str) -> Optional[int]:
    import winreg

    def value(hive, key: str, name: str) -> Optional[int]:
        try:
            with winreg.OpenKey(hive, key) as opened:
                found = winreg.QueryValueEx(opened, name)[0]
        except FileNotFoundError:
            return None
        return found if isinstance(found, int) else -1

    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for key in _POLICIES:
            # "Don't use the Recycle Bin", or a size set by the computer's administrator.
            if value(hive, key, "NoRecycleFiles") or value(hive, key, "RecycleBinSize") is not None:
                return None

    keys = [rf"{_BIT_BUCKET}\Volume\{volume_id}"]
    # A folder like Documents that was moved to another drive keeps a limit of its own.
    try:
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, rf"{_BIT_BUCKET}\KnownFolder") as known:
            for i in range(winreg.QueryInfoKey(known)[0]):
                keys.append(rf"{_BIT_BUCKET}\KnownFolder\{winreg.EnumKey(known, i)}")
    except FileNotFoundError:
        pass
    limits = []
    for key in keys:
        most = value(winreg.HKEY_CURRENT_USER, key, "MaxCapacity")
        # NukeOnDelete is "Don't move files to the Recycle Bin".
        if not most or most < 0 or value(winreg.HKEY_CURRENT_USER, key, "NukeOnDelete"):
            return None
        limits.append(most * _MIB)
    return min(limits)
