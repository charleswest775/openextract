/**
 * Shared types and date helpers for calendar events.
 *
 * Event times arrive in three shapes (see ios-backup-core's calendar_events):
 *   - timed events: ISO with an offset, e.g. "2024-03-10T15:00:00+00:00"
 *   - floating timed events: ISO without an offset — a local wall-clock time
 *   - all-day events: "YYYY-MM-DD" dates, with `end` the last day (inclusive)
 * All-day dates must be built as local dates: `new Date("2024-03-12")` is UTC
 * midnight, which shows as the day before anywhere west of Greenwich.
 */

export interface CalendarPerson {
  name: string | null;
  email: string | null;
}

export interface CalendarEvent {
  id: number;
  title: string;
  start: string;
  end: string | null;
  all_day: boolean;
  floating: boolean;
  timezone: string | null;
  calendar_id: number | null;
  calendar: string | null;
  calendar_color: string | null;
  account: string | null;
  location: string | null;
  address: string | null;
  latitude: number | null;
  longitude: number | null;
  notes: string;
  url: string | null;
  conference_url: string | null;
  organizer: CalendarPerson | null;
  attendees: (CalendarPerson & { status: number | null })[];
  recurring: boolean;
  uid: string | null;
  created: string | null;
  modified: string | null;
}

export interface CalendarInfo {
  id: number;
  title: string;
  color: string | null;
  account: string | null;
  event_count: number;
}

function localDate(ymd: string): Date {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function eventStart(ev: CalendarEvent): Date {
  return ev.all_day ? localDate(ev.start) : new Date(ev.start);
}

export function eventEnd(ev: CalendarEvent): Date | null {
  if (!ev.end) return null;
  return ev.all_day ? localDate(ev.end) : new Date(ev.end);
}

export function sameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

/** "YYYY-MM-DD" for the local day an event starts on. */
export function eventDayKey(ev: CalendarEvent): string {
  const d = eventStart(ev);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const time = (d: Date) => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
const shortDate = (d: Date) => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/** "All day", "Mar 20 – Mar 22", "3:00 PM – 4:00 PM", or "11:00 PM – Mar 11, 1:00 AM". */
export function formatEventWhen(ev: CalendarEvent): string {
  const start = eventStart(ev);
  const end = eventEnd(ev);
  if (ev.all_day) {
    if (!end || sameDay(start, end)) return 'All day';
    return `${shortDate(start)} – ${shortDate(end)}`;
  }
  if (!end || end.getTime() === start.getTime()) return time(start);
  if (sameDay(start, end)) return `${time(start)} – ${time(end)}`;
  return `${time(start)} – ${shortDate(end)}, ${time(end)}`;
}

export function formatPerson(p: CalendarPerson): string {
  if (p.name && p.email) return `${p.name} <${p.email}>`;
  return p.name || p.email || '';
}
