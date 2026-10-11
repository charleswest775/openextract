"""Generated backups: OpenExtract must extract exactly what the generator wrote (its expected.json).

Only synthetic items (corpus/synthetic.json) have an answer key. Real backups are
checked by the invariants and spot facts instead.
"""

from collections import Counter

import pytest

from corpus.facts import parse_iso

pytestmark = pytest.mark.corpus


def _expected(ctx):
    expected = ctx.item.expected() if hasattr(ctx.item, "expected") else None
    if not expected:
        pytest.skip("no answer key (not a generated backup)")
    ctx.require_open()
    return expected


def _names(expected):
    """handle → "First Last" for every contact, as the app should display them."""
    names = {}
    for contact in expected["contacts"]:
        name = " ".join(p for p in (contact["first"], contact["last"]) if p) or contact["organization"]
        for value in contact["phones"] + contact["emails"]:
            names[value] = name
    return names


def _handle_name(names, handle):
    if handle in names:
        return names[handle]
    digits = "".join(ch for ch in handle if ch.isdigit())
    return next((name for value, name in names.items() if digits and "".join(c for c in value if c.isdigit()) == digits), None)


def test_contacts_match_answer_key(ctx):
    expected = _expected(ctx)
    listed = Counter((c.get("first_name") or "", c.get("last_name") or "") for c in ctx.contacts)
    wanted = Counter((c["first"], c["last"]) for c in expected["contacts"])
    assert listed == wanted
    by_name = {(c.get("first_name") or "", c.get("last_name") or ""): c for c in ctx.contacts}
    for contact in expected["contacts"]:
        got = by_name[(contact["first"], contact["last"])]
        assert sorted(got.get("phones") or []) == sorted(contact["phones"]), contact["first"]
        assert sorted(got.get("emails") or []) == sorted(contact["emails"]), contact["first"]


def test_conversations_match_answer_key(ctx):
    expected = _expected(ctx)
    names = _names(expected)
    listed = {c["chat_identifier"]: c for c in ctx.conversations}
    assert set(listed) == {c["chat_identifier"] for c in expected["conversations"]}
    for want in expected["conversations"]:
        got = listed[want["chat_identifier"]]
        assert got["message_count"] == want["message_count"], want["chat"]
        assert got["is_group"] == want["is_group"], want["chat"]
        assert got["service"] == want["service"], want["chat"]
        if want["is_group"]:
            assert got["display_name"] == want["name"], want["chat"]
        else:
            assert got["display_name"] == _handle_name(names, want["chat_identifier"]), want["chat"]
        assert parse_iso(got["last_message_date"]) == parse_iso(want["last_message_date"]), want["chat"]


def test_messages_match_answer_key(ctx):
    expected = _expected(ctx)
    chats = {c["chat_id"]: c["chat_identifier"] for c in ctx.conversations}
    got = Counter(
        (chats[m["chat_id"]], m["text"], m["is_from_me"], m["is_reaction"], parse_iso(m["date"])) for m in ctx.messages
    )
    want = Counter(
        (m["chat_identifier"], m["text"], m["is_from_me"], m["is_reaction"], parse_iso(m["date"])) for m in expected["messages"]
    )
    missing, extra = want - got, got - want
    assert not missing and not extra, f"missing {list(missing)[:3]} … extra {list(extra)[:3]} …"


def test_received_messages_name_their_sender(ctx):
    expected = _expected(ctx)
    names = _names(expected)
    senders = {(m["text"], parse_iso(m["date"])): m["sender_handle"] for m in expected["messages"] if not m["is_from_me"]}
    wrong = [
        (m["text"][:30], m["sender"])
        for m in ctx.messages
        if not m["is_from_me"]
        and (handle := senders.get((m["text"], parse_iso(m["date"])))) is not None
        and m["sender"] != _handle_name(names, handle)
    ]
    assert not wrong, f"senders shown wrongly: {wrong[:5]}"


_APPS = {"phone": "Phone", "facetime-audio": "FaceTime Audio", "facetime-video": "FaceTime Video"}


def _minute(iso: str) -> int:
    return int(parse_iso(iso).timestamp()) // 60


def test_calls_match_answer_key(ctx):
    """Every call, plus a missed call for each voicemail that has none (the app merges them in)."""
    expected = _expected(ctx)
    if not expected.get("calls") and not expected.get("voicemails"):
        pytest.skip("no calls or voicemails in this backup")
    want = Counter(
        (c["address"], parse_iso(c["date"]), c["duration"], "outgoing" if c["outgoing"] else "incoming",
         "answered" if c["answered"] else "missed", _APPS[c["service"]], c["contact"] or c["address"])
        for c in expected["calls"]
    )
    called = {(c["address"], _minute(c["date"])) for c in expected["calls"]}
    want.update(
        (v["sender"], parse_iso(v["date"]), v["duration"], "incoming", "missed", "Phone", v["contact"] or v["sender"])
        for v in expected["voicemails"] if (v["sender"], _minute(v["date"])) not in called
    )
    got = Counter(
        (c["address"], parse_iso(c["date"]), c["duration"], c["direction"], c["status"], c["app"], c["contact_name"])
        for c in ctx.calls_result.get("calls", [])
    )
    missing, extra = want - got, got - want
    assert not missing and not extra, f"missing {list(missing)[:3]} … extra {list(extra)[:3]} …"


def test_voicemails_match_answer_key(ctx):
    expected = _expected(ctx)
    if "voicemail" in expected.get("absent", {}):
        pytest.skip("no voicemail in this backup")
    want = Counter((v["sender"], parse_iso(v["date"]), v["duration"], v["contact"] or v["sender"])
                   for v in expected["voicemails"])
    got = Counter((v["phone_number"], parse_iso(v["date_received"]), v["duration"], v["contact_name"])
                  for v in ctx.voicemails_result.get("voicemails", []))
    missing, extra = want - got, got - want
    assert not missing and not extra, f"missing {list(missing)[:3]} … extra {list(extra)[:3]} …"


# Data types a generated backup doesn't hold (expected.json "absent"), with the extracted list
# that must come back empty and the dashboard totals that must be zero. Types the app doesn't
# read yet are left out.
ABSENT_CHECKS = {
    "messages": (lambda ctx: ctx.conversations, ("total_messages", "total_conversations")),
    "contacts": (lambda ctx: ctx.contacts, ("total_contacts",)),
    "calls": (lambda ctx: ctx.calls_result.get("calls", []), ("total_calls",)),
    "voicemail": (lambda ctx: ctx.voicemails_result.get("voicemails", []), ("total_voicemails",)),
    "notes": (lambda ctx: ctx.notes_result.get("notes", []), ("total_notes",)),
    "photos": (lambda ctx: ctx.photos_result.get("photos", []) + ctx.albums_result.get("albums", []),
               ("total_photos", "total_videos")),
    "browser_history": (lambda ctx: ctx.browser_result.get("visits", []), ()),
}


def test_absent_data_types_come_back_empty(ctx):
    """A backup without a data type must show that tab empty, not fail or invent rows."""
    expected = _expected(ctx)
    absent = [t for t in expected.get("absent", {}) if t in ABSENT_CHECKS]
    if expected.get("voicemails") and "calls" in absent:
        absent.remove("calls")  # voicemails show in the call list; test_calls_match_answer_key covers them
    if not absent:
        pytest.skip("the backup holds every data type the app reads")
    overview = ctx.stats["overview"]
    for data_type in absent:
        listed, totals = ABSENT_CHECKS[data_type]
        assert listed(ctx) == [], data_type
        for total in totals:
            assert overview[total] == 0, f"{data_type}: {total}"
