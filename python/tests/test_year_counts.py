"""
Tests for the Year view's day counts: the cases a synthetic backup doesn't hold,
on small hand-built databases. python/tests/corpus/test_corpus_year_counts.py
checks real generated backups against the Timeline's sources.
"""

import json
import os
import sqlite3
import sys
import tempfile
import time
import unittest
from datetime import datetime, timezone
from unittest import mock

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from year_counts import YearCounter, _Person  # noqa: E402

_APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)
_NANO = 1_000_000_000

_SMS_SCHEMA = """
    CREATE TABLE message (ROWID INTEGER PRIMARY KEY, date INTEGER, associated_message_type INTEGER,
                          balloon_bundle_id TEXT);
    CREATE TABLE chat (ROWID INTEGER PRIMARY KEY, chat_identifier TEXT);
    CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER);
"""


def _apple(when: datetime) -> int:
    return int((when - _APPLE_EPOCH).total_seconds())


def _utc(*args) -> datetime:
    return datetime(*args, tzinfo=timezone.utc)


def _local_noon(year: int, month: int, day: int) -> datetime:
    """Noon on this computer's clock, so the day doesn't depend on the time zone tests run in."""
    return datetime(year, month, day, 12).astimezone(timezone.utc)


def _use_time_zone(test: unittest.TestCase, tz: str) -> None:
    patcher = mock.patch.dict(os.environ, {"TZ": tz})
    patcher.start()
    test.addCleanup(time.tzset)
    test.addCleanup(patcher.stop)
    time.tzset()


class _FakeBackup:
    """Only what a backup accessor has: paths for get_file, and its info."""

    def __init__(self, files: dict, info: dict | None = None):
        self.files = files
        self.info = info or {}
        self.backup_dir = None

    def get_file(self, relative_path, domain="HomeDomain"):
        return self.files.get(relative_path)


class _Base(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.calls = mock.Mock()
        self.calls.list_calls.return_value = {"calls": []}
        self.notes = mock.Mock()
        self.notes.list_notes.return_value = {"notes": []}
        self.browser = mock.Mock()
        self.browser.list_browser_history.return_value = {"visits": []}
        self.photos = mock.Mock()
        self.photos._inner._open_photos_db.return_value = None
        self.messages = mock.Mock()
        self.counter = YearCounter(self.messages, self.photos, self.calls, self.notes, self.browser)

    def _db(self, name: str, script: str, rows=()) -> str:
        path = tempfile.mktemp(suffix=name, dir=self._tmp.name)
        conn = sqlite3.connect(path)
        conn.executescript(script)
        for sql, values in rows:
            conn.executemany(sql, values)
        conn.commit()
        conn.close()
        return path

    def _sms(self, messages, chats=((1, "+15555550100"),), name="sms.db") -> _FakeBackup:
        """messages: (rowid, date, reaction type, bundle id, [chat ids])."""
        path = self._db(name, _SMS_SCHEMA, [
            ("INSERT INTO chat VALUES (?, ?)", chats),
            ("INSERT INTO message VALUES (?, ?, ?, ?)", [m[:4] for m in messages]),
            ("INSERT INTO chat_message_join VALUES (?, ?)",
             [(chat, m[0]) for m in messages for chat in m[4]]),
        ])
        return _FakeBackup({"Library/SMS/sms.db": path})

    def _counts(self, backup, year, **kwargs):
        return self.counter.year_counts(backup, {}, year, **kwargs)


@unittest.skipUnless(hasattr(time, "tzset"), "time.tzset is POSIX-only")
class TestLocalDays(_Base):
    # 7 PM on June 26 in California is 2 AM on June 27 in UTC.
    EVENING = _utc(2026, 6, 27, 2, 5)

    def test_messages_count_on_the_computers_local_day(self):
        backup = self._sms([(1, _apple(self.EVENING) * _NANO, 0, None, [1])])
        _use_time_zone(self, "America/Los_Angeles")
        self.assertEqual(self._counts(backup, 2026)["days"], {"2026-06-26": {"message": 1}})

    def test_the_local_day_follows_the_time_zone(self):
        backup = self._sms([(1, _apple(self.EVENING) * _NANO, 0, None, [1])])
        _use_time_zone(self, "UTC")
        self.assertEqual(self._counts(backup, 2026)["days"], {"2026-06-27": {"message": 1}})

    def test_new_years_eve_belongs_to_the_old_year(self):
        backup = self._sms([(1, _apple(_utc(2026, 1, 1, 3)) * _NANO, 0, None, [1])])
        _use_time_zone(self, "America/Los_Angeles")
        result = self._counts(backup, 2025)
        self.assertEqual(result["years"], [2025])
        self.assertEqual(result["days"], {"2025-12-31": {"message": 1}})

    def test_seconds_and_nanoseconds_in_one_database(self):
        backup = self._sms([
            (1, _apple(_utc(2020, 3, 4, 12)), 0, None, [1]),
            (2, _apple(_utc(2020, 3, 4, 13)) * _NANO, 0, None, [1]),
        ])
        _use_time_zone(self, "UTC")
        self.assertEqual(self._counts(backup, 2020)["days"], {"2020-03-04": {"message": 2}})

    def test_calls_notes_and_web_use_the_same_local_day(self):
        self.calls.list_calls.return_value = {"calls": [{"address": "+15555550100", "date": self.EVENING.isoformat()}]}
        self.notes.list_notes.return_value = {"notes": [{"created": self.EVENING.isoformat(), "modified": None}]}
        self.browser.list_browser_history.return_value = {"visits": [{"visit_date": self.EVENING.isoformat()}]}
        _use_time_zone(self, "America/Los_Angeles")
        days = self._counts(_FakeBackup({}), 2026)["days"]
        self.assertEqual(days, {"2026-06-26": {"call": 1, "note": 1, "browser": 1}})


class TestWhatCounts(_Base):
    DAY = _apple(_utc(2024, 5, 5, 12)) * _NANO

    def test_tapbacks_and_location_balloons_are_left_out(self):
        backup = self._sms([
            (1, self.DAY, 0, None, [1]),
            (2, self.DAY, None, None, [1]),
            (3, self.DAY, 2000, None, [1]),  # a tapback
            (4, self.DAY, 3000, None, [1]),  # removing one
            (5, self.DAY, 0, "com.apple.messages.MSMessageExtensionBalloonPlugin:0:com.apple.findmy", [1]),
            (6, self.DAY, 0, "com.apple.messages.URLBalloonProvider", [1]),
        ])
        result = self._counts(backup, 2024)
        self.assertEqual(sum(d["message"] for d in result["days"].values()), 3)

    def test_undated_messages_and_ones_in_no_chat_are_left_out(self):
        backup = self._sms([
            (1, self.DAY, 0, None, [1]),
            (2, 0, 0, None, [1]),
            (3, self.DAY, 0, None, []),
            (4, self.DAY, 0, None, [99]),  # joined to a chat that isn't there
        ])
        result = self._counts(backup, 2024)
        self.assertEqual(sum(d["message"] for d in result["days"].values()), 1)

    def test_a_message_in_two_chats_counts_once(self):
        backup = self._sms([(1, self.DAY, 0, None, [1, 2])], chats=((1, "+15555550100"), (2, "a@example.org")))
        result = self._counts(backup, 2024)
        self.assertEqual(sum(d["message"] for d in result["days"].values()), 1)

    def test_counts_past_the_timelines_message_limit(self):
        total = 200_500
        path = self._db("big.db", _SMS_SCHEMA, [
            ("INSERT INTO chat VALUES (?, ?)", [(1, "+15555550100")]),
            ("INSERT INTO message VALUES (?, ?, 0, NULL)", ((i, self.DAY) for i in range(1, total + 1))),
            ("INSERT INTO chat_message_join VALUES (1, ?)", ((i,) for i in range(1, total + 1))),
        ])
        result = self._counts(_FakeBackup({"Library/SMS/sms.db": path}), 2024)
        self.assertEqual(sum(d["message"] for d in result["days"].values()), total)

    def test_photos_leave_out_trashed_and_ones_only_in_icloud(self):
        when = _apple(_utc(2024, 5, 5, 12))
        path = self._db("Photos.sqlite", """
            CREATE TABLE ZASSET (Z_PK INTEGER PRIMARY KEY, ZDATECREATED TIMESTAMP, ZTRASHEDSTATE INTEGER);
        """, [("INSERT INTO ZASSET VALUES (?, ?, ?)", [
            (1, when, 0),
            (2, when, 0),
            (3, when, 1),  # trashed
            (4, when, 0),  # only in iCloud
            (5, None, 0),  # no date, so no place on the Timeline
        ])])
        self.photos._inner._open_photos_db.side_effect = lambda _: sqlite3.connect(path)
        self.photos.ids_in_backup.return_value = frozenset({1, 2, 3, 5})
        result = self._counts(_FakeBackup({}), 2024)
        self.assertEqual(sum(d["photo"] for d in result["days"].values()), 2)

    def test_photos_on_ios_13_and_earlier(self):
        path = self._db("Photos.sqlite", "CREATE TABLE ZGENERICASSET (Z_PK INTEGER PRIMARY KEY, ZDATECREATED TIMESTAMP);",
                        [("INSERT INTO ZGENERICASSET VALUES (?, ?)", [(1, _apple(_utc(2019, 5, 5, 12)))])])
        self.photos._inner._open_photos_db.side_effect = lambda _: sqlite3.connect(path)
        self.photos.ids_in_backup.return_value = None
        self.assertEqual(self._counts(_FakeBackup({}), 2019)["years"], [2019])

    def test_voicemail_leaves_out_trashed_and_undated(self):
        when = int(_utc(2024, 5, 5, 12).timestamp())
        path = self._db("voicemail.db", """
            CREATE TABLE voicemail (ROWID INTEGER PRIMARY KEY, sender TEXT, date INTEGER, trashed_date INTEGER);
        """, [("INSERT INTO voicemail VALUES (?, ?, ?, ?)", [
            (1, "+15555550100", when, 0),
            (2, "+15555550100", when, None),
            (3, "+15555550100", when, when + 60),
            (4, "+15555550100", 0, 0),
        ])])
        result = self._counts(_FakeBackup({"Library/Voicemail/voicemail.db": path}), 2024)
        self.assertEqual(sum(d["voicemail"] for d in result["days"].values()), 2)

    def test_only_the_requested_types_come_back(self):
        backup = self._sms([(1, self.DAY, 0, None, [1])])
        self.notes.list_notes.return_value = {"notes": [{"created": _utc(2024, 5, 5, 12).isoformat()}]}
        days = self._counts(backup, 2024, types=["note"])["days"]
        self.assertEqual(list(next(iter(days.values()))), ["note"])

    def test_unknown_types_are_refused(self):
        with self.assertRaises(ValueError):
            self._counts(_FakeBackup({}), 2024, types=["health"])

    def test_one_unreadable_type_doesnt_hide_the_others(self):
        backup = self._sms([(1, self.DAY, 0, None, [1])])
        self.notes.list_notes.side_effect = RuntimeError("Notes could not be read")
        result = self._counts(backup, 2024)
        self.assertEqual(result["errors"], {"note": "Notes could not be read"})
        self.assertEqual(sum(d["message"] for d in result["days"].values()), 1)

    def test_a_backup_without_call_history_is_not_an_error(self):
        self.calls.list_calls.return_value = {
            "calls": [], "empty_reason": "requires_encryption", "error": "Call history not found.",
        }
        self.assertEqual(self._counts(_FakeBackup({}), 2024)["errors"], {})

    def test_unreadable_call_history_is_an_error(self):
        self.calls.list_calls.return_value = {"calls": [], "error": "could not be read"}
        self.assertEqual(self._counts(_FakeBackup({}), 2024)["errors"], {"call": "could not be read"})


class TestPerson(_Base):
    DAY = _apple(_utc(2024, 5, 5, 12)) * _NANO
    CHATS = (
        (1, "+15555550100"),
        (2, "riley@example.org"),
        (3, "+15555550199"),
        (4, "chat644566139839284925"),
    )

    def _backup(self):
        return self._sms([
            (1, self.DAY, 0, None, [1]),
            (2, self.DAY, 0, None, [2]),
            (3, self.DAY, 0, None, [3]),
            (4, self.DAY, 0, None, [4]),
        ], chats=self.CHATS)

    def _messages(self, identifiers):
        days = self._counts(self._backup(), 2024, identifiers=identifiers)["days"]
        return sum(d.get("message", 0) for d in days.values())

    def test_every_number_and_email_of_a_person_counts(self):
        self.assertEqual(self._messages(["(555) 555-0100", "Riley@Example.org"]), 2)

    def test_a_group_chat_counts_only_when_named(self):
        self.assertEqual(self._messages(["+15555550100"]), 1)
        self.assertEqual(self._messages(["+15555550100", "chat644566139839284925"]), 2)

    def test_no_identifiers_matches_nothing_not_everyone(self):
        self.assertEqual(self._messages([]), 0)

    def test_a_group_chat_id_is_not_read_as_a_phone_number(self):
        self.assertFalse(_Person(["+18398392849"]).matches("chat644566139839284925"))
        self.assertFalse(_Person(["chat644566139839284925"]).matches("+16139839284925"))

    def test_short_codes_match_exactly(self):
        self.assertTrue(_Person(["12345"]).matches("12345"))
        self.assertFalse(_Person(["12345"]).matches("+112345"))

    def test_calls_and_voicemail_match_by_address(self):
        when = _utc(2024, 5, 5, 12)
        self.calls.list_calls.return_value = {"calls": [
            {"address": "+1 555 555 0100", "date": when.isoformat()},
            {"address": "+15555550199", "date": when.isoformat()},
        ]}
        path = self._db("voicemail.db", """
            CREATE TABLE voicemail (ROWID INTEGER PRIMARY KEY, sender TEXT, date INTEGER, trashed_date INTEGER);
        """, [("INSERT INTO voicemail VALUES (?, ?, ?, 0)", [
            (1, "15555550100", int(when.timestamp())),
            (2, "+15555550199", int(when.timestamp())),
        ])])
        backup = _FakeBackup({"Library/Voicemail/voicemail.db": path})
        days = self._counts(backup, 2024, identifiers=["+15555550100"])["days"]
        self.assertEqual(list(days.values()), [{"call": 1, "voicemail": 1}])

    def test_photos_notes_and_web_arent_counted_for_a_person(self):
        when = _utc(2024, 5, 5, 12).isoformat()
        self.notes.list_notes.return_value = {"notes": [{"created": when}]}
        self.browser.list_browser_history.return_value = {"visits": [{"visit_date": when}]}
        self.assertEqual(self._counts(_FakeBackup({}), 2024, identifiers=["+15555550100"])["days"], {})

    def test_years_describe_the_backup_not_the_person(self):
        backup = self._sms([
            (1, _apple(_utc(2022, 5, 5, 12)) * _NANO, 0, None, [1]),
            (2, self.DAY, 0, None, [3]),
        ], chats=self.CHATS)
        result = self._counts(backup, 2024, identifiers=["+15555550100"], types=["message"])
        self.assertEqual(result["years"], [2022, 2024])
        self.assertEqual(result["days"], {})
        self.assertEqual(result["history_start"][:4], "2022")


class TestHistoryEdges(_Base):
    def test_history_start_is_the_first_counted_message(self):
        backup = self._sms([
            (1, _apple(_local_noon(2023, 8, 10)) * _NANO, 2000, None, [1]),  # a tapback isn't history
            (2, _apple(_local_noon(2023, 8, 11)) * _NANO, 0, None, [1]),
            (3, _apple(_local_noon(2024, 1, 2)) * _NANO, 0, None, [1]),
        ])
        self.assertEqual(self._counts(backup, 2024)["history_start"], "2023-08-11")

    def test_older_photos_add_years_but_dont_move_history_start(self):
        backup = self._sms([(1, _apple(_local_noon(2024, 8, 11)) * _NANO, 0, None, [1])])
        self.notes.list_notes.return_value = {"notes": [{"created": _local_noon(2015, 3, 3).isoformat()}]}
        result = self._counts(backup, 2015)
        self.assertEqual(result["years"], [2015, 2024])
        self.assertEqual(result["history_start"], "2024-08-11")

    def test_no_messages_means_no_history_start(self):
        result = self._counts(_FakeBackup({}), 2024)
        self.assertIsNone(result["history_start"])
        self.assertEqual(result["years"], [])

    def test_history_ends_on_the_day_the_backup_was_made(self):
        backup = _FakeBackup({}, info={"last_backup": _local_noon(2026, 6, 29).isoformat()})
        self.assertEqual(self._counts(backup, 2026)["history_end"], "2026-06-29")

    def test_history_ends_on_the_latest_item_without_a_backup_date(self):
        self.notes.list_notes.return_value = {"notes": [{"created": _local_noon(2025, 3, 3).isoformat()}]}
        self.assertEqual(self._counts(_FakeBackup({}), 2025)["history_end"], "2025-03-03")


class TestCaching(_Base):
    def test_each_backup_is_read_once(self):
        backup = _FakeBackup({})
        self.notes.list_notes.return_value = {"notes": [{"created": _utc(2024, 5, 5, 12).isoformat()}]}
        self._counts(backup, 2024)
        self._counts(backup, 2023)
        self._counts(backup, 2024, types=["note"])
        self._counts(backup, 2024, identifiers=["+15555550100"])
        self._counts(backup, 2024, identifiers=["+15555550100"])
        self.notes.list_notes.assert_called_once()
        self.calls.list_calls.assert_called_once()

    def test_reopening_a_backup_reads_it_again(self):
        self._counts(_FakeBackup({}), 2024)
        self._counts(_FakeBackup({}), 2024)
        self.assertEqual(self.notes.list_notes.call_count, 2)

    def test_a_failed_read_is_tried_again(self):
        backup = _FakeBackup({})
        self.notes.list_notes.side_effect = [RuntimeError("busy"), {"notes": []}]
        self.assertEqual(self._counts(backup, 2024)["errors"], {"note": "busy"})
        self.assertEqual(self._counts(backup, 2024)["errors"], {})

    def test_the_result_is_json(self):
        self.assertTrue(json.dumps(self._counts(_FakeBackup({}), 2024)))


@unittest.skipUnless(hasattr(time, "tzset"), "time.tzset is POSIX-only")
class TestMessagesOnDay(_Base):
    def test_finds_a_day_far_older_than_the_newest_messages(self):
        _use_time_zone(self, "UTC")
        target = _apple(_utc(2019, 2, 3, 12)) * _NANO
        rows = [(i, _apple(_utc(2024, 1, 1, 12)) * _NANO + i, 0, None, [1]) for i in range(10, 1200)]
        rows += [(i, target, 0, None, [1]) for i in (3, 5)]
        rows += [(4, _apple(_utc(2019, 2, 4, 12)) * _NANO, 0, None, [1])]  # between them, a day later
        backup = self._sms(rows)

        def get_messages(_backup, chat_id, _contacts, offset, limit):
            ids = sorted((r[0] for r in rows), reverse=True)[offset:offset + limit]
            by_id = {r[0]: r for r in rows}
            iso = lambda d: datetime.fromtimestamp(d / _NANO + 978307200, timezone.utc).isoformat()  # noqa: E731
            return {"messages": [{"message_id": i, "date": iso(by_id[i][1])} for i in ids]}

        self.messages.get_messages.side_effect = get_messages
        result = self.counter.messages_on_day(backup, {}, "2019-02-03")
        self.assertEqual([c["chat_id"] for c in result["conversations"]], [1])
        self.assertEqual({m["message_id"] for m in result["conversations"][0]["messages"]}, {3, 5})
        # It asked for only the page holding the day, not the whole chat.
        _, _, _, _, limit = self.messages.get_messages.call_args.args
        self.assertEqual(limit, 3)

    def test_a_day_without_messages_is_empty(self):
        backup = self._sms([(1, _apple(_utc(2024, 1, 1, 12)) * _NANO, 0, None, [1])])
        self.assertEqual(self.counter.messages_on_day(backup, {}, "2019-02-03"), {"conversations": []})


if __name__ == "__main__":
    unittest.main()
