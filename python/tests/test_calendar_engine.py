"""
The engine's Calendar methods over real (minimal) backups, called the way the RPC handlers are.

Each state the calendar can be in, and what every method and the home
screen's counts (get_backup_stats) say about it:

  * not in the backup (or an ios-backup-core without Calendar support):
    calm empties, no error anywhere, and nothing saved;
  * in the backup with nothing to list: "no_records";
  * listed but unreadable: an error, counted in the overview's errors, and
    saves fail instead of writing empty files;
  * an older layout (iOS 4's Event table): "unsupported_format", not an
    error in the overview;
  * a full calendar, in the iOS 26 and the iOS 13 layouts: the calendars,
    the events (each kind of date in its own fields), the filters, the rule in
    words and the home screen's counts agree.

Reading a calendar needs ios-backup-core with the Calendar extractor and its
backupgen (for the table definitions): those cases skip without it (or fail
when OPENEXTRACT_REQUIRE_GENERATED=1). The calm "not in the backup" case
runs either way.
"""

import io
import json
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
from rpc_contract_support import load_engine_module, skip_or_fail  # noqa: E402
import calendar_backup as cb  # noqa: E402

NOTHING_TO_SAVE = "There are no calendar events in this backup to save."


def _needs_library():
    problem = cb.library_problem()
    if problem:
        skip_or_fail(problem)


class EngineCase(unittest.TestCase):

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)  # runs last: after the backups are closed (Windows)
        self.tmp = Path(tmp.name)
        self.server = load_engine_module().SidecarServer()
        self.addCleanup(self._close_all)
        self.n = 0

    def _close_all(self):
        for udid in list(self.server.backup_manager._open_backups):
            self.server.backup_manager.close_backup(udid)

    def open(self, files: dict, missing=()) -> str:
        """Open a bare backup holding ``files``; ``missing`` are listed in its Manifest.db but not on disk."""
        self.n += 1
        udid = f"00008120-00000000000000{self.n:02d}"
        backup_dir = cb.make_minimal(self.tmp / f"b{self.n}" / udid, files, udid)
        for domain, rel in missing:
            fid = cb.wb.file_id(domain, rel)
            os.remove(backup_dir / fid[:2] / fid)
        self.assertEqual(self.call("open_backup", udid=udid, backup_dir=str(backup_dir))["status"], "open")
        return udid

    def call(self, method, **params):
        result = self.server.methods[method](params)
        json.dumps(result)  # what goes back to the app must be plain JSON as it is
        return result

    def out(self, name="out") -> Path:
        return self.tmp / name  # not made: a save that has nothing to write must not make it either

    def overview(self, udid):
        """((own events, other events, own calendars, own calendars with events, status), errors)."""
        stats = self.call("get_backup_stats", udid=udid)
        o = stats["overview"]
        counts = (o["total_calendar_events"], o["total_subscribed_events"], o["total_calendars"],
                  o["total_calendars_with_events"], o["calendar_status"])
        return counts, stats["errors"]

    def assert_every_method(self, udid, *, calendars, events, save):
        """Each method answers the same way for the state; saves never write a file for it."""
        self.assertEqual(self.call("list_calendars", udid=udid), calendars)
        for params in ({}, {"include_hidden": True}):
            self.assertEqual(self.call("list_calendar_events", udid=udid, **params), events)
        out = self.out(f"save-{udid[-2:]}")
        for fmt in ("ics", "csv"):
            self.assertEqual(self.call("export_calendar", udid=udid, output_dir=str(out), format=fmt), save)
        self.assertFalse(out.exists())


class TestNotInBackup(EngineCase):

    def test_calm_everywhere(self):
        udid = self.open({})
        self.assert_every_method(
            udid,
            calendars={"calendars": [], "empty_reason": "not_in_backup"},
            events={"events": [], "empty_reason": "not_in_backup"},
            save={"error": NOTHING_TO_SAVE, "empty_reason": "not_in_backup"},
        )
        self.assertEqual(self.call("list_calendar_events", udid=udid, calendar_id=3),
                         {"events": [], "empty_reason": "not_in_backup"})
        self.assertEqual(self.overview(udid), ((0, 0, 0, 0, "not_in_backup"), []))

    def test_without_library_support_every_method_is_calm(self):
        import calendar_events
        saved = calendar_events._told_no_support
        self.addCleanup(setattr, calendar_events, "_told_no_support", saved)
        calendar_events._told_no_support = False
        log = io.StringIO()
        with redirect_stderr(log):
            first, second = calendar_events._NoCalendarSupport(), calendar_events._NoCalendarSupport()
        self.assertEqual(log.getvalue().count("no Calendar extractor"), 1)
        self.server.calendar_extractor._inner = first
        udid = self.open({cb.LIBRARY: b"whatever is there"})
        self.assert_every_method(
            udid,
            calendars={"calendars": [], "empty_reason": "not_in_backup"},
            events={"events": [], "empty_reason": "not_in_backup"},
            save={"error": NOTHING_TO_SAVE, "empty_reason": "not_in_backup"},
        )
        self.assertEqual(self.overview(udid), ((0, 0, 0, 0, "not_in_backup"), []))
        self.assertEqual(second.list_events(None, calendar_id=3), {"events": [], "empty_reason": "not_in_backup"})


class TestLibraryStates(EngineCase):

    def setUp(self):
        super().setUp()
        _needs_library()

    def test_nothing_to_list(self):
        for data in (cb.empty_library(self.tmp / "e26", "ios26"), cb.empty_library(self.tmp / "e13", "ios13"), b""):
            udid = self.open({cb.LIBRARY: data})
            self.assert_every_method(
                udid,
                calendars={"calendars": [], "empty_reason": "no_records"},
                events={"events": [], "empty_reason": "no_records", "hidden_count": 0},
                save={"error": NOTHING_TO_SAVE, "empty_reason": "no_records"},
            )
            self.assertEqual(self.overview(udid), ((0, 0, 0, 0, "no_records"), []))

    def test_listed_but_unreadable(self):
        for files, missing in (({cb.LIBRARY: b"not a database " * 64}, ()),
                               ({cb.LIBRARY: b"x"}, (cb.LIBRARY,))):
            udid = self.open(files, missing)
            unreadable = self.call("list_calendars", udid=udid)
            self.assertEqual(unreadable["calendars"], [])
            self.assertNotIn("empty_reason", unreadable)
            error = unreadable["error"]
            self.assertIn("could not be read", error)
            self.assertNotIn("Error", error.split("(")[0])  # words for people, before any detail
            self.assert_every_method(udid, calendars=unreadable, events={"events": [], "error": error},
                                     save={"error": error})
            counts, errors = self.overview(udid)
            self.assertEqual(counts, (0, 0, 0, 0, "error"))
            self.assertEqual(errors, [f"calendar: {error}"])

    def test_an_older_layout_is_not_an_error(self):
        udid = self.open({cb.LIBRARY: cb.old_layout_library(self.tmp / "old")})
        result = self.call("list_calendar_events", udid=udid)
        self.assertEqual((result["events"], result["empty_reason"]), ([], "unsupported_format"))
        self.assertIn("older format", result["error"])
        self.assertEqual(self.call("list_calendars", udid=udid)["empty_reason"], "unsupported_format")
        out = self.out()
        self.assertEqual(self.call("export_calendar", udid=udid, output_dir=str(out), format="ics"),
                         {"error": result["error"], "empty_reason": "unsupported_format"})
        self.assertFalse(out.exists())
        self.assertEqual(self.overview(udid), ((0, 0, 0, 0, "unsupported_format"), []))


class FullCalendar:
    """The test calendar in one layout; subclasses set LAYOUT."""

    LAYOUT = "ios26"

    def setUp(self):
        super().setUp()
        _needs_library()
        self.scenario = cb.build(self.tmp / "parts", self.LAYOUT)
        self.udid = self.open(self.scenario.files)

    def test_calendars_read_as_the_database_holds_them(self):
        s = self.scenario
        result = self.call("list_calendars", udid=self.udid)
        self.assertNotIn("error", result)
        calendars = result["calendars"]
        # The scheduling inbox and the reminders-only list are left out; the phone's own order.
        self.assertEqual([c["id"] for c in calendars],
                         [cb.CAL_DEFAULT, cb.CAL_HOME, cb.CAL_WORK, cb.CAL_HOLIDAYS, cb.CAL_BIRTHDAYS])
        for c in calendars:
            self.assertEqual({k: c[k] for k in s.calendars[c["id"]]}, s.calendars[c["id"]], c["id"])

    def test_events_read_as_the_database_holds_them(self):
        s = self.scenario
        result = self.call("list_calendar_events", udid=self.udid)
        self.assertNotIn("error", result)
        self.assertEqual(result["hidden_count"], len(s.hidden))
        events = result["events"]
        self.assertEqual([e["id"] for e in events], s.in_order())
        for e in events:
            self.assertEqual({k: e[k] for k in s.events[e["id"]]}, s.events[e["id"]], e["id"])
        by_id = {e["id"]: e for e in events}
        self.assertEqual(by_id[cb.EV_BAKERY]["title"], cb.BAKERY_TITLE)  # stored as a BLOB
        # A field never mixes kinds of date.
        for e in events:
            if e["all_day"]:
                self.assertEqual((e["start"], e["wall_start"]), (None, None))
                self.assertEqual(len(e["start_day"]), 10)
            elif e["floating"]:
                self.assertEqual((e["start"], e["start_day"]), (None, None))
                self.assertNotIn("+", e["wall_start"])
            else:
                self.assertEqual((e["start_day"], e["wall_start"]), (None, None))
                self.assertTrue(e["start"].endswith("+00:00"))

    def test_the_rule_in_words(self):
        by_id = {e["id"]: e for e in self.call("list_calendar_events", udid=self.udid)["events"]}
        self.assertEqual(by_id[cb.EV_FATHERS_DAY]["repeats"], "Every year on the third Sunday of June, 10 times")
        # Until the end of Aug 26 in Los Angeles, which is Aug 27 in UTC.
        self.assertEqual(by_id[cb.EV_CLIMB]["repeats"], "Every week on Tuesday, until Aug 26, 2025")
        self.assertEqual({i for i, e in by_id.items() if e["repeats"] is not None}, {cb.EV_FATHERS_DAY, cb.EV_CLIMB})
        self.assertTrue(all("repeats" in e for e in by_id.values()))

    def test_one_calendar_and_its_count(self):
        s = self.scenario
        calendars = self.call("list_calendars", udid=self.udid)["calendars"]
        for c in calendars:
            for asked in (c["id"], str(c["id"])):
                result = self.call("list_calendar_events", udid=self.udid, calendar_id=asked)
                ids = [e["id"] for e in result["events"]]
                self.assertEqual(ids, s.in_order(s.events_of(c["id"])), c["id"])
                self.assertEqual(len(ids), c["event_count"], c["id"])
                if not ids:
                    self.assertEqual(result["empty_reason"], "no_records")
        # Not an id: never the calendar a float rounds down to, nor "could not be read" for a huge number.
        for unknown in (999, "abc", True, cb.CAL_HOME + 0.9, -1, 2 ** 63, "9" * 5000):
            result = self.call("list_calendar_events", udid=self.udid, calendar_id=unknown)
            self.assertEqual((result["events"], result["empty_reason"]), ([], "no_records"), unknown)

    def test_hidden_and_junk_events_on_request(self):
        s = self.scenario
        every = self.call("list_calendar_events", udid=self.udid, include_hidden=True)
        self.assertEqual({e["id"] for e in every["events"]}, set(s.events) | s.hidden)
        self.assertEqual(every["hidden_count"], 0)

    def test_contacts_name_people_without_a_name(self):
        backup = self.server.backup_manager.get_open_backup(self.udid)
        found = self.server.calendar_extractor.list_events(backup, contacts={"riley@example.com": "Riley Chen"})
        standup = next(e for e in found["events"] if e["id"] == cb.EV_STANDUP)
        self.assertEqual([a["name"] for a in standup["attendees"]], ["Pat Okafor", "Sam Rivera", "Riley Chen", "Room 4B"])

    def test_counts_on_the_home_screen_match_the_lists(self):
        s = self.scenario
        calendars = self.call("list_calendars", udid=self.udid)["calendars"]
        events = self.call("list_calendar_events", udid=self.udid)["events"]
        kinds = {c["id"]: c["kind"] for c in calendars}
        mine = [e for e in events if kinds[e["calendar_id"]] == "normal"]
        counts, errors = self.overview(self.udid)
        self.assertEqual(counts, (len(mine), len(events) - len(mine), sum(1 for c in calendars if c["kind"] == "normal"),
                                  len({e["calendar_id"] for e in mine}), "ok"))
        with_events = {s.events[i]["calendar_id"] for i in s.own_events}
        self.assertEqual(counts, (len(s.own_events), len(s.events) - len(s.own_events), len(s.own), len(with_events),
                                  "ok"))
        # The local Default calendar is the person's own but has nothing in it: not "events in 3 calendars".
        self.assertNotIn(cb.CAL_DEFAULT, with_events)
        self.assertEqual(counts[2:4], (3, 2))
        self.assertEqual(errors, [])

    def test_reopening_reads_the_calendar_again(self):
        before = self.call("list_calendar_events", udid=self.udid)
        backup_dir = self.server.backup_manager.get_open_backup(self.udid).backup_dir
        self.assertEqual(self.call("open_backup", udid=self.udid, backup_dir=backup_dir)["status"], "open")
        self.assertEqual(self.call("list_calendar_events", udid=self.udid), before)


class TestIos26Calendar(FullCalendar, EngineCase):
    LAYOUT = "ios26"


class TestIos13Calendar(FullCalendar, EngineCase):
    LAYOUT = "ios13"


if __name__ == "__main__":
    unittest.main()
