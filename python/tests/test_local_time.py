"""
Tests that the Overview dashboard shows times in the computer's local time
zone, not UTC. Messages sent on a Friday evening in California fall on
Saturday morning in UTC, so UTC bucketing gave "Busiest day Saturday" and
"Peak hour 2 AM" for someone who mostly texts at 7 PM.
"""

import os
import plistlib
import sqlite3
import sys
import tempfile
import time
import unittest
from datetime import date, datetime, timezone
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from backup import BackupManager  # noqa: E402
from stats import StatsComputer  # noqa: E402

_APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)

# Friday 2026-06-26, 7 PM PDT (UTC-7) is Saturday 2026-06-27, 2 AM UTC.
_FRIDAY_EVENING_PDT = [
    datetime(2026, 6, 27, 2, 5, tzinfo=timezone.utc),
    datetime(2026, 6, 27, 2, 20, tzinfo=timezone.utc),
    datetime(2026, 6, 27, 2, 45, tzinfo=timezone.utc),
]
# Wednesday 2026-06-24, noon PDT.
_WEDNESDAY_NOON_PDT = datetime(2026, 6, 24, 19, 0, tzinfo=timezone.utc)


def _use_time_zone(test: unittest.TestCase, tz: str) -> None:
    """Set this process's local time zone for the rest of the test."""
    patcher = mock.patch.dict(os.environ, {"TZ": tz})
    patcher.start()
    test.addCleanup(time.tzset)
    test.addCleanup(patcher.stop)
    time.tzset()


class _FakeBackup:
    def __init__(self, sms_db: str):
        self.sms_db = sms_db

    def get_file(self, relative_path, domain="HomeDomain"):
        if (domain, relative_path) == ("HomeDomain", "Library/SMS/sms.db"):
            return self.sms_db
        return None


@unittest.skipUnless(hasattr(time, "tzset"), "time.tzset is POSIX-only")
class TestMessageStatsLocalTime(unittest.TestCase):

    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)

    def _backup(self, nanoseconds: bool) -> _FakeBackup:
        path = os.path.join(self._tmp.name, f"sms-{nanoseconds}.db")
        conn = sqlite3.connect(path)
        conn.executescript(
            "CREATE TABLE message (ROWID INTEGER PRIMARY KEY, date INTEGER, is_from_me INTEGER);"
            "CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT, "
            "display_name TEXT, service_name TEXT, group_id TEXT);"
            "CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);"
            "INSERT INTO chat VALUES (1, '+15555550100', '', 'iMessage', NULL);"
        )
        scale = 1_000_000_000 if nanoseconds else 1
        for rowid, sent_at in enumerate(_FRIDAY_EVENING_PDT + [_WEDNESDAY_NOON_PDT], start=1):
            apple_date = int((sent_at - _APPLE_EPOCH).total_seconds()) * scale
            conn.execute("INSERT INTO message VALUES (?, ?, 1)", (rowid, apple_date))
            conn.execute("INSERT INTO chat_message_join VALUES (1, ?)", (rowid,))
        conn.commit()
        conn.close()
        return _FakeBackup(path)

    def test_busiest_day_and_hour_use_local_time(self):
        _use_time_zone(self, "America/Los_Angeles")
        for nanoseconds in (True, False):
            with self.subTest(nanoseconds=nanoseconds):
                stats = StatsComputer()._message_stats(self._backup(nanoseconds), {})
                self.assertEqual(stats["busiest_day"], "Friday")
                self.assertEqual(stats["busiest_hour"], 19)

    def test_busiest_day_and_hour_follow_the_computers_time_zone(self):
        _use_time_zone(self, "UTC")
        stats = StatsComputer()._message_stats(self._backup(nanoseconds=True), {})
        self.assertEqual(stats["busiest_day"], "Saturday")
        self.assertEqual(stats["busiest_hour"], 2)


def _read_info(last_backup: datetime) -> dict:
    """Read the info for a backup whose Info.plist has this Last Backup Date."""
    with tempfile.TemporaryDirectory() as backup_dir:
        with open(os.path.join(backup_dir, "Info.plist"), "wb") as f:
            plistlib.dump({"Last Backup Date": last_backup}, f)
        open(os.path.join(backup_dir, "Manifest.db"), "wb").close()
        return BackupManager()._read_backup_info(backup_dir)


class TestLastBackupDate(unittest.TestCase):

    def test_last_backup_is_marked_as_utc(self):
        # Backup made 2026-06-28 21:10 PDT; Info.plist stores it in UTC, which
        # plistlib hands back as a naive datetime.
        info = _read_info(datetime(2026, 6, 29, 4, 10))

        self.assertEqual(info["last_backup"], "2026-06-29T04:10:00+00:00")

    @unittest.skipUnless(hasattr(time, "tzset"), "time.tzset is POSIX-only")
    def test_last_backup_converts_to_the_local_date(self):
        _use_time_zone(self, "America/Los_Angeles")
        info = _read_info(datetime(2026, 6, 29, 4, 10))

        local = datetime.fromisoformat(info["last_backup"]).astimezone()
        self.assertEqual(local.date(), date(2026, 6, 28))
        self.assertEqual(local.hour, 21)


if __name__ == "__main__":
    unittest.main()
