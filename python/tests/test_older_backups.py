"""
Which older backups may go to the Trash (python/older_backups.py, python/trash_room.py).

These folders can be the only copy of someone's messages and photos, so most of this is what
must be refused. The engine itself never moves or deletes: every test that asks also finds
everything exactly as it was.
"""

import os
import shutil
import sys
import types
from datetime import timedelta
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
for _path in (HERE, HERE.parent, HERE.parent.parent):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from encrypted_backup import MADE, PASSWORD, make_encrypted_backup  # noqa: E402
from fake_iphone import FakeIPhone, run_backup  # noqa: E402
from fake_iphone import plan as plans  # noqa: E402
from fake_iphone.device import DEFAULT_UDID as UDID  # noqa: E402

import backup  # noqa: E402
import backup_beside  # noqa: E402
import backup_status  # noqa: E402
import older_backups  # noqa: E402
import trash_room  # noqa: E402

REAL_PROBLEM = trash_room.problem
MIB = 1024 * 1024
OTHER_IPHONE = "00008030-000A1B2C3D4E5F60"
LATER = MADE + timedelta(days=40)


@pytest.fixture(autouse=True)
def roomy_trash(monkeypatch):
    monkeypatch.setattr(trash_room, "problem", lambda *_: None)


@pytest.fixture
def out(tmp_path):
    return tmp_path.resolve() / "Backups"


def make(tmp_path, dest, when, *, udid=UDID, by_openextract=False, seed=1):
    made = make_encrypted_backup(tmp_path / f"made-{dest.name}-{seed}", udid, seed=seed, when=when)
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(made), str(dest))
    if by_openextract:
        finish_marker(dest)
    return dest


def finish_marker(folder):
    attempt = backup_status.BackupTry(str(folder)).start()
    attempt.finished()


@pytest.fixture
def old(tmp_path, out):
    return make(tmp_path, out / UDID, MADE)


@pytest.fixture
def new(tmp_path, out, old):
    return make(tmp_path, out / f"{UDID}-20240615-120000", LATER, by_openextract=True, seed=2)


@pytest.fixture
def manager():
    manager = backup.BackupManager()
    yield manager
    manager.close_backup(UDID)


def opened(manager, folder, password=PASSWORD):
    result = manager.open_backup(UDID, password=password, backup_dir=str(folder))
    assert result["status"] == "open"
    return manager.get_open_backup(UDID)


def snapshot(root):
    """Every path under root, and every file's bytes."""
    found = {}
    for here, dirs, files in os.walk(root):
        for name in dirs + files:
            path = os.path.join(here, name)
            if os.path.islink(path):
                found[path] = ("link", os.readlink(path))
            elif os.path.isfile(path) and os.access(path, os.R_OK):
                found[path] = Path(path).read_bytes()
            else:
                found[path] = None
    return found


def offered(manager, kept):
    return [Path(b["backup_dir"]) for b in older_backups.list_older(kept, manager.read_info)["backups"]]


def ask(manager, kept, target):
    return older_backups.check(kept, str(target), manager.read_info)


def refused(manager, kept, target, reason=older_backups.NOT_OFFERED):
    assert ask(manager, kept, target) == {"allowed": False, "reason": reason}


def stored(folder):
    return sorted(p for p in folder.glob("??/*") if p.is_file())


def link(target, at, directory=False):
    try:
        os.symlink(target, at, target_is_directory=directory)
    except OSError as e:
        pytest.skip(f"can't make a link here: {e}")


# ── What may go ──────────────────────────────────────────────────────────────

def test_the_older_backup_is_offered_and_asking_changes_nothing(manager, out, old, new):
    kept = opened(manager, new)
    before = snapshot(out)
    assert offered(manager, kept) == [old]
    found = ask(manager, kept, old)
    assert found["allowed"] is True and found["stamp"]
    assert found["older"]["backup_dir"] == str(old) and found["newer"]["backup_dir"] == str(new)
    assert found["older"]["encrypted"] and found["newer"]["encrypted"]
    assert found["older"]["device_name"] == "Test iPhone"
    assert found["older"]["bytes"] == sum(p.stat().st_size for p in old.rglob("*") if p.is_file())
    assert found["older"]["last_backup"] < found["newer"]["last_backup"]
    assert snapshot(out) == before


def test_several_are_listed_newest_first(manager, tmp_path, out, old, new):
    middle = make(tmp_path, out / f"{UDID}-20240520-120000", MADE + timedelta(days=14), seed=3)
    assert offered(manager, opened(manager, new)) == [middle, old]


def test_from_the_middle_one_only_the_oldest(manager, tmp_path, out, old, new):
    middle = make(tmp_path, out / f"{UDID}-20240520-120000", MADE + timedelta(days=14), by_openextract=True, seed=3)
    kept = opened(manager, middle)
    assert offered(manager, kept) == [old]
    refused(manager, kept, new)


def test_backups_still_in_a_work_folder(manager, tmp_path, out, old):
    middle = make(tmp_path, out / backup_beside.WORK_DIR / UDID, MADE + timedelta(days=14), seed=3)
    newest = make(tmp_path, out / f"{backup_beside.WORK_DIR}-2" / UDID, LATER, by_openextract=True, seed=2)
    kept = opened(manager, newest)
    assert offered(manager, kept) == [middle, old]
    assert ask(manager, kept, middle)["allowed"] and ask(manager, kept, old)["allowed"]


def test_ordinary_clutter_is_fine(manager, old, new):
    for name in (".DS_Store", "desktop.ini", "Thumbs.db", "._Info.plist", "Manifest.db-wal"):
        (old / name).write_bytes(b"x")
    (stored(old)[0].parent / ".DS_Store").write_bytes(b"x")
    assert ask(manager, opened(manager, new), old)["allowed"]


def test_odd_values_in_a_backups_info_dont_break_the_list(manager, out, old, new):
    import json
    import plistlib

    info = plistlib.loads((old / "Info.plist").read_bytes())
    info.update({"Device Name": {"a": b"bytes"}, "Product Version": b"\xff", "Phone Number": 5})
    (old / "Info.plist").write_bytes(plistlib.dumps(info))
    kept = opened(manager, new)
    json.dumps(older_backups.list_older(kept, manager.read_info))
    found = ask(manager, kept, old)
    json.dumps(found)
    assert found["allowed"] and isinstance(found["older"]["device_name"], str)


def test_the_stamp_follows_the_folder(manager, old, new):
    kept = opened(manager, new)
    first = ask(manager, kept, old)["stamp"]
    assert ask(manager, kept, old)["stamp"] == first
    with open(stored(old)[0], "ab") as f:
        f.write(b"more")
    assert ask(manager, kept, old)["stamp"] != first


def test_another_folder_put_in_its_place_has_another_stamp(manager, out, old, new):
    kept = opened(manager, new)
    first = ask(manager, kept, old)["stamp"]
    copy = out.parent / "a copy"
    shutil.copytree(old, copy)
    os.rename(old, out.parent / "the first")
    os.rename(copy, old)
    assert ask(manager, kept, old)["stamp"] != first


# ── The newest, and anything that isn't an older backup of this iPhone ──────

def test_the_newest_is_never_offered(manager, tmp_path, out, old, new):
    finish_marker(old)
    kept = opened(manager, old)
    assert offered(manager, kept) == []
    refused(manager, kept, new)


def test_not_the_open_one_itself(manager, old, new):
    refused(manager, opened(manager, new), new)


def test_not_another_iphones(manager, tmp_path, out, old, new):
    theirs = make(tmp_path, out / OTHER_IPHONE, MADE, udid=OTHER_IPHONE, seed=4)
    kept = opened(manager, new)
    assert theirs not in offered(manager, kept)
    refused(manager, kept, theirs)


def test_not_one_in_another_folder(manager, tmp_path, old, new):
    elsewhere = make(tmp_path, tmp_path.resolve() / "Other drive" / UDID, MADE, seed=4)
    refused(manager, opened(manager, new), elsewhere)


@pytest.mark.parametrize("when", [LATER, LATER + timedelta(seconds=1)], ids=["same time", "newer"])
def test_not_one_that_isnt_older(manager, tmp_path, out, old, new, when):
    other = make(tmp_path, out / f"{UDID}-20240701-120000", when, seed=5)
    kept = opened(manager, new)
    assert other not in offered(manager, kept)
    refused(manager, kept, other)


def test_not_one_with_no_date(manager, old, new):
    (old / "Info.plist").unlink()
    (old / "Status.plist").unlink()
    refused(manager, opened(manager, new), old)


def test_not_one_openextract_finished_later_whatever_the_iphones_clock_said(manager, old, new):
    finish_marker(old)  # after new's
    refused(manager, opened(manager, new), old)


@pytest.mark.parametrize("wanted", ["", ".", "..", "parent", "dotted", "nowhere", "trailing"])
def test_only_exactly_what_was_listed(manager, out, old, new, wanted):
    kept = opened(manager, new)
    asked = {"parent": str(out), "dotted": os.path.join(str(new), "..", old.name),
             "nowhere": str(out / "nothing here"), "trailing": str(old) + os.sep}.get(wanted, wanted)
    refused(manager, kept, asked)


def test_not_a_link_to_a_backup(manager, tmp_path, out, old, new):
    real = make(tmp_path, tmp_path.resolve() / "Other drive" / UDID, MADE, seed=4)
    alias = out / "shortcut"
    link(real, alias, directory=True)
    refused(manager, opened(manager, new), alias)


def test_not_another_name_for_the_open_one(manager, out, old, new):
    alias = out / "another name"
    link(new, alias, directory=True)
    kept = opened(manager, alias)
    assert offered(manager, kept) == [old]
    refused(manager, kept, new)


def test_a_backup_made_inside_an_older_ones_folder_cant_take_that_one_away(manager, tmp_path, out, old):
    inner = make(tmp_path, old / UDID, LATER, by_openextract=True, seed=2)
    kept = opened(manager, inner)
    assert offered(manager, kept) == []
    refused(manager, kept, old)


# ── An older one that didn't finish, or can't be unlocked ───────────────────

def keys_emptied(folder):
    (folder / "Manifest.plist").write_bytes(b"")


def keys_gone(folder):
    finish_marker(folder)
    (folder / "Manifest.plist").unlink()


def files_waiting(folder):
    (folder / "Snapshot" / "ab").mkdir(parents=True)
    (folder / "Snapshot" / "ab" / ("ab" * 20)).write_bytes(b"x")


def index_gone(folder):
    (folder / "Manifest.db").unlink()


def try_cut_off(folder):
    os.utime(folder / "Manifest.db", (1_600_000_000, 1_600_000_000))
    backup_status.BackupTry(str(folder)).start()


@pytest.mark.parametrize("broken", [keys_emptied, keys_gone, files_waiting, index_gone, try_cut_off])
def test_one_that_may_need_rescuing_is_never_offered(manager, old, new, broken):
    broken(old)
    kept = opened(manager, new)
    assert offered(manager, kept) == []
    refused(manager, kept, old)


# ── The one that's staying has to be sure ───────────────────────────────────

def test_not_from_one_openextract_didnt_see_finish(manager, old, new):
    (new / backup_status.MARKER_FILE).unlink()
    kept = opened(manager, new)
    assert offered(manager, kept) == []
    refused(manager, kept, old)


def test_not_from_one_changed_since(manager, old, new):
    kept = opened(manager, new)
    os.utime(new / "Manifest.db", (1_600_000_000, 1_600_000_000))
    refused(manager, kept, old)


def test_not_from_one_that_has_gone(manager, out, old, new):
    kept = opened(manager, new)
    manager.close_backup(UDID)  # Windows won't rename it while it's open
    os.rename(new, out.parent / "moved away")
    gone = types.SimpleNamespace(backup_dir=kept.backup_dir)
    refused(manager, gone, old)


def test_not_from_one_missing_a_file(manager, old, new):
    kept = opened(manager, new)
    stored(new)[0].unlink()
    refused(manager, kept, old, older_backups.KEPT_NOT_WHOLE)


def test_not_from_one_that_lost_a_file_after_the_app_last_counted(manager, old, new):
    kept = opened(manager, new)
    assert older_backups.backup_files.missing_files(kept)["missing"] == 0
    stored(new)[-1].unlink()
    refused(manager, kept, old, older_backups.KEPT_NOT_WHOLE)


@pytest.mark.parametrize("listing", [lambda _: [], lambda _: 1 / 0], ids=["nothing listed", "can't be read"])
def test_not_from_one_whose_list_of_files_cant_be_had(manager, old, new, monkeypatch, listing):
    kept = opened(manager, new)
    monkeypatch.setattr(older_backups.backup_files, "_listed_files", listing)
    refused(manager, kept, old, older_backups.KEPT_NOT_WHOLE)


# ── Things that would go with it ─────────────────────────────────────────────

def saved_file(folder):
    (folder / "Mom's photos.zip").write_bytes(b"irreplaceable")


def saved_folder(folder):
    (folder / "Messages export").mkdir()


def hidden_file(folder):
    (folder / ".notes").write_bytes(b"x")


def file_among_the_stored(folder):
    (stored(folder)[0].parent / "IMG_0001.JPG").write_bytes(b"x")


def folder_among_the_stored(folder):
    (stored(folder)[0].parent / ("ab" * 20)).mkdir()


def folder_named_like_clutter(folder):
    (folder / ".DS_Store").mkdir()


def link_inside(folder):
    link(folder.parent, folder / "ff", directory=True)


def link_among_the_stored(folder):
    link(folder / "Info.plist", stored(folder)[0].parent / ("cd" * 20))


def a_backup_inside(folder):
    shutil.copytree(folder, folder.parent / "copying")
    os.rename(folder.parent / "copying", folder / "inner")


@pytest.mark.parametrize("extra", [saved_file, saved_folder, hidden_file, file_among_the_stored,
                                   folder_among_the_stored, folder_named_like_clutter, link_inside,
                                   link_among_the_stored, a_backup_inside])
def test_one_with_anything_else_in_it_stays(manager, out, old, new, extra):
    extra(old)
    kept = opened(manager, new)
    before = snapshot(out)
    refused(manager, kept, old, older_backups.OTHER_THINGS)
    assert snapshot(out) == before


def test_one_that_cant_all_be_read_stays(manager, old, new, monkeypatch):
    kept = opened(manager, new)
    blocked = str(stored(old)[0].parent)
    real = os.scandir

    def scandir(path="."):
        if str(path) == blocked:
            raise PermissionError(13, "Access is denied", blocked)
        return real(path)

    monkeypatch.setattr(os, "scandir", scandir)
    refused(manager, kept, old, older_backups.CANT_READ)


def test_a_drives_own_folder_stays(manager, old, new, monkeypatch):
    kept = opened(manager, new)
    monkeypatch.setattr(os.path, "ismount", lambda path: str(path) == str(old))
    refused(manager, kept, old)


def test_no_room_in_the_trash_is_passed_on(manager, old, new, monkeypatch):
    kept = opened(manager, new)
    asked = []
    monkeypatch.setattr(trash_room, "problem", lambda *a: asked.append(a) or trash_room.BIN_TOO_FULL)
    refused(manager, kept, old, trash_room.BIN_TOO_FULL)
    ((path, room, longest),) = asked
    assert path == str(old) and longest == max(len(str(p)) for p in old.rglob("*") if p.is_file())
    assert room >= sum(p.stat().st_size for p in old.rglob("*") if p.is_file())


# ── The whole way round, with the fake iPhone ───────────────────────────────

@pytest.mark.fake_iphone
def test_back_up_remove_the_older_and_back_up_again(manager, out, old):
    sending = lambda: FakeIPhone(plans.synthetic_backup(file_count=20, large_files=()))  # noqa: E731
    run = run_backup(sending(), out)
    assert run.error is None, run.error
    second = Path(run.result["backup_path"])
    kept = opened(manager, second, password=None)
    assert offered(manager, kept) == [old]
    found = ask(manager, kept, old)
    assert found["allowed"] and found["older"]["encrypted"] and not found["newer"]["encrypted"]

    os.rename(old, out.parent / "the Trash")  # what the main process's trashItem does
    assert offered(manager, kept) == []
    manager.close_backup(UDID)

    before = snapshot(second)
    run = run_backup(sending(), out)
    assert run.error is None, run.error
    third = Path(run.result["backup_path"])
    # Not <udid> again: putting the first back from the Trash would merge it into this one.
    assert third.parent == out and third.name.startswith(f"{UDID}-") and third != second
    assert run.result["earlier_backup"] == str(second)
    assert not (out / UDID).exists()
    assert snapshot(second) == before


def test_the_newest_dated_one_counts_as_the_one_already_there(tmp_path, out):
    for name in (f"{UDID}-20240101-000000", f"{UDID}-20240615-120000"):
        (out / name).mkdir(parents=True)
        (out / name / "Manifest.db").write_bytes(b"x")
    (out / f"{UDID}-20250101-000000").mkdir()  # holds nothing
    (out / f"{UDID}-notes").mkdir()
    destination = backup_beside.Destination(str(out))
    assert destination.prepare(UDID) == str(out / backup_beside.WORK_DIR)
    assert destination.beside and destination.earlier == str(out / f"{UDID}-20240615-120000")


# ── Room in the Trash ────────────────────────────────────────────────────────

@pytest.mark.parametrize("room, limit, used, expected", [
    (10, 299, 0, None),
    (290, 299, 0, None),
    (179, 299, 179, trash_room.BIN_TOO_FULL),  # measured: Windows erased the first and said it worked
    (290, 299, 9, trash_room.BIN_TOO_FULL),    # within the margin
    (301, 299, 0, trash_room.TOO_BIG),         # measured: refused
    (10, None, 0, trash_room.NO_BIN),
])
def test_it_only_goes_if_it_fits_beside_everything_in_the_recycle_bin(room, limit, used, expected):
    assert trash_room.fits(room * MIB, limit and limit * MIB, used * MIB) == expected


def test_never_on_linux(monkeypatch, tmp_path):
    monkeypatch.setattr(trash_room.sys, "platform", "linux")
    assert REAL_PROBLEM(str(tmp_path), 1, 10) == trash_room.NOT_HERE


def test_not_on_a_macs_network_drive(monkeypatch, tmp_path):
    monkeypatch.setattr(trash_room.sys, "platform", "darwin")
    monkeypatch.setattr(trash_room, "_is_local", lambda _: False)
    assert REAL_PROBLEM(str(tmp_path), 1, 10) == trash_room.NOT_LOCAL


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS's statfs")
def test_this_macs_drive_is_local_and_a_folder_that_isnt_there_is_not(tmp_path):
    assert trash_room._is_local(str(tmp_path))
    assert not trash_room._is_local(str(tmp_path / "nothing"))
    if os.path.isdir("/System/Volumes/Data/home") and os.path.ismount("/System/Volumes/Data/home"):
        assert not trash_room._is_local("/System/Volumes/Data/home")  # an autofs mount


def test_windows_refuses_paths_too_long_and_a_bin_it_cant_read(monkeypatch, tmp_path):
    monkeypatch.setattr(trash_room.sys, "platform", "win32")

    def cant(_):
        raise OSError("no")

    monkeypatch.setattr(trash_room, "_recycle_bin", cant)
    assert REAL_PROBLEM(str(tmp_path), 1, 300) == trash_room.PATH_TOO_LONG
    assert REAL_PROBLEM(str(tmp_path), 1, 10) == trash_room.NO_BIN


@pytest.mark.skipif(sys.platform != "win32", reason="the Recycle Bin")
def test_this_computers_recycle_bin_can_be_read(tmp_path):
    limit, used = trash_room._recycle_bin(str(tmp_path))
    assert (limit is None or limit >= MIB) and used >= 0
    assert trash_room.cluster_size(str(tmp_path)) >= 512


VOLUME = rf"{trash_room._BIT_BUCKET}\Volume\{{v}}"
KNOWN = rf"{trash_room._BIT_BUCKET}\KnownFolder"


class FakeWinreg(types.SimpleNamespace):
    HKEY_CURRENT_USER, HKEY_LOCAL_MACHINE = "HKCU", "HKLM"

    def __init__(self, values):
        super().__init__(values=values)

    def OpenKey(self, hive, key):
        if not any(h == hive and (k == key or k.startswith(key + "\\")) for h, k in self.values):
            raise FileNotFoundError(key)
        fake = self

        class Key(tuple):
            def __enter__(self):
                return self

            def __exit__(self, *_):
                fake.closed = True

        return Key((hive, key))

    def QueryValueEx(self, key, name):
        try:
            return self.values[tuple(key)][name], 4
        except KeyError:
            raise FileNotFoundError(name) from None

    def _children(self, key):
        return sorted({k[len(key[1]) + 1:] for h, k in self.values if h == key[0] and k.startswith(key[1] + "\\")})

    def QueryInfoKey(self, key):
        return len(self._children(key)), 0, 0

    def EnumKey(self, key, i):
        return self._children(key)[i]


@pytest.mark.parametrize("values, limit", [
    ({("HKCU", VOLUME): {"MaxCapacity": 299, "NukeOnDelete": 0}}, 299 * MIB),
    ({("HKCU", VOLUME): {"MaxCapacity": 299, "NukeOnDelete": 1}}, None),
    ({("HKCU", VOLUME): {"MaxCapacity": 0}}, None),
    ({("HKCU", VOLUME): {}}, None),
    ({}, None),
    ({("HKCU", VOLUME): {"MaxCapacity": 299}, ("HKCU", KNOWN + r"\{docs}"): {"MaxCapacity": 100}}, 100 * MIB),
    ({("HKCU", VOLUME): {"MaxCapacity": 299}, ("HKLM", trash_room._POLICIES[0]): {"NoRecycleFiles": 1}}, None),
    ({("HKCU", VOLUME): {"MaxCapacity": 299}, ("HKCU", trash_room._POLICIES[1]): {"RecycleBinSize": 2}}, None),
], ids=["set", "turned off", "zero", "no size", "never set", "moved Documents", "policy off", "policy size"])
def test_the_recycle_bins_limit(monkeypatch, values, limit):
    monkeypatch.setitem(sys.modules, "winreg", FakeWinreg(values))
    assert trash_room._limit("{v}") == limit
