"""Contract tests for the engine's JSON-RPC interface: every method, through the real process.

Each method in ``SidecarServer.methods`` (python/main.py) has a case in CONTRACT
below. The cases start the real engine (python/main.py, or the binary named by
``$OPENEXTRACT_SIDECAR``), open a generated backup and call the method over
stdin/stdout the way the app does, then check what comes back: its shape, the
files it writes, and the values the backup's answer key gives.
test_every_engine_method_has_a_contract_case fails when the engine serves a
method with no case here, and says what to add.

Backups: Maren (every data type filled; encrypted copy, password "test") and
Einstein (Messages and Contacts only, so every other method must come back
cleanly empty), written by ios-backup-core's backupgen (corpus/synthetic.py)
into the corpus cache. WhatsApp, which backupgen doesn't write, comes from
whatsapp_backup.py: a copy of Einstein's backup with WhatsApp added (so
sms.db's ids and WhatsApp's collide) and an encrypted backup holding only
WhatsApp. Podcasts, likewise, come from podcasts_backup.py: a copy of
Einstein's backup with an Apple Podcasts library added, and an encrypted
backup holding only that library. Without backupgen, or without network the first time
Maren's photos are needed, these tests skip, unless OPENEXTRACT_REQUIRE_GENERATED=1
(set in CI) makes that a failure.

The corpus tests (python/tests/corpus, run with -m corpus) compare every record
with the answer keys. This file checks the interface: every method answers with
the right shape or a clean error, the engine survives bad input, stdout carries
nothing but JSON-RPC, and the common calls stay fast (PERF_BUDGETS).

    pytest python/tests/test_rpc_contract.py -v
"""

from __future__ import annotations

import hashlib
import html
import io
import json
import os
import re
import shutil
import sys
import time
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import datetime
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Callable

import pytest
from PIL import Image, ImageOps

sys.path.insert(0, str(Path(__file__).resolve().parent))
from rpc_contract_support import (  # noqa: E402
    AMR_MAGIC,
    DELETED_AT,
    DEVICE_SETUP_PREFIXES,
    EINSTEIN,
    EINSTEIN_ENCRYPTED,
    JPEG_MAGIC,
    MAREN,
    MAREN_ENCRYPTED,
    PDF_MAGIC,
    VOICEMAIL_TRANSCRIPT,
    BackupEngine,
    ContractRuntime,
    Engine,
    ProtocolError,
    SidecarError,
    assert_error_dict,
    decoded,
    engine_methods,
    files_under,
    generated_backup,
    local_day,
    methods_needing_an_open_backup,
    read_csv,
    same_path,
)
from bundle_schema import check_bundle, read_lines  # noqa: E402
import whatsapp_backup as wb  # noqa: E402
import podcasts_backup as pb  # noqa: E402

# ── Performance budgets ──────────────────────────────────────────────────────
# Seconds of wall-clock time for one cold call on a freshly started engine with
# Maren's backup (1,410 messages, 170 photos), timed from this process, so they
# include the JSON-RPC round trip. Measured on an M-series Mac (2026-11, worst
# of 3 runs): engine start 0.24 s; open_backup 0.002; list_conversations 0.005;
# get_messages 0.004; list_photos 0.012; get_photo_thumbnail 0.056;
# search_messages 0.014; get_backup_stats 0.013; get_year_counts 0.013;
# get_attachment's thumbnail 0.011. On a Windows 11 PC: start 0.27 s, every
# call 0.025 s or less.
# A budget is 4x that, rounded up, but never under 1 s for a call (10 s to
# start): hosted CI runners are several times slower and Windows ones add
# Defender scans and slow first file opens, and a flaky budget is worse than
# none. So these catch a call becoming 100x slower (a scan per row, a re-read
# per page), not a 2x drift. test_performance_budgets prints the measured
# times, so the CI log shows the trend.
PERF_BUDGETS = {
    "engine_start": 10.0,        # process start to the {"status":"ready"} line (imports)
    "open_backup": 1.0,
    "list_conversations": 1.0,
    "get_messages": 1.0,         # first page (50) of the biggest conversation
    "get_attachment_thumb": 1.0,  # a message photo's first thumbnail: decode a 1600 px JPEG, scale, re-encode
    "list_photos": 1.0,          # first page (100)
    "get_photo_thumbnail": 1.0,  # first thumbnail: decode a 1600 px JPEG, scale, re-encode
    "search_messages": 1.0,      # a common word across every conversation
    "get_backup_stats": 1.0,     # reads every database in the backup
    "get_year_counts": 1.0,      # first call: counts every data type for the whole backup
}

SEARCH_WORD = "bread"  # in Maren's busiest conversation more than once
FAKE_UDID = "00000000-0000000000000000"  # no iPhone has it; no CI runner has an iPhone at all
TIMELINE_TYPES = {"message", "call", "photo", "voicemail", "note", "browser"}
PERSON_TYPES = {"message", "call", "voicemail"}
BACKUP_PHASES = {"negotiating", "waiting", "passcode", "backing_up", "finalizing"}


# ── Fixtures ─────────────────────────────────────────────────────────────────

@pytest.fixture(scope="session")
def runtime(tmp_path_factory):
    rt = ContractRuntime(tmp_path_factory)
    yield rt
    rt.close()


class Ctx:
    """What a contract case can use: the shared engines (started on first use) and a temp folder."""

    def __init__(self, runtime: ContractRuntime, tmp_path: Path):
        self.runtime = runtime
        self.tmp = tmp_path

    @property
    def maren(self) -> BackupEngine:
        return self.runtime.backup(MAREN)

    @property
    def maren_enc(self) -> BackupEngine:
        return self.runtime.backup(MAREN_ENCRYPTED)

    @property
    def einstein(self) -> BackupEngine:
        return self.runtime.backup(EINSTEIN)

    @property
    def whatsapp(self) -> BackupEngine:
        """Einstein's backup with WhatsApp added; ``.plan.scenario`` says what's in it."""
        return self.runtime.whatsapp()

    @property
    def whatsapp_enc(self) -> BackupEngine:
        """An encrypted backup holding only WhatsApp (password "test")."""
        return self.runtime.whatsapp(encrypted=True)

    @property
    def person(self) -> BackupEngine:
        """Einstein's backup with WhatsApp, call history, voicemail and Messages attachments added, the
        ids colliding across Messages and WhatsApp; ``.plan`` says what's in it (make_person_copy)."""
        return self.runtime.person()

    @property
    def podcasts(self) -> BackupEngine:
        """Einstein's backup with an Apple Podcasts library added; ``.plan.scenario`` says what's in it."""
        return self.runtime.podcasts()

    @property
    def podcasts_enc(self) -> BackupEngine:
        """An encrypted backup holding only the Podcasts library (password "test")."""
        return self.runtime.podcasts(encrypted=True)

    @property
    def plain(self) -> Engine:
        """An engine with no backup open."""
        return self.runtime.engine("plain")

    @property
    def device(self) -> Engine:
        """The engine for the live-iPhone methods, kept apart from the backup engines."""
        return self.runtime.engine("device")

    def out(self, name: str) -> Path:
        """A path in the test's temp folder that doesn't exist yet."""
        return self.tmp / name

    def folder(self, name: str) -> Path:
        """A new, empty folder (the app's folder picker always hands over an existing one)."""
        path = self.tmp / name
        path.mkdir(parents=True)
        return path


@pytest.fixture
def ctx(runtime, tmp_path) -> Ctx:
    return Ctx(runtime, tmp_path)


# ── One case per engine method ───────────────────────────────────────────────

CONTRACT: dict[str, Callable[[Ctx], None]] = {}


def contract(method: str):
    def register(case):
        assert method not in CONTRACT, f"two contract cases for {method}"
        CONTRACT[method] = case
        return case
    return register


@contract("ping")
def case_ping(ctx):
    result = ctx.plain.call("ping")
    assert result["status"] == "ok"
    assert isinstance(result["version"], str) and result["version"]


@contract("list_backups")
def case_list_backups(ctx):
    m = ctx.maren
    # A backup folder itself: that backup and nothing else (#81)
    result = m.call("list_backups", {"path": str(m.backup_dir)})
    assert len(result["backups"]) == 1, result
    found = result["backups"][0]
    assert found["udid"] == m.udid
    assert same_path(found["backup_dir"], m.backup_dir)
    assert found["encrypted"] is False
    assert found["product_version"] == m.expected["ios"]
    assert found["product_type"] == m.expected["product_type"]
    assert found["device_name"]
    assert found["size_bytes"] is None  # get_backup_size works it out later
    # A folder holding backups: each one in it
    result = m.call("list_backups", {"path": str(m.backup_dir.parent)})
    assert [b["udid"] for b in result["backups"]] == [m.udid]
    assert same_path(result["search_dirs"][0], m.backup_dir.parent)
    enc = ctx.maren_enc
    assert [b["encrypted"] for b in enc.call("list_backups", {"path": str(enc.backup_dir)})["backups"]] == [True]
    # No path: the OS's usual folders. What's in them depends on the machine, so the shape only.
    result = ctx.plain.call("list_backups", {})
    assert isinstance(result["backups"], list) and isinstance(result["search_dirs"], list)
    assert isinstance(result.get("permission_denied", []), list)
    for backup in result["backups"]:
        assert {"udid", "backup_dir", "encrypted", "device_name"} <= set(backup), backup


@contract("open_backup")
def case_open_backup(ctx):
    m = ctx.maren
    result = m.open()  # opening again replaces the open backup
    assert result["status"] == "open"
    info = result["info"]
    assert info["udid"] == m.udid and info["encrypted"] is False
    assert info["product_version"] == m.expected["ios"]
    assert same_path(info["backup_dir"], m.backup_dir)
    assert len(m.rpc("list_conversations")["conversations"]) == len(m.expected["conversations"])

    enc = ctx.maren_enc
    result = enc.open(password=None)
    assert result["status"] == "password_required" and result["info"]["encrypted"] is True
    err = enc.error("open_backup", {"udid": enc.udid, "password": "not-the-password", "backup_dir": str(enc.backup_dir)})
    assert re.search(r"decrypt|password|passphrase", err.message, re.I), err.message
    # Neither attempt closed the backup that was already open
    assert len(enc.rpc("list_conversations")["conversations"]) == len(enc.expected["conversations"])
    result = enc.open()
    assert result["status"] == "open" and result["info"]["encrypted"] is True

    # An empty folder and a UDID no backup has: an error the UI can show
    err = ctx.plain.error("open_backup", {"udid": FAKE_UDID, "backup_dir": str(ctx.folder("not-a-backup"))})
    assert err.message.startswith(("BACKUP_MISSING:", "FULL_DISK_ACCESS_REQUIRED:")), err.message


@contract("validate_password")
def case_validate_password(ctx):
    enc = ctx.maren_enc
    params = {"udid": enc.udid, "backup_dir": str(enc.backup_dir)}
    assert enc.call("validate_password", {**params, "password": enc.password}) == {"valid": True}
    result = enc.call("validate_password", {**params, "password": "not-the-password"})
    assert result["valid"] is False and result["error"], result
    m = ctx.maren  # not encrypted: any password will do
    assert m.call("validate_password", {"udid": m.udid, "password": "x", "backup_dir": str(m.backup_dir)}) == {"valid": True}
    result = ctx.plain.call("validate_password", {"udid": FAKE_UDID, "password": "x", "backup_dir": str(ctx.folder("empty"))})
    assert result == {"valid": False, "error": "Backup not found"}


@contract("get_backup_size")
def case_get_backup_size(ctx):
    m = ctx.maren
    # The engine's definition: the files in the backup's two-character folders
    on_disk = sum(
        f.stat().st_size
        for d in m.backup_dir.iterdir() if d.is_dir() and len(d.name) == 2
        for f in d.iterdir() if f.is_file()
    )
    for _ in range(2):  # the second answer comes from ~/.openextract/size_cache.json
        result = m.call("get_backup_size", {"backup_dir": str(m.backup_dir)})
        assert result["size_bytes"] == on_disk > 0
        assert result["size_gb"] == round(on_disk / 1024 ** 3, 2)


@contract("check_backup_files")
def case_check_backup_files(ctx):
    # A backup that finished has every file it lists in its folder (OE-102 was one that didn't).
    for engine in (ctx.maren, ctx.maren_enc):
        result = engine.rpc("check_backup_files")
        assert result["listed"] > 0, result
        assert result["missing"] == 0, result
        assert result["missing_by_area"] == {"photos": 0, "messages": 0, "other": 0}


@contract("list_conversations")
def case_list_conversations(ctx):
    m = ctx.maren
    result = m.rpc("list_conversations")
    assert "error" not in result and "empty_reason" not in result, result
    conversations = result["conversations"]
    expected = {c["chat_identifier"]: c for c in m.expected["conversations"]}
    assert sorted(c["chat_identifier"] for c in conversations) == sorted(expected)
    assert sum(c["message_count"] for c in conversations) == len(m.expected["messages"])
    for c in conversations:
        assert isinstance(c["chat_id"], int) and isinstance(c["message_count"], int)
        assert isinstance(c["display_name"], str) and c["display_name"]
        assert c["is_group"] is expected[c["chat_identifier"]]["is_group"]
        local_day(c["last_message_date"])  # a real ISO 8601 time


@contract("get_messages")
def case_get_messages(ctx):
    m = ctx.maren
    conv = m.biggest_conversation
    chat_id, total = conv["chat_id"], conv["message_count"]
    page = m.rpc("get_messages", chat_id=chat_id, offset=0, limit=50)
    assert (page["total"], page["offset"], page["limit"], page["next_offset"]) == (total, 0, 50, 50)
    assert len(page["messages"]) == 50
    ids = [msg["message_id"] for msg in page["messages"]]
    assert ids == sorted(ids) and len(set(ids)) == 50  # oldest first within the page
    for msg in page["messages"]:
        assert {"message_id", "text", "date", "is_from_me", "sender", "attachments", "is_reaction"} <= set(msg)
        assert isinstance(msg["is_from_me"], bool) and isinstance(msg["attachments"], list)
        local_day(msg["date"])
    # The next page holds the 50 before those
    older = m.rpc("get_messages", chat_id=chat_id, offset=50, limit=50)["messages"]
    assert len(older) == 50 and max(msg["message_id"] for msg in older) < min(ids)
    # The last page is short and ends the conversation
    last = m.rpc("get_messages", chat_id=chat_id, offset=total - 7, limit=50)
    assert len(last["messages"]) == 7 and last["next_offset"] == total
    # A date range with nothing in it
    empty = m.rpc("get_messages", chat_id=chat_id, offset=0, limit=50,
                  date_from="1990-01-01T00:00:00Z", date_to="1990-12-31T23:59:59Z")
    assert empty["messages"] == [] and empty["total"] == 0


@contract("get_attachment")
def case_get_attachment(ctx):
    for engine in (ctx.maren, ctx.maren_enc):
        with_attachment = [msg for msg in engine.expected["messages"] if msg["attachment"]]
        assert len(engine.attachments) == len(with_attachment) > 0
        # get_messages says what each one is and that its file is in the backup
        for _, _, att in engine.attachments:
            assert att["available"] is True and att["is_sticker"] is False, att
            assert att["uti"] == "public.jpeg", att
        for _, _, att in engine.attachments[:6]:
            what = f"attachment {att['attachment_id']}"
            result = engine.rpc("get_attachment", attachment_id=att["attachment_id"])
            data = decoded(result, what)
            assert result["filename"] == att["transfer_name"]
            assert result["mime_type"] == att["mime_type"] == "image/jpeg"
            assert data.startswith(JPEG_MAGIC) and len(data) == att["total_bytes"] == result["size"]
            # A thumbnail: a small JPEG, with the whole photo's size as it is shown
            thumb = engine.rpc("get_attachment", attachment_id=att["attachment_id"], thumbnail=True)
            small = decoded(thumb, f"{what} thumbnail")
            assert thumb["mime_type"] == "image/jpeg" and small.startswith(JPEG_MAGIC) and len(small) < len(data)
            assert (thumb["filename"], thumb["size"]) == (att["transfer_name"], att["total_bytes"])
            with Image.open(io.BytesIO(small)) as img, Image.open(io.BytesIO(data)) as photo:
                assert max(img.size) <= 400, img.size
                assert (thumb["width"], thumb["height"]) == ImageOps.exif_transpose(photo).size
            assert engine.rpc("get_attachment", attachment_id=att["attachment_id"], thumbnail=True) == thumb  # kept
            # A copy under its own name, outside the backup, in the engine's folder of copies
            copy = engine.rpc("get_attachment", attachment_id=att["attachment_id"], as_file=True)
            path = Path(copy["path"])
            assert path.name == att["transfer_name"] and path.read_bytes() == data
            assert (copy["mime_type"], copy["filename"], copy["size"], copy["openable"]) == \
                ("image/jpeg", att["transfer_name"], att["total_bytes"], True)
            assert engine.backup_dir.resolve() not in path.resolve().parents
            assert path.parent.parent.parent.name.startswith("openextract-messages-"), path
        for flags in ({}, {"thumbnail": True}, {"as_file": True}):
            assert engine.rpc("get_attachment", attachment_id=10 ** 9, **flags) == {"error": "Attachment not found"}

    # A backup copied only partway (OE-102): one photo's file isn't in its folder
    m = ctx.maren
    _, _, gone = m.attachments[0]
    partial = ctx.tmp / "partial" / m.udid
    shutil.copytree(m.backup_dir, partial, copy_function=_link_or_copy)
    file_id = hashlib.sha1(f"MediaDomain-{gone['filename'].removeprefix('~/')}".encode()).hexdigest()
    (partial / file_id[:2] / file_id).unlink()
    engine = ctx.runtime.fresh("partial")
    assert engine.call("open_backup", {"udid": m.udid, "backup_dir": str(partial)})["status"] == "open"
    page = engine.call("get_messages", {"udid": m.udid, "chat_id": next(c for c, msg, a in m.attachments if a is gone),
                                        "offset": 0, "limit": 10_000})
    found = {a["attachment_id"]: a["available"] for msg in page["messages"] for a in msg["attachments"]}
    assert found[gone["attachment_id"]] is False and sum(found.values()) == len(found) - 1, found
    for flags in ({}, {"thumbnail": True}, {"as_file": True}):
        result = engine.call("get_attachment", {"udid": m.udid, "attachment_id": gone["attachment_id"], **flags})
        assert result == {"error": "This file isn't in the backup", "empty_reason": "not_in_backup"}, (flags, result)


def _link_or_copy(src, dest):
    """Copy a backup's file for a test that changes the copy: a hard link where the disk allows one (quick)."""
    try:
        os.link(src, dest)
    except OSError:
        shutil.copy2(src, dest)
    return dest


@contract("get_message_offset")
def case_get_message_offset(ctx):
    m = ctx.maren
    conv = m.biggest_conversation
    messages = m.messages_of(conv["chat_id"])
    assert len(messages) == conv["message_count"]
    for target in (messages[-1], messages[len(messages) // 2], messages[3], messages[0]):
        result = m.rpc("get_message_offset", chat_id=conv["chat_id"], message_id=target["message_id"])
        newer = sum(1 for msg in messages if msg["message_id"] > target["message_id"])
        assert result == {"offset": newer, "found": True}
        # That offset opens the conversation at the message
        page = m.rpc("get_messages", chat_id=conv["chat_id"], offset=result["offset"], limit=1)
        assert page["messages"][0]["message_id"] == target["message_id"]
    other = next(c for c in m.conversations if c["chat_id"] != conv["chat_id"])
    result = m.rpc("get_message_offset", chat_id=other["chat_id"], message_id=messages[0]["message_id"])
    assert result["found"] is False


@contract("search_messages")
def case_search_messages(ctx):
    m = ctx.maren
    conv = m.biggest_conversation
    messages = [msg for msg in m.messages_of(conv["chat_id"])
                if not msg["is_reaction"] and len(msg["text"] or "") >= 20]
    target = messages[len(messages) // 3]
    query = target["text"][3:18]
    result = m.rpc("search_messages", query=query)
    assert result["query"] == query
    assert target["message_id"] in {r["message_id"] for r in result["results"]}
    for r in result["results"]:
        assert query.lower() in r["text"].lower()
        assert {"message_id", "text", "date", "is_from_me", "sender", "chat_id"} <= set(r)
    # Only in one conversation
    in_chat = m.rpc("search_messages", query=query, chat_id=conv["chat_id"])["results"]
    assert target["message_id"] in {r["message_id"] for r in in_chat}
    assert {r["chat_id"] for r in in_chat} == {conv["chat_id"]}
    # Text beyond ASCII (UTF-8 both ways)
    fancy = next(msg for msg in messages if any(ord(ch) > 127 for ch in msg["text"]))
    query = fancy["text"][-12:]
    assert fancy["message_id"] in {r["message_id"] for r in m.rpc("search_messages", query=query)["results"]}
    # A date range that leaves the message out
    before = m.rpc("search_messages", query=target["text"], date_to="2000-01-01T00:00:00Z")["results"]
    assert target["message_id"] not in {r["message_id"] for r in before}
    # The limit, and nothing found
    assert len(m.rpc("search_messages", query="the", limit=3)["results"]) == 3
    assert m.rpc("search_messages", query="zq-no-message-says-this-7f3a")["results"] == []


@contract("list_albums")
def case_list_albums(ctx):
    m = ctx.maren
    albums = m.rpc("list_albums")["albums"]
    everything = next(a for a in albums if a["id"] == "__all__")
    assert everything["asset_count"] == everything["in_backup"] == len(m.expected["photos"])
    expected = Counter(name for photo in m.expected["photos"] for name in photo["albums"])
    assert {a["title"]: a["asset_count"] for a in albums if not a["id"].startswith("__")} == dict(expected)
    for album in albums:
        assert album["in_backup"] == album["asset_count"]  # every photo's original is in this backup
    # Favorites and Hidden follow All Photos when the engine has them (nothing in maren is hidden).
    smart = {a["id"]: a["asset_count"] for a in albums if a["id"] in ("__favorites__", "__hidden__")}
    if smart:
        favorites = sum(1 for p in m.expected["photos"] if p["favorite"] and not p["trashed"])
        assert [a["id"] for a in albums[:3]] == ["__all__", "__favorites__", "__hidden__"]
        assert smart == {"__favorites__": favorites, "__hidden__": 0}
        assert all(a["parent_id"] is None for a in albums)  # maren's albums aren't in folders


@contract("list_photos")
def case_list_photos(ctx):
    m = ctx.maren
    expected = sorted(p["filename"] for p in m.expected["photos"])
    page = m.rpc("list_photos", offset=0, limit=100)
    assert len(page["photos"]) == 100
    assert (page["total"], page["in_backup"], page["not_in_backup"]) == (len(expected), len(expected), 0)
    assert page["source"] == "photos_sqlite"
    for photo in page["photos"]:
        assert {"uuid", "filename", "file_hash", "kind", "date_created", "width", "height", "album_ids"} <= set(photo)
        assert photo["file_hash"] and photo["kind"] in ("photo", "video", "live_photo")
    rest = m.rpc("list_photos", offset=100, limit=100)["photos"]
    assert sorted(p["filename"] for p in page["photos"] + rest) == expected
    album = next(a for a in m.rpc("list_albums")["albums"] if not a["id"].startswith("__"))
    in_album = m.rpc("list_photos", offset=0, limit=500, album_id=album["id"])
    assert in_album["total"] == len(in_album["photos"]) == album["asset_count"]
    assert all(album["id"] in p["album_ids"] for p in in_album["photos"])
    favorites = m.rpc("list_photos", offset=0, limit=500, album_id="__favorites__")
    if favorites.get("source") == "photos_sqlite":  # an engine without Favorites can't filter by it
        assert all(p["favorite"] for p in favorites["photos"])
        assert favorites["total"] == sum(1 for p in m.expected["photos"] if p["favorite"] and not p["trashed"])


@contract("get_photo_thumbnail")
def case_get_photo_thumbnail(ctx):
    for engine in (ctx.maren, ctx.maren_enc):  # the encrypted one hands out "dcim:" keys
        photo = engine.photos[0]
        result = engine.rpc("get_photo_thumbnail", file_hash=photo["file_hash"], size=200)
        image = Image.open(io.BytesIO(decoded(result, "thumbnail")))
        assert result["mime_type"] == "image/jpeg" and image.format == "JPEG"
        assert max(image.size) == 200 and (result["width"], result["height"]) == image.size
        assert result["cached"] is False
        again = engine.rpc("get_photo_thumbnail", file_hash=photo["file_hash"], size=200)
        assert again["cached"] is True and again["data"] == result["data"]
        small = Image.open(io.BytesIO(decoded(engine.rpc("get_photo_thumbnail", file_hash=photo["file_hash"], size=64))))
        assert max(small.size) == 64
    assert_error_dict(ctx.maren.rpc("get_photo_thumbnail", file_hash="0" * 40), "not found")


@contract("get_photo")
def case_get_photo(ctx):
    for engine in (ctx.maren, ctx.maren_enc):
        for photo in engine.photos[:3]:
            result = engine.rpc("get_photo", file_hash=photo["file_hash"])
            data = decoded(result, "photo")
            assert result["mime_type"] == "image/jpeg" and data.startswith(JPEG_MAGIC)
            assert Image.open(io.BytesIO(data)).size == (photo["width"], photo["height"])
    assert_error_dict(ctx.maren.rpc("get_photo", file_hash="0" * 40), "not found")


@contract("get_photo_path")
def case_get_photo_path(ctx):
    for engine in (ctx.maren, ctx.maren_enc):
        photo = engine.photos[0]
        result = engine.rpc("get_photo_path", file_hash=photo["file_hash"])
        assert set(result) == {"path", "filename", "openable"}
        path = Path(result["path"])
        assert path.is_file() and path.stat().st_size > 0
        assert path.read_bytes()[:3] == JPEG_MAGIC
        # A file another app can open, so never the backup's own: there it is named by its
        # hash, with no extension, and macOS can run it instead of opening it (#297). An
        # unencrypted backup's is a copy under the iPhone's name; an encrypted one's is the
        # temp file it was decrypted to, which keeps the extension.
        assert result["openable"] is True and result["filename"] == photo["filename"]
        assert path.suffix == Path(photo["filename"]).suffix
        assert not path.resolve().is_relative_to(engine.backup_dir.resolve())
        if not engine.encrypted:
            assert path.name == photo["filename"]
    assert_error_dict(ctx.maren.rpc("get_photo_path", file_hash="0" * 40), "not found")


@contract("get_photo_metadata")
def case_get_photo_metadata(ctx):
    m = ctx.maren
    expected = {p["filename"]: p for p in m.expected["photos"]}
    titles = {a["id"]: a["title"] for a in m.rpc("list_albums")["albums"]}
    for photo in m.photos[:5]:
        meta = m.rpc("get_photo_metadata", asset_uuid=photo["uuid"])
        assert meta["uuid"] == photo["uuid"] and meta["filename"] == photo["filename"]
        want = expected[photo["filename"]]
        assert sorted(meta["album_names"]) == sorted(want["albums"]) == sorted(titles[i] for i in meta["album_ids"])
        assert abs(meta["latitude"] - want["lat"]) < 1e-5 and abs(meta["longitude"] - want["lon"]) < 1e-5
        assert (meta["width"], meta["height"]) == (want["width"], want["height"])
    assert_error_dict(m.rpc("get_photo_metadata", asset_uuid="00000000-0000-0000-0000-000000000000"), "not found")


@contract("list_voicemails")
def case_list_voicemails(ctx):
    m = ctx.maren
    voicemails = m.rpc("list_voicemails")["voicemails"]
    assert sorted((v["id"], v["duration"]) for v in voicemails) == \
        sorted((v["rowid"], v["duration"]) for v in m.expected["voicemails"])
    for v in voicemails:
        assert {"phone_number", "contact_name", "date_received", "is_read", "transcript", "folder"} <= set(v)
        assert v["folder"] == "voicemail"
        local_day(v["date_received"])
    everything = m.rpc("list_voicemails", include_deleted=True)
    assert everything["voicemails"] == voicemails
    assert everything["counts"] == {"voicemail": len(voicemails), "spam": 0, "deleted": 0}


@contract("get_voicemail_audio")
def case_get_voicemail_audio(ctx):
    for engine in (ctx.maren, ctx.maren_enc):
        for v in engine.voicemails:
            result = engine.rpc("get_voicemail_audio", voicemail_id=v["id"])
            assert decoded(result, f"voicemail {v['id']}").startswith(AMR_MAGIC)
            assert result["mime_type"] == "audio/amr" and result["voicemail_id"] == v["id"]
    assert_error_dict(ctx.maren.rpc("get_voicemail_audio", voicemail_id=10 ** 6), "isn't in the backup")
    assert_error_dict(ctx.maren.rpc("get_voicemail_audio", voicemail_id="../../Manifest"), "isn't in the backup")


@contract("list_calls")
def case_list_calls(ctx):
    enc = ctx.maren_enc  # iOS backs call history up only when the backup is encrypted
    expected = len(enc.expected["calls"])
    page = enc.rpc("list_calls", offset=0, limit=100)
    assert page["total"] == expected and len(page["calls"]) == min(100, expected)
    rest = enc.rpc("list_calls", offset=100, limit=100)["calls"]
    ids = [c["call_id"] for c in page["calls"] + rest]
    assert len(ids) == len(set(ids)) == expected
    for call in page["calls"]:
        assert {"address", "contact_name", "date", "duration", "direction", "status", "app"} <= set(call)
        assert call["direction"] in ("incoming", "outgoing")
        local_day(call["date"])
    # Unencrypted: no call history, but each voicemail shows as a missed call
    plain = ctx.maren.rpc("list_calls", offset=0, limit=100)
    assert plain["total"] == len(plain["calls"]) == len(ctx.maren.expected["voicemails"])
    assert {c["status"] for c in plain["calls"]} == {"missed"}


@contract("list_contacts")
def case_list_contacts(ctx):
    m = ctx.maren
    contacts = m.rpc("list_contacts")["contacts"]
    assert len(contacts) == len(m.expected["contacts"])
    owner = next(c for c in m.expected["contacts"] if c.get("is_owner"))
    assert f"{owner['first']} {owner['last']}" in {c["display_name"] for c in contacts}
    for c in contacts:
        assert isinstance(c["phones"], list) and isinstance(c["emails"], list) and c["display_name"]


@contract("list_notes")
def case_list_notes(ctx):
    m = ctx.maren
    notes = m.rpc("list_notes")["notes"]
    assert sorted(n["title"] for n in notes) == sorted(n["title"] for n in m.expected["notes"])
    assert len({n["note_id"] for n in notes}) == len(notes)
    for n in notes:
        assert n["body"] and local_day(n["created"]) and local_day(n["modified"])


@contract("export_conversation")
def case_export_conversation(ctx):
    m = ctx.maren
    conv = m.biggest_conversation
    messages = m.messages_of(conv["chat_id"])
    sample = next(msg for msg in messages if msg["text"] and "\n" not in msg["text"] and not msg["attachments"])
    first_word = re.match(r"\w+", conv["display_name"]).group(0)
    for fmt, suffix in (("txt", ".txt"), ("csv", ".csv"), ("html", ".html"), ("pdf_source", ".html")):
        out = ctx.folder(f"conversation-{fmt}")
        result = m.rpc("export_conversation", chat_id=conv["chat_id"], format=fmt, output_dir=str(out),
                       display_name=conv["display_name"])
        path = Path(result["file"])
        assert same_path(path.parent, out) and path.suffix == suffix and first_word in path.name
        assert result["message_count"] == conv["message_count"]
        assert path.stat().st_size > 0
        if fmt == "txt":
            assert sample["text"] in path.read_text(encoding="utf-8-sig")
        elif fmt == "csv":
            rows = read_csv(path)
            assert rows[0] == ["Date", "Sender", "Text", "Is From Me", "Has Attachments"]
            assert len(rows) - 1 == conv["message_count"]
            assert sample["text"] in {row[2] for row in rows[1:]}
        else:
            page = path.read_text(encoding="utf-8")
            assert page.startswith("<!DOCTYPE html>") and html.escape(sample["text"]) in page
        if fmt == "pdf_source":  # images drawn inline, from an attachments/ folder beside the page
            images = set(re.findall(r'<img src="(attachments/[^"]+)"', page))
            expected = {a["attachment_id"] for msg in messages for a in msg["attachments"]
                        if (a["mime_type"] or "").startswith("image/")}
            assert len(images) == len(expected) > 0
            for rel in images:
                assert (out / rel).read_bytes()[:3] == JPEG_MAGIC
    # Only the messages a search matches (CSV: see test_search_results_export_as_csv)
    matches = m.rpc("search_messages", query=SEARCH_WORD, chat_id=conv["chat_id"])["results"]
    for fmt in ("txt", "html"):
        result = m.rpc("export_conversation", chat_id=conv["chat_id"], format=fmt,
                       output_dir=str(ctx.folder(f"conversation-query-{fmt}")), query=SEARCH_WORD)
        assert result["message_count"] == len(matches) > 0
    assert_error_dict(m.rpc("export_conversation", chat_id=conv["chat_id"], format="docx",
                            output_dir=str(ctx.folder("conversation-docx"))), "Unsupported format")


# search_messages results have no has_attachments; the CSV export reads it.
# The app's current Save buttons don't pass a query, but the RPC takes one.
@pytest.mark.parametrize("method", ["export_conversation", "export_conversations"])
def test_search_results_export_as_csv(ctx, method):
    m = ctx.maren
    conv = m.biggest_conversation
    matches = m.rpc("search_messages", query=SEARCH_WORD, chat_id=conv["chat_id"])["results"]
    out = ctx.folder("query-csv")
    if method == "export_conversation":
        params = {"chat_id": conv["chat_id"]}
    else:
        params = {"chat_ids": [conv["chat_id"]], "mode": "merged",
                  "conversation_names": {str(conv["chat_id"]): conv["display_name"]}}
    try:
        result = m.rpc(method, format="csv", output_dir=str(out), query=SEARCH_WORD, **params)
    except SidecarError as e:
        pytest.fail(f"{method} (csv, with a query) failed: {e.message}")
    assert result["message_count"] == len(matches) > 0
    path = Path(result.get("file") or result["files"][0])
    assert len(read_csv(path)) - 1 == len(matches)


@contract("export_conversations")
def case_export_conversations(ctx):
    m = ctx.maren
    two = sorted(m.conversations, key=lambda c: c["message_count"])[:2]
    names = {str(c["chat_id"]): c["display_name"] for c in two}
    total = sum(c["message_count"] for c in two)
    out = ctx.folder("separate")
    result = m.rpc("export_conversations", chat_ids=[c["chat_id"] for c in two], conversation_names=names,
                   format="csv", output_dir=str(out), mode="separate")
    assert result["message_count"] == total and len(result["files"]) == 2
    assert sorted(len(read_csv(Path(f))) - 1 for f in result["files"]) == sorted(c["message_count"] for c in two)
    assert len(files_under(out)) == 2
    out = ctx.folder("merged")
    result = m.rpc("export_conversations", chat_ids=[c["chat_id"] for c in two], conversation_names=names,
                   format="txt", output_dir=str(out), mode="merged")
    assert result["message_count"] == total and len(result["files"]) == 1
    text = Path(result["files"][0]).read_text(encoding="utf-8-sig")
    assert all(name in text for name in names.values())


@contract("export_photos")
def case_export_photos(ctx):
    m = ctx.maren
    filenames = sorted(p["filename"] for p in m.expected["photos"])
    out = ctx.out("photos")  # missing: the engine makes it
    seen = len(m.notifications)
    result = m.rpc("export_photos", output_dir=str(out))
    assert (result["exported"], result["errors"], result["not_in_backup"]) == (len(filenames), 0, 0)
    # How far along it is, for "Saving 12 of 40 photos and videos…": ends at the total, never goes back.
    progress = [n["params"] for n in m.notifications[seen:]]
    assert progress and all(n["method"] == "export.progress" for n in m.notifications[seen:])
    assert {p["kind"] for p in progress} == {"photos"} and {p["total"] for p in progress} == {len(filenames)}
    assert [p["done"] for p in progress] == sorted(p["done"] for p in progress)
    assert (progress[0]["done"], progress[-1]["done"], progress[-1]["failed"]) == (0, len(filenames), 0)
    assert same_path(result["output_dir"], out)
    written = files_under(out)
    assert sorted(p.name for p in written) == filenames and all(p.parent == out for p in written)
    assert all(p.stat().st_size > 0 for p in written)
    assert all(p.read_bytes()[:3] == JPEG_MAGIC for p in written[::17])
    shutil.rmtree(out)  # 100 MB; don't leave it in pytest's temp folders

    out = ctx.out("photos-by-date")
    result = m.rpc("export_photos", output_dir=str(out),
                   options={"folder_structure": "by_date", "include_metadata_sidecar": True})
    assert result["exported"] == len(filenames) and result["errors"] == 0
    by_name = {p["filename"]: p for p in m.photos}
    images = [p for p in files_under(out) if p.suffix != ".json"]
    assert sorted(p.name for p in images) == filenames
    assert len([p for p in files_under(out) if p.suffix == ".json"]) == len(filenames)
    for image in images:
        photo = by_name[image.name]
        taken = datetime.fromisoformat(photo["date_created"])
        assert image.parent.relative_to(out).parts == (str(taken.year), f"{taken.month:02d}")
        meta = json.loads(Path(f"{image}.json").read_text(encoding="utf-8"))
        assert meta["uuid"] == photo["uuid"] and "file_hash" not in meta
    shutil.rmtree(out)


@contract("export_voicemails")
def case_export_voicemails(ctx):
    m = ctx.maren
    out = ctx.out("voicemail")
    result = m.rpc("export_voicemails", output_dir=str(out))
    assert result["status"] == "success" and result["exported"] == len(m.voicemails) > 0
    assert same_path(result["path"], out)
    rows = read_csv(out / "voicemails.csv")
    assert rows[0] == ["ID", "List", "Date", "Contact", "Phone Number", "Spam", "Duration", "Is Read", "Transcript"]
    assert sorted(int(row[0]) for row in rows[1:]) == sorted(v["id"] for v in m.voicemails)
    assert {row[1] for row in rows[1:]} == {"Voicemail"}
    audio = files_under(out / "audio")
    assert len(audio) == len(m.voicemails)
    assert all(p.suffix == ".amr" and p.read_bytes().startswith(AMR_MAGIC) for p in audio)


@contract("export_bundle")
def case_export_bundle(ctx):
    m = ctx.maren
    out = ctx.folder("bundle")
    result = m.rpc("export_bundle", output_dir=str(out), time_zone="America/Los_Angeles")
    path = Path(result["path"])
    assert same_path(path.parent, out) and path.name.startswith("OpenExtract Bundle - ")
    assert check_bundle(path) == []
    assert result["errors"] == {} and result["failed_files"] == 0 and result["schema_version"] == "0.1"
    assert {"manifest.json", "SHA256SUMS", "conversations.json", "messages.jsonl", "calls.jsonl", "voicemail.jsonl",
            "contacts.json", "photos.jsonl", "albums.json", "people.json"} <= set(result["files"])
    assert sorted(result["files"]) == sorted(p.relative_to(path).as_posix() for p in files_under(path))
    expected = m.expected
    assert result["counts"]["messages"] == len(expected["messages"])
    assert result["counts"]["voicemail"] == len(expected["voicemails"])
    assert result["counts"]["contacts"] == len(expected["contacts"])
    assert result["counts"]["photos"] == len(m.photos)
    manifest = json.loads((path / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["backup"]["ios_version"] == expected["ios"]
    assert manifest["backup"]["product_type"] == expected["product_type"]
    assert manifest["backup"]["encrypted"] is False and manifest["computer_time_zone"] == "America/Los_Angeles"
    # Every message, each with the conversation it's in; attachments copied in and hashed
    messages = read_lines(path / "messages.jsonl")
    assert sorted(msg["id"] for msg in messages) == sorted(
        msg["message_id"] for c in m.conversations for msg in m.messages_of(c["chat_id"]))
    copied = [a for msg in messages for a in msg["attachments"] if a["path"]]
    assert len(copied) == len(m.attachments) > 0
    # Voicemail keeps every number, even a saved contact's
    voicemails = read_lines(path / "voicemail.jsonl")
    assert sorted(v["phone_number"] for v in voicemails) == sorted(v["sender"] for v in expected["voicemails"])
    assert all(v["audio_path"] and v["audio_sha256"] for v in voicemails)
    # Photo files only when asked for
    assert not (path / "photos").exists()


def _record_page(path: Path) -> str:
    """A saved record document (record_document.py): a whole page, nothing that
    runs or loads from elsewhere, the app's footer."""
    page = path.read_text(encoding="utf-8")
    assert page.startswith("<!DOCTYPE html>") and page.rstrip().endswith("</html>")
    assert not any(tag in page.lower() for tag in ("<script", "<img", "<link", " src="))
    assert "@media print" in page and "Made with OpenExtract" in page
    return page


@contract("export_calls")
def case_export_calls(ctx):
    enc = ctx.maren_enc
    calls = enc.expected["calls"]
    out = ctx.out("calls")
    result = enc.rpc("export_calls", output_dir=str(out))
    assert result["success"] is True and result["count"] == len(calls)
    path = Path(result["path"])
    assert same_path(path.parent, out) and path.name == "call_history.csv" and same_path(result["file"], path)
    assert path.read_bytes().startswith(b"\xef\xbb\xbf")  # Excel reads it as UTF-8
    rows = read_csv(path)
    assert rows[0] == ["Date", "Contact Name", "Phone/Email", "Direction", "Status", "Duration (s)", "App/Service"]
    assert len(rows) - 1 == result["count"]
    assert {row[3] for row in rows[1:]} <= {"Incoming", "Outgoing"}
    # Saving again keeps the first file
    again = enc.rpc("export_calls", output_dir=str(out), format="csv")
    assert Path(again["file"]).name == "call_history (2).csv" and path.exists()

    # A web page, the page Electron prints to a PDF, and plain text: a row or line per call
    for fmt, ext in (("html", ".html"), ("pdf_source", ".html"), ("txt", ".txt")):
        folder = ctx.folder(f"calls-{fmt}")
        result = enc.rpc("export_calls", output_dir=str(folder), format=fmt)
        path = Path(result["file"])
        assert result["success"] is True and result["count"] == len(calls), result
        assert same_path(path.parent, folder) and path.name == f"call_history{ext}" and files_under(folder) == [path]
        if ext == ".html":
            page = _record_page(path)
            assert page.count("<tr>") == len(calls) + 1  # the heading row, then one per call
            assert f"{len(calls):,} calls" in page and "<h1>Call history</h1>" in page
        else:
            lines = path.read_text(encoding="utf-8-sig").splitlines()
            assert lines[0] == "Call history" and sum(line.startswith("[") for line in lines) == len(calls)
    assert_error_dict(enc.rpc("export_calls", output_dir=str(ctx.folder("calls-docx")), format="docx"), "Unsupported format")


@contract("export_notes")
def case_export_notes(ctx):
    m = ctx.maren
    notes = m.notes
    out = ctx.out("notes-txt")
    result = m.rpc("export_notes", note_ids=[n["note_id"] for n in notes], format="txt", output_dir=str(out))
    assert result["status"] == "ok" and result["count"] == len(notes) and result["files"] == result["exported"]
    paths = [Path(p) for p in result["exported"]]
    assert len(paths) == len(notes) == len(set(paths)) == len(files_under(out))  # no two notes in one file
    titles = {n["title"] for n in notes}
    for path in paths:
        assert path.suffix == ".txt"
        assert path.read_text(encoding="utf-8").split("\n", 1)[0].removeprefix("Title: ") in titles
    out = ctx.out("notes-pdf")
    result = m.rpc("export_notes", note_ids=[n["note_id"] for n in notes[:3]], format="pdf", output_dir=str(out))
    assert result["status"] == "ok" and len(result["exported"]) == 3
    assert all(Path(p).suffix == ".pdf" and Path(p).read_bytes().startswith(PDF_MAGIC) for p in result["exported"])
    result = m.rpc("export_notes", note_ids=[10 ** 6], format="txt", output_dir=str(ctx.out("notes-none")))
    assert result["status"] == "error" and result["message"]

    # One note as a web page, or as the page Electron prints: named after it, its text in it
    first = notes[0]
    for fmt in ("html", "pdf_source"):
        folder = ctx.folder(f"notes-one-{fmt}")
        result = m.rpc("export_notes", note_ids=[first["note_id"]], format=fmt, output_dir=str(folder))
        [path] = [Path(p) for p in result["files"]]
        assert result["status"] == "ok" and path.suffix == ".html" and files_under(folder) == [path]
        page = _record_page(path)
        assert f"<h1>{html.escape(first['title'])}</h1>" in page
        last_line = first["body"].strip().splitlines()[-1]
        assert html.escape(last_line) in page

    # Every note in one file (no note_ids: all of them), in each format
    for fmt, ext in (("txt", ".txt"), ("html", ".html"), ("pdf_source", ".html")):
        folder = ctx.folder(f"notes-merged-{fmt}")
        result = m.rpc("export_notes", format=fmt, mode="merged", output_dir=str(folder))
        path = Path(result["file"])
        assert result["status"] == "ok" and result["count"] == len(notes) and result["exported"] == [result["file"]]
        assert same_path(path.parent, folder) and path.name == f"Notes{ext}" and files_under(folder) == [path]
        text = path.read_text(encoding="utf-8")
        assert all((html.escape(n["title"]) if ext == ".html" else n["title"]) in text for n in notes)
    # Saving them again keeps the first file
    again = m.rpc("export_notes", format="txt", mode="merged", output_dir=str(folder.parent / "notes-merged-txt"))
    assert Path(again["file"]).name == "Notes (2).txt"

    # A format or mode it doesn't know is an error, never an empty success
    assert_error_dict(m.rpc("export_notes", note_ids=[first["note_id"]], format="docx", output_dir=str(ctx.out("n-docx"))),
                      "Unsupported format")
    assert_error_dict(m.rpc("export_notes", format="txt", mode="zip", output_dir=str(ctx.out("n-zip"))), "Unsupported mode")
    assert not ctx.out("n-docx").exists() and not ctx.out("n-zip").exists()


@contract("has_browser_history")
def case_has_browser_history(ctx):
    assert ctx.maren_enc.rpc("has_browser_history") == {"safari": True, "firefox": False, "has_any": True}
    # iOS backs Safari history up only when the backup is encrypted
    assert ctx.maren.rpc("has_browser_history")["has_any"] is False


@contract("list_browser_history")
def case_list_browser_history(ctx):
    enc = ctx.maren_enc
    expected = len(enc.expected["browser_history"])
    everything = enc.rpc("list_browser_history", browser="all", offset=0, limit=0)
    assert everything["total"] == len(everything["visits"]) == expected
    assert everything["browsers_found"] == ["safari"]
    for visit in everything["visits"][:20]:
        assert {"url", "title", "domain", "visit_date", "browser", "visit_count"} <= set(visit)
        assert visit["url"].startswith("http") and visit["browser"] == "safari"
    page = enc.rpc("list_browser_history", browser="all", offset=10, limit=10)
    assert page["visits"] == everything["visits"][10:20] and page["total"] == expected
    assert enc.rpc("list_browser_history", browser="safari", offset=0, limit=0)["total"] == expected
    assert enc.rpc("list_browser_history", browser="firefox", offset=0, limit=0)["total"] == 0


@contract("export_browser_history")
def case_export_browser_history(ctx):
    enc = ctx.maren_enc
    out = ctx.out("browser")
    result = enc.rpc("export_browser_history", output_dir=str(out))
    assert result["success"] is True and result["count"] == len(enc.expected["browser_history"])
    path = Path(result["path"])
    assert same_path(path.parent, out) and path.suffix == ".csv"
    assert path.read_bytes().startswith(b"\xef\xbb\xbf") and same_path(result["file"], path)
    rows = read_csv(path)
    assert rows[0] == ["Date", "Browser", "URL", "Title", "Domain", "Visit Count"]
    assert len(rows) - 1 == result["count"] and {row[1] for row in rows[1:]} == {"Safari"}
    result = ctx.maren.rpc("export_browser_history", output_dir=str(ctx.out("browser-plain")))
    assert result["success"] is False and result["error"]

    visits = enc.expected["browser_history"]
    for fmt, ext in (("html", ".html"), ("pdf_source", ".html"), ("txt", ".txt")):
        folder = ctx.folder(f"browser-{fmt}")
        result = enc.rpc("export_browser_history", output_dir=str(folder), format=fmt)
        path = Path(result["file"])
        assert result["success"] is True and result["count"] == len(visits), result
        assert same_path(path.parent, folder) and path.suffix == ext and files_under(folder) == [path]
        if ext == ".html":
            page = _record_page(path)
            assert page.count("<tr>") == len(visits) + 1 and "<h1>Web history</h1>" in page
            assert f"{len(visits):,} page visits" in page
        else:
            lines = path.read_text(encoding="utf-8-sig").splitlines()
            assert lines[0] == "Web history" and sum(line.startswith("[") for line in lines) == len(visits)
    assert_error_dict(enc.rpc("export_browser_history", output_dir=str(ctx.folder("browser-x")), format="xlsx"),
                      "Unsupported format")


# ── WhatsApp ─────────────────────────────────────────────────────────────────
# Its ids are ChatStorage's and overlap with sms.db's in the copy of Einstein's
# backup, so each case also checks that the same number reads different rows
# through Messages' method and WhatsApp's. Pages are in arrival order (sort),
# never message_id order.

def _looks_like_base64_protobuf(text: str) -> bool:
    """WhatsApp 2.23+ stores push names and last-message text as base64 protobuf; never shown."""
    return bool(re.fullmatch(r"[A-Za-z0-9+/]{8,}={0,2}", text or "")) and (text or "").startswith("C")


@contract("list_whatsapp_chats")
def case_list_whatsapp_chats(ctx):
    wa = ctx.whatsapp
    s = wa.plan.scenario
    result = wa.rpc("list_whatsapp_chats")
    assert "error" not in result and "empty_reason" not in result, result
    chats = result["conversations"]
    assert {c["chat_id"]: (c["display_name"], c["chat_type"], c["handle"], c["archived"]) for c in chats} == s.chats
    assert {c["chat_id"]: c["message_count"] for c in chats} == s.counts  # status updates aren't chats
    dates = [c["last_message_date"] for c in chats]
    assert dates == sorted(dates, reverse=True)  # newest first
    for c in chats:
        assert c["service"] == "WhatsApp" and c["chat_identifier"] == c["chat_jid"] and c["chat_jid"]
        assert c["is_group"] is (c["chat_type"] == "group")
        local_day(c["last_message_date"])
        assert c["last_message_preview"] and not _looks_like_base64_protobuf(c["last_message_preview"])
    by_id = {c["chat_id"]: c for c in chats}
    assert by_id[wb.CHAT_RILEY]["last_message_preview"] == "A message type from the future"  # last by arrival
    # The same chat ids as Messages' conversations, but other chats
    sms = {c["chat_id"]: c for c in wa.rpc("list_conversations")["conversations"]}
    shared = set(sms) & set(by_id)
    assert shared, "the test copy should have chat ids in both sms.db and ChatStorage"
    assert all(sms[i]["chat_identifier"] != by_id[i]["chat_identifier"] for i in shared)
    # The encrypted backup reads the same
    enc = ctx.whatsapp_enc
    assert [(c["chat_id"], c["display_name"], c["message_count"], c["last_message_date"]) for c in enc.whatsapp_chats] == \
        [(c["chat_id"], c["display_name"], c["message_count"], c["last_message_date"]) for c in chats]


@contract("get_whatsapp_messages")
def case_get_whatsapp_messages(ctx):
    wa = ctx.whatsapp
    s = wa.plan.scenario
    total = s.counts[wb.CHAT_RILEY]
    page = wa.rpc("get_whatsapp_messages", chat_id=wb.CHAT_RILEY, offset=0, limit=5)
    assert (page["total"], page["offset"], page["limit"], page["next_offset"]) == (total, 0, 5, 5)
    sorts = [m["sort"] for m in page["messages"]]
    ids = [m["message_id"] for m in page["messages"]]
    assert sorts == sorted(sorts) and len(set(sorts)) == 5  # arrival order within the page...
    assert ids != sorted(ids)                               # ...which isn't row-id order
    keys = {"message_id", "text", "message_type", "event_text", "date", "is_from_me", "sender", "sender_handle",
            "has_attachments", "attachments", "is_reaction", "sort", "sender_jid", "quoted", "reactions", "call",
            "location", "received_date", "event_code", "starred", "vcard", "link_preview"}
    for m in page["messages"]:
        assert keys <= set(m), sorted(keys - set(m))
    older = wa.rpc("get_whatsapp_messages", chat_id=wb.CHAT_RILEY, offset=5, limit=5)["messages"]
    assert len(older) == 5 and max(m["sort"] for m in older) < min(sorts)
    last = wa.rpc("get_whatsapp_messages", chat_id=wb.CHAT_RILEY, offset=total - 2, limit=5)
    assert len(last["messages"]) == 2 and last["next_offset"] == total

    messages = {m["message_id"]: m for m in wa.whatsapp_messages_of(wb.CHAT_RILEY)}
    assert len(messages) == total
    assert [m["sort"] for m in wa.whatsapp_messages_of(wb.CHAT_RILEY)] == \
        sorted(m["sort"] for m in messages.values())
    assert all(m["is_reaction"] is False for m in messages.values())  # reactions sit on their message
    notice = messages[wb.MSG_NOTICE]
    assert (notice["message_type"], notice["sender"], notice["is_from_me"]) == ("system", "", False)
    assert notice["event_text"]
    assert messages[wb.MSG_HELLO]["reactions"][0]["emoji"] == "❤️" and messages[wb.MSG_HELLO]["reactions"][0]["is_from_me"]
    reply = messages[wb.MSG_REPLY]
    assert reply["quoted"]["message_id"] == wb.MSG_HELLO and reply["quoted"]["text"] == wb.HELLO_TEXT
    assert [r["sender"] for r in reply["reactions"]] == [wb.RILEY_NAME]
    assert messages[wb.MSG_MISSED_CALL]["call"]["outcome"] == "missed"
    assert messages[wb.MSG_MISSED_CALL]["event_text"] == "Missed voice call"
    location = messages[wb.MSG_LOCATION]["location"]
    assert (location["latitude"], location["longitude"], location["place_name"]) == (45.52, -122.68, wb.PLACE_NAME)
    assert location["attachment_id"] == wb.ATT_LOCATION and location["thumbnail_path"]
    image = messages[wb.MSG_IMAGE]["attachments"][0]
    assert (image["attachment_id"], image["available"], image["filename"]) == (wb.ATT_IMAGE, True, "Message/" + wb.IMAGE_PATH)
    missing = messages[wb.MSG_MISSING_IMAGE]["attachments"][0]
    assert (missing["attachment_id"], missing["available"]) == (wb.ATT_MISSING_IMAGE, False)
    assert messages[wb.MSG_LAST]["starred"] is True
    # Arrived last though the sender's clock put it earlier
    assert messages[wb.MSG_LAST]["sort"] > messages[wb.MSG_DOCUMENT]["sort"]
    assert messages[wb.MSG_LAST]["date"] < messages[wb.MSG_DOCUMENT]["date"]

    group = wa.whatsapp_messages_of(wb.CHAT_GROUP)
    assert [m["sender"] for m in group if m["message_type"] == "text" and not m["is_from_me"]] == ["Casey", "Drew"]
    # A date range with nothing in it, a chat that isn't there, status updates
    empty = wa.rpc("get_whatsapp_messages", chat_id=wb.CHAT_RILEY, offset=0, limit=50,
                   date_from="1990-01-01T00:00:00Z", date_to="1990-12-31T23:59:59Z")
    assert empty["messages"] == [] and empty["total"] == 0
    for chat_id in (10 ** 6, wb.CHAT_STATUS):
        nothing = wa.rpc("get_whatsapp_messages", chat_id=chat_id, offset=0, limit=50)
        assert (nothing["messages"], nothing["total"]) == ([], 0) and "error" not in nothing
    # The same chat id through Messages: a different conversation
    sms_texts = {m["text"] for m in wa.messages_of(wb.CHAT_RILEY)}
    assert wb.HELLO_TEXT not in sms_texts and not sms_texts & {m["text"] for m in messages.values() if m["text"]}
    # Encrypted: the same messages
    enc = ctx.whatsapp_enc
    assert [(m["message_id"], m["sort"], m["text"]) for m in enc.whatsapp_messages_of(wb.CHAT_RILEY)] == \
        [(m["message_id"], m["sort"], m["text"]) for m in wa.whatsapp_messages_of(wb.CHAT_RILEY)]


@contract("get_whatsapp_message_offset")
def case_get_whatsapp_message_offset(ctx):
    wa = ctx.whatsapp
    messages = wa.whatsapp_messages_of(wb.CHAT_RILEY)
    for i in (len(messages) - 1, len(messages) // 2, 3, 0):
        target = messages[i]
        result = wa.rpc("get_whatsapp_message_offset", chat_id=wb.CHAT_RILEY, message_id=target["message_id"])
        assert result == {"offset": len(messages) - 1 - i, "found": True}  # newer by arrival, not by id
        page = wa.rpc("get_whatsapp_messages", chat_id=wb.CHAT_RILEY, offset=result["offset"], limit=1)
        assert page["messages"][0]["message_id"] == target["message_id"]
    assert wa.rpc("get_whatsapp_message_offset", chat_id=wb.CHAT_GROUP,
                  message_id=messages[0]["message_id"]) == {"offset": 0, "found": False}


@contract("search_whatsapp_messages")
def case_search_whatsapp_messages(ctx):
    wa = ctx.whatsapp

    def ids(**params):
        result = wa.rpc("search_whatsapp_messages", **params)
        assert "error" not in result and result["query"] == params["query"], result
        for r in result["results"]:
            assert {"message_id", "text", "date", "is_from_me", "sender", "chat_id", "chat_name"} <= set(r)
        return [r["message_id"] for r in result["results"]]

    assert ids(query="100%") == [wb.MSG_LAST]           # % and _ are literal
    assert ids(query=wb.HELLO_TEXT[6:]) == [wb.MSG_HELLO]
    assert ids(query="caption") == [wb.MSG_IMAGE]       # captions, any case
    assert ids(query="Quarterly") == [wb.MSG_DOCUMENT]  # document names
    in_group = wa.rpc("search_whatsapp_messages", query="o", chat_id=wb.CHAT_GROUP)["results"]
    assert in_group and {r["chat_id"] for r in in_group} == {wb.CHAT_GROUP}
    assert ids(query=wb.STATUS_TEXT) == []              # status updates are never searched
    assert ids(query=wb.LAST_TEXT, date_to="2000-01-01T00:00:00Z") == []
    assert len(ids(query="o", limit=2)) == 2
    assert ids(query="zq-no-message-says-this-7f3a") == []
    # Messages' search doesn't see WhatsApp, nor WhatsApp's Messages
    assert wa.rpc("search_messages", query=wb.HELLO_TEXT)["results"] == []
    sms_text = next(m["text"] for m in wa.messages_of(wa.biggest_conversation["chat_id"]) if len(m["text"] or "") > 20)
    assert ids(query=sms_text) == []


@contract("get_whatsapp_attachment")
def case_get_whatsapp_attachment(ctx):
    for engine in (ctx.whatsapp, ctx.whatsapp_enc):
        s = engine.plan.scenario
        image = engine.rpc("get_whatsapp_attachment", attachment_id=wb.ATT_IMAGE)
        assert decoded(image, "image") == s.image_bytes
        assert (image["mime_type"], image["filename"], image["size"]) == ("image/jpeg", "abcd-image.jpg", len(s.image_bytes))
        thumb = engine.rpc("get_whatsapp_attachment", attachment_id=wb.ATT_IMAGE, thumbnail=True)
        assert decoded(thumb, "thumbnail") == s.thumb_bytes and thumb["mime_type"] == "image/jpeg"
        map_preview = engine.rpc("get_whatsapp_attachment", attachment_id=wb.ATT_LOCATION, thumbnail=True)
        assert decoded(map_preview, "map") == s.map_bytes
        voice = engine.rpc("get_whatsapp_attachment", attachment_id=wb.ATT_VOICE_NOTE)
        assert decoded(voice, "voice note") == wb.VOICE_BYTES and voice["mime_type"] == "audio/ogg"
        doc = engine.rpc("get_whatsapp_attachment", attachment_id=wb.ATT_DOCUMENT, as_file=True)
        path = Path(doc["path"])
        assert path.name == wb.DOCUMENT_TITLE and path.read_bytes() == wb.PDF_BYTES
        assert doc["openable"] is True  # a PDF; a program would be False (test_whatsapp_adapter.py)
        assert not path.resolve().is_relative_to(engine.backup_dir.resolve())  # a copy, never the backup's file
        assert engine.rpc("get_whatsapp_attachment", attachment_id=wb.ATT_MISSING_IMAGE) == \
            {"error": "This file isn't in the backup", "empty_reason": "not_in_backup"}
        assert engine.rpc("get_whatsapp_attachment", attachment_id=10 ** 6) == {"error": "Attachment not found"}
    # The same number through Messages' method: not this photo
    wa = ctx.whatsapp
    sms = wa.rpc("get_attachment", attachment_id=wb.ATT_IMAGE)
    assert sms.get("data") != wa.rpc("get_whatsapp_attachment", attachment_id=wb.ATT_IMAGE)["data"]


@contract("export_whatsapp_chat")
def case_export_whatsapp_chat(ctx):
    wa = ctx.whatsapp
    s = wa.plan.scenario
    count = s.counts[wb.CHAT_RILEY]
    for fmt, suffix in (("txt", ".txt"), ("csv", ".csv"), ("html", ".html"), ("pdf_source", ".html")):
        out = ctx.folder(f"whatsapp-{fmt}")
        result = wa.rpc("export_whatsapp_chat", chat_id=wb.CHAT_RILEY, format=fmt, output_dir=str(out),
                        display_name=wb.RILEY_NAME)
        path = Path(result["file"])
        assert same_path(path.parent, out) and path.suffix == suffix and path.name.startswith(wb.RILEY_NAME)
        assert result["message_count"] == count
        if fmt == "txt":
            text = path.read_text(encoding="utf-8-sig")
            lines = text.splitlines()
            assert len(lines) == count
            assert "Messages and calls are end-to-end encrypted." in lines[0] and ": " not in lines[0].split("] ", 1)[1]
            assert f"me: [Replying to {wb.RILEY_NAME}: {wb.HELLO_TEXT}] {wb.REPLY_TEXT}" in text
            assert text.index(wb.DOCUMENT_TITLE) < text.index(wb.LAST_TEXT)  # arrival order, not dates
        elif fmt == "csv":
            rows = read_csv(path)
            assert rows[0] == ["Date", "Sender", "Text", "Is From Me", "Has Attachments", "Type", "Replying To", "Reactions"]
            assert len(rows) - 1 == count
            assert [row[5] for row in rows[1:]].count("Call") == 3
        else:
            page = path.read_text(encoding="utf-8")
            assert page.startswith("<!DOCTYPE html>") and f"<title>WhatsApp chat: {wb.RILEY_NAME}</title>" in page
            assert '<div class="system">' in page and html.escape(wb.LAST_TEXT) in page
            assert "Photo not in this backup" in page
        if fmt == "html":
            folder = out / f"{path.stem}_attachments"
            assert (folder / f"wa{wb.ATT_IMAGE}-abcd-image.jpg").read_bytes() == s.image_bytes
            assert (folder / f"wa{wb.ATT_VOICE_NOTE}-voice.opus").read_bytes() == wb.VOICE_BYTES
            assert re.search(r'<audio controls[^>]*voice\.opus', page)
        if fmt == "pdf_source":
            images = set(re.findall(r'<img[^>]* src="(attachments/[^"]+)"', page))
            assert images == {f"attachments/wa{wb.ATT_IMAGE}.jpg", f"attachments/wamap{wb.ATT_LOCATION}.jpg"}
            for rel in images:
                assert (out / rel).read_bytes()[:3] == JPEG_MAGIC
    # Only the messages a search matches
    matches = wa.rpc("search_whatsapp_messages", query="o", chat_id=wb.CHAT_RILEY)["results"]
    result = wa.rpc("export_whatsapp_chat", chat_id=wb.CHAT_RILEY, format="txt",
                    output_dir=str(ctx.folder("whatsapp-query")), query="o")
    assert result["message_count"] == len(matches) > 0
    # Media from an encrypted backup (decrypted on the way)
    enc = ctx.whatsapp_enc
    out = ctx.folder("whatsapp-encrypted-html")
    result = enc.rpc("export_whatsapp_chat", chat_id=wb.CHAT_RILEY, format="html", output_dir=str(out),
                     display_name=wb.RILEY_NAME)
    folder = out / f"{Path(result['file']).stem}_attachments"
    assert (folder / f"wa{wb.ATT_IMAGE}-abcd-image.jpg").read_bytes() == s.image_bytes
    assert_error_dict(wa.rpc("export_whatsapp_chat", chat_id=wb.CHAT_RILEY, format="docx",
                             output_dir=str(ctx.folder("whatsapp-docx"))), "Unsupported format")


@contract("export_whatsapp_chats")
def case_export_whatsapp_chats(ctx):
    wa = ctx.whatsapp
    s = wa.plan.scenario
    chat_ids = [wb.CHAT_RILEY, wb.CHAT_GROUP]
    names = {str(wb.CHAT_RILEY): wb.RILEY_NAME, str(wb.CHAT_GROUP): wb.GROUP_NAME}
    total = s.counts[wb.CHAT_RILEY] + s.counts[wb.CHAT_GROUP]
    out = ctx.folder("whatsapp-separate")
    result = wa.rpc("export_whatsapp_chats", chat_ids=chat_ids, conversation_names=names, format="csv",
                    output_dir=str(out), mode="separate")
    assert result["message_count"] == total and len(result["files"]) == 2
    assert sorted(len(read_csv(Path(f))) - 1 for f in result["files"]) == sorted(s.counts[c] for c in chat_ids)
    assert len(files_under(out)) == 2
    out = ctx.folder("whatsapp-merged")
    result = wa.rpc("export_whatsapp_chats", chat_ids=chat_ids, conversation_names=names, format="txt",
                    output_dir=str(out), mode="merged")
    assert result["message_count"] == total and len(result["files"]) == 1
    text = Path(result["files"][0]).read_text(encoding="utf-8-sig")
    assert f"(from {wb.GROUP_NAME}) Casey: Hi all" in text and f"(in {wb.RILEY_NAME})" in text
    out = ctx.folder("whatsapp-merged-pdf")
    result = wa.rpc("export_whatsapp_chats", chat_ids=chat_ids, conversation_names=names, format="pdf_source",
                    output_dir=str(out), mode="merged")
    assert [Path(f).suffix for f in result["files"]] == [".html"] and result["message_count"] == total


# ── Everything with one person (People's Save) ───────────────────────────────

PERSON_CSV_HEADER = ["Date", "Kind", "Conversation", "Direction", "Sender", "Text", "Attachments",
                     "Attachment files", "Duration", "Transcript"]


@contract("export_person")
def case_export_person(ctx):
    p = ctx.person
    plan, s = p.plan, p.plan.scenario
    # The Messages conversation and the WhatsApp chat share an id: two different chats
    assert plan.sms_chat_id == wb.CHAT_RILEY
    sms_messages = [m for m in p.messages_of(plan.sms_chat_id) if not m["is_reaction"]]
    calls = p.rpc("list_calls", offset=0, limit=1000)["calls"]
    call_ids = [c["call_id"] for c in calls]
    assert sorted(map(str, call_ids)) == sorted([*map(str, plan.call_ids), *(f"vm_{v}" for v in plan.voicemail_audio)])
    assert {type(i) for i in call_ids} == {int, str}  # 1 and "vm_1", compared as text
    voicemails = p.rpc("list_voicemails", include_deleted=True)["voicemails"]
    params = dict(display_name=wb.RILEY_NAME, chat_ids=[plan.sms_chat_id],
                  conversation_names={str(plan.sms_chat_id): "Riley (text messages)"},
                  whatsapp_chat_ids=[wb.CHAT_RILEY], whatsapp_names={str(wb.CHAT_RILEY): wb.RILEY_NAME},
                  call_ids=call_ids, voicemail_ids=[v["id"] for v in voicemails])
    counts = {"message": len(sms_messages), "whatsapp": s.counts[wb.CHAT_RILEY], "call": len(calls),
              "voicemail": len(voicemails)}
    total = sum(counts.values())
    wa_media = [a for m in p.whatsapp_messages_of(wb.CHAT_RILEY) for a in m["attachments"]]
    sms_media = plan.sms_attachments.values()
    media = {
        "copied": sum(data is not None for _, data in sms_media) + sum(a["available"] for a in wa_media)
        + sum(audio is not None for audio in plan.voicemail_audio.values()),
        "not_in_backup": sum(data is None for _, data in sms_media) + sum(not a["available"] for a in wa_media)
        + sum(audio is None for audio in plan.voicemail_audio.values()),
        "failed": 0,
    }
    files_total = len(sms_media) + len(wa_media) + len(voicemails)

    def originals_in(folder: Path):
        # Every source's own file, though Messages' and WhatsApp's attachment ids collide
        for att_id, (name, data) in plan.sms_attachments.items():
            assert (folder / f"{att_id}-{name}").exists() is (data is not None), name
            if data is not None:
                assert (folder / f"{att_id}-{name}").read_bytes() == data
        assert (folder / f"wa{wb.ATT_IMAGE}-abcd-image.jpg").read_bytes() == s.image_bytes
        assert (folder / f"wa{wb.ATT_DOCUMENT}-{wb.DOCUMENT_TITLE}").read_bytes() == wb.PDF_BYTES
        assert (folder / f"wa{wb.ATT_VOICE_NOTE}-voice.opus").read_bytes() == wb.VOICE_BYTES
        assert [r.read_bytes() for r in folder.glob("vm*.amr")] == [plan.voicemail_audio[1]]

    base = None
    for fmt, suffix in (("html", ".html"), ("csv", ".csv"), ("txt", ".txt")):
        out = ctx.folder(f"person-{fmt}")
        seen = len(p.notifications)
        result = p.rpc("export_person", format=fmt, output_dir=str(out), **params)
        path = Path(result["file"])
        assert same_path(path.parent, out) and path.suffix == suffix and path.name.startswith(wb.RILEY_NAME)
        base = path.stem
        assert result["counts"] == counts and result["message_count"] == total
        assert result["media"] == media and result["errors"] == {}
        folder = Path(result["media_folder"])
        assert same_path(folder, out / f"{base}_attachments")
        originals_in(folder)
        progress = [n["params"] for n in p.notifications[seen:] if n["method"] == "export.progress"]
        assert progress and {q["kind"] for q in progress} == {"person"}
        assert {q["total"] for q in progress} == {total + files_total}
        assert (progress[0]["done"], progress[-1]["done"], progress[-1]["failed"]) == (0, total + files_total, 0)
        if fmt == "html":
            page = path.read_text(encoding="utf-8")
            assert page.startswith("<!DOCTYPE html>") and f"<title>Everything with {wb.RILEY_NAME}</title>" in page
            assert html.escape(VOICEMAIL_TRANSCRIPT) in page and "<b>soon</b>" not in page
            assert re.search(r'<audio controls[^>]*voice\.opus', page)
            assert re.search(r'<video controls[^>]*clip\.mov', page)
            assert "Image not in this backup: IMG_0009.heic" in page
            # Merged by date: WhatsApp's chat (Mar 1, 2024), the calls (Mar 2 and 3), a voicemail (Mar 4),
            # then the newest text message, which has the attachments (May 2024)
            marks = [wb.HELLO_TEXT, "Outgoing call", "Missed FaceTime audio call", "Call me back", "clip.mov"]
            assert [page.index(m) for m in marks] == sorted(page.index(m) for m in marks)
            assert page.count('<span class="src">WhatsApp</span>') == counts["whatsapp"]
        elif fmt == "csv":
            rows = read_csv(path)
            assert rows[0] == PERSON_CSV_HEADER and len(rows) - 1 == total
            kinds = Counter(row[1] for row in rows[1:])
            assert (kinds["WhatsApp"], kinds["Call"], kinds["Voicemail"]) == \
                (counts["whatsapp"], counts["call"], counts["voicemail"])
            assert kinds["SMS"] + kinds["Messages"] + kinds["RCS"] == counts["message"]
            for row in rows[1:]:
                for rel in filter(None, row[7].split("; ")):
                    assert (out / rel).is_file(), rel
        else:
            text = path.read_text(encoding="utf-8-sig")
            assert f"(WhatsApp) {wb.RILEY_NAME}: {wb.HELLO_TEXT}" in text
            assert f"[Video: clip.mov -> {base}_attachments/{wb.ATT_DOCUMENT}-clip.mov]" in text
            assert "(Voicemail) Voicemail" in text and "(Call) Outgoing call" in text

    # PDF: the page goes into Electron's staging folder; every original goes beside the PDF in the
    # chosen folder, under a name free for both the PDF and the folder
    staging, chosen = ctx.folder("person-staging"), ctx.folder("person-chosen")
    (chosen / f"{base}.pdf").write_bytes(b"%PDF-1.4 saved earlier")
    result = p.rpc("export_person", format="pdf_source", output_dir=str(staging), media_dir=str(chosen), **params)
    page_path = Path(result["file"])
    assert same_path(page_path.parent, staging) and page_path.name == f"{base} (2).html"
    assert result["counts"] == counts and result["media"] == media
    assert same_path(result["media_folder"], chosen / f"{base} (2)_attachments")
    originals_in(Path(result["media_folder"]))
    page = page_path.read_text(encoding="utf-8")
    images = set(re.findall(r'<img[^>]* src="(attachments/[^"]+)"', page))
    assert {f"attachments/{wb.ATT_IMAGE}.jpg", f"attachments/wa{wb.ATT_IMAGE}.jpg"} <= images
    for rel in images:
        assert (staging / rel).read_bytes()[:3] == JPEG_MAGIC
    assert f"Saved as {wb.ATT_DOCUMENT}-clip.mov" in page and "Recording saved as vm1-" in page
    assert "<video" not in page and "<audio" not in page
    assert (chosen / f"{base}.pdf").read_bytes() == b"%PDF-1.4 saved earlier"

    assert_error_dict(p.rpc("export_person", format="docx", output_dir=str(ctx.folder("person-docx")), **params),
                      "Unsupported format")
    assert files_under(ctx.tmp / "person-docx") == []


# ── Podcasts ─────────────────────────────────────────────────────────────────
# The library (MTLibrary.sqlite) in a copy of Einstein's backup, and in an
# encrypted backup holding only it. "Listened" is the history (a play count,
# a last played date or a position), never the app's "played" mark alone,
# which it puts on a followed show's whole back catalogue.

PODCAST_CSV_HEADER = ["Title", "Author", "Followed", "Feed URL", "Website", "Added", "Last played",
                      "Episodes", "Listened"]
EPISODE_CSV_HEADER = ["Podcast", "Title", "Published", "Duration (s)", "Listened", "Play count",
                      "Last played", "Position (s)", "State", "Saved", "Downloaded on iPhone",
                      "Audio URL", "Web page"]


@contract("list_podcasts")
def case_list_podcasts(ctx):
    pod = ctx.podcasts
    s = pod.plan.scenario
    result = pod.rpc("list_podcasts")
    assert "error" not in result and "empty_reason" not in result, result
    shows = result["podcasts"]
    assert [p["id"] for p in shows] == sorted(s.shows)  # the library's own order
    for p in shows:
        assert {k: p[k] for k in s.shows[p["id"]]} == s.shows[p["id"]], p["id"]
        for key in ("added_date", "last_played_date", "unfollowed_date"):
            if p[key]:
                local_day(p[key])
    # Played but never chosen: not followed
    assert {p["id"] for p in shows if p["followed"]} == s.followed
    assert next(p for p in shows if p["id"] == pb.SHOW_IMPLICIT)["implicitly_followed"] is True
    # The encrypted backup reads the same
    assert ctx.podcasts_enc.podcasts == shows


@contract("list_podcast_episodes")
def case_list_podcast_episodes(ctx):
    pod = ctx.podcasts
    s = pod.plan.scenario
    result = pod.rpc("list_podcast_episodes")
    assert "error" not in result and "empty_reason" not in result, result
    episodes = result["episodes"]
    assert [e["id"] for e in episodes] == s.newest_first(s.episodes)  # newest published first
    for e in episodes:
        assert {k: e[k] for k in s.episodes[e["id"]]} == s.episodes[e["id"]], e["id"]
        assert "description" not in e  # never shown; would make the answer much bigger
        assert not any("asset" in key for key in e)  # where the iPhone kept the audio means nothing here
    assert pod.rpc("list_podcast_episodes", podcast_id=None)["episodes"] == episodes
    # One show's. The app sends a number; a string reads the same.
    for podcast_id in (pb.SHOW_FIELD_NOTES, str(pb.SHOW_FIELD_NOTES)):
        ids = [e["id"] for e in pod.rpc("list_podcast_episodes", podcast_id=podcast_id)["episodes"]]
        assert ids == s.newest_first(s.episodes_of(pb.SHOW_FIELD_NOTES))
    # The listening history: not the back catalogue the app marked played
    history = pod.rpc("list_podcast_episodes", listened_only=True)["episodes"]
    assert [e["id"] for e in history] == s.newest_first(s.listened)
    assert pb.EP_BACK_CATALOGUE not in s.listened and pb.EP_IN_PROGRESS in s.listened
    one = pod.rpc("list_podcast_episodes", podcast_id=pb.SHOW_FIELD_NOTES, listened_only=True)["episodes"]
    assert {e["id"] for e in one} == {pb.EP_DOWNLOADED, pb.EP_IN_PROGRESS}
    # A show the library doesn't have: nothing, calmly
    assert pod.rpc("list_podcast_episodes", podcast_id=999) == {"episodes": [], "empty_reason": "no_records"}
    # The encrypted backup reads the same
    assert ctx.podcasts_enc.podcast_episodes == episodes


@contract("export_podcasts")
def case_export_podcasts(ctx):
    pod = ctx.podcasts
    s = pod.plan.scenario
    # OPML: the followed shows with a feed, for another podcast app
    out = ctx.folder("podcasts-opml")
    result = pod.rpc("export_podcasts", output_dir=str(out), format="opml")
    path = Path(result["path"])
    assert result == {"status": "success", "count": len(s.opml_feeds), "path": str(path), "files": [str(path)]}
    assert same_path(path.parent, out) and path.name == "Podcasts.opml"
    root = ET.parse(path).getroot()
    assert (root.tag, root.get("version")) == ("opml", "2.0")
    assert root.findtext("head/title") == f"Podcasts from {pb.DEVICE_NAME}"
    assert parsedate_to_datetime(root.findtext("head/dateCreated")).tzinfo is not None  # RFC 822
    outlines = root.findall("body/outline")
    assert {o.get("text"): o.get("xmlUrl") for o in outlines} == s.opml_feeds
    assert all(o.get("type") == "rss" for o in outlines)
    assert "Field Notes &amp; &lt;Margins&gt;" in path.read_text(encoding="utf-8")
    # Saving again never overwrites
    again = pod.rpc("export_podcasts", output_dir=str(out), format="opml")
    assert Path(again["path"]).name == "Podcasts (2).opml" and len(files_under(out)) == 2
    # CSV: every show and every episode
    out = ctx.folder("podcasts-csv")
    result = pod.rpc("export_podcasts", output_dir=str(out), format="csv")
    assert (result["status"], result["count"]) == ("success", len(s.shows))
    shows_csv, episodes_csv = (Path(f) for f in result["files"])
    assert result["path"] == result["files"][0]
    assert (shows_csv.name, episodes_csv.name) == ("Podcasts.csv", "Podcast episodes.csv")
    assert files_under(out) == sorted([shows_csv, episodes_csv])
    rows = read_csv(shows_csv)
    assert rows[0] == PODCAST_CSV_HEADER and len(rows) - 1 == len(s.shows)
    titles = [row[0] for row in rows[1:]]
    assert pb.AMPERSAND_TITLE in titles and "'" + pb.FORMULA_TITLE in titles  # never a formula
    rows = read_csv(episodes_csv)
    assert rows[0] == EPISODE_CSV_HEADER and len(rows) - 1 == len(s.episodes)
    by_title = {row[1]: row for row in rows[1:]}
    assert "'" + pb.FORMULA_EPISODE in by_title
    in_progress = by_title[s.episodes[pb.EP_IN_PROGRESS]["title"]]
    assert in_progress[7:10] == [str(int(pb.IN_PROGRESS_AT)), "In progress", "Yes"]
    published = datetime.fromisoformat(in_progress[2])
    assert published.utcoffset() is not None  # local time, with its offset
    assert published == datetime.fromisoformat(s.episodes[pb.EP_IN_PROGRESS]["published_date"])
    assert by_title[s.episodes[pb.EP_DOWNLOADED]["title"]][10] == "Yes"
    # The encrypted backup saves the same shows
    out = ctx.folder("podcasts-encrypted-opml")
    result = ctx.podcasts_enc.rpc("export_podcasts", output_dir=str(out), format="opml")
    assert result["count"] == len(s.opml_feeds)
    assert {o.get("xmlUrl") for o in ET.parse(result["path"]).getroot().iter("outline")} == set(s.opml_feeds.values())
    out = ctx.folder("podcasts-docx")
    assert_error_dict(pod.rpc("export_podcasts", output_dir=str(out), format="docx"), "Unsupported format")
    assert files_under(out) == []


@contract("recover_messages")
def case_recover_messages(ctx):
    rec = ctx.runtime.recovery()
    plan = rec.plan
    result = rec.rpc("recover_messages")
    assert result["schema_support"] == {"recently_deleted": True}
    assert result["scanned"] == {"recently_deleted": len(plan.deleted), "orphaned": len(plan.orphaned)}
    recent_id, orphan_id = f"recent:{plan.deleted_chat_id}", f"orphan:{plan.orphan_handle}"
    by_id = {c["recovery_id"]: c for c in result["conversations"]}
    assert set(by_id) == set(result["messages_by_conversation"]) == {recent_id, orphan_id}

    recent = by_id[recent_id]
    assert (recent["source"], recent["chat_id"], recent["message_count"]) == ("recently_deleted", plan.deleted_chat_id, 3)
    original = next(c for c in ctx.einstein.conversations if c["chat_id"] == plan.deleted_chat_id)
    assert recent["display_name"] == original["display_name"]
    orphan = by_id[orphan_id]
    assert (orphan["source"], orphan["chat_id"], orphan["message_count"]) == ("orphaned", None, 2)

    found = result["messages_by_conversation"]
    assert sorted((msg["message_id"], msg["text"]) for msg in found[recent_id]) == plan.deleted
    assert sorted((msg["message_id"], msg["text"]) for msg in found[orphan_id]) == plan.orphaned
    for msg in found[recent_id]:
        assert msg["source"] == "recently_deleted"
        assert msg["deleted_date"].startswith(DELETED_AT.strftime("%Y-%m-%dT%H:%M"))
    for msg in found[orphan_id]:
        assert msg["source"] == "orphaned" and msg["deleted_date"] is None
    for msgs in found.values():
        dates = [msg["date"] for msg in msgs]
        assert dates == sorted(dates)

    # The normal views no longer show them
    counts = {c["chat_id"]: c["message_count"] for c in rec.conversations}
    assert counts[plan.deleted_chat_id] == plan.original_counts[plan.deleted_chat_id] - 3
    assert counts[plan.orphan_chat_id] == plan.original_counts[plan.orphan_chat_id] - 2
    visible = {msg["message_id"] for msg in rec.messages_of(plan.deleted_chat_id)}
    assert not visible & {message_id for message_id, _ in plan.deleted}

    # Nothing to recover in a backup with nothing deleted
    result = ctx.maren.rpc("recover_messages")
    assert result["conversations"] == [] and result["scanned"] == {"recently_deleted": 0, "orphaned": 0}


@contract("export_recovered_messages")
def case_export_recovered_messages(ctx):
    rec = ctx.runtime.recovery()
    plan = rec.plan
    texts = sorted(text for _, text in plan.deleted + plan.orphaned)
    exts = {"csv": ".csv", "html": ".html", "pdf_source": ".html", "txt": ".txt", "pdf": ".pdf"}
    for fmt, ext in exts.items():
        out = ctx.folder(f"recovered-{fmt}")
        result = rec.rpc("export_recovered_messages", format=fmt, output_dir=str(out))
        path = Path(result["file"])
        assert same_path(path.parent, out) and path.name == f"recovered_messages{ext}"
        assert (result["message_count"], result["conversation_count"]) == (len(texts), 2)
        assert [p.name for p in files_under(out)] == [path.name]
        if fmt == "csv":
            assert path.read_bytes().startswith(b"\xef\xbb\xbf")
            rows = read_csv(path)
            assert rows[0] == ["Conversation", "Source", "Date", "Sender", "Is From Me", "Text", "Deleted Date"]
            assert sorted(row[5] for row in rows[1:]) == texts
            assert {row[1] for row in rows[1:]} == {"Recently Deleted", "Orphaned"}
            # Dates in local time with the offset: the same moment as the engine's UTC
            dates = sorted(datetime.fromisoformat(row[2]) for row in rows[1:])
            found = rec.rpc("recover_messages")["messages_by_conversation"]
            assert dates == sorted(datetime.fromisoformat(m["date"]) for msgs in found.values() for m in msgs)
        elif ext == ".html":
            page = _record_page(path)
            assert f"{len(texts)} messages in 2 conversations" in page and "<h1>Recovered messages</h1>" in page
            assert all(html.escape(text).replace("\n", "<br>") in page for text in texts)
            assert "Recently Deleted" in page and "Left behind" in page  # the screen's words for where they were found
        elif fmt == "txt":
            text = path.read_text(encoding="utf-8-sig")
            assert text.startswith("Recovered messages\n") and all(t.splitlines()[0] in text for t in texts)
        else:
            assert path.read_bytes().startswith(PDF_MAGIC)
    # Saving again keeps the first file
    again = rec.rpc("export_recovered_messages", format="html", output_dir=str(ctx.tmp / "recovered-html"))
    assert Path(again["file"]).name == "recovered_messages (2).html"
    assert_error_dict(rec.rpc("export_recovered_messages", format="docx", output_dir=str(ctx.folder("recovered-docx"))),
                      "Unsupported format")


@contract("write_file")
def case_write_file(ctx):
    target = ctx.out("nested") / "deeper" / "timeline.html"  # missing folders are made
    content = '<p class="x">Ünïcödé 🥾 — "quotes" & <tags></p>\nsecond line\n'
    result = ctx.plain.call("write_file", {"path": str(target), "content": content})
    assert result == {"status": "ok", "path": str(target)}
    assert target.read_text(encoding="utf-8") == content
    # A multi-megabyte request line, like a long Timeline export
    big = ctx.out("big.txt")
    content = "0123456789abcdef\n" * 250_000
    ctx.plain.call("write_file", {"path": str(big), "content": content})
    assert big.read_text(encoding="utf-8") == content


@contract("get_aggregate_stats")
def case_get_aggregate_stats(ctx):
    engine = ctx.runtime.fresh("aggregate")
    assert engine.call("get_aggregate_stats") == {"total_devices": 0, "total_size_gb": 0.0, "total_messages": 0}
    item, einstein_dir = generated_backup(EINSTEIN)
    plan = ctx.runtime.recovery_plan()
    engine.call("open_backup", {"udid": item.udid, "backup_dir": str(einstein_dir)})
    engine.call("open_backup", {"udid": plan.udid, "backup_dir": str(plan.backup_dir)})
    result = engine.call("get_aggregate_stats")
    assert result["total_devices"] == 2
    assert result["total_messages"] == len(item.expected()["messages"]) + plan.message_rows
    assert isinstance(result["total_size_gb"], (int, float))
    m = ctx.maren
    result = m.call("get_aggregate_stats")
    assert (result["total_devices"], result["total_messages"]) == (1, len(m.expected["messages"]))


@contract("get_backup_stats")
def case_get_backup_stats(ctx):
    for engine in (ctx.maren, ctx.maren_enc):
        exp = engine.expected
        stats = engine.rpc("get_backup_stats")
        assert stats["errors"] == []
        o = stats["overview"]
        assert o["encrypted"] is engine.encrypted
        assert (o["ios_version"], o["product_type"]) == (exp["ios"], exp["product_type"])
        assert o["total_messages"] == len(exp["messages"])
        assert o["total_conversations"] == len(exp["conversations"])
        assert o["total_photos"] + o["total_videos"] == o["photos_in_backup"] == len(exp["photos"])
        assert o["photos_missing_from_folder"] == 0
        assert o["total_contacts"] == len(exp["contacts"])
        assert o["total_notes"] == len(exp["notes"])
        assert o["total_voicemails"] == len(exp["voicemails"])
        messages = stats["messages"]
        assert messages["sent"] == sum(1 for msg in exp["messages"] if msg["is_from_me"])
        assert messages["sent"] + messages["received"] == len(exp["messages"])
        assert messages["group_conversations"] + messages["one_on_one_conversations"] == len(exp["conversations"])
    assert ctx.maren_enc.rpc("get_backup_stats")["overview"]["total_calls"] == len(ctx.maren_enc.expected["calls"])
    # Maren's WhatsApp, as her answer key has it (none from a library whose backupgen predates it)
    for engine in (ctx.maren, ctx.maren_enc):
        o, wa = engine.rpc("get_backup_stats")["overview"], engine.expected.get("whatsapp")
        want = (sum(c["message_count"] for c in wa["chats"]), len(wa["chats"]), "ok") if wa else (0, 0, "not_in_backup")
        assert (o["total_whatsapp_messages"], o["total_whatsapp_chats"], o["whatsapp_status"]) == want
    # WhatsApp: its own totals, apart from Messages'
    einstein_messages = len(ctx.einstein.expected["messages"])
    for engine in (ctx.whatsapp, ctx.whatsapp_enc):
        s = engine.plan.scenario
        stats = engine.rpc("get_backup_stats")
        assert stats["errors"] == []
        o = stats["overview"]
        assert (o["total_whatsapp_messages"], o["total_whatsapp_chats"], o["whatsapp_status"]) == \
            (s.total_messages, len(s.counts), "ok")
        assert o["total_messages"] == (0 if engine.encrypted else einstein_messages)
    # Podcasts: every show, the followed ones, and the listening history, as the screen lists them
    o = ctx.maren.rpc("get_backup_stats")["overview"]
    assert (o["total_podcasts"], o["podcasts_status"]) == (0, "not_in_backup")
    for engine in (ctx.podcasts, ctx.podcasts_enc):
        s = engine.plan.scenario
        stats = engine.rpc("get_backup_stats")
        assert stats["errors"] == []
        o = stats["overview"]
        assert (o["total_podcasts"], o["total_podcasts_followed"], o["total_podcast_episodes_listened"],
                o["podcasts_status"]) == (len(s.shows), len(s.followed), len(s.listened), "ok")
        assert o["total_podcasts"] == len(engine.podcasts)
        assert o["total_podcast_episodes_listened"] == len(engine.rpc("list_podcast_episodes", listened_only=True)["episodes"])


@contract("get_year_counts")
def case_get_year_counts(ctx):
    m = ctx.maren
    texts = [msg for msg in m.expected["messages"] if not msg["is_reaction"]]
    first = m.rpc("get_year_counts", year=2000)  # "years" and the history span cover the whole backup
    years = first["years"]
    assert (first["year"], first["days"], first["errors"]) == (2000, {}, {})
    assert years == sorted(years) and {int(local_day(msg["date"])[:4]) for msg in texts} <= set(years)
    assert first["history_start"] == min(local_day(msg["date"]) for msg in texts)
    totals = Counter()
    for year in years:
        result = m.rpc("get_year_counts", year=year)
        assert result["year"] == year and result["errors"] == {}
        for day, counts in result["days"].items():
            assert day.startswith(f"{year}-") and set(counts) <= TIMELINE_TYPES and min(counts.values()) > 0
            totals.update(counts)
    # What the Timeline lists: messages but not tapbacks, every photo, every voicemail
    assert totals["message"] == len(texts)
    assert totals["photo"] == len(m.expected["photos"])
    assert totals["voicemail"] == len(m.expected["voicemails"])
    assert totals["note"] > 0
    year = years[-1]
    everyone = m.rpc("get_year_counts", year=year)["days"]
    only = m.rpc("get_year_counts", year=year, types=["photo"])["days"]
    assert only == {day: {"photo": c["photo"]} for day, c in everyone.items() if "photo" in c}
    person = m.rpc("get_year_counts", year=year, identifiers=[m.biggest_conversation["chat_identifier"]])["days"]
    assert person and all(set(c) <= PERSON_TYPES for c in person.values())
    assert all(n <= everyone[day][t] for day, c in person.items() for t, n in c.items())
    err = m.error("get_year_counts", {"udid": m.udid, "year": year, "types": ["bogus"]})
    assert "Unknown data types" in err.message


@contract("get_messages_on_day")
def case_get_messages_on_day(ctx):
    m = ctx.maren
    year = int(local_day(m.biggest_conversation["last_message_date"])[:4])
    days = m.rpc("get_year_counts", year=year, types=["message"])["days"]
    picked = sorted(days, key=lambda d: (-days[d]["message"], d))[:3] + [min(days), max(days)]
    for day in picked:
        result = m.rpc("get_messages_on_day", day=day)
        messages = [msg for c in result["conversations"] for msg in c["messages"]]
        assert all(local_day(msg["date"]) == day for msg in messages), day
        assert sum(1 for msg in messages if not msg["is_reaction"]) == days[day]["message"]
        for c in result["conversations"]:
            ids = [msg["message_id"] for msg in c["messages"]]
            assert ids and ids == sorted(ids)
    assert m.rpc("get_messages_on_day", day="1999-01-01") == {"conversations": []}


# Live-iPhone methods. No CI runner has an iPhone (or, on Linux and Windows, the
# usbmuxd service that finds one), so each must answer with a result or a clean
# error the Back up my iPhone screen understands, quickly, and leave the engine running.

@contract("backup.list_devices")
def case_backup_list_devices(ctx):
    engine = ctx.device
    try:
        result = engine.call("backup.list_devices", timeout=180)
    except SidecarError as e:
        # Linux without usbmuxd, Windows without Apple Devices: a setup step, not a crash
        assert e.message.startswith("DEVICE_SERVICE_REQUIRED: ") or "Apple Devices" in e.message, e.message
    else:
        assert isinstance(result["devices"], list)
        for device in result["devices"]:  # a developer's own iPhone may be plugged in
            assert isinstance(device["udid"], str) and device["udid"] and isinstance(device["name"], str)
            assert device["connection_type"] in ("usb", "wifi") and isinstance(device["trusted"], bool)
    engine.assert_alive()


@contract("backup.pair_device")
def case_backup_pair_device(ctx):
    engine = ctx.device
    err = engine.error("backup.pair_device", {"udid": FAKE_UDID}, timeout=90)
    # macOS: usbmuxd has no such iPhone. Linux, Windows: no usbmuxd to ask.
    assert FAKE_UDID in err.message or "not found" in err.message.lower() \
        or err.message.startswith(DEVICE_SETUP_PREFIXES), err.message
    assert "udid" in engine.error("backup.pair_device", {}).message


@contract("backup.start")
def case_backup_start(ctx):
    engine = ctx.runtime.fresh("backup-start")  # its own engine: nothing else waits on it if it hangs
    out = ctx.out("device-backup")
    started = time.perf_counter()
    err = engine.error("backup.start", {"udid": FAKE_UDID, "output_dir": str(out), "encrypted": False}, timeout=90)
    assert err.message.startswith(DEVICE_SETUP_PREFIXES), err.message
    assert time.perf_counter() - started < 90
    assert files_under(out) == []
    for note in engine.notifications:
        assert note["jsonrpc"] == "2.0" and note["method"] == "backup.progress" and "id" not in note
        params = note["params"]
        assert params["phase"] in BACKUP_PHASES and 0 <= params["percent"] <= 100
        assert all(isinstance(params[k], int) for k in ("percent", "files_done", "files_total", "bytes_done"))


@contract("backup.install_device_support")
def case_backup_install_device_support(ctx):
    if sys.platform == "win32":
        pytest.skip("On Windows this installs Apple Devices with winget and starts it, which a test must "
                    "never do. It is only checked to be registered (test_every_engine_method_has_a_contract_case).")
    started = time.perf_counter()
    err = ctx.device.error("backup.install_device_support", {}, timeout=30)
    assert "only windows" in err.message.lower(), err.message
    assert time.perf_counter() - started < 10


def test_every_engine_method_has_a_contract_case():
    served = set(engine_methods())
    missing = sorted(served - set(CONTRACT))
    stale = sorted(set(CONTRACT) - served)
    problems = []
    if missing:
        problems.append(
            f"The engine serves {missing} with no contract test. For each, add a case to CONTRACT in "
            "python/tests/test_rpc_contract.py that calls it the way the app does and checks the answer:\n\n"
            '    @contract("<method>")\n'
            "    def case_<method>(ctx):\n"
            '        result = ctx.maren.rpc("<method>", ...)  # ctx.maren: Maren\'s backup, opened\n'
            "        assert ...                               # shape, values, files written\n\n"
            "If it reads a kind of data Einstein's backup doesn't have, add an EMPTY_STATES entry too."
        )
    if stale:
        problems.append(f"CONTRACT has cases for {stale}, which the engine no longer serves. Remove them.")
    assert not problems, "\n\n".join(problems)


@pytest.mark.parametrize("method", sorted(CONTRACT))
def test_contract(method, ctx):
    CONTRACT[method](ctx)


def test_encrypted_backup_reads_like_the_plain_one(ctx):
    """The encrypted copy of Maren's backup opens with its password and reads the same as the plain one."""
    plain, enc = ctx.maren, ctx.maren_enc
    assert enc.open_result["status"] == "open" and enc.open_result["info"]["encrypted"] is True
    assert sorted(c["message_count"] for c in enc.conversations) == sorted(c["message_count"] for c in plain.conversations)
    assert sorted(n["title"] for n in enc.notes) == sorted(n["title"] for n in plain.notes)
    assert sorted(p["filename"] for p in enc.photos) == sorted(p["filename"] for p in plain.photos)
    assert all(p["file_hash"].startswith("dcim:") for p in enc.photos)
    assert len(enc.rpc("list_contacts")["contacts"]) == len(plain.rpc("list_contacts")["contacts"])
    assert sorted((v["id"], v["duration"]) for v in enc.voicemails) == sorted((v["id"], v["duration"]) for v in plain.voicemails)


# ── Empty states: Einstein has Messages and Contacts and nothing else ────────

EMPTY_STATES: dict[str, Callable[[BackupEngine, Path], None]] = {}


def empty_state(method: str):
    def register(check):
        EMPTY_STATES[method] = check
        return check
    return register


@empty_state("list_albums")
def empty_list_albums(e, out):
    assert e.rpc("list_albums")["albums"] == []


@empty_state("list_photos")
def empty_list_photos(e, out):
    result = e.rpc("list_photos", offset=0, limit=100)
    assert result["photos"] == [] and result["total"] == 0 and result.get("not_in_backup", 0) == 0


@empty_state("get_photo_thumbnail")
def empty_get_photo_thumbnail(e, out):
    assert_error_dict(e.rpc("get_photo_thumbnail", file_hash="0" * 40), "not found")


@empty_state("get_photo")
def empty_get_photo(e, out):
    assert_error_dict(e.rpc("get_photo", file_hash="0" * 40), "not found")


@empty_state("get_photo_path")
def empty_get_photo_path(e, out):
    assert_error_dict(e.rpc("get_photo_path", file_hash="0" * 40), "not found")


@empty_state("get_photo_metadata")
def empty_get_photo_metadata(e, out):
    assert_error_dict(e.rpc("get_photo_metadata", asset_uuid="00000000-0000-0000-0000-000000000000"))


@empty_state("get_attachment")
def empty_get_attachment(e, out):
    assert e.rpc("get_attachment", attachment_id=1) == {"error": "Attachment not found"}


@empty_state("list_voicemails")
def empty_list_voicemails(e, out):
    result = e.rpc("list_voicemails")
    assert result["voicemails"] == [] and result.get("empty_reason") == "not_in_backup" and "error" not in result


@empty_state("get_voicemail_audio")
def empty_get_voicemail_audio(e, out):
    assert_error_dict(e.rpc("get_voicemail_audio", voicemail_id=1), "isn't in the backup")


@empty_state("list_calls")
def empty_list_calls(e, out):
    result = e.rpc("list_calls", offset=0, limit=100)
    assert result["calls"] == [] and result["total"] == 0
    # Only an unencrypted backup is told that encrypting would bring call history in
    assert result["empty_reason"] == ("not_in_backup" if e.encrypted else "requires_encryption")


@empty_state("list_notes")
def empty_list_notes(e, out):
    assert e.rpc("list_notes")["notes"] == []


@empty_state("has_browser_history")
def empty_has_browser_history(e, out):
    assert e.rpc("has_browser_history") == {"safari": False, "firefox": False, "has_any": False}


@empty_state("list_browser_history")
def empty_list_browser_history(e, out):
    result = e.rpc("list_browser_history", browser="all", offset=0, limit=0)
    assert result["visits"] == [] and result["total"] == 0


@empty_state("recover_messages")
def empty_recover_messages(e, out):
    result = e.rpc("recover_messages")
    assert result["conversations"] == [] and result["messages_by_conversation"] == {}
    assert result["scanned"] == {"recently_deleted": 0, "orphaned": 0}


@empty_state("export_photos")
def empty_export_photos(e, out):
    result = e.rpc("export_photos", output_dir=str(out), options={})
    assert (result["exported"], result["errors"]) == (0, 0) and files_under(out) == []


@empty_state("export_voicemails")
def empty_export_voicemails(e, out):
    assert e.rpc("export_voicemails", output_dir=str(out)) == {"status": "success", "exported": 0}
    assert files_under(out) == []


@empty_state("export_bundle")
def empty_export_bundle(e, out):
    result = e.rpc("export_bundle", output_dir=str(out))
    path = Path(result["path"])
    assert check_bundle(path) == [] and result["errors"] == {}
    assert result["counts"]["messages"] == len(e.expected["messages"])
    types = json.loads((path / "manifest.json").read_text(encoding="utf-8"))["types"]
    for kind in ("calls", "voicemail", "photos"):
        assert types[kind]["count"] == 0 and types[kind]["empty_reason"], (kind, types[kind])
    assert types["voicemail"]["empty_reason"] == "not_in_backup"


@empty_state("export_calls")
def empty_export_calls(e, out):
    result = e.rpc("export_calls", output_dir=str(out))
    assert result["success"] is False and "no calls" in result["error"].lower() and files_under(out) == []


@empty_state("export_notes")
def empty_export_notes(e, out):
    result = e.rpc("export_notes", note_ids=[1, 2, 3], format="txt", output_dir=str(out))
    assert result["status"] == "error" and result["message"] and files_under(out) == []


@empty_state("export_browser_history")
def empty_export_browser_history(e, out):
    result = e.rpc("export_browser_history", output_dir=str(out))
    assert result["success"] is False and "no browser history" in result["error"].lower()
    assert files_under(out) == []


@empty_state("export_recovered_messages")
def empty_export_recovered_messages(e, out):
    out.mkdir()
    result = e.rpc("export_recovered_messages", format="csv", output_dir=str(out))
    assert (result["message_count"], result["conversation_count"]) == (0, 0)
    assert len(read_csv(Path(result["file"]))) == 1  # the header and nothing else


@empty_state("list_whatsapp_chats")
def empty_list_whatsapp_chats(e, out):
    assert e.rpc("list_whatsapp_chats") == {"conversations": [], "empty_reason": "not_in_backup"}


@empty_state("get_whatsapp_messages")
def empty_get_whatsapp_messages(e, out):
    # chat 1 is a Messages conversation in this backup: never read through here
    assert e.rpc("get_whatsapp_messages", chat_id=1, offset=0, limit=50) == {
        "messages": [], "total": 0, "next_offset": 0, "offset": 0, "limit": 50, "empty_reason": "not_in_backup"}


@empty_state("get_whatsapp_message_offset")
def empty_get_whatsapp_message_offset(e, out):
    assert e.rpc("get_whatsapp_message_offset", chat_id=1, message_id=1) == {"offset": 0, "found": False}


@empty_state("search_whatsapp_messages")
def empty_search_whatsapp_messages(e, out):
    assert e.rpc("search_whatsapp_messages", query="the") == {"results": [], "query": "the", "empty_reason": "not_in_backup"}


@empty_state("get_whatsapp_attachment")
def empty_get_whatsapp_attachment(e, out):
    not_here = {"error": "WhatsApp is not in this backup", "empty_reason": "not_in_backup"}
    assert e.rpc("get_whatsapp_attachment", attachment_id=1) == not_here
    assert e.rpc("get_whatsapp_attachment", attachment_id=1, as_file=True) == not_here


@empty_state("export_whatsapp_chat")
def empty_export_whatsapp_chat(e, out):
    result = e.rpc("export_whatsapp_chat", chat_id=1, format="txt", output_dir=str(out))
    assert result == {"error": "WhatsApp is not in this backup", "empty_reason": "not_in_backup"}
    assert files_under(out) == []


@empty_state("export_whatsapp_chats")
def empty_export_whatsapp_chats(e, out):
    for mode in ("separate", "merged"):
        result = e.rpc("export_whatsapp_chats", chat_ids=[1], conversation_names={"1": "X"}, format="html",
                       output_dir=str(out), mode=mode)
        assert result == {"error": "WhatsApp is not in this backup", "empty_reason": "not_in_backup"}
    assert files_under(out) == []


@empty_state("export_person")
def empty_export_person(e, out):
    # WhatsApp, calls and voicemail aren't in Einstein's backup: the Messages part is still saved,
    # and the part that isn't there is named
    conv = e.biggest_conversation
    messages = [m for m in e.messages_of(conv["chat_id"]) if not m["is_reaction"]]
    out.mkdir()
    result = e.rpc("export_person", format="csv", output_dir=str(out), display_name=conv["display_name"],
                   chat_ids=[conv["chat_id"]], whatsapp_chat_ids=[conv["chat_id"]], call_ids=["vm_1", 1],
                   voicemail_ids=[1])
    assert result["counts"] == {"message": len(messages), "whatsapp": 0, "call": 0, "voicemail": 0}
    assert result["errors"] == {"whatsapp": "WhatsApp is not in this backup"}
    assert result["media"] == {"copied": 0, "not_in_backup": 0, "failed": 0} and "media_folder" not in result
    assert len(read_csv(Path(result["file"]))) - 1 == len(messages)
    assert files_under(out) == [Path(result["file"])]
    # Only what isn't there: nothing to save, and nothing written
    nothing = out / "nothing"
    result = e.rpc("export_person", format="html", output_dir=str(nothing), display_name="X",
                   whatsapp_chat_ids=[1], call_ids=["vm_1"], voicemail_ids=[1])
    assert result == {"error": "WhatsApp is not in this backup", "errors": {"whatsapp": "WhatsApp is not in this backup"}}
    assert not nothing.exists()


@empty_state("list_podcasts")
def empty_list_podcasts(e, out):
    assert e.rpc("list_podcasts") == {"podcasts": [], "empty_reason": "not_in_backup"}


@empty_state("list_podcast_episodes")
def empty_list_podcast_episodes(e, out):
    nothing = {"episodes": [], "empty_reason": "not_in_backup"}
    assert e.rpc("list_podcast_episodes") == nothing
    assert e.rpc("list_podcast_episodes", podcast_id=1, listened_only=True) == nothing


@empty_state("export_podcasts")
def empty_export_podcasts(e, out):
    for fmt in ("opml", "csv"):
        result = e.rpc("export_podcasts", output_dir=str(out), format=fmt)
        assert result == {"error": "There are no podcasts in this backup to save.", "empty_reason": "not_in_backup"}
    assert files_under(out) == []


@empty_state("get_backup_stats")
def empty_get_backup_stats(e, out):
    stats = e.rpc("get_backup_stats")
    assert stats["errors"] == []
    o = stats["overview"]
    assert o["total_messages"] == len(e.expected["messages"]) and o["total_contacts"] == len(e.expected["contacts"])
    for key in ("total_photos", "total_videos", "photos_in_backup", "total_calls", "total_notes", "total_voicemails",
                "total_whatsapp_messages", "total_whatsapp_chats", "total_podcasts", "total_podcasts_followed",
                "total_podcast_episodes_listened"):
        assert o[key] == 0, key
    assert o["whatsapp_status"] == "not_in_backup"
    assert o["podcasts_status"] == "not_in_backup"


@empty_state("get_year_counts")
def empty_get_year_counts(e, out):
    years = e.rpc("get_year_counts", year=2000)["years"]
    assert years
    for year in years:
        result = e.rpc("get_year_counts", year=year)
        assert result["errors"] == {} and result["days"]
        assert {t for counts in result["days"].values() for t in counts} == {"message"}


@pytest.mark.parametrize("method", sorted(EMPTY_STATES))
@pytest.mark.parametrize("key", [EINSTEIN, EINSTEIN_ENCRYPTED])
def test_empty_state(key, method, runtime, tmp_path):
    EMPTY_STATES[method](runtime.backup(key), tmp_path / "out")


# ── Robustness: what a bad request does to the engine ────────────────────────

def test_malformed_json_gets_a_parse_error(runtime):
    engine = runtime.engine("robust")
    for line in ('{"id": 1, "method": "ping"', "not json at all", "{'id': 1, 'method': 'ping'}"):
        reply = engine.send_raw(line)
        assert reply["id"] is None and "result" not in reply, reply
        assert reply["error"]["code"] == -32700 and reply["error"]["message"].startswith("Parse error")
    # A blank line gets no reply at all: the next reply is the ping's
    reply = engine.send_raw("\n" + json.dumps({"id": "after-blank", "method": "ping"}))
    assert reply["id"] == "after-blank" and reply["result"]["status"] == "ok"
    engine.assert_alive()


def test_unknown_method_gets_method_not_found(runtime):
    engine = runtime.engine("robust")
    reply = engine.send_raw(json.dumps({"jsonrpc": "2.0", "id": "u-1", "method": "no_such_method", "params": {}}))
    assert reply["id"] == "u-1" and reply["error"]["code"] == -32601
    assert "no_such_method" in reply["error"]["message"]
    reply = engine.send_raw(json.dumps({"jsonrpc": "2.0", "id": "u-2", "params": {}}))  # no method at all
    assert reply["id"] == "u-2" and reply["error"]["code"] == -32601
    engine.assert_alive()


@pytest.mark.parametrize("method, params, missing", [
    ("open_backup", {}, "udid"),
    ("get_messages", {"udid": FAKE_UDID}, "chat_id"),
    ("get_whatsapp_messages", {"udid": FAKE_UDID}, "chat_id"),
    ("get_attachment", {"udid": FAKE_UDID}, "attachment_id"),
    ("get_whatsapp_attachment", {"udid": FAKE_UDID}, "attachment_id"),
    ("write_file", {"path": "never-written.txt"}, "content"),
    ("get_backup_size", {}, "backup_dir"),
    ("backup.pair_device", {}, "udid"),
    ("backup.start", {"udid": FAKE_UDID}, "output_dir"),
], ids=lambda v: v if isinstance(v, str) else None)
def test_missing_required_param_gets_an_error(runtime, method, params, missing):
    engine = runtime.engine("robust")
    err = engine.error(method, params)  # also checks the engine still answers ping
    assert err.code == -32000 and missing in err.message, err.message


def _unopened_params(tmp_path: Path) -> dict:
    """Every parameter a method that needs an open backup reads before it looks the backup up."""
    return {
        "udid": "00000000-NOT-OPENED-0000", "chat_id": 1, "chat_ids": [1], "message_id": 1,
        "attachment_id": 1, "query": "hello", "file_hash": "0" * 40, "asset_uuid": "X",
        "voicemail_id": 1, "note_ids": [1], "year": 2025, "day": "2025-01-01", "format": "txt",
        "output_dir": str(tmp_path / "never-written"), "offset": 0, "limit": 10,
    }


@pytest.mark.parametrize("method", methods_needing_an_open_backup())
def test_backup_that_is_not_open_gets_a_clean_error(runtime, method, tmp_path):
    engine = runtime.engine("robust")
    err = engine.error(method, _unopened_params(tmp_path))
    assert err.code == -32000
    assert "Backup not open: 00000000-NOT-OPENED-0000" in err.message, (
        f"{method}: {err.message!r}. If that names a parameter, add it to _unopened_params.")
    assert not (tmp_path / "never-written").exists()


@pytest.mark.parametrize("request_id", ["abc", "ünïcødé-🔑", "", "42", 0, -7, 2 ** 53 - 1], ids=repr)
def test_request_id_is_echoed_exactly(runtime, request_id):
    engine = runtime.engine("robust")
    reply = engine.send_raw(json.dumps({"jsonrpc": "2.0", "id": request_id, "method": "ping", "params": {}}))
    assert reply["id"] == request_id and type(reply["id"]) is type(request_id), reply
    assert reply["result"]["status"] == "ok"


def test_every_response_has_its_id_and_one_of_result_or_error(runtime):
    engine = runtime.engine("robust")
    requests = [("ping", {}), ("no_such_method", {}), ("list_conversations", {"udid": FAKE_UDID}),
                ("get_aggregate_stats", {}), ("get_messages", {})]
    for n, (method, params) in enumerate(requests, start=1000):
        reply = engine.send_raw(json.dumps({"jsonrpc": "2.0", "id": n, "method": method, "params": params}))
        assert reply["id"] == n and ("result" in reply) != ("error" in reply), reply
        if "error" in reply:
            assert isinstance(reply["error"]["code"], int) and isinstance(reply["error"]["message"], str)


@pytest.mark.parametrize("params", [None, [], "udid", 7], ids=repr)
def test_params_that_are_not_an_object_get_an_error(runtime, params):
    engine = runtime.engine("robust")
    reply = engine.send_raw(json.dumps({"jsonrpc": "2.0", "id": 9, "method": "list_conversations", "params": params}))
    assert reply["id"] == 9 and isinstance(reply["error"]["code"], int), reply
    engine.assert_alive()


@pytest.mark.parametrize("line", ['[{"jsonrpc": "2.0", "id": 1, "method": "ping"}]', '"ping"', "42", "null"],
                         ids=["batch", "string", "number", "null"])
def test_valid_json_that_is_not_an_object_gets_an_error(runtime, line):
    engine = runtime.fresh("not-an-object")
    try:
        reply = engine.send_raw(line, timeout=30)
    except ProtocolError as e:
        pytest.fail(f"the engine exited instead of answering: {e}")
    assert reply["id"] is None and reply["error"]["code"] == -32600, reply
    engine.assert_alive()


def test_method_that_is_not_a_string_gets_method_not_found(runtime):
    engine = runtime.fresh("method-not-a-string")
    for n, method in enumerate([["ping"], {"name": "ping"}, 42, True]):
        try:
            reply = engine.send_raw(json.dumps({"jsonrpc": "2.0", "id": n, "method": method, "params": {}}), timeout=30)
        except ProtocolError as e:
            pytest.fail(f"the engine exited on method {method!r}: {e}")
        assert reply["id"] == n and reply["error"]["code"] == -32601, reply
    engine.assert_alive()


def test_raw_utf8_request_like_electron(runtime, tmp_path, monkeypatch):
    """Electron sends JSON.stringify output, which leaves non-ASCII text as raw UTF-8 bytes.

    SidecarClient uses Python's json.dumps, which escapes it as \\uXXXX, so the
    cases above never send raw UTF-8. This test does, with Electron's environment:
    no PYTHONUTF8 or PYTHONIOENCODING.
    """
    monkeypatch.delenv("PYTHONUTF8", raising=False)
    monkeypatch.delenv("PYTHONIOENCODING", raising=False)
    engine = runtime.fresh("utf8")
    target = tmp_path / "Łódź café 🥾" / "naïve.txt"
    content = "Łódź, Zürich, São Paulo, Ōsaka, 東京, 🥾\n"
    request = {"jsonrpc": "2.0", "id": "utf8", "method": "write_file", "params": {"path": str(target), "content": content}}
    try:
        reply = engine.send_raw(json.dumps(request, ensure_ascii=False), timeout=30)
    except ProtocolError as e:
        pytest.fail(f"the engine exited on a UTF-8 request: {e}")
    assert reply.get("result") == {"status": "ok", "path": str(target)}, reply
    assert target.read_text(encoding="utf-8") == content
    engine.assert_alive()


def test_whatsapp_reads_send_no_raw_bytes(runtime):
    """Every WhatsApp read, over the whole test backup, leaves no "[RPC ERROR]" in the engine's log.

    The engine turns raw bytes in a result into text and only logs it, so a
    ZMETADATA or ZRECEIPTINFO blob leaking out would pass every shape check.
    """
    wa = runtime.whatsapp()
    for chat in wa.rpc("list_whatsapp_chats")["conversations"]:
        page = wa.rpc("get_whatsapp_messages", chat_id=chat["chat_id"], offset=0, limit=500)
        for m in page["messages"]:
            for a in m["attachments"]:
                wa.rpc("get_whatsapp_attachment", attachment_id=a["attachment_id"], thumbnail=bool(a["thumbnail_path"]))
        wa.rpc("search_whatsapp_messages", query="e", chat_id=chat["chat_id"])
    wa.rpc("get_backup_stats")
    log = Path(wa.client._tmp.name) / "python_log.txt"
    errors = [line for line in log.read_text(encoding="utf-8").splitlines() if "[RPC ERROR]" in line] if log.exists() else []
    assert not errors, errors[:5]


def test_podcast_reads_send_no_raw_bytes(runtime):
    """Every Podcasts read, over the whole test backup, leaves no "[RPC ERROR]" in the engine's log.

    One episode title is stored as a BLOB, as some libraries do: it must come
    back as text, and the engine would only log raw bytes, not fail.
    """
    pod = runtime.podcasts()
    for show in pod.rpc("list_podcasts")["podcasts"]:
        pod.rpc("list_podcast_episodes", podcast_id=show["id"])
    pod.rpc("list_podcast_episodes", listened_only=True)
    pod.rpc("get_backup_stats")
    log = Path(pod.client._tmp.name) / "python_log.txt"
    errors = [line for line in log.read_text(encoding="utf-8").splitlines() if "[RPC ERROR]" in line] if log.exists() else []
    assert not errors, errors[:5]


# ── Speed ────────────────────────────────────────────────────────────────────

def test_performance_budgets(runtime, record_property, capsys):
    item, backup_dir = generated_backup(MAREN)
    engine = runtime.fresh("perf")
    timings = {"engine_start": engine.start_seconds}

    def timed(name, method, **params):
        started = time.perf_counter()
        result = engine.call(method, params)
        timings[name] = time.perf_counter() - started
        return result

    udid = item.udid
    assert timed("open_backup", "open_backup", udid=udid, backup_dir=str(backup_dir))["status"] == "open"
    conversations = timed("list_conversations", "list_conversations", udid=udid)["conversations"]
    biggest = max(conversations, key=lambda c: c["message_count"])
    assert timed("get_messages", "get_messages", udid=udid, chat_id=biggest["chat_id"], offset=0, limit=50)["messages"]
    attachment = next(
        a for c in conversations
        for msg in engine.call("get_messages", {"udid": udid, "chat_id": c["chat_id"], "offset": 0, "limit": 10_000})["messages"]
        for a in msg["attachments"]
    )
    assert "data" in timed("get_attachment_thumb", "get_attachment", udid=udid,
                           attachment_id=attachment["attachment_id"], thumbnail=True)
    photos = timed("list_photos", "list_photos", udid=udid, offset=0, limit=100)["photos"]
    assert "data" in timed("get_photo_thumbnail", "get_photo_thumbnail", udid=udid, file_hash=photos[0]["file_hash"], size=200)
    assert timed("search_messages", "search_messages", udid=udid, query="the")["results"]
    assert timed("get_backup_stats", "get_backup_stats", udid=udid)["errors"] == []
    year = int(item.expected()["backup_date"][:4])
    assert timed("get_year_counts", "get_year_counts", udid=udid, year=year)["days"]

    lines = [f"engine timings on {MAREN} ({sys.platform}), seconds:"]
    for name, budget in PERF_BUDGETS.items():
        record_property(f"seconds_{name}", round(timings[name], 4))
        lines.append(f"  {name:<22}{timings[name]:8.3f}   budget {budget:5.1f}")
    with capsys.disabled():
        print("\n" + "\n".join(lines))
    assert set(timings) == set(PERF_BUDGETS)
    over = {name: round(timings[name], 3) for name, budget in PERF_BUDGETS.items() if timings[name] > budget}
    assert not over, f"over budget (seconds): {over}; budgets: {PERF_BUDGETS}"


# ── Last: stdout stayed pure JSON-RPC ────────────────────────────────────────

def test_stdout_stayed_pure_json(runtime):
    """Every engine this run started wrote only JSON-RPC to stdout (libraries' prints go to stderr).

    SidecarClient also fails the call that sees a stray line; this catches any left after the last call.
    Run last: it's the last test in the file.
    """
    problems = {e.name: e.protocol_errors for e in runtime.live_engines() if e.protocol_errors}
    assert not problems, f"non-JSON lines or stray ids on stdout: {problems}"
    for engine in runtime.live_engines():
        for note in engine.notifications:
            assert note.get("jsonrpc") == "2.0" and note.get("method") in ("backup.progress", "export.progress"), note
            if note["method"] == "export.progress":
                params = note["params"]
                assert set(params) == {"kind", "done", "total", "failed"}, note
                assert 0 <= params["failed"] <= params["done"] <= params["total"], note
