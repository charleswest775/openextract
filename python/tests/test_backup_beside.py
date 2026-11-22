"""
Backing up into the folder that holds that iPhone's last backup (python/backup_beside.py).

Up to 0.18.0 such a try emptied the last backup's Manifest.plist before the iPhone had asked for
its passcode, so one that failed left an encrypted backup locked for good. Here the last backup
is really encrypted, and after every way a try can end, success included, it must be the same
files, untouched, and still unlock and read the same.
"""

import os
import re
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
from fake_iphone import FakeIPhone, InUse, failing_disk, run_backup  # noqa: E402
from fake_iphone import plan as plans  # noqa: E402
from fake_iphone.device import DEFAULT_UDID as UDID  # noqa: E402
from fake_iphone.harness import is_root  # noqa: E402
from fake_iphone.real_modules import real_pymobiledevice3  # noqa: E402
from fake_iphone.wire import Dropped  # noqa: E402
from killed_engine import STAGES  # noqa: E402

import backup  # noqa: E402
import backup_beside  # noqa: E402
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
    monkeypatch.setattr(backup_beside, "RENAME_WAIT_S", 0.2)
    monkeypatch.setattr(backup_beside, "_RENAME_RETRY_S", 0.05)


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
    """
    Every path under folder, the folder too, with which file it is, when it was last written and
    its bytes: equal means nothing was written, replaced, added, removed, or put back afterwards.
    """
    found = {}
    for p in [folder, *folder.rglob("*")]:
        st = p.stat()
        found[p.relative_to(folder).as_posix()] = (st.st_ino, st.st_mtime_ns, p.read_bytes() if p.is_file() else None)
    return found


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


def work(out: Path, n: int = 1) -> Path:
    return out / (backup_beside.WORK_DIR if n == 1 else f"{backup_beside.WORK_DIR}-{n}")


def new_backup(run) -> Path:
    assert run.error is None, run.error
    return Path(run.result["backup_path"])


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


def test_tries_that_stop_early_are_written_over_by_the_next(out, earlier, later):
    before = everything_in(earlier)
    for how in ("disconnected mid-transfer", "passcode not entered", "disconnected mid-transfer"):
        assert run_backup(FAILED_TRIES[how](), out).error is not None
        assert everything_in(earlier) == before
        assert sorted(p.name for p in out.iterdir()) == sorted([UDID, backup_beside.WORK_DIR])

    new = new_backup(run_backup(FakeIPhone(plan_sending(later), will_encrypt=True), out))
    assert sorted(p.name for p in out.iterdir()) == sorted([UDID, new.name])  # no work folder left
    assert everything_in(earlier) == before
    assert messages_in(new) == A_WEEK_LATER


@pytest.mark.parametrize("stopped_before", ["MoveItems", "RemoveItems"])
def test_a_try_that_got_every_file_is_not_written_over(out, earlier, later, stopped_before):
    # Everything arrived, keys and list of files too. On a dying iPhone that's the newest copy.
    ops = plan_sending(later)
    ops.insert(next(i for i, op in enumerate(ops) if op["op"] == stopped_before), DROP)
    assert run_backup(FakeIPhone(ops, will_encrypt=True), out).error is not None
    stopped = everything_in(work(out) / UDID)

    assert run_backup(FAILED_TRIES["passcode not entered"](), out).error is not None
    assert everything_in(work(out) / UDID) == stopped
    assert (work(out, 2) / UDID).is_dir()
    if stopped_before == "RemoveItems":  # every file had been moved into place
        assert messages_in(work(out) / UDID) == A_WEEK_LATER


def test_a_first_backup_is_still_written_straight_into_the_folder(out):
    failed = run_backup(FakeIPhone(drop_after_bytes=4 * plans.MiB), out)
    assert failed.error is not None and UNCHANGED not in failed.error
    assert not work(out).exists()
    run = run_backup(FakeIPhone(), out)
    assert run.error is None and "earlier_backup" not in run.result
    assert [p.name for p in out.iterdir()] == [UDID]


def test_a_first_backup_that_got_every_file_is_not_written_over(out, later):
    ops = plan_sending(later)
    ops.insert(next(i for i, op in enumerate(ops) if op["op"] == "RemoveItems"), DROP)
    first = run_backup(FakeIPhone(ops, will_encrypt=True), out)
    assert first.error is not None
    stopped = everything_in(first.backup_dir)

    retry = run_backup(FAILED_TRIES["passcode not entered"](), out)
    assert UNCHANGED in retry.error
    assert everything_in(first.backup_dir) == stopped
    assert messages_in(first.backup_dir) == A_WEEK_LATER


def test_a_folder_the_iphone_cant_go_on_with_doesnt_point_at_the_old_backup(out, earlier):
    # _UNFINISHED_BACKUP's known fix says the unfinished backup in that folder can be deleted.
    ops = small_backup()
    folder = next(f for f in plans.uploaded_files(ops) if f.get("relative_path"))["path"].rsplit("/", 1)[0]
    ops.remove({"op": "CreateDirectory", "path": folder})
    run = run_backup(FakeIPhone(ops, will_encrypt=True), out)
    assert run.error == f"{device_backup._NEW_CANT_CONTINUE} {UNCHANGED}"


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


@pytest.mark.parametrize("stage", STAGES)
def test_killed_at_any_stage_has_changed_nothing(out, earlier, stage):
    before = everything_in(earlier)
    kill_the_engine_at(out, stage)

    # As a kill leaves it, before anything has had a chance to put things right.
    assert everything_in(earlier) == before
    # The next launch.
    found = [b["backup_dir"] for b in listed(out)]
    assert str(earlier) in found
    assert messages_in(earlier) == THE_ONLY_COPY
    if stage in ("before the rename", "after the rename"):  # the new one had finished: offered too, first
        assert len(found) == 2 and found[0] != str(earlier)
    # And the next try.
    assert UNCHANGED in run_backup(FAILED_TRIES["passcode not entered"](), out).error
    assert everything_in(earlier) == before


# ── A backup that works ──────────────────────────────────────────────────────

def test_a_successful_backup_gets_its_own_folder_and_the_earlier_one_stays(out, earlier, later):
    before = everything_in(earlier)
    run = run_backup(FakeIPhone(plan_sending(later), will_encrypt=True), out)

    new = new_backup(run)
    assert new.parent == out and re.fullmatch(rf"{UDID}-\d{{8}}-\d{{6}}", new.name)
    assert run.result == {"success": True, "backup_path": str(new), "existing_password": True,
                          "earlier_backup": str(earlier)}
    assert everything_in(earlier) == before
    assert messages_in(earlier) == THE_ONLY_COPY
    assert messages_in(new) == A_WEEK_LATER
    assert backup_status.check(str(new)).confirmed
    assert not work(out).exists()
    run.assert_progress_never_goes_back()


def test_the_newest_backup_is_listed_and_opened_first(out, earlier):
    # pymobiledevice3's Info.plist has no date, so the one just made used to sort last.
    new = new_backup(run_backup(FakeIPhone(small_backup()), out))

    found = listed(out)
    assert [b["backup_dir"] for b in found] == [str(new), str(earlier)]
    assert found[0]["last_backup"] > found[1]["last_backup"]
    manager = backup.BackupManager()
    opened = manager.open_backup(UDID, backup_dir=str(out))  # given the folder they're both in
    manager.close_backup(UDID)
    assert opened["info"]["backup_dir"] == str(new)


def test_backing_up_again_and_again_keeps_each_one(out, earlier, later):
    before = everything_in(earlier)
    second = new_backup(run_backup(FakeIPhone(plan_sending(later), will_encrypt=True), out))
    second_before = everything_in(second)
    third = new_backup(run_backup(FakeIPhone(plan_sending(later), will_encrypt=True), out))

    assert third != second  # even in the same second
    assert everything_in(earlier) == before and everything_in(second) == second_before
    assert len(listed(out)) == 3


def test_the_lock_error_retry_still_works(out, earlier, later):
    before = everything_in(earlier)
    phone = FakeIPhone(plan_sending(later), will_encrypt=True,
                       refuse_attempts={0: {"ErrorCode": 208, "ErrorDescription": "Device locked (MBErrorDomain/208)"}})
    assert messages_in(new_backup(run_backup(phone, out))) == A_WEEK_LATER
    assert phone.attempts == 2
    assert everything_in(earlier) == before


def test_hanging_up_at_the_end_is_still_a_success(out, earlier, later):
    before = everything_in(earlier)
    run = run_backup(FakeIPhone(plan_sending(later)[:-1] + [DROP], will_encrypt=True), out)

    assert messages_in(new_backup(run)) == A_WEEK_LATER
    assert everything_in(earlier) == before


def test_success_without_a_whole_backup_is_an_error(out, earlier):
    before = everything_in(earlier)
    run = run_backup(FakeIPhone([{"op": "ProcessMessage", "content": {"ErrorCode": 0}}], will_encrypt=True), out)

    assert run.error == f"{backup_beside.NOT_WHOLE} {UNCHANGED}"
    assert everything_in(earlier) == before


@pytest.mark.parametrize("broken", ["Manifest.plist", "Manifest.db"])
def test_a_new_backup_that_cant_be_read_costs_nothing(out, earlier, later, broken):
    # Nothing here can tell that a new encrypted backup will unlock, so nothing may depend on it.
    before = everything_in(earlier)
    (later / broken).write_bytes(b"garbage the iPhone called a success")
    run_backup(FakeIPhone(plan_sending(later), will_encrypt=True), out)

    assert everything_in(earlier) == before
    assert messages_in(earlier) == THE_ONLY_COPY


def test_what_another_program_writes_to_the_earlier_backup_meanwhile_stays(out, earlier, later):
    # Finder, iTunes or another computer, during a try that takes hours.
    phone = FakeIPhone(plan_sending(later), will_encrypt=True)
    phone.before("MoveItems", lambda _op: (earlier / "written meanwhile").write_bytes(b"keep"))
    new_backup(run_backup(phone, out))
    assert (earlier / "written meanwhile").read_bytes() == b"keep"
    assert messages_in(earlier) == THE_ONLY_COPY


@pytest.mark.parametrize("odd", ["it never finished", "its keys were lost", "its keys are damaged",
                                 "only its stored files are left", "only its keys are left"])
def test_whats_left_of_a_backup_is_left_alone_too(out, earlier, later, odd):
    if odd == "it never finished":
        (earlier / "Snapshot" / "ab").mkdir(parents=True)
    elif odd == "its keys were lost":
        (earlier / "Manifest.plist").write_bytes(b"")
    elif odd == "its keys are damaged":
        (earlier / "Manifest.plist").write_bytes(b"not a plist")
    elif odd == "only its stored files are left":
        (earlier / "Manifest.plist").unlink()
        (earlier / "Manifest.db").unlink()
    else:
        for stored in [earlier / "Manifest.db", *earlier.glob("??/*")]:
            stored.unlink()
    before = everything_in(earlier)
    run = run_backup(FakeIPhone(plan_sending(later), will_encrypt=True), out)

    assert messages_in(new_backup(run)) == A_WEEK_LATER
    assert run.result["earlier_backup"] == str(earlier)
    assert everything_in(earlier) == before


def test_the_earlier_backup_open_in_another_program(out, earlier, later):
    # It isn't moved, so it doesn't matter who has it open, the app included.
    manager = backup.BackupManager()
    manager.open_backup(UDID, password=PASSWORD, backup_dir=str(earlier))
    try:
        before = everything_in(earlier)
        assert messages_in(new_backup(run_backup(FakeIPhone(plan_sending(later), will_encrypt=True), out))) == A_WEEK_LATER
        assert everything_in(earlier) == before
        assert Path(manager.get_open_backup(UDID).get_file(SMS[1], SMS[0])).read_bytes() == THE_ONLY_COPY
    finally:
        manager.close_backup(UDID)


def test_a_new_backup_in_use_stays_where_it_is_and_is_never_reused(out, earlier, later):
    # The real thing: Windows won't rename a folder with a file open in it. Elsewhere the folder
    # it's in is made read-only, which stops the rename the same way.
    if is_root():
        pytest.skip("root can write to a read-only folder")
    phone = FakeIPhone(plan_sending(later), will_encrypt=True)
    other_program = InUse()
    phone.before("ProcessMessage", lambda _op: other_program.lock(work(out) / UDID / "Manifest.db"
                                                                  if sys.platform == "win32" else work(out) / UDID))
    try:
        run = run_backup(phone, out)
    finally:
        other_program.release()
    new = new_backup(run)
    assert new == work(out) / UDID
    assert messages_in(new) == A_WEEK_LATER
    assert {b["backup_dir"] for b in listed(out)} == {str(earlier), str(new)}

    # The app saved that path, so the next try mustn't write there or move it.
    before = everything_in(new)
    assert run_backup(FAILED_TRIES["passcode not entered"](), out).error is not None
    assert everything_in(new) == before


# ── Odd folders ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("udid", ["..", ".", "", "../elsewhere", "a/b", "a\\b", "C:"])
def test_a_name_from_the_device_cant_point_outside_the_folder(out, udid):
    with pytest.raises(RuntimeError):
        backup_beside.Destination(str(out)).prepare(udid)
    assert not out.exists()


def _link_folder(link: Path, to: Path) -> None:
    if sys.platform == "win32":
        import _winapi

        _winapi.CreateJunction(str(to), str(link))  # needs no special rights, unlike a symlink
    else:
        link.symlink_to(to, target_is_directory=True)


def test_a_backup_folder_thats_a_link_to_another_place(out, tmp_path, later):
    real = make_encrypted_backup(tmp_path / "other drive", UDID, text=THE_ONLY_COPY)
    out.mkdir()
    _link_folder(out / UDID, real)
    before = everything_in(real)

    assert run_backup(FAILED_TRIES["passcode not entered"](), out).error is not None
    assert everything_in(real) == before
    assert messages_in(new_backup(run_backup(FakeIPhone(plan_sending(later), will_encrypt=True), out))) == A_WEEK_LATER
    assert everything_in(real) == before


def test_a_backup_folder_on_a_drive_that_isnt_plugged_in(out, tmp_path):
    out.mkdir()
    away = tmp_path / "unplugged drive"
    away.mkdir()
    _link_folder(out / UDID, away)
    away.rmdir()
    assert backup_beside.holds_a_backup(str(out / UDID))


def test_a_folder_that_cant_be_read_counts_as_a_backup(out, earlier, monkeypatch):
    def refuse(_path):
        raise PermissionError(13, "Access is denied")

    monkeypatch.setattr(backup_beside.os, "scandir", refuse)
    assert backup_beside.holds_a_backup(str(earlier))


def test_choosing_the_old_backups_own_folder_reports_the_new_one(out, earlier, later):
    # It used to say "Backup complete" and open the old one. Someone could erase the iPhone on that.
    run = run_backup(FakeIPhone(plan_sending(later), will_encrypt=True), earlier)

    assert new_backup(run) == earlier / UDID
    assert messages_in(earlier / UDID) == A_WEEK_LATER
    assert messages_in(earlier) == THE_ONLY_COPY


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
