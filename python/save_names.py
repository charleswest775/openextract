"""
Files put into a folder the person chose, never over one that's there.

SaveNames picks a path for each file. copy_new and write_new make only new files,
so even a file that turned up after the path was picked is safe, and give a file
its name only once it's whole.
"""

import filecmp
import os
import shutil
import unicodedata
import uuid
from typing import Callable


class SaveNames:
    """Where one save puts each file, so that none is written over another.

    iPhones reuse names (IMG_0001 again in a later DCIM folder), and macOS and Windows
    folders don't tell IMG_0001.JPG from img_0001.jpg. The second gets "IMG_0001 (2).JPG",
    as in Finder and File Explorer. A file already in the folder is this file only if it
    holds the same bytes, so saving again into a folder makes no copies of what's there.
    """

    def __init__(self):
        self._taken: set = set()

    def place(self, folder: str, name: str, is_this_file: Callable[[str], bool]) -> tuple:
        """(the path for the file, whether that path already holds it)."""
        base, ext = os.path.splitext(name)
        n = 1
        while True:
            path = os.path.join(folder, name if n == 1 else f"{base} ({n}){ext}")
            key = unicodedata.normalize("NFC", path).casefold()
            if key not in self._taken:
                there = os.path.lexists(path)
                if not there or (os.path.isfile(path) and is_this_file(path)):
                    self._taken.add(key)
                    return path, there
            n += 1


def same_file(path: str, source: str) -> bool:
    """Whether the file at ``path`` holds exactly what ``source`` does."""
    # filecmp remembers answers by size and time, and saved photos are given the time
    # they were taken, so a copy edited since could pass for the photo. Read both.
    filecmp.clear_cache()
    try:
        return filecmp.cmp(path, source, shallow=False)
    except OSError:
        return False


def holds(path: str, data: bytes) -> bool:
    """Whether the file at ``path`` holds exactly ``data``."""
    try:
        if os.path.getsize(path) != len(data):
            return False
        with open(path, "rb") as f:
            return f.read() == data
    except OSError:
        return False


def copy_new(source: str, path: str) -> None:
    """Copy ``source`` to the new file ``path``, with its dates where the drive takes them."""
    _make_new(path, lambda partial: shutil.copyfile(source, partial))
    try:
        shutil.copystat(source, path)
    except OSError:
        pass  # the file is saved; only the drive won't take its dates


def write_new(path: str, data: bytes) -> None:
    """Write ``data`` to the new file ``path``."""
    def write(partial: str) -> None:
        with open(partial, "wb") as f:
            f.write(data)

    _make_new(path, write)


def _make_new(path: str, fill: Callable[[str], object]) -> None:
    """Fill a file of another name, then give it ``path``; FileExistsError if that's taken.

    A save cut short (closing the window stops the engine) then never leaves part of a
    photo under the photo's name, which the next save would leave alone as someone's file.
    """
    partial = os.path.join(os.path.dirname(path), f"OpenExtract-{uuid.uuid4().hex[:8]}.partial")
    try:
        fill(partial)
        _move_new(partial, path)
    except BaseException:
        _remove(partial)
        raise


def _move_new(partial: str, path: str) -> None:
    """Rename ``partial`` to ``path``, never replacing a file."""
    if os.name == "nt":
        os.rename(partial, path)  # on Windows this refuses to replace
        return
    # Elsewhere a rename replaces, so claim the name first and replace only that empty file.
    # (Hard links would do it in one step, but exFAT drives have none.)
    open(path, "xb").close()
    try:
        os.replace(partial, path)
    except BaseException:
        _remove(path)
        raise


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass
