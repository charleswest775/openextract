<!-- Calendar extraction: the ios-backup-core extractor (CalendarExtractor, extractors/calendar_events.py, with events_to_ics) and the app section built on it. Written 2026-11-20 from the design notes, the public Hickman backups and the iOS 26.5 Simulator's Calendar schema. -->

# Calendar extraction

OpenExtract reads the Calendar app's events in a backup: every calendar and the account it belongs to, and each event's time, place, notes, links, invitees and their answers, alerts and how it repeats. The reading is done by `CalendarExtractor` in ios-backup-core (`src/ios_backup_core/extractors/calendar_events.py`), which also writes iCalendar files (`events_to_ics`). The app adds a Calendar section with Upcoming and Past, calendar-file and CSV saves, and counts on the home page.

## Where the database lives

One SQLite file, found through the manifest (`%Calendar.sqlitedb`, preferring the exact path):

- Domain `HomeDomain`
- Path `Library/Calendar/Calendar.sqlitedb`

| iOS | Where | How we know |
|---|---|---|
| 13.3.1, 13.4.1, 15.3.1, 16.1.2, 17.3 | as above | Public Hickman backups in the corpus |
| 18 to 25 | assumed as above | Unverified: no public backup yet |
| 26.5 | as above, same core columns | The iOS 26.5 Simulator's schema (harvested by backupgen) |
| 3 to 12 | as above, older layout | Not checked. A database without the `CalendarItem` and `Calendar` tables is reported as a format OpenExtract can't read yet, never as "no events" |

The database is in WAL mode; no backup checked had a `-wal` file. `Extras.db` beside it (alarm state) and the per-account `AuxDatabase` databases of iOS 16+ (0 rows in the corpus) aren't read.

## What is read

Every column is checked first, and a missing one reads as `None`.

`Store`, the accounts: `type` 0 local ("On My iPhone"), 1 Exchange, 2 CalDAV (iCloud, and also Gmail and others: the name tells them apart), 3 MobileMe, 4 subscribed, 5 the iPhone's own store for Birthdays and Found in Mail. `name` is what the screen heads each account's calendars with.

`Calendar`, one row per calendar, leaving out CalDAV inbox, outbox and notification collections and lists that hold only reminders:

| Column | Field |
|---|---|
| `ROWID`, `title`, `color` | `id`, `title`, `color` (`#RRGGBB`) |
| `store_id` → `Store` | `account` (`id`, `name`, `type`, `disabled`) |
| `external_id = '__HolidayCalendar__'`; `_SqliteDatabaseProperties` BirthdayCalendarID, SuggestionsCalendarID…; `Store.type = 4` | `kind`: `holidays`, `birthdays`, `suggestions` (Found in Mail), `subscribed`, else `normal` |
| `flags & 1` | `read_only` (inferred from the data: every read-only calendar in the corpus has it) |
| `sharing_status`, `self_identity_email`, `subcal_url` | `sharing` (codes unconfirmed), `owner_email`, `subscription_url` |
| events listed for it | `event_count` |

`CalendarItem`, the events (`entity_type = 2`; masters marked `phantom_master` are left out, and hidden or junk events are left out and counted as `hidden_count`):

| Column | Field |
|---|---|
| `ROWID`, `unique_identifier`, `calendar_id` | `id`, `uid`, `calendar_id` |
| `summary`, `description`, `url`, `conference_url` | `title`, `notes`, `url`, `conference_url` |
| `start_date`, `end_date`, `start_tz`, `end_tz`, `all_day` | the dates (below) |
| `status` | `none`, `confirmed`, `tentative`, `cancelled` |
| `availability` | `busy`, `free`, `tentative`, `unavailable` |
| `location_id` → `Location` | `location` (`title`, `address`, `latitude`, `longitude`) |
| `Recurrence` (`frequency`, `interval`, `count`, `end_date`, `specifier`, `week_start`, `cached_end_date`) | `recurrence`, as iCalendar parts (`by_day: ["3SU"]` and so on) |
| `ExceptionDate` | `exceptions`, dates left out of a series |
| `orig_item_id`, `orig_date` | `detached_from`: one date of a series that was changed |
| `Participant` + `Identity` (`entity_type` 8 organizer, 7 invitees) | `organizer`, `attendees` (name, email, answer, role, `is_me`) |
| `Alarm` (not the `default_alarm` rows iOS 16+ adds to every event) | `alarms`: seconds before the start, or a set time |

The engine adds `repeats`, how a series repeats in words ("Every year on the third Sunday of June", "Every week on Tuesday, until Jun 30, 2026").

## Dates, and why nothing may shift a day

Dates are Apple seconds since 2001-01-01, read by a converter of the Calendar's own: 0 is a real date, and NSDate's distant past and future read as no date. Each event's dates are one of three kinds, and a field never mixes them:

- **All day.** iOS stores the day's start as midnight UTC with `start_tz = '_float'`, and the end 86,399 seconds after the last day starts (137 of 144 events on Hickman 17.3 are like this). They come back as days: `start_day`, `end_day` (the last day, inclusive) and `days`. A July 4 holiday is July 4 on every computer: the app reads `"2026-07-04"` as a local day, never as UTC midnight (which is July 3 west of Greenwich), and saves write the day as it is.
- **Floating** (timed, `_float`, no time zone): the wall-clock time is stored as if it were UTC. It comes back as `wall_start`/`wall_end` without an offset, and 9:00 is 9:00 wherever the computer is. No corpus backup has one.
- **In a time zone** (timed, an IANA name such as `America/New_York`, the kind Hickman's 7 timed events are): `start`/`end` are UTC instants, `time_zone` keeps the name. The app shows them on this computer's clock and, when the event was set in another zone, gives its time there too. An odd zone name falls back to UTC with the name kept.

Exceptions, and a series' `until` and `last_start`, are the same kind of date as the event's start. A changed date's original start (`detached_from.original_start`) is the same kind as its series' start, which differs from the changed date's own kind when that one date was switched between timed and all day (not seen in real data). The app reads it by its own shape: ten characters a day, ending in `Z` or an offset an instant, else a wall-clock time.

## The app

Engine (`python/calendar_events.py`, over the library class; the import is guarded, so with a library that lacks the extractor Calendar reads as not in the backup):

- `list_calendars {udid}` and `list_calendar_events {udid, calendar_id?, include_hidden?}` return the library's result (events with the people named from the address book, and `repeats`). Empty results carry `empty_reason`: `not_in_backup` or `no_records`; an older layout is `unsupported_format` with an `error`; a database that is listed but can't be read is an `error` with no `empty_reason`.
- `export_calendar {udid, output_dir, format, calendar_id?}` starts with `export_`, so Electron gives it the long time limit. It never overwrites.
  - `ics`: a folder named after the iPhone with one `<calendar>.ics` per calendar that has events, or, with `calendar_id`, that calendar's file alone. RFC 5545 by hand: all-day events as `VALUE=DATE` with the exclusive end iCalendar wants, floating times without `Z` or `TZID`, zoned times with `TZID` and a `VTIMEZONE` for each zone, series as `RRULE` with `EXDATE`, a changed date as `RECURRENCE-ID`, alerts as `VALARM`. Invitees are written into the description, not as `ATTENDEE` lines, so importing the file doesn't turn every event into a meeting invitation.
  - `csv`: one `Calendar.csv` (or `<calendar>.csv`): Calendar, Account, Title, Start, End, All Day, Time Zone, Location, Address, Latitude, Longitude, Notes, URL, Repeats, RRULE, Status, Availability, Organizer, Invitees, Alerts, Created, Modified. All-day days and floating times are written as they are; zoned times in local time with their offset.
  - Nothing to save is `{error, empty_reason}`; an unknown `calendar_id` is "That calendar isn't in this backup."
- `get_backup_stats` overview: `total_calendar_events` (events in the person's own calendars), `total_subscribed_events` (holidays, birthdays, Found in Mail and subscriptions), `total_calendars` (the person's own, empty ones too), `total_calendars_with_events` (those of them with at least one event: the home tile's "Events in 2 calendars"), `calendar_status`. `errors` gets a `calendar: ...` line only for a real error.

Screen (`src/components/explore/CalendarExplorer.tsx`, wording and date handling in `src/lib/calendar.ts`): a Calendar tile and section after Voice Memos. The tile counts the person's own events; the section also shows for holidays or subscriptions alone, or when the calendar couldn't be read, and a backup with no events at all lists Calendar under "Not in this backup" ("No events in this iPhone's calendars"). The list starts with All calendars (the person's own), then their calendars by account with each one's colour and count, then, quietly, Other calendars: holidays, birthdays, Found in Mail and subscriptions that have events (iOS makes Birthdays and Found in Mail on every iPhone, and Birthdays is always empty in a backup, so empty ones aren't listed), which are opened one at a time and never mixed into All calendars (holiday subscriptions are most of the events in real backups: 136 of 144 on Hickman 17.3). Upcoming and Past divide at the backup's date (as of the backup, said once); Upcoming opens first when there's anything coming. The agenda goes a day at a time, upcoming forward and past backward, and lists a repeating event once, on the day it started, with how it repeats. Each event opens to its time (and its time where it was set), place, links, organizer and invitees with their answers, alerts (an all-day event's as a time of day, "On the day at 9:00 AM", as in the CSV), notes and calendar. Save writes every calendar from All calendars, or the open one. The feedback area is `calendar`.

## Tests

- Library (ios-backup-core): extractor tests on Calendar databases built from the harvested schemas, covering every date kind, recurrence parsing, people, alerts and the ICS writer; backupgen gives the synthetic Maren persona a calendar (two iCloud calendars, US Holidays, Found in Mail, a weekly series with a skipped and a moved date, a trip, an event in another zone, a floating one, a cancelled one, events after the backup date).
- Engine: `python/tests/calendar_backup.py`, `test_calendar_engine.py`, `test_calendar_export.py` (the ICS parsed back; CSV local times in two fixed zones; all-day days not shifted), and the contract cases and empty states in `test_rpc_contract.py`.
- App: `scripts/calendar.test.mjs` (dates, the split, the agenda, wording; run again in seven time zones), `scripts/calendar-screen.test.mjs` (the screen, also in seven zones), `scripts/save-data.test.mjs` (`saveCalendar`), and the e2e suites `screens`, `exports` and `empty`.
- Corpus (`python/tests/corpus/test_corpus_calendar.py`): on each Hickman item, every event listed once against the raw table (119, 133 and 144 events), the calendars, all-day events keeping their day, timed events as UTC instants, plausible dates (holiday subscriptions run years past the backup), recurring events flagged (26 to 28 per backup, all yearly), and a save round trip.

```bash
OPENEXTRACT_CORPUS_ITEMS=pub-hickman-13.3.1,pub-hickman-13.4.1,pub-hickman-15.3.1,pub-hickman-16.1.2,pub-hickman-17.3 \
  python -m pytest python/tests/corpus -m corpus -k "calendar or invariants"
```

Order to merge: the ios-backup-core change first. CI clones library master, so the app's Calendar tests fail there until the library has the extractor.

## Known gaps

- iOS 18 to 25 are unverified, and iOS 3 to 12 likely have an older layout, reported as one OpenExtract can't read yet.
- The public backups have almost nothing unusual: no Exchange or local events, no floating timed events, no multi-day events, no skipped or changed dates, no birthdays, no cancelled events, and invitees on only a few events (2, 3 and 5 on Hickman 15.3.1, 16.1.2 and 17.3, none on 13.x). Those paths are covered by built test databases only. Recurrence frequencies other than yearly come from third-party readers, not from real data.
- A repeating event is listed once, on the day it started; its later dates aren't listed one by one, and a series that began in the past is under Past even when it continues.
- Calendar isn't in the Timeline, search, People, the Year view or the data bundle.
- Attachments, reminders and the per-account `AuxDatabase` databases aren't read.
- `read_only` and the sharing codes are inferred, not confirmed.
