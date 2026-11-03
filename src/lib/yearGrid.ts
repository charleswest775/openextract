/**
 * The Year view's grid: weeks as columns, Sunday to Saturday as rows.
 *
 * Worked out in UTC, where every day is 24 hours long, so daylight saving can't
 * skip or repeat a square. The days themselves come from the engine in local time.
 */

const DAY_MS = 86_400_000;

export interface GridCell {
  day: string;   // YYYY-MM-DD
  col: number;
  row: number;
}

export interface YearGrid {
  cells: GridCell[];
  columns: number;  // 53, or 54 in a leap year that starts on a Saturday (2028)
  months: { label: string; col: number }[];
}

export function buildYearGrid(year: number): YearGrid {
  const first = Date.UTC(year, 0, 1);
  const offset = new Date(first).getUTCDay();
  const dayCount = (Date.UTC(year + 1, 0, 1) - first) / DAY_MS;

  const cells: GridCell[] = [];
  const months: { label: string; col: number }[] = [];
  for (let i = 0; i < dayCount; i++) {
    const date = new Date(first + i * DAY_MS);
    const slot = i + offset;
    const col = Math.floor(slot / 7);
    cells.push({ day: date.toISOString().slice(0, 10), col, row: slot % 7 });
    if (date.getUTCDate() === 1) {
      months.push({ label: date.toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' }), col });
    }
  }
  return { cells, columns: cells[cells.length - 1].col + 1, months };
}

// Darkness 1-4 for a day's count, by quartile of the days with anything on them,
// so one huge day doesn't wash out the rest of the year.
export function shadeLevels(counts: number[]): (count: number) => number {
  const sorted = counts.filter(c => c > 0).sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.floor((sorted.length - 1) * q)] ?? 0;
  const cuts = [at(0.25), at(0.5), at(0.75)];
  return count => 1 + cuts.filter(cut => count > cut).length;
}

// Dates are plain calendar days here, so format them in UTC too.
export function formatDay(day: string, withYear = false): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: withYear ? 'numeric' : undefined,
    timeZone: 'UTC',
  });
}
