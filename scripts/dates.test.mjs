// Tests for how dates, times and durations are shown (src/lib/dates.ts).
// The engine sends every timestamp as UTC ISO 8601 ("2024-03-10T09:59:59.123456+00:00");
// the app shows it on the person's own local calendar day and clock.
// Run with: node --test scripts/dates.test.mjs (also re-runs itself in other time zones)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';
import { rerunInTimeZones, onlyIn } from './test-helpers/time-zones.mjs';

const { formatDate, formatTime, formatDateTime, formatRelative, formatDuration } = loadTs('src/lib/dates.ts');

// An instant at this local wall-clock time, as the engine would send it
const local = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms);
const engine = date => date.toISOString().replace('Z', '+00:00');
// en-US puts a narrow no-break space before AM/PM; compare it as a plain space
const plain = s => s.replace(/\s+/g, ' ');

// Days that are 23 or 25 hours long somewhere, plus the ends of months and years
const TRICKY_DAYS = [
  [2024, 1, 1], [2024, 2, 29], [2024, 3, 10], [2024, 3, 31], [2024, 4, 7],
  [2024, 10, 6], [2024, 10, 27], [2024, 11, 3], [2024, 12, 31], [2025, 1, 1], [2023, 2, 28],
];

test('nothing to show gives an empty string', () => {
  for (const empty of ['', null, undefined]) {
    assert.equal(formatDate(empty), '');
    assert.equal(formatTime(empty), '');
    assert.equal(formatDateTime(empty), '');
    assert.equal(formatRelative(empty), '');
  }
});

test('every form of engine timestamp reads as the same moment', () => {
  const forms = [
    '2024-03-10T09:59:59.123456+00:00', // Python isoformat with microseconds
    '2024-03-10T09:59:59+00:00',
    '2024-03-10T09:59:59Z',
    '2024-03-10T09:59:59.123Z',
  ];
  for (const iso of forms) {
    assert.notEqual(formatDate(iso), 'Invalid Date', iso);
    assert.equal(formatDate(iso), formatDate(forms[0]), iso);
    assert.equal(formatTime(iso), formatTime(forms[0]), iso);
  }
});

test('a day runs from local midnight to local midnight, including DST days', () => {
  for (const [y, m, d] of TRICKY_DAYS) {
    const day = formatDate(engine(local(y, m, d, 12)));
    assert.equal(formatDate(engine(local(y, m, d, 0, 0, 0))), day, `start of ${y}-${m}-${d}`);
    assert.equal(formatDate(engine(local(y, m, d, 0, 30))), day, `00:30 on ${y}-${m}-${d}`);
    assert.equal(formatDate(engine(local(y, m, d, 23, 30))), day, `23:30 on ${y}-${m}-${d}`);
    assert.equal(formatDate(engine(local(y, m, d, 23, 59, 59, 999))), day, `end of ${y}-${m}-${d}`);
    assert.notEqual(formatDate(engine(local(y, m, d + 1, 0, 0, 0))), day, `the day after ${y}-${m}-${d}`);
    assert.notEqual(formatDate(engine(local(y, m, d - 1, 23, 59, 59, 999))), day, `the day before ${y}-${m}-${d}`);
  }
});

test('times are shown on the local clock', () => {
  // The same wall-clock time on days either side of a DST change reads the same
  for (const [y, m, d] of TRICKY_DAYS) {
    assert.equal(formatTime(engine(local(y, m, d, 21, 5))), formatTime(engine(local(2024, 6, 15, 21, 5))), `${y}-${m}-${d} 21:05`);
    assert.equal(formatTime(engine(local(y, m, d, 9, 41))), formatTime(engine(local(2024, 1, 15, 9, 41))), `${y}-${m}-${d} 09:41`);
  }
  assert.notEqual(formatTime(engine(local(2024, 6, 15, 9, 41))), formatTime(engine(local(2024, 6, 15, 21, 41))));
});

test('formatDateTime is the date, a space, then the time', () => {
  const iso = engine(local(2024, 2, 29, 18, 7));
  assert.equal(formatDateTime(iso), `${formatDate(iso)} ${formatTime(iso)}`);
});

// The browser-history activity tooltip passes these day keys
test('a calendar day with no time (YYYY-MM-DD) shows that day', () => {
  for (const [y, m, d] of TRICKY_DAYS) {
    const key = `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    assert.equal(formatDate(key), formatDate(engine(local(y, m, d, 12))), key);
  }
});

test("a timestamp that can't be read is shown as it came", () => {
  assert.equal(formatDate('unknown'), 'unknown');
});

test('formatRelative counts back from now', () => {
  const ago = ms => engine(new Date(Date.now() - ms));
  const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR;
  assert.equal(formatRelative(ago(0)), 'Just now');
  assert.equal(formatRelative(ago(30_000)), 'Just now');
  assert.equal(formatRelative(ago(90_000)), '1m ago');
  assert.equal(formatRelative(ago(59 * MIN + 30_000)), '59m ago');
  assert.equal(formatRelative(ago(HOUR + 5 * MIN)), '1h ago');
  assert.equal(formatRelative(ago(23 * HOUR + 50 * MIN)), '23h ago');
  assert.equal(formatRelative(ago(DAY + HOUR)), '1d ago');
  assert.equal(formatRelative(ago(6 * DAY + 23 * HOUR)), '6d ago');
  // A week or more back shows the date
  const old = ago(8 * DAY);
  assert.equal(formatRelative(old), formatDate(old));
  assert.equal(formatRelative('2019-07-04T16:20:00+00:00'), formatDate('2019-07-04T16:20:00+00:00'));
  // A clock a little ahead (the phone's or this computer's) still reads as now
  assert.equal(formatRelative(engine(new Date(Date.now() + 5 * MIN))), 'Just now');
});

test('formatDuration shows minutes and seconds', () => {
  assert.equal(formatDuration(0), '0:00');
  assert.equal(formatDuration(null), '0:00');
  assert.equal(formatDuration(undefined), '0:00');
  assert.equal(formatDuration(NaN), '0:00');
  assert.equal(formatDuration(0.4), '0:00');
  assert.equal(formatDuration(7), '0:07');
  assert.equal(formatDuration(59.99), '0:59');
  assert.equal(formatDuration(60), '1:00');
  assert.equal(formatDuration(125.6), '2:05');
  assert.equal(formatDuration(3599), '59:59');
  // No hours column: a 2½-hour call reads as 150 minutes
  assert.equal(formatDuration(3600), '60:00');
  assert.equal(formatDuration(9000), '150:00');
});

// ── Exact strings, in the zone where each moment is tricky ───────────────────
// [engine timestamp, formatDate, formatTime]
const IN_ZONE = {
  'America/Los_Angeles': [
    ['2024-03-10T07:59:59.999+00:00', 'Mar 9, 2024', '11:59 PM'],
    ['2024-03-10T08:00:00+00:00', 'Mar 10, 2024', '12:00 AM'],
    ['2024-03-10T09:59:59+00:00', 'Mar 10, 2024', '1:59 AM'],   // clocks go forward
    ['2024-03-10T10:00:00+00:00', 'Mar 10, 2024', '3:00 AM'],
    ['2024-11-03T08:30:00+00:00', 'Nov 3, 2024', '1:30 AM'],    // clocks go back: 1:30 twice
    ['2024-11-03T09:30:00+00:00', 'Nov 3, 2024', '1:30 AM'],
    ['2024-11-04T07:59:59+00:00', 'Nov 3, 2024', '11:59 PM'],   // a 25-hour day
  ],
  'Australia/Lord_Howe': [
    ['2024-04-06T12:59:59+00:00', 'Apr 6, 2024', '11:59 PM'],
    ['2024-04-06T13:00:00+00:00', 'Apr 7, 2024', '12:00 AM'],
    ['2024-04-06T14:59:59+00:00', 'Apr 7, 2024', '1:59 AM'],    // back half an hour
    ['2024-04-06T15:00:00+00:00', 'Apr 7, 2024', '1:30 AM'],
    ['2024-10-05T15:29:59+00:00', 'Oct 6, 2024', '1:59 AM'],    // forward half an hour
    ['2024-10-05T15:30:00+00:00', 'Oct 6, 2024', '2:30 AM'],
  ],
  'Asia/Kolkata': [
    ['2024-03-09T18:29:59+00:00', 'Mar 9, 2024', '11:59 PM'],
    ['2024-03-09T18:30:00+00:00', 'Mar 10, 2024', '12:00 AM'],
    ['2024-02-28T18:30:00+00:00', 'Feb 29, 2024', '12:00 AM'],
  ],
  'UTC': [
    ['2024-03-10T00:00:00+00:00', 'Mar 10, 2024', '12:00 AM'],
    ['2024-12-31T23:59:59.999999+00:00', 'Dec 31, 2024', '11:59 PM'],
  ],
  'Pacific/Kiritimati': [
    ['2024-12-31T09:59:59+00:00', 'Dec 31, 2024', '11:59 PM'],
    ['2024-12-31T10:00:00+00:00', 'Jan 1, 2025', '12:00 AM'],
  ],
  'America/St_Johns': [
    ['2024-03-10T03:29:59+00:00', 'Mar 9, 2024', '11:59 PM'],
    ['2024-03-10T05:29:59+00:00', 'Mar 10, 2024', '1:59 AM'],
    ['2024-03-10T05:30:00+00:00', 'Mar 10, 2024', '3:00 AM'],
  ],
};

for (const [tz, rows] of Object.entries(IN_ZONE)) {
  test(`exact dates and times in ${tz}`, { skip: onlyIn(tz) }, () => {
    for (const [iso, date, time] of rows) {
      assert.equal(formatDate(iso), date, iso);
      assert.equal(plain(formatTime(iso)), time, iso);
      assert.equal(plain(formatDateTime(iso)), `${date} ${time}`, iso);
    }
  });
}

test('German dates and 24-hour times in Europe/Berlin', { skip: onlyIn('Europe/Berlin', 'de-DE') }, () => {
  assert.equal(formatDate('2024-03-31T00:59:59+00:00'), '31. März 2024');
  assert.equal(formatTime('2024-03-31T00:59:59+00:00'), '1:59');
  assert.equal(formatTime('2024-03-31T01:00:00+00:00'), '3:00');
  assert.equal(formatDateTime('2024-10-26T22:00:00+00:00'), '27. Okt. 2024 0:00');
});

rerunInTimeZones(import.meta.url);
