"""
Back up into a folder that already holds that iPhone's backup without putting that backup at risk.

pymobiledevice3's Mobilebackup2Service.backup(full=True) empties <folder>/<udid>/Manifest.plist and
rewrites Info.plist and Status.plist before the iPhone has even asked for its passcode. The first
holds an encrypted backup's keys, so up to 0.18.0 any try that failed left the backup already there
locked for good. Saving those files and putting them back wouldn't be enough: near the end the
iPhone replaces the backup's files one at a time, each with a new key, and the old keys can't read
those.

So a try never writes into an earlier backup. It goes into a folder of its own beside it:

    <folder>/<udid>/                                  the earlier backup, not touched
    <folder>/OpenExtract new backup/<udid>/           the try

A try that fails, is killed or loses power has changed nothing, so there's nothing to put back.
Once the iPhone reports success:

    1. <udid>                        -> OpenExtract new backup/<udid>.previous
    2. OpenExtract new backup/<udid> -> <udid>
    3. <udid>.previous               -> <udid>.old, which is deleted

    Stopped between 1 and 2: recover() puts .previous back the next time that folder is listed or
    opened. Stopped between 2 and 3: the next backup moves .previous out beside the new one.
    Stopped during 3: the next backup finishes deleting .old.

This needs no more room at its peak: in a full backup every file arrives in Snapshot before any
old one is replaced, so the old and new backups were both on the drive anyway.

What may be deleted: a try that has no list of files (Manifest.db), and an earlier backup that was
finished and readable, once the iPhone has confirmed the one replacing it. And only files with a
backup's own names, one by one. Anything else is kept and renamed, and when a rename won't work,
both backups stay where they are.
"""

from __future__ import annotations

import errno
import gc
import hashlib
import os
import plistlib
import re
import stat
import sys
import tempfile
import time
from typing import Callable, NamedTuple, Optional

import backup_status

WORK_DIR = "OpenExtract new backup"
_PREVIOUS = ".previous"
_OLD = ".old"

# Windows won't rename a folder while any file in it is open, as antivirus and the Search indexer
# have files that were just written.
RENAME_WAIT_S = 20.0
_RENAME_RETRY_S = 0.5
_REMOVE_REPORT_EVERY = 1000

_METADATA = frozenset({
    "Info.plist", "Manifest.plist", "Status.plist",
    "Manifest.db", "Manifest.db-shm", "Manifest.db-wal", "Manifest.db-journal",
    "Manifest.mbdb", "Manifest.mbdx",
    backup_status.MARKER_FILE, backup_status.MARKER_FILE + ".tmp",
})
_CLUTTER = frozenset({".DS_Store", "desktop.ini", "Thumbs.db"})
_STORED_FILE_RE = re.compile(r"[0-9a-f]{40}(?:-shm|-wal|-journal)?", re.IGNORECASE)
_HEX_DIR_RE = re.compile(r"[0-9a-f]{2}", re.IGNORECASE)
_UDID_RE = re.compile(r"[0-9A-Za-z-]+")
_WINDOWS_JUNCTION = 0xA0000003  # IO_REPARSE_TAG_MOUNT_POINT

IN_USE = (
    "OpenExtract couldn't prepare a place for the new backup, because it wasn't allowed to change "
    f'the "{WORK_DIR}" folder where you chose to save it. Close any window or program using that '
    "folder, or choose another folder, then try again."
)
BUSY = (
    "Another OpenExtract window is already backing up this iPhone into that folder. Wait for it to "
    "finish, then try again."
)


def _quiet(_msg: str) -> None:
    pass


# ── What's in a folder ───────────────────────────────────────────────────────

def _is_clutter(name: str) -> bool:
    return name in _CLUTTER or name.startswith("._")


def _is_link(st: os.stat_result) -> bool:
    # A junction says it's a folder, even without following links.
    return stat.S_ISLNK(st.st_mode) or getattr(st, "st_reparse_tag", 0) == _WINDOWS_JUNCTION


def holds_a_backup(folder: str) -> bool:
    """
    folder holds something of a backup that a new try would destroy: a list of files (in place, or
    in Snapshot waiting to be moved), keys, or stored files. False for what a first backup that
    stopped early leaves, which is tried again in place. True if it can't tell.
    """
    try:
        for name in ("Manifest.db", "Manifest.mbdb", os.path.join(backup_status.SNAPSHOT_DIR, "Manifest.db")):
            if os.path.lexists(os.path.join(folder, name)):
                return True
        keys = os.path.join(folder, "Manifest.plist")
        if os.path.lexists(keys) and os.path.getsize(keys) > 0:
            return True
        with os.scandir(folder) as entries:
            for entry in entries:
                if _STORED_FILE_RE.fullmatch(entry.name):
                    return True
                if _HEX_DIR_RE.fullmatch(entry.name) and entry.is_dir():
                    with os.scandir(entry.path) as stored:
                        if any(not _is_clutter(f.name) for f in stored):
                            return True
    except FileNotFoundError:
        return os.path.lexists(folder) and not os.path.isdir(folder)
    except OSError:
        return True
    return False


def _backup_contents(folder: str) -> Optional[tuple[list[str], list[str]]]:
    """
    (files, folders) in a backup folder, deepest first, so the keys and list of files go last and
    the folder itself very last. None if there's anything in it a backup doesn't have, a link, or
    anything that can't be read: then none of it may be deleted.
    """
    files: list[str] = []
    folders: list[str] = []

    def walk(path: str, where: str) -> bool:
        here = []
        with os.scandir(path) as entries:
            for entry in entries:
                name = entry.name
                if entry.is_file(follow_symlinks=False):
                    if not (_is_clutter(name) or _STORED_FILE_RE.fullmatch(name)
                            or (where != "hex" and name in _METADATA)):
                        return False
                    here.append(entry.path)
                    continue
                if not entry.is_dir(follow_symlinks=False) or _is_link(entry.stat(follow_symlinks=False)):
                    return False
                if where != "hex" and _HEX_DIR_RE.fullmatch(name):
                    inside = "hex"
                elif where == "top" and name == backup_status.SNAPSHOT_DIR:
                    inside = "snapshot"
                else:
                    return False
                if not walk(entry.path, inside):
                    return False
        files.extend(here)
        folders.append(path)
        return True

    try:
        top = os.lstat(folder)
        if not stat.S_ISDIR(top.st_mode) or _is_link(top) or not walk(folder, "top"):
            return None
    except OSError:
        return None
    return files, folders


def _remove_backup(folder: str, report: Callable[[], None] = lambda: None, log=_quiet) -> bool:
    """Deletes a backup folder, if it holds only a backup. True once it's gone."""
    contents = _backup_contents(folder)
    if contents is None:
        log(f"left {folder!r}: it holds something that isn't a backup's, or couldn't be read")
        return False
    files, folders = contents
    try:
        for i, path in enumerate(files, 1):
            try:
                os.remove(path)
            except FileNotFoundError:
                pass  # macOS removes a file's ._ twin along with it
            if i % _REMOVE_REPORT_EVERY == 0:
                report()
        for path in folders:
            os.rmdir(path)
    except OSError as e:
        log(f"couldn't remove all of {folder!r}: {e!r}")
        return False
    return True


def _is_replaceable(folder: str) -> bool:
    """An earlier backup that a confirmed new one supersedes: finished, with its keys, and no more."""
    earlier = backup_status.check(folder)
    if not earlier.finished or not earlier.openable:
        return False
    try:
        with open(os.path.join(folder, "Manifest.plist"), "rb") as f:
            if not plistlib.load(f):
                return False
    except Exception:  # missing, empty or damaged: not a backup to throw away
        return False
    return _backup_contents(folder) is not None


def _flush(folder: str, log=_quiet) -> bool:
    """Gets a new backup onto the drive before the one it replaces is deleted."""
    try:
        for name in ("Info.plist", "Status.plist", "Manifest.plist", "Manifest.db", "Manifest.mbdb"):
            path = os.path.join(folder, name)
            if os.path.isfile(path):
                with open(path, "r+b") as f:
                    os.fsync(f.fileno())
        if hasattr(os, "sync"):  # not on Windows
            os.sync()
    except OSError as e:
        log(f"couldn't flush {folder!r}, so the earlier backup stays: {e!r}")
        return False
    return True


def _rename(src: str, dst: str, log=_quiet, wait_s: Optional[float] = None) -> bool:
    """Renames without ever replacing anything, trying again while another program has it open."""
    deadline = time.monotonic() + (RENAME_WAIT_S if wait_s is None else wait_s)
    while True:
        if os.path.lexists(dst):  # POSIX would replace an empty folder
            log(f"didn't rename {src!r}: {dst!r} is already there")
            return False
        try:
            os.rename(src, dst)
            return True
        except OSError as e:
            busy = isinstance(e, PermissionError) or e.errno == errno.EBUSY
            if not busy or time.monotonic() >= deadline:
                log(f"couldn't rename {src!r} to {dst!r}: {e!r}")
                return False
        time.sleep(_RENAME_RETRY_S)


# ── One engine at a time ─────────────────────────────────────────────────────

class _Lock:
    """
    Held by the engine backing up into a folder, so that another window's engine doesn't clear
    that try or recover halfway through its renames. The system lets go of it if the engine dies.
    It's kept in the temp folder: some drives a backup is saved to can't lock files.
    """

    def __init__(self, work_dir: str, name: str):
        key = hashlib.sha256(os.path.normcase(os.path.join(work_dir, name)).encode("utf-8", "surrogatepass")).hexdigest()
        self._path = os.path.join(tempfile.gettempdir(), f"openextract-backup-{key[:32]}.lock")
        self._fd: Optional[int] = None

    def acquire(self) -> bool:
        """False if another engine has it. True if this one does, or if locking isn't possible here."""
        try:
            fd = os.open(self._path, os.O_RDWR | os.O_CREAT, 0o600)
        except OSError:
            return True
        try:
            if sys.platform == "win32":
                import msvcrt

                msvcrt.locking(fd, msvcrt.LK_NBLCK, 1)
            else:
                import fcntl

                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError as e:
            os.close(fd)
            # EAGAIN where flock is busy; EACCES or EDEADLOCK from msvcrt.locking.
            busy = (errno.EACCES, errno.EAGAIN, errno.EWOULDBLOCK, getattr(errno, "EDEADLOCK", errno.EDEADLK))
            return e.errno not in busy
        self._fd = fd
        return True

    def release(self) -> None:
        if self._fd is not None:
            os.close(self._fd)  # closing lets go of it
            self._fd = None


# ── Finding what a stopped try left ──────────────────────────────────────────

def recover(folder: str, log=_quiet) -> None:
    """
    Puts an earlier backup back in folder if the engine stopped between moving it aside and
    putting the new one in its place. Only ever renames, and only to a name nothing has.
    """
    work = os.path.join(os.path.realpath(folder), WORK_DIR)
    try:
        names = os.listdir(work)
    except OSError:
        return
    for name in names:
        if not name.endswith(_PREVIOUS):
            continue
        original = name[:-len(_PREVIOUS)]
        place = os.path.join(os.path.dirname(work), original)
        if not original or os.path.lexists(place):
            continue
        lock = _Lock(work, original)
        if not lock.acquire():
            continue
        try:
            if _rename(os.path.join(work, name), place, log, wait_s=0):
                log(f"put the earlier backup back at {place!r}: a backup stopped while replacing it")
        finally:
            lock.release()


def waiting(folder: str) -> list[str]:
    """Folders in folder's work folder that could be backups: ones that couldn't be moved into place."""
    work = os.path.join(folder, WORK_DIR)
    try:
        with os.scandir(work) as entries:
            return sorted(e.path for e in entries if e.is_dir() and not e.name.endswith(_OLD))
    except OSError:
        return []


# ── One backup ───────────────────────────────────────────────────────────────

class Placed(NamedTuple):
    path: Optional[str]  # where the new backup is, or None if it was written in place
    earlier: Optional[str]  # where the earlier backup is, if it was kept


class Destination:
    """
    Where one backup is written, and what becomes of the backup that was already there.

        destination = Destination(output_dir)
        root = destination.prepare(udid)   # before anything is given the folder to write to
        ... the backup, into <root>/<udid> ...
        destination.finish(confirmed)      # only if it finished
        destination.close()                # always

    While `beside` is true, nothing in the earlier backup has been or will be written to until
    finish().
    """

    def __init__(self, output_dir: str, log=_quiet, release: Optional[Callable[[str], None]] = None):
        self._output_dir = output_dir
        self._log = log
        # Closes whatever this engine has open in a backup folder that's about to move.
        self._release = release
        self._lock: Optional[_Lock] = None
        self._target = self._real = self._work = self._new = self._previous = self._old = ""
        self.root = output_dir
        self.beside = False

    def prepare(self, udid: str) -> str:
        """The folder to give pymobiledevice3 as backup_directory. Safe to call again for a retry."""
        # These paths get renamed and deleted, and the name comes from the device.
        if not _UDID_RE.fullmatch(udid or ""):
            raise RuntimeError("Your iPhone didn't give a valid ID. Unplug it, plug it back in, then try again.")
        if self._lock is None:
            self._target = os.path.join(self._output_dir, udid)
            # <udid> may be a link to another drive. The try goes beside the real folder, to be
            # renamed into its place.
            self._real = os.path.realpath(self._target)
            parent, name = os.path.split(self._real)
            self._work = os.path.join(parent, WORK_DIR)
            self._new = os.path.join(self._work, udid)
            self._previous = os.path.join(self._work, name + _PREVIOUS)
            self._old = os.path.join(self._work, name + _OLD)
            lock = _Lock(self._work, name)
            if not lock.acquire():
                raise RuntimeError(BUSY)
            self._lock = lock

        if os.path.lexists(self._previous):  # an engine stopped while swapping
            if os.path.lexists(self._real):
                self._set_aside(self._previous, "earlier backup")
            elif not _rename(self._previous, self._real, self._log):
                raise RuntimeError(IN_USE)
        if os.path.lexists(self._old):  # ...or while deleting what it had replaced
            _remove_backup(self._old, log=self._log)

        self.beside = holds_a_backup(self._real)
        self.root = self._work if self.beside else self._output_dir
        if os.path.lexists(self._new) and not self._clear_last_try() and self.beside:
            raise RuntimeError(IN_USE)
        if self.beside:
            try:
                os.makedirs(self._new, exist_ok=True)
            except OSError as e:
                self._log(f"couldn't make {self._new!r}: {e!r}")
                raise RuntimeError(IN_USE) from e
            if sys.platform != "win32":
                try:  # as private as the folder it will replace
                    os.chmod(self._new, stat.S_IMODE(os.stat(self._real).st_mode) | stat.S_IRWXU)
                except OSError as e:
                    self._log(f"couldn't copy the backup folder's permissions: {e!r}")
            self._log(f"the folder has a backup of this iPhone: backing up beside it, in {self._new!r}")
        return self.root

    def _clear_last_try(self) -> bool:
        """
        An earlier try's folder out of the way. One with a list of files can be opened (it may
        even have finished), so it's kept. Without one there's nothing in it to open, and the
        room is needed.
        """
        has_index = any(os.path.lexists(os.path.join(self._new, n)) for n in ("Manifest.db", "Manifest.mbdb"))
        if not has_index and _remove_backup(self._new, log=self._log):
            return True
        return self._set_aside(self._new, "new backup") is not None

    def _set_aside(self, src: str, label: str) -> Optional[str]:
        """Renames src to "<udid> (<label>)" beside the backup. Returns that, or None if it can't."""
        name = dest = f"{self._real} ({label})"
        n = 1
        while os.path.lexists(dest):
            n += 1
            dest = f"{name[:-1]} {n})"
        return dest if _rename(src, dest, self._log) else None

    def finish(self, confirmed: bool, report: Callable[[], None] = lambda: None) -> Placed:
        """
        Puts a finished backup in the earlier one's place. The earlier one is deleted only when
        `confirmed`, meaning the iPhone itself reported success. Never raises: the backup is made.
        """
        if not self.beside:
            return Placed(None, None)
        try:
            return self._swap(confirmed, report)
        except Exception as e:
            self._log(f"couldn't put the new backup in the earlier one's place: {e!r}")
            path = self._new if os.path.lexists(self._new) else self._target
            earlier = self._previous if os.path.lexists(self._previous) else None
            if earlier is None and path == self._new:
                earlier = self._target
            return Placed(path, earlier)

    def _swap(self, confirmed: bool, report: Callable[[], None]) -> Placed:
        new = backup_status.check(self._new)
        whole = new.finished and new.openable
        if not whole:
            self._log(f"the new backup doesn't look finished ({new.signs}): keeping both")
            return self._keep_both()
        flushed = _flush(self._new, self._log)
        if self._release is not None:
            try:
                self._release(self._real)
            except Exception as e:
                self._log(f"couldn't close the earlier backup: {e!r}")
            gc.collect()  # SQLite connections nothing closed hold their files until collected
        report()
        if not _rename(self._real, self._previous, self._log):
            return self._keep_both()
        if not _rename(self._new, self._real, self._log):
            if _rename(self._previous, self._real, self._log):
                return self._keep_both()
            return Placed(self._new, self._previous)  # recover() puts it back

        # Judged where it is now, under a name nothing else writes to.
        if confirmed and flushed and _is_replaceable(self._previous) and _rename(self._previous, self._old, self._log):
            _remove_backup(self._old, report, self._log)
            return Placed(self._target, None)
        return Placed(self._target, self._set_aside(self._previous, "earlier backup") or self._previous)

    def _keep_both(self) -> Placed:
        return Placed(self._set_aside(self._new, "new backup") or self._new, self._target)

    def close(self) -> None:
        if self._lock is None:
            return
        for folder in (self._new, self._work):
            try:
                os.rmdir(folder)  # only if it's empty
            except OSError:
                pass
        self._lock.release()
        self._lock = None
