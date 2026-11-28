"""Data bundles (export_bundle, docs/BUNDLE.md) made from every corpus backup.

Each bundle must check against its JSON Schemas and its SHA256SUMS, and hold exactly
what the engine's own list methods return: the same messages, calls, voicemails,
contacts and photos. Generated backups are also checked against their answer keys,
and copy their photo files in; real ones copy attachments and voicemail audio only,
to keep the run short.
"""

import json
import plistlib
import sys
from collections import Counter
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from bundle_schema import check_bundle, read_lines  # noqa: E402

pytestmark = pytest.mark.corpus


@pytest.fixture(scope="session")
def bundles_root(tmp_path_factory) -> Path:
    return tmp_path_factory.mktemp("bundles")


@pytest.fixture
def made(ctx, bundles_root):
    """The bundle made from this item (once per item), and its manifest."""
    ctx.require_open()
    if "bundle" not in ctx.__dict__:
        synthetic = hasattr(ctx.item, "expected") and ctx.item.expected() is not None
        out = bundles_root / ctx.item.key
        out.mkdir(parents=True, exist_ok=True)
        before = len(ctx.client.notifications)
        result = ctx.client.call("export_bundle", {
            "udid": ctx.udid, "output_dir": str(out), "time_zone": "UTC",
            "files": {"photos": synthetic},
        }, timeout=1800)
        # The save's progress reports are expected; take them off the client, whose
        # other tests check that nothing else arrived (test_protocol_stayed_clean)
        progress = ctx.client.notifications[before:]
        del ctx.client.notifications[before:]
        assert progress and all(n["method"] == "export.progress" and n["params"]["kind"] == "bundle"
                                for n in progress), progress[:3]
        assert progress[-1]["params"]["done"] == progress[-1]["params"]["total"]
        path = Path(result["path"])
        manifest = json.loads((path / "manifest.json").read_text(encoding="utf-8"))
        ctx.__dict__["bundle"] = (result, path, manifest)
    return ctx.__dict__["bundle"]


def test_bundle_checks_against_schemas_and_sums(made):
    result, path, _ = made
    assert check_bundle(path) == []
    assert result["errors"] == {}, result["errors"]
    assert result["failed_files"] == 0


def test_bundle_names_its_backup(ctx, made):
    _, _, manifest = made
    with open(ctx.backup_dir / "Info.plist", "rb") as f:
        info = plistlib.load(f)
    backup = manifest["backup"]
    assert backup["ios_version"] == info.get("Product Version")
    assert backup["product_type"] == info.get("Product Type")
    assert backup["encrypted"] is bool(ctx.item.encrypted)
    assert manifest["time_zone_used"] == "UTC" and manifest["schema_version"] == "0.1"


def test_bundle_messages_are_the_engines(ctx, made):
    _, path, manifest = made
    listed = ctx.messages
    if not (path / "messages.jsonl").exists():
        assert listed == []
        return
    bundled = read_lines(path / "messages.jsonl")
    assert Counter((m["chat_id"], m["id"]) for m in bundled) == Counter((m["chat_id"], m["message_id"]) for m in listed)
    assert manifest["types"]["messages"]["count"] == len(bundled)
    by_id = {(m["chat_id"], m["message_id"]): m for m in listed}
    for m in bundled:
        want = by_id[(m["chat_id"], m["id"])]
        assert m["is_from_me"] == want["is_from_me"] and (m["text"] or "") == (want["text"] or "")
        assert m["sender_handle"] is None if m["is_from_me"] else m["sender_handle"] == (want["sender_handle"] or None)
    conversations = json.loads((path / "conversations.json").read_text(encoding="utf-8"))["conversations"]
    assert sorted(c["chat_id"] for c in conversations) == sorted(c["chat_id"] for c in ctx.conversations)
    assert sum(c["message_count"] for c in conversations) == len(bundled)
    attachments = [a for m in bundled for a in m["attachments"]]
    tally = manifest["types"]["messages"]["attachments"]
    assert tally["copied"] + tally["not_in_backup"] + tally["failed"] == len(attachments)
    assert sum(1 for a in attachments if a["path"]) == tally["copied"]


def test_bundle_calls_and_voicemail_are_the_engines(ctx, made):
    _, path, manifest = made
    calls = ctx.calls_result.get("calls", [])
    bundled = read_lines(path / "calls.jsonl")
    assert sorted(c["id"] for c in bundled) == sorted(str(c["call_id"]) for c in calls)
    voicemails = ctx.rpc("list_voicemails", include_deleted=True).get("voicemails", [])
    bundled_vm = read_lines(path / "voicemail.jsonl")
    assert sorted((v["id"], v["phone_number"] or "") for v in bundled_vm) == sorted(
        (str(v["id"]), v["phone_number"] or "") for v in voicemails)
    for v in bundled_vm:
        assert v["is_deleted"] == (v["folder"] == "deleted")
        assert v["folder"] != "spam" or v["is_spam"]
    assert manifest["types"]["voicemail"]["count"] == len(voicemails)


def test_bundle_contacts_and_photos_are_the_engines(ctx, made):
    _, path, manifest = made
    contacts = json.loads((path / "contacts.json").read_text(encoding="utf-8"))["contacts"]
    assert sorted(c["id"] for c in contacts) == sorted(c["id"] for c in ctx.contacts)
    library = ctx.photos_in_album("__library__").get("photos", [])
    photos = read_lines(path / "photos.jsonl")
    assert sorted(p["id"] or "" for p in photos) == sorted(p.get("uuid") or "" for p in library)
    if manifest["files_copied"]["photos"]:
        copied = [p for p in photos if p["path"]]
        assert len(copied) == len(photos) == manifest["types"]["photos"]["photo_files"]["copied"]


def test_bundle_people_add_up(made):
    _, path, manifest = made
    people = json.loads((path / "people.json").read_text(encoding="utf-8"))
    assert people["sources"] == ["messages", "calls", "voicemail"]
    # Voicemail from a number, in the Voicemail and Spam lists: Deleted isn't counted, as on the People screen
    voicemail_from_someone = sum(1 for v in read_lines(path / "voicemail.jsonl")
                                 if v["phone_number"] and v["date_utc"] and not v["is_deleted"])
    assert sum(p["counts"]["voicemail"] for p in people["people"]) == voicemail_from_someone
    if (path / "messages.jsonl").exists():
        dated = Counter(m["chat_id"] for m in read_lines(path / "messages.jsonl") if m["date_utc"])
        conversations = json.loads((path / "conversations.json").read_text(encoding="utf-8"))["conversations"]
        with_someone = {c["chat_id"] for c in conversations if c["chat_identifier"]}
        assert sum(p["counts"]["messages"] for p in people["people"]) == sum(
            n for chat, n in dated.items() if chat in with_someone)


def test_bundle_matches_answer_key(ctx, made):
    expected = ctx.item.expected() if hasattr(ctx.item, "expected") else None
    if not expected:
        pytest.skip("no answer key (not a generated backup)")
    result, _, manifest = made
    counts = result["counts"]
    assert counts["messages"] == len(expected["messages"])
    assert counts["contacts"] == len(expected["contacts"])
    assert counts["voicemail"] == len(expected["voicemails"])
    assert manifest["backup"]["ios_version"] == expected["ios"]
