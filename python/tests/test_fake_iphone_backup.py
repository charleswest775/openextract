"""
Making a backup, end to end, against a scripted fake iPhone (python/tests/fake_iphone).

Unlike test_backup.py, nothing in pymobiledevice3 is mocked here: the engine's start_backup(),
Mobilebackup2Service.backup(), DeviceLink and ServiceConnection all run, and write real files.
The fake iPhone plays the phone's side over a socket pair and can misbehave on cue. Each test
asserts what the app would get: the result or the error text it shows, the backup.progress
notifications, and what's left in the backup folder. See fake_iphone/README.md to add one.
"""

import errno
import os
import sqlite3
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
for _path in (HERE, HERE.parent):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from fake_iphone import FakeIPhone, InUse, failing_disk, run_backup, slow_disk  # noqa: E402
from fake_iphone import plan as plans  # noqa: E402
from fake_iphone.harness import is_root, stalling_disk  # noqa: E402
from fake_iphone.real_modules import module  # noqa: E402

import device_backup  # noqa: E402

pytestmark = pytest.mark.fake_iphone

MiB = plans.MiB
TERMINATED = "The connection to your iPhone was terminated unexpectedly."


@pytest.fixture(autouse=True)
def quick_engine(monkeypatch):
    # The engine's own timings, shortened so each scenario takes a second or two.
    monkeypatch.setattr(device_backup, "_BYTES_REPORT_INTERVAL_S", 0.05)
    monkeypatch.setattr(device_backup, "_BACKUP_LOCK_RETRY_DELAY_S", 0.05)


@pytest.fixture
def out(tmp_path):
    return tmp_path / "Backups"


def _before_final_answer(ops, *extra):
    """The plan with extra ops just before the iPhone's final answer."""
    return ops[:-1] + list(extra) + ops[-1:]


def _expected_files(ops):
    """{path in the backup folder: size} for every file the plan sends, after its moves."""
    where = plans.final_locations(ops)
    return {where[f["path"]].split("/", 1)[1]: f["size"] for f in plans.uploaded_files(ops)
            if not f.get("error") and not f.get("generate")}


def _first_file_batch(ops):
    """The first UploadFiles that sends the iPhone's files (not Status.plist)."""
    return next(op for op in ops if op["op"] == "UploadFiles" and any("relative_path" in f for f in op["files"]))


def _through_first_file_batch(ops):
    """The plan up to and including the first batch of the iPhone's files."""
    return ops[:ops.index(_first_file_batch(ops)) + 1]


# ── A backup that works ──────────────────────────────────────────────────────

def test_full_backup(out):
    phone = FakeIPhone()
    run = run_backup(phone, out)

    assert run.error is None
    assert run.result == {"success": True, "backup_path": str(run.backup_dir)}

    # Every file where the iPhone put it, at its full size; Snapshot gone.
    expected = _expected_files(phone.plan)
    files = run.files()
    assert set(expected) <= files
    assert {"Info.plist", "Manifest.db", "Manifest.plist", "Status.plist"} <= files
    assert not (run.backup_dir / "Snapshot").exists()
    for name, size in expected.items():
        assert (run.backup_dir / name).stat().st_size == size, name
    some = next(iter(expected))
    assert (run.backup_dir / some).read_bytes()[:32] == plans.expected_prefix(
        plans.with_udid(next(f["path"] for f in plans.uploaded_files(phone.plan) if f["path"].endswith(some)), phone.udid))

    # Manifest.db lists them all.
    with sqlite3.connect(run.backup_dir / "Manifest.db") as con:
        listed = {row[0] for row in con.execute("SELECT fileID FROM Files")}
    assert listed == {name.split("/")[-1] for name in expected}

    # What the screen showed: in order, never backwards, ending at 100% with every byte counted.
    assert run.phases == ["negotiating", "waiting", "backing_up", "finalizing"]
    run.assert_progress_never_goes_back()
    assert run.progress[-1]["phase"] == "finalizing" and run.progress[-1]["percent"] == 100
    assert run.progress[-1]["bytes_done"] == plans.payload_bytes(phone.plan)


def _unreadable_files(run):
    """Files the plan sent that OpenExtract's reader can't find in the finished backup."""
    import backup

    manager = backup.BackupManager()
    opened = manager.open_backup(run.phone.udid, backup_dir=run.result["backup_path"])
    assert opened["status"] == "open" and opened["info"]["encrypted"] is False
    try:
        reader = manager.get_open_backup(run.phone.udid)
        missing = []
        for f in plans.uploaded_files(run.phone.plan):
            if f.get("generate") or f.get("error"):
                continue
            found = reader.get_file(f["relative_path"], f["domain"])
            if found is None or os.path.getsize(found) != f["size"]:
                missing.append(f"{f['domain']}/{f['relative_path']}")
        return missing
    finally:
        manager.close_backup(run.phone.udid)


def test_the_app_can_open_the_backup(out):
    run = run_backup(FakeIPhone(), out)
    assert run.error is None
    assert _unreadable_files(run) == []


def test_backup_into_a_folder_with_an_unfinished_one(out):
    # The first try loses the connection partway; Retry uses the same folder.
    first = run_backup(FakeIPhone(drop_after_bytes=6 * MiB), out)
    assert first.error is not None
    run = run_backup(FakeIPhone(), out)
    assert run.error is None
    assert set(_expected_files(run.phone.plan)) <= run.files()
    assert not (run.backup_dir / "Snapshot").exists()


# ── The connection drops ─────────────────────────────────────────────────────

def test_connection_drops_partway(out):
    phone = FakeIPhone(drop_after_bytes=12 * MiB)
    run = run_backup(phone, out)

    assert run.result is None
    assert run.error.startswith(TERMINATED)
    assert phone.drops == 1
    assert "backing_up" in run.phases and run.progress[-1]["percent"] < 100
    assert run.progress[-1]["bytes_done"] <= 12 * MiB
    run.assert_progress_never_goes_back()
    # Nothing was moved into place: no Manifest.db, what arrived is still in Snapshot.
    assert not (run.backup_dir / "Manifest.db").exists()
    arrived = sum((run.backup_dir / name).stat().st_size for name in run.files() if name.startswith("Snapshot/"))
    assert 0 < arrived <= 12 * MiB


def test_unplugged_partway(out):
    phone = FakeIPhone(drop_after_bytes=12 * MiB, unplug_on_drop=True)
    run = run_backup(phone, out)

    assert run.error.startswith("DEVICE_DISCONNECTED:")
    assert not phone.connected


def test_unplugged_while_moving_files_into_place(out):
    phone = FakeIPhone()
    phone.before("MoveItems", lambda op: phone.unplug())
    run = run_backup(phone, out)

    assert run.error.startswith("DEVICE_DISCONNECTED:")


def test_iphone_closes_the_connection_after_the_last_file(out):
    # Everything arrived and was moved into place; the iPhone hangs up instead of answering.
    phone = FakeIPhone(plans.synthetic_backup()[:-1] + [{"op": "Drop"}])
    run = run_backup(phone, out)

    assert run.error is None, run.error
    assert run.result["success"] is True
    assert run.progress[-1]["percent"] == 100


def test_drop_in_a_folder_with_an_older_backup_is_not_a_success(out):
    # A Manifest.db from an earlier backup mustn't make a failed one look finished.
    old = out / FakeIPhone().udid
    old.mkdir(parents=True)
    (old / "Manifest.db").write_bytes(b"old")
    os.utime(old / "Manifest.db", (1_600_000_000, 1_600_000_000))

    run = run_backup(FakeIPhone(drop_after_bytes=6 * MiB), out)
    assert run.error is not None and run.error.startswith(TERMINATED)


def test_every_connection_drops_but_the_iphone_stays_plugged_in(out):
    # The backup connection and the backup lock's (AFC) drop together, as when usbmuxd resets the
    # device's links. Six of the seven Windows reports end like this.
    phone = FakeIPhone(drop_after_bytes=12 * MiB, drop_everything=True)
    run = run_backup(phone, out)

    assert phone.connected
    assert run.error.startswith(TERMINATED)


def _raised_in(exc, function):
    import traceback
    return any(frame.name == function for frame in traceback.extract_tb(exc.__traceback__))


@pytest.mark.xfail(strict=True, reason=(
    "pymobiledevice3 Mobilebackup2Service._backup_lock() releases the iPhone's sync lock in a "
    "finally block; on a dead AFC link that raises ConnectionTerminatedError, which replaces the "
    "error that ended the backup (draft upstream issue in the PR that added this test)."))
def test_the_error_that_ended_the_backup_is_the_one_reported(out):
    phone = FakeIPhone(drop_after_bytes=12 * MiB, drop_everything=True)
    run = run_backup(phone, out)

    assert not _raised_in(run.exception.__cause__, "_backup_lock")


def test_connection_reset_partway(out):
    # Windows reports a connection usbmuxd tore down as "forcibly closed" (WinError 10054).
    phone = FakeIPhone(_through_first_file_batch(plans.synthetic_backup()) + [{"op": "Drop"}], reset_on_drop=True)
    run = run_backup(phone, out)
    assert run.error.startswith(TERMINATED)


# ── A slow computer ──────────────────────────────────────────────────────────

def test_slow_disk_keeps_reporting_bytes(out, monkeypatch):
    # While one big file trickles in, the device's percentage stands still; the bytes copied
    # must keep moving, both for the screen and for the app's time limit (PR #222).
    plan = plans.synthetic_backup(file_count=20, large_files=(6 * MiB,))
    slow_disk(monkeypatch, bytes_per_second=12 * MiB)
    run = run_backup(FakeIPhone(plan), out)

    assert run.error is None
    big_file_reports = [p for p in run.progress if p["phase"] == "backing_up"]
    longest = _longest_run_at_one_percent(big_file_reports)
    sizes = [p["bytes_done"] for p in longest]
    assert sizes == sorted(sizes) and len(set(sizes)) >= 4, run.progress


def _longest_run_at_one_percent(reports):
    best, current = [], []
    for p in reports:
        if current and p["percent"] == current[-1]["percent"]:
            current.append(p)
        else:
            current = [p]
        best = max(best, current, key=len)
    return best


def test_iphone_gives_up_when_the_computer_stalls(out, monkeypatch):
    # The computer stops reading for longer than the iPhone waits (a drive spinning up, antivirus
    # holding a new file): the iPhone closes the connection. How long a real iPhone waits is
    # unknown; this checks what the user is told when it happens.
    stalling_disk(monkeypatch, after_bytes=4 * MiB, seconds=2.0)
    phone = FakeIPhone(stall_timeout=0.5)
    run = run_backup(phone, out)

    assert phone.stalled
    assert run.error is not None and run.error.startswith(TERMINATED)


# ── The computer's disk ──────────────────────────────────────────────────────

def test_disk_fills_up_while_writing(out, monkeypatch):
    failing_disk(monkeypatch, after_bytes=5 * MiB, error=errno.ENOSPC)
    run = run_backup(FakeIPhone(), out)

    assert run.error is not None
    assert run.error.startswith("Not enough free space for this backup."), run.error


def test_iphone_needs_more_space_than_the_drive_has(out):
    # BackupAgent2 asks for more space (DLMessagePurgeDiskSpace), then refuses (MBErrorDomain/105).
    plan = [dict(op, needs_more_than_reported=5 * 10**9) if op["op"] == "GetFreeDiskSpace" else op
            for op in plans.synthetic_backup()]
    run = run_backup(FakeIPhone(plan), out)

    assert run.error.startswith("Not enough free space for this backup. It needs more than ")
    assert "GB free, but the drive you chose has" in run.error


def test_iphone_itself_is_full(out):
    phone = FakeIPhone(refuse_attempts={0: {
        "ErrorCode": 105,
        "ErrorDescription": 'Failed to create snapshot: No space left on device (28) at path "/private/var"',
    }})
    run = run_backup(phone, out)
    assert run.error == device_backup._IPHONE_FULL


# ── Files in use by another program ──────────────────────────────────────────

skip_if_root = pytest.mark.skipif(is_root(), reason="root ignores the read-only folder that stands in for a lock")


@skip_if_root
def test_file_in_use_while_moving_files_into_place(out):
    # The iPhone moves each file from Snapshot/<xx>/ to <xx>/; Defender, OneDrive or the indexer
    # has one of them open.
    phone = FakeIPhone()
    lock = InUse()
    first = next(src for op in phone.plan if op["op"] == "MoveItems" for src in op["items"])
    phone.before("MoveItems", lambda op: lock.lock(out / plans.with_udid(first, phone.udid)))
    try:
        run = run_backup(phone, out)
    finally:
        lock.release()

    assert run.error == device_backup._FOLDER_IN_USE
    assert isinstance(run.exception.__cause__, PermissionError)
    assert (run.backup_dir / "Snapshot").exists()


@skip_if_root
def test_folder_in_use_while_removing_snapshot(out):
    # OE-11: "[WinError 5] Access is denied: '...\\Snapshot\\00'". At the end the iPhone removes
    # Snapshot, now 256 empty folders; another program has one of them open.
    phone = FakeIPhone()
    lock = InUse()
    phone.before("RemoveItems", lambda op: lock.lock(run_dir(phone, out) / "Snapshot" / "00"))
    try:
        run = run_backup(phone, out)
    finally:
        lock.release()

    assert run.error == device_backup._FOLDER_IN_USE
    assert isinstance(run.exception.__cause__, PermissionError)
    assert (run.backup_dir / "Snapshot" / "00").exists()


def run_dir(phone, out):
    return out / phone.udid


@skip_if_root
def test_folder_in_use_in_a_folder_reached_through_a_link(tmp_path):
    # pymobiledevice3 names files from the folder's resolved path. A folder chosen through a link
    # (on Windows also a mapped drive or a short 8.3 name) must still get the "in use" message,
    # not "[Errno 13] Permission denied: ..." as it is.
    real = tmp_path / "real"
    real.mkdir()
    link = tmp_path / "link"
    try:
        link.symlink_to(real, target_is_directory=True)
    except OSError as e:
        pytest.skip(f"can't make a link here: {e}")
    phone = FakeIPhone()
    lock = InUse()
    first = next(src for op in phone.plan if op["op"] == "MoveItems" for src in op["items"])
    phone.before("MoveItems", lambda op: lock.lock(real / plans.with_udid(first, phone.udid)))
    try:
        run = run_backup(phone, link)
    finally:
        lock.release()

    assert run.error == device_backup._FOLDER_IN_USE


def _a_week_later():
    """The same iPhone a week later: more messages in sms.db, and new photos."""
    later = plans.synthetic_backup(file_count=160)
    next(f for f in plans.uploaded_files(later) if f.get("relative_path") == "Library/SMS/sms.db")["size"] += 64 * 1024
    return later


def test_a_second_backup_into_the_same_folder(out):
    # Backing up the same iPhone again into the same folder (or Retry after a backup that got as
    # far as moving files). The iPhone moves each file onto the last backup's copy, which is
    # replaced. (Not traced from a real iPhone yet: it might move differently the second time.)
    first = run_backup(FakeIPhone(), out)
    assert first.error is None
    run = run_backup(FakeIPhone(_a_week_later()), out)

    assert run.error is None
    assert _unreadable_files(run) == []


@pytest.mark.xfail(sys.platform == "win32", strict=True, reason=(
    "pymobiledevice3 DeviceLink.move_items() uses shutil.move(). On Windows, os.rename() onto an "
    "existing file fails and shutil.move() copies the file, then deletes the original, so a second "
    "backup into the same folder copies every file again at ~99%. libimobiledevice deletes the "
    "destination, then renames (draft upstream issue in the PR that added this test)."))
def test_a_second_backup_moves_files_without_copying_them(out, monkeypatch):
    run_backup(FakeIPhone(), out)
    failed_renames = []
    rename = os.rename

    def watching(src, dst, *args, **kwargs):
        try:
            return rename(src, dst, *args, **kwargs)
        except OSError:
            failed_renames.append(str(dst))
            raise

    monkeypatch.setattr(os, "rename", watching)
    run = run_backup(FakeIPhone(_a_week_later()), out)

    assert run.error is None
    # Manifest.plist always lands on the empty one pymobiledevice3 writes at the start.
    assert [p for p in failed_renames if not p.endswith("Manifest.plist")] == []


@pytest.mark.xfail(strict=True, reason=(
    "Latent, not seen from a real iPhone: pymobiledevice3 DeviceLink.move_items() uses "
    "shutil.move(), which moves a folder INTO an existing one instead of replacing it. The traced "
    "iPhone moves files, not folders (draft upstream issue in the PR that added this test)."))
def test_moving_a_folder_onto_an_existing_one_replaces_it(out):
    # A plan that moves whole folders, as an iPhone might: Snapshot/<xx> onto an existing <xx>.
    ops = plans.synthetic_backup()
    moves = [op for op in ops if op["op"] == "MoveItems" and not any(k.endswith(".plist") or k.endswith(".db") for k in op["items"])]
    first = ops.index(moves[0])
    for op in moves:
        ops.remove(op)
    ops.insert(first, {"op": "MoveItems", "progress": 99.5,
                       "items": {f"{{udid}}/Snapshot/{xx}": f"{{udid}}/{xx}" for xx in plans.ALL_PREFIXES}})
    run = run_backup(FakeIPhone(ops), out)  # the <xx> folders exist: the iPhone made them first

    assert run.error is None
    assert _unreadable_files(run) == []


# ── The iPhone's own errors ──────────────────────────────────────────────────

def test_iphone_cannot_read_some_files(out, tmp_path, monkeypatch):
    # OE-6, OE-8: MBErrorDomain/104 "Multiple errors uploading files".
    ops = plans.synthetic_backup()
    batch = _first_file_batch(ops)
    for f in batch["files"][:3]:
        f["error"] = "Operation not permitted"
    phone = FakeIPhone(ops)
    log = tmp_path / "python_log.txt"
    monkeypatch.setattr(device_backup, "_LOG_PATH", str(log))
    run = run_backup(phone, out)

    assert phone.final_answers[-1]["ErrorCode"] == 104
    assert run.error == device_backup._FILES_NOT_SENT
    # Which files, and why, reach the engine's log on this computer. (Feedback reports keep only
    # error entries from it, and no file paths from inside a backup.)
    logged = log.read_text(encoding="utf-8")
    for f in batch["files"][:3]:
        assert f["device_name"] in logged and "Operation not permitted" in logged


def test_iphone_sends_a_file_into_a_folder_it_did_not_create(out):
    # OE-6: "[Errno 2] No such file or directory: '...\\Snapshot\\51\\...'": the iPhone counts on a
    # folder from an earlier try that isn't there.
    ops = plans.synthetic_backup()
    folder = _first_file_batch(ops)["files"][0]["path"].rsplit("/", 1)[0]  # {udid}/Snapshot/<xx>
    ops.remove({"op": "CreateDirectory", "path": folder})
    run = run_backup(FakeIPhone(ops), out)

    assert isinstance(run.exception.__cause__, FileNotFoundError)
    assert run.error == device_backup._UNFINISHED_BACKUP


def test_encrypted_backup_after_a_failed_try(out):
    # OE-6: every backup try leaves an empty Manifest.plist until it finishes. Turning on
    # encryption makes the iPhone read it, and an empty one fails with MBErrorDomain/205.
    first = run_backup(FakeIPhone(drop_after_bytes=6 * MiB), out)
    assert first.error is not None
    assert (first.backup_dir / "Manifest.plist").stat().st_size == 0

    phone = FakeIPhone(will_encrypt=False)
    run = run_backup(phone, out, encrypted=True, password="correct horse")

    assert run.error is None, run.error
    assert phone.will_encrypt


@pytest.mark.xfail(strict=True, reason=(
    "pymobiledevice3 Mobilebackup2Service.backup(full=True) deletes the folder's Manifest.plist "
    "and rewrites Status.plist and Info.plist before the iPhone sends anything. A try that fails "
    "leaves the backup already in that folder without its Manifest.plist, which holds an encrypted "
    "backup's keys, so that backup can't be opened again (draft upstream issue in the PR that "
    "added this test)."))
def test_a_failed_try_keeps_the_last_backups_manifest(out):
    first = run_backup(FakeIPhone(), out)
    assert first.error is None
    manifest = (first.backup_dir / "Manifest.plist").read_bytes()
    failed = run_backup(FakeIPhone(drop_after_bytes=1 * MiB), out)
    assert failed.error is not None

    assert (first.backup_dir / "Manifest.plist").read_bytes() == manifest


def test_backup_lock_busy_once(out):
    # MBErrorDomain/208 right after the passcode: the engine waits and tries once more.
    phone = FakeIPhone(refuse_attempts={0: {"ErrorCode": 208, "ErrorDescription": "Device locked (MBErrorDomain/208)"}})
    run = run_backup(phone, out)

    assert run.error is None
    assert phone.attempts == 2
    run.assert_progress_never_goes_back()


def test_backup_lock_busy_twice(out):
    phone = FakeIPhone(refuse_attempts={n: {"ErrorCode": 208, "ErrorDescription": "Device locked (MBErrorDomain/208)"} for n in (0, 1)})
    run = run_backup(phone, out)
    assert run.error.startswith("PASSCODE_REQUIRED: Your iPhone was locked when the backup started.")


def test_iphone_is_locked(out):
    run = run_backup(FakeIPhone(locked=True), out)
    assert run.error.startswith("PASSCODE_REQUIRED: Your iPhone is locked.")


def test_another_app_holds_the_sync_lock_briefly(out):
    # Apple Devices, iTunes or Finder syncing: pymobiledevice3 retries the iPhone's sync lock.
    phone = FakeIPhone(sync_lock_busy=3)
    run = run_backup(phone, out)
    assert run.error is None


def test_another_app_holds_the_sync_lock(out, monkeypatch):
    _no_waiting_in_mobilebackup2(monkeypatch)
    run = run_backup(FakeIPhone(sync_lock_busy=10_000), out)
    assert run.error == device_backup._SYNC_IN_PROGRESS


def _no_waiting_in_mobilebackup2(monkeypatch):
    """pymobiledevice3 retries the sync lock 50 times, 0.2 s apart; skip the waits."""
    import asyncio
    from types import SimpleNamespace

    mobilebackup2 = module("pymobiledevice3.services.mobilebackup2")
    quick = SimpleNamespace(**{name: getattr(asyncio, name) for name in dir(asyncio) if not name.startswith("__")})

    async def sleep(_delay, result=None):
        return await asyncio.sleep(0, result)

    quick.sleep = sleep
    monkeypatch.setattr(mobilebackup2, "asyncio", quick)


# ── The passcode ─────────────────────────────────────────────────────────────

def test_long_wait_for_the_passcode(out):
    wait = 1.5
    plan = [{"op": "Notify", "name": plans.LOCAL_AUTH_PRESENTED}, {"op": "Sleep", "seconds": wait},
            {"op": "Notify", "name": plans.LOCAL_AUTH_DISMISSED}] + plans.synthetic_backup()
    run = run_backup(FakeIPhone(plan), out)

    assert run.error is None
    assert run.phases == ["negotiating", "waiting", "passcode", "backing_up", "finalizing"]
    asked = next(p["t"] for p in run.progress if p["phase"] == "passcode")
    copying = next(p["t"] for p in run.progress if p["phase"] == "backing_up")
    assert copying - asked >= wait * 0.9
    # Nothing to report while it waits: the bar stays at 0 and no bytes move.
    waiting = [p for p in run.progress if asked <= p["t"] < copying]
    assert all(p["percent"] == 0 and p["bytes_done"] == 0 for p in waiting)


def test_passcode_never_entered(out):
    # The iPhone asks for its passcode, nobody enters it, and it ends the backup.
    plan = [{"op": "Notify", "name": plans.LOCAL_AUTH_PRESENTED}, {"op": "Sleep", "seconds": 0.3}, {"op": "Drop"}]
    run = run_backup(FakeIPhone(plan), out)

    assert "passcode" in run.phases
    assert run.error.startswith("PASSCODE_REQUIRED:"), run.error


def test_unplugged_while_waiting_for_the_passcode(out):
    plan = [{"op": "Notify", "name": plans.LOCAL_AUTH_PRESENTED}, {"op": "Sleep", "seconds": 0.3}, {"op": "Unplug"}]
    run = run_backup(FakeIPhone(plan), out)
    assert run.error.startswith("DEVICE_DISCONNECTED:")


# ── Recorded traces ──────────────────────────────────────────────────────────

TRACES = HERE / "fake_iphone" / "traces"


@pytest.mark.parametrize("trace", sorted(TRACES.glob("*.jsonl")), ids=lambda p: p.stem)
def test_replay_trace(out, trace):
    ops = plans.load_trace(trace)
    phone = FakeIPhone(ops)
    run = run_backup(phone, out)

    assert run.error is None, run.error
    assert set(_expected_files(ops)) <= run.files()
    run.assert_progress_never_goes_back()


def test_recorder_captures_what_the_iphone_sent(out, tmp_path):
    from fake_iphone.recorder import record_devicelink

    phone = FakeIPhone()
    trace = tmp_path / "trace.jsonl"
    with record_devicelink(trace, udid=phone.udid, raw=True):
        run = run_backup(phone, out)
    assert run.error is None

    recorded = plans.load_trace(trace)
    assert [op["op"] for op in recorded] == [op["op"] for op in phone.plan]
    sent = [(f["path"], f["size"]) for f in plans.uploaded_files(phone.plan) if not f.get("generate")]
    got = [(f["path"], f["size"]) for f in plans.uploaded_files(recorded) if f["path"].rsplit("/", 1)[-1] not in plans.METADATA_FILES]
    assert got == sent

    # ... and replaying it backs up the same files.
    replay = run_backup(FakeIPhone(recorded), tmp_path / "replay")
    assert replay.error is None
    assert replay.files() == run.files()


def test_recorded_traces_are_scrubbed(out, tmp_path):
    # File IDs are unsalted SHA-1s of domain and path, and the iPhone's own file names name apps and
    # photos: a trace keeps neither, nor exact sizes, unless recorded with raw=True.
    from fake_iphone.recorder import record_devicelink

    phone = FakeIPhone()
    trace = tmp_path / "trace.jsonl"
    with record_devicelink(trace, udid=phone.udid):
        run = run_backup(phone, out)
    assert run.error is None

    text = trace.read_text(encoding="utf-8")
    sent = [f for f in plans.uploaded_files(phone.plan) if not f.get("generate")]
    assert not any(f["path"].rsplit("/", 1)[-1] in text or f["device_name"] in text for f in sent)
    assert phone.udid not in text
    recorded = [f for f in plans.uploaded_files(plans.load_trace(trace)) if f["path"].rsplit("/", 1)[-1] not in plans.METADATA_FILES]
    assert [f["path"].split("/")[-2] for f in recorded] == [f["path"].split("/")[-2] for f in sent]  # same <xx> folders
    assert all(f["device_name"].startswith("file-") for f in recorded)
    assert [f["size"] for f in recorded] == [int(float(f"{f['size']:.2g}")) if f["size"] >= 100 else f["size"] for f in sent]

    replay = run_backup(FakeIPhone(plans.load_trace(trace)), tmp_path / "replay")
    assert replay.error is None
    assert len(replay.files()) == len(run.files())
