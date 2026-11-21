"""
Saving the calendar (python/calendar_events.py): .ics files for another calendar app, or a CSV.

What must hold:

  * the .ics files are valid iCalendar (RFC 5545), read back here with a small
    unfolder: CRLF line ends, lines of 75 octets or fewer, every BEGIN with
    its END, TEXT escaped; all-day events as dates with the day after the
    last as DTEND; floating times with no zone and no Z; zoned times with
    their TZID and a VTIMEZONE for each; a series' RRULE and EXDATE, and a
    moved occurrence under the series' UID with its RECURRENCE-ID; alerts;
    no ORGANIZER or ATTENDEE (re-importing would make meetings of them);
  * saving every calendar writes one file per calendar that has events, in a
    folder named after the iPhone; one calendar is one file;
  * the CSV has its columns, zoned times in local time with the offset (here
    in fixed PDT and IST zones), and all-day days and floating times exactly
    as stored, never moved; no cell a spreadsheet would run;
  * a save never overwrites a file ("Home (2).ics"), and nothing to save
    writes nothing and says so calmly.

The .ics and folder cases run through the engine's handlers over a minimal
backup holding the test calendar (calendar_backup.py), with the library's
events_to_ics; they skip without ios-backup-core's Calendar extractor and
backupgen (or fail when OPENEXTRACT_REQUIRE_GENERATED=1). The CSV cases feed
the adapter events in the library's shape.
"""

import os
import re
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))
from rpc_contract_support import load_engine_module, read_csv, skip_or_fail  # noqa: E402
import calendar_backup as cb  # noqa: E402
from calendar_events import CalendarExtractor, repeats_text  # noqa: E402

PDT = timezone(timedelta(hours=-7), "PDT")
IST = timezone(timedelta(hours=5, minutes=30), "IST")
NOW = datetime(2026, 11, 20, 9, 30, tzinfo=timezone.utc)
HEADER = ["Calendar", "Account", "Title", "Start", "End", "All Day", "Time Zone", "Location", "Address",
          "Latitude", "Longitude", "Notes", "URL", "Repeats", "RRULE", "Status", "Availability", "Organizer",
          "Invitees", "Alerts", "Created", "Modified"]
NOTHING_TO_SAVE = "There are no calendar events in this backup to save."


def _needs_library():
    problem = cb.library_problem()
    if problem:
        skip_or_fail(problem)


# ── Reading an .ics back ─────────────────────────────────────────────────────

def parse_ics(raw: bytes) -> list:
    """Check the file's framing and return its components as nested dicts:
    {"name", "props": [(name, params, value)], "children": [...]}."""
    assert raw.endswith(b"\r\n"), "the last line must end with CRLF"
    text = raw.decode("utf-8")
    physical = text[:-2].split("\r\n")
    assert "\n" not in text.replace("\r\n", ""), "a bare LF line end"
    for line in physical:
        assert len(line.encode("utf-8")) <= 75, f"a line longer than 75 octets: {len(line.encode('utf-8'))}"
    logical = []
    for line in physical:
        if line.startswith((" ", "\t")):
            assert logical, "a folded line with nothing to continue"
            logical[-1] += line[1:]
        else:
            logical.append(line)
    root = {"name": None, "props": [], "children": []}
    stack = [root]
    for line in logical:
        head, sep, value = line.partition(":")
        assert sep, f"a line without a colon: {line[:40]!r}"
        name, *params = head.split(";")
        if name == "BEGIN":
            node = {"name": value, "props": [], "children": []}
            stack[-1]["children"].append(node)
            stack.append(node)
        elif name == "END":
            assert stack[-1]["name"] == value, f"END:{value} closes {stack[-1]['name']}"
            stack.pop()
        else:
            stack[-1]["props"].append((name, tuple(params), value))
    assert len(stack) == 1, f"unclosed {stack[-1]['name']}"
    return root["children"]


def props(node, name) -> list:
    return [(params, value) for n, params, value in node["props"] if n == name]


def prop(node, name):
    found = props(node, name)
    assert len(found) == 1, f"{name}: {len(found)} found"
    return found[0]


def unescape(value: str) -> str:
    return re.sub(r"\\([\\;,nN])", lambda m: "\n" if m.group(1) in "nN" else m.group(1), value)


class IcsCase(unittest.TestCase):

    def setUp(self):
        _needs_library()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name)
        self.server = load_engine_module().SidecarServer()
        self.scenario = cb.build(self.tmp / "parts", "ios26")
        self.udid = "00008120-0000000000000088"
        backup_dir = cb.make_minimal(self.tmp / "backup" / self.udid, self.scenario.files, self.udid)
        self.server.methods["open_backup"]({"udid": self.udid, "backup_dir": str(backup_dir)})
        self.addCleanup(self.server.backup_manager.close_backup, self.udid)
        self.out = self.tmp / "out"
        self.out.mkdir()

    def save(self, fmt="ics", out=None, **params):
        return self.server.methods["export_calendar"](
            {"udid": self.udid, "output_dir": str(out or self.out), "format": fmt, **params})

    def vevents(self, path) -> dict:
        """UID (plus RECURRENCE-ID when there is one) -> VEVENT, for the calendar in ``path``."""
        (calendar,) = parse_ics(Path(path).read_bytes())
        self.assertEqual(calendar["name"], "VCALENDAR")
        out = {}
        for child in calendar["children"]:
            if child["name"] == "VEVENT":
                key = prop(child, "UID")[1]
                if props(child, "RECURRENCE-ID"):
                    key += "@" + prop(child, "RECURRENCE-ID")[1]
                out[key] = child
        return out


class TestEveryCalendar(IcsCase):

    def test_a_folder_with_a_file_per_calendar(self):
        s = self.scenario
        result = self.save()
        folder = self.out / "Test iPhone Calendar"  # the minimal backup's iPhone is "Test iPhone"
        files = [folder / "Home.ics", folder / "Work.ics", folder / "US Holidays.ics"]
        self.assertEqual(result, {"status": "success", "count": len(s.events), "calendars": 3, "path": str(folder),
                                  "files": [str(f) for f in files]})
        self.assertEqual(sorted(folder.iterdir()), sorted(files))  # none for calendars without events
        for path, calendar_id in zip(files, (cb.CAL_HOME, cb.CAL_WORK, cb.CAL_HOLIDAYS)):
            (calendar,) = parse_ics(path.read_bytes())
            self.assertEqual(prop(calendar, "VERSION")[1], "2.0")
            self.assertEqual(prop(calendar, "METHOD")[1], "PUBLISH")
            self.assertEqual(prop(calendar, "X-WR-CALNAME")[1], s.calendars[calendar_id]["title"])
            vevents = [c for c in calendar["children"] if c["name"] == "VEVENT"]
            self.assertEqual(len(vevents), len(s.events_of(calendar_id)), path.name)
            for v in vevents:
                self.assertEqual(props(v, "ORGANIZER") + props(v, "ATTENDEE"), [])

    def test_dates_of_every_kind(self):
        folder = Path(self.save()["path"])
        home, work = self.vevents(folder / "Home.ics"), self.vevents(folder / "Work.ics")
        holidays = self.vevents(folder / "US Holidays.ics")
        # All day: dates, and DTEND the day after the last day (July 4 to 6 inclusive).
        trip = home[f"UID-{cb.EV_TRIP}@example.com"]
        self.assertEqual(prop(trip, "DTSTART"), (("VALUE=DATE",), "20250704"))
        self.assertEqual(prop(trip, "DTEND"), (("VALUE=DATE",), "20250707"))
        # Floating: the wall clock, no zone and no Z.
        call = home[f"UID-{cb.EV_CALL}@example.com"]
        self.assertEqual(prop(call, "DTSTART"), ((), "20250401T183000"))
        self.assertEqual(prop(call, "DTEND"), ((), "20250401T190000"))
        # Zoned: local time with its TZID, and a VTIMEZONE for it.
        standup = work[f"UID-{cb.EV_STANDUP}@example.com"]
        self.assertEqual(prop(standup, "DTSTART"), (("TZID=Asia/Kolkata",), "20250310T100000"))
        self.assertEqual(prop(standup, "DTEND"), (("TZID=Asia/Kolkata",), "20250310T103000"))
        (calendar,) = parse_ics((folder / "Work.ics").read_bytes())
        zones = {prop(c, "TZID")[1]: c for c in calendar["children"] if c["name"] == "VTIMEZONE"}
        self.assertEqual(set(zones), {"Asia/Kolkata", "America/New_York"})
        self.assertEqual([prop(c, "TZOFFSETTO")[1] for c in zones["Asia/Kolkata"]["children"]], ["+0530"])
        ny_parts = {c["name"] for c in zones["America/New_York"]["children"]}
        self.assertEqual(ny_parts, {"STANDARD", "DAYLIGHT"})
        # The holiday's yearly rule, and the date it is.
        fathers = holidays[f"UID-{cb.EV_FATHERS_DAY}@example.com"]
        self.assertEqual(prop(fathers, "DTSTART"), (("VALUE=DATE",), "20220619"))
        self.assertEqual(prop(fathers, "RRULE")[1], "FREQ=YEARLY;COUNT=10;BYDAY=3SU;BYMONTH=6;WKST=SU")
        self.assertEqual(prop(fathers, "TRANSP")[1], "TRANSPARENT")

    def test_a_series_with_a_skipped_and_a_moved_week(self):
        home = self.vevents(Path(self.save()["path"]) / "Home.ics")
        climb = home["UID-CLIMB@example.com"]
        self.assertEqual(prop(climb, "DTSTART"), (("TZID=America/Los_Angeles",), "20250603T190000"))
        self.assertEqual(prop(climb, "RRULE")[1], "FREQ=WEEKLY;UNTIL=20250827T065959Z;BYDAY=TU;WKST=SU")
        self.assertEqual(prop(climb, "EXDATE"), (("TZID=America/Los_Angeles",), "20250701T190000"))
        moved = home["UID-CLIMB@example.com@20250708T190000"]
        self.assertEqual(prop(moved, "RECURRENCE-ID"), (("TZID=America/Los_Angeles",), "20250708T190000"))
        self.assertEqual(prop(moved, "DTSTART"), (("TZID=America/Los_Angeles",), "20250709T190000"))
        self.assertEqual(props(moved, "RRULE"), [])

    def test_text_people_and_alerts(self):
        folder = Path(self.save()["path"])
        work, home = self.vevents(folder / "Work.ics"), self.vevents(folder / "Home.ics")
        qa = work[f"UID-{cb.EV_QA}@example.com"]
        self.assertEqual(prop(qa, "SUMMARY")[1], "Q&A <draft>\\; notes\\, too")
        self.assertEqual(unescape(prop(qa, "SUMMARY")[1]), cb.QA_TITLE)
        self.assertEqual(unescape(prop(qa, "DESCRIPTION")[1]), cb.QA_NOTES)
        self.assertEqual(prop(qa, "URL")[1], cb.QA_URL)
        self.assertEqual(prop(qa, "STATUS")[1], "TENTATIVE")
        (alarm,) = [c for c in qa["children"] if c["name"] == "VALARM"]
        self.assertEqual(prop(alarm, "TRIGGER"), (("VALUE=DATE-TIME",), "20250909T120000Z"))
        standup = work[f"UID-{cb.EV_STANDUP}@example.com"]
        description = unescape(prop(standup, "DESCRIPTION")[1])
        self.assertEqual(description.splitlines(), [
            "Organizer: Pat Okafor <pat@example.com>",
            "Invitees: Pat Okafor <pat@example.com> (accepted), Sam Rivera <sam.rivera@example.com> (tentative), "
            "riley@example.com (declined), Room 4B <room4b@example.com> (accepted)"])
        self.assertEqual(unescape(prop(standup, "LOCATION")[1]), "Room 4B, 1 Example Road, Bengaluru")
        self.assertEqual(prop(standup, "GEO")[1], "12.9716;77.5946")
        (alarm,) = [c for c in standup["children"] if c["name"] == "VALARM"]
        self.assertEqual((prop(alarm, "ACTION")[1], prop(alarm, "TRIGGER")[1]), ("DISPLAY", "-PT15M"))
        dinner = home[f"UID-{cb.EV_DINNER}@example.com"]
        self.assertEqual(prop(dinner, "STATUS")[1], "CANCELLED")
        self.assertEqual(unescape(prop(dinner, "SUMMARY")[1]), cb.FORMULA_TITLE)
        bakery = home[f"UID-{cb.EV_BAKERY}@example.com"]
        self.assertEqual(prop(bakery, "SUMMARY")[1], cb.BAKERY_TITLE)
        self.assertNotIn(f"UID-{cb.EV_HIDDEN}@example.com", home)  # hidden events stay out, as on the screen

    def test_saving_again_never_overwrites(self):
        first = self.save()
        second = self.save()
        self.assertEqual(Path(second["path"]).name, "Test iPhone Calendar (2)")
        self.assertEqual(sorted(p.name for p in Path(first["path"]).iterdir()),
                         sorted(p.name for p in Path(second["path"]).iterdir()))


class TestOneCalendar(IcsCase):

    def test_one_file(self):
        s = self.scenario
        for asked in (cb.CAL_HOME, str(cb.CAL_HOME)):
            out = self.tmp / f"one-{asked!r}"
            out.mkdir()
            result = self.save(out=out, calendar_id=asked)
            path = out / "Home.ics"
            self.assertEqual(result, {"status": "success", "count": len(s.events_of(cb.CAL_HOME)), "calendars": 1,
                                      "path": str(path), "files": [str(path)]})
            self.assertEqual(len(self.vevents(path)), len(s.events_of(cb.CAL_HOME)))
        self.assertEqual(Path(self.save(out=out, calendar_id=cb.CAL_HOME)["path"]).name, "Home (2).ics")

    def test_a_calendar_without_events_or_not_there(self):
        out = self.tmp / "never"
        self.assertEqual(self.save(out=out, calendar_id=cb.CAL_DEFAULT),
                         {"error": "There are no events in this calendar to save.", "empty_reason": "no_records"})
        for unknown in (999, cb.CAL_INBOX, "abc", True, "9" * 5000, -1, 2 ** 63, 1.0):
            for fmt in ("ics", "csv"):
                self.assertEqual(self.save(fmt, out=out, calendar_id=unknown),
                                 {"error": "That calendar isn't in this backup."}, unknown)
        self.assertFalse(out.exists())

    def test_one_calendar_as_a_spreadsheet(self):
        result = self.save("csv", calendar_id=cb.CAL_WORK)
        self.assertEqual(Path(result["path"]).name, "Work.csv")
        rows = read_csv(Path(result["path"]))
        self.assertEqual(len(rows) - 1, len(self.scenario.events_of(cb.CAL_WORK)))
        self.assertEqual({r[0] for r in rows[1:]}, {"Work"})

    def test_every_calendar_as_a_spreadsheet(self):
        s = self.scenario
        result = self.save("csv")
        path = self.out / "Calendar.csv"
        self.assertEqual(result, {"status": "success", "count": len(s.events), "calendars": 3, "path": str(path),
                                  "files": [str(path)]})
        rows = read_csv(path)
        self.assertEqual(rows[0], HEADER)
        self.assertEqual(len(rows) - 1, len(s.events))
        self.assertEqual(Path(self.save("csv")["path"]).name, "Calendar (2).csv")

    def test_unsupported_format_and_a_place_it_cant_be_saved(self):
        out = self.tmp / "never"
        self.assertEqual(self.save("vcs", out=out), {"error": "Unsupported format: vcs"})
        self.assertFalse(out.exists())
        blocker = self.tmp / "a file"
        blocker.write_text("x")
        self.assertTrue(self.save(out=blocker)["error"].startswith("The calendar couldn't be saved there: "))


# ── The CSV, from events in the library's shape ──────────────────────────────

CALENDARS = [
    {"id": 3, "title": "Home", "color": "#34AADC", "kind": "normal", "read_only": False, "subscription_url": None,
     "sharing": "not_shared", "owner_email": "sam@example.com", "event_count": 4,
     "account": {"id": 3, "name": "iCloud", "type": "caldav", "disabled": False}},
    {"id": 5, "title": "US Holidays", "color": None, "kind": "holidays", "read_only": True, "subscription_url": None,
     "sharing": None, "owner_email": None, "event_count": 1,
     "account": {"id": 4, "name": "Subscribed Calendars", "type": "subscribed", "disabled": False}},
]


def _event(eid, calendar_id=3, title="Event", **fields):
    base = {"id": eid, "uid": f"u{eid}", "calendar_id": calendar_id, "title": title, "notes": None, "url": None,
            "conference_url": None, "all_day": False, "floating": False, "start": None, "end": None,
            "start_day": None, "end_day": None, "days": None, "wall_start": None, "wall_end": None,
            "time_zone": None, "end_time_zone": None, "status": "none", "availability": "busy", "location": None,
            "recurrence": None, "exceptions": [], "detached_from": None, "organizer": None, "attendees": [],
            "alarms": [], "year_unknown": False, "created_date": None, "modified_date": None}
    base.update(fields)
    return base


EVENTS = [
    # Independence Day, all day: July 4 everywhere.
    _event(1, 5, "Independence Day", all_day=True, floating=True, start_day="2024-07-04", end_day="2024-07-04",
           days=1, availability="free",
           recurrence={"frequency": "yearly", "interval": 1, "count": None, "until": None, "by_day": [],
                       "by_month_day": [], "by_month": [], "by_set_pos": [], "by_year_day": [], "by_week_no": [],
                       "week_start": "SU", "last_start": None}),
    # A trip, three days, ending inclusive on the 8th.
    _event(2, title="Trip", all_day=True, floating=True, start_day="2024-07-06", end_day="2024-07-08", days=3,
           alarms=[{"seconds_before": -32400}]),
    # Floating: 9:00 wherever you are.
    _event(3, title="=HYPERLINK(\"x\")", floating=True, wall_start="2024-07-05T09:00:00",
           wall_end="2024-07-05T09:30:00"),
    # Zoned: 5:48 PM on Jul 5 in California, Jul 6 in UTC and in India.
    _event(4, title="Dinner", start="2024-07-06T00:48:12+00:00", end="2024-07-06T01:48:12+00:00",
           time_zone="America/Los_Angeles", status="cancelled", url=None, conference_url="https://example.com/v",
           location={"title": "Cafe", "address": "2 Main St", "latitude": 37.5, "longitude": -122.25},
           organizer={"name": "Pat", "email": "pat@example.com", "is_me": False},
           attendees=[{"name": "Pat", "email": "pat@example.com", "phone": None, "status": "accepted",
                       "role": "chair", "type": "person", "is_me": False},
                      {"name": None, "email": "sam@example.com", "phone": None, "status": "needs_action",
                       "role": "required", "type": "person", "is_me": True}],
           alarms=[{"seconds_before": 900}, {"seconds_before": 86400}, {"at": "2024-07-05T23:00:00+00:00"}],
           created_date="2024-07-01T16:10:09+00:00", modified_date="2024-07-02T16:10:09+00:00"),
]


class FakeInner:
    def __init__(self, calendars, events):
        self.calendars, self.events = calendars, events

    def list_calendars(self, backup):
        return {"calendars": [dict(c) for c in self.calendars]}

    def list_events(self, backup, calendar_id=None, include_hidden=False, contacts=None):
        found = [dict(e) for e in self.events if calendar_id is None or e["calendar_id"] == calendar_id]
        return {"events": found, "hidden_count": 0} if found else {"events": [], "empty_reason": "no_records",
                                                                   "hidden_count": 0}


class Backup:
    info = {"device_name": "Sam's iPhone"}


class CsvCase(unittest.TestCase):
    ZONE = PDT

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.out = Path(tmp.name)
        self.ext = CalendarExtractor()
        self.ext.local_tz = self.ZONE
        self.ext._inner = FakeInner(CALENDARS, EVENTS)

    def rows(self, **kwargs):
        result = self.ext.export_calendar(Backup(), str(self.out), "csv", **kwargs)
        self.assertEqual(result["status"], "success", result)
        return {r[2]: r for r in read_csv(Path(result["path"]))[1:]}


class TestCsvInCalifornia(CsvCase):

    def test_days_and_wall_clocks_never_move(self):
        rows = self.rows()
        self.assertEqual(rows["Independence Day"][3:7], ["2024-07-04", "2024-07-04", "Yes", ""])
        self.assertEqual(rows["Trip"][3:5], ["2024-07-06", "2024-07-08"])  # the last day, included
        self.assertEqual(rows["'=HYPERLINK(\"x\")"][3:7], ["2024-07-05T09:00:00", "2024-07-05T09:30:00", "No",
                                                            "Floating"])

    def test_instants_in_local_time(self):
        dinner = self.rows()["Dinner"]
        self.assertEqual(dinner[3:7], ["2024-07-05T17:48:12-07:00", "2024-07-05T18:48:12-07:00", "No",
                                       "America/Los_Angeles"])
        self.assertEqual(dinner[20:22], ["2024-07-01T09:10:09-07:00", "2024-07-02T09:10:09-07:00"])

    def test_every_column(self):
        rows = self.rows()
        dinner = rows["Dinner"]
        self.assertEqual(dinner[:3], ["Home", "iCloud", "Dinner"])
        self.assertEqual(dinner[7:13], ["Cafe", "2 Main St", "37.5", "-122.25", "", "https://example.com/v"])
        self.assertEqual(dinner[15:20], ["Cancelled", "Busy", "Pat <pat@example.com>",
                                         "Pat <pat@example.com> (accepted); sam@example.com (needs action)",
                                         "15 minutes before; 1 day before; At Jul 5, 2024, 4:00 PM"])
        holiday = rows["Independence Day"]
        self.assertEqual(holiday[:2], ["US Holidays", "Subscribed Calendars"])
        self.assertEqual((holiday[13], holiday[15], holiday[16]), ("Every year on July 4", "", "Free"))
        self.assertEqual(rows["Trip"][19], "On the day at 9:00 AM")
        self.assertEqual(rows["Trip"][13:15], ["", ""])

    def test_the_rule_as_rrule(self):
        _needs_library()  # the RRULE is the library's recurrence_rrule
        self.assertEqual(self.rows()["Independence Day"][14], "FREQ=YEARLY;WKST=SU")

    def test_one_calendar(self):
        result = self.ext.export_calendar(Backup(), str(self.out), "csv", calendar_id=5)
        self.assertEqual(Path(result["path"]).name, "US Holidays.csv")
        self.assertEqual(result["count"], 1)

    def test_a_birthday_without_its_year(self):
        # Apple keeps such a birthday in 1604: the spreadsheet says the day, not a year it wasn't.
        birthdays = dict(CALENDARS[0], id=7, title="Birthdays", kind="birthdays", event_count=2)
        yearly = _rule("yearly")
        self.ext._inner = FakeInner([birthdays], [
            _event(20, 7, "Jo's Birthday", all_day=True, floating=True, start_day="1604-03-02", end_day="1604-03-02",
                   days=1, recurrence=yearly, year_unknown=True),
            _event(21, 7, "Ann's Birthday", all_day=True, floating=True, start_day="1980-11-30",
                   end_day="1980-11-30", days=1, recurrence=yearly)])
        rows = self.rows()
        self.assertEqual(rows["Jo's Birthday"][3:6] + [rows["Jo's Birthday"][13]],
                         ["March 2", "March 2", "Yes", "Every year on March 2"])
        self.assertEqual(rows["Ann's Birthday"][3:5], ["1980-11-30", "1980-11-30"])  # a known year stays


class TestCsvInIndia(CsvCase):
    ZONE = IST

    def test_only_instants_move(self):
        rows = self.rows()
        self.assertEqual(rows["Independence Day"][3], "2024-07-04")
        self.assertEqual(rows["'=HYPERLINK(\"x\")"][3], "2024-07-05T09:00:00")
        self.assertEqual(rows["Dinner"][3:5], ["2024-07-06T06:18:12+05:30", "2024-07-06T07:18:12+05:30"])


class TestNothingToSave(unittest.TestCase):

    def test_nothing_is_written(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        out = Path(tmp.name) / "out"
        ext = CalendarExtractor()
        ext._inner = FakeInner([dict(CALENDARS[0], event_count=0)], [])
        for fmt in ("ics", "csv"):
            self.assertEqual(ext.export_calendar(Backup(), str(out), fmt),
                             {"error": NOTHING_TO_SAVE, "empty_reason": "no_records"})
        self.assertFalse(out.exists())


@unittest.skipUnless(hasattr(time, "tzset"), "time.tzset is POSIX-only")
class TestComputersTimeZone(unittest.TestCase):

    def setUp(self):
        patcher = mock.patch.dict(os.environ, {"TZ": "America/Los_Angeles"})
        patcher.start()
        self.addCleanup(time.tzset)
        self.addCleanup(patcher.stop)
        time.tzset()

    def test_the_computers_zone_by_default(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        ext = CalendarExtractor()
        self.assertIsNone(ext.local_tz)
        ext._inner = FakeInner(CALENDARS, EVENTS)
        result = ext.export_calendar(Backup(), tmp.name, "csv")
        rows = {r[2]: r for r in read_csv(Path(result["path"]))[1:]}
        self.assertEqual(rows["Dinner"][3], "2024-07-05T17:48:12-07:00")
        self.assertEqual(rows["Independence Day"][3], "2024-07-04")


# ── The rule in words ────────────────────────────────────────────────────────

def _rule(frequency, **parts):
    rule = {"frequency": frequency, "interval": 1, "count": None, "until": None, "by_day": [], "by_month_day": [],
            "by_month": [], "by_set_pos": [], "by_year_day": [], "by_week_no": [], "week_start": "SU",
            "last_start": None}
    rule.update(parts)
    return rule


class TestRepeatsText(unittest.TestCase):

    def say(self, rule, tz=None, **event):
        return repeats_text(_event(1, recurrence=rule, **event), tz)

    def test_the_examples(self):
        self.assertEqual(self.say(_rule("yearly", by_day=["3SU"], by_month=[6])),
                         "Every year on the third Sunday of June")
        self.assertEqual(self.say(_rule("weekly", by_day=["TU"], until="2026-06-30"), all_day=True,
                                  start_day="2026-01-06"), "Every week on Tuesday, until Jun 30, 2026")
        self.assertEqual(self.say(_rule("weekly", interval=2, by_day=["WE", "MO"], count=10)),
                         "Every 2 weeks on Monday and Wednesday, 10 times")
        self.assertEqual(self.say(_rule("daily")), "Every day")

    def test_more_rules(self):
        self.assertEqual(self.say(_rule("weekly", by_day=["MO", "TU", "WE", "TH", "FR"])), "Every week on weekdays")
        self.assertEqual(self.say(_rule("weekly", by_day=["SU", "SA"])), "Every week on weekends")
        self.assertEqual(self.say(_rule("monthly", by_day=["-1MO"])), "Every month on the last Monday")
        self.assertEqual(self.say(_rule("monthly", by_month_day=[1, 15])), "Every month on the 1st and 15th")
        self.assertEqual(self.say(_rule("monthly", by_month_day=[-1], count=1)), "Every month on the last day, once")
        self.assertEqual(self.say(_rule("yearly", by_month=[6], by_month_day=[19])), "Every year on June 19")
        self.assertEqual(self.say(_rule("yearly", interval=4, by_month=[11], by_day=["1TU"])),
                         "Every 4 years on the first Tuesday of November")
        self.assertEqual(self.say(_rule("monthly", by_day=["MO", "TU"], by_set_pos=[-1])),
                         "Every month on a custom schedule")
        self.assertIsNone(repeats_text(_event(1)))

    def test_parts_the_words_would_leave_out_are_a_custom_schedule(self):
        # Valid RFC 5545 rules (a CalDAV client can make them) whose words, without these parts, would be
        # wrong: Thunderbird's "every weekday" isn't "Every day", Friday the 13th isn't every Friday.
        for rule, said in (
                (_rule("daily", by_day=["MO", "TU", "WE", "TH", "FR"]), "Every day on a custom schedule"),
                (_rule("daily", by_month_day=[1]), "Every day on a custom schedule"),
                (_rule("daily", by_month=[12], count=5), "Every day on a custom schedule, 5 times"),
                (_rule("weekly", by_day=["SA"], by_month=[6, 7, 8]), "Every week on a custom schedule"),
                (_rule("monthly", by_day=["FR"], by_month_day=[13]), "Every month on a custom schedule"),
                (_rule("monthly", by_month=[1, 7], by_month_day=[1]), "Every month on a custom schedule"),
                (_rule("yearly", by_day=["FR"], by_month_day=[13], by_month=[3]), "Every year on a custom schedule")):
            self.assertEqual(self.say(rule, all_day=True, start_day="2026-03-13"), said, rule)
        # What is said in full stays as it was.
        self.assertEqual(self.say(_rule("weekly", by_day=["MO", "TU", "WE", "TH", "FR"])), "Every week on weekdays")
        self.assertEqual(self.say(_rule("yearly", by_month=[6], by_month_day=[19])), "Every year on June 19")
        self.assertEqual(self.say(_rule("yearly", by_day=["3SU"], by_month=[6])),
                         "Every year on the third Sunday of June")

    def test_a_rule_without_a_day_says_its_starts(self):
        # Floating and all-day starts as they are; an instant on the event's own zone's day.
        self.assertEqual(self.say(_rule("weekly"), floating=True, wall_start="2025-06-03T19:00:00"),
                         "Every week on Tuesday")
        self.assertEqual(self.say(_rule("yearly"), all_day=True, start_day="2024-07-04"), "Every year on July 4")
        self.assertEqual(self.say(_rule("monthly"), all_day=True, start_day="2024-07-08"), "Every month on the 8th")
        # 02:00 UTC on Wednesday is Tuesday evening in Los Angeles.
        self.assertEqual(self.say(_rule("weekly", until="2025-08-27T06:59:59+00:00"), IST,
                                  start="2025-06-04T02:00:00+00:00", time_zone="America/Los_Angeles"),
                         "Every week on Tuesday, until Aug 26, 2025")
        # An unknown zone: the day in the zone the engine was given.
        self.assertEqual(self.say(_rule("weekly"), IST, start="2025-06-04T02:00:00+00:00", time_zone="GMT+0400"),
                         "Every week on Wednesday")


if __name__ == "__main__":
    unittest.main()
