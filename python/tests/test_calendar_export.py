"""
Tests for the Calendar adapter's iCalendar and CSV export.

The core extractor is stubbed, so these run against any ios-backup-core version.
"""

import csv
import os
import sys
import tempfile
import unittest
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from calendar_events import (  # noqa: E402
    OUTDATED_CORE_MESSAGE,
    CalendarExtractor,
    build_ics,
    ics_fold,
)

STAMP = datetime(2026, 1, 1, tzinfo=timezone.utc)


def _event(event_id, title, start, end, all_day=False, calendar_id=1, **extra):
    ev = {
        "id": event_id, "title": title, "start": start, "end": end, "all_day": all_day,
        "floating": all_day, "timezone": None, "calendar_id": calendar_id, "calendar": None,
        "calendar_color": None, "account": None, "location": None, "address": None,
        "latitude": None, "longitude": None, "notes": "", "url": None, "conference_url": None,
        "organizer": None, "attendees": [], "recurring": False, "uid": None,
        "created": None, "modified": None,
    }
    ev.update(extra)
    return ev


def _unfold(ics: str) -> list:
    return ics.replace("\r\n ", "").split("\r\n")


class _StubCore:
    def __init__(self, events, calendars):
        self._result = {"events": events, "calendars": calendars, "errors": []}

    def list_events(self, backup, calendar_id=None):
        return self._result


class BuildIcsTests(unittest.TestCase):
    def test_timed_event_in_utc(self):
        ics = build_ics("Work", "#1BADF8", [_event(
            1, "Planning", "2024-03-10T15:00:00+00:00", "2024-03-10T16:00:00+00:00",
            uid="E1-UID")], STAMP)
        lines = _unfold(ics)
        self.assertIn("X-WR-CALNAME:Work", lines)
        self.assertIn("X-APPLE-CALENDAR-COLOR:#1BADF8", lines)
        self.assertIn("UID:E1-UID", lines)
        self.assertIn("DTSTART:20240310T150000Z", lines)
        self.assertIn("DTEND:20240310T160000Z", lines)
        self.assertIn("DTSTAMP:20260101T000000Z", lines)
        self.assertTrue(ics.endswith("END:VCALENDAR\r\n"))

    def test_floating_time_has_no_z(self):
        lines = _unfold(build_ics("Home", None, [_event(
            1, "Wake up", "2024-03-15T09:30:00", "2024-03-15T09:45:00")], STAMP))
        self.assertIn("DTSTART:20240315T093000", lines)

    def test_all_day_end_is_exclusive(self):
        lines = _unfold(build_ics("Home", None, [_event(
            1, "Conference", "2024-03-20", "2024-03-22", all_day=True)], STAMP))
        self.assertIn("DTSTART;VALUE=DATE:20240320", lines)
        self.assertIn("DTEND;VALUE=DATE:20240323", lines)

    def test_text_is_escaped_and_long_lines_fold(self):
        notes = "Bring: snacks, drinks; and\nthe projector — " + "é" * 60
        ics = build_ics("Home", None, [_event(
            1, "Party", "2024-01-01T20:00:00+00:00", None, notes=notes)], STAMP)
        for raw in ics.split("\r\n"):
            self.assertLessEqual(len(raw.encode("utf-8")), 75)
        description = next(line for line in _unfold(ics) if line.startswith("DESCRIPTION:"))
        self.assertEqual(
            description,
            "DESCRIPTION:Bring: snacks\\, drinks\\; and\\nthe projector — " + "é" * 60,
        )

    def test_fold_never_splits_a_character(self):
        folded = ics_fold("SUMMARY:" + "😀" * 40)
        for part in folded.split("\r\n"):
            part.encode("utf-8").decode("utf-8")  # raises if a character was cut
            self.assertLessEqual(len(part.encode("utf-8")), 75)

    def test_people_location_and_duplicate_uids(self):
        events = [
            _event(1, "Sync", "2024-01-01T10:00:00+00:00", None, uid="SERIES",
                   location="Office", address="1 Main St", latitude=40.7, longitude=-74.0,
                   organizer={"name": "Alex Chen", "email": "alex@example.com"},
                   attendees=[{"name": "Sam", "email": "sam@example.com"},
                              {"name": "No Email", "email": None}]),
            _event(2, "Sync (moved)", "2024-01-08T11:00:00+00:00", None, uid="SERIES"),
        ]
        lines = _unfold(build_ics("Work", None, events, STAMP))
        self.assertIn("LOCATION:Office\\, 1 Main St", lines)
        self.assertIn("GEO:40.7;-74.0", lines)
        self.assertIn('ORGANIZER;CN="Alex Chen":mailto:alex@example.com', lines)
        self.assertIn('ATTENDEE;CN="Sam":mailto:sam@example.com', lines)
        self.assertEqual(sum(1 for line in lines if line.startswith("ATTENDEE")), 1)
        self.assertIn("UID:SERIES", lines)
        self.assertIn("UID:SERIES-2", lines)


class ExportCalendarTests(unittest.TestCase):
    def setUp(self):
        self.out = tempfile.mkdtemp()
        self.ext = CalendarExtractor()

    def test_writes_one_ics_per_calendar_and_a_csv(self):
        self.ext._inner = _StubCore(
            [
                _event(1, "Planning", "2024-03-10T15:00:00+00:00", None, calendar_id=1,
                       calendar="Work", recurring=True),
                _event(2, "Holiday", "2024-03-12", "2024-03-12", all_day=True, calendar_id=2,
                       calendar="Home: Family"),
            ],
            [{"id": 1, "title": "Work", "color": None},
             {"id": 2, "title": "Home: Family", "color": "#FF0000"}],
        )
        result = self.ext.export_calendar(object(), self.out)
        self.assertTrue(result["success"])
        self.assertEqual(result["count"], 2)
        self.assertEqual(result["recurring"], 1)
        self.assertEqual(sorted(result["files"]), ["Home_ Family.ics", "Work.ics"])
        with open(os.path.join(self.out, "events.csv"), encoding="utf-8") as f:
            rows = list(csv.reader(f))
        self.assertEqual(rows[0][:4], ["Start", "End", "All Day", "Title"])
        self.assertEqual([r[3] for r in rows[1:]], ["Planning", "Holiday"])

    def test_nothing_to_export(self):
        self.ext._inner = _StubCore([], [])
        result = self.ext.export_calendar(object(), self.out)
        self.assertFalse(result["success"])

    def test_outdated_core(self):
        self.ext._inner = None
        self.assertEqual(self.ext.list_events(object())["errors"][0]["message"],
                         OUTDATED_CORE_MESSAGE)
        self.assertFalse(self.ext.export_calendar(object(), self.out)["success"])


if __name__ == "__main__":
    unittest.main()
