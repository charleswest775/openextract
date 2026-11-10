"""
Backups made by iOS 9 and earlier: Manifest.mbdb instead of Manifest.db (in-app report OE-13).

iTunes kept these backups' files flat in the backup folder and listed them in
Manifest.mbdb. They weren't recognised as backups at all. ios-backup-core now
reads them (encrypted ones too) and the older databases inside them; these
tests drive the engine's own methods over backups that ios-backup-core's
backupgen writes the old way (backupgen/legacy.py), against its answer key.

Encrypted backups made by iOS 10.0 and 10.1 (issue #107) use Manifest.db but
still the older keybag, without DPSL, and used to fail with "Failed to decrypt
backup: b'DPSL'". backupgen.legacy writes those too (--ios 10.1.1).

Needs ios-backup-core with backupgen.legacy: skipped without it, or failed when
OPENEXTRACT_REQUIRE_GENERATED=1 (CI).
"""

import base64
import importlib
import json
import os
import sys
from pathlib import Path

import pytest

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from rpc_contract_support import load_engine_module, skip_or_fail  # noqa: E402
from corpus.synthetic import backupgen_root  # noqa: E402

PASSWORD = "test"
JPEG_MAGIC = b"\xff\xd8\xff"
# (iOS version, password): the oldest and newest releases with Manifest.mbdb, an encrypted one,
# and an encrypted iOS 10.1 one (Manifest.db, keybag without DPSL).
BACKUPS = [("6.1.6", None), ("9.3.5", None), ("9.3.5", PASSWORD), ("10.1.1", PASSWORD)]


def _generate_legacy():
    root = backupgen_root()
    if root is None:
        skip_or_fail("ios-backup-core's backupgen wasn't found; set OPENEXTRACT_IOS_BACKUP_CORE")
    if not (root / "backupgen" / "legacy.py").is_file():
        skip_or_fail(f"the ios-backup-core checkout at {root} has no backupgen/legacy.py; update it")
    if str(root) not in sys.path:
        sys.path.insert(0, str(root))
    generate_legacy = importlib.import_module("backupgen.legacy").generate_legacy

    def generate(out, *, ios, **kwargs):
        backup_dir = generate_legacy(out, ios=ios, **kwargs)
        if ios.startswith("10.") and not (backup_dir / "Manifest.db").is_file():
            skip_or_fail(f"the ios-backup-core checkout at {root} can't write iOS 10.0/10.1 backups; update it")
        return backup_dir

    return generate


@pytest.fixture(scope="module")
def server():
    srv = load_engine_module().SidecarServer()
    yield srv
    for udid in list(srv.backup_manager._open_backups):
        srv.backup_manager.close_backup(udid)


def _call(server, method, **params):
    result = server.methods[method](params)
    # What the app gets must be plain JSON as it is: an iOS 6 backup's photo UUIDs
    # came back as raw bytes, and writing them ended the engine (OE-26 to OE-28).
    json.dumps(result)
    return result


@pytest.fixture(scope="module", params=BACKUPS, ids=lambda b: f"ios{b[0]}-{'encrypted' if b[1] else 'plain'}")
def opened(request, server, tmp_path_factory):
    ios, password = request.param
    out = tmp_path_factory.mktemp(f"old-{ios}")
    backup_dir = _generate_legacy()(out, ios=ios, password=password)
    expected = json.loads((out / "expected.json").read_text(encoding="utf-8"))
    (info,) = _call(server, "list_backups", path=str(out))["backups"]
    if password:
        assert _call(server, "open_backup", udid=info["udid"], backup_dir=str(backup_dir))["status"] \
            == "password_required"
    result = _call(server, "open_backup", udid=info["udid"], backup_dir=str(backup_dir), password=password)
    assert result["status"] == "open"
    return {"udid": info["udid"], "info": info, "dir": backup_dir, "expected": expected}


def test_listed_with_its_details(opened):
    info, expected = opened["info"], opened["expected"]
    assert info["manifest_format"] == expected["manifest_format"]
    assert info["product_version"] == expected["ios"]
    assert info["device_name"] == "Sam's iPhone"
    assert info["backup_dir"] == str(opened["dir"])
    assert info["last_backup"].startswith("2016-09-10T18:30:00")


def test_size_counts_the_stored_files(server, opened):
    size = _call(server, "get_backup_size", backup_dir=str(opened["dir"]))
    if opened["info"]["manifest_format"] == "mbdb":
        files = list(opened["dir"].iterdir())  # flat in the folder
    else:
        files = [f for d in opened["dir"].iterdir() if d.is_dir() for f in d.iterdir()]
    assert size["size_bytes"] == sum(f.stat().st_size for f in files)


def test_messages(server, opened):
    udid, expected = opened["udid"], opened["expected"]
    conversations = _call(server, "list_conversations", udid=udid)["conversations"]
    assert sorted(c["chat_identifier"] for c in conversations) == \
        sorted(c["chat_identifier"] for c in expected["conversations"])
    for want in expected["conversations"]:
        got = next(c for c in conversations if c["chat_identifier"] == want["chat_identifier"])
        if want["display_name"]:
            assert got["display_name"] == want["display_name"]
        messages = _call(server, "get_messages", udid=udid, chat_id=got["chat_id"])["messages"]
        assert [m["text"] for m in messages] == [m["text"] for m in want["messages"]]
        assert [m["date"] for m in messages] == [m["date"] for m in want["messages"]]
        for message in messages:
            for attachment in message["attachments"]:
                fetched = _call(server, "get_attachment", udid=udid, attachment_id=attachment["attachment_id"])
                assert base64.b64decode(fetched["data"])[:3] == JPEG_MAGIC
                assert fetched["filename"] == "IMG_0042.JPG"
    hits = _call(server, "search_messages", udid=udid, query="Saturday")["results"]
    assert [h["text"] for h in hits] == ["Are we still on for Saturday?"]


def test_contacts_and_calls(server, opened):
    udid, expected = opened["udid"], opened["expected"]
    contacts = _call(server, "list_contacts", udid=udid)["contacts"]
    assert sorted(c["display_name"] for c in contacts) == expected["contacts"]
    calls = _call(server, "list_calls", udid=udid)["calls"]
    got = sorted((c["date"], c["contact_name"], c["direction"], c["status"], c["app"]) for c in calls)
    want = sorted((c["date"], c["contact_name"], c["direction"], c["status"], c["app"]) for c in expected["calls"])
    assert got == want


def test_photos(server, opened):
    udid, expected = opened["udid"], opened["expected"]
    photos = _call(server, "list_photos", udid=udid)["photos"]
    assert sorted(p["filename"] for p in photos) == sorted(p["filename"] for p in expected["photos"])
    # iOS 6 keeps ZUUID as 16 raw bytes; list_photos gives it as the string later releases
    # store. (Older ios-backup-core checkouts write expected.json without photo UUIDs.)
    want_uuid = {p["filename"]: p.get("uuid") for p in expected["photos"]}
    for photo in photos:
        assert isinstance(photo["uuid"], str)
        if want_uuid[photo["filename"]]:
            assert photo["uuid"] == want_uuid[photo["filename"]]
        meta = _call(server, "get_photo_metadata", udid=udid, asset_uuid=photo["uuid"])
        assert meta["filename"] == photo["filename"]
        path = _call(server, "get_photo_path", udid=udid, file_hash=photo["file_hash"])["path"]
        assert Path(path).read_bytes()[:3] == JPEG_MAGIC
        thumb = _call(server, "get_photo_thumbnail", udid=udid, file_hash=photo["file_hash"])
        assert base64.b64decode(thumb["data"])[:3] == JPEG_MAGIC
    albums = {a["title"]: a for a in _call(server, "list_albums", udid=udid)["albums"]}
    assert albums["Holiday"]["in_backup"] == 2


def test_notes(server, opened):
    udid, expected = opened["udid"], opened["expected"]
    notes = _call(server, "list_notes", udid=udid)["notes"]
    assert {n["title"]: n["body"] for n in notes} == expected["note_bodies"]


def test_dashboard_and_timeline(server, opened):
    udid = opened["udid"]
    overview = _call(server, "get_backup_stats", udid=udid)["overview"]
    assert (overview["total_messages"], overview["total_conversations"], overview["total_contacts"],
            overview["total_calls"], overview["total_photos"], overview["total_notes"]) == (7, 3, 3, 4, 3, 2)
    counts = _call(server, "get_year_counts", udid=udid, year=2012)
    assert counts["years"] == [2012, 2013]
    assert not counts["errors"]
    day = _call(server, "get_messages_on_day", udid=udid, day="2012-11-03")
    assert sum(len(c["messages"]) for c in day["conversations"]) == 3


def test_what_old_backups_lack_is_empty_not_an_error(server, opened):
    udid = opened["udid"]
    assert _call(server, "list_voicemails", udid=udid)["empty_reason"] == "not_in_backup"
    assert _call(server, "has_browser_history", udid=udid)["has_any"] is False
    recovered = _call(server, "recover_messages", udid=udid)
    assert recovered["conversations"] == [] and "error" not in recovered


def test_export(server, opened, tmp_path):
    udid = opened["udid"]
    chat_ids = [c["chat_id"] for c in _call(server, "list_conversations", udid=udid)["conversations"]]
    files = _call(server, "export_conversations", udid=udid, chat_ids=chat_ids, format="html",
                  output_dir=str(tmp_path))["files"]
    assert len(files) == 3 and all(os.path.getsize(f) for f in files)
    photos = _call(server, "list_photos", udid=udid)["photos"]
    result = _call(server, "export_photos", udid=udid, file_hashes=[p["file_hash"] for p in photos],
                   output_dir=str(tmp_path / "photos"))
    assert (result["exported"], result["errors"]) == (3, 0)


# ── opening ──────────────────────────────────────────────────────────────────


def test_found_when_the_parent_folder_is_picked(server, tmp_path):
    # Its own seed, so its UDID isn't the one the module's opened backup has.
    backup_dir = _generate_legacy()(tmp_path / "Backup", ios="7.1.2", seed=1)
    mgr = server.backup_manager
    info = mgr._find_backup_in_subdirs(str(tmp_path / "Backup"), "")
    assert info["backup_dir"] == str(backup_dir)
    assert _call(server, "open_backup", udid=info["udid"], backup_dir=str(tmp_path / "Backup"))["status"] == "open"
    mgr.close_backup(info["udid"])


@pytest.mark.parametrize("ios", ["8.4.1", "10.1.1"])
def test_wrong_password(server, tmp_path, ios):
    backup_dir = _generate_legacy()(tmp_path, ios=ios, password=PASSWORD, seed=2)
    (info,) = _call(server, "list_backups", path=str(tmp_path))["backups"]
    udid = info["udid"]
    assert info["encrypted"] is True
    assert _call(server, "validate_password", udid=udid, backup_dir=str(backup_dir), password="nope") \
        == {"valid": False, "error": "Incorrect password"}
    assert _call(server, "validate_password", udid=udid, backup_dir=str(backup_dir), password=PASSWORD) \
        == {"valid": True}
    with pytest.raises(ValueError, match="incorrect passphrase"):
        _call(server, "open_backup", udid=udid, backup_dir=str(backup_dir), password="nope")


def test_damaged_manifest_says_so(server, tmp_path):
    backup_dir = _generate_legacy()(tmp_path, ios="9.3.5", seed=3)
    mbdb = backup_dir / "Manifest.mbdb"
    mbdb.write_bytes(mbdb.read_bytes()[:-10])
    (info,) = _call(server, "list_backups", path=str(tmp_path))["backups"]
    with pytest.raises(ValueError, match=r"iOS 9 or earlier.*damaged"):
        _call(server, "open_backup", udid=info["udid"], backup_dir=str(backup_dir))
    assert server.backup_manager._open_backups.get(server.backup_manager._norm_udid(info["udid"])) is None
