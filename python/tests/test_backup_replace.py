"""
Backing up into the folder that holds that iPhone's last backup (python/backup_replace.py).

Up to 0.18.0 such a try emptied the last backup's Manifest.plist before the iPhone had asked for
its passcode, so one that failed left an encrypted backup locked for good. Here the last backup
is really encrypted, and after each way a try can end it must still unlock and read the same.
"""

import os
import shutil
import signal
import subprocess
import sys
import threading
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
for _path in (HERE, HERE.parent, HERE.parent.parent):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from encrypted_backup import PASSWORD, SMS, make_encrypted_backup, plan_sending  # noqa: E402
from fake_iphone import FakeIPhone, failing_disk, run_backup  # noqa: E402
from fake_iphone import plan as plans  # noqa: E402
from fake_iphone.device import DEFAULT_UDID as UDID  # noqa: E402
from fake_iphone.real_modules import real_pymobiledevice3  # noqa: E402
from fake_iphone.wire import Dropped  # noqa: E402
from killed_engine import STAGES  # noqa: E402

import backup  # noqa: E402
import backup_replace  # noqa: E402
import backup_status  # noqa: E402
import device_backup  # noqa: E402

pytestmark = pytest.mark.fake_iphone

THE_ONLY_COPY = b"messages from someone who is gone"
A_WEEK_LATER = b"messages a week later"
UNCHANGED = device_backup.EARLIER_UNCHANGED


@pytest.fixture(autouse=True)
def quick_engine(monkeypatch):
    monkeypatch.setattr(device_backup, "_BYTES_REPORT_INTERVAL_S", 0.05)
    monkeypatch.setattr(device_backup, "_BACKUP_LOCK_RETRY_DELAY_S", 0.05)
    monkeypatch.setattr(backup_replace, "RENAME_WAIT_S", 0.2)
    monkeypatch.setattr(backup_replace, "_RENAME_RETRY_S", 0.05)


@pytest.fixture
def out(tmp_path):
    return tmp_path / "Backups"


@pytest.fixture
def earlier(out):
    return make_encrypted_backup(out, UDID, text=THE_ONLY_COPY)


@pytest.fixture
def later(tmp_path):
    return make_encrypted_backup(tmp_path / "on the iPhone", UDID, seed=2, text=A_WEEK_LATER)


def everything_in(folder: Path) -> dict:
    """Every path under folder with its bytes: nothing added, removed or changed."""
    return {p.relative_to(folder).as_posix(): (p.read_bytes() if p.is_file() else None)
            for p in folder.rglob("*")}


def messages_in(folder: Path) -> bytes:
    """sms.db, read the way the app does: found, unlocked with the password, decrypted."""
    manager = backup.BackupManager()
    opened = manager.open_backup(UDID, password=PASSWORD, backup_dir=str(folder))
    assert opened["status"] == "open" and opened["info"]["encrypted"] is True
    try:
        found = manager.get_open_backup(UDID).get_file(SMS[1], SMS[0])
        assert found, "sms.db couldn't be read"
        return Path(found).read_bytes()
    finally:
        manager.close_backup(UDID)


def listed(out: Path) -> list:
    return backup.BackupManager().list_backups(custom_path=str(out))["backups"]


def work(out: Path) -> Path:
    return out / backup_replace.WORK_DIR


def small_backup() -> list:
    return plans.synthetic_backup(file_count=20, large_files=())


def before_first(op_name: str, *extra: dict) -> list:
    ops = small_backup()
    i = next(i for i, op in enumerate(ops) if op["op"] == op_name)
    return ops[:i] + list(extra)


ASKS = {"op": "Notify", "name": plans.LOCAL_AUTH_PRESENTED}
WAITS = {"op": "Sleep", "seconds": 0.3}
DROP, UNPLUG = {"op": "Drop"}, {"op": "Unplug"}


# ── Tries that fail ──────────────────────────────────────────────────────────

FAILED_TRIES = {
    "passcode not entered": lambda: FakeIPhone([ASKS, WAITS, DROP], will_encrypt=True),
    "passcode refused": lambda: FakeIPhone(will_encrypt=True, refuse_attempts={
        0: {"ErrorCode": 207, "ErrorDescription": "User canceled authentication (MBErrorDomain/207)"}}),
    "unplugged at the passcode": lambda: FakeIPhone([ASKS, WAITS, UNPLUG], will_encrypt=True),
    "disconnected mid-transfer": lambda: FakeIPhone(will_encrypt=True, drop_after_bytes=4 * plans.MiB),
    "unplugged mid-transfer": lambda: FakeIPhone(will_encrypt=True, drop_after_bytes=4 * plans.MiB,
                                                 unplug_on_drop=True),
    "everything drops mid-transfer": lambda: FakeIPhone(will_encrypt=True, drop_after_bytes=4 * plans.MiB,
                                                        drop_everything=True),
    "disconnected with every file sent": lambda: FakeIPhone(before_first("MoveItems", DROP), will_encrypt=True),
    "disconnected after the moves": lambda: FakeIPhone(before_first("RemoveItems", DROP), will_encrypt=True),
    "the iPhone's own error at the very end": lambda: FakeIPhone(small_backup()[:-1] + [
        {"op": "ProcessMessage", "content": {"ErrorCode": 104, "ErrorDescription": "MBErrorDomain/104"}}],
        will_encrypt=True),
    "locked both times": lambda: FakeIPhone(will_encrypt=True, refuse_attempts={
        n: {"ErrorCode": 208, "ErrorDescription": "Device locked (MBErrorDomain/208)"} for n in (0, 1)}),
    "locked before it starts": lambda: FakeIPhone(will_encrypt=True, locked=True),
    "no room": lambda: FakeIPhone([{"op": "GetFreeDiskSpace", "needs_more_than_reported": 10**9}],
                                  will_encrypt=True),
}


@pytest.mark.parametrize("how", FAILED_TRIES)
def test_a_failed_try_leaves_the_earlier_backup_exactly_as_it_was(out, earlier, how):
    before = everything_in(earlier)
    run = run_backup(FAILED_TRIES[how](), out)

    assert run.error is not None
    assert everything_in(earlier) == before
    assert messages_in(earlier) == THE_ONLY_COPY
    assert UNCHANGED in run.error, run.error
    info = next(b for b in listed(out) if b["backup_dir"] == str(earlier))
    assert info["encrypted"] and info["openable"] and not info["unfinished"]


def test_the_passcode_error_is_still_a_step_and_says_the_backup_is_safe(out, earlier):
    run = run_backup(FakeIPhone([ASKS, WAITS, DROP], will_encrypt=True), out)
    assert run.error.startswith("PASSCODE_REQUIRED: ")
    assert run.error.endswith(f"click Retry. {UNCHANGED}")
    assert listed(out)[0]["backup_dir"] == str(earlier) and len(listed(out)) == 1


def test_a_full_drive_says_the_earlier_backup_needs_room_too(out, earlier):
    run = run_backup(FAILED_TRIES["no room"](), out)
    assert run.error.startswith("Not enough free space for this backup.")
    assert run.error.endswith(f"{UNCHANGED} {device_backup._ROOM_FOR_BOTH}")


def test_the_drive_fills_up_while_writing(out, earlier, monkeypatch):
    before = everything_in(earlier)
    phone = FakeIPhone(will_encrypt=True)
    with real_pymobiledevice3():  # so the real DeviceLink is the one patched
        failing_disk(monkeypatch, after_bytes=2 * plans.MiB)
    run = run_backup(phone, out)
    assert run.error.startswith("Not enough free space for this backup.") and UNCHANGED in run.error
    assert everything_in(earlier) == before


def test_passcode_refused_while_turning_encryption_on(out, earlier):
    # The iPhone's password was reset and the user sets a new one. The iPhone is given that
    # folder's Manifest.plist for this, and can rewrite it: it mustn't be the earlier backup's.
    before = everything_in(earlier)
    phone = FakeIPhone(will_encrypt=False)

    def refused(_request):
        raise Dropped("the passcode wasn't entered")

    phone.before("ChangePassword", refused)
    run = run_backup(phone, out, encrypted=True, password="a new password")

    assert run.error.startswith("PASSCODE_REQUIRED: ") and UNCHANGED in run.error
    assert everything_in(earlier) == before


def test_turning_encryption_on_never_shows_the_iphone_the_earlier_keys(out, earlier, monkeypatch):
    from fake_iphone import services

    shown = []
    download = services.MobileBackup2.op_DownloadFiles

    def watching(self, op):
        received = download(self, op)
        shown.extend(v for k, v in received.items() if k.endswith("Manifest.plist"))
        return received

    keys = (earlier / "Manifest.plist").read_bytes()
    monkeypatch.setattr(services.MobileBackup2, "op_DownloadFiles", watching)
    run_backup(FakeIPhone(before_first("MoveItems", DROP)), out, encrypted=True, password="a new password")

    assert shown and keys not in shown
    assert (earlier / "Manifest.plist").read_bytes() == keys


def test_tries_one_after_another_leave_one_partial_at_most(out, earlier, later):
    before = everything_in(earlier)
    for how in ("disconnected mid-transfer", "passcode not entered", "disconnected mid-transfer"):
        assert run_backup(FAILED_TRIES[how](), out).error is not None
        assert everything_in(earlier) == before
        assert sorted(p.name for p in out.iterdir()) == sorted([UDID, backup_replace.WORK_DIR])

    run = run_backup(FakeIPhone(plan_sending(later), will_encrypt=True), out)
    assert run.error is None, run.error
    assert [p.name for p in out.iterdir()] == [UDID]
    assert messages_in(earlier) == A_WEEK_LATER


def test_a_first_backup_is_still_written_straight_into_the_folder(out):
    failed = run_backup(FakeIPhone(drop_after_bytes=4 * plans.MiB), out)
    assert failed.error is not None and UNCHANGED not in failed.error
    assert not work(out).exists()
    assert run_backup(FakeIPhone(), out).error is None
    assert [p.name for p in out.iterdir()] == [UDID]


# ── The engine is killed, or the power goes ──────────────────────────────────

def kill_the_engine_at(out: Path, stage: str) -> None:
    child = subprocess.Popen([sys.executable, str(HERE / "killed_engine.py"), str(out), stage, UDID],
                             stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)
    watchdog = threading.Timer(90, child.kill)
    watchdog.start()
    try:
        said = []
        for line in child.stdout:
            said.append(line)
            if line.startswith("READY "):
                os.kill(int(line.split()[1]), getattr(signal, "SIGKILL", signal.SIGTERM))
                break
        else:
            pytest.fail(f"the engine never got to {stage!r}: {said}")
        child.wait(30)
    finally:
        watchdog.cancel()
        child.kill()
        child.stdout.close()


@pytest.mark.parametrize("stage", ["passcode", "transfer", "moving", "finishing", "before the swap"])
def test_killed_before_the_swap_has_changed_nothing(out, earlier, stage):
    assert stage in STAGES
    before = everything_in(earlier)
    kill_the_engine_at(out, stage)

    # As a kill leaves it, before anything has had a chance to put things right.
    assert everything_in(earlier) == before
    # The next launch.
    assert str(earlier) in [b["backup_dir"] for b in listed(out)]
    assert messages_in(earlier) == THE_ONLY_COPY


@pytest.mark.parametrize("next_launch", ["lists the folder", "opens the recent backup", "browses to the backup"])
def test_killed_between_the_renames_puts_the_earlier_backup_back(out, earlier, next_launch):
    before = everything_in(earlier)
    kill_the_engine_at(out, "between the renames")
    assert not earlier.exists()

    if next_launch == "lists the folder":
        found = listed(out)
        # The finished new one couldn't be moved into place, and is offered too.
        assert {Path(b["backup_dir"]).resolve() for b in found} == {earlier.resolve(), (work(out) / UDID).resolve()}
    elif next_launch == "browses to the backup":
        assert [b["backup_dir"] for b in listed(earlier)] == [str(earlier)]
    assert messages_in(earlier) == THE_ONLY_COPY
    assert everything_in(earlier) == before


def test_killed_between_the_renames_then_backing_up_again_keeps_every_backup(out, earlier):
    before = everything_in(earlier)
    kill_the_engine_at(out, "between the renames")

    # Straight into another try, which fails: the next launch never listed the folder.
    run = run_backup(FAILED_TRIES["passcode not entered"](), out)
    assert UNCHANGED in run.error
    assert everything_in(earlier) == before
    assert backup_status.check(str(out / f"{UDID} (new backup)")).finished


def test_killed_after_the_swap_keeps_both_until_told_otherwise(out, earlier, later):
    before = everything_in(earlier)
    kill_the_engine_at(out, "after the swap")

    assert backup_status.check(str(earlier)).confirmed  # the new one
    assert len(listed(out)) == 2
    assert run_backup(FakeIPhone(plan_sending(later), will_encrypt=True), out).error is None
    kept = out / f"{UDID} (earlier backup)"
    assert everything_in(kept) == before
    assert messages_in(kept) == THE_ONLY_COPY


def test_killed_while_deleting_what_was_replaced(out, earlier, later):
    kill_the_engine_at(out, "deleting")

    assert backup_status.check(str(earlier)).confirmed
    assert [b["backup_dir"] for b in listed(out)] == [str(earlier)]  # not the half-deleted one
    assert run_backup(FakeIPhone(plan_sending(later), will_encrypt=True), out).error is None
    assert [p.name for p in out.iterdir()] == [UDID]


# ── A backup that works ──────────────────────────────────────────────────────

def test_a_successful_backup_replaces_the_earlier_one(out, earlier, later):
    before = everything_in(earlier)
    phone = FakeIPhone(plan_sending(later), will_encrypt=True)
    at_the_end = {}
    phone.before("ProcessMessage", lambda _op: at_the_end.update(everything_in(earlier)))
    run = run_backup(phone, out)

    assert run.error is None, run.error
    assert at_the_end == before  # untouched, keys and all, until the iPhone said it had finished
    assert run.result == {"success": True, "backup_path": str(earlier), "existing_password": True}
    assert messages_in(earlier) == A_WEEK_LATER
    assert backup_status.check(str(earlier)).confirmed
    assert [p.name for p in out.iterdir()] == [UDID]  # no second copy, no work folder
    run.assert_progress_never_goes_back()


def test_the_lock_error_retry_still_replaces(out, earlier, later):
    phone = FakeIPhone(plan_sending(later), will_encrypt=True,
                       refuse_attempts={0: {"ErrorCode": 208, "ErrorDescription": "Device locked (MBErrorDomain/208)"}})
    assert run_backup(phone, out).error is None
    assert phone.attempts == 2
    assert messages_in(earlier) == A_WEEK_LATER


def test_hanging_up_at_the_end_is_success_but_keeps_the_earlier_one(out, earlier, later):
    # Only inferred to have finished, so nothing is deleted on the strength of it.
    before = everything_in(earlier)
    run = run_backup(FakeIPhone(plan_sending(later)[:-1] + [DROP], will_encrypt=True), out)

    assert run.error is None, run.error
    kept = Path(run.result["earlier_backup"])
    assert everything_in(kept) == before and messages_in(kept) == THE_ONLY_COPY
    assert messages_in(Path(run.result["backup_path"])) == A_WEEK_LATER


def test_success_without_a_whole_backup_doesnt_replace_anything(out, earlier):
    before = everything_in(earlier)
    run = run_backup(FakeIPhone([{"op": "ProcessMessage", "content": {"ErrorCode": 0}}], will_encrypt=True), out)

    assert run.error is None
    assert run.result["earlier_backup"] == str(earlier)
    assert everything_in(earlier) == before


@pytest.mark.parametrize("odd", ["a file of the user's", "a file of the user's, inside", "a folder of the user's",
                                 "it never finished", "its keys were lost", "its keys are damaged"])
def test_an_earlier_backup_thats_more_or_less_than_a_backup_is_kept(out, earlier, later, odd):
    if odd == "a file of the user's":
        (earlier / "Read me - Mum's phone.txt").write_text("keep", encoding="utf-8")
    elif odd == "a file of the user's, inside":
        (next(earlier.glob("??")) / "notes.txt").write_text("keep", encoding="utf-8")
    elif odd == "a folder of the user's":
        (earlier / "saved photos").mkdir()
    elif odd == "it never finished":
        (earlier / "Snapshot" / "ab").mkdir(parents=True)
    elif odd == "its keys were lost":
        (earlier / "Manifest.plist").write_bytes(b"")
    else:
        (earlier / "Manifest.plist").write_bytes(b"not a plist")
    before = everything_in(earlier)
    run = run_backup(FakeIPhone(plan_sending(later), will_encrypt=True), out)

    assert run.error is None, run.error
    kept = out / f"{UDID} (earlier backup)"
    assert Path(run.result["earlier_backup"]).resolve() == kept.resolve()
    assert everything_in(kept) == before
    assert messages_in(earlier) == A_WEEK_LATER


def test_a_second_kept_backup_gets_its_own_name(out, earlier, later):
    (out / f"{UDID} (earlier backup)").mkdir()
    (earlier / "mine.txt").write_text("keep", encoding="utf-8")
    run = run_backup(FakeIPhone(plan_sending(later), will_encrypt=True), out)
    assert Path(run.result["earlier_backup"]).name == f"{UDID} (earlier backup 2)"


@pytest.mark.parametrize("stuck", [1, 2], ids=["the earlier one is in use", "the new one is in use"])
def test_a_rename_that_wont_work_keeps_both(out, earlier, later, monkeypatch, stuck):
    before = everything_in(earlier)
    rename = backup_replace._rename
    calls = [0]

    def wont(src, dst, *args, **kwargs):
        calls[0] += 1
        return False if calls[0] == stuck else rename(src, dst, *args, **kwargs)

    monkeypatch.setattr(backup_replace, "_rename", wont)
    run = run_backup(FakeIPhone(plan_sending(later), will_encrypt=True), out)

    assert run.error is None
    assert everything_in(earlier) == before
    assert run.result["earlier_backup"] == str(earlier)
    assert messages_in(Path(run.result["backup_path"])) == A_WEEK_LATER


def test_a_new_backup_that_cant_move_at_all_is_still_found(out, earlier, later, monkeypatch):
    monkeypatch.setattr(backup_replace, "_rename", lambda *a, **k: False)
    run = run_backup(FakeIPhone(plan_sending(later), will_encrypt=True), out)

    assert run.error is None
    assert Path(run.result["backup_path"]).resolve() == (work(out) / UDID).resolve()
    assert len(listed(out)) == 2
    assert messages_in(work(out) / UDID) == A_WEEK_LATER


def test_not_flushed_means_not_deleted(out, earlier, later, monkeypatch):
    before = everything_in(earlier)
    monkeypatch.setattr(backup_replace, "_flush", lambda *a, **k: False)
    run = run_backup(FakeIPhone(plan_sending(later), will_encrypt=True), out)
    assert everything_in(Path(run.result["earlier_backup"])) == before


def test_the_backup_open_in_the_app_is_closed_before_its_replaced(out, earlier, later):
    # It would go on using the old keys on the new files, and on Windows stop the rename.
    manager = backup.BackupManager()
    manager.open_backup(UDID, password=PASSWORD, backup_dir=str(earlier))
    phone = FakeIPhone(plan_sending(later), will_encrypt=True)
    with phone.plugged_in():
        result = device_backup.DeviceBackupManager().start_backup(
            UDID, str(out), False, None, lambda *a, **k: None, release=manager.close_backups_in)

    assert "earlier_backup" not in result
    with pytest.raises(ValueError, match="Backup not open"):
        manager.get_open_backup(UDID)


# ── Never outside the backup ─────────────────────────────────────────────────

@pytest.mark.parametrize("udid", ["..", ".", "", "../elsewhere", "a/b", "a\\b", "C:"])
def test_a_name_from_the_device_cant_point_outside_the_folder(out, udid):
    destination = backup_replace.Destination(str(out))
    with pytest.raises(RuntimeError):
        destination.prepare(udid)
    assert not out.exists()


def _link_folder(link: Path, to: Path) -> None:
    if sys.platform == "win32":
        import _winapi

        _winapi.CreateJunction(str(to), str(link))  # needs no special rights, unlike a symlink
    else:
        link.symlink_to(to, target_is_directory=True)


@pytest.mark.parametrize("where", ["ab", "Snapshot"])
def test_deleting_never_follows_a_link(tmp_path, where):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / ("ab" + "0" * 38)).write_bytes(b"someone's file")
    folder = tmp_path / "backup"
    folder.mkdir()
    _link_folder(folder / where, elsewhere)

    assert backup_replace._remove_backup(str(folder)) is False
    assert (elsewhere / ("ab" + "0" * 38)).read_bytes() == b"someone's file"


def test_a_backup_folder_thats_a_link_to_another_place(out, tmp_path, later):
    real = make_encrypted_backup(tmp_path / "other drive", UDID, text=THE_ONLY_COPY)
    out.mkdir()
    _link_folder(out / UDID, real)
    before = everything_in(real)

    assert run_backup(FAILED_TRIES["passcode not entered"](), out).error is not None
    assert everything_in(real) == before
    assert run_backup(FakeIPhone(plan_sending(later), will_encrypt=True), out).error is None
    assert messages_in(out / UDID) == A_WEEK_LATER
    assert messages_in(real) == A_WEEK_LATER


def test_two_windows_cant_back_up_into_the_same_folder(out, earlier):
    first = backup_replace.Destination(str(out))
    first.prepare(UDID)
    try:
        with pytest.raises(RuntimeError, match="Another OpenExtract window"):
            backup_replace.Destination(str(out)).prepare(UDID)
        assert (work(out) / UDID).is_dir()
    finally:
        first.close()
    again = backup_replace.Destination(str(out))
    again.prepare(UDID)
    again.close()
    assert not work(out).exists()


def test_recovering_doesnt_get_between_another_engines_renames(out, earlier):
    swapping = backup_replace.Destination(str(out))
    swapping.prepare(UDID)
    try:
        aside = work(out) / f"{UDID}.previous"
        os.rename(earlier, aside)
        backup_replace.recover(str(out))
        assert aside.is_dir() and not earlier.exists()
    finally:
        swapping.close()
    backup_replace.recover(str(out))
    assert earlier.is_dir()


# ── A folder an older OpenExtract already damaged ────────────────────────────

@pytest.mark.parametrize("keys", ["emptied", "emptied, then removed"])
def test_a_backup_0_18_locked_says_so_and_unlocks_when_its_keys_are_put_back(out, earlier, tmp_path, keys):
    # A copy from Time Machine or File History is the only way back.
    from_time_machine = tmp_path / "Manifest.plist"
    shutil.copyfile(earlier / "Manifest.plist", from_time_machine)
    week_ago = (earlier / "Manifest.db").stat().st_mtime - 7 * 24 * 3600
    os.utime(earlier / "Manifest.db", (week_ago, week_ago))
    backup_status.BackupTry(str(earlier)).start()
    (earlier / "Manifest.plist").write_bytes(b"")
    if keys == "emptied, then removed":
        (earlier / "Manifest.plist").unlink()

    info = listed(out)[0]
    assert info["unfinished"] and info["encrypted"] and not info["openable"]
    with pytest.raises(RuntimeError) as raised:
        messages_in(earlier)
    assert str(raised.value) == backup_status.CANT_UNLOCK

    shutil.copyfile(from_time_machine, earlier / "Manifest.plist")
    assert messages_in(earlier) == THE_ONLY_COPY
