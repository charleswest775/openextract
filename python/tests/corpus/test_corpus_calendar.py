"""Calendar invariants for every backup in the corpus.

What the engine's Calendar methods return, checked against Calendar.sqlitedb
read directly (``raw_backup.RawBackup``, not ios-backup-core): every event row
is listed once (hidden and junk ones only when asked for), every calendar the
app shows is a real one and the CalDAV scheduling collections aren't, all-day
events keep the day they were stored with (never moved by a time zone), timed
events are the instants stored, repeating events carry their rule, and the
.ics and CSV saves hold what the screen lists.

The public Hickman backups' counts (from the Calendar research, counted on the
raw databases) are pinned in HICKMAN, so a change in what is read shows up as
a number, not only as a disagreement between two readers.

Failure messages name ids and counts only, never titles, places or people from a backup.
"""

import csv
import re
from collections import Counter
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

from corpus.facts import parse_iso

pytestmark = pytest.mark.corpus

CALENDAR = ("HomeDomain", "Library/Calendar/Calendar.sqlitedb")
EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)
EARLIEST = datetime(1900, 1, 1, tzinfo=timezone.utc)  # birthdays and holidays can start long ago
FUTURE_YEARS = 15  # holiday subscriptions run years past the backup
SCHEDULING = ("/inbox/", "/outbox/", "/notification/")
NOTHING_TO_SAVE = "There are no calendar events in this backup to save."

# Counted on the raw databases (maps/research-calendar.md §4): events (entity_type 2), all-day
# events, timed events, series masters, events with invitees.
HICKMAN = {
    "pub-hickman-13.3.1": {"events": 119, "all_day": 118, "timed": 1, "repeating": 26, "with_attendees": 0},
    "pub-hickman-13.4.1": {"events": 119, "all_day": 118, "timed": 1, "repeating": 26, "with_attendees": 0},
    "pub-hickman-15.3.1": {"events": 133, "all_day": 129, "timed": 4, "repeating": 26, "with_attendees": 2},
    "pub-hickman-16.1.2": {"events": 142, "all_day": 137, "timed": 5, "repeating": 28, "with_attendees": 3},
    "pub-hickman-17.3": {"events": 144, "all_day": 137, "timed": 7, "repeating": 28, "with_attendees": 5},
}


def _sample(values, limit=5):
    values = list(values)
    return f"{values[:limit]}{' …' if len(values) > limit else ''} ({len(values)} total)"


def _files_under(folder: Path) -> list[Path]:
    return sorted(p for p in folder.rglob("*") if p.is_file())


def _cocoa(value):
    if value is None or isinstance(value, (bytes, str)) or abs(float(value)) >= 6.3e10:
        return None
    return EPOCH + timedelta(seconds=float(value))


class RawCalendar:
    """Calendar.sqlitedb, read raw: what the app should list."""

    def __init__(self, ctx):
        ctx.require_open()
        conn = ctx.raw.connect(*CALENDAR)
        if conn is None:
            pytest.skip("no Calendar.sqlitedb in this backup")
        self.conn = conn
        tables = ctx.raw.tables(conn)
        if "CalendarItem" not in tables:
            pytest.skip("this Calendar.sqlitedb has no CalendarItem table")
        cols = ctx.raw.columns(conn, "CalendarItem")

        def col(name, fallback="NULL"):
            return name if name in cols else fallback

        where = "WHERE entity_type = 2" if "entity_type" in cols else ""
        self.items = {}
        for r in conn.execute(
            f"SELECT ROWID, calendar_id, start_date, end_date, start_tz, end_tz, all_day, "
            f"{col('has_recurrences', '0')} AS has_recurrences, {col('hidden', '0')} AS hidden, "
            f"{col('junk_status', '0')} AS junk, {col('phantom_master', '0')} AS phantom, "
            f"{col('has_attendees', '0')} AS has_attendees FROM CalendarItem {where}"
        ):
            if r["phantom"]:
                continue
            self.items[r["ROWID"]] = dict(r)
        self.recurrences = {r[0] for r in conn.execute("SELECT DISTINCT owner_id FROM Recurrence")} \
            if "Recurrence" in tables else set()
        cal_cols = ctx.raw.columns(conn, "Calendar") if "Calendar" in tables else set()
        self.calendars = {}
        if cal_cols:
            supported = "supported_entity_types" if "supported_entity_types" in cal_cols else "NULL"
            for r in conn.execute(f"SELECT ROWID, external_id, {supported} AS supported FROM Calendar"):
                self.calendars[r["ROWID"]] = dict(r)

    @property
    def shown(self) -> dict:
        """Events the screen lists by default: not hidden, not junk."""
        return {i: r for i, r in self.items.items() if not r["hidden"] and not (r["junk"] or 0) > 0}

    def listed_calendars(self) -> set:
        """Calendars the app shows: not a scheduling collection, not an empty reminders-only list."""
        with_events = Counter(r["calendar_id"] for r in self.items.values())
        out = set()
        for cid, c in self.calendars.items():
            external = (c["external_id"] or "")
            external = external.decode("utf-8", "replace") if isinstance(external, bytes) else external
            if external.lower().endswith(SCHEDULING):
                continue
            if c["supported"] is not None and not c["supported"] & 4 and not with_events.get(cid):
                continue
            out.add(cid)
        return out

    def close(self):
        self.conn.close()


@pytest.fixture
def raw_calendar(ctx):
    cal = RawCalendar(ctx)
    yield cal
    cal.close()


@pytest.fixture
def events(ctx, raw_calendar):
    result = ctx.calendar_events_result
    assert "error" not in result, f"list_calendar_events: {result.get('error')!r}"
    if not raw_calendar.shown:
        assert result.get("events") == [] and result.get("empty_reason") == "no_records", sorted(result)
    return result.get("events", [])


def test_calendar_absent_is_calm(ctx, tmp_path):
    """A backup without Calendar.sqlitedb says so, without an error, on the screen, in the counts and on save."""
    ctx.require_open()
    if ctx.raw.has_file(*CALENDAR):
        pytest.skip("this backup has a calendar")
    assert ctx.calendars_result == {"calendars": [], "empty_reason": "not_in_backup"}
    assert ctx.calendar_events_result == {"events": [], "empty_reason": "not_in_backup"}
    o = ctx.stats.get("overview", {})
    counts = (o.get("total_calendar_events"), o.get("total_subscribed_events"), o.get("total_calendars"),
              o.get("total_calendars_with_events"), o.get("calendar_status"))
    assert counts == (0, 0, 0, 0, "not_in_backup"), counts
    for fmt in ("ics", "csv"):
        out = tmp_path / fmt
        out.mkdir()
        result = ctx.rpc("export_calendar", output_dir=str(out), format=fmt)
        assert result == {"error": NOTHING_TO_SAVE, "empty_reason": "not_in_backup"}, sorted(result)
        assert _files_under(out) == [], f"{fmt}: wrote {len(_files_under(out))} files for a backup without a calendar"


def test_every_event_listed_once(ctx, raw_calendar, events):
    ids = [e["id"] for e in events]
    assert len(ids) == len(set(ids)), f"{len(ids) - len(set(ids))} events listed twice"
    shown = set(raw_calendar.shown)
    assert set(ids) == shown, (
        f"missing events {_sample(sorted(shown - set(ids)))}, unexpected events {_sample(sorted(set(ids) - shown))}"
    )
    hidden = len(raw_calendar.items) - len(shown)
    assert ctx.calendar_events_result.get("hidden_count") == hidden, \
        f"hidden_count {ctx.calendar_events_result.get('hidden_count')}, raw has {hidden} hidden or junk events"
    every = ctx.rpc("list_calendar_events", include_hidden=True)
    assert {e["id"] for e in every.get("events", [])} == set(raw_calendar.items), "include_hidden doesn't list them all"


def test_hickman_counts(ctx, raw_calendar, events):
    want = HICKMAN.get(ctx.item.key)
    if want is None:
        pytest.skip("no pinned counts for this backup")
    got = {
        "events": len(events),
        "all_day": sum(1 for e in events if e["all_day"]),
        "timed": sum(1 for e in events if not e["all_day"]),
        "repeating": sum(1 for e in events if e["recurrence"]),
        "with_attendees": sum(1 for e in events if e["attendees"]),
    }
    assert got == want


def test_calendars_match(ctx, raw_calendar, events):
    result = ctx.calendars_result
    assert "error" not in result, f"list_calendars: {result.get('error')!r}"
    listed = {c["id"]: c for c in result.get("calendars", [])}
    want = raw_calendar.listed_calendars()
    assert set(listed) == want, (
        f"missing calendars {sorted(want - set(listed))}, unexpected calendars {sorted(set(listed) - want)}"
    )
    per_calendar = Counter(r["calendar_id"] for r in raw_calendar.shown.values())
    counts = {cid: (c["event_count"], per_calendar.get(cid, 0)) for cid, c in listed.items()
              if c["event_count"] != per_calendar.get(cid, 0)}
    assert not counts, f"event_count differs from CalendarItem rows (listed, raw): {counts}"
    for cid in list(listed)[:4]:
        page = ctx.rpc("list_calendar_events", calendar_id=cid)
        assert len(page.get("events", [])) == listed[cid]["event_count"], f"calendar {cid}"
    kinds = Counter(c["kind"] for c in listed.values())
    assert set(kinds) <= {"normal", "holidays", "birthdays", "suggestions", "subscribed"}, kinds
    orphans = {e["id"] for e in events if e["calendar_id"] not in listed}
    assert not orphans, f"events in no listed calendar: {_sample(sorted(orphans))}"


def test_all_day_events_keep_their_day(ctx, raw_calendar, events):
    """July 4 stays July 4: a floating all-day event's day is its stored UTC date, never a local one."""
    by_id = {e["id"]: e for e in events}
    wrong = []
    for rid, raw in raw_calendar.shown.items():
        if not raw["all_day"] or raw["start_tz"] != "_float":
            continue
        start, end = _cocoa(raw["start_date"]), _cocoa(raw["end_date"])
        e = by_id[rid]
        days = max(1, round(((end - start).total_seconds() + 1) / 86400)) if end else 1
        want = (start.date().isoformat(), (start.date() + timedelta(days=days - 1)).isoformat(), days, None, None)
        if (e["start_day"], e["end_day"], e["days"], e["start"], e["wall_start"]) != want:
            wrong.append(rid)
    assert not wrong, f"all-day events not on their stored day: {_sample(wrong)}"


def test_timed_events_are_the_stored_instants(ctx, raw_calendar, events):
    by_id = {e["id"]: e for e in events}
    wrong, zones = [], []
    for rid, raw in raw_calendar.shown.items():
        if raw["all_day"]:
            continue
        e = by_id[rid]
        if raw["start_tz"] == "_float":
            if e["wall_start"] != _cocoa(raw["start_date"]).replace(tzinfo=None).isoformat(timespec="seconds"):
                wrong.append(rid)
            continue
        if parse_iso(e["start"]) != _cocoa(raw["start_date"]):
            wrong.append(rid)
        if e["time_zone"] != raw["start_tz"]:
            zones.append(rid)
    assert not wrong, f"timed events whose start isn't the stored time: {_sample(wrong)}"
    assert not zones, f"timed events that lost their zone name: {_sample(zones)}"


def test_event_dates_plausible(ctx, events):
    latest = (ctx.backup_date or datetime.now(timezone.utc)) + timedelta(days=366 * FUTURE_YEARS)
    bad, backwards = [], []
    for e in events:
        if e["all_day"]:
            first = date.fromisoformat(e["start_day"])
            last = date.fromisoformat(e["end_day"])
            start, end = datetime(first.year, first.month, first.day, tzinfo=timezone.utc), \
                datetime(last.year, last.month, last.day, tzinfo=timezone.utc)
        elif e["floating"]:
            start, end = parse_iso(e["wall_start"]), parse_iso(e["wall_end"])
        else:
            start, end = parse_iso(e["start"]), parse_iso(e["end"])
        if start is None or not EARLIEST <= start <= latest:
            bad.append(e["id"])
        elif end is not None and end < start:
            backwards.append(e["id"])
    assert not bad, f"impossible event starts (allowed {EARLIEST.date()} to {latest.date()}): {_sample(bad)}"
    assert not backwards, f"events ending before they start: {_sample(backwards)}"


def test_repeating_events_carry_their_rule(ctx, raw_calendar, events):
    want = {rid for rid, r in raw_calendar.shown.items() if r["has_recurrences"] and rid in raw_calendar.recurrences}
    got = {e["id"] for e in events if e["recurrence"]}
    assert got == want, f"recurring: missing {_sample(sorted(want - got))}, unexpected {_sample(sorted(got - want))}"
    words = [e["id"] for e in events if bool(e.get("repeats")) != bool(e["recurrence"])]
    assert not words, f"events whose 'repeats' words don't match their rule: {_sample(words)}"
    frequencies = Counter(e["recurrence"]["frequency"] for e in events if e["recurrence"])
    assert set(frequencies) <= {"daily", "weekly", "monthly", "yearly"}, frequencies


def _unfold(raw: bytes) -> list[str]:
    lines = []
    for line in raw.decode("utf-8").split("\r\n"):
        if line.startswith((" ", "\t")) and lines:
            lines[-1] += line[1:]
        elif line:
            lines.append(line)
    return lines


def test_ics_round_trip(ctx, raw_calendar, events, tmp_path):
    if not events:
        pytest.skip("no events")
    result = ctx.rpc("export_calendar", output_dir=str(tmp_path), format="ics")
    assert "error" not in result, result.get("error")
    files = [Path(f) for f in result["files"]]
    assert _files_under(Path(result["path"])) == sorted(files)
    listed = {c["id"]: c for c in ctx.calendars_result["calendars"]}
    assert result["calendars"] == sum(1 for c in listed.values() if c["event_count"]), result["calendars"]
    vevents, dated = 0, 0
    for path in files:
        raw = path.read_bytes()
        assert raw.endswith(b"\r\n") and b"\n" not in raw.replace(b"\r\n", b""), f"{path.name}: not CRLF"
        assert all(len(line) <= 75 for line in raw.split(b"\r\n")), f"{path.name}: a line over 75 octets"
        lines = _unfold(raw)
        begins = Counter(line[6:] for line in lines if line.startswith("BEGIN:"))
        ends = Counter(line[4:] for line in lines if line.startswith("END:"))
        assert begins == ends, f"{path.name}: BEGIN/END don't pair: {begins - ends} {ends - begins}"
        vevents += begins["VEVENT"]
        dated += sum(1 for line in lines if line.startswith("DTSTART;VALUE=DATE:"))
        assert not any(line.startswith(("ORGANIZER", "ATTENDEE")) for line in lines), path.name
        zones = {m.group(1) for line in lines for m in [re.match(r"[A-Z-]+;TZID=([^:;]+)", line)] if m}
        defined = {line[5:] for line in lines if line.startswith("TZID:")}
        assert zones <= defined, f"{path.name}: TZIDs without a VTIMEZONE: {sorted(zones - defined)}"
    with_start = [e for e in events if e["start_day"] or e["wall_start"] or e["start"]]
    assert vevents == result["count"] == len(with_start), \
        f"{vevents} VEVENTs, count {result['count']}, {len(with_start)} events listed with a start"
    assert dated == sum(1 for e in with_start if e["all_day"]), "all-day events not written as dates"
    again = ctx.rpc("export_calendar", output_dir=str(tmp_path), format="ics")
    assert Path(again["path"]).name.endswith(" (2)"), "a second save overwrote the first"


def test_csv_round_trip(ctx, events, tmp_path):
    if not events:
        pytest.skip("no events")
    result = ctx.rpc("export_calendar", output_dir=str(tmp_path), format="csv")
    assert "error" not in result, result.get("error")
    with open(result["path"], newline="", encoding="utf-8-sig") as f:
        rows = list(csv.reader(f))
    assert rows[0][:6] == ["Calendar", "Account", "Title", "Start", "End", "All Day"], "Calendar.csv header"
    assert len(rows) - 1 == result["count"] == len(events), f"{len(rows) - 1} rows, {len(events)} events listed"
    all_day_starts = Counter(r[3] for r in rows[1:] if r[5] == "Yes")
    assert all_day_starts == Counter(e["start_day"] for e in events if e["all_day"]), \
        "all-day events' days were moved in the CSV"
