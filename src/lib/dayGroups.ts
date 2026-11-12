import { formatDate } from './dates';

/**
 * Splitting a thread into days, for the date pills in Messages, WhatsApp and
 * Recover deleted messages.
 *
 * Messages arrive in the order the thread reads, but their dates don't always
 * agree with that order: a WhatsApp message is stamped with the sender's clock
 * and can arrive after midnight with yesterday's date, and an sms.db page can
 * hold a message a minute older than the one before it. Starting a new day
 * whenever the date changed made a second "Mar 3" pill after "Mar 4", with the
 * same React key as the first. So a new day starts only when a message's day is
 * later than the day on screen; a message stamped earlier stays where it
 * arrived (its bubble can show its own date). Days are therefore in order and
 * each appears once, and the day itself is a key that stays the same when
 * older messages are loaded above.
 */

export interface DayGroup<T> {
  /** The day as YYYY-MM-DD on this computer's calendar, or 'unknown': unique within one thread. */
  key: string;
  /** What the pill says: "Mar 3, 2025", or "Date unknown". */
  label: string;
  messages: T[];
}

export const UNKNOWN_DAY = 'unknown';
export const UNKNOWN_DAY_LABEL = 'Date unknown';

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The local calendar day of an ISO date as YYYY-MM-DD; null when there's no usable date. */
export function dayKey(iso: string | null | undefined): string | null {
  if (!iso) return null;
  // A bare YYYY-MM-DD is already a day on the local calendar (dates.ts reads it the same way)
  const m = DATE_ONLY.exec(iso);
  if (m) return iso;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Messages in thread order, grouped into days. Messages with no usable date
 * join the day they arrived in; any before the first dated message are under
 * "Date unknown".
 */
export function groupByDay<T extends { date?: string | null }>(messages: T[]): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  let current: DayGroup<T> | null = null;
  for (const msg of messages) {
    const day = dayKey(msg.date);
    // YYYY-MM-DD strings compare in date order
    const later = day !== null && (current === null || current.key === UNKNOWN_DAY || day > current.key);
    if (later) {
      current = { key: day, label: formatDate(msg.date) || day, messages: [msg] };
      groups.push(current);
    } else if (current) {
      current.messages.push(msg);
    } else {
      current = { key: UNKNOWN_DAY, label: UNKNOWN_DAY_LABEL, messages: [msg] };
      groups.push(current);
    }
  }
  return groups;
}

/** A message stamped with a different day from the group it sits in: show its date with its time. */
export function isOffDay(date: string | null | undefined, group: { key: string }): boolean {
  const day = dayKey(date);
  return day !== null && group.key !== UNKNOWN_DAY && day !== group.key;
}
