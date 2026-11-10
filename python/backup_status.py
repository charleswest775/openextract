"""
Whether a backup folder holds a backup that finished.

A backup that stops partway leaves a folder that looks like a backup. OE-31: a backup cut off at
61% was opened as if it were complete, and Calls then failed with "file is not a database".

How an iPhone backup is written (a trace of a real first backup, an iPhone 17 on iOS 27.2,
2026-11-10, and pymobiledevice3 11.x's Mobilebackup2Service.backup()):

  1. The computer writes <udid>/Info.plist. pymobiledevice3 also writes a Status.plist that says
     SnapshotState "finished" and replaces Manifest.plist with an empty file, all before the
     iPhone sends anything. (Finder, iTunes and libimobiledevice don't touch either file.)
  2. The iPhone creates <udid>/Snapshot and writes its own Status.plist, which it writes four
     times in all.
  3. Every file arrives in Snapshot/<xx>/<fileID>, then Manifest.plist and Manifest.db.
  4. The files are moved one at a time to <xx>/<fileID>, then Manifest.plist and Manifest.db.
  5. Snapshot is removed, and the iPhone writes its last Status.plist.

So the signs that a backup didn't finish, most reliable first:

  - OpenExtract's own marker (MARKER_FILE) says a backup was started and that try never put a
    new Manifest.db in place. The engine writes it before each backup and replaces it only once
    the iPhone reports success (device_backup.py), so it doesn't depend on guessing.
  - A Snapshot folder. The iPhone makes one at the start of every backup, whatever program asked
    for it, and removes it only at the very end.
  - An empty Manifest.plist. pymobiledevice3 empties it before the backup starts and the iPhone
    replaces it near the end. This covers the minutes before Snapshot exists, while the iPhone
    prepares or waits for its passcode. (OpenExtract 0.12 and earlier left this; Finder doesn't.)
  - A Status.plist the iPhone wrote saying anything but "finished". libimobiledevice counts a
    backup as good only when it says "finished". pymobiledevice3 writes "finished" itself before
    the backup, so "finished" proves nothing and is ignored.
  - No Manifest.db at all: the backup stopped before the iPhone sent its list of files, so there
    is nothing to open.

A Manifest.db older than the try would be another sign, but only the engine knows when the try
began, which is what the marker records.
"""

from __future__ import annotations

import json
import os
import plistlib
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional

MARKER_FILE = "openextract-backup.json"
SNAPSHOT_DIR = "Snapshot"
_MANIFEST_DB = "Manifest.db"
_MANIFEST_MBDB = "Manifest.mbdb"
_SQLITE_HEADER = b"SQLite format 3\x00"
# FAT drives store file times to 2 seconds.
_MTIME_SLACK_S = 2.0

# What the app shows. The engine raises the last two when there's nothing it can open.
UNFINISHED = (
    "This backup didn't finish, so some things may be missing or won't open. "
    "Make a new backup to see everything."
)
NOTHING_TO_OPEN = (
    "This backup didn't finish, so there's nothing in it OpenExtract can open yet. "
    "Make a new backup to see everything."
)
CANT_UNLOCK = (
    "This backup didn't finish, and it's encrypted, so OpenExtract can't unlock what's in it. "
    "Make a new backup to see everything."
)


@dataclass
class Completion:
    """What check() found in a backup folder."""

    finished: bool
    # Why it isn't finished, for the engine's log and the tests: "openextract_try", "snapshot",
    # "empty_manifest_plist", "status:<the iPhone's SnapshotState>", "no_manifest_db".
    signs: list[str] = field(default_factory=list)
    # OpenExtract's marker says this backup finished, and it's the same Manifest.db.
    confirmed: bool = False
    # Something to open: a Manifest.db, readable without keys the failed try threw away.
    openable: bool = True
    # The folder is a backup, finished or not. False for a folder with nothing of a backup in it.
    is_backup: bool = True

    @property
    def problem(self) -> Optional[str]:
        """Why it can't be opened, in the app's words, or None if it can."""
        if self.openable:
            return None
        return NOTHING_TO_OPEN if "no_manifest_db" in self.signs else CANT_UNLOCK


def _file_facts(path: str) -> Optional[dict]:
    try:
        st = os.stat(path)
    except OSError:
        return None
    return {"size": st.st_size, "mtime": st.st_mtime}


def read_marker(backup_dir: str) -> Optional[dict]:
    try:
        with open(os.path.join(backup_dir, MARKER_FILE), encoding="utf-8") as f:
            marker = json.load(f)
    except (OSError, ValueError):
        return None
    if not isinstance(marker, dict) or marker.get("state") not in ("started", "finished"):
        return None
    return marker


def _snapshot_state(backup_dir: str) -> Optional[str]:
    try:
        with open(os.path.join(backup_dir, "Status.plist"), "rb") as f:
            status = plistlib.load(f)
    except Exception:  # missing, empty or damaged: says nothing either way
        return None
    state = status.get("SnapshotState") if isinstance(status, dict) else None
    return state if isinstance(state, str) else None


def _is_plain_sqlite(path: str) -> bool:
    try:
        with open(path, "rb") as f:
            return f.read(len(_SQLITE_HEADER)) == _SQLITE_HEADER
    except OSError:
        return False


def check(backup_dir: str) -> Completion:
    """Whether the backup in backup_dir finished, and if not, whether there's anything to open."""
    signs: list[str] = []
    manifest_db = os.path.join(backup_dir, _MANIFEST_DB)
    db = _file_facts(manifest_db)
    has_index = db is not None or os.path.exists(os.path.join(backup_dir, _MANIFEST_MBDB))
    marker = read_marker(backup_dir)

    if marker and marker["state"] == "started":
        started_at = marker.get("started_at")
        # A try that got as far as putting its own Manifest.db in place is judged on the other
        # signs: it may have finished just before the engine stopped.
        new_index = (db is not None and isinstance(started_at, (int, float))
                     and db["mtime"] >= started_at - _MTIME_SLACK_S)
        if not new_index:
            signs.append("openextract_try")
    snapshot = os.path.isdir(os.path.join(backup_dir, SNAPSHOT_DIR))
    if snapshot:
        signs.append("snapshot")
    manifest_plist = _file_facts(os.path.join(backup_dir, "Manifest.plist"))
    empty_manifest_plist = manifest_plist is not None and manifest_plist["size"] == 0
    if empty_manifest_plist:
        signs.append("empty_manifest_plist")
    state = _snapshot_state(backup_dir)
    if state is not None and state != "finished":
        signs.append(f"status:{state}")
    if not has_index:
        signs.append("no_manifest_db")

    is_backup = has_index or (
        os.path.exists(os.path.join(backup_dir, "Info.plist")) and (snapshot or marker is not None))
    # A failed try by pymobiledevice3 empties Manifest.plist, which holds an encrypted backup's
    # keys. An encrypted Manifest.db can't be read without them.
    keys_lost = db is not None and empty_manifest_plist and not _is_plain_sqlite(manifest_db)
    confirmed = (not signs and marker is not None and marker["state"] == "finished"
                 and _same_file(marker.get("manifest_db"), db))
    return Completion(
        finished=not signs,
        signs=signs,
        confirmed=confirmed,
        openable=has_index and not keys_lost,
        is_backup=is_backup,
    )


def _same_file(recorded, now: Optional[dict]) -> bool:
    return (isinstance(recorded, dict) and now is not None and recorded.get("size") == now["size"]
            and isinstance(recorded.get("mtime"), (int, float))
            and abs(recorded["mtime"] - now["mtime"]) <= _MTIME_SLACK_S)


def finished_since(backup_dir: str, since: float) -> bool:
    """A backup that started at `since` put its own Manifest.db in place and shows no sign of
    stopping partway: for when the iPhone hangs up instead of reporting the result."""
    db = _file_facts(os.path.join(backup_dir, _MANIFEST_DB))
    return db is not None and db["mtime"] >= since - _MTIME_SLACK_S and check(backup_dir).finished


# ── The marker ───────────────────────────────────────────────────────────────

def _iso(ts: float) -> str:
    return datetime.fromtimestamp(ts, timezone.utc).isoformat(timespec="seconds")


def _write_marker(backup_dir: str, marker: dict) -> None:
    path = os.path.join(backup_dir, MARKER_FILE)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(marker, f, indent=2)
        f.write("\n")
    os.replace(tmp, path)


_WATCHED = ("Info.plist", "Status.plist", "Manifest.plist", _MANIFEST_DB)


def _folder_state(backup_dir: str) -> tuple:
    def facts(name: str):
        try:
            st = os.stat(os.path.join(backup_dir, name))
        except OSError:
            return None
        return (st.st_size, st.st_mtime_ns)
    return tuple(facts(name) for name in _WATCHED) + (os.path.isdir(os.path.join(backup_dir, SNAPSHOT_DIR)),)


class BackupTry:
    """
    OpenExtract's marker around one backup try into backup_dir (<folder>/<udid>):

        attempt = BackupTry(backup_dir).start()   # just before the backup request
        ... the backup ...
        attempt.finished()                        # only once the iPhone has reported success
        attempt.failed()                          # or this, if the try failed

    start() records "started". finished() records "finished" with the Manifest.db it wrote.
    failed() leaves "started" in place, unless the try never touched the folder (the iPhone was
    locked, another app held its sync lock): then whatever was there before is put back, so a
    try that changed nothing doesn't make a good backup look unfinished.

    The marker never stops a backup: if it can't be written, the backup goes ahead without it.
    """

    def __init__(self, backup_dir: str, log=lambda msg: None):
        self.backup_dir = backup_dir
        self._log = log
        self._previous: Optional[bytes] = None
        self._made_folder = False
        self._wrote = False
        self._before: tuple = ()
        self.started_at = 0.0

    def start(self) -> "BackupTry":
        path = os.path.join(self.backup_dir, MARKER_FILE)
        try:
            with open(path, "rb") as f:
                self._previous = f.read()
        except OSError:
            self._previous = None
        self.started_at = time.time()
        try:
            if not os.path.isdir(self.backup_dir):
                os.makedirs(self.backup_dir)
                self._made_folder = True
            self._before = _folder_state(self.backup_dir)
            _write_marker(self.backup_dir, {
                "app": "OpenExtract",
                "state": "started",
                "started": _iso(self.started_at),
                "started_at": self.started_at,
            })
            self._wrote = True
        except OSError as e:
            self._log(f"couldn't write {MARKER_FILE} in {self.backup_dir!r}: {e!r}")
        return self

    def finished(self) -> None:
        now = time.time()
        try:
            _write_marker(self.backup_dir, {
                "app": "OpenExtract",
                "state": "finished",
                "started": _iso(self.started_at),
                "started_at": self.started_at,
                "finished": _iso(now),
                "finished_at": now,
                "manifest_db": _file_facts(os.path.join(self.backup_dir, _MANIFEST_DB)),
            })
        except OSError as e:
            self._log(f"couldn't write {MARKER_FILE} in {self.backup_dir!r}: {e!r}")

    def failed(self) -> None:
        if not self._wrote or _folder_state(self.backup_dir) != self._before:
            return  # no marker to take back, or the try changed the folder: "started" stays
        path = os.path.join(self.backup_dir, MARKER_FILE)
        try:
            if self._previous is None:
                os.remove(path)
                if self._made_folder and not os.listdir(self.backup_dir):
                    os.rmdir(self.backup_dir)
            else:
                with open(path, "wb") as f:
                    f.write(self._previous)
        except OSError as e:
            self._log(f"couldn't put back {MARKER_FILE} in {self.backup_dir!r}: {e!r}")
