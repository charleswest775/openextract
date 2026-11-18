"""
Tests that call history, web history and notes saves show dates in the
computer's local time zone, as messages, WhatsApp and podcast saves do. They
used to write the library's UTC value: a call made at 5:48 PM in California
read "2024-07-06T00:48:12+00:00", the wrong time and the wrong day.

Every test but the last class fixes the time zone on the extractor, so the
results don't depend on the computer running them.
"""

import csv
import os
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from browser_history import BrowserHistoryExtractor  # noqa: E402
from calls import CallExtractor  # noqa: E402
from notes import NoteExtractor  # noqa: E402

PDT = timezone(timedelta(hours=-7), "PDT")
IST = timezone(timedelta(hours=5, minutes=30), "IST")

# UTC dates as the library gives them. In California:
#   Fri Jul 5 9:10 AM, Fri Jul 5 5:48 PM (already Jul 6 in UTC),
#   Sat Jul 6 12:05 AM.
UTC_DATES = [
    "2024-07-05T16:10:09+00:00",
    "2024-07-06T00:48:12+00:00",
    "2024-07-06T07:05:00.250000+00:00",
]
CSV_PDT = [
    "2024-07-05T09:10:09-07:00",
    "2024-07-05T17:48:12-07:00",
    "2024-07-06T00:05:00.250000-07:00",
]


def _calls(dates):
    return [
        {"date": date, "contact_name": "Alice", "address": "+15555550100",
         "direction": "incoming", "status": "answered", "duration": 60, "app": "Phone"}
        for date in dates
    ]


def _visits(dates):
    return [
        {"visit_date": date, "browser": "safari", "url": "https://example.com/",
         "title": "Example", "domain": "example.com", "visit_count": 1}
        for date in dates
    ]


def _note(created, modified, note_id=1, title="Shopping"):
    return {"note_id": note_id, "title": title, "created": created,
            "modified": modified, "body": "Milk\nEggs"}


def _csv_rows(path):
    with open(path, newline="", encoding="utf-8") as f:
        return list(csv.reader(f))


def _read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


class _SaveTest(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.out = self._tmp.name


class TestCallHistoryCsv(_SaveTest):

    def _save(self, dates, tz=PDT):
        ext = CallExtractor.__new__(CallExtractor)
        ext.local_tz = tz
        with mock.patch.object(ext, "list_calls", return_value={"calls": _calls(dates)}):
            result = ext.export_calls_csv(None, {}, self.out)
        self.assertTrue(result["success"], result)
        rows = _csv_rows(result["path"])
        self.assertEqual(rows[0][0], "Date")
        return [row[0] for row in rows[1:]]

    def test_date_is_local_iso_with_offset(self):
        self.assertEqual(self._save(UTC_DATES), CSV_PDT)

    def test_date_is_the_same_moment_as_the_librarys(self):
        dates = self._save(UTC_DATES, tz=IST)
        self.assertEqual(dates[0], "2024-07-05T21:40:09+05:30")
        for written, utc in zip(dates, UTC_DATES):
            self.assertEqual(datetime.fromisoformat(written), datetime.fromisoformat(utc))

    def test_missing_or_unreadable_dates_do_not_fail(self):
        self.assertEqual(self._save([None, "sometime", UTC_DATES[1]]),
                         ["", "sometime", "2024-07-05T17:48:12-07:00"])


class TestWebHistoryCsv(_SaveTest):

    def _save(self, dates, tz=PDT):
        ext = BrowserHistoryExtractor.__new__(BrowserHistoryExtractor)
        ext.local_tz = tz
        with mock.patch.object(ext, "list_browser_history", return_value={"visits": _visits(dates)}):
            result = ext.export_browser_history_csv(None, self.out)
        self.assertTrue(result["success"], result)
        rows = _csv_rows(result["path"])
        self.assertEqual(rows[0][0], "Date")
        return [row[0] for row in rows[1:]]

    def test_date_is_local_iso_with_offset(self):
        self.assertEqual(self._save(UTC_DATES), CSV_PDT)

    def test_date_is_the_same_moment_as_the_librarys(self):
        dates = self._save(UTC_DATES, tz=IST)
        self.assertEqual(dates[1], "2024-07-06T06:18:12+05:30")
        for written, utc in zip(dates, UTC_DATES):
            self.assertEqual(datetime.fromisoformat(written), datetime.fromisoformat(utc))

    def test_missing_or_unreadable_dates_do_not_fail(self):
        self.assertEqual(self._save([None, "sometime", UTC_DATES[1]]),
                         ["", "sometime", "2024-07-05T17:48:12-07:00"])


class TestNotesSave(_SaveTest):

    def _ext(self, notes, tz=PDT):
        ext = NoteExtractor.__new__(NoteExtractor)
        ext.local_tz = tz
        patcher = mock.patch.object(ext, "list_notes", return_value={"notes": notes})
        patcher.start()
        self.addCleanup(patcher.stop)
        return ext

    def _txt_header(self, notes, tz=PDT, note_id=1):
        result = self._ext(notes, tz).export_notes(None, [note_id], "txt", self.out)
        self.assertEqual(result["status"], "ok", result)
        return _read(result["exported"][0]).splitlines()[:3]

    def test_txt_shows_local_date_and_time(self):
        # Created Friday morning, last edited Friday evening: Saturday in UTC.
        self.assertEqual(self._txt_header([_note(UTC_DATES[0], UTC_DATES[1])]), [
            "Title: Shopping",
            "Created: Jul 5, 2024, 9:10 AM",
            "Modified: Jul 5, 2024, 5:48 PM",
        ])

    def test_days_follow_the_time_zone(self):
        self.assertEqual(self._txt_header([_note(UTC_DATES[0], UTC_DATES[1])], tz=timezone.utc)[1:], [
            "Created: Jul 5, 2024, 4:10 PM",
            "Modified: Jul 6, 2024, 12:48 AM",
        ])

    def test_missing_or_unreadable_dates_do_not_fail(self):
        # The library gives None for a note without a date.
        self.assertEqual(self._txt_header([_note(None, "sometime")])[1:], [
            "Created: Unknown date",
            "Modified: sometime",
        ])

    def test_pdf_shows_local_date_and_time(self):
        try:
            from reportlab.pdfgen import canvas
        except ImportError:
            self.skipTest("reportlab isn't installed")
        drawn = []
        real_draw = canvas.Canvas.drawString

        def draw(c, x, y, text, *args, **kwargs):
            drawn.append(text)
            return real_draw(c, x, y, text, *args, **kwargs)

        ext = self._ext([_note(UTC_DATES[0], UTC_DATES[1])])
        with mock.patch.object(canvas.Canvas, "drawString", draw):
            result = ext.export_notes(None, [1], "pdf", self.out)
        self.assertEqual(result["status"], "ok", result)
        self.assertTrue(os.path.getsize(result["exported"][0]) > 0)
        self.assertEqual(drawn[1:3], ["Created: Jul 5, 2024, 9:10 AM", "Modified: Jul 5, 2024, 5:48 PM"])


@unittest.skipUnless(hasattr(time, "tzset"), "time.tzset is POSIX-only")
class TestComputersTimeZone(_SaveTest):

    def setUp(self):
        super().setUp()
        patcher = mock.patch.dict(os.environ, {"TZ": "America/Los_Angeles"})
        patcher.start()
        self.addCleanup(time.tzset)
        self.addCleanup(patcher.stop)
        time.tzset()

    def test_calls_use_the_computers_time_zone_by_default(self):
        ext = CallExtractor.__new__(CallExtractor)
        self.assertIsNone(ext.local_tz)
        with mock.patch.object(ext, "list_calls", return_value={"calls": _calls(UTC_DATES)}):
            result = ext.export_calls_csv(None, {}, self.out)
        self.assertEqual([row[0] for row in _csv_rows(result["path"])[1:]], CSV_PDT)

    def test_web_history_uses_the_computers_time_zone_by_default(self):
        ext = BrowserHistoryExtractor.__new__(BrowserHistoryExtractor)
        self.assertIsNone(ext.local_tz)
        with mock.patch.object(ext, "list_browser_history", return_value={"visits": _visits(UTC_DATES)}):
            result = ext.export_browser_history_csv(None, self.out)
        self.assertEqual([row[0] for row in _csv_rows(result["path"])[1:]], CSV_PDT)

    def test_notes_use_the_computers_time_zone_by_default(self):
        ext = NoteExtractor.__new__(NoteExtractor)
        self.assertIsNone(ext.local_tz)
        with mock.patch.object(ext, "list_notes", return_value={"notes": [_note(UTC_DATES[0], UTC_DATES[1])]}):
            result = ext.export_notes(None, [1], "txt", self.out)
        self.assertEqual(_read(result["exported"][0]).splitlines()[1:3], [
            "Created: Jul 5, 2024, 9:10 AM",
            "Modified: Jul 5, 2024, 5:48 PM",
        ])


if __name__ == "__main__":
    unittest.main()
