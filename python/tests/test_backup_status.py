"""
Telling a finished backup from one that stopped partway (python/backup_status.py), on folders
laid out by hand the way Finder, iTunes and pymobiledevice3 leave them. The fake-iPhone
scenarios in test_unfinished_backup.py make the same folders by running a backup.
"""

import json
import os
import plistlib
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import backup  # noqa: E402
import backup_status  # noqa: E402

UDID = "00008110-000A1B2C3D4E5F60"


def _plist(path: Path, value: dict) -> None:
    path.write_bytes(plistlib.dumps(value, fmt=plistlib.FMT_BINARY))


def _manifest_db(path: Path) -> None:
    con = sqlite3.connect(path)
    con.execute("CREATE TABLE Files (fileID TEXT PRIMARY KEY, domain TEXT, relativePath TEXT, flags INTEGER, file BLOB)")
    con.commit()
    con.close()


def finished_backup(folder: Path) -> Path:
    """A backup as a finished backup leaves it."""
    folder.mkdir(parents=True)
    _plist(folder / "Info.plist", {"Unique Identifier": UDID, "Device Name": "Test iPhone",
                                   "Product Version": "18.4.1", "Last Backup Date": datetime(2026, 11, 3, 10)})
    _plist(folder / "Manifest.plist", {"IsEncrypted": False, "Version": "10.0"})
    _plist(folder / "Status.plist", {"SnapshotState": "finished", "BackupState": "new", "IsFullBackup": True})
    _manifest_db(folder / "Manifest.db")
    (folder / "3d").mkdir()
    return folder


def _old(path: Path, seconds_ago: float = 3600) -> None:
    t = path.stat().st_mtime - seconds_ago
    os.utime(path, (t, t))


@pytest.fixture
def folder(tmp_path):
    return tmp_path / UDID


# ── check() ──────────────────────────────────────────────────────────────────

def test_a_finished_backup(folder):
    c = backup_status.check(str(finished_backup(folder)))
    assert c.finished and c.signs == [] and c.openable and c.is_backup
    assert not c.confirmed  # no OpenExtract marker: finished by every sign, but not confirmed
    assert c.problem is None


def test_finder_stopped_partway(folder):
    # Finder or iTunes leave the older Manifest.plist alone; the iPhone's Snapshot folder and
    # its own Status.plist give it away.
    finished_backup(folder)
    (folder / "Snapshot" / "3d").mkdir(parents=True)
    _plist(folder / "Status.plist", {"SnapshotState": "uploading", "BackupState": "new"})
    c = backup_status.check(str(folder))
    assert not c.finished and c.signs == ["snapshot", "status:uploading"] and c.openable


def test_stopped_while_the_iphone_was_preparing(folder):
    # Before the iPhone makes Snapshot, a pymobiledevice3 try has only emptied Manifest.plist
    # and written its own "finished" Status.plist, which says nothing.
    finished_backup(folder)
    (folder / "Manifest.plist").write_bytes(b"")
    c = backup_status.check(str(folder))
    assert not c.finished and c.signs == ["empty_manifest_plist"]
    assert c.openable  # Manifest.db is plain SQLite: readable without keys


def test_encrypted_backup_that_lost_its_keys(folder):
    # An encrypted backup's Manifest.db can't be read without the keys in Manifest.plist, which
    # the failed try emptied: nothing can be opened, and it isn't a password problem.
    finished_backup(folder)
    (folder / "Manifest.plist").write_bytes(b"")
    (folder / "Manifest.db").write_bytes(os.urandom(4096))
    c = backup_status.check(str(folder))
    assert not c.openable and c.problem == backup_status.CANT_UNLOCK

    info = backup.BackupManager()._read_backup_info(str(folder))
    assert info["unfinished"] and info["encrypted"] and not info["openable"]
    with pytest.raises(RuntimeError, match="encrypted, so OpenExtract can't unlock"):
        backup.BackupManager().open_backup(UDID, backup_dir=str(folder))


def test_stopped_before_the_iphone_sent_its_list_of_files(folder):
    folder.mkdir()
    _plist(folder / "Info.plist", {"Unique Identifier": UDID, "Device Name": "Test iPhone"})
    (folder / "Manifest.plist").write_bytes(b"")
    (folder / "Snapshot" / "3d").mkdir(parents=True)
    c = backup_status.check(str(folder))
    assert c.is_backup and not c.openable and c.problem == backup_status.NOTHING_TO_OPEN

    found = backup.BackupManager().list_backups(custom_path=str(folder.parent))["backups"]
    assert [(b["udid"], b["device_name"], b["unfinished"], b["openable"]) for b in found] == [
        (UDID, "Test iPhone", True, False)]
    with pytest.raises(RuntimeError, match="nothing in it OpenExtract can open yet"):
        backup.BackupManager().open_backup(UDID, backup_dir=str(folder))


@pytest.mark.parametrize("contents", [["Info.plist"], ["Snapshot"], []])
def test_not_a_backup(folder, contents):
    folder.mkdir()
    for name in contents:
        if name == "Snapshot":
            (folder / name).mkdir()
        else:
            _plist(folder / name, {})
    assert not backup_status.check(str(folder)).is_backup
    assert backup.BackupManager().list_backups(custom_path=str(folder.parent))["backups"] == []


@pytest.mark.parametrize("status", [None, b"", b"not a plist", plistlib.dumps({"BackupState": "new"})])
def test_a_status_plist_that_says_nothing_is_ignored(folder, status):
    finished_backup(folder)
    if status is None:
        (folder / "Status.plist").unlink()
    else:
        (folder / "Status.plist").write_bytes(status)
    assert backup_status.check(str(folder)).finished


def test_a_missing_manifest_plist_alone_is_not_a_sign(folder):
    finished_backup(folder)
    (folder / "Manifest.plist").unlink()
    assert backup_status.check(str(folder)).finished


def test_an_unfinished_folder_with_nothing_to_open_is_passed_over_for_one_with_something(tmp_path):
    # The same iPhone in two folders under the one the user picked: open the one that can be.
    empty_try = tmp_path / "a-first" / UDID
    empty_try.mkdir(parents=True)
    _plist(empty_try / "Info.plist", {"Unique Identifier": UDID})
    (empty_try / "Snapshot").mkdir()
    good = finished_backup(tmp_path / "b-second" / UDID)
    manager = backup.BackupManager()
    assert manager._find_backup_in_subdirs(str(empty_try.parent), UDID)["openable"] is False
    parent = tmp_path / "both"
    parent.mkdir()
    os.rename(empty_try, parent / "0-try")
    os.rename(good, parent / "1-good")
    assert manager._find_backup_in_subdirs(str(parent), UDID)["backup_dir"] == str(parent / "1-good")


# ── OpenExtract's marker ─────────────────────────────────────────────────────

def test_marker_started_and_never_finished(folder):
    finished_backup(folder)
    _old(folder / "Manifest.db")
    backup_status.BackupTry(str(folder)).start()
    (folder / "Snapshot").mkdir()
    c = backup_status.check(str(folder))
    assert c.signs[0] == "openextract_try" and not c.finished


def test_marker_started_but_the_try_put_its_own_manifest_db_in_place(folder):
    # The engine stopped after the iPhone finished: the other signs decide.
    finished_backup(folder)
    attempt = backup_status.BackupTry(str(folder)).start()
    _manifest_db(folder / "Manifest.new")
    os.replace(folder / "Manifest.new", folder / "Manifest.db")
    os.utime(folder / "Manifest.db", (attempt.started_at + 5, attempt.started_at + 5))
    assert backup_status.check(str(folder)).finished


def test_marker_started_on_an_ios_9_backup(folder):
    # iOS 9 and earlier list their files in Manifest.mbdb: a new one clears the marker's
    # "started", an older one doesn't.
    finished_backup(folder)
    (folder / "Manifest.db").unlink()
    (folder / "Manifest.mbdb").write_bytes(b"mbdb\x05\x00")
    _old(folder / "Manifest.mbdb")
    attempt = backup_status.BackupTry(str(folder)).start()
    assert backup_status.check(str(folder)).signs == ["openextract_try"]
    os.utime(folder / "Manifest.mbdb", (attempt.started_at + 5, attempt.started_at + 5))
    assert backup_status.check(str(folder)).finished
    assert backup_status.finished_since(str(folder), attempt.started_at)
    attempt.finished()
    marker = backup_status.read_marker(str(folder))
    assert marker["manifest_db"]["size"] == 6 and backup_status.check(str(folder)).confirmed


def test_marker_finished(folder):
    finished_backup(folder)
    attempt = backup_status.BackupTry(str(folder)).start()
    (folder / "Status.plist").touch()  # the try wrote to the folder
    attempt.finished()
    marker = json.loads((folder / backup_status.MARKER_FILE).read_text(encoding="utf-8"))
    assert marker["state"] == "finished" and marker["app"] == "OpenExtract"
    assert marker["manifest_db"]["size"] == (folder / "Manifest.db").stat().st_size
    assert backup_status.check(str(folder)).confirmed


def test_marker_finished_for_another_manifest_db_is_not_a_confirmation(folder):
    # Another program backed up into the same folder later: its backup is judged on the signs.
    finished_backup(folder)
    backup_status.BackupTry(str(folder)).start().finished()
    with sqlite3.connect(folder / "Manifest.db") as con:
        con.execute("CREATE TABLE Later (x)")
    c = backup_status.check(str(folder))
    assert c.finished and not c.confirmed


def test_marker_finished_does_not_hide_a_later_try_by_another_program(folder):
    finished_backup(folder)
    backup_status.BackupTry(str(folder)).start().finished()
    (folder / "Snapshot").mkdir()
    c = backup_status.check(str(folder))
    assert not c.finished and not c.confirmed and c.signs == ["snapshot"]


def test_a_failed_try_that_changed_nothing_puts_the_old_marker_back(folder):
    finished_backup(folder)
    backup_status.BackupTry(str(folder)).start().finished()
    before = (folder / backup_status.MARKER_FILE).read_bytes()
    backup_status.BackupTry(str(folder)).start().failed()
    assert (folder / backup_status.MARKER_FILE).read_bytes() == before


def test_a_failed_try_that_changed_the_folder_stays_started(folder):
    finished_backup(folder)
    attempt = backup_status.BackupTry(str(folder)).start()
    (folder / "Manifest.plist").write_bytes(b"")
    attempt.failed()
    assert backup_status.read_marker(str(folder))["state"] == "started"


def test_a_failed_try_that_made_the_folder_removes_it(folder):
    backup_status.BackupTry(str(folder)).start().failed()
    assert not folder.exists()


def test_the_marker_never_stops_a_backup(folder, monkeypatch):
    finished_backup(folder)

    def refuse(*args, **kwargs):
        raise PermissionError(13, "Access is denied")

    monkeypatch.setattr(backup_status, "_write_marker", refuse)
    logged = []
    attempt = backup_status.BackupTry(str(folder), log=logged.append).start()
    attempt.finished()
    attempt.failed()
    assert len(logged) == 2 and all("Access is denied" in line for line in logged)
    assert not (folder / backup_status.MARKER_FILE).exists()


def test_a_damaged_marker_is_ignored(folder):
    finished_backup(folder)
    (folder / backup_status.MARKER_FILE).write_text("{not json", encoding="utf-8")
    assert backup_status.check(str(folder)).finished
    (folder / backup_status.MARKER_FILE).write_text(json.dumps({"state": "maybe"}), encoding="utf-8")
    assert backup_status.check(str(folder)).finished


def test_the_marker_does_not_count_toward_the_backups_size(folder):
    finished_backup(folder)
    backup_status.BackupTry(str(folder)).start().finished()
    assert backup.BackupManager().get_backup_size(str(folder))["size_bytes"] == 0
