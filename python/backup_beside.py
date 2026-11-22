"""
A new backup never goes into a folder that holds one.

pymobiledevice3's Mobilebackup2Service.backup(full=True) empties <folder>/<udid>/Manifest.plist and
rewrites Info.plist and Status.plist before the iPhone has even asked for its passcode. The first
holds an encrypted backup's keys, so up to 0.18.0 any try that failed left the backup already there
locked for good.

Saving those files and putting them back wouldn't be enough: near the end the iPhone replaces the
backup's files one at a time, each with a new key, and the old keys can't read those. Swapping the
new backup in and deleting the old isn't safe either: nothing here can prove the new one can be
unlocked, or that the old one had nothing the iPhone has since lost (it may have been erased, or
handed down). So a backup that's already there is never written to, renamed or deleted:

    <folder>/<udid>/                      the backup already there
    <folder>/OpenExtract-new/<udid>/      the try
    <folder>/<udid>-20261121-190512/      the try, renamed once the iPhone has reported success

That name is the one iTunes gives a backup it archives. A try that fails, is killed or loses power
has touched nothing else, so there's nothing to put back on the next launch. If it can't be renamed
(Windows won't while another program has a file in it open) it stays where it is, and is listed.

A try with nothing of a backup in it yet is written over by the next, as a first backup's is. One
that has something (its list of files, keys or stored files) is a backup like any other: the next
try goes into OpenExtract-new-2, and so on.

While files arrive this takes no more room than before: in a full backup every file lands in
Snapshot before any old one is replaced. It's afterwards that both backups stay on the drive.
"""

from __future__ import annotations

import errno
import os
import re
import time

import backup_status

# Short: Windows paths stop at 260 characters.
WORK_DIR = "OpenExtract-new"
_WORK_DIR_RE = re.compile(re.escape(WORK_DIR) + r"(?:-\d+)?")

# Windows won't rename a folder while any file in it is open, as antivirus and the Search indexer
# have files that were just written.
RENAME_WAIT_S = 20.0
_RENAME_RETRY_S = 0.5

_INDEX_OR_STORED_RE = re.compile(r"manifest\.db|manifest\.mbdb|[0-9a-f]{40}", re.IGNORECASE)
_HEX_DIR_RE = re.compile(r"[0-9a-f]{2}", re.IGNORECASE)
_CLUTTER = frozenset({".DS_Store", "desktop.ini", "Thumbs.db"})
_UDID_RE = re.compile(r"[0-9A-Za-z-]+")

INVALID_ID = "Your iPhone didn't give a valid ID. Unplug it, plug it back in, then try again."
NOT_WHOLE = (
    "Your iPhone said the backup had finished, but the new backup isn't complete, so it can't be "
    "relied on. Try again."
)


def _quiet(_msg: str) -> None:
    pass


def holds_a_backup(folder: str) -> bool:
    """
    folder holds something of a backup that a try would destroy: a list of files (in place, or in
    Snapshot waiting to be moved), keys, or stored files. False for what a try that stopped early
    leaves. True if it can't tell.
    """
    try:
        with os.scandir(folder) as entries:
            for entry in entries:
                name = entry.name
                if _INDEX_OR_STORED_RE.fullmatch(name):
                    return True
                if name == "Manifest.plist" and entry.stat().st_size > 0:
                    return True
                if name == backup_status.SNAPSHOT_DIR and os.path.lexists(os.path.join(entry.path, "Manifest.db")):
                    return True
                if _HEX_DIR_RE.fullmatch(name) and entry.is_dir():
                    with os.scandir(entry.path) as stored:
                        if any(f.name not in _CLUTTER and not f.name.startswith("._") for f in stored):
                            return True
    except FileNotFoundError:
        # Nothing there, unless it's a link to a drive that isn't plugged in, or something in
        # it went away while it was being read.
        return os.path.lexists(folder)
    except OSError:
        return True
    return False


def unplaced(folder: str) -> list[str]:
    """Folders that could be backups in folder's work folders: tries that weren't renamed."""
    found: list[str] = []
    try:
        with os.scandir(folder) as entries:
            works = [e.path for e in entries if _WORK_DIR_RE.fullmatch(e.name) and e.is_dir()]
    except OSError:
        return found
    for work in works:
        try:
            with os.scandir(work) as entries:
                found.extend(e.path for e in entries if e.is_dir())
        except OSError:
            continue
    return sorted(found)


class Destination:
    """
    Where one backup is written.

        destination = Destination(output_dir)
        root = destination.prepare(udid)   # before anything is given the folder to write to
        ... the backup, into <root>/<udid> ...
        path = destination.finish()        # only once it has finished
        destination.close()                # always

    While `beside` is true, `earlier` is a backup that was already there, and nothing is written
    to it, then or later.
    """

    def __init__(self, output_dir: str, log=_quiet):
        self._output_dir = output_dir
        self._log = log
        self._new = ""
        self.root = output_dir
        self.earlier = ""
        self.beside = False

    def prepare(self, udid: str) -> str:
        """The folder to give pymobiledevice3 as backup_directory. Asked again for each retry."""
        # The name comes from the device, and becomes part of a path.
        if not _UDID_RE.fullmatch(udid or ""):
            raise RuntimeError(INVALID_ID)
        self.earlier = os.path.join(self._output_dir, udid)
        self.beside = holds_a_backup(self.earlier)
        self.root, self._new = self._output_dir, self.earlier
        if not self.beside:
            return self.root
        n = 1
        while True:
            self.root = os.path.join(self._output_dir, WORK_DIR if n == 1 else f"{WORK_DIR}-{n}")
            self._new = os.path.join(self.root, udid)
            # lexists is False when it can't tell, so this ends: making the folder says why.
            if not os.path.lexists(self._new) or not holds_a_backup(self._new):
                break
            n += 1
        self._log(f"the folder has a backup of this iPhone: backing up beside it, in {self._new!r}")
        return self.root

    def finish(self) -> str:
        """
        The new backup's folder, renamed to its own name beside the one already there. Raises if
        it isn't a whole backup, whatever the iPhone said.
        """
        if not self.beside:
            return self._new
        status = backup_status.check(self._new)
        if not status.finished or not status.openable:
            self._log(f"the iPhone reported success but the new backup isn't whole: {status.signs}")
            raise RuntimeError(NOT_WHOLE)
        name = dest = f"{self.earlier}-{time.strftime('%Y%m%d-%H%M%S')}"
        n = 1
        while os.path.lexists(dest):
            n += 1
            dest = f"{name}-{n}"
        return dest if self._rename(self._new, dest) else self._new

    def _rename(self, src: str, dst: str) -> bool:
        deadline = time.monotonic() + RENAME_WAIT_S
        while True:
            try:
                os.rename(src, dst)
                return True
            except OSError as e:
                busy = isinstance(e, PermissionError) or e.errno == errno.EBUSY
                if not busy or time.monotonic() >= deadline:
                    self._log(f"the new backup stays in {src!r}, as it couldn't be renamed: {e!r}")
                    return False
            time.sleep(_RENAME_RETRY_S)

    def close(self) -> None:
        if not self.beside:
            return
        for folder in (self._new, self.root):
            try:
                os.rmdir(folder)  # only ever an empty one
            except OSError:
                pass
