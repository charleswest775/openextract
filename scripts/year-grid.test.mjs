// Tests for the Year view's grid (src/lib/yearGrid.ts): one square per calendar
// day, weeks as columns and Sunday..Saturday as rows, in every time zone.
// The engine's day keys (python/year_counts.py) are local calendar days, "YYYY-MM-DD".
// Run with: node --test scripts/year-grid.test.mjs (also re-runs itself in other time zones)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';
import { rerunInTimeZones, enUS } from './test-helpers/time-zones.mjs';

const { buildYearGrid, shadeLevels, formatDay } = loadTs('src/lib/yearGrid.ts');

const isLeap = y => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
const key = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
// The weekday of a calendar day, worked out without Date: Zeller's congruence, 0 = Sunday
function weekday(y, m, d) {
  if (m < 3) { m += 12; y -= 1; }
  const k = y % 100, j = Math.floor(y / 100);
  const h = (d + Math.floor(13 * (m + 1) / 5) + k + Math.floor(k / 4) + Math.floor(j / 4) + 5 * j) % 7;
  return (h + 6) % 7;
}
const DAYS_IN_MONTH = (y, m) => [31, isLeap(y) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];

test('every day of the year has exactly one square, in order, on its weekday', () => {
  for (let year = 1900; year <= 2100; year++) {
    const { cells } = buildYearGrid(year);
    assert.equal(cells.length, isLeap(year) ? 366 : 365, `${year} day count`);
    let i = 0;
    const first = weekday(year, 1, 1);
    for (let m = 1; m <= 12; m++) {
      for (let d = 1; d <= DAYS_IN_MONTH(year, m); d++, i++) {
        const cell = cells[i];
        assert.equal(cell.day, key(year, m, d), `${year} square ${i}`);
        assert.equal(cell.row, weekday(year, m, d), `${cell.day} weekday`);
        assert.equal(cell.col, Math.floor((i + first) / 7), `${cell.day} week`);
      }
    }
  }
});

test('leap days: 2024 and 2000 have Feb 29, 1900 and 2100 do not', () => {
  const days = year => new Set(buildYearGrid(year).cells.map(c => c.day));
  assert.ok(days(2024).has('2024-02-29'));
  assert.ok(days(2000).has('2000-02-29'));
  assert.ok(!days(1900).has('1900-02-29'));
  assert.ok(!days(2100).has('2100-02-29'));
  assert.ok(!days(2023).has('2023-02-29'));
  // ...and nothing spills into the next year
  for (const year of [1900, 2000, 2023, 2024, 2100]) {
    const { cells } = buildYearGrid(year);
    assert.equal(cells[0].day, `${year}-01-01`);
    assert.equal(cells.at(-1).day, `${year}-12-31`);
  }
});

test('53 columns, or 54 in a leap year that starts on a Saturday', () => {
  for (let year = 1900; year <= 2100; year++) {
    const want = isLeap(year) && weekday(year, 1, 1) === 6 ? 54 : 53;
    assert.equal(buildYearGrid(year).columns, want, String(year));
  }
  assert.equal(buildYearGrid(2028).columns, 54);
  assert.equal(buildYearGrid(2000).columns, 54);
  assert.equal(buildYearGrid(2022).columns, 53); // starts on a Saturday, but 365 days
  assert.equal(buildYearGrid(2024).columns, 53);
});

test('days when the clocks change are ordinary squares in every time zone', () => {
  const { cells } = buildYearGrid(2024);
  const count = day => cells.filter(c => c.day === day).length;
  for (const day of ['2024-03-10', '2024-11-03', '2024-03-31', '2024-10-27', '2024-04-07', '2024-10-06']) {
    assert.equal(count(day), 1, day);
  }
  assert.equal(new Set(cells.map(c => c.day)).size, 366);
  // Squares are a day apart: the row steps by one and wraps into the next column
  for (let i = 1; i < cells.length; i++) {
    const [a, b] = [cells[i - 1], cells[i]];
    if (a.row === 6) assert.deepEqual([b.row, b.col], [0, a.col + 1], b.day);
    else assert.deepEqual([b.row, b.col], [a.row + 1, a.col], b.day);
  }
});

test('month labels sit over the week holding the 1st', () => {
  for (const year of [2023, 2024, 2028, 2100]) {
    const { cells, months } = buildYearGrid(year);
    assert.equal(months.length, 12);
    assert.equal(months[0].col, 0);
    for (let m = 1; m <= 12; m++) {
      const firstCell = cells.find(c => c.day === key(year, m, 1));
      assert.equal(months[m - 1].col, firstCell.col, `${year}-${m}`);
      // The label is that month, not the one before (a local-time slip shows "Dec" over January)
      const expected = new Date(year, m - 1, 15).toLocaleDateString(undefined, { month: 'short' });
      assert.equal(months[m - 1].label, expected, `${year}-${m}`);
    }
  }
});

test('English month labels', { skip: !enUS && 'needs an en-US locale' }, () => {
  assert.deepEqual(buildYearGrid(2024).months.map(m => m.label),
    ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']);
});

test('formatDay shows the calendar day it was given, in every time zone', () => {
  const sameDay = (y, m, d, opts) => new Date(y, m - 1, d, 12).toLocaleDateString(undefined, opts);
  for (const [y, m, d] of [[2024, 1, 1], [2024, 2, 29], [2024, 3, 10], [2024, 11, 3], [2024, 12, 31], [2025, 1, 1]]) {
    assert.equal(formatDay(key(y, m, d)), sameDay(y, m, d, { month: 'short', day: 'numeric' }), key(y, m, d));
    assert.equal(formatDay(key(y, m, d), true), sameDay(y, m, d, { month: 'short', day: 'numeric', year: 'numeric' }), key(y, m, d));
  }
  // Every square of a year gets its own label
  const labels = buildYearGrid(2024).cells.map(c => formatDay(c.day, true));
  assert.equal(new Set(labels).size, 366);
});

test('formatDay in English', { skip: !enUS && 'needs an en-US locale' }, () => {
  assert.equal(formatDay('2024-03-10'), 'Mar 10');
  assert.equal(formatDay('2024-12-31', true), 'Dec 31, 2024');
  assert.equal(formatDay('2025-01-01', true), 'Jan 1, 2025');
  assert.equal(formatDay('2024-02-29', true), 'Feb 29, 2024');
});

test('shadeLevels splits busy days into quarters', () => {
  const counts = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100
  const shade = shadeLevels(counts);
  assert.deepEqual([1, 25, 26, 50, 51, 75, 76, 100].map(shade), [1, 1, 2, 2, 3, 3, 4, 4]);
});

test("one huge day doesn't wash out the rest of the year", () => {
  const counts = [...Array.from({ length: 20 }, (_, i) => i + 1), 50_000];
  const shade = shadeLevels(counts);
  assert.equal(shade(50_000), 4);
  assert.equal(shade(20), 4);
  assert.equal(shade(1), 1);
  assert.equal(shade(8), 2);
  assert.equal(shade(12), 3);
});

test('quiet days are left out when finding the quarters', () => {
  const shade = shadeLevels([0, 0, 0, 0, 0, -1, 5, 10, 15, 20]);
  assert.deepEqual([5, 6, 10, 11, 15, 16, 20].map(shade), [1, 2, 2, 3, 3, 4, 4]);
});

test('shadeLevels with no data, one day, or every day the same', () => {
  assert.equal(shadeLevels([])(0), 1);
  assert.equal(shadeLevels([0, 0, 0])(0), 1);
  assert.equal(shadeLevels([42])(42), 1);
  assert.equal(shadeLevels([7, 7, 7, 7])(7), 1);
  const huge = shadeLevels([1e9, 2e9, 3e9, 4e9, Number.MAX_SAFE_INTEGER]);
  assert.equal(huge(Number.MAX_SAFE_INTEGER), 4);
  assert.equal(huge(1e9), 1);
});

test('shades are always 1-4 and never go down as the count goes up', () => {
  let seed = 7;
  const rand = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
  for (let round = 0; round < 50; round++) {
    const counts = Array.from({ length: 1 + Math.floor(rand() * 366) }, () => Math.floor(rand() ** 3 * 500));
    const shade = shadeLevels(counts);
    let last = 0;
    for (let c = 0; c <= 600; c++) {
      const level = shade(c);
      assert.ok(level >= 1 && level <= 4, `level ${level}`);
      assert.ok(level >= last, `count ${c}`);
      last = level;
    }
  }
});

rerunInTimeZones(import.meta.url);
