"""
Files put into a folder the person chose, never over one that's there.

SaveNames picks a path for each file, and copy_new and write_new make only new
files, so even a file that turned up after the path was picked is safe.
"""

import filecmp
import os
import shutil
import unicodedata
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
    _make_new(path, lambda: shutil.copyfile(source, path))
    try:
        shutil.copystat(source, path)
    except OSError:
        pass  # the file is saved; only the drive won't take its dates


def write_new(path: str, data: bytes) -> None:
    """Write ``data`` to the new file ``path``."""
    def write() -> None:
        with open(path, "wb") as f:
            f.write(data)

    _make_new(path, write)


def _make_new(path: str, fill: Callable[[], object]) -> None:
    # "x" raises FileExistsError instead of replacing, and is outside the try: that file isn't ours to remove
    open(path, "xb").close()
    try:
        fill()
    except BaseException:
        try:
            os.remove(path)
        except OSError:
            pass
        raise
