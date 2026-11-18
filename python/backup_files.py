"""
Whether a backup's folder holds every file its list of files names (in-app report OE-102).

An iPhone backup stores each file under its fileID, at <backup>/<first two characters>/<fileID>
(directly in the backup folder for iOS 9 and earlier), and Manifest.db lists every file with its
fileID. In a backup that finished, every file Manifest.db lists is in the folder: four real
backups (iOS 15.3.1, 16.0, 16.1.2 and 17.3) list none that aren't.

OE-102 (Windows, iOS 26.5.2, not encrypted) was a folder whose Manifest.db listed the photos
but whose photo files weren't there, with no sign that the backup didn't finish
(backup_status.py). The Photos screen listed every photo, and each one failed with "Photo not
found". Most likely the folder was copied or moved and the copy stopped partway.

So Photos lists only photos whose file is in the folder (photos.py), and the app tells the
user when files are missing (check_backup_files in main.py).
"""

from __future__ import annotations

import os
import sys
import weakref
from typing import Optional

from ios_backup_core.db import connect_readonly

# Where each part of the app keeps the files it shows, for the app's message.
_PHOTO_PREFIXES = ("Media/DCIM/", "Media/PhotoData/CPLAssets/")
_MESSAGE_PREFIX = "Library/SMS/"
_FILE_ID_LEN = 40

_stored: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()
_missing: "weakref.WeakKeyDictionary" = weakref.WeakKeyDictionary()


def _read_folder(backup_dir: str) -> Optional[frozenset]:
    """The names of the files stored in a backup folder: in its two-character folders, and
    (iOS 9 and earlier) directly in it. One directory read per folder, no file stats."""
    names: set = set()
    try:
        entries = list(os.scandir(backup_dir))
    except OSError as e:
        print(f"[files] couldn't list the backup folder: {e}", file=sys.stderr, flush=True)
        return None
    for entry in entries:
        try:
            if len(entry.name) == 2 and entry.is_dir():
                with os.scandir(entry.path) as inner:
                    names.update(f.name for f in inner)
            elif len(entry.name) == _FILE_ID_LEN:
                names.add(entry.name)
        except OSError as e:
            # One folder we can't read: its files count as missing, which they are to us.
            print(f"[files] couldn't list {entry.name} in the backup folder: {e}", file=sys.stderr, flush=True)
    return frozenset(names)


def stored_file_ids(backup) -> Optional[frozenset]:
    """The fileIDs stored in the backup's folder, read once per open backup.

    None when there's no folder to read (a test's stand-in backup) or it can't be listed;
    then nothing counts as missing.
    """
    try:
        if backup in _stored:
            return _stored[backup]
    except TypeError:  # not weak-referenceable: read it every time
        pass
    backup_dir = getattr(backup, "backup_dir", None)
    names = _read_folder(backup_dir) if isinstance(backup_dir, str) and os.path.isdir(backup_dir) else None
    try:
        _stored[backup] = names
    except TypeError:
        pass
    return names


def is_stored(backup, file_id: str) -> bool:
    """Whether the backup's folder has the file stored under file_id (True if it can't tell)."""
    names = stored_file_ids(backup)
    return names is None or file_id in names


def _area(domain: str, path: str) -> str:
    if domain == "CameraRollDomain" and path.startswith(_PHOTO_PREFIXES):
        return "photos"
    if domain in ("MediaDomain", "HomeDomain") and path.startswith(_MESSAGE_PREFIX):
        return "messages"
    return "other"


def _listed_files(backup) -> list:
    """(fileID, domain, relativePath) of each file the backup lists: files, not folders or links.

    An encrypted backup's list_files already gives only files. An unencrypted one's gives
    folders too, so Manifest.db is read here. iOS 9 and earlier: Manifest.mbdb, which
    ios-backup-core turns into the same table, with each file's size beside it; an empty file
    there is left out, as nothing says those were stored.
    """
    if getattr(backup, "encrypted", False):
        return [(f.get("hash"), f.get("domain") or "", f.get("path") or "") for f in backup.list_files()]
    manifest = backup.get_manifest_db()
    if not manifest:
        return []
    conn = connect_readonly(manifest, backup)
    try:
        columns = {col[1] for col in conn.execute("PRAGMA table_info(Files)")}
        where = "flags = 1" + (" AND (size IS NULL OR size > 0)" if "size" in columns else "")
        return conn.execute(f"SELECT fileID, domain, relativePath FROM Files WHERE {where}").fetchall()
    finally:
        conn.close()


def missing_files(backup) -> dict:
    """How many of the files the backup lists aren't in its folder, read once per open backup.

    ``{"listed": n, "missing": n, "missing_by_area": {"photos": n, "messages": n, "other": n}}``.
    "photos" counts files (a Live Photo is two), so it can differ from the Photos screen's count.
    """
    if backup in _missing:
        return _missing[backup]
    by_area = {"photos": 0, "messages": 0, "other": 0}
    listed = missing = 0
    names = stored_file_ids(backup)
    if names is not None:
        try:
            files = _listed_files(backup)
        except Exception as e:  # a damaged Manifest.db: the screens say so themselves
            print(f"[files] couldn't read the backup's list of files: {e}", file=sys.stderr, flush=True)
            files = []
        for file_id, domain, path in files:
            listed += 1
            if file_id not in names:
                missing += 1
                by_area[_area(domain or "", path or "")] += 1
    if missing:
        print(
            f"[files] {missing} of the {listed} files this backup lists aren't in its folder "
            f"(photos {by_area['photos']}, messages {by_area['messages']}, other {by_area['other']})",
            file=sys.stderr, flush=True,
        )
    result = {"listed": listed, "missing": missing, "missing_by_area": by_area}
    _missing[backup] = result
    return result
