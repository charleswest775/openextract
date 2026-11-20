"""A backup with Calendar in it, for the engine's tests.

Calendar.sqlitedb is built with backupgen's sqlitegen from the table
definitions ios-backup-core harvested (the iOS 26.5 Simulator's, and a real
iOS 13.4.1 backup's, indexes and triggers included), with rows encoded as the
public backups and the library's research show them: Cocoa seconds, ``_float``
for all-day and floating events, all-day events ending at 23:59:59 of their
last day, Participant/Identity rows for people. Every calendar, event and
person is invented, with example.com addresses.

The test calendar holds the cases that matter:

  * calendars of every kind: a local one with no events, Birthdays, two
    iCloud ones, Apple's holiday subscription; and two the app must leave
    out (a CalDAV scheduling inbox and a reminders-only list);
  * a three-day all-day trip (its days must never move: July 4 stays July 4
    west of Greenwich), a floating timed event, a meeting in India's zone,
    one in New York's;
  * a weekly series with a skipped week and one moved occurrence, and a
    yearly holiday on the third Sunday of June;
  * a meeting with an organizer, invitees who answered differently and a
    room, an alert before the start, an alert at a set time, and an all-day
    alert at 9 in the morning;
  * a title starting with ``=`` (a CSV must not let a spreadsheet run it),
    one with ``&``, ``<``, ``;`` and ``,`` and notes with a line break and a
    backslash (an .ics must escape them), a title stored as a BLOB (it must
    come back as text), a cancelled event, and a hidden and a junk event
    (left out unless asked for).

``Scenario`` says what the engine should read back.
"""

from __future__ import annotations

import importlib
import sys
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

HERE = Path(__file__).resolve().parent
if str(HERE) not in sys.path:
    sys.path.insert(0, str(HERE))

import whatsapp_backup as wb  # noqa: E402

DOMAIN = "HomeDomain"
DATABASE = "Calendar.sqlitedb"
LIBRARY = (DOMAIN, f"Library/Calendar/{DATABASE}")
LAYOUTS = {"ios26": "26.5", "ios13": "13.4.1"}

PLAIN_UDID = "00008120-0000000000CA1E0A"
ENCRYPTED_UDID = "00008030-0000000000CA1E0B"
PASSWORD = "test"
DEVICE_NAME = "Calendar test iPhone"
OWNER_EMAIL = "sam.rivera@example.com"

_APPLE_EPOCH = datetime(2001, 1, 1, tzinfo=timezone.utc)
FLOAT = "_float"

# Calendars (ROWID)
CAL_DEFAULT, CAL_BIRTHDAYS, CAL_HOME, CAL_WORK, CAL_HOLIDAYS, CAL_INBOX, CAL_REMINDERS = range(1, 8)
# Events (ROWID)
EV_TRIP, EV_STANDUP, EV_CALL, EV_CLIMB, EV_CLIMB_MOVED, EV_FATHERS_DAY, EV_DINNER, EV_QA, EV_HIDDEN, EV_BAKERY, \
    EV_JUNK = range(1, 12)
# Participants (ROWID)
P_ORGANIZER, P_PAT, P_ME, P_RILEY, P_ROOM = range(1, 6)

TRIP_TITLE = "Coast trip"
STANDUP_TITLE = "Standup, Bengaluru"
FORMULA_TITLE = "=SUM(1) dinner"
QA_TITLE = "Q&A <draft>; notes, too"
QA_NOTES = "Line one\nback\\slash"
QA_URL = "https://example.com/meet?a=1&b=2"
BAKERY_TITLE = "Bakery run"
LA, NY, KOLKATA = "America/Los_Angeles", "America/New_York", "Asia/Kolkata"


def apple(dt: datetime) -> float:
    return (dt - _APPLE_EPOCH).total_seconds()


def utc(year, month, day, hour=0, minute=0, second=0) -> datetime:
    return datetime(year, month, day, hour, minute, second, tzinfo=timezone.utc)


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


@dataclass
class Scenario:
    layout: str
    calendars: dict = field(default_factory=dict)   # id -> what list_calendars returns for it (a subset)
    events: dict = field(default_factory=dict)      # id -> what list_events returns for it (a subset)
    hidden: set = field(default_factory=set)        # ids left out unless include_hidden
    files: dict = field(default_factory=dict)       # (domain, relative path) -> bytes

    def events_of(self, calendar_id: int) -> set:
        return {i for i, e in self.events.items() if e["calendar_id"] == calendar_id}

    def in_order(self, ids=None) -> list:
        """Ids in the order list_events gives them: by start (a day at its midnight, a wall-clock
        time as it is, an instant in UTC), then id."""
        def key(i):
            e = self.events[i]
            when = e["start_day"] or e["wall_start"] or e["start"]
            moment = datetime.fromisoformat(when if len(when) > 10 else when + "T00:00:00")
            return moment.replace(tzinfo=None), i
        return sorted(self.events if ids is None else ids, key=key)

    @property
    def own(self) -> set:
        """Calendars of the person's own (kind "normal")."""
        return {i for i, c in self.calendars.items() if c["kind"] == "normal"}

    @property
    def own_events(self) -> set:
        return {i for i, e in self.events.items() if self.calendars[e["calendar_id"]]["kind"] == "normal"}


def _date_fields(**given) -> dict:
    out = {"all_day": False, "floating": False, "start": None, "end": None, "start_day": None, "end_day": None,
           "days": None, "wall_start": None, "wall_end": None, "time_zone": None, "end_time_zone": None}
    out.update(given)
    return out


def _populate(layout: str, s: Scenario, db) -> None:
    version = tuple(int(p) for p in db.schema["ios"].split("."))
    stores, calendars, items = db.table("Store"), db.table("Calendar"), db.table("CalendarItem")
    stores.insert({"ROWID": 1, "name": "Default", "type": 0, "flags": 0, "display_order": 0})
    stores.insert({"ROWID": 2, "name": "Other", "type": 5, "flags": 4, "display_order": 1})
    stores.insert({"ROWID": 3, "name": "iCloud", "type": 2, "disabled": 0, "flags": 0, "display_order": 2,
                   "owner_name": "Sam Rivera"})
    stores.insert({"ROWID": 4, "name": "Subscribed Calendars", "type": 4, "disabled": 0, "flags": 0,
                   "display_order": 3})

    def calendar(rowid, store, title, color, kind, order, **extra):
        calendars.insert({"ROWID": rowid, "store_id": store, "title": title, "color": color, "display_order": order,
                          "UUID": f"CAL-{rowid}", "self_identity_id": -1, "owner_identity_id": -1, **extra})

    calendar(CAL_DEFAULT, 1, "Default", None, "normal", 0, flags=0x2)
    calendar(CAL_BIRTHDAYS, 2, "Birthdays", "#8295AF", "birthdays", 0, flags=0x5, supported_entity_types=4)
    calendar(CAL_HOME, 3, "Home", "#34AADCFF", "normal", 1, flags=0x100900, supported_entity_types=4,
             external_id="/1234/calendars/home/", sharing_status=0, self_identity_email=OWNER_EMAIL)
    calendar(CAL_WORK, 3, "Work", "#CC73E1FF", "normal", 2, flags=0x100D00, supported_entity_types=4,
             external_id="/1234/calendars/work/", sharing_status=1, self_identity_email=OWNER_EMAIL)
    calendar(CAL_HOLIDAYS, 4, "US Holidays", "#FF2968", "holidays", 0, flags=0x1009, supported_entity_types=4,
             external_id="__HolidayCalendar__", subcal_url="https://calendars.example.com/holidays/us_en.ics/")
    calendar(CAL_INBOX, 3, "Inbox", None, "normal", -1, flags=0x100022, supported_entity_types=4,
             external_id="/1234/calendars/inbox/")
    calendar(CAL_REMINDERS, 1, "Groceries", "#FF9500", "normal", 3, flags=0, supported_entity_types=8)
    props = db.table("_SqliteDatabaseProperties")
    for key, value in (("BirthdayCalendarID", CAL_BIRTHDAYS), ("NativeStoreID", 2),
                       ("OccurrenceCacheTimeZone", LA)):
        props.insert({"key": key, "value": str(value)})

    account = {1: {"id": 1, "name": "Default", "type": "local", "disabled": False},
               2: {"id": 2, "name": "Other", "type": "other", "disabled": False},
               3: {"id": 3, "name": "iCloud", "type": "caldav", "disabled": False},
               4: {"id": 4, "name": "Subscribed Calendars", "type": "subscribed", "disabled": False}}
    has_subcal = calendars.has("subcal_url")
    s.calendars = {
        CAL_DEFAULT: {"title": "Default", "color": None, "kind": "normal", "account": account[1], "read_only": False},
        CAL_BIRTHDAYS: {"title": "Birthdays", "color": "#8295AF", "kind": "birthdays", "account": account[2],
                        "read_only": True},
        CAL_HOME: {"title": "Home", "color": "#34AADC", "kind": "normal", "account": account[3], "read_only": False,
                   "sharing": "not_shared", "owner_email": OWNER_EMAIL},
        CAL_WORK: {"title": "Work", "color": "#CC73E1", "kind": "normal", "account": account[3], "read_only": False,
                   "sharing": "shared_by_me", "owner_email": OWNER_EMAIL},
        CAL_HOLIDAYS: {"title": "US Holidays", "color": "#FF2968", "kind": "holidays", "account": account[4],
                       "read_only": True,
                       "subscription_url": "https://calendars.example.com/holidays/us_en.ics/" if has_subcal else None},
    }

    identities = db.table("Identity")
    ident = {}
    for key, name, email in (("organizer", "Pat Okafor", "pat@example.com"), ("pat", "Pat Okafor", "pat@example.com"),
                             ("me", "Sam Rivera", OWNER_EMAIL), ("riley", None, "riley@example.com"),
                             ("room", "Room 4B", "room4b@example.com")):
        if (name, email) not in ident:
            ident[(name, email)] = identities.insert({"display_name": name, "address": f"mailto:{email}"})
        ident[key] = ident[(name, email)]
    participants = db.table("Participant")
    # (rowid, entity type, type, status, role, identity, email)
    for rowid, entity, kind, status, role, who, email in (
            (P_ORGANIZER, 8, 0, 0, 0, "organizer", "pat@example.com"),
            (P_PAT, 7, 1, 1, 3, "pat", "pat@example.com"),
            (P_ME, 7, 1, 3, 1, "me", OWNER_EMAIL),
            (P_RILEY, 7, 1, 2, 2, "riley", "riley@example.com"),
            (P_ROOM, 7, 2, 1, 4, "room", "room4b@example.com")):
        participants.insert({"ROWID": rowid, "entity_type": entity, "type": kind, "status": status,
                             "pending_status": status, "role": role, "identity_id": ident[who],
                             "owner_id": EV_STANDUP, "UUID": f"P-{rowid}", "email": email, "is_self": 0})

    db.table("Location").insert({"ROWID": 1, "title": "Room 4B", "address": "1 Example Road, Bengaluru",
                                 "latitude": 12.9716, "longitude": 77.5946, "item_owner_id": EV_STANDUP})
    db.table("Location").insert({"ROWID": 2, "title": "Climbing Gym", "address": None, "latitude": 0.0,
                                 "longitude": 0.0, "item_owner_id": EV_CLIMB})

    alarms = db.table("Alarm")
    alarm_rows = [(EV_STANDUP, -900, None), (EV_TRIP, 32400, None), (EV_QA, None, apple(utc(2025, 9, 9, 12)))]
    for n, (owner, interval, at) in enumerate(alarm_rows, start=1):
        alarms.insert({"ROWID": n, "trigger_interval": interval, "trigger_date": at, "type": 0,
                       "calendaritem_owner_id": owner, "calendar_owner_id": -1, "default_alarm": 0,
                       "UUID": f"A-{n}"})
    if version >= (16,):  # iOS 16 on: every event has a placeholder for its calendar's default alert
        for owner in range(EV_TRIP, EV_JUNK + 1):
            alarms.insert({"trigger_interval": None, "type": 0, "calendaritem_owner_id": owner,
                           "calendar_owner_id": -1, "default_alarm": 1, "UUID": f"D-{owner}"})

    # Weekly climbing, Tuesdays 7 PM in Los Angeles (PDT, UTC-7), Jun 3 to Aug 26 2025;
    # Jul 1 skipped, Jul 8 moved to Wednesday Jul 9.
    climb_start = utc(2025, 6, 4, 2)
    db.table("Recurrence").insert({"ROWID": 1, "frequency": 2, "interval": 1, "week_start": 7, "count": 0,
                                   "end_date": apple(utc(2025, 8, 27, 6, 59, 59)), "specifier": "D=0TU",
                                   "cached_end_date": apple(utc(2025, 8, 27, 2)), "cached_end_date_tz": LA,
                                   "by_month_months": 0, "owner_id": EV_CLIMB, "UUID": "R-1"})
    db.table("ExceptionDate").insert({"ROWID": 1, "owner_id": EV_CLIMB, "date": apple(utc(2025, 7, 2, 2)),
                                      "sync_order": 0})
    # Father's Day: yearly, the third Sunday of June, ten times from 2022.
    db.table("Recurrence").insert({"ROWID": 2, "frequency": 4, "interval": 1, "week_start": 7, "count": 10,
                                   "end_date": None, "specifier": "D=+3SU;O=6",
                                   "cached_end_date": apple(utc(2031, 6, 15)), "cached_end_date_tz": FLOAT,
                                   "by_month_months": 0, "owner_id": EV_FATHERS_DAY, "UUID": "R-2"})

    created, modified = utc(2025, 1, 2, 3, 4, 5), utc(2025, 1, 3, 4, 5, 6)

    def item(rowid, calendar_id, title, start, start_tz, end, end_tz, all_day=0, **extra):
        items.insert({"ROWID": rowid, "summary": title, "start_date": apple(start), "start_tz": start_tz,
                      "end_date": apple(end), "end_tz": end_tz, "all_day": all_day, "calendar_id": calendar_id,
                      "orig_item_id": 0, "organizer_id": 0, "self_attendee_id": 0, "location_id": 0, "status": 0,
                      "availability": 0, "hidden": 0, "junk_status": 0, "phantom_master": 0, "has_recurrences": 0,
                      "entity_type": 2, "birthday_id": -1, "unique_identifier": f"UID-{rowid}@example.com",
                      "UUID": f"ITEM-{rowid}", "creation_date": apple(created), "last_modified": apple(modified),
                      **extra})

    item(EV_TRIP, CAL_HOME, TRIP_TITLE, utc(2025, 7, 4), FLOAT, utc(2025, 7, 4) + timedelta(days=3, seconds=-1),
         FLOAT, all_day=1)
    item(EV_STANDUP, CAL_WORK, STANDUP_TITLE, utc(2025, 3, 10, 4, 30), KOLKATA, utc(2025, 3, 10, 5), KOLKATA,
         organizer_id=P_ORGANIZER, self_attendee_id=P_ME, location_id=1, has_attendees=1)
    item(EV_CALL, CAL_HOME, "Call grandma", utc(2025, 4, 1, 18, 30), FLOAT, utc(2025, 4, 1, 19), FLOAT)
    item(EV_CLIMB, CAL_HOME, "Climbing", climb_start, LA, climb_start + timedelta(hours=2), LA, has_recurrences=1,
         location_id=2, unique_identifier="UID-CLIMB@example.com")
    item(EV_CLIMB_MOVED, CAL_HOME, "Climbing", utc(2025, 7, 10, 2), LA, utc(2025, 7, 10, 4), LA,
         orig_item_id=EV_CLIMB, orig_date=apple(utc(2025, 7, 9, 2)), unique_identifier="UID-CLIMB@example.com")
    item(EV_FATHERS_DAY, CAL_HOLIDAYS, "Father's Day", utc(2022, 6, 19), FLOAT, utc(2022, 6, 19, 23, 59, 59), FLOAT,
         all_day=1, has_recurrences=1, availability=1, creation_date=None)
    item(EV_DINNER, CAL_HOME, FORMULA_TITLE, utc(2025, 8, 1, 2), LA, utc(2025, 8, 1, 4), LA, status=3)
    item(EV_QA, CAL_WORK, QA_TITLE, utc(2025, 9, 9, 13), NY, utc(2025, 9, 9, 14), NY, status=2, description=QA_NOTES,
         url=QA_URL)
    item(EV_HIDDEN, CAL_HOME, "Hidden thing", utc(2025, 5, 5, 17), LA, utc(2025, 5, 5, 18), LA, hidden=1)
    item(EV_BAKERY, CAL_HOME, BAKERY_TITLE.encode("utf-8"), utc(2025, 5, 2), FLOAT,
         utc(2025, 5, 2, 23, 59, 59), FLOAT, all_day=1)
    item(EV_JUNK, CAL_WORK, "Win a prize", utc(2025, 5, 6, 17), NY, utc(2025, 5, 6, 18), NY, junk_status=1)

    s.hidden = {EV_HIDDEN, EV_JUNK}
    common = {"notes": None, "url": None, "status": "none", "availability": "busy", "recurrence": None,
              "exceptions": [], "detached_from": None, "organizer": None, "attendees": [], "alarms": [],
              "created_date": iso(created), "modified_date": iso(modified), "location": None}
    s.events = {
        EV_TRIP: {**common, "calendar_id": CAL_HOME, "title": TRIP_TITLE,
                  **_date_fields(all_day=True, floating=True, start_day="2025-07-04", end_day="2025-07-06", days=3),
                  "alarms": [{"seconds_before": -32400}]},
        EV_STANDUP: {**common, "calendar_id": CAL_WORK, "title": STANDUP_TITLE,
                     **_date_fields(start=iso(utc(2025, 3, 10, 4, 30)), end=iso(utc(2025, 3, 10, 5)),
                                    time_zone=KOLKATA),
                     "location": {"title": "Room 4B", "address": "1 Example Road, Bengaluru", "latitude": 12.9716,
                                  "longitude": 77.5946},
                     "organizer": {"name": "Pat Okafor", "email": "pat@example.com", "is_me": False},
                     "attendees": [
                         {"name": "Pat Okafor", "email": "pat@example.com", "phone": None, "status": "accepted",
                          "role": "chair", "type": "person", "is_me": False},
                         {"name": "Sam Rivera", "email": OWNER_EMAIL, "phone": None, "status": "tentative",
                          "role": "required", "type": "person", "is_me": True},
                         {"name": None, "email": "riley@example.com", "phone": None, "status": "declined",
                          "role": "optional", "type": "person", "is_me": False},
                         {"name": "Room 4B", "email": "room4b@example.com", "phone": None, "status": "accepted",
                          "role": "non_participant", "type": "room", "is_me": False}],
                     "alarms": [{"seconds_before": 900}]},
        EV_CALL: {**common, "calendar_id": CAL_HOME, "title": "Call grandma",
                  **_date_fields(floating=True, wall_start="2025-04-01T18:30:00", wall_end="2025-04-01T19:00:00")},
        EV_CLIMB: {**common, "calendar_id": CAL_HOME, "title": "Climbing",
                   **_date_fields(start=iso(climb_start), end=iso(climb_start + timedelta(hours=2)), time_zone=LA),
                   "location": {"title": "Climbing Gym", "address": None, "latitude": None, "longitude": None},
                   "recurrence": {"frequency": "weekly", "interval": 1, "count": None,
                                  "until": iso(utc(2025, 8, 27, 6, 59, 59)), "by_day": ["TU"], "by_month_day": [],
                                  "by_month": [], "by_set_pos": [], "by_year_day": [], "by_week_no": [],
                                  "week_start": "SU", "last_start": iso(utc(2025, 8, 27, 2))},
                   "exceptions": [iso(utc(2025, 7, 2, 2))]},
        EV_CLIMB_MOVED: {**common, "calendar_id": CAL_HOME, "title": "Climbing",
                         **_date_fields(start=iso(utc(2025, 7, 10, 2)), end=iso(utc(2025, 7, 10, 4)), time_zone=LA),
                         "detached_from": {"event_id": EV_CLIMB, "original_start": iso(utc(2025, 7, 9, 2))}},
        EV_FATHERS_DAY: {**common, "calendar_id": CAL_HOLIDAYS, "title": "Father's Day",
                         **_date_fields(all_day=True, floating=True, start_day="2022-06-19", end_day="2022-06-19",
                                        days=1),
                         "availability": "free", "created_date": None,
                         "recurrence": {"frequency": "yearly", "interval": 1, "count": 10, "until": None,
                                        "by_day": ["3SU"], "by_month_day": [], "by_month": [6], "by_set_pos": [],
                                        "by_year_day": [], "by_week_no": [], "week_start": "SU",
                                        "last_start": "2031-06-15"}},
        EV_DINNER: {**common, "calendar_id": CAL_HOME, "title": FORMULA_TITLE, "status": "cancelled",
                    **_date_fields(start=iso(utc(2025, 8, 1, 2)), end=iso(utc(2025, 8, 1, 4)), time_zone=LA)},
        EV_QA: {**common, "calendar_id": CAL_WORK, "title": QA_TITLE, "status": "tentative", "notes": QA_NOTES,
                "url": QA_URL,
                **_date_fields(start=iso(utc(2025, 9, 9, 13)), end=iso(utc(2025, 9, 9, 14)), time_zone=NY),
                "alarms": [{"at": iso(utc(2025, 9, 9, 12))}]},
        EV_BAKERY: {**common, "calendar_id": CAL_HOME, "title": BAKERY_TITLE,
                    **_date_fields(all_day=True, floating=True, start_day="2025-05-02", end_day="2025-05-02",
                                   days=1)},
    }
    for cid, cal in s.calendars.items():
        cal["event_count"] = len(s.events_of(cid))


def build(workdir: Path, layout: str = "ios26") -> Scenario:
    """The test calendar in ``workdir``; the Scenario holds its file and what should be read back."""
    _, sqlitegen = wb._backupgen()
    s = Scenario(layout=layout)
    workdir = Path(workdir)
    workdir.mkdir(parents=True, exist_ok=True)
    data = sqlitegen.build(workdir / f"{DATABASE}-{layout}", LAYOUTS[layout], DATABASE,
                           lambda db: _populate(layout, s, db))
    s.files = {LIBRARY: data}
    return s


def empty_library(workdir: Path, layout: str = "ios26") -> bytes:
    """Calendar.sqlitedb with its tables but no calendars or events."""
    _, sqlitegen = wb._backupgen()
    Path(workdir).mkdir(parents=True, exist_ok=True)
    return sqlitegen.build(Path(workdir) / f"{DATABASE}-empty-{layout}", LAYOUTS[layout], DATABASE, lambda db: None)


def old_layout_library(workdir: Path) -> bytes:
    """A database in iOS 4's layout (an Event table, no CalendarItem), which isn't read yet."""
    import sqlite3

    path = Path(workdir) / "Calendar-old.sqlitedb"
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path)
    try:
        conn.execute("CREATE TABLE Event (ROWID INTEGER PRIMARY KEY, summary TEXT, start_date INTEGER, "
                     "end_date INTEGER, calendar_id INTEGER)")
        conn.execute("CREATE TABLE Calendar (ROWID INTEGER PRIMARY KEY, title TEXT)")
        conn.execute("INSERT INTO Event VALUES (1, 'An old event', 300000000, 300003600, 1)")
        conn.commit()
    finally:
        conn.close()
    return path.read_bytes()


def library_problem() -> Optional[str]:
    """Why the Calendar tests can't build or read a calendar here, or None when they can."""
    try:
        module = importlib.import_module("ios_backup_core.extractors.calendar_events")
    except ImportError:
        module = None
    if module is None or not all(hasattr(module, n) for n in ("CalendarExtractor", "events_to_ics", "recurrence_rrule")):
        return "this ios-backup-core has no Calendar extractor; set PYTHONPATH to a checkout that has it"
    root = wb.backupgen_root()
    if root is None:
        return "ios-backup-core's backupgen wasn't found; set OPENEXTRACT_IOS_BACKUP_CORE"
    for schema in LAYOUTS.values():
        if not (root / "backupgen" / "schemas" / f"ios-{schema}" / f"{DATABASE}.json").is_file():
            return f"the ios-backup-core checkout at {root} has no harvested {DATABASE} schema for iOS {schema}"
    return None


# ── Backups ──────────────────────────────────────────────────────────────────

def make_minimal(dest: Path, files: dict, udid: str = PLAIN_UDID) -> Path:
    """A bare plain backup holding only ``files`` ((domain, relative path) -> bytes)."""
    return wb.make_minimal_plain(dest, files, udid)


def make_einstein_copy(source: Path, dest: Path, scenario, udid: str = PLAIN_UDID,
                       device_name: str = DEVICE_NAME) -> Path:
    """A copy of an unencrypted backup (Einstein's) with the scenario's files added, under a new UDID."""
    return wb.make_plain_copy(source, dest, scenario, udid=udid, device_name=device_name)


def make_encrypted(out_parent: Path, scenario, password: str = PASSWORD, udid: str = ENCRYPTED_UDID) -> Path:
    """A new encrypted backup holding only the scenario's files (backupgen's BackupWriter); returns its folder."""
    container, _ = wb._backupgen()
    device = container.Device(name=DEVICE_NAME, product_type="iPhone15,2", product_name="iPhone 14 Pro",
                              ios="26.5", build="23F77", phone_number="+1 202 555 0100", udid=udid)
    writer = container.BackupWriter(Path(out_parent), device, datetime(2025, 7, 20, tzinfo=timezone.utc),
                                    wb.SCHEMA_VERSION, password=password, seed=17)
    for (domain, rel), data in scenario.files.items():
        writer.add_file(domain, rel, data)
    return writer.finalize()
