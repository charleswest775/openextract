/**
 * The Calendar screen's wording and decisions, kept apart from the component
 * so they can be tested: which calendars are the person's own and how they're
 * grouped, how events split into upcoming and past at the backup's date, the
 * agenda's days and order, what each row and detail says, and what to say when
 * there's nothing to show.
 *
 * Dates. An event's dates are one of three kinds (src/types/calendar.ts), and
 * each is read its own way, so nothing shifts by a day:
 * - All day: `start_day`/`end_day` are days on the wall calendar. They're read
 *   as local days with the Date(y, m, d) constructor, never `new Date('YYYY-MM-DD')`,
 *   which is UTC midnight and the day before west of Greenwich.
 * - Floating: `wall_start`/`wall_end` are wall-clock times, read the same way
 *   (Date(y, m, d, h, min)) to sort and split, and shown from their own parts,
 *   so 9:00 is 9:00 on any computer, even in an hour its clock skips.
 * - In a time zone: `start`/`end` are instants, shown on this computer's clock,
 *   with a note giving the time where the event was set when that differs.
 *
 * The agenda lists each event once, on its first day: a repeating event at its
 * first start (with how it repeats from the engine), a changed date of one
 * (detached_from) as its own row.
 */
import type {
  AttendeeStatus, Calendar, CalendarAccount, CalendarEmptyReason, CalendarEvent, CalendarExportResult,
  CalendarSaveFormat, CalendarStatus, EventAlarm, EventAttendee, EventOrganizer,
} from '../types/calendar';
import { formatDate, formatTime } from './dates';

export { webAddress } from './podcasts';

// "1 event", "3 events". A copy of saveData's plural, so this file needs nothing from the bridge.
function count(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

// ── Calendars ──────────────────────────────────────────────────────────────

/** What a calendar is called, even without a title. */
export function calendarName(cal: Pick<Calendar, 'title'> | null | undefined): string {
  return cal?.title?.trim() || 'Untitled calendar';
}

/** One of the person's own calendars, as opposed to holidays, birthdays, Found in Mail or a subscription. */
export function isOwnCalendar(cal: Pick<Calendar, 'kind'>): boolean {
  return cal.kind === 'normal';
}

/** The colour dot's colour: the calendar's own, or a quiet grey. */
export function calendarColor(cal: Pick<Calendar, 'color'> | null | undefined): string {
  const c = cal?.color?.trim();
  return c && /^#[0-9a-f]{6}$/i.test(c) ? c : 'var(--text-tertiary)';
}

const ACCOUNT_FALLBACK: Record<string, string> = {
  exchange: 'Exchange', caldav: 'CalDAV', mobileme: 'iCloud', subscribed: 'Subscribed', other: 'Other accounts',
  reminders: 'Reminders', unknown: 'Calendars',
};

/** What a group of calendars is headed with: "On My iPhone", "iCloud", the Exchange account's name… */
export function accountLabel(account: CalendarAccount | null | undefined): string {
  if (!account) return 'Calendars';
  if (account.type === 'local') return 'On My iPhone';
  return account.name?.trim() || ACCOUNT_FALLBACK[account.type] || 'Calendars';
}

/** What a calendar that isn't the person's own is. Found in Mail and Found in Natural Language are both Siri's. */
export function otherKindLabel(cal: Pick<Calendar, 'kind'>): string {
  switch (cal.kind) {
    case 'holidays': return 'Holidays';
    case 'birthdays': return 'Birthdays';
    case 'suggestions': return 'Siri Suggestions';
    case 'subscribed': return 'Subscribed';
    default: return '';
  }
}

/** "12 events", "No events" */
export function eventCount(n: number): string {
  return n > 0 ? count(n, 'event') : 'No events';
}

/** "1 event matches", "3 events match": how many events a search found. */
export function matchCount(n: number): string {
  return `${count(n, 'event')} ${n === 1 ? 'matches' : 'match'}`;
}

/** A calendar's line in the list. `n` is how many of its events are shown (fewer while searching). */
export function calendarLine(cal: Calendar, n: number = cal.event_count, searching = false): string {
  const events = searching ? (n > 0 ? matchCount(n) : 'No matches') : eventCount(n);
  const kind = otherKindLabel(cal);
  return kind ? `${kind} · ${events}` : events;
}

/** What a calendar's header says about it: its account, kind, sharing and size. */
export function calendarFacts(cal: Calendar): string[] {
  const facts = [isOwnCalendar(cal) ? accountLabel(cal.account) : otherKindLabel(cal)];
  if (cal.sharing === 'shared_by_me') facts.push('Shared by you');
  if (cal.sharing === 'shared_with_me') facts.push(cal.owner_email ? `Shared with you by ${cal.owner_email}` : 'Shared with you');
  if (cal.read_only && isOwnCalendar(cal) && cal.sharing !== 'shared_with_me') facts.push('Read only');
  facts.push(eventCount(cal.event_count));
  return facts.filter(Boolean);
}

export interface CalendarGroup {
  key: string;
  label: string;
  calendars: Calendar[];
}

export interface CalendarGroups {
  /** The person's own calendars, by account, in the engine's order, empty ones too. */
  mine: CalendarGroup[];
  /**
   * Holidays, birthdays, Found in Mail and subscriptions that have events: opened one at a time,
   * never part of All calendars. Empty ones are left out: iOS makes Birthdays, Found in Mail and
   * the like on every iPhone, and Birthdays is always empty in a backup.
   */
  others: Calendar[];
}

export function groupCalendars(calendars: Calendar[]): CalendarGroups {
  const mine: CalendarGroup[] = [];
  const others: Calendar[] = [];
  for (const cal of calendars) {
    if (!isOwnCalendar(cal)) {
      if (cal.event_count > 0) others.push(cal);
      continue;
    }
    const key = cal.account ? `account:${cal.account.id}` : 'none';
    let group = mine.find(g => g.key === key);
    if (!group) {
      group = { key, label: accountLabel(cal.account), calendars: [] };
      mine.push(group);
    }
    group.calendars.push(cal);
  }
  return { mine, others };
}

// ── Reading an event's dates ───────────────────────────────────────────────

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?/;
const DAY_MS = 86_400_000;

/** A YYYY-MM-DD day as local midnight on that day; null when it isn't one. */
export function parseDay(day: string | null | undefined): Date | null {
  const m = day ? DAY.exec(day) : null;
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // Date(y, m, d) is local, but years 0-99 mean 1900-1999 to it
  d.setFullYear(Number(m[1]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A wall-clock time (YYYY-MM-DDTHH:MM:SS, no offset) at that time on this computer's clock; null when it isn't one. */
export function parseWall(wall: string | null | undefined): Date | null {
  const m = wall ? WALL.exec(wall) : null;
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
  d.setFullYear(Number(m[1]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * A wall-clock time as that time in UTC, to show (formatted in UTC) rather than to sort by:
 * shown through this computer's clock, a time in an hour it skips (2:30 on the morning
 * daylight saving starts) would read an hour later.
 */
function wallFace(wall: string | null | undefined): Date | null {
  const m = wall ? WALL.exec(wall) : null;
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)));
  d.setUTCFullYear(Number(m[1]));
  return Number.isNaN(d.getTime()) ? null : d;
}

function parseInstant(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Which of the three kinds of date an event has, or null when it has no start at all. */
export type DateKind = 'day' | 'wall' | 'instant';

export function dateKind(e: CalendarEvent): DateKind | null {
  if (e.all_day) return e.start_day ? 'day' : null;
  if (e.wall_start) return 'wall';
  return e.start ? 'instant' : null;
}

/**
 * Which kind of date a value is, by its own shape: "2026-03-20" a day, one ending in Z or an
 * offset an instant, else a wall-clock time. For a changed date's original start, which is
 * the kind of its series' start, not always of its own (one date can be made all day).
 */
function kindOfValue(value: string | null | undefined): DateKind | null {
  if (!value) return null;
  if (value.length === 10) return 'day';
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value) ? 'instant' : 'wall';
}

/** A date of the same kind as the event's start (an exception, an until). */
function readAs(kind: DateKind | null, value: string | null | undefined): Date | null {
  if (kind === 'day') return parseDay(value) ?? parseDay(value?.slice(0, 10));
  if (kind === 'wall') return parseWall(value);
  return parseInstant(value);
}

/** When the event starts, as a Date to sort and show by (local midnight for an all-day event). */
export function eventStart(e: CalendarEvent): Date | null {
  const kind = dateKind(e);
  if (kind === 'day') return parseDay(e.start_day);
  if (kind === 'wall') return parseWall(e.wall_start);
  return parseInstant(e.start);
}

/** When the event is over: an all-day event at midnight after its last day. Never before its start. */
export function eventEnd(e: CalendarEvent): Date | null {
  const start = eventStart(e);
  if (!start) return null;
  const kind = dateKind(e);
  let end: Date | null;
  if (kind === 'day') {
    const last = parseDay(e.end_day) ?? start;
    end = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
  } else {
    end = kind === 'wall' ? parseWall(e.wall_end) : parseInstant(e.end);
  }
  return end && end.getTime() > start.getTime() ? end : start;
}

function localDayKey(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(d.getFullYear()).padStart(4, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The day an event is listed under, as YYYY-MM-DD: its own day, its wall-clock day, or this computer's day of its start. */
export function eventDayKey(e: CalendarEvent): string | null {
  const kind = dateKind(e);
  if (kind === 'day') return parseDay(e.start_day) ? e.start_day : null;
  if (kind === 'wall') return parseWall(e.wall_start) ? e.wall_start!.slice(0, 10) : null;
  const start = parseInstant(e.start);
  return start ? localDayKey(start) : null;
}

// ── Upcoming and past ──────────────────────────────────────────────────────

/** Where upcoming and past divide: the backup's date, or now when the backup's date isn't known. */
export interface SplitPoint {
  at: Date;
  fromBackup: boolean;
}

export function splitPoint(lastBackup: string | null | undefined, now: Date = new Date()): SplitPoint {
  const at = parseInstant(lastBackup);
  return at ? { at, fromBackup: true } : { at: now, fromBackup: false };
}

/** Not over yet at the split point: an event in progress then (an all-day event that day too) is upcoming. */
export function isUpcoming(e: CalendarEvent, at: Date): boolean {
  const end = eventEnd(e);
  return !!end && end.getTime() > at.getTime();
}

export type AgendaView = 'upcoming' | 'past';

export function splitEvents(events: CalendarEvent[], at: Date): { upcoming: CalendarEvent[]; past: CalendarEvent[] } {
  const upcoming: CalendarEvent[] = [], past: CalendarEvent[] = [];
  for (const e of events) (isUpcoming(e, at) ? upcoming : past).push(e);
  return { upcoming, past };
}

/** The view a calendar opens on: what's coming when there is anything, else what's past. */
export function defaultView(events: CalendarEvent[], at: Date): AgendaView {
  return events.some(e => isUpcoming(e, at)) ? 'upcoming' : 'past';
}

/** The note under Upcoming / Past: where they divide, and (when it applies) how repeating events are listed. */
export function splitNote(split: SplitPoint, anyRepeating: boolean): string {
  const asOf = split.fromBackup
    ? `Upcoming and past as of the backup on ${formatDate(split.at.toISOString())}.`
    : 'Upcoming and past as of today.';
  return anyRepeating ? `${asOf} A repeating event is listed once, on the day it started.` : asOf;
}

export interface AgendaDay {
  /** YYYY-MM-DD, or 'unknown'. */
  key: string;
  label: string;
  events: CalendarEvent[];
}

const UNKNOWN = 'unknown';

/** "Tuesday, March 3, 2026"; a day with no real year (a birthday) without its weekday or year. */
export function dayLabel(key: string): string {
  const d = parseDay(key);
  if (!d) return 'Date unknown';
  if (d.getFullYear() < 1800) return d.toLocaleDateString(undefined, { month: 'long', day: 'numeric' });
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

function byStart(a: CalendarEvent, b: CalendarEvent): number {
  const ta = eventStart(a)?.getTime(), tb = eventStart(b)?.getTime();
  const ha = ta != null, hb = tb != null;
  if (ha && hb && ta !== tb) return ta! - tb!;
  if (ha !== hb) return ha ? -1 : 1; // no date: last
  // The same moment: all-day first, then by id
  if (a.all_day !== b.all_day) return a.all_day ? -1 : 1;
  return a.id - b.id;
}

/**
 * The agenda's days. Upcoming runs forward from the split; Past runs back from
 * it, newest day first, with each day's events still in the order they happen.
 * Events with no date are last, under "Date unknown".
 */
export function agenda(events: CalendarEvent[], view: AgendaView): AgendaDay[] {
  const days: AgendaDay[] = [];
  const unknown: CalendarEvent[] = [];
  for (const e of [...events].sort(byStart)) {
    const key = eventDayKey(e);
    if (!key) { unknown.push(e); continue; }
    const last = days[days.length - 1];
    if (last && last.key === key) last.events.push(e);
    else days.push({ key, label: dayLabel(key), events: [e] });
  }
  if (view === 'past') days.reverse();
  if (unknown.length) days.push({ key: UNKNOWN, label: 'Date unknown', events: unknown });
  return days;
}

// ── What an event's row and details say ────────────────────────────────────

/** What an event is called, even without a title. */
export function eventName(e: Pick<CalendarEvent, 'title'>): string {
  return e.title?.trim() || 'Untitled event';
}

// The formatting below takes the zone to show a date in: undefined (this computer's) for days
// and instants, 'UTC' for a wall-clock time read with wallFace
const shortDay = (d: Date, withYear: boolean, timeZone?: string) =>
  d.toLocaleDateString(undefined, withYear ? { month: 'short', day: 'numeric', year: 'numeric', timeZone } : { month: 'short', day: 'numeric', timeZone });
const longDay = (d: Date, timeZone?: string) => ((timeZone ? d.getUTCFullYear() : d.getFullYear()) < 1800
  ? d.toLocaleDateString(undefined, { month: 'long', day: 'numeric', timeZone })
  : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone }));
const clockTime = (d: Date, timeZone?: string) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone });

/** "9:00 – 10:00 AM" where the computer's language joins times that way, else "9:00 AM – 10:00 AM". */
function timeRange(a: Date, b: Date, timeZone?: string): string {
  const fmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', timeZone });
  const range = (fmt as unknown as { formatRange?: (x: Date, y: Date) => string }).formatRange;
  if (typeof range === 'function') {
    try { return range.call(fmt, a, b); } catch { /* fall back below */ }
  }
  return `${clockTime(a, timeZone)} – ${clockTime(b, timeZone)}`;
}

const dayKeyIn = (d: Date, timeZone?: string) => (timeZone ? d.toISOString().slice(0, 10) : localDayKey(d));
const sameDay = (a: Date, b: Date, timeZone?: string) => dayKeyIn(a, timeZone) === dayKeyIn(b, timeZone);

/** A timed event's start and end as shown: a floating one's from their own parts (in UTC), never ending before it starts. */
function shownTimes(e: CalendarEvent, kind: 'wall' | 'instant'): { start: Date; end: Date | null; timeZone?: string } {
  if (kind === 'instant') return { start: eventStart(e)!, end: eventEnd(e) };
  const start = wallFace(e.wall_start)!;
  const end = wallFace(e.wall_end);
  return { start, end: end && end.getTime() > start.getTime() ? end : start, timeZone: 'UTC' };
}

/**
 * The time on an event's row: "All day", "Jul 4 – Jul 6" for several days,
 * "9:00 – 10:00 AM", or "Jul 4, 9:00 PM – Jul 5, 1:00 AM" across midnight.
 */
export function timeText(e: CalendarEvent): string {
  const kind = dateKind(e);
  if (!kind) return '';
  if (kind === 'day') {
    const first = parseDay(e.start_day)!;
    const last = parseDay(e.end_day);
    if (!last || last.getTime() <= first.getTime()) return 'All day';
    const years = first.getFullYear() !== last.getFullYear();
    return `${shortDay(first, years)} – ${shortDay(last, years)}`;
  }
  const { start, end, timeZone } = shownTimes(e, kind);
  if (!end || end.getTime() === start.getTime()) return clockTime(start, timeZone);
  if (sameDay(start, end, timeZone)) return timeRange(start, end, timeZone);
  // Ends at midnight: still that one evening
  const justBefore = new Date(end.getTime() - 1);
  const midnight = timeZone ? end.getUTCHours() === 0 && end.getUTCMinutes() === 0 : end.getHours() === 0 && end.getMinutes() === 0;
  if (sameDay(start, justBefore, timeZone) && midnight) return `${clockTime(start, timeZone)} – ${clockTime(end, timeZone)}`;
  return `${shortDay(start, false, timeZone)}, ${clockTime(start, timeZone)} – ${shortDay(end, false, timeZone)}, ${clockTime(end, timeZone)}`;
}

/** The details' When line: "Sat, Jul 4, 2026, all day", "Tue, Mar 3, 2026, 9:00 – 10:00 AM"… */
export function whenText(e: CalendarEvent): string {
  const kind = dateKind(e);
  if (!kind) return 'Date unknown';
  if (kind === 'day') {
    const first = parseDay(e.start_day)!;
    const last = parseDay(e.end_day);
    if (!last || last.getTime() <= first.getTime()) return `${longDay(first)}, all day`;
    const days = e.days ?? Math.round((last.getTime() - first.getTime()) / DAY_MS) + 1;
    return `${longDay(first)} – ${longDay(last)}, all day (${count(days, 'day')})`;
  }
  const { start, end, timeZone } = shownTimes(e, kind);
  if (!end || end.getTime() === start.getTime()) return `${longDay(start, timeZone)}, ${clockTime(start, timeZone)}`;
  if (sameDay(start, end, timeZone)) return `${longDay(start, timeZone)}, ${timeRange(start, end, timeZone)}`;
  return `${longDay(start, timeZone)}, ${clockTime(start, timeZone)} – ${longDay(end, timeZone)}, ${clockTime(end, timeZone)}`;
}

/** Said for a floating event, which happens at the same clock time wherever the iPhone is. */
export const FLOATING_NOTE = "This event has no time zone, so it's at this time wherever you are.";

/** "New York" for America/New_York; the name itself when it isn't Area/City. */
export function zoneCity(zone: string): string {
  const parts = zone.split('/');
  return parts.length > 1 ? parts[parts.length - 1].replace(/_/g, ' ') : zone;
}

function wallIn(d: Date, timeZone?: string): string | null {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(d);
  } catch {
    return null;
  }
}

/**
 * A note about the event's time zone, or null when there's nothing to say:
 * floating events say they have none; an event set in another zone gives its
 * time there, because the row shows it on this computer's clock.
 */
export function zoneNote(e: CalendarEvent): string | null {
  const kind = dateKind(e);
  if (kind === 'wall') return FLOATING_NOTE;
  if (kind !== 'instant' || !e.time_zone || e.time_zone === '_float') return null;
  const start = eventStart(e)!;
  const there = wallIn(start, e.time_zone);
  if (there === null) return `It was set in the time zone "${e.time_zone}".`;
  const here = wallIn(start);
  if (there === here) return null;
  const sameDate = there.slice(0, 10) === here?.slice(0, 10);
  const time = start.toLocaleTimeString(undefined, { timeZone: e.time_zone, hour: 'numeric', minute: '2-digit' });
  const date = start.toLocaleDateString(undefined, { timeZone: e.time_zone, weekday: 'short', month: 'short', day: 'numeric' });
  const at = sameDate ? `at ${time}` : `on ${date} at ${time}`;
  return `Shown on this computer's clock: it starts ${at} ${zoneCity(e.time_zone)} time.`;
}

/** "Repeats every week on Tuesday", from the engine's words; "Repeats" when an older engine sent none. */
export function repeatText(e: Pick<CalendarEvent, 'recurrence' | 'repeats'>): string | null {
  const words = e.repeats?.trim();
  if (words) return `Repeats ${/^[A-Z][a-z]/.test(words) ? words[0].toLowerCase() + words.slice(1) : words}`;
  return e.recurrence ? 'Repeats' : null;
}

/** A date of the same kind as the event's start, said short: "Jun 11, 2026". */
function sayDateAs(e: CalendarEvent, value: string | null | undefined): string {
  const d = readAs(dateKind(e), value);
  return d ? shortDay(d, true) : '';
}

/** "Skipped on Jun 11, 2026 and Jun 18, 2026" for the dates left out of a repeating event. */
export function skippedText(e: CalendarEvent): string | null {
  const days = (e.exceptions ?? []).map(x => sayDateAs(e, x)).filter(Boolean);
  if (days.length === 0) return null;
  const shown = days.slice(0, 5);
  const more = days.length - shown.length;
  const list = more > 0
    ? `${shown.join(', ')} and ${count(more, 'other date')}`
    : shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
  return `Skipped on ${list}`;
}

/**
 * One date of a repeating event that was changed: "Moved from Jun 4, 2026", or changed in some
 * other way. The original start is the kind of the series' start, so it's read by its own shape:
 * a date made all day keeps the time it had, and a day isn't read as UTC midnight.
 */
export function changedText(e: CalendarEvent): string | null {
  if (!e.detached_from) return null;
  const value = e.detached_from.original_start;
  const original = readAs(kindOfValue(value), value);
  const start = eventStart(e);
  if (original && start && localDayKey(original) !== localDayKey(start)) return `Moved from ${shortDay(original, true)}`;
  return 'Changed for this date';
}

/** The chips on a row: cancelled or tentative, how it repeats, and a changed date of a repeating event. */
export function eventChips(e: CalendarEvent): string[] {
  const chips: string[] = [];
  if (e.status === 'cancelled') chips.push('Cancelled');
  else if (e.status === 'tentative') chips.push('Tentative');
  const repeats = repeatText(e);
  if (repeats) chips.push(repeats);
  const changed = changedText(e);
  if (changed) chips.push(changed);
  return chips;
}

/** The place on a row: its name, or its address when it has no name. */
export function placeLine(e: Pick<CalendarEvent, 'location'>): string {
  return e.location?.title?.trim() || e.location?.address?.trim() || '';
}

/** The place in the details: name and address, each once. */
export function placeLines(e: Pick<CalendarEvent, 'location'>): string[] {
  const title = e.location?.title?.trim() || '';
  const address = e.location?.address?.trim() || '';
  if (!title) return address ? [address] : [];
  return address && address !== title && !title.includes(address) ? [title, address] : [title];
}

/** Who someone is: their name, else their email or number. */
export function personName(p: Pick<EventAttendee, 'name' | 'email'> & { phone?: string | null }): string {
  return p.name?.trim() || p.email?.trim() || p.phone?.trim() || 'Someone';
}

/** "Organized by Pat Doe", or "You organized it". */
export function organizerText(o: EventOrganizer | null | undefined): string | null {
  if (!o) return null;
  return o.is_me ? 'You organized it' : `Organized by ${personName(o)}`;
}

/** How someone answered an invitation. */
export function answerText(status: AttendeeStatus): string {
  switch (status) {
    case 'accepted': return 'Accepted';
    case 'declined': return 'Declined';
    case 'tentative': return 'Maybe';
    case 'needs_action': return 'No answer yet';
    case 'delegated': return 'Delegated';
    case 'completed': return 'Completed';
    case 'in_process': return 'In process';
    default: return '';
  }
}

const UNITS: [number, string][] = [[604_800, 'week'], [86_400, 'day'], [3_600, 'hour'], [60, 'minute']];

/** "9:00 AM" for seconds after midnight, as the engine's _clock says it. */
function clockOf(seconds: number): string {
  const h = Math.floor(seconds / 3600), rest = seconds % 3600;
  return `${h % 12 || 12}:${String(Math.floor(rest / 60)).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
}

/**
 * "15 minutes before", "1 day before", "At time of event", "On Jul 3, 2026 at 9:00 AM". An
 * all-day event starts at midnight, so its alerts are a time of day: "On the day at 9:00 AM",
 * "1 day before at 9:00 AM". The same words as the spreadsheet (python/calendar_events.py _alert_words).
 */
export function alertText(alarm: EventAlarm, allDay = false): string {
  if ('at' in alarm) {
    const day = formatDate(alarm.at), time = formatTime(alarm.at);
    return day ? `On ${day}${time ? ` at ${time}` : ''}` : 'At a set time';
  }
  const s = Math.round(alarm.seconds_before);
  if (allDay && Number.isFinite(s)) {
    const after = -s; // seconds after the day's midnight
    const days = Math.floor(after / 86_400);
    const when = clockOf(after - days * 86_400);
    if (days === 0) return `On the day at ${when}`;
    if (days < 0) return `${-days} day${days < -1 ? 's' : ''} before at ${when}`;
    return `${days} day${days > 1 ? 's' : ''} after at ${when}`;
  }
  if (!Number.isFinite(s) || s === 0) return 'At time of event';
  const abs = Math.abs(s);
  const [size, unit] = UNITS.find(([size]) => abs % size === 0) ?? [60, 'minute'];
  const n = Math.max(1, Math.round(abs / size));
  return `${count(n, unit)} ${s > 0 ? 'before' : 'after'}`;
}

/** The words a search looks through for an event: title, place, notes and the people on it. */
export function eventMatchFields(e: CalendarEvent): (string | null)[] {
  return [
    e.title, e.location?.title ?? null, e.location?.address ?? null, e.notes,
    e.organizer?.name ?? null, e.organizer?.email ?? null,
    ...(e.attendees ?? []).flatMap(a => [a.name, a.email]),
  ];
}

/** An event id as a search result names it ("calendar:141"). */
export function eventSelectId(e: Pick<CalendarEvent, 'id'>): string {
  return `calendar:${e.id}`;
}

// ── Empty states ───────────────────────────────────────────────────────────

export interface EmptyCopy {
  /** 'error' and 'unsupported' get a Report button; 'empty' is calm. */
  kind: 'error' | 'unsupported' | 'empty';
  title: string;
  detail?: string;
}

/** What the Calendar screen says when it has nothing to show, from the engine's answer. */
export function emptyCopy(
  emptyReason: CalendarEmptyReason | string | null | undefined,
  error: string | null | undefined,
): EmptyCopy {
  if (emptyReason === 'unsupported_format') {
    return { kind: 'unsupported', title: "This version of Calendar can't be read yet", detail: error || undefined };
  }
  if (error && emptyReason !== 'not_in_backup' && emptyReason !== 'no_records') {
    return { kind: 'error', title: "Couldn't read the calendar", detail: error };
  }
  if (emptyReason === 'no_records') {
    return { kind: 'empty', title: 'No calendar events in this backup', detail: "Calendar is on this iPhone, but it doesn't have any events." };
  }
  return {
    kind: 'empty',
    title: 'No calendar events in this backup',
    detail: emptyReason === 'not_in_backup' ? "This iPhone's calendar wasn't in the backup." : undefined,
  };
}

/** What an agenda with nothing in it says. */
export function agendaEmptyText(view: AgendaView, query: string): string {
  if (query) return `No ${view} events match "${query}"`;
  return view === 'upcoming' ? 'No upcoming events.' : 'No past events.';
}

/** A search that finds nothing in any calendar. */
export function noMatchCopy(query: string): { title: string; detail: string } {
  return { title: `No events match "${query}"`, detail: "Try an event's title, its place, its notes or someone on it." };
}

// ── Saving ─────────────────────────────────────────────────────────────────

/** What a save says under "Saved …". `one` is true when a single calendar was saved. */
export function calendarSaveDetail(result: Partial<CalendarExportResult>, format: CalendarSaveFormat, one: boolean): string {
  if (format === 'csv') return 'A spreadsheet of the events';
  if (one) return 'A calendar file, for Calendar, Outlook or Google';
  const files = result.calendars ?? result.files?.length ?? 0;
  return `${count(files, 'calendar file')}, for Calendar, Outlook or Google`;
}

// ── Home and details ───────────────────────────────────────────────────────

/** The overview numbers the home tile reads; an older engine sends none of them. */
export interface CalendarOverview {
  /** Events in the person's own calendars. */
  total_calendar_events?: number;
  /** Events in holidays, birthdays, Found in Mail and subscribed calendars. */
  total_subscribed_events?: number;
  /** The person's own calendars, empty ones too. */
  total_calendars?: number;
  /** The person's own calendars that have events (an older engine doesn't send it). */
  total_calendars_with_events?: number;
  calendar_status?: CalendarStatus;
}

/** Calendar is in the backup but couldn't be read: its tile still shows, with no number, to say why. */
export function calendarUnreadable(o: CalendarOverview | null | undefined): boolean {
  return o?.calendar_status === 'error' || o?.calendar_status === 'unsupported_format';
}

/** Whether the section shows: any event in any calendar, or a calendar that couldn't be read. */
export function calendarShown(o: CalendarOverview | null | undefined): boolean {
  return (o?.total_calendar_events ?? 0) + (o?.total_subscribed_events ?? 0) > 0 || calendarUnreadable(o);
}

/**
 * The home tile's line. It counts only calendars with events (total_calendars counts empty ones
 * too, like the local Default), and without that number says nothing about calendars.
 */
export function calendarHomeLine(o: CalendarOverview): string {
  if (o.calendar_status === 'unsupported_format') return "This Calendar version can't be read yet";
  if (o.calendar_status === 'error') return "Couldn't be read: open it to see why";
  if (!o.total_calendar_events && o.total_subscribed_events) return 'Holidays and subscribed calendars';
  if (o.total_calendars_with_events) return `Events in ${count(o.total_calendars_with_events, 'calendar')}`;
  return 'Events, invitations and alerts';
}
