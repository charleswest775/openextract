"""The Year view's counts on generated backups, checked against the answer key and the Timeline.

Every day of every year must hold exactly what the Timeline's own sources list
for that day, because clicking a day opens the Timeline on it.
"""

from collections import Counter, defaultdict
from datetime import datetime

import pytest

from corpus.facts import parse_iso

pytestmark = pytest.mark.corpus


def _local_day(iso: str) -> str:
    return datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone().date().isoformat()


def _synthetic(ctx):
    expected = ctx.item.expected() if hasattr(ctx.item, "expected") else None
    if not expected:
        pytest.skip("no answer key (not a generated backup)")
    ctx.require_open()
    return expected


def _all_days(ctx, **params) -> dict:
    """{type: Counter of day} across every year the backup holds."""
    first = ctx.rpc("get_year_counts", year=2000, **params)
    assert first["errors"] == {}
    out = defaultdict(Counter)
    for year in first["years"]:
        result = ctx.rpc("get_year_counts", year=year, **params)
        for day, counts in result["days"].items():
            assert day.startswith(str(year))
            for entry_type, count in counts.items():
                out[entry_type][day] = count
    return out


def _timeline_days(ctx) -> dict:
    """What the Timeline's sources list, by the same local day (src/hooks/useTimeline.ts)."""
    out = defaultdict(Counter)
    seen = set()
    for m in ctx.messages:
        if m["is_reaction"] or not m["date"] or m["message_id"] in seen:
            continue
        seen.add(m["message_id"])
        out["message"][_local_day(m["date"])] += 1
    for c in ctx.calls_result.get("calls", []):
        out["call"][_local_day(c["date"])] += 1
    for p in ctx.photos_result.get("photos", []):
        if p.get("date_created"):
            out["photo"][_local_day(p["date_created"])] += 1
    for v in ctx.voicemails_result.get("voicemails", []):
        if v["date_received"]:
            out["voicemail"][_local_day(v["date_received"])] += 1
    for n in ctx.notes_result.get("notes", []):
        if n.get("created") or n.get("modified"):
            out["note"][_local_day(n.get("created") or n.get("modified"))] += 1
    for v in ctx.browser_result.get("visits", []):
        if v.get("visit_date"):
            out["browser"][_local_day(v["visit_date"])] += 1
    return out


def test_every_day_matches_the_timeline(ctx):
    _synthetic(ctx)
    got, want = _all_days(ctx), _timeline_days(ctx)
    for entry_type in ("message", "call", "photo", "voicemail", "note", "browser"):
        assert got[entry_type] == want[entry_type], entry_type


def test_messages_match_answer_key(ctx):
    expected = _synthetic(ctx)
    want = Counter(_local_day(m["date"]) for m in expected["messages"] if not m["is_reaction"])
    assert _all_days(ctx, types=["message"])["message"] == want


def test_photos_match_answer_key(ctx):
    expected = _synthetic(ctx)
    want = Counter(_local_day(p["date"]) for p in expected["photos"] if not p["trashed"])
    assert _all_days(ctx, types=["photo"])["photo"] == want


def test_history_start_and_years(ctx):
    expected = _synthetic(ctx)
    result = ctx.rpc("get_year_counts", year=2000)
    messages = [m for m in expected["messages"] if not m["is_reaction"]]
    want_start = min((_local_day(m["date"]) for m in messages), default=None)
    assert result["history_start"] == want_start
    want_years = {int(d[:4]) for days in _timeline_days(ctx).values() for d in days}
    assert set(result["years"]) == want_years
    assert result["years"] == sorted(result["years"])
    assert result["history_end"] == parse_iso(expected["backup_date"]).astimezone().date().isoformat()


def test_a_person_gets_their_chats_calls_and_voicemail_only(ctx):
    expected = _synthetic(ctx)
    groups = [c for c in expected["conversations"] if c["is_group"]]
    direct = [c for c in expected["conversations"] if not c["is_group"]]
    if not direct:
        pytest.skip("no one-to-one conversations")
    chat = max(direct, key=lambda c: c["message_count"])
    identifier = chat["chat_identifier"]
    got = _all_days(ctx, identifiers=[identifier])

    want = Counter(
        _local_day(m["date"]) for m in expected["messages"]
        if m["chat_identifier"] == identifier and not m["is_reaction"]
    )
    assert got["message"] == want
    # Being in a group chat doesn't bring its messages along: those stay out.
    if groups:
        assert sum(got["message"].values()) == sum(want.values())
    assert got["photo"] == Counter() and got["note"] == Counter() and got["browser"] == Counter()

    calls = Counter(_local_day(c["date"]) for c in ctx.calls_result.get("calls", []) if c["address"] == identifier)
    assert got["call"] == calls
    voicemail = Counter(_local_day(v["date"]) for v in expected["voicemails"] if v["sender"] == identifier)
    assert got["voicemail"] == voicemail


def test_a_group_chat_counts_when_named(ctx):
    expected = _synthetic(ctx)
    groups = [c for c in expected["conversations"] if c["is_group"]]
    if not groups:
        pytest.skip("no group chats")
    identifier = groups[0]["chat_identifier"]
    want = Counter(
        _local_day(m["date"]) for m in expected["messages"]
        if m["chat_identifier"] == identifier and not m["is_reaction"]
    )
    assert _all_days(ctx, identifiers=[identifier], types=["message"])["message"] == want


def test_messages_on_day_match_the_counts(ctx):
    _synthetic(ctx)
    days = _timeline_days(ctx)["message"]
    if not days:
        pytest.skip("no messages")
    for day in sorted(days)[:: max(len(days) // 25, 1)]:
        result = ctx.rpc("get_messages_on_day", day=day)
        shown = {
            m["message_id"] for c in result["conversations"] for m in c["messages"]
            if not m["is_reaction"]
        }
        assert len(shown) == days[day], day
