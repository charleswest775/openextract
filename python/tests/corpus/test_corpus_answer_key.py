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
    # Businesses have only an organization, so it's part of the key.
    listed = Counter((c.get("first_name") or "", c.get("last_name") or "", c.get("organization") or "") for c in ctx.contacts)
    wanted = Counter((c["first"], c["last"], c["organization"]) for c in expected["contacts"])
    assert listed == wanted
    by_name = {(c.get("first_name") or "", c.get("last_name") or "", c.get("organization") or ""): c for c in ctx.contacts}
    for contact in expected["contacts"]:
        got = by_name[(contact["first"], contact["last"], contact["organization"])]
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


def test_notes_match_answer_key(ctx):
    expected = _expected(ctx)
    if not expected.get("notes"):
        pytest.skip("no notes in this backup")
    want = Counter((n["title"], n["text"], parse_iso(n["created"]), parse_iso(n["modified"])) for n in expected["notes"])
    got = Counter(
        (n["title"], n["body"], parse_iso(n["created"]) if n.get("created") else None, parse_iso(n["modified"]))
        for n in ctx.notes_result.get("notes", [])
    )
    missing, extra = want - got, got - want
    assert not missing and not extra, f"missing {list(missing)[:2]} … extra {list(extra)[:2]} …"


def test_browser_history_matches_answer_key(ctx):
    expected = _expected(ctx)
    if not expected.get("browser_history"):
        pytest.skip("no browser history in this backup")
    # The app folds a page revisited within two minutes into one visit.
    want, kept = Counter(), {}
    for v in sorted(expected["browser_history"], key=lambda v: v["date"]):
        when, headline = parse_iso(v["date"]), v["title"] or v["url"]
        if headline in kept and (when - kept[headline]).total_seconds() < 120:
            continue
        kept[headline] = when
        want[(v["url"], v["title"], when)] += 1
    got = Counter((v["url"], v["title"], parse_iso(v["visit_date"])) for v in ctx.browser_result.get("visits", []))
    missing, extra = want - got, got - want
    assert not missing and not extra, f"missing {list(missing)[:3]} … extra {list(extra)[:3]} …"


def _photos(ctx):
    expected = _expected(ctx)
    if not expected.get("photos"):
        pytest.skip("no photos in this backup")
    return expected, [p for p in expected["photos"] if not p["trashed"]]


def test_photos_match_answer_key(ctx):
    """Every photo outside Recently Deleted, with its size, date, favourite flag and location."""
    _, shown = _photos(ctx)
    want = Counter((p["filename"], p["width"], p["height"], p["favorite"], parse_iso(p["date"])) for p in shown)
    listed = ctx.photos_result.get("photos", [])
    got = Counter((p["filename"], p["width"], p["height"], p["favorite"], parse_iso(p["date_created"])) for p in listed)
    missing, extra = want - got, got - want
    assert not missing and not extra, f"missing {list(missing)[:3]} … extra {list(extra)[:3]} …"
    by_name = {p["filename"]: p for p in listed}
    for photo in (p for p in shown if p["lat"] is not None):
        got_photo = by_name[photo["filename"]]
        assert (round(got_photo["latitude"], 4), round(got_photo["longitude"], 4)) == (round(photo["lat"], 4), round(photo["lon"], 4))


def test_albums_match_answer_key(ctx):
    _, shown = _photos(ctx)
    want = Counter(title for p in shown for title in p["albums"])
    got = {a["title"]: a["asset_count"] for a in ctx.albums_result.get("albums", []) if a["id"] != "__all__"}
    assert got == dict(want)


def test_unlocated_photos_have_no_coordinates(ctx):
    """iOS stores -180 for "no location"; the app must not show that as a place or count it."""
    _, shown = _photos(ctx)
    unlocated = {p["filename"] for p in shown if p["lat"] is None}
    if not unlocated:
        pytest.skip("every photo has a location")
    wrong = [(p["filename"], p["latitude"]) for p in ctx.photos_result.get("photos", [])
             if p["filename"] in unlocated and p["latitude"] is not None]
    assert not wrong, f"photos without a location show coordinates: {wrong}"
    assert ctx.stats["photos"]["with_location"] == len(shown) - len(unlocated)


def test_photo_attachments_match_answer_key(ctx):
    expected = _expected(ctx)
    sent = Counter((m["attachment"]["name"], m["attachment"]["bytes"]) for m in expected["messages"] if m.get("attachment"))
    if not sent:
        pytest.skip("no attachments in this backup")
    got = Counter((a["transfer_name"], a["total_bytes"]) for m in ctx.messages for a in m.get("attachments") or [])
    assert got == sent


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
