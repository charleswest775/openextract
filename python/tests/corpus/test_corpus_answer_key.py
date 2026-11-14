"""Generated backups: OpenExtract must extract exactly what the generator wrote (its expected.json).

Only synthetic items (corpus/synthetic.json) have an answer key. Real backups are
checked by the invariants and spot facts instead.
"""

import base64
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


# ── WhatsApp ─────────────────────────────────────────────────────────────────
# The answer key's "whatsapp" section lists chats (status updates aren't chats) and every
# message in arrival order ("sort", WhatsApp's ZSORT) with its replies, reactions, calls,
# locations, attachments and notices; sender_handle is "" for the owner and for notices.

_WA_CALL_OUTCOMES = {"answered": "answered", "missed": "missed", "unanswered": "no_answer"}
_WA_MAGIC = {"image/jpeg": b"\xff\xd8", "application/pdf": b"%PDF-", "audio/ogg": b"OggS"}


def _whatsapp(ctx):
    expected = _expected(ctx)
    if not expected.get("whatsapp"):
        pytest.skip("no WhatsApp in this backup")
    return expected["whatsapp"]


def _whatsapp_threads(ctx, wa):
    """answer-key chat id → (listed chat, its messages in arrival order) as the engine returns them."""
    result = ctx.whatsapp_result
    assert "error" not in result and "empty_reason" not in result, sorted(result)
    listed = {c["chat_jid"]: c for c in ctx.whatsapp_chats}
    assert set(listed) == {c["jid"] for c in wa["chats"]}, "chats listed (status updates are never chats)"
    threads = {}
    for want in wa["chats"]:
        chat = listed[want["jid"]]
        page = ctx.whatsapp_pages[chat["chat_id"]]
        assert page["error"] is None, want["chat"]
        threads[want["chat"]] = (chat, page["messages"])
    return threads


def _wa_wanted(wa, chat_id):
    return [m for m in wa["messages"] if m["chat"] == chat_id]


def test_whatsapp_chats_match_answer_key(ctx):
    wa = _whatsapp(ctx)
    threads = _whatsapp_threads(ctx, wa)
    for want in wa["chats"]:
        got, _ = threads[want["chat"]]
        assert (got["display_name"], got["chat_type"], got["handle"], got["message_count"], got["is_group"], got["service"]) == \
            (want["name"], want["type"], want["handle"], want["message_count"], want["type"] == "group", "WhatsApp"), want["chat"]
        assert parse_iso(got["last_message_date"]) == parse_iso(want["last_message_date"]), want["chat"]
    overview = ctx.stats["overview"]
    assert (overview["total_whatsapp_chats"], overview["total_whatsapp_messages"], overview["whatsapp_status"]) == \
        (len(wa["chats"]), sum(c["message_count"] for c in wa["chats"]), "ok")


def test_whatsapp_messages_match_answer_key(ctx):
    """Every message, in arrival order, with its type, direction, sender, text, time and star."""
    wa = _whatsapp(ctx)
    threads = _whatsapp_threads(ctx, wa)
    for want_chat in wa["chats"]:
        _, messages = threads[want_chat["chat"]]
        want = _wa_wanted(wa, want_chat["chat"])
        got = [(m["sort"], m["message_type"], m["is_from_me"], "" if m["is_from_me"] else m["sender_handle"],
                m["text"], parse_iso(m["date"]), m["starred"]) for m in messages]
        assert got == [(w["sort"], w["kind"], w["is_from_me"], w["sender_handle"], w["text"], parse_iso(w["date"]),
                        w["starred"]) for w in want], want_chat["chat"]
        for m, w in zip(messages, want):
            if not w["is_from_me"] and w["sender_name"]:
                assert m["sender"] == w["sender_name"], (want_chat["chat"], w["sort"])


def test_whatsapp_replies_reactions_calls_and_places_match_answer_key(ctx):
    wa = _whatsapp(ctx)
    threads = _whatsapp_threads(ctx, wa)
    for want_chat in wa["chats"]:
        _, messages = threads[want_chat["chat"]]
        sort_of = {m["message_id"]: m["sort"] for m in messages}
        for m, w in zip(messages, _wa_wanted(wa, want_chat["chat"])):
            where = (want_chat["chat"], w["sort"])
            if w["quoted"]:
                q = m["quoted"] or {}
                assert (sort_of.get(q.get("message_id")), q.get("is_from_me"), q.get("text"), q.get("message_type")) == \
                    (w["quoted"]["sort"], w["quoted"]["is_from_me"], w["quoted"]["text"], w["quoted"]["kind"]), where
            else:
                assert m["quoted"] is None, where
            assert [(r["emoji"], r["is_from_me"], "" if r["is_from_me"] else r["sender_handle"], parse_iso(r["date"]))
                    for r in m["reactions"]] == \
                [(r["emoji"], r["is_from_me"], r["sender_handle"], parse_iso(r["date"])) for r in w["reactions"]], where
            if w["call"]:
                assert m["call"] == {"is_video": w["call"]["video"], "duration": w["call"]["duration"],
                                     "outcome": _WA_CALL_OUTCOMES[w["call"]["outcome"]],
                                     "direction": w["call"]["direction"]}, where
            if w["location"]:
                loc = m["location"]
                assert (round(loc["latitude"], 4), round(loc["longitude"], 4), loc["live"], loc["place_name"],
                        loc["thumbnail_path"]) == (round(w["location"]["lat"], 4), round(w["location"]["lon"], 4),
                                                   w["location"]["live"], w["location"]["place"],
                                                   w["location"]["thumbnail"]), where
                preview = ctx.rpc("get_whatsapp_attachment", attachment_id=loc["attachment_id"], thumbnail=True)
                assert preview.get("data") and preview.get("mime_type") == "image/jpeg", where
            if w["notice"]:
                notice = w["notice"]
                text = {"encrypted": "Messages and calls are end-to-end encrypted.",
                        "created": f"{notice.get('name')} created the group",
                        "added": "You were added" if notice.get("member") == "me" else f"{notice.get('name')} was added"}
                assert m["event_text"] == text[notice["event"]], where


def test_whatsapp_media_matches_answer_key(ctx):
    """Photos, voice messages and documents: in the backup and served whole, or calmly not there."""
    wa = _whatsapp(ctx)
    threads = _whatsapp_threads(ctx, wa)
    seen = 0
    for want_chat in wa["chats"]:
        _, messages = threads[want_chat["chat"]]
        for m, w in zip(messages, _wa_wanted(wa, want_chat["chat"])):
            where = (want_chat["chat"], w["sort"])
            want = w["attachment"]
            if not want:
                assert m["attachments"] == [], where
                continue
            seen += 1
            a = m["attachments"][0]
            assert (a["transfer_name"], a["filename"], a["total_bytes"], a["available"], a["thumbnail_path"],
                    a["width"], a["height"], a["duration"]) == (want["name"], want["path"], want["bytes"],
                                                                want["available"], want["thumbnail"], want["width"],
                                                                want["height"], want["duration"]), where
            assert (a["mime_type"] or "").split(";")[0] == want["mime_type"].split(";")[0], where
            served = ctx.rpc("get_whatsapp_attachment", attachment_id=a["attachment_id"])
            if want["available"]:
                data = base64.b64decode(served.get("data") or "")
                assert len(data) == want["bytes"] and data.startswith(_WA_MAGIC[want["mime_type"].split(";")[0]]), where
            else:
                assert served.get("empty_reason") == "not_in_backup" and served.get("error"), where
            if want["thumbnail"]:
                thumb = ctx.rpc("get_whatsapp_attachment", attachment_id=a["attachment_id"], thumbnail=True)
                assert thumb.get("data"), where
    if not seen:
        pytest.skip("no WhatsApp media in this backup")


def test_whatsapp_people_are_matched_by_number(ctx):
    """A one-to-one chat carries the other person's number, so People can join it to their texts and calls."""
    wa = _whatsapp(ctx)
    names = _names(_expected(ctx))
    for chat in wa["chats"]:
        if chat["type"] != "individual":
            continue
        name = _handle_name(names, chat["handle"])
        assert bool(name) == chat["contact"], chat["chat"]
        if name:
            assert chat["name"] == name, chat["chat"]


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
               ("total_photos", "total_videos", "photos_in_backup")),
    "browser_history": (lambda ctx: ctx.browser_result.get("visits", []), ()),
    "whatsapp": (lambda ctx: ctx.whatsapp_chats, ("total_whatsapp_chats", "total_whatsapp_messages")),
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
    if "whatsapp" in absent:
        # Most iPhones have no WhatsApp: that's "not in this backup", never an error.
        assert ctx.whatsapp_result == {"conversations": [], "empty_reason": "not_in_backup"}
        assert overview["whatsapp_status"] == "not_in_backup"
