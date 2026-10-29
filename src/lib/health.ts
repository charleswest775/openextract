/**
 * Types and helpers for the Health tab.
 *
 * Dates from the sidecar are local calendar days ("YYYY-MM-DD"), not
 * instants. Parse them with localDate(), never `new Date("YYYY-MM-DD")`,
 * which is UTC midnight and shows as the day before west of Greenwich.
 */

export interface HealthDay {
  date: string;
  steps?: number;
  distance_km?: number;
  flights?: number;
  active_energy_kcal?: number;
  resting_heart_rate?: number;
  heart_rate_min?: number;
  heart_rate_avg?: number;
  heart_rate_max?: number;
  weight_kg?: number;
}

export interface HealthNight {
  /** The local date the night ended */
  date: string;
  asleep_minutes: number;
  in_bed_minutes: number;
  awake_minutes: number;
  core_minutes: number;
  deep_minutes: number;
  rem_minutes: number;
}

export interface HealthWorkout {
  id: number;
  activity_type: number;
  type: string;
  start: string | null;
  end: string | null;
  duration_minutes: number | null;
  distance_km: number | null;
  energy_kcal: number | null;
  avg_heart_rate: number | null;
  max_heart_rate: number | null;
  indoor: boolean | null;
  source: string | null;
}

export interface HealthSummary {
  available: boolean;
  notice: string | null;
  errors: { section?: string; message: string }[];
  range: { first: string; last: string } | null;
  daily: HealthDay[];
  sleep: HealthNight[];
  workouts: HealthWorkout[];
}

// ── Dates ────────────────────────────────────────────────────────────────────

export function localDate(ymd: string): Date {
  const [y, m, d] = ymd.slice(0, 10).split('-').map(Number);
  return new Date(y, m - 1, d);
}

export function toYmd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
}

// ── Ranges and buckets ───────────────────────────────────────────────────────

export type RangeKey = '30d' | '90d' | '1y' | 'all';
export type Bucket = 'day' | 'week' | 'month';

export const RANGES: { key: RangeKey; label: string; days: number | null; bucket: Bucket }[] = [
  { key: '30d', label: '30 days', days: 30, bucket: 'day' },
  { key: '90d', label: '90 days', days: 90, bucket: 'day' },
  { key: '1y', label: '1 year', days: 365, bucket: 'week' },
  { key: 'all', label: 'All time', days: null, bucket: 'month' },
];

/**
 * The first day of a range: counted back from the backup's last day with
 * data (a backup can be years old, so "today" would often show nothing).
 */
export function rangeStart(range: { first: string; last: string }, days: number | null): string {
  if (days === null) return range.first;
  const start = toYmd(addDays(localDate(range.last), -(days - 1)));
  return start > range.first ? start : range.first;
}

/** Day → itself; week → its Monday; month → its first day. */
export function bucketKey(ymd: string, bucket: Bucket): string {
  if (bucket === 'day') return ymd;
  if (bucket === 'month') return `${ymd.slice(0, 7)}-01`;
  const d = localDate(ymd);
  return toYmd(addDays(d, -((d.getDay() + 6) % 7)));
}

/** Average of `pick(row)` per bucket, over the rows that have a value. Ascending. */
export function averageBy<T extends { date: string }>(
  rows: T[],
  bucket: Bucket,
  pick: (row: T) => number | null | undefined,
): { key: string; value: number }[] {
  const sums = new Map<string, { total: number; count: number }>();
  for (const row of rows) {
    const v = pick(row);
    if (v === null || v === undefined) continue;
    const key = bucketKey(row.date, bucket);
    const s = sums.get(key) ?? { total: 0, count: 0 };
    s.total += v;
    s.count += 1;
    sums.set(key, s);
  }
  return [...sums.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, s]) => ({ key, value: s.total / s.count }));
}

export function mean(values: (number | null | undefined)[]): number | null {
  const present = values.filter((v): v is number => v !== null && v !== undefined);
  return present.length ? present.reduce((a, b) => a + b, 0) / present.length : null;
}

export function formatPeriod(key: string, bucket: Bucket): string {
  const d = localDate(key);
  if (bucket === 'month') return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const day = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  return bucket === 'week' ? `Week of ${day}` : d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

export function formatTick(key: string, bucket: Bucket): string {
  const d = localDate(key);
  if (bucket === 'month') return d.toLocaleDateString(undefined, { month: 'short', year: '2-digit' });
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// ── Units and formatting ─────────────────────────────────────────────────────

export type Units = 'metric' | 'us';

export function defaultUnits(): Units {
  return navigator.language === 'en-US' ? 'us' : 'metric';
}

export function distance(km: number, units: Units): { value: number; unit: string } {
  return units === 'us' ? { value: km * 0.621371, unit: 'mi' } : { value: km, unit: 'km' };
}

export function weight(kg: number, units: Units): { value: number; unit: string } {
  return units === 'us' ? { value: kg * 2.20462, unit: 'lb' } : { value: kg, unit: 'kg' };
}

export function formatNumber(value: number, digits = 0): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: digits, minimumFractionDigits: digits });
}

/** 437 → "7h 17m" */
export function formatMinutes(minutes: number): string {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}
