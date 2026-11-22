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

import hashlib
import os
import plistlib
import shutil
import sqlite3
import stat
import sys
import tempfile
import weakref
from typing import Iterator, Optional

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


# The checks before an older backup may go (older_backups.py). Stricter than missing_files,
# which only tells the person what to expect, and never cached.

_JUNCTION = 0xA0000003  # IO_REPARSE_TAG_MOUNT_POINT, which lstat calls a folder
# FILE_ATTRIBUTE_OFFLINE, RECALL_ON_OPEN and RECALL_ON_DATA_ACCESS; macOS's SF_DATALESS
_WINDOWS_ONLINE_ONLY = 0x1000 | 0x40000 | 0x400000
_MAC_DATALESS = 0x40000000
# These can shrink to nothing while the iPhone is backing them up, whatever the list says.
_LIVE_COMPANIONS = ("-wal", "-shm", "-journal")


def is_link(st: os.stat_result) -> bool:
    return stat.S_ISLNK(st.st_mode) or getattr(st, "st_reparse_tag", 0) == _JUNCTION


def is_online_only(st: os.stat_result) -> bool:
    """A placeholder for a file that's only in OneDrive, iCloud Drive or the like."""
    if getattr(st, "st_file_attributes", 0) & _WINDOWS_ONLINE_ONLY:
        return True
    return sys.platform == "darwin" and bool(getattr(st, "st_flags", 0) & _MAC_DATALESS)


def _claimed_size(value) -> Optional[int]:
    """A listed file's size, from its Files.size or the MBFile record in Files.file."""
    if isinstance(value, int):
        return value
    try:
        record = plistlib.loads(bytes(value))
        return int(record["$objects"][record["$top"]["root"].data]["Size"])
    except Exception:  # plistlib raises many kinds; any of them means unknown
        return None


def _read_listed(cursor) -> Iterator[tuple]:
    columns = {row[1] for row in cursor.execute("PRAGMA table_info(Files)").fetchall()}
    size = "size" if "size" in columns else "file" if "file" in columns else "NULL"
    where = "flags = 1" + (" AND (size IS NULL OR size > 0)" if size == "size" else "")
    # One at a time: with each file's record, 400,000 of them together were over 400 MB.
    yield from cursor.execute(f"SELECT fileID, relativePath, {size} FROM Files WHERE {where}")


def _listed_with_sizes(backup) -> Iterator[tuple]:
    """(fileID, relativePath, what says its size) of each file the backup lists."""
    if getattr(backup, "encrypted", False):
        with backup._decrypted_backup.manifest_db_cursor() as cursor:
            yield from _read_listed(cursor)
        return
    manifest = backup.get_manifest_db()
    if not manifest:
        return
    conn = connect_readonly(manifest, backup)
    try:
        yield from _read_listed(conn.cursor())
    finally:
        conn.close()


def stored_whole(backup) -> Optional[dict]:
    """
    {"bytes": the listed files' size, "ids": their fileIDs} if each is in its own place in the
    folder now, as a file of its own with something in it. None if not, or if that can't be
    told. A link doesn't count anywhere in it: what it points at could be the older backup.
    """
    folder = backup.backup_dir
    stored: dict = {}

    def ours(entry) -> Optional[os.stat_result]:
        st = entry.stat(follow_symlinks=False)
        return None if is_link(st) or is_online_only(st) else st

    try:
        flat = not os.path.lexists(os.path.join(folder, "Manifest.db"))  # iOS 9 and earlier
        with os.scandir(folder) as entries:
            for entry in entries:
                st = ours(entry)
                if st is None:
                    return None
                if stat.S_ISREG(st.st_mode) and flat and len(entry.name) == _FILE_ID_LEN:
                    stored[entry.name] = st.st_size
                elif stat.S_ISDIR(st.st_mode) and len(entry.name) == 2:
                    with os.scandir(entry.path) as inner:
                        for item in inner:
                            item_st = ours(item)
                            if item_st is None:
                                return None
                            if stat.S_ISREG(item_st.st_mode) and item.name[:2] == entry.name:
                                stored[item.name] = item_st.st_size
        ids: set = set()
        total = 0
        for file_id, path, size in _listed_with_sizes(backup):
            if file_id not in stored:
                return None
            # Sizes often differ a little for files that were in use, so only empty ones count.
            if not stored[file_id] and _claimed_size(size) != 0 and not (path or "").endswith(_LIVE_COMPANIONS):
                return None
            if file_id not in ids:  # a crafted list can name one file many times over
                ids.add(file_id)
                total += stored[file_id]
    except Exception as e:
        print(f"[files] couldn't check the backup's files: {type(e).__name__}", file=sys.stderr, flush=True)
        return None
    if not ids:
        return None
    return {"bytes": total, "ids": frozenset(ids)}


def names_still_there(backup, ids: frozenset) -> bool:
    """Quick, for just before acting on stored_whole(): one directory read per folder."""
    names = _read_folder(backup.backup_dir)
    return names is not None and ids <= names


def messages_readable(backup, ids: frozenset) -> bool:
    """
    Whether the backup's Messages can be read from its folder now: copied (decrypted) afresh to a
    temp folder and every message's row read. Having a file there doesn't mean it can be read,
    and these are what people least want to lose. True when it lists no Messages.
    """
    domain, path = "HomeDomain", "Library/SMS/sms.db"

    def file_id(suffix: str) -> str:
        return hashlib.sha1(f"{domain}-{path}{suffix}".encode()).hexdigest()

    if file_id("") not in ids:
        return True
    work = None
    try:
        work = tempfile.mkdtemp(prefix="openextract-check-")
        copy = os.path.join(work, "sms.db")
        for suffix in ("", "-wal"):
            stored_as = file_id(suffix)
            if stored_as not in ids:
                continue
            if getattr(backup, "encrypted", False):
                backup._decrypted_backup.extract_file(
                    relative_path=path + suffix, domain_like=domain, output_filename=copy + suffix)
            else:
                source = os.path.join(backup.backup_dir, stored_as[:2], stored_as)
                if not os.path.isfile(source):  # iOS 9 and earlier
                    source = os.path.join(backup.backup_dir, stored_as)
                shutil.copyfile(source, copy + suffix)
        conn = sqlite3.connect(copy)
        try:
            conn.execute("SELECT count(*) FROM message NOT INDEXED").fetchone()
        finally:
            conn.close()
        return True
    except Exception as e:  # the decryption library raises many kinds
        print(f"[files] couldn't read the backup's Messages: {type(e).__name__}", file=sys.stderr, flush=True)
        return False
    finally:
        if work:
            shutil.rmtree(work, ignore_errors=True)
