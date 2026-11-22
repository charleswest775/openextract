"""
Writing a saved page and the files beside it, so a failed write is never taken for a gap in the backup.

What goes wrong is one of two things:

  * the save can't be written (no room, the drive gone, a folder that can't be
    written to): an OSError, which new_page turns into SaveStopped, in words
    for people, after taking back what the save wrote;
  * one file's own problem (it can't be read from the backup, or can't have
    that name or size where it's going): FileNotSaved, which the save counts
    and the page labels, and the save goes on.

A file gets its name only once it's whole.
"""

import errno
import os
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

# One file's problem, as its label says it ("Image couldn't be read: IMG_1.jpg").
CANT_READ = "couldn't be read"
CANT_SAVE = "couldn't be saved"

_CHUNK_BYTES = 1024 * 1024

# On Windows a virus scanner or OneDrive can hold a file just written for a moment, and it can't be renamed until then.
_RENAME_WAITS = (0.1, 0.2, 0.4, 0.8) if os.name == "nt" else ()


class SaveStopped(Exception):
    """The save couldn't go on. Its message is for people, and is what the app shows."""

    def after(self, saved: int, noun: str) -> "SaveStopped":
        """The same, saying that the ``saved`` pages finished before it are fine."""
        if not saved:
            return self
        which = f"{noun} saved before that is" if saved == 1 else f"{saved:,} {noun}s saved before that are"
        return SaveStopped(f"{self} The {which} complete.")


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
    return f"Couldn't save: {error.strerror or error}"


def log_failure(what: str, error: BaseException) -> None:
    # Without the path: it has the conversation's and the file's names in it, and this log goes into reports
    cause = error if isinstance(error, OSError) else error.__cause__
    why = f": {getattr(cause, 'strerror', None) or type(cause).__name__}" if cause else ""
    print(f"[save] {what}{why}", file=sys.stderr, flush=True)


@contextmanager
def new_page(path: str, files=None):
    """Open a save's page to write. If it can't be finished, take back what this save wrote.

    ``files`` is the page's attachment writer: ``take_back()`` removes the
    files it made, and its ``no_room`` is what a full disk means for it. An
    OSError becomes SaveStopped.
    """
    was_there = os.path.lexists(path)
    opened = False
    try:
        # "x" when the name was free, so a file that has turned up since is never written over
        with open(path, "w" if was_there else "x", encoding="utf-8") as f:
            opened = True
            yield f
    except BaseException as e:
        if opened and not was_there:
            remove(path)
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
        _write_whole(dest, fill)


def write_whole(dest: str, data: bytes) -> None:
    """Write ``data`` to ``dest``, failing as copy_whole does."""
    _write_whole(dest, lambda out: out.write(data))


def _write_whole(dest: str, fill: Callable) -> None:
    # A short name, so it fits wherever the file's own name would (Windows' 260 characters)
    partial = os.path.join(os.path.dirname(dest), f"{uuid.uuid4().hex[:8]}.partial")
    try:
        try:
            with open(partial, "wb") as out:
                fill(out)
        except OSError as e:
            if e.errno == errno.EFBIG:  # over 4 GB on a FAT32 drive: the rest still fit
                raise FileNotSaved(CANT_SAVE) from e
            raise
        _give_name(partial, dest)
    except BaseException:
        remove(partial)
        raise


def _give_name(partial: str, dest: str) -> None:
    """Rename a whole file to its name. The bytes are written by now, so failing is that file's problem."""
    waits = list(_RENAME_WAITS)
    while True:
        try:
            os.replace(partial, dest)
            return
        except OSError as e:
            if out_of_space(e):
                raise
            if not waits or not isinstance(e, PermissionError):
                raise FileNotSaved(CANT_SAVE) from e
            time.sleep(waits.pop(0))


def remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass  # never made, or the drive is gone
