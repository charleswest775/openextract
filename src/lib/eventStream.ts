import type { TimelineEntry } from '../types/timeline';
import { formatDate } from './dates';
import { dayKey, UNKNOWN_DAY } from './dayGroups';

/**
 * The Timeline's and People's stream of events, split into days for the
 * sticky date headings. Only the first `shown` events are on screen (the
 * stream grows as you scroll), but each day's count is the whole day's.
 */
export interface StreamDay {
  /** Unique within the stream: the local calendar day (YYYY-MM-DD), or 'unknown'. */
  key: string;
  /** What the heading says: "Nov 17, 2026", or "Unknown date". */
  label: string;
  /** The day's events that are on screen, newest first. */
  entries: TimelineEntry[];
  /** How many events the day has in all, including any not on screen yet. */
  total: number;
}

const keyOf = (e: TimelineEntry) => dayKey(e.timestamp) ?? UNKNOWN_DAY;

/** The days of the first `shown` events of a newest-first stream. */
export function streamDays(entries: TimelineEntry[], shown: number): StreamDay[] {
  const days: StreamDay[] = [];
  const used = new Map<string, number>();
  const end = Math.max(0, Math.min(shown, entries.length));
  let current: StreamDay | null = null;
  let currentDay = '';
  for (let i = 0; i < end; i++) {
    const e = entries[i];
    const day = keyOf(e);
    if (!current || day !== currentDay) {
      // A day seen before further up (an out-of-order date) still needs a key of its own
      const n = used.get(day) ?? 0;
      used.set(day, n + 1);
      currentDay = day;
      current = {
        key: n === 0 ? day : `${day}#${n}`,
        label: day === UNKNOWN_DAY ? 'Unknown date' : formatDate(e.timestamp) || 'Unknown date',
        entries: [],
        total: 0,
      };
      days.push(current);
    }
    current.entries.push(e);
  }
  for (const d of days) d.total = d.entries.length;
  // Only the last day on screen can carry on past what's shown
  if (current) {
    for (let i = end; i < entries.length && keyOf(entries[i]) === currentDay; i++) current.total++;
  }
  return days;
}
