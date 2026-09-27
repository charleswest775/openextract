"""Helpers for writing exported files with safe, non-colliding names."""

import os
import re

_UNSAFE_FILENAME_CHARS = re.compile(r'[<>:"/\\|?*\x00-\x1f]')


def safe_filename(name: str, max_length: int = 120) -> str:
    """Make *name* safe as a file name on macOS and Windows."""
    cleaned = _UNSAFE_FILENAME_CHARS.sub("_", name).strip().rstrip(". ")
    return cleaned[:max_length].rstrip(". ") or "Untitled"


def unique_path(directory: str, file_name: str) -> str:
    """Return a path in *directory* that doesn't exist yet, adding " (2)" etc."""
    stem, ext = os.path.splitext(file_name)
    candidate = os.path.join(directory, file_name)
    n = 2
    while os.path.exists(candidate):
        candidate = os.path.join(directory, f"{stem} ({n}){ext}")
        n += 1
    return candidate
