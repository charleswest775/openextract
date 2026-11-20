/**
 * What the engine's Calendar calls return (python/calendar_events.py, over
 * ios-backup-core's CalendarExtractor, which reads Calendar.sqlitedb).
 *
 * Ids are database row ids: a calendar's `id` is what list_calendar_events and
 * export_calendar take as `calendar_id`.
 *
 * An event's dates come in one of three kinds, and a field never mixes them
 * (so nothing reads "2024-07-04" as UTC midnight and shows July 3):
 * - timed, in a time zone: `start`/`end` are UTC instants ("…+00:00"),
 *   shown on this computer's clock; `time_zone` names the event's zone.
 * - timed, floating (no time zone): `wall_start`/`wall_end` are wall-clock
 *   times without an offset ("2026-03-01T09:00:00"), the same anywhere.
 * - all day: `start_day`/`end_day` are days ("2026-07-04"), with `end_day`
 *   the last day (inclusive) and `days` how many.
 * The others of the three are null.
 */

/** Why a list came back empty, as the engine says it. */
export type CalendarEmptyReason = 'not_in_backup' | 'no_records' | 'unsupported_format';

/** What get_backup_stats says about Calendar, in its overview. */
export type CalendarStatus = 'ok' | 'not_in_backup' | 'no_records' | 'unsupported_format' | 'error';

/** The kind of account a calendar belongs to (Calendar.sqlitedb's Store table). */
export type CalendarAccountType =
  | 'local' | 'exchange' | 'caldav' | 'mobileme' | 'subscribed' | 'other' | 'reminders' | 'unknown';

export interface CalendarAccount {
  id: number;
  /** As the iPhone names it: "iCloud", "Gmail", "Default"… */
  name: string | null;
  type: CalendarAccountType;
  disabled: boolean;
}

/**
 * 'normal' is a calendar of the person's own. The rest come to the iPhone from
 * elsewhere: a holidays calendar, birthdays from Contacts, events Siri found in
 * Mail ('suggestions'), or a calendar subscribed to.
 */
export type CalendarKind = 'normal' | 'holidays' | 'birthdays' | 'suggestions' | 'subscribed';

export type CalendarSharing = 'not_shared' | 'shared_by_me' | 'shared_with_me';

export interface Calendar {
  id: number;
  title: string | null;
  /** "#RRGGBB", or null. */
  color: string | null;
  account: CalendarAccount | null;
  kind: CalendarKind;
  read_only: boolean;
  subscription_url: string | null;
  sharing: CalendarSharing | null;
  owner_email: string | null;
  /** The events list_calendar_events lists for it. */
  event_count: number;
}

export type EventStatus = 'none' | 'confirmed' | 'tentative' | 'cancelled';
export type EventAvailability = 'busy' | 'free' | 'tentative' | 'unavailable';

export interface EventLocation {
  title: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
}

/**
 * How a repeating event repeats. `until` and `last_start` are the same kind
 * of date as the event's start (a day, a wall-clock time or a UTC instant).
 */
export interface EventRecurrence {
  frequency: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  count: number | null;
  until: string | null;
  /** iCalendar BYDAY values: "TU", "3SU", "-1MO". */
  by_day: string[];
  by_month_day: number[];
  by_month: number[];
  by_set_pos: number[];
  by_year_day: number[];
  by_week_no: number[];
  week_start: string | null;
  last_start: string | null;
}

export interface EventOrganizer {
  name: string | null;
  email: string | null;
  is_me: boolean;
}

export type AttendeeStatus =
  | 'needs_action' | 'accepted' | 'declined' | 'tentative' | 'delegated' | 'completed' | 'in_process' | 'unknown';
export type AttendeeRole = 'unknown' | 'required' | 'optional' | 'chair' | 'non_participant';
export type AttendeeType = 'unknown' | 'person' | 'room' | 'resource' | 'group';

export interface EventAttendee {
  name: string | null;
  email: string | null;
  phone: string | null;
  status: AttendeeStatus;
  role: AttendeeRole;
  type: AttendeeType;
  is_me: boolean;
}

/** An alert: so long before the start (negative: after it), or at a set time (UTC). */
export type EventAlarm = { seconds_before: number } | { at: string };

export interface CalendarEvent {
  id: number;
  uid: string | null;
  calendar_id: number;
  title: string | null;
  notes: string | null;
  url: string | null;
  conference_url: string | null;
  all_day: boolean;
  floating: boolean;
  /** Timed events in a time zone: UTC instants. */
  start: string | null;
  end: string | null;
  /** All-day events: the first and last day, YYYY-MM-DD. */
  start_day: string | null;
  end_day: string | null;
  days: number | null;
  /** Floating timed events: wall-clock times, YYYY-MM-DDTHH:MM:SS, no offset. */
  wall_start: string | null;
  wall_end: string | null;
  /** The zone a timed event was set in, as the iPhone named it ("America/New_York"). */
  time_zone: string | null;
  /** The end's zone, only when it differs from the start's. */
  end_time_zone: string | null;
  status: EventStatus;
  availability: EventAvailability | null;
  location: EventLocation | null;
  recurrence: EventRecurrence | null;
  /** Dates left out of a repeating event, the same kind of date as its start. */
  exceptions: string[];
  /**
   * One date of a repeating event that was changed: the series' event and the start this date
   * had, the same kind of date as the series' start (event_id's), which can differ from this
   * date's own kind when it was switched between timed and all day.
   */
  detached_from: { event_id: number; original_start: string | null } | null;
  organizer: EventOrganizer | null;
  attendees: EventAttendee[];
  alarms: EventAlarm[];
  /** A birthday whose year isn't known: show the day without a year. */
  year_unknown: boolean;
  created_date: string | null;
  modified_date: string | null;
  /** How a repeating event repeats, in words, from the engine ("Every week on Tuesday"); null otherwise. */
  repeats?: string | null;
}

export interface CalendarsResult {
  calendars: Calendar[];
  empty_reason?: CalendarEmptyReason;
  error?: string;
}

export interface CalendarEventsResult {
  events: CalendarEvent[];
  /** Events the iPhone hides (junk invitations and the like), left out of `events`. */
  hidden_count?: number;
  empty_reason?: CalendarEmptyReason;
  error?: string;
}

export type CalendarSaveFormat = 'ics' | 'csv';

/** What export_calendar returns when it wrote something. */
export interface CalendarExportResult {
  status: 'success';
  /** Events written. */
  count: number;
  /** Calendar files written, when saving every calendar as .ics. */
  calendars?: number;
  /** The folder of calendar files, or the one file written. */
  path: string;
  files: string[];
}
