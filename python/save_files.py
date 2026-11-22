"""
Writing a saved page and the files beside it, so a failed write is never taken for a gap in the backup.

What goes wrong is one of two things:

  * the save can't be written (no room, the drive gone, a folder that can't be
    written to or renamed in): an OSError, which new_page turns into
    SaveStopped, in words for people, after taking back what the save wrote;
  * one file's own problem (it can't be read from the backup, or can't have
    that name or size where it's going): FileNotSaved, which the save counts
    and the page labels, and the save goes on.

A file, the page included, gets its name only once it's whole. So a save that
fails leaves what had that name before as it was.
"""

import errno
import os
import shutil
import sys
import time
import uuid
from contextlib import contextmanager
from typing import Callable

NO_ROOM = "There isn't enough space to save here. Free up some space or choose another folder."
NO_ROOM_FOR_PDF = "There isn't enough space on this computer to make the PDF. Free up some space and try again."
NO_ROOM_TO_DECRYPT = ("There isn't enough space on this computer to decrypt the backup's files. It needs room "
                      "here even when you save to another drive. Free up some space and try again.")
NOT_ALLOWED = "OpenExtract can't save in that folder. Choose another folder."
UNFINISHED = "The save couldn't finish. Check that the drive is still connected, or choose another folder."

# One file's problem, as its label says it ("Image couldn't be read: IMG_1.jpg").
CANT_READ = "couldn't be read"
CANT_SAVE = "couldn't be saved"

# The biggest file FAT32 takes
FAT32_LARGEST = 4 * 1024 ** 3 - 1

_CHUNK_BYTES = 1024 * 1024

# A virus scanner, OneDrive or a network drive can hold a file just written for a moment.
_HELD_WAITS = (0.1, 0.2, 0.4, 0.8)


class SaveStopped(Exception):
    """The save couldn't go on. Its message is for people, and is what the app shows."""

    def after(self, saved: int, noun: str, failed: int = 0) -> "SaveStopped":
        """The same, saying how the ``saved`` pages finished before it are, ``failed`` of their files not copied."""
        if not saved:
            return self
        which = f"{noun} saved before that" if saved == 1 else f"{saved:,} {noun}s saved before that"
        are = "is" if saved == 1 else "are"
        if not failed:
            return SaveStopped(f"{self} The {which} {are} complete.")
        files = "1 file" if failed == 1 else f"{failed:,} files"
        them = "it" if saved == 1 else "them"
        return SaveStopped(f"{self} The {which} {are} still there, but {files} in {them} couldn't be copied, "
                           "so keep the backup.")


class FileNotSaved(Exception):
    """One file's problem (``problem``: CANT_READ or CANT_SAVE); the save goes on."""

    def __init__(self, problem: str):
        super().__init__(problem)
        self.problem = problem


def out_of_space(error: BaseException) -> bool:
    return (getattr(error, "errno", None) in (errno.ENOSPC, getattr(errno, "EDQUOT", -1))
            or getattr(error, "winerror", None) in (39, 112))  # ERROR_HANDLE_DISK_FULL, ERROR_DISK_FULL


def write_error(error: OSError, no_room: str = NO_ROOM) -> str:
    """Why a save couldn't be written, in words for people."""
    if out_of_space(error):
        return no_room
    if error.errno in (errno.EACCES, errno.EPERM, errno.EROFS):
        return NOT_ALLOWED
    return UNFINISHED


def log_failure(what: str, error: BaseException) -> None:
    # Without the path: it has the conversation's and the file's names in it, and this log goes into reports
    cause = error if isinstance(error, OSError) else error.__cause__
    why = f": {getattr(cause, 'strerror', None) or type(cause).__name__}" if cause else ""
    print(f"[save] {what}{why}", file=sys.stderr, flush=True)


@contextmanager
def new_page(path: str, files=None):
    """Open a save's page to write. It gets its name when it's finished; if it can't be, take back the save.

    ``files`` is the page's attachment writer: ``take_back()`` removes the
    files it made, and its ``no_room`` is what a full disk means for it. An
    OSError becomes SaveStopped.
    """
    replacing = os.path.lexists(path)
    partial = _partial_beside(path)
    try:
        with open(partial, "x", encoding="utf-8") as f:
            yield f
        try:
            _give_name(partial, path, replacing)
        except FileNotSaved as e:
            raise e.__cause__  # for the page, that's the whole save's problem
    except BaseException as e:
        remove(partial)
        if files is not None:
            files.take_back()
        if not isinstance(e, OSError):
            raise
        log_failure("a save stopped", e)
        # Not chained, for the same reason log_failure leaves the path out
        raise SaveStopped(write_error(e, files.no_room if files is not None else NO_ROOM)) from None


def copy_whole(src: str, dest: str) -> None:
    """Copy ``src`` to ``dest``. FileNotSaved is that file's problem; an OSError is the save's."""
    try:
        source = open(src, "rb")
    except OSError as e:
        raise FileNotSaved(CANT_READ) from e

    def fill(out) -> None:
        # Not shutil.copyfile: its errors don't say whether reading or writing failed
        while True:
            try:
                chunk = source.read(_CHUNK_BYTES)
            except OSError as e:
                raise FileNotSaved(CANT_READ) from e
            if not chunk:
                return
            out.write(chunk)

    with source:
        try:
            _write_whole(dest, fill)
        except OSError as e:
            if _too_big_for_drive(src, dest, e):
                raise FileNotSaved(CANT_SAVE) from e
            raise


def write_whole(dest: str, data: bytes) -> None:
    """Write ``data`` to ``dest``, failing as copy_whole does."""
    _write_whole(dest, lambda out: out.write(data))


def _partial_beside(path: str) -> str:
    # A short name, so it fits wherever the file's own name would (Windows' 260 characters)
    return os.path.join(os.path.dirname(path), f"{uuid.uuid4().hex[:8]}.partial")


def _write_whole(dest: str, fill: Callable) -> None:
    replacing = os.path.lexists(dest)
    partial = _partial_beside(dest)
    try:
        with open(partial, "wb") as out:
            fill(out)
        _give_name(partial, dest, replacing)
    except BaseException:
        remove(partial)
        raise


def _too_big_for_drive(src: str, dest: str, error: OSError) -> bool:
    """Whether a write failed only because FAT32 takes no file of 4 GB: the rest still fit."""
    if error.errno == errno.EFBIG:
        return True
    if error.errno != errno.EINVAL and not out_of_space(error):
        return False
    try:
        size = os.path.getsize(src)
        # Windows can call it no space, so see whether there is
        return size > FAT32_LARGEST and shutil.disk_usage(os.path.dirname(dest)).free > size
    except OSError:
        return False


def _held(error: OSError) -> bool:
    return error.errno == errno.EBUSY or (os.name == "nt" and isinstance(error, PermissionError))


def _give_name(partial: str, dest: str, replacing: bool) -> None:
    """Rename a whole file to its name, replacing only a file that was there when writing began.

    The bytes are written by now, so failing is that file's problem, unless
    nothing in the folder can be renamed: then it's the save's.
    """
    waits = list(_HELD_WAITS)
    while True:
        try:
            if replacing:
                os.replace(partial, dest)
            elif os.name == "nt":
                os.rename(partial, dest)  # on Windows this refuses to replace
            elif os.path.lexists(dest):
                raise FileExistsError(errno.EEXIST, os.strerror(errno.EEXIST), dest)
            else:
                os.rename(partial, dest)
            return
        except OSError as e:
            if out_of_space(e):
                raise
            if waits and _held(e):
                time.sleep(waits.pop(0))
                continue
            if isinstance(e, PermissionError) and not _can_rename_in(os.path.dirname(dest)):
                raise
            raise FileNotSaved(CANT_SAVE) from e


def _can_rename_in(folder: str) -> bool:
    """Whether any file can be renamed there: some shared folders let files be made but not renamed."""
    probe = _partial_beside(os.path.join(folder, "probe"))
    renamed = _partial_beside(os.path.join(folder, "probe"))
    try:
        open(probe, "wb").close()
        os.rename(probe, renamed)
    except OSError:
        remove(probe)
        return False
    remove(renamed)
    return True


def remove(path: str) -> None:
    waits = list(_HELD_WAITS)
    while True:
        try:
            os.remove(path)
            return
        except OSError as e:
            if not waits or not _held(e):
                return  # never made, or the drive is gone
            time.sleep(waits.pop(0))
