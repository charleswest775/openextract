"""
Which older backups may go to the Trash (python/older_backups.py, python/trash_room.py).

These folders can be the only copy of someone's messages and photos, so most of this is what
must be refused. The engine itself never moves or deletes: every test that asks also finds
everything exactly as it was.
"""

import json
import os
import plistlib
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
import backup_files  # noqa: E402
import backup_beside  # noqa: E402
import backup_status  # noqa: E402
import older_backups  # noqa: E402
import trash_room  # noqa: E402

REAL_PROBLEM = trash_room.problem
REAL_STORED_WHOLE = backup_files.stored_whole
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
    # Written when it was made, by this computer's clock too.
    os.utime(dest / "Manifest.db", (when.timestamp(), when.timestamp()))
    if by_openextract:
        finish_marker(dest, when)
    return dest


def finish_marker(folder, when):
    """OpenExtract's marker, as if it saw the iPhone finish this backup at `when`."""
    attempt = backup_status.BackupTry(str(folder)).start()
    attempt.finished()
    path = folder / backup_status.MARKER_FILE
    marker = json.loads(path.read_text(encoding="utf-8"))
    marker.update(started_at=when.timestamp(), finished_at=when.timestamp() + 60)
    path.write_text(json.dumps(marker), encoding="utf-8")


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
    # On exFAT a Mac puts a ._<name> file beside each: not part of the backup.
    return sorted(p for p in folder.glob("??/*") if p.is_file() and not p.name.startswith("._"))


def own_files(folder):
    return [p for p in folder.rglob("*") if p.is_file() and not p.name.startswith("._")]


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
    assert found["older"]["bytes"] == sum(p.stat().st_size for p in own_files(old))
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
    # The newest can be one still there; one to go can't, as the next try would take its place.
    assert offered(manager, kept) == [old]
    assert ask(manager, kept, old)["allowed"]
    refused(manager, kept, middle)


def test_ordinary_clutter_is_fine(manager, old, new):
    for name in (".DS_Store", "desktop.ini", "Thumbs.db", "._Info.plist", "Manifest.db-wal"):
        (old / name).write_bytes(b"x")
    (stored(old)[0].parent / ".DS_Store").write_bytes(b"x")
    assert ask(manager, opened(manager, new), old)["allowed"]


def test_odd_values_in_a_backups_info_dont_break_the_list(manager, out, old, new):
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
    finish_marker(old, MADE)
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
    finish_marker(old, LATER + timedelta(hours=1))
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


def test_not_a_link_named_as_a_backup_would_be(manager, tmp_path, out, old, new):
    real = make(tmp_path, tmp_path.resolve() / "Other drive" / UDID, MADE, seed=4)
    alias = out / f"{UDID}-20240401-120000"
    link(real, alias, directory=True)
    kept = opened(manager, new)
    assert alias not in offered(manager, kept)
    refused(manager, kept, alias)


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
    finish_marker(folder, MADE)
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
    assert offered(manager, kept) == []
    refused(manager, kept, old, older_backups.KEPT_CHANGED)


def test_not_from_one_that_has_gone(manager, out, old, new):
    kept = opened(manager, new)
    manager.close_backup(UDID)  # Windows won't rename it while it's open
    os.rename(new, out.parent / "moved away")
    gone = types.SimpleNamespace(backup_dir=kept.backup_dir, opened_as=kept.opened_as)
    refused(manager, gone, old, older_backups.KEPT_CHANGED)


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
    monkeypatch.setattr(backup_files, "_listed_with_sizes", listing)
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
    within = stored(folder)[0].parent
    (within / (within.name + "0" * 38)).mkdir()


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


# ── The one that's staying, after it was unlocked ────────────────────────────

def zero_filled(p):
    p.write_bytes(b"\0" * p.stat().st_size)


def same_size_other_keys(p):
    st = p.stat()
    data = bytearray(p.read_bytes())
    data[-1] ^= 1
    p.write_bytes(bytes(data))
    os.utime(p, ns=(st.st_atime_ns, st.st_mtime_ns))


@pytest.mark.parametrize("change", [Path.unlink, zero_filled, same_size_other_keys],
                         ids=["gone", "zeroed", "other keys, same size and time"])
def test_its_keys_changed_after_it_was_unlocked(manager, old, new, change):
    kept = opened(manager, new)
    change(new / "Manifest.plist")
    assert offered(manager, kept) == []
    refused(manager, kept, old, older_backups.KEPT_CHANGED)


@pytest.mark.parametrize("name", ["Info.plist", "Status.plist", backup_status.MARKER_FILE])
def test_what_it_says_it_is_changed_after_it_was_unlocked(manager, old, new, name):
    kept = opened(manager, new)
    with open(new / name, "ab") as f:
        f.write(b"\n")
    refused(manager, kept, old, older_backups.KEPT_CHANGED)


def test_another_drives_backups_at_the_same_paths(manager, tmp_path, out, old, new):
    kept = opened(manager, new)
    manager.close_backup(UDID)  # Windows won't rename it while it's open
    copy = tmp_path / "the other drive"
    shutil.copytree(new, copy)
    os.rename(new, tmp_path / "the drive that was there")
    os.rename(copy, new)
    then = types.SimpleNamespace(backup_dir=str(new), opened_as=kept.opened_as)
    refused(manager, then, old, older_backups.KEPT_CHANGED)


def test_one_never_unlocked_allows_nothing(manager, old, new):
    never = types.SimpleNamespace(backup_dir=str(new))
    assert offered(manager, never) == []
    refused(manager, never, old, older_backups.KEPT_CHANGED)


def test_one_that_changes_while_the_older_is_measured(manager, old, new, monkeypatch):
    kept = opened(manager, new)

    def while_measuring(*_):
        (new / "Manifest.plist").write_bytes(b"")

    monkeypatch.setattr(trash_room, "problem", while_measuring)
    refused(manager, kept, old, older_backups.KEPT_CHANGED)


def test_one_that_loses_a_file_while_the_older_is_measured(manager, old, new, monkeypatch):
    kept = opened(manager, new)
    monkeypatch.setattr(trash_room, "problem", lambda *_: stored(new)[0].unlink())
    refused(manager, kept, old, older_backups.KEPT_NOT_WHOLE)


def every_file_empty(new, old):
    for p in stored(new):
        p.write_bytes(b"")


def one_file_empty(new, old):
    stored(new)[0].write_bytes(b"")


def in_the_wrong_folder(new, old):
    p = stored(new)[0]
    wrong = new / ("00" if p.parent.name != "00" else "11")
    wrong.mkdir(exist_ok=True)
    os.rename(p, wrong / p.name)


def a_folder_not_a_file(new, old):
    p = stored(new)[0]
    p.unlink()
    p.mkdir()


def files_linked_into_the_older(new, old):
    p = stored(new)[0]
    target = old / p.parent.name / p.name
    target.parent.mkdir(exist_ok=True)
    shutil.copyfile(p, target)
    p.unlink()
    link(target, p)


def a_stray_link(new, old):
    link(old, new / "shortcut", directory=True)


@pytest.mark.parametrize("damage", [every_file_empty, one_file_empty, in_the_wrong_folder, a_folder_not_a_file,
                                    files_linked_into_the_older, a_stray_link])
def test_every_listed_file_has_to_be_there_for_real(manager, old, new, damage):
    damage(new, old)
    refused(manager, opened(manager, new), old, older_backups.KEPT_NOT_WHOLE)


def listing_with_first_empty(new, monkeypatch, path, size):
    empty = stored(new)[0]
    empty.write_bytes(b"")
    real = backup_files._listed_with_sizes
    monkeypatch.setattr(backup_files, "_listed_with_sizes", lambda kept: [
        (file_id, path, size) if file_id == empty.name else (file_id, p, s) for file_id, p, s in real(kept)])


@pytest.mark.parametrize("path, size", [("Library/SMS/sms.db-wal", 4096), ("Library/empty.txt", 0)])
def test_an_empty_file_thats_meant_to_be(manager, old, new, monkeypatch, path, size):
    kept = opened(manager, new)
    listing_with_first_empty(new, monkeypatch, path, size)
    assert ask(manager, kept, old)["allowed"]


def test_an_empty_file_of_unknown_size_isnt_enough(manager, old, new, monkeypatch):
    kept = opened(manager, new)
    listing_with_first_empty(new, monkeypatch, "Library/something", None)
    refused(manager, kept, old, older_backups.KEPT_NOT_WHOLE)


def test_a_folder_it_cant_list_isnt_whole(old, new, manager, monkeypatch):
    kept = opened(manager, new)
    monkeypatch.setattr(backup_files, "_read_folder", lambda _: None)
    refused(manager, kept, old, older_backups.KEPT_NOT_WHOLE)


def test_only_its_listed_files_count_toward_its_size(manager, old, new):
    (new / "a 45 GB zip.zip").write_bytes(b"x" * 100_000)
    kept = opened(manager, new)
    (stored(new)[0].parent / "beside.bin").write_bytes(b"x" * 100_000)
    assert ask(manager, kept, old)["newer"]["bytes"] == sum(p.stat().st_size for p in stored(new) if p.name != "beside.bin")


def test_not_from_one_renamed_by_hand(manager, tmp_path, out, old):
    renamed = make(tmp_path, out / "Mom's phone, June", LATER, by_openextract=True, seed=2)
    kept = opened(manager, renamed)
    assert offered(manager, kept) == []
    refused(manager, kept, old)


# ── The one to go, more ways ─────────────────────────────────────────────────

def test_the_keys_gone_fixture_would_otherwise_be_offered(manager, old, new):
    finish_marker(old, MADE)
    assert ask(manager, opened(manager, new), old)["allowed"]


def plist_gone(old):
    (old / "Manifest.plist").unlink()  # as Finder made it, so with no marker


def plist_cut_short(old):
    p = old / "Manifest.plist"
    p.write_bytes(p.read_bytes()[:40])


def plist_zeroed(old):
    zero_filled(old / "Manifest.plist")


def keybag_gone(old):
    p = old / "Manifest.plist"
    manifest = plistlib.loads(p.read_bytes())
    del manifest["BackupKeyBag"]
    p.write_bytes(plistlib.dumps(manifest))


def says_not_encrypted(old):
    p = old / "Manifest.plist"
    manifest = plistlib.loads(p.read_bytes())
    manifest["IsEncrypted"] = False
    p.write_bytes(plistlib.dumps(manifest))


@pytest.mark.parametrize("broken", [plist_gone, plist_cut_short, plist_zeroed, keybag_gone, says_not_encrypted])
def test_one_that_cant_be_unlocked_is_never_offered(manager, old, new, broken):
    broken(old)
    kept = opened(manager, new)
    assert offered(manager, kept) == []
    refused(manager, kept, old)


def test_not_one_this_computer_wrote_later_whatever_the_iphones_clock_said(manager, old, new):
    written = (LATER + timedelta(days=1)).timestamp()
    os.utime(old / "Manifest.db", (written, written))
    refused(manager, opened(manager, new), old)


@pytest.mark.parametrize("at", [float("inf"), float("nan"), "yesterday", None])
def test_not_from_one_whose_finish_time_is_no_time(manager, old, new, at):
    path = new / backup_status.MARKER_FILE
    marker = json.loads(path.read_text(encoding="utf-8"))
    marker["finished_at"] = at
    path.write_text(json.dumps(marker), encoding="utf-8")
    refused(manager, opened(manager, new), old)


def test_a_folder_not_named_as_its_backups_are_isnt_even_read(manager, tmp_path, out, old, new):
    copy = make(tmp_path, out / "Dad's old phone", MADE, seed=4)
    (out / "Documents").mkdir()
    (out / f"{UDID}-notes").mkdir()
    kept = opened(manager, new)
    read = []
    older_backups.list_older(kept, lambda path: read.append(Path(path)) or manager.read_info(path))
    assert set(read) == {old, new}
    refused(manager, kept, copy)


def test_a_folder_named_for_it_but_holding_another_iphones(manager, tmp_path, out, old, new):
    theirs = make(tmp_path, out / f"{UDID}-20240401-120000", MADE, udid=OTHER_IPHONE, seed=4)
    kept = opened(manager, new)
    assert theirs not in offered(manager, kept)
    refused(manager, kept, theirs)


def test_one_odd_backup_doesnt_hide_the_others(manager, tmp_path, out, old, new):
    odd = make(tmp_path, out / f"{UDID}-20240520-120000", MADE + timedelta(days=14), seed=3)
    kept = opened(manager, new)

    def read_info(path):
        if Path(path) == odd:
            raise OverflowError("int too large to convert to float")
        return manager.read_info(path)

    assert [b["backup_dir"] for b in older_backups.list_older(kept, read_info)["backups"]] == [str(old)]


def test_not_through_a_linked_work_folder(manager, tmp_path, out, old, new):
    elsewhere = make(tmp_path, tmp_path.resolve() / "Other drive" / "work" / UDID, MADE, seed=6)
    link(elsewhere.parent, out / backup_beside.WORK_DIR, directory=True)
    through = out / backup_beside.WORK_DIR / UDID
    kept = opened(manager, new)
    assert through not in offered(manager, kept)
    refused(manager, kept, through)


@pytest.mark.parametrize("trash", [".Trash", ".Trashes/501", "$Recycle.Bin/S-1-5-21-1", ".Trash-1000/files"])
def test_not_backups_already_in_a_trash(manager, tmp_path, trash):
    binned = tmp_path.resolve() / trash
    old = make(tmp_path, binned / UDID, MADE)
    new = make(tmp_path, binned / f"{UDID}-20240615-120000", LATER, by_openextract=True, seed=2)
    kept = opened(manager, new)
    assert offered(manager, kept) == []
    refused(manager, kept, old)


def test_a_drive_mounted_inside_stays(manager, old, new, monkeypatch):
    kept = opened(manager, new)
    inside = str(stored(old)[0].parent)
    monkeypatch.setattr(os.path, "ismount", lambda path: str(path) == inside)
    refused(manager, kept, old, older_backups.OTHER_THINGS)


@pytest.mark.parametrize("where, name", [
    ("", "._Wedding video.mov"), ("xx", "._Wedding video.mov"), ("", "ab" * 20),
    ("xx", "zz" * 20), ("wrong", "ab" * 20), ("same xx", "z" * 38), ("", "._"), ("xx", "._Info.plist"), ("", "Manifest.db.zip"),
], ids=["resource-fork-like", "that inside", "loose stored name", "not hex", "another folder's", "not hex after its folder's", "bare ._",
        "Info's inside", "almost a name"])
def test_names_only_like_a_backups_stay(manager, old, new, where, name):
    first = stored(old)[0].parent
    if where == "same xx":
        name = first.name + name
    folder = {"": old, "xx": first, "same xx": first, "wrong": old / "00"}[where]
    folder.mkdir(exist_ok=True)
    (folder / name).write_bytes(b"x")
    refused(manager, opened(manager, new), old, older_backups.OTHER_THINGS)


@pytest.mark.parametrize("name", ["abc", "g0"])
def test_folders_only_like_a_backups_stay(manager, old, new, name):
    (old / name).mkdir()
    refused(manager, opened(manager, new), old, older_backups.OTHER_THINGS)


def test_finders_own_attribute_files_go_with_it(manager, old, new):
    file = stored(old)[0]
    for extra in (old / f"._{file.parent.name}", file.parent / f"._{file.name}", old / "._Manifest.db"):
        extra.write_bytes(b"x")
    assert ask(manager, opened(manager, new), old)["allowed"]


@pytest.mark.parametrize("which", ["old", "new"])
def test_a_backup_thats_only_online_stays(manager, old, new, monkeypatch, which):
    kept = opened(manager, new)
    online = stored(old if which == "old" else new)[0]
    inode = online.lstat().st_ino
    if sys.platform == "win32":
        pytest.skip("a directory entry has no inode on Windows; test_what_counts_as_online_only covers it")
    monkeypatch.setattr(backup_files, "is_online_only", lambda st: st.st_ino == inode)
    expected = older_backups.ONLINE_ONLY if which == "old" else older_backups.KEPT_NOT_WHOLE
    refused(manager, kept, old, expected)


def test_what_counts_as_online_only(monkeypatch):
    for attributes in (0x1000, 0x40000, 0x400000):
        assert backup_files.is_online_only(types.SimpleNamespace(st_file_attributes=attributes))
    assert not backup_files.is_online_only(types.SimpleNamespace(st_file_attributes=0x20))
    monkeypatch.setattr(backup_files.sys, "platform", "darwin")
    assert backup_files.is_online_only(types.SimpleNamespace(st_flags=0x40000000))
    assert not backup_files.is_online_only(types.SimpleNamespace(st_flags=0))


def test_a_junction_counts_as_a_link():
    assert backup_files.is_link(types.SimpleNamespace(st_mode=0o040777, st_reparse_tag=0xA0000003))
    assert not backup_files.is_link(types.SimpleNamespace(st_mode=0o040777, st_reparse_tag=0))


@pytest.mark.skipif(sys.platform != "win32", reason="junctions")
@pytest.mark.parametrize("where", ["beside", "inside", "in the one staying"])
def test_junctions(manager, tmp_path, out, old, new, where):
    import _winapi

    elsewhere = make(tmp_path, tmp_path.resolve() / "Other drive" / UDID, MADE, seed=6)
    at = {"beside": out / f"{UDID}-20240401-120000", "inside": old / "ff", "in the one staying": new / "shortcut"}[where]
    if at.exists():
        pytest.skip("the generated backup uses that folder")
    _winapi.CreateJunction(str(elsewhere), str(at))
    kept = opened(manager, new)
    if where == "beside":
        refused(manager, kept, at)
    else:
        refused(manager, kept, old, older_backups.OTHER_THINGS if where == "inside" else older_backups.KEPT_NOT_WHOLE)


# ── The second look ──────────────────────────────────────────────────────────

def test_a_file_saved_into_it_during_the_check_is_seen(manager, old, new, monkeypatch):
    kept = opened(manager, new)

    def meanwhile(backup_):
        saved_file(old)
        return REAL_STORED_WHOLE(backup_)

    monkeypatch.setattr(backup_files, "stored_whole", meanwhile)
    refused(manager, kept, old, older_backups.OTHER_THINGS)


def test_showing_it_in_finder_doesnt_count_as_a_change(manager, old, new):
    kept = opened(manager, new)
    first = ask(manager, kept, old)
    (old / ".DS_Store").write_bytes(b"x" * 6148)
    again = ask(manager, kept, old)
    assert (again["stamp"], again["older"]) == (first["stamp"], first["older"])


def test_a_stored_file_rewritten_at_the_same_size_does(manager, old, new):
    kept = opened(manager, new)
    first = ask(manager, kept, old)["stamp"]
    file = stored(old)[0]
    file.write_bytes(b"y" * file.stat().st_size)
    ahead = file.stat().st_mtime + 10_000_000
    os.utime(file, (ahead, ahead))
    assert ask(manager, kept, old)["stamp"] != first


def test_an_index_rewritten_at_the_same_size_does(manager, old, new):
    kept = opened(manager, new)
    first = ask(manager, kept, old)["stamp"]
    earlier = (MADE - timedelta(days=1)).timestamp()
    os.utime(old / "Manifest.db", (earlier, earlier))
    assert ask(manager, kept, old)["stamp"] != first


def test_what_the_question_shows(manager, old, new):
    info = plistlib.loads((old / "Info.plist").read_bytes())
    info.update({"Device Name": "N" * 5000, "Phone Number": "+1 555 0199", "Last Backup Date": MADE.replace(tzinfo=None)})
    (old / "Info.plist").write_bytes(plistlib.dumps(info))
    found = ask(manager, opened(manager, new), old)
    assert len(found["older"]["device_name"]) <= 200
    assert found["older"]["phone_number"] == "+1 555 0199" and found["newer"]["phone_number"] == "+1 555 0100"
    assert found["older"]["last_backup"] == "2024-05-06T12:00:00+00:00"


# ── Through the engine's own methods ─────────────────────────────────────────

def test_the_engines_methods_allow_that_one_and_only_that_one(out, old, new):
    from rpc_contract_support import load_engine_module

    server = load_engine_module().SidecarServer()

    def call(method, **params):
        answer = server.handle_request({"id": "x", "method": method, "params": {"udid": UDID, **params}})
        json.dumps(answer, allow_nan=False)
        return answer["result"]

    try:
        assert call("open_backup", backup_dir=str(new), password=PASSWORD)["status"] == "open"
        assert [b["backup_dir"] for b in call("backup.list_older")["backups"]] == [str(old)]
        found = call("backup.check_older", backup_dir=str(old))
        assert found["allowed"] is True and found["older"]["backup_dir"] == str(old)
        assert found["newer"]["bytes"] == sum(p.stat().st_size for p in stored(new))
        for other in (new, out):
            assert call("backup.check_older", backup_dir=str(other))["allowed"] is False
    finally:
        server.backup_manager.close_backup(UDID)


@pytest.mark.parametrize("ios, password", [("6.1.6", None), ("9.3.5", None), ("9.3.5", "test"), ("10.1.1", "test")])
def test_old_iphones_backups(manager, tmp_path, ios, password):
    from test_old_backups import _generate_legacy

    older = _generate_legacy()(tmp_path.resolve() / "Backups", ios=ios, password=password)
    newer = older.parent / f"{older.name}-20240615-120000"
    shutil.copytree(older, newer)
    for folder, when in ((older, MADE), (newer, LATER)):
        info = plistlib.loads((folder / "Info.plist").read_bytes())
        info["Last Backup Date"] = when.replace(tzinfo=None)
        (folder / "Info.plist").write_bytes(plistlib.dumps(info))
        index = next(folder / n for n in ("Manifest.db", "Manifest.mbdb") if (folder / n).exists())
        os.utime(index, (when.timestamp(), when.timestamp()))
    finish_marker(newer, LATER)
    udid = manager.read_info(str(newer))["udid"]
    assert manager.open_backup(udid, password=password, backup_dir=str(newer))["status"] == "open"
    try:
        kept = manager.get_open_backup(udid)
        assert offered(manager, kept) == [older]
        assert ask(manager, kept, older)["allowed"]
    finally:
        manager.close_backup(udid)


# ── The next backup, after one has gone ──────────────────────────────────────

def test_one_still_in_a_work_folder_still_means_a_dated_name(tmp_path, out, monkeypatch):
    waiting = out / backup_beside.WORK_DIR / UDID
    waiting.mkdir(parents=True)
    (waiting / "Manifest.db").write_bytes(b"x")
    destination = backup_beside.Destination(str(out))
    assert destination.prepare(UDID) == str(out / f"{backup_beside.WORK_DIR}-2")
    assert destination.beside and destination.earlier == str(waiting)

    made = make(tmp_path, out / f"{backup_beside.WORK_DIR}-2" / UDID, LATER, seed=2)
    monkeypatch.setattr(backup_beside.time, "strftime", lambda _: "20240615-120000")
    (out / f"{UDID}-20240615-120000").mkdir()
    assert destination.finish() == str(out / f"{UDID}-20240615-120000-2")
    assert not made.exists() and not (out / UDID).exists()


# ── Windows' Recycle Bin, with stand-ins for Windows ─────────────────────────

class FakeWindows:
    def __init__(self, drive=3, limit=299 * MIB, used=0, query=0, cluster=(8, 512)):
        self.drive, self.limit, self.used, self.query, self.cluster = drive, limit, used, query, cluster

    def GetVolumePathNameW(self, path, root, size):
        root.value = "X:\\"
        return 1

    def GetDriveTypeW(self, root):
        return self.drive

    def GetVolumeNameForVolumeMountPointW(self, root, volume, size):
        volume.value = "\\\\?\\Volume{v}\\"
        return 1

    def SHQueryRecycleBinW(self, root, info):
        info._obj.size = self.used
        return self.query

    def GetDiskFreeSpaceW(self, root, sectors, sector, free, total):
        sectors._obj.value, sector._obj.value = self.cluster
        return 1


def on_windows(monkeypatch, fake):
    import ctypes

    monkeypatch.setattr(trash_room.sys, "platform", "win32")
    monkeypatch.setattr(ctypes, "WinDLL", lambda *a, **k: fake, raising=False)
    monkeypatch.setattr(trash_room, "_limit", lambda volume: fake.limit if volume == "{v}" else None)


@pytest.mark.parametrize("fake, room, longest, expected", [
    (FakeWindows(), 100 * MIB, 259, None),
    (FakeWindows(), 100 * MIB, 260, trash_room.PATH_TOO_LONG),
    (FakeWindows(used=250 * MIB), 100 * MIB, 100, trash_room.BIN_TOO_FULL),
    (FakeWindows(), 300 * MIB, 100, trash_room.TOO_BIG),
    (FakeWindows(drive=2), MIB, 100, trash_room.NO_BIN),
    (FakeWindows(drive=4), MIB, 100, trash_room.NO_BIN),
    (FakeWindows(query=-2147418113), MIB, 100, trash_room.NO_BIN),
    (FakeWindows(limit=None), MIB, 100, trash_room.NO_BIN),
], ids=["room", "long path", "bin too full", "too big", "memory stick", "network", "can't ask", "no limit"])
def test_what_windows_says_is_what_decides(monkeypatch, fake, room, longest, expected):
    on_windows(monkeypatch, fake)
    assert REAL_PROBLEM("X:\\Backups\\one", room, longest) == expected


def test_windows_cluster(monkeypatch):
    on_windows(monkeypatch, FakeWindows(cluster=(8, 512)))
    assert trash_room.cluster_size("X:\\Backups\\one") == 4096


def test_files_and_folders_are_rounded_up_to_clusters(old):
    plain, rounded = older_backups._measure(str(old), 1), older_backups._measure(str(old), 4096)
    files = [p for p in old.rglob("*") if p.is_file()]
    own = own_files(old)
    folders = [p for p in old.iterdir() if p.is_dir()]
    assert rounded["room"] == 4096 * len(folders) + sum(-(-p.stat().st_size // 4096) * 4096 for p in files)
    assert rounded["bytes"] == plain["bytes"] == sum(p.stat().st_size for p in own)


def test_a_mac_that_cant_tell_if_its_local_says_no(monkeypatch, tmp_path):
    import ctypes

    def cant(*_a, **_k):
        raise OSError("no")

    monkeypatch.setattr(ctypes, "CDLL", cant)
    assert trash_room._is_local(str(tmp_path)) is False


def test_not_from_one_whose_marker_is_for_another_list_of_files(manager, old, new):
    earlier = (LATER - timedelta(days=1)).timestamp()
    os.utime(new / "Manifest.db", (earlier, earlier))  # before it's opened
    kept = opened(manager, new)
    assert offered(manager, kept) == []
    refused(manager, kept, old)


def test_a_backup_starting_in_it_during_the_check_is_seen(manager, old, new, monkeypatch):
    kept = opened(manager, new)

    def meanwhile(backup_):
        files_waiting(old)
        return REAL_STORED_WHOLE(backup_)

    monkeypatch.setattr(backup_files, "stored_whole", meanwhile)
    refused(manager, kept, old, older_backups.OTHER_THINGS)


@pytest.mark.skipif(sys.platform == "win32", reason="test_junctions has real ones")
def test_a_folder_that_is_really_a_link_stays(manager, old, new, monkeypatch):
    kept = opened(manager, new)
    inside = stored(old)[0].parent.lstat().st_ino
    real = backup_files.is_link
    monkeypatch.setattr(backup_files, "is_link", lambda st: st.st_ino == inside or real(st))
    refused(manager, kept, old, older_backups.OTHER_THINGS)
