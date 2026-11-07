"""
Tests that Messages exports show times in the computer's local time zone, in
words people read, instead of the engine's UTC ISO strings. A message sent at
5:48 PM in California used to read "2024-07-06T00:48:12+00:00": the wrong
time, and the wrong day.

Every test but the last fixes the time zone on the extractor, so the results
don't depend on the computer running them.
"""

import csv
import os
import re
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from messages import MessageExtractor  # noqa: E402

PDT = timezone(timedelta(hours=-7), "PDT")
IST = timezone(timedelta(hours=5, minutes=30), "IST")

# (message_id, UTC date from the engine, sender, text). In California:
#   Fri Jul 5 9:10 AM, Fri Jul 5 5:48 PM (already Jul 6 in UTC),
#   Sat Jul 6 12:05 AM, Sat Jul 6 12:30 PM.
_MESSAGES = [
    (1, "2024-07-05T16:10:09+00:00", "Alice", "Morning"),
    (2, "2024-07-06T00:48:12+00:00", "me", "Leaving now"),
    (3, "2024-07-06T07:05:00.250000+00:00", "Alice", "Still up?"),
    (4, "2024-07-06T19:30:00+00:00", "me", "Lunch"),
]

TXT_PDT = [
    "[Jul 5, 2024, 9:10 AM] Alice: Morning",
    "[Jul 5, 2024, 5:48 PM] me: Leaving now",
    "[Jul 6, 2024, 12:05 AM] Alice: Still up?",
    "[Jul 6, 2024, 12:30 PM] me: Lunch",
]
CSV_PDT = [
    "2024-07-05T09:10:09-07:00",
    "2024-07-05T17:48:12-07:00",
    "2024-07-06T00:05:00.250000-07:00",
    "2024-07-06T12:30:00-07:00",
]
# The day headings and times an HTML page shows, in order.
HTML_PDT = [
    ("day", "Jul 5, 2024"), ("meta", "9:10 AM"), ("meta", "5:48 PM"),
    ("day", "Jul 6, 2024"), ("meta", "12:05 AM"), ("meta", "12:30 PM"),
]


def _messages(conversation=None):
    out = []
    for message_id, date, sender, text in _MESSAGES:
        msg = {
            "message_id": message_id,
            "date": date,
            "text": text,
            "sender": sender,
            "is_from_me": sender == "me",
            "has_attachments": False,
            "attachments": [],
        }
        if conversation is not None:
            msg["_conversation"] = conversation
        out.append(msg)
    return out


def _read(path, encoding="utf-8"):
    with open(path, encoding=encoding) as f:
        return f.read()


def _txt_lines(path):
    return _read(path, "utf-8-sig").splitlines()


def _csv_rows(path):
    with open(path, newline="", encoding="utf-8-sig") as f:
        return list(csv.reader(f))


def _html_times(path):
    """[("day", "Jul 5, 2024"), ("meta", "9:10 AM"), ...] from an HTML export,
    leaving out a merged export's "(from Mom)" label."""
    found = re.findall(r'<div class="(day|meta)">(.*?)(?: <span class="conv-label">.*?</span>)?</div>',
                       _read(path))
    return [(kind, text) for kind, text in found]


class _ExportTest(unittest.TestCase):

    def setUp(self):
        self.ext = MessageExtractor.__new__(MessageExtractor)
        self.ext.local_tz = PDT
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.out = self._tmp.name


class TestSingleConversationExport(_ExportTest):

    def test_txt_shows_local_date_and_time_on_each_line(self):
        result = self.ext._export_txt(_messages(), 1, self.out, "Alice")
        self.assertEqual(_txt_lines(result["file"]), TXT_PDT)

    def test_csv_date_is_local_iso_with_offset(self):
        result = self.ext._export_csv(_messages(), 1, self.out, "Alice")
        rows = _csv_rows(result["file"])
        self.assertEqual(rows[0], ["Date", "Sender", "Text", "Is From Me", "Has Attachments"])
        self.assertEqual([row[0] for row in rows[1:]], CSV_PDT)

    def test_csv_date_is_the_same_moment_as_the_engines(self):
        self.ext.local_tz = IST
        result = self.ext._export_csv(_messages(), 1, self.out, "Alice")
        dates = [row[0] for row in _csv_rows(result["file"])[1:]]
        self.assertEqual(dates[0], "2024-07-05T21:40:09+05:30")
        for written, (_, engine, _, _) in zip(dates, _MESSAGES):
            self.assertEqual(datetime.fromisoformat(written), datetime.fromisoformat(engine))

    def test_html_has_a_heading_per_local_day_and_a_time_per_message(self):
        result = self.ext._export_html(_messages(), 1, self.out, "Alice")
        self.assertEqual(_html_times(result["file"]), HTML_PDT)
        self.assertNotIn("+00:00", _read(result["file"]))

    def test_pdf_source_has_a_heading_per_local_day_and_a_time_per_message(self):
        with mock.patch.object(self.ext, "_collect_messages_for_chat", return_value=_messages()):
            result = self.ext.export_conversation(None, 1, {}, "pdf_source", self.out, display_name="Alice")
        self.assertEqual(_html_times(result["file"]), HTML_PDT)

    def test_days_follow_the_time_zone(self):
        # In UTC the 5:48 PM message is 12:48 AM the next day.
        self.ext.local_tz = timezone.utc
        result = self.ext._export_html(_messages(), 1, self.out, "Alice")
        self.assertEqual(_html_times(result["file"]), [
            ("day", "Jul 5, 2024"), ("meta", "4:10 PM"),
            ("day", "Jul 6, 2024"), ("meta", "12:48 AM"), ("meta", "7:05 AM"), ("meta", "7:30 PM"),
        ])

    def test_file_name_uses_the_same_time_zone(self):
        name = self.ext._get_filename_for_message_export("Alice", _messages())
        # The last message is Jul 6 in UTC too, but the first is Jul 5 only locally.
        self.assertEqual(name, "Alice, Jul 5 2024 - Jul 6 2024")
        self.ext.local_tz = IST
        self.assertEqual(self.ext._get_filename_for_message_export("Alice", _messages()),
                         "Alice, Jul 5 2024 - Jul 7 2024")

    def test_missing_or_unreadable_dates_do_not_fail(self):
        messages = _messages()[:1]
        messages[0]["date"] = None
        messages.append({**_messages()[1], "date": "sometime"})
        messages.append(_messages()[2])

        txt = self.ext._export_txt(messages, 1, self.out, None)
        self.assertEqual(_txt_lines(txt["file"]), [
            "[Unknown date] Alice: Morning",
            "[sometime] me: Leaving now",
            "[Jul 6, 2024, 12:05 AM] Alice: Still up?",
        ])
        csv_result = self.ext._export_csv(messages, 1, self.out, None)
        self.assertEqual([row[0] for row in _csv_rows(csv_result["file"])[1:]],
                         ["", "sometime", "2024-07-06T00:05:00.250000-07:00"])
        html_result = self.ext._export_html(messages, 1, self.out, None)
        self.assertEqual(_html_times(html_result["file"]), [
            ("meta", ""), ("meta", "sometime"), ("day", "Jul 6, 2024"), ("meta", "12:05 AM"),
        ])


class TestMergedExport(_ExportTest):

    def _export(self, fmt):
        # Alice's messages in one conversation, mine in another; the merged
        # export puts them back in time order.
        def collect(backup, chat_id, *args):
            return [m for m in _messages() if m["is_from_me"] == (chat_id == 2)]

        with mock.patch.object(self.ext, "_collect_messages_for_chat", side_effect=collect):
            result = self.ext.export_conversations(
                None, [1, 2], {1: "Mom", 2: "Dad"}, {}, fmt, self.out, mode="merged",
            )
        return result["files"][0]

    def test_merged_txt(self):
        self.assertEqual(_txt_lines(self._export("txt")), [
            "[Jul 5, 2024, 9:10 AM] (from Mom) Alice: Morning",
            "[Jul 5, 2024, 5:48 PM] (to Dad) me: Leaving now",
            "[Jul 6, 2024, 12:05 AM] (from Mom) Alice: Still up?",
            "[Jul 6, 2024, 12:30 PM] (to Dad) me: Lunch",
        ])

    def test_merged_csv(self):
        rows = _csv_rows(self._export("csv"))
        self.assertEqual(rows[0][0], "Date")
        self.assertEqual([row[0] for row in rows[1:]], CSV_PDT)
        self.assertEqual([row[1] for row in rows[1:]], ["Mom", "Dad", "Mom", "Dad"])

    def test_merged_html_and_pdf_source(self):
        for fmt in ("html", "pdf_source"):
            with self.subTest(fmt=fmt):
                path = self._export(fmt)
                self.assertEqual(_html_times(path), HTML_PDT)
                self.assertIn('<div class="meta">5:48 PM <span class="conv-label">(to Dad)</span></div>',
                              _read(path))


@unittest.skipUnless(hasattr(time, "tzset"), "time.tzset is POSIX-only")
class TestComputersTimeZone(unittest.TestCase):

    def test_exports_use_the_computers_time_zone_by_default(self):
        patcher = mock.patch.dict(os.environ, {"TZ": "America/Los_Angeles"})
        patcher.start()
        self.addCleanup(time.tzset)
        self.addCleanup(patcher.stop)
        time.tzset()

        ext = MessageExtractor.__new__(MessageExtractor)
        self.assertIsNone(ext.local_tz)
        with tempfile.TemporaryDirectory() as out:
            result = ext._export_txt(_messages(), 1, out, "Alice")
            self.assertEqual(_txt_lines(result["file"]), TXT_PDT)


if __name__ == "__main__":
    unittest.main()
