"""
Opening a backup that stopped partway (OE-31: a backup of a 210 GB iPhone was cut off at 61%,
then opened as if it were complete, and Calls failed with "file is not a database").

Each scenario backs up the fake iPhone (fake_iphone/README.md), stops the backup partway the way
real ones stop, then lists and opens the folder the way the app does. What tells a finished
backup from an unfinished one is in python/backup_status.py.
"""

import json
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
for _path in (HERE, HERE.parent):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from fake_iphone import FakeIPhone, run_backup  # noqa: E402
from fake_iphone import plan as plans  # noqa: E402

import backup  # noqa: E402
import backup_status  # noqa: E402
import device_backup  # noqa: E402

pytestmark = pytest.mark.fake_iphone

MiB = plans.MiB
# What the app says when the connection drops after data has arrived (every scenario here).
DROPPED = device_backup._CONNECTION_DROPPED.split("{copied}")[0]


@pytest.fixture(autouse=True)
def quick_engine(monkeypatch):
    monkeypatch.setattr(device_backup, "_BYTES_REPORT_INTERVAL_S", 0.05)
    monkeypatch.setattr(device_backup, "_BACKUP_LOCK_RETRY_DELAY_S", 0.05)


@pytest.fixture
def out(tmp_path):
    return tmp_path / "Backups"


# ── How a real iPhone writes its Status.plist ────────────────────────────────

def _status(state, progress):
    """The iPhone writing <udid>/Status.plist in place, as a real one does four times."""
    return {"op": "UploadFiles", "progress": progress, "files": [
        {"path": "{udid}/Status.plist", "device_name": "Status.plist", "size": 0,
         "generate": "status_plist", "state": state}]}


def _first(ops, name):
    return next(i for i, op in enumerate(ops) if op["op"] == name)


def _like_a_real_iphone(ops=None):
    """
    A backup plan whose Status.plist says what the iPhone is doing. A real iPhone writes it in
    place four times: before the first file, before the first move, before Snapshot is removed,
    and after. synthetic_backup() does too, but every one says "finished", because the trace
    keeps names and sizes, never contents. libimobiledevice counts a backup as good only when
    the last one says "finished", so the earlier ones are modelled as the steps they come before.
    """
    ops = [op for op in (ops or plans.synthetic_backup())
           if not (op["op"] == "UploadFiles" and [f["path"] for f in op["files"]] == ["{udid}/Status.plist"])]
    first_file = _first(ops, "UploadFiles")
    ops.insert(first_file, _status("uploading", ops[first_file].get("progress", 0)))
    ops.insert(_first(ops, "MoveItems"), _status("moving", 98.9))
    ops.insert(_first(ops, "RemoveItems"), _status("removing", 99.99))
    last_remove = max(i for i, op in enumerate(ops) if op["op"] == "RemoveItems")
    ops.insert(last_remove + 1, _status("finished", 100))
    return ops


def _hang_up_before(ops, name):
    """The iPhone closes the connection just before the first step called `name`."""
    ops = list(ops)
    ops.insert(_first(ops, name), {"op": "Drop"})
    return ops


# ── What the app sees ────────────────────────────────────────────────────────

def _listed(out):
    """What the app lists when the user picks the folder the backups were saved to."""
    return backup.BackupManager().list_backups(custom_path=str(out))["backups"]


def _the_one_listed(out):
    found = _listed(out)
    assert len(found) == 1, found
    return found[0]


def _open_and_read_messages(run):
    """Opens the backup like the app does; returns its info and whether sms.db can be read."""
    manager = backup.BackupManager()
    opened = manager.open_backup(run.phone.udid, backup_dir=str(run.backup_dir))
    try:
        reader = manager.get_open_backup(run.phone.udid)
        sms = reader.get_file("Library/SMS/sms.db", "HomeDomain")
        return opened, sms is not None
    finally:
        manager.close_backup(run.phone.udid)


def _marker(run):
    return json.loads((run.backup_dir / backup_status.MARKER_FILE).read_text(encoding="utf-8"))


def _a_week_later(run):
    """Makes the finished backup in run's folder a week old, as a real earlier backup would be.
    (One made a second ago is as new as the next try, to a FAT drive's clock.)"""
    import os
    import time

    week_ago = time.time() - 7 * 24 * 3600
    for name in ("Manifest.db", "Manifest.plist", "Info.plist", "Status.plist"):
        os.utime(run.backup_dir / name, (week_ago, week_ago))


# ── A backup that finishes ───────────────────────────────────────────────────

def test_a_finished_backup_is_marked_finished(out):
    run = run_backup(FakeIPhone(_like_a_real_iphone()), out)
    assert run.error is None, run.error

    marker = _marker(run)
    assert marker["state"] == "finished"
    assert marker["manifest_db"]["size"] == (run.backup_dir / "Manifest.db").stat().st_size
    assert backup_status.check(str(run.backup_dir)).confirmed
    info = _the_one_listed(out)
    assert info["unfinished"] is False and info["openable"] is True
    opened, can_read = _open_and_read_messages(run)
    assert opened["status"] == "open" and opened["info"]["unfinished"] is False and can_read


def test_iphone_hangs_up_instead_of_answering_after_the_last_step(out):
    # Everything is in place and Snapshot is gone; the iPhone closes the connection instead of
    # sending its final answer. That's a finished backup, and it's marked as one.
    ops = _like_a_real_iphone()
    run = run_backup(FakeIPhone(ops[:-1] + [{"op": "Drop"}]), out)

    assert run.error is None, run.error
    assert _marker(run)["state"] == "finished"
    assert _the_one_listed(out)["unfinished"] is False


# ── A backup that stops partway ──────────────────────────────────────────────

def test_cut_off_partway_into_an_empty_folder(out):
    # The first backup of this iPhone stops partway: the iPhone hasn't sent its Manifest.db yet,
    # so there's nothing to open, and the app says so instead of "No iPhone backups found".
    run = run_backup(FakeIPhone(_like_a_real_iphone(), drop_after_bytes=12 * MiB), out)
    assert run.error.startswith(DROPPED)

    info = _the_one_listed(out)
    assert info["unfinished"] is True and info["openable"] is False
    assert info["udid"] == run.phone.udid
    assert set(info["unfinished_signs"]) == {
        "openextract_try", "snapshot", "empty_manifest_plist", "status:uploading", "no_manifest_db"}
    with pytest.raises(RuntimeError) as raised:
        backup.BackupManager().open_backup(run.phone.udid, backup_dir=str(run.backup_dir))
    assert str(raised.value) == backup_status.NOTHING_TO_OPEN


def test_cut_off_partway_over_an_older_backup(out):
    # OE-31's shape: a folder with a finished backup, then a try that stops partway. The folder
    # still holds the older backup's Manifest.db and files, so it can be opened, but it's no
    # longer that backup: the app says it didn't finish.
    first = run_backup(FakeIPhone(), out)
    assert first.error is None
    _a_week_later(first)
    run = run_backup(FakeIPhone(_like_a_real_iphone(), drop_after_bytes=6 * MiB), out)
    assert run.error.startswith(DROPPED)

    info = _the_one_listed(out)
    assert info["unfinished"] is True and info["openable"] is True
    assert set(info["unfinished_signs"]) == {"openextract_try", "snapshot", "empty_manifest_plist", "status:uploading"}
    opened, can_read = _open_and_read_messages(run)
    assert opened["status"] == "open" and opened["info"]["unfinished"] is True
    assert can_read  # what's there can still be looked at


def test_cut_off_with_every_file_sent_but_none_moved(out):
    first = run_backup(FakeIPhone(), out)
    assert first.error is None
    _a_week_later(first)
    run = run_backup(FakeIPhone(_hang_up_before(_like_a_real_iphone(), "MoveItems")), out)
    assert run.error.startswith(DROPPED)

    info = _the_one_listed(out)
    assert info["unfinished"] is True and info["openable"] is True
    assert {"openextract_try", "snapshot", "status:moving"} <= set(info["unfinished_signs"])


def test_cut_off_partway_through_the_moves(out):
    # A real iPhone moves files out of Snapshot one at a time, 128 to a message, then
    # Manifest.plist and Manifest.db. This one stops after the first message: some new files are
    # in place, the rest are still in Snapshot, and the folder's Manifest.db is the older one.
    first = run_backup(FakeIPhone(), out)
    assert first.error is None
    _a_week_later(first)
    ops = _like_a_real_iphone(plans.synthetic_backup(file_count=300, large_files=()))
    moves = [i for i, op in enumerate(ops) if op["op"] == "MoveItems"]
    assert len(moves) >= 3
    ops.insert(moves[1], {"op": "Drop"})
    run = run_backup(FakeIPhone(ops), out)
    assert run.error.startswith(DROPPED)

    moved = set(ops[moves[0]]["items"].values())
    assert all((out / dst.replace("{udid}", run.phone.udid)).exists() for dst in moved)
    assert any(name.startswith("Snapshot/") for name in run.files())
    info = _the_one_listed(out)
    assert info["unfinished"] is True and info["openable"] is True
    assert set(info["unfinished_signs"]) == {"openextract_try", "snapshot", "empty_manifest_plist", "status:moving"}
    opened, _ = _open_and_read_messages(run)
    assert opened["status"] == "open" and opened["info"]["unfinished"] is True


def test_iphone_hangs_up_before_removing_snapshot(out):
    # Every file and the new Manifest.db are in place, but the iPhone never finished: it would
    # have removed Snapshot (now 256 empty folders) and written its last Status.plist next.
    # Not a success.
    run = run_backup(FakeIPhone(_hang_up_before(_like_a_real_iphone(), "RemoveItems")), out)
    assert run.error.startswith(DROPPED), run.error

    info = _the_one_listed(out)
    assert info["unfinished"] is True and info["openable"] is True
    assert info["unfinished_signs"] == ["snapshot", "status:removing"]
    assert _marker(run)["state"] == "started"


def test_unplugged_partway(out):
    run = run_backup(FakeIPhone(_like_a_real_iphone(), drop_after_bytes=6 * MiB, unplug_on_drop=True), out)
    assert run.error.startswith("DEVICE_DISCONNECTED:")
    assert _the_one_listed(out)["unfinished"] is True


def test_a_new_backup_after_one_that_stopped_is_finished(out):
    first = run_backup(FakeIPhone(_like_a_real_iphone(), drop_after_bytes=6 * MiB), out)
    assert first.error is not None
    run = run_backup(FakeIPhone(_like_a_real_iphone()), out)
    assert run.error is None, run.error

    info = _the_one_listed(out)
    assert info["unfinished"] is False
    assert backup_status.check(str(run.backup_dir)).confirmed


# ── A try that never got going ───────────────────────────────────────────────

def test_a_try_that_changed_nothing_leaves_a_finished_backup_alone(out):
    # The iPhone is locked, so the backup never starts and nothing in the folder changes. The
    # backup already there is still finished, and still marked so.
    first = run_backup(FakeIPhone(), out)
    assert first.error is None
    before = (first.backup_dir / backup_status.MARKER_FILE).read_bytes()

    run = run_backup(FakeIPhone(locked=True), out)
    assert run.error.startswith("PASSCODE_REQUIRED:")
    assert (first.backup_dir / backup_status.MARKER_FILE).read_bytes() == before
    assert _the_one_listed(out)["unfinished"] is False


def test_a_try_that_changed_nothing_leaves_no_folder_behind(out):
    run = run_backup(FakeIPhone(locked=True), out)
    assert run.error.startswith("PASSCODE_REQUIRED:")
    assert not run.backup_dir.exists()
    assert _listed(out) == []
