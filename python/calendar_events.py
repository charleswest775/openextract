"""
Calendar adapter.

Delegates reading to ``ios_backup_core.extractors.calendar_events``: the
calendars in Calendar.sqlitedb (with their accounts and kinds: the person's
own, holidays, birthdays, Found in Mail, subscriptions) and their events, a
repeating event as one series with its rule. Keeps what is openextract's own:

  * ``repeats``: each repeating event's rule in English ("Every week on
    Tuesday, until Jun 30, 2026"), for the screen and the spreadsheet;
  * the saves:
      - ``ics``: calendar files (iCalendar, RFC 5545) that Calendar, Outlook
        and Google import: one per calendar that has events, in a folder
        named after the iPhone, or one file for one calendar. Written by the
        library's ``events_to_ics``: series stay series, all-day events stay
        dates and floating times stay floating;
      - ``csv``: one spreadsheet row per event (a series is one row), times
        in local time.

This module is named calendar_events, not calendar: the engine's folder is
first on the import path, and a calendar.py there would hide the standard
library's calendar module, which email.utils needs.

Dates come in three kinds that never share a field (see the library):
zoned timed events are instants (``start``/``end`` in UTC), floating ones are
wall-clock times (``wall_start``/``wall_end``) and all-day ones are days
(``start_day``/``end_day``, the last day included). Only instants go through
local-time conversion here; a day or a wall-clock time is written as it is,
so July 4 stays July 4 in California.

A save never overwrites a file: a second one is "Home (2).ics". When there is
nothing to save, nothing is written and the answer is an error with an
``empty_reason``, which the app shows as a calm notice.
"""

import csv
import os
import re
import sys
from datetime import date, datetime, timezone
from zoneinfo import ZoneInfo

from app_copies import title_stem
from local_dates import MONTHS, csv_date, readable_date
from podcasts import _csv_cell, _device_name, _unused_name

try:
    from ios_backup_core.extractors.calendar_events import (
        CalendarExtractor as _CoreCalendarExtractor,
        events_to_ics,
        recurrence_rrule,
    )
except ImportError:
    # An ios-backup-core from before Calendar support. The engine must still
    # start and every other section still work, so Calendar answers as if it
    # weren't in the backup (see _NoCalendarSupport).
    _CoreCalendarExtractor = None
    events_to_ics = None
    recurrence_rrule = None

__all__ = ["CalendarExtractor", "NOTHING_TO_SAVE", "repeats_text"]

# What the app is told, in words for people.
NOTHING_TO_SAVE = "There are no calendar events in this backup to save."
NOTHING_IN_CALENDAR = "There are no events in this calendar to save."
NO_SUCH_CALENDAR = "That calendar isn't in this backup."

FORMATS = ("ics", "csv")
DEFAULT_NAME = "Calendar"

CSV_HEADER = ["Calendar", "Account", "Title", "Start", "End", "All Day", "Time Zone", "Location", "Address",
              "Latitude", "Longitude", "Notes", "URL", "Repeats", "RRULE", "Status", "Availability", "Organizer",
              "Invitees", "Alerts", "Created", "Modified"]

_STATUS_WORDS = {"confirmed": "Confirmed", "tentative": "Tentative", "cancelled": "Cancelled"}
_AVAILABILITY_WORDS = {"busy": "Busy", "free": "Free", "tentative": "Tentative", "unavailable": "Unavailable"}

_DIGITS = re.compile(r"[0-9]+")
_MAX_ID = 2**63 - 1  # the largest row id SQLite has

# Said once per engine, however many extractors are made.
_told_no_support = False


class _NoCalendarSupport:
    """Stands in for the library's extractor when ios-backup-core has none."""

    def __init__(self):
        global _told_no_support
        if not _told_no_support:
            _told_no_support = True
            print("[calendar] this ios-backup-core has no Calendar extractor; Calendar shows as not in the backup",
                  file=sys.stderr, flush=True)

    def list_calendars(self, backup):
        return {"calendars": [], "empty_reason": "not_in_backup"}

    def list_events(self, backup, calendar_id=None, include_hidden=False, contacts=None):
        return {"events": [], "empty_reason": "not_in_backup"}


def _problem(result: dict) -> dict:
    """The error to return for a list that couldn't be read, with its empty_reason (an older
    layout's "unsupported_format") when it has one."""
    problem = {"error": result["error"]}
    if result.get("empty_reason"):
        problem["empty_reason"] = result["empty_reason"]
    return problem


def calendar_id_of(value):
    """A calendar id as an int, or None when it isn't one: an int or a string of digits, never a bool, from 0
    to the largest row id."""
    if isinstance(value, bool):
        return None
    if isinstance(value, int):
        number = value
    elif isinstance(value, str) and _DIGITS.fullmatch(value.strip()):
        try:
            number = int(value.strip())
        except ValueError:  # more digits than Python makes a number of (4300): no calendar's id
            return None
    else:
        return None
    return number if 0 <= number <= _MAX_ID else None


# ── The repeat rule in words ─────────────────────────────────────────────────

_DAY_NAMES = {"MO": "Monday", "TU": "Tuesday", "WE": "Wednesday", "TH": "Thursday", "FR": "Friday",
              "SA": "Saturday", "SU": "Sunday"}
_WEEK_ORDER = ("MO", "TU", "WE", "TH", "FR", "SA", "SU")
_MONTH_NAMES = ("January", "February", "March", "April", "May", "June", "July", "August", "September",
                "October", "November", "December")
_ORDINAL_WORDS = {1: "first", 2: "second", 3: "third", 4: "fourth", 5: "fifth", -1: "last", -2: "second to last"}
_UNITS = {"daily": ("day", "days"), "weekly": ("week", "weeks"), "monthly": ("month", "months"),
          "yearly": ("year", "years")}
_BYDAY = re.compile(r"([+-]?\d{1,2})?(MO|TU|WE|TH|FR|SA|SU)")


def _and(items: list) -> str:
    """"A", "A and B", "A, B and C"."""
    items = [str(i) for i in items]
    if len(items) <= 1:
        return "".join(items)
    return ", ".join(items[:-1]) + " and " + items[-1]


def _ordinal(n: int) -> str:
    """"first", "third", "last"; past fifth, "6th"."""
    if n in _ORDINAL_WORDS:
        return _ORDINAL_WORDS[n]
    return _nth(n) if n > 0 else f"{_nth(-n)} to last"


def _nth(n: int) -> str:
    """"1st", "2nd", "11th", "23rd"."""
    suffix = "th" if 10 <= n % 100 <= 20 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def _month_day_words(day: int) -> str:
    if day == -1:
        return "last day"
    if day < 0:
        return f"{_nth(-day)} to last day"
    return _nth(day)


def _zone(name):
    if not name or name == "_float":
        return None
    try:
        return ZoneInfo(name)
    except Exception:  # noqa: BLE001  an unknown or odd zone name
        return None


def _parse(value):
    """"YYYY-MM-DD" → date, an ISO time → datetime (naive or aware); else None."""
    if not isinstance(value, str) or not value.strip():
        return None
    text = value.strip()
    try:
        if len(text) == 10:
            return date.fromisoformat(text)
        return datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        return None


def _day_of(value, event: dict, tz=None):
    """The calendar day of one of an event's dates: a day as it is, a wall-clock time's own day,
    an instant's day in the event's zone (else ``tz``; None is this computer's)."""
    parsed = _parse(value)
    if parsed is None:
        return None
    if isinstance(parsed, datetime):
        if parsed.tzinfo is not None:
            zone = _zone(event.get("time_zone")) if not event.get("all_day") else None
            parsed = parsed.astimezone(zone or tz)
        return parsed.date()
    return parsed


def _start_day(event: dict, tz=None):
    if event.get("all_day"):
        return _day_of(event.get("start_day"), event, tz)
    if event.get("floating"):
        return _day_of(event.get("wall_start"), event, tz)
    return _day_of(event.get("start"), event, tz)


def repeats_text(event: dict, tz=None):
    """How a repeating event repeats, in English, or None when it doesn't repeat.

    "Every year on the third Sunday of June", "Every week on Tuesday, until
    Jun 30, 2026", "Every 2 weeks on Monday and Wednesday, 10 times", "Every
    day". A rule with no day given repeats on its start's day, which is said
    ("Every year on July 4"). Rules with parts this doesn't put into words
    (set positions, year days, week numbers, or days and months a rule's
    frequency isn't said with, like weekdays in a daily rule or a month day
    beside a weekday) say "on a custom schedule".
    ``tz`` is the zone an instant's day is told in when the event's own zone
    is unknown; None is this computer's.
    """
    rule = event.get("recurrence") if isinstance(event, dict) else None
    if not isinstance(rule, dict):
        return None
    unit = _UNITS.get(rule.get("frequency"))
    if unit is None:
        return "Repeats"
    interval = rule.get("interval")
    interval = interval if isinstance(interval, int) and not isinstance(interval, bool) and interval > 1 else 1
    text = f"Every {unit[0]}" if interval == 1 else f"Every {interval} {unit[1]}"

    days = []
    for token in rule.get("by_day") or []:
        match = _BYDAY.fullmatch(str(token).upper())
        if match:
            days.append((int(match.group(1)) if match.group(1) else 0, match.group(2)))
    month_days = [d for d in rule.get("by_month_day") or [] if isinstance(d, int) and d]
    months = [m for m in rule.get("by_month") or [] if isinstance(m, int) and 1 <= m <= 12]
    frequency = rule.get("frequency")
    # A part the words below would leave out makes the schedule custom too: "Every day" for a
    # daily rule on weekdays only, or "on every Friday" for Friday the 13th, wouldn't be true.
    custom = any(rule.get(k) for k in ("by_set_pos", "by_year_day", "by_week_no")) or bool(
        (frequency == "daily" and (days or month_days or months))
        or (frequency == "weekly" and (month_days or months))
        or (frequency == "monthly" and (months or (days and month_days)))
        or (frequency == "yearly" and days and month_days))
    start = _start_day(event, tz)

    def day_words(pairs):
        return _and([f"the {_ordinal(n)} {_DAY_NAMES[d]}" if n else f"every {_DAY_NAMES[d]}" for n, d in pairs])

    if custom:
        text += " on a custom schedule"
    elif frequency == "weekly":
        codes = sorted({d for _, d in days}, key=_WEEK_ORDER.index)
        if not codes and start is not None:
            codes = [_WEEK_ORDER[start.weekday()]]
        if set(codes) == set(_WEEK_ORDER[:5]):
            text += " on weekdays"
        elif set(codes) == {"SA", "SU"}:
            text += " on weekends"
        elif codes:
            text += " on " + _and([_DAY_NAMES[c] for c in codes])
    elif frequency == "monthly":
        if days:
            text += " on " + day_words(days)
        elif month_days:
            text += " on the " + _and([_month_day_words(d) for d in month_days])
        elif start is not None:
            text += f" on the {_nth(start.day)}"
    elif frequency == "yearly":
        month_names = [_MONTH_NAMES[m - 1] for m in months]
        if days:
            text += " on " + day_words(days) + (" of " + _and(month_names) if month_names else "")
        elif month_days and len(months) == 1:
            text += " on " + _and([f"{month_names[0]} {d}" if d > 0 else f"the {_month_day_words(d)} of "
                                   f"{month_names[0]}" for d in month_days])
        elif month_days:
            text += " on the " + _and([_month_day_words(d) for d in month_days]) + (
                " of " + _and(month_names) if month_names else "")
        elif month_names:
            day = f" {start.day}" if start is not None and len(month_names) == 1 and start.month == months[0] else ""
            text += (f" on {month_names[0]}{day}" if day else " in " + _and(month_names))
        elif start is not None:
            text += f" on {_MONTH_NAMES[start.month - 1]} {start.day}"

    count = rule.get("count")
    if isinstance(count, int) and not isinstance(count, bool) and count > 0:
        text += ", once" if count == 1 else f", {count} times"
    else:
        until = _day_of(rule.get("until"), event, tz)
        if until is not None:
            text += f", until {MONTHS[until.month - 1]} {until.day}, {until.year}"
    return text


def _start_kind(event: dict) -> str:
    if event.get("all_day"):
        return "all_day"
    return "floating" if event.get("floating") else "zoned"


def _person(person) -> str:
    if not isinstance(person, dict):
        return ""
    name, email = person.get("name"), person.get("email")
    if name and email:
        return f"{name} <{email}>"
    return name or email or person.get("phone") or ""


def _clock(seconds: int) -> str:
    """"9:00 AM" for seconds after midnight."""
    hours, rest = divmod(seconds, 3600)
    return f"{hours % 12 or 12}:{rest // 60:02d} {'AM' if hours < 12 else 'PM'}"


def _alert_words(alarm, all_day: bool = False) -> str:
    """"15 minutes before", "1 day before", "At time of event"; for an all-day event, which
    starts at midnight, a time of day: "On the day at 9:00 AM", "1 day before at 9:00 AM"."""
    if not isinstance(alarm, dict):
        return ""
    seconds = alarm.get("seconds_before")
    if isinstance(seconds, (int, float)) and not isinstance(seconds, bool):
        seconds = int(seconds)
        if all_day:
            after = -seconds  # seconds after the day's midnight
            days, clock = divmod(after, 86400)
            when = _clock(clock)
            if days == 0:
                return f"On the day at {when}"
            if days < 0:
                return f"{-days} day{'s' if days < -1 else ''} before at {when}"
            return f"{days} day{'s' if days > 1 else ''} after at {when}"
        if seconds == 0:
            return "At time of event"
        span = abs(seconds)
        for size, one, many in ((604800, "week", "weeks"), (86400, "day", "days"), (3600, "hour", "hours"),
                                (60, "minute", "minutes"), (1, "second", "seconds")):
            if span % size == 0:
                n = span // size
                return f"{n} {one if n == 1 else many} {'before' if seconds > 0 else 'after'}"
    return ""


class CalendarExtractor:
    """Adapter wrapping the ios-backup-core CalendarExtractor."""

    # The time zone saves show instants in; None is this computer's, as the app
    # and the other saves use (local_dates.py). Tests set a fixed one.
    local_tz = None

    def __init__(self):
        self._inner = _CoreCalendarExtractor() if _CoreCalendarExtractor is not None else _NoCalendarSupport()

    # ── Reading ──────────────────────────────────────────────────────────────

    def list_calendars(self, backup) -> dict:
        """Every calendar with its account, kind and event count (the library's answer, unchanged)."""
        return self._inner.list_calendars(backup)

    def list_events(self, backup, calendar_id=None, include_hidden: bool = False, contacts=None) -> dict:
        """Events by start, a series as one row; one calendar's with ``calendar_id``.

        The library's answer, plus ``repeats`` on every event: the rule in
        words, or None for an event that doesn't repeat. ``contacts`` names
        invitees who have no name of their own.
        """
        result = self._inner.list_events(backup, calendar_id=calendar_id, include_hidden=include_hidden,
                                         contacts=contacts)
        for event in result.get("events") or []:
            if isinstance(event, dict):
                event["repeats"] = repeats_text(event, self.local_tz)
        return result

    # ── Saving ───────────────────────────────────────────────────────────────

    def export_calendar(self, backup, output_dir: str, fmt: str = "ics", calendar_id=None, contacts=None,
                        now=None) -> dict:
        """Save the calendars as .ics files or a CSV into ``output_dir``.

        Every calendar: ics writes a folder ("<iPhone> Calendar") with one
        file per calendar that has events; csv one "Calendar.csv". With
        ``calendar_id``, that calendar alone: "<title>.ics" or
        "<title>.csv". Returns ``{"status": "success", "count", "calendars",
        "path", "files"}``: count is the events written. Nothing to save is
        an error with ``empty_reason`` and writes nothing; a calendar that
        can't be read passes its error through.
        """
        if fmt not in FORMATS:
            return {"error": f"Unsupported format: {fmt}"}
        listed = self.list_calendars(backup)
        if listed.get("error"):
            return _problem(listed)
        calendars = listed.get("calendars") or []
        if not calendars:
            return {"error": NOTHING_TO_SAVE, "empty_reason": listed.get("empty_reason") or "no_records"}
        one = None
        if calendar_id is not None:
            wanted = calendar_id_of(calendar_id)
            one = next((c for c in calendars if wanted is not None and c.get("id") == wanted), None)
            if one is None:
                return {"error": NO_SUCH_CALENDAR}
        events_result = self.list_events(backup, calendar_id=one["id"] if one else None, contacts=contacts)
        if events_result.get("error"):
            return _problem(events_result)
        events = events_result.get("events") or []
        if not events:
            if one is not None:
                return {"error": NOTHING_IN_CALENDAR, "empty_reason": "no_records"}
            return {"error": NOTHING_TO_SAVE, "empty_reason": events_result.get("empty_reason") or "no_records"}
        try:
            if fmt == "csv":
                return self._write_csv(calendars, events, output_dir, one)
            if one is not None:
                return self._write_one_ics(one, events, output_dir, now)
            return self._write_ics_folder(backup, calendars, events, output_dir, now)
        except OSError as e:
            return {"error": f"The calendar couldn't be saved there: {e.strerror or e}"}

    @staticmethod
    def _ics(events, calendar, now) -> tuple:
        """(the file's text, how many events it holds)."""
        text = events_to_ics(events, [calendar], now=now or datetime.now(timezone.utc))
        return text, text.count("\r\nBEGIN:VEVENT\r\n")

    @staticmethod
    def _write_text(path, text) -> None:
        # newline="": the text already has the CRLF line ends RFC 5545 asks for.
        with open(path, "x", encoding="utf-8", errors="replace", newline="") as f:
            f.write(text)

    def _write_one_ics(self, calendar, events, output_dir, now) -> dict:
        text, count = self._ics(events, calendar, now)
        os.makedirs(output_dir, exist_ok=True)
        stem = title_stem(calendar.get("title") or "", DEFAULT_NAME)
        path = os.path.join(output_dir, _unused_name(output_dir, stem, ".ics"))
        self._write_text(path, text)
        return {"status": "success", "count": count, "calendars": 1, "path": path, "files": [path]}

    def _write_ics_folder(self, backup, calendars, events, output_dir, now) -> dict:
        by_calendar: dict = {}
        for event in events:
            by_calendar.setdefault(event.get("calendar_id"), []).append(event)
        # Build every file's text first, so a failure leaves no half-written folder.
        texts = []
        for calendar in calendars:
            own = by_calendar.get(calendar.get("id"))
            if not own:
                continue
            text, count = self._ics(own, calendar, now)
            if count:
                texts.append((calendar, text, count))
        if not texts:
            return {"error": NOTHING_TO_SAVE, "empty_reason": "no_records"}
        device = _device_name(backup)
        folder_stem = title_stem(f"{device} {DEFAULT_NAME}" if device else DEFAULT_NAME, DEFAULT_NAME)
        os.makedirs(output_dir, exist_ok=True)
        folder = os.path.join(output_dir, _unused_name(output_dir, folder_stem, ""))
        os.mkdir(folder)
        files, total = [], 0
        for calendar, text, count in texts:
            stem = title_stem(calendar.get("title") or "", DEFAULT_NAME)
            path = os.path.join(folder, _unused_name(folder, stem, ".ics"))
            self._write_text(path, text)
            files.append(path)
            total += count
        return {"status": "success", "count": total, "calendars": len(files), "path": folder, "files": files}

    def _write_csv(self, calendars, events, output_dir, one) -> dict:
        by_id = {c.get("id"): c for c in calendars}
        rows = [self._row(e, by_id.get(e.get("calendar_id")) or {}) for e in events]
        os.makedirs(output_dir, exist_ok=True)
        stem = title_stem(one.get("title") or "", DEFAULT_NAME) if one else DEFAULT_NAME
        path = os.path.join(output_dir, _unused_name(output_dir, stem, ".csv"))
        # utf-8-sig: Excel reads the file as UTF-8 only with the BOM in front.
        with open(path, "x", newline="", encoding="utf-8-sig", errors="replace") as f:
            writer = csv.writer(f)
            writer.writerow(CSV_HEADER)
            for row in rows:
                writer.writerow([_csv_cell(cell) for cell in row])
        return {"status": "success", "count": len(rows), "calendars": len({e.get("calendar_id") for e in events}),
                "path": path, "files": [path]}

    def _when(self, event: dict) -> tuple:
        """(Start, End) cells: an all-day event's days and a floating event's wall-clock times as
        they are; only a zoned event's instants are moved to local time. A birthday whose year
        isn't known is its month and day."""
        kind = _start_kind(event)
        if event.get("year_unknown"):
            # A birthday whose year isn't known, which Apple keeps in the year 1604: the day alone, as
            # the screen shows it ("March 2"), never a year it wasn't. The .ics keeps 1604, Apple's way.
            fields = {"all_day": ("start_day", "end_day"), "floating": ("wall_start", "wall_end"),
                      "zoned": ("start", "end")}[kind]
            days = [_day_of(event.get(f), event, self.local_tz) for f in fields]
            return tuple(f"{_MONTH_NAMES[d.month - 1]} {d.day}" if d else "" for d in days)
        if kind == "all_day":
            return event.get("start_day") or "", event.get("end_day") or ""
        if kind == "floating":
            return event.get("wall_start") or "", event.get("wall_end") or ""
        return self._csv_date(event.get("start")), self._csv_date(event.get("end"))

    def _row(self, event: dict, calendar: dict) -> list:
        start, end = self._when(event)
        location = event.get("location") if isinstance(event.get("location"), dict) else {}
        account = calendar.get("account") if isinstance(calendar.get("account"), dict) else {}
        recurrence = event.get("recurrence")
        rule = recurrence_rrule(recurrence, _start_kind(event)) if recurrence and recurrence_rrule else ""
        invitees = []
        for attendee in event.get("attendees") or []:
            label = _person(attendee)
            if not label:
                continue
            status = attendee.get("status")
            if status and status != "unknown":
                label += f" ({str(status).replace('_', ' ')})"
            invitees.append(label)
        alerts = []
        for alarm in event.get("alarms") or []:
            words = _alert_words(alarm, bool(event.get("all_day")))
            if not words and isinstance(alarm, dict) and alarm.get("at"):
                words = f"At {readable_date(alarm['at'], self.local_tz)}"
            if words:
                alerts.append(words)
        if event.get("floating") and not event.get("all_day"):
            zone = "Floating"
        else:
            zone = event.get("time_zone") or ""
        return [
            calendar.get("title") or "",
            account.get("name") or "",
            event.get("title") or "",
            start,
            end,
            "Yes" if event.get("all_day") else "No",
            zone,
            location.get("title") or "",
            location.get("address") or "",
            "" if location.get("latitude") is None else location.get("latitude"),
            "" if location.get("longitude") is None else location.get("longitude"),
            event.get("notes") or "",
            event.get("url") or event.get("conference_url") or "",
            event.get("repeats") if event.get("repeats") is not None else (repeats_text(event, self.local_tz) or ""),
            rule,
            _STATUS_WORDS.get(event.get("status"), ""),
            _AVAILABILITY_WORDS.get(event.get("availability"), ""),
            _person(event.get("organizer")),
            "; ".join(invitees),
            "; ".join(alerts),
            self._csv_date(event.get("created_date")),
            self._csv_date(event.get("modified_date")),
        ]

    def _csv_date(self, iso) -> str:
        """An instant as ISO 8601 in local time with its offset (local_dates.py). Never for a day
        or a wall-clock time: those have no zone to move from."""
        return csv_date(iso, self.local_tz)
