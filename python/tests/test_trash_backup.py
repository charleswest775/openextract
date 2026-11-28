"""trash_backup.py: whether a backup on the app's list may go to the Trash, and what the question
needs to say. Nothing here moves anything; electron/olderBackups.ts asks and moves."""

from __future__ import annotations

import os
import shutil
import sqlite3
import sys
from datetime import timedelta
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
for _path in (HERE, HERE.parent, HERE.parent.parent):
    if str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

from encrypted_backup import MADE, make_encrypted_backup  # noqa: E402
from fake_iphone.device import DEFAULT_UDID as UDID  # noqa: E402

import backup  # noqa: E402
import backup_status  # noqa: E402
import older_backups  # noqa: E402
import trash_backup  # noqa: E402
import trash_room  # noqa: E402

REAL_PROBLEM = trash_room.problem
OTHER_IPHONE = "00008030-000A1B2C3D4E5F60"
LATER = MADE + timedelta(days=40)


@pytest.fixture(autouse=True)
def roomy_trash(monkeypatch):
    monkeypatch.setattr(trash_room, "problem", lambda *_: None)


@pytest.fixture
def out(tmp_path):
    return tmp_path.resolve() / "Backups"


@pytest.fixture
def manager():
    return backup.BackupManager()


def messages_db(tmp_path) -> bytes:
    path = tmp_path / "messages-source.db"
    if not path.exists():
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE message (ROWID INTEGER PRIMARY KEY, text TEXT)")
        conn.executemany("INSERT INTO message (text) VALUES (?)", [("synthetic " * 20,)] * 10)
        conn.commit()
        conn.close()
    return path.read_bytes()


def make(tmp_path, dest, when=MADE, *, udid=UDID, seed=1):
    made = make_encrypted_backup(tmp_path / f"made-{dest.name}-{seed}", udid, seed=seed, when=when,
                                 text=messages_db(tmp_path))
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(made), str(dest))
    return dest


def nothing_usual():
    return {"backups": []}


def ask(manager, folder, usual=nothing_usual):
    return trash_backup.check(str(folder), manager.read_info, usual)


def refused(manager, folder, reason):
    assert ask(manager, folder) == {"allowed": False, "reason": reason}


def snapshot(root):
    found = {}
    for here, dirs, files in os.walk(root):
        for name in dirs + files:
            path = os.path.join(here, name)
            found[path] = Path(path).read_bytes() if os.path.isfile(path) else None
    return found


def link(target, at):
    try:
        os.symlink(target, at, target_is_directory=True)
    except OSError as e:
        pytest.skip(f"can't make a link here: {e}")


# ── What may go, and what the question is told ───────────────────────────────

def test_a_backup_may_go_and_asking_changes_nothing(manager, tmp_path, out):
    only = make(tmp_path, out / UDID)
    before = snapshot(out)
    result = ask(manager, only)
    assert snapshot(out) == before
    assert result["allowed"] is True, result
    b = result["backup"]
    assert Path(b["backup_dir"]) == only
    assert b["encrypted"] is True and b["unfinished"] is False
    assert b["bytes"] == sum(p.stat().st_size for p in only.rglob("*") if p.is_file())
    assert b["last_backup"].startswith(MADE.date().isoformat())
    assert isinstance(b["device_name"], str) and isinstance(b["phone_number"], str)
    assert result["others"] == [] and result["more_others"] == 0
    assert result["stamp"]


def test_the_folder_is_named_by_its_real_path(manager, tmp_path, out):
    only = make(tmp_path, out / UDID)
    roundabout = str(out / UDID / ".." / UDID)
    result = ask(manager, roundabout)
    assert result["allowed"] is True and Path(result["backup"]["backup_dir"]) == only


def test_other_backups_of_the_iphone_beside_it_newest_first(manager, tmp_path, out):
    old = make(tmp_path, out / UDID, MADE)
    new = make(tmp_path, out / f"{UDID}-20240615-120000", LATER, seed=2)
    newest = make(tmp_path, out / f"{UDID}-20240715-120000", LATER + timedelta(days=30), seed=3)
    make(tmp_path, out / OTHER_IPHONE, LATER, udid=OTHER_IPHONE, seed=4)
    (out / "Holiday photos").mkdir()

    others = ask(manager, old)["others"]
    assert [Path(o["backup_dir"]) for o in others] == [newest, new]
    assert all(o["encrypted"] is True and o["unfinished"] is False for o in others)
    assert others[0]["last_backup"] > others[1]["last_backup"]
    assert [Path(o["backup_dir"]) for o in ask(manager, newest)["others"]] == [new, old]


def test_other_backups_of_the_iphone_in_the_usual_folders(manager, tmp_path, out):
    mine = make(tmp_path, out / UDID, LATER)
    usual = make(tmp_path, tmp_path.resolve() / "MobileSync" / "Backup" / UDID, MADE, seed=2)
    elsewhere = make(tmp_path, tmp_path.resolve() / "MobileSync" / "Backup" / OTHER_IPHONE, MADE,
                     udid=OTHER_IPHONE, seed=3)
    listed = [manager.read_info(str(p)) | {"backup_dir": str(p)} for p in (usual, elsewhere, mine)]
    result = ask(manager, mine, lambda: {"backups": listed})
    assert [Path(o["backup_dir"]) for o in result["others"]] == [usual]


def test_a_usual_folder_that_cant_be_read_doesnt_stop_the_question(manager, tmp_path, out):
    mine = make(tmp_path, out / UDID)

    def broken():
        raise PermissionError("blocked")

    result = ask(manager, mine, broken)
    assert result["allowed"] is True and result["others"] == []


def test_at_most_three_others_are_named_and_the_rest_counted(manager, tmp_path, out):
    mine = make(tmp_path, out / UDID, MADE)
    for i in range(5):
        make(tmp_path, out / f"{UDID}-2024070{i + 1}-120000", LATER + timedelta(days=i), seed=10 + i)
    result = ask(manager, mine)
    assert len(result["others"]) == 3 and result["more_others"] == 2


def test_a_backup_that_didnt_finish_says_so(manager, tmp_path, out):
    folder = make(tmp_path, out / UDID)
    (folder / "Manifest.plist").write_bytes(b"")  # what a failed try by pymobiledevice3 leaves
    assert backup_status.check(str(folder)).finished is False
    result = ask(manager, folder)
    assert result["allowed"] is True and result["backup"]["unfinished"] is True


def test_the_stamp_follows_the_folder(manager, tmp_path, out):
    folder = make(tmp_path, out / UDID)
    first = ask(manager, folder)["stamp"]
    assert ask(manager, folder)["stamp"] == first
    stored = next(p for p in folder.glob("??/*") if p.is_file())
    stored.write_bytes(stored.read_bytes() + b"more")
    assert ask(manager, folder)["stamp"] != first


def test_ordinary_clutter_is_fine(manager, tmp_path, out):
    folder = make(tmp_path, out / UDID)
    (folder / ".DS_Store").write_bytes(b"\0" * 10)
    (folder / "desktop.ini").write_text("[.ShellClassInfo]", encoding="utf-8")
    assert ask(manager, folder)["allowed"] is True


# ── What may not ─────────────────────────────────────────────────────────────

def test_not_a_folder_with_other_things_in_it(manager, tmp_path, out):
    folder = make(tmp_path, out / UDID)
    (folder / "IMG_0001.jpg").write_bytes(b"photo")
    refused(manager, folder, older_backups.OTHER_THINGS)


def test_not_a_folder_with_another_folder_in_it(manager, tmp_path, out):
    folder = make(tmp_path, out / UDID)
    (folder / "Saved messages").mkdir()
    refused(manager, folder, older_backups.OTHER_THINGS)


def test_not_a_folder_with_no_backup_in_it(manager, tmp_path):
    empty = tmp_path / "Documents"
    empty.mkdir()
    (empty / "notes.txt").write_text("mine", encoding="utf-8")
    refused(manager, empty, trash_backup.NOT_A_BACKUP)
    assert (empty / "notes.txt").exists()


def test_not_a_folder_that_isnt_there(manager, tmp_path):
    refused(manager, tmp_path / "gone", trash_backup.NOT_A_BACKUP)


def test_nothing_that_isnt_a_path(manager):
    for odd in ("", None, 42):
        assert trash_backup.check(odd, manager.read_info, nothing_usual) == \
            {"allowed": False, "reason": trash_backup.NOT_A_BACKUP}


def test_not_a_link_to_a_backup(manager, tmp_path, out):
    folder = make(tmp_path, out / UDID)
    at = tmp_path / "shortcut"
    link(folder, at)
    refused(manager, at, trash_backup.A_LINK)
    assert folder.is_dir()


def test_not_one_already_in_a_trash(manager, tmp_path):
    for bin_name in (".Trash", "$RECYCLE.BIN", ".Trash-1000"):
        folder = make(tmp_path, tmp_path.resolve() / bin_name / UDID, seed=hash(bin_name) % 1000)
        refused(manager, folder, trash_backup.already_in_bin())


def test_not_when_the_trash_wouldnt_keep_it(manager, tmp_path, out, monkeypatch):
    folder = make(tmp_path, out / UDID)
    asked = []

    def problem(path, room, longest):
        asked.append(room)
        return trash_room.BIN_TOO_FULL if room else None

    monkeypatch.setattr(trash_room, "problem", problem)
    refused(manager, folder, trash_room.BIN_TOO_FULL)
    # Asked first with nothing, to refuse quickly, then with the folder's real size.
    assert asked[0] == 0 and asked[1] > 0


def test_on_linux_never(manager, tmp_path, out, monkeypatch):
    folder = make(tmp_path, out / UDID)
    monkeypatch.setattr(trash_room, "problem", REAL_PROBLEM)
    monkeypatch.setattr(sys, "platform", "linux")
    refused(manager, folder, trash_room.NOT_HERE)
