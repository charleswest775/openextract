// Tests for the Calendar screen's wording and decisions (src/lib/calendar.ts):
// which calendars are the person's own and how they're grouped, how events
// split into Upcoming and Past at the backup's date, the agenda's days and
// order, what rows and details say, empty states, saves and the home tile.
//
// Dates are the point of most of this file. All-day and floating events are
// wall-calendar days and times, so they must read the same in every time zone
// (a July 4 holiday is never July 3); events in a time zone are instants shown
// on this computer's clock. The file re-runs itself in other zones (last line),
// and its checks hold in any zone: expected values are built with the local
// Date constructor, and exact English strings are checked only in en-US.
// Data is fictional, shaped like the engine's list_calendars / list_calendar_events.
// Run with: node --test scripts/calendar.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeBridge, loadTs } from './test-helpers/load-ts.mjs';
import { enUS, onlyIn, rerunInTimeZones, zone } from './test-helpers/time-zones.mjs';

const cal = loadTs('src/lib/calendar.ts');
const plain = s => s.replace(/\s+/g, ' ');

function calendar(over = {}) {
  return {
    id: 1, title: 'Home', color: '#34AADC', account: { id: 3, name: 'iCloud', type: 'caldav', disabled: false },
    kind: 'normal', read_only: false, subscription_url: null, sharing: 'not_shared', owner_email: 'me@example.com',
    event_count: 3,
    ...over,
  };
}

function event(over = {}) {
  return {
    id: 1, uid: 'UID-1', calendar_id: 1, title: 'Dentist', notes: null, url: null, conference_url: null,
    all_day: false, floating: false,
    start: '2026-03-03T17:00:00+00:00', end: '2026-03-03T18:00:00+00:00',
    start_day: null, end_day: null, days: null, wall_start: null, wall_end: null,
    time_zone: 'America/Los_Angeles', end_time_zone: null,
    status: 'none', availability: 'busy', location: null, recurrence: null, exceptions: [], detached_from: null,
    organizer: null, attendees: [], alarms: [], year_unknown: false,
    created_date: null, modified_date: null, repeats: null,
    ...over,
  };
}

const allDay = (start_day, end_day = start_day, over = {}) => event({
  all_day: true, floating: true, start: null, end: null, time_zone: null, start_day, end_day,
  days: Math.round((Date.UTC(...end_day.split('-').map((n, i) => i === 1 ? n - 1 : +n)) - Date.UTC(...start_day.split('-').map((n, i) => i === 1 ? n - 1 : +n))) / 86400000) + 1,
  ...over,
});
const floating = (wall_start, wall_end, over = {}) => event({
  floating: true, start: null, end: null, time_zone: null, wall_start, wall_end, ...over,
});
const localDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ── Reading dates without shifting them ─────────────────────────────────────

test('a day is read as that day on this computer\'s calendar, never as UTC midnight', () => {
  const d = cal.parseDay('2026-07-04');
  assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()], [2026, 6, 4, 0]);
  assert.equal(cal.parseDay('2026-07-04T00:00:00'), null, 'only bare days');
  assert.equal(cal.parseDay(null), null);
  assert.equal(cal.parseDay('not a day'), null);
  const w = cal.parseWall('2026-03-01T09:30:00');
  assert.deepEqual([w.getFullYear(), w.getMonth(), w.getDate(), w.getHours(), w.getMinutes()], [2026, 2, 1, 9, 30]);
  assert.equal(cal.parseWall('2026-03-01'), null);
  // A birthday whose year isn't known (Apple uses 1604) is still that day
  assert.equal(cal.parseDay('1604-06-19').getFullYear(), 1604);
});

test('an all-day event and a floating one are listed on their own day in every time zone', () => {
  assert.equal(cal.eventDayKey(allDay('2026-07-04')), '2026-07-04');
  assert.equal(cal.eventDayKey(allDay('2026-01-01')), '2026-01-01');
  assert.equal(cal.eventDayKey(floating('2026-03-01T23:30:00', '2026-03-02T00:30:00')), '2026-03-01');
  assert.equal(cal.eventDayKey(floating('2026-03-02T00:15:00', null)), '2026-03-02');
  // In a time zone: this computer's day of the instant
  const e = event({ start: '2026-03-03T23:30:00+00:00', end: null });
  assert.equal(cal.eventDayKey(e), localDay(new Date('2026-03-03T23:30:00Z')));
  assert.equal(cal.eventDayKey(event({ start: null })), null);
  assert.equal(cal.dateKind(allDay('2026-07-04')), 'day');
  assert.equal(cal.dateKind(floating('2026-03-01T09:00:00', null)), 'wall');
  assert.equal(cal.dateKind(event()), 'instant');
  assert.equal(cal.dateKind(event({ start: null })), null);
});

test('an all-day event is over at midnight after its last day; a timed one at its end, never before its start', () => {
  const july4 = allDay('2026-07-04');
  assert.equal(cal.eventEnd(july4).getTime(), new Date(2026, 6, 5).getTime());
  assert.equal(cal.eventEnd(allDay('2026-07-04', '2026-07-06')).getTime(), new Date(2026, 6, 7).getTime());
  const f = floating('2026-03-01T09:00:00', '2026-03-01T10:00:00');
  assert.equal(cal.eventEnd(f).getTime(), new Date(2026, 2, 1, 10).getTime());
  assert.equal(cal.eventEnd(event({ end: null })).getTime(), new Date('2026-03-03T17:00:00Z').getTime());
  assert.equal(cal.eventEnd(event({ end: '2026-03-03T16:00:00+00:00' })).getTime(), new Date('2026-03-03T17:00:00Z').getTime());
});

// ── Upcoming and past ───────────────────────────────────────────────────────

test('events split at the backup\'s date: an event still on then, an all-day one that day included, is upcoming', () => {
  // The backup was made at 3 pm on July 4 on this computer's clock
  const at = new Date(2026, 6, 4, 15, 0);
  const split = cal.splitPoint(at.toISOString());
  assert.equal(split.fromBackup, true);
  assert.equal(split.at.getTime(), at.getTime());
  const up = e => cal.isUpcoming(e, split.at);
  assert.equal(up(allDay('2026-07-04')), true, 'the day of the backup is still upcoming');
  assert.equal(up(allDay('2026-07-03')), false);
  assert.equal(up(allDay('2026-07-01', '2026-07-04')), true, 'a trip still going on');
  assert.equal(up(allDay('2026-07-05')), true);
  assert.equal(up(floating('2026-07-04T14:00:00', '2026-07-04T14:30:00')), false);
  assert.equal(up(floating('2026-07-04T14:00:00', '2026-07-04T16:00:00')), true, 'in progress');
  assert.equal(up(floating('2026-07-04T16:00:00', null)), true);
  assert.equal(up(event({ start: new Date(2026, 6, 4, 14).toISOString(), end: new Date(2026, 6, 4, 14, 59).toISOString() })), false);
  assert.equal(up(event({ start: new Date(2026, 6, 4, 18).toISOString(), end: null })), true);
  assert.equal(up(event({ start: null, end: null })), false, 'an event with no date is past');

  const { upcoming, past } = cal.splitEvents([allDay('2026-07-03', '2026-07-03', { id: 1 }), allDay('2026-07-04', '2026-07-04', { id: 2 })], split.at);
  assert.deepEqual([upcoming.map(e => e.id), past.map(e => e.id)], [[2], [1]]);
  assert.equal(cal.defaultView([allDay('2026-07-05')], split.at), 'upcoming');
  assert.equal(cal.defaultView([allDay('2026-07-03')], split.at), 'past', 'nothing upcoming: opens on the past');
});

test('without the backup\'s date, the split is now, and the note says so', () => {
  const now = new Date(2026, 10, 20, 12);
  assert.deepEqual(cal.splitPoint('', now), { at: now, fromBackup: false });
  assert.deepEqual(cal.splitPoint(null, now), { at: now, fromBackup: false });
  assert.equal(cal.splitNote({ at: now, fromBackup: false }, false), 'Upcoming and past as of today.');
});

test('the note names the backup\'s date, and how repeating events are listed only when there are some', { skip: !enUS && 'English words' }, () => {
  const at = new Date(2026, 10, 20, 12);
  assert.equal(cal.splitNote({ at, fromBackup: true }, false), 'Upcoming and past as of the backup on Nov 20, 2026.');
  assert.equal(cal.splitNote({ at, fromBackup: true }, true),
    'Upcoming and past as of the backup on Nov 20, 2026. A repeating event is listed once, on the day it started.');
});

test('the agenda: upcoming runs forward; past runs back a day at a time, each day in order; no date last', () => {
  const list = [
    floating('2026-07-04T09:00:00', '2026-07-04T10:00:00', { id: 5 }),
    allDay('2026-07-04', '2026-07-04', { id: 4 }),
    allDay('2026-07-02', '2026-07-02', { id: 2 }),
    floating('2026-07-02T08:00:00', null, { id: 3 }),
    event({ id: 9, start: null, end: null }),
    floating('2026-07-04T09:00:00', '2026-07-04T09:30:00', { id: 6 }),
  ];
  const up = cal.agenda(list, 'upcoming');
  assert.deepEqual(up.map(d => d.key), ['2026-07-02', '2026-07-04', 'unknown']);
  assert.deepEqual(up.map(d => d.events.map(e => e.id)), [[2, 3], [4, 5, 6], [9]], 'all-day first, then by time, then id');
  const past = cal.agenda(list, 'past');
  assert.deepEqual(past.map(d => d.key), ['2026-07-04', '2026-07-02', 'unknown'], 'newest day first');
  assert.deepEqual(past[0].events.map(e => e.id), [4, 5, 6], 'a day still reads in the order it happens');
  assert.equal(past.at(-1).label, 'Date unknown');
  assert.equal(list[0].id, 5, "the engine's list is left as it was");
});

test('day headers name the day, the same day in every zone; a birthday without a year has none', () => {
  assert.equal(cal.dayLabel('2026-07-04'), new Date(2026, 6, 4).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }));
  assert.equal(cal.dayLabel('1604-06-19'), new Date(2026, 5, 19).toLocaleDateString(undefined, { month: 'long', day: 'numeric' }));
  assert.equal(cal.dayLabel('unknown'), 'Date unknown');
});

test('day headers in English', { skip: !enUS && 'English words' }, () => {
  assert.equal(cal.dayLabel('2026-07-04'), 'Saturday, July 4, 2026');
  assert.equal(cal.dayLabel('1604-06-19'), 'June 19');
});

// ── Rows and details ────────────────────────────────────────────────────────

test('row times: "All day", several days, floating times as written, across midnight', () => {
  assert.equal(cal.timeText(allDay('2026-07-04')), 'All day');
  const short = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  assert.equal(cal.timeText(allDay('2026-07-04', '2026-07-06')), `${short(new Date(2026, 6, 4))} – ${short(new Date(2026, 6, 6))}`);
  const t = d => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  // A floating event's time is its wall time on any computer
  assert.ok(plain(cal.timeText(floating('2026-03-01T09:00:00', null))) === plain(t(new Date(2026, 2, 1, 9))));
  assert.equal(cal.timeText(event({ start: null })), '');
});

test('a floating event shows its own time on any computer, even in an hour this computer\'s clock skips or repeats', () => {
  // Days daylight saving starts or ends in the US, Europe or Lord Howe, each against the next
  // day, when no clock changes: the times read the same
  const nextDay = d => { const [y, m, n] = d.split('-').map(Number); return new Date(Date.UTC(y, m - 1, n + 1)).toISOString().slice(0, 10); };
  for (const day of ['2026-03-08', '2026-03-29', '2026-10-04', '2026-11-01', '2026-10-25', '2026-04-05']) {
    for (const [a, b] of [['02:30', '03:30'], ['01:30', '02:30'], ['02:00', '02:15']]) {
      const there = floating(`${day}T${a}:00`, `${day}T${b}:00`);
      const after = floating(`${nextDay(day)}T${a}:00`, `${nextDay(day)}T${b}:00`);
      assert.equal(plain(cal.timeText(there)), plain(cal.timeText(after)), `${day} ${a}–${b}`);
      assert.ok(plain(cal.whenText(there)).endsWith(plain(cal.timeText(after))), `${day} ${a}–${b}: ${cal.whenText(there)}`);
    }
  }
  assert.equal(cal.eventDayKey(floating('2026-03-08T02:30:00', null)), '2026-03-08');
});

test('a floating event in the hour daylight saving skips, in English', { skip: !enUS && 'English words' }, () => {
  assert.equal(plain(cal.timeText(floating('2026-03-08T02:30:00', '2026-03-08T03:30:00'))), '2:30 – 3:30 AM');
  assert.equal(plain(cal.whenText(floating('2026-03-08T02:30:00', '2026-03-08T03:30:00'))), 'Sun, Mar 8, 2026, 2:30 – 3:30 AM');
  assert.equal(plain(cal.timeText(floating('2026-03-08T01:30:00', '2026-03-08T02:30:00'))), '1:30 – 2:30 AM');
  assert.equal(plain(cal.timeText(floating('2026-03-08T02:30:00', null))), '2:30 AM');
  assert.equal(plain(cal.timeText(floating('2026-03-07T21:00:00', '2026-03-08T02:30:00'))), 'Mar 7, 9:00 PM – Mar 8, 2:30 AM');
});

test('row times in English', { skip: !enUS && 'English words' }, () => {
  assert.equal(cal.timeText(allDay('2026-07-04', '2026-07-06')), 'Jul 4 – Jul 6');
  assert.equal(cal.timeText(allDay('2026-12-30', '2027-01-02')), 'Dec 30, 2026 – Jan 2, 2027');
  assert.equal(plain(cal.timeText(floating('2026-03-01T09:00:00', '2026-03-01T10:00:00'))), '9:00 – 10:00 AM');
  assert.equal(plain(cal.timeText(floating('2026-03-01T11:30:00', '2026-03-01T13:00:00'))), '11:30 AM – 1:00 PM');
  assert.equal(plain(cal.timeText(floating('2026-07-04T21:00:00', '2026-07-05T01:00:00'))), 'Jul 4, 9:00 PM – Jul 5, 1:00 AM');
  assert.equal(plain(cal.timeText(floating('2026-07-04T21:00:00', '2026-07-05T00:00:00'))), '9:00 PM – 12:00 AM', 'ending at midnight is that evening');
  assert.equal(plain(cal.whenText(allDay('2026-07-04'))), 'Sat, Jul 4, 2026, all day');
  assert.equal(plain(cal.whenText(allDay('2026-07-04', '2026-07-06'))), 'Sat, Jul 4, 2026 – Mon, Jul 6, 2026, all day (3 days)');
  assert.equal(plain(cal.whenText(floating('2026-03-01T09:00:00', '2026-03-01T10:00:00'))), 'Sun, Mar 1, 2026, 9:00 – 10:00 AM');
});

test('an event in a time zone shows on this computer\'s clock (Los Angeles)', { skip: onlyIn('America/Los_Angeles') }, () => {
  // 17:00 UTC is 9:00 in Los Angeles in March (PST)
  assert.equal(plain(cal.timeText(event())), '9:00 – 10:00 AM');
  assert.equal(cal.zoneNote(event()), null, 'set in this computer\'s own zone: nothing to say');
  assert.equal(plain(cal.zoneNote(event({ time_zone: 'America/New_York' }))), "Shown on this computer's clock: it starts at 12:00 PM New York time.");
  assert.equal(plain(cal.zoneNote(event({ time_zone: 'Asia/Tokyo' }))), "Shown on this computer's clock: it starts on Wed, Mar 4 at 2:00 AM Tokyo time.");
});

test('an event in a time zone shows on this computer\'s clock (Kolkata)', { skip: onlyIn('Asia/Kolkata') }, () => {
  // 17:00 UTC is 22:30 in Kolkata
  assert.equal(plain(cal.timeText(event())), '10:30 – 11:30 PM');
  assert.equal(plain(cal.zoneNote(event())), "Shown on this computer's clock: it starts at 9:00 AM Los Angeles time.");
});

test('the time zone note: none for all-day events or this computer\'s zone, one for floating events and odd zone names', () => {
  assert.equal(cal.zoneNote(allDay('2026-07-04')), null);
  assert.equal(cal.zoneNote(floating('2026-03-01T09:00:00', null)), cal.FLOATING_NOTE);
  assert.equal(cal.FLOATING_NOTE, "This event has no time zone, so it's at this time wherever you are.");
  assert.equal(cal.zoneNote(event({ time_zone: zone })), null);
  assert.equal(cal.zoneNote(event({ time_zone: null })), null);
  assert.equal(cal.zoneNote(event({ time_zone: 'GMT+0400' })), 'It was set in the time zone "GMT+0400".');
  // Elsewhere: said exactly when that zone's clock differs from this computer's
  const there = new Intl.DateTimeFormat('en-US', { timeZone: 'Pacific/Kiritimati', hour: '2-digit', minute: '2-digit', day: '2-digit', hourCycle: 'h23' }).format(new Date('2026-03-03T17:00:00Z'));
  const here = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', day: '2-digit', hourCycle: 'h23' }).format(new Date('2026-03-03T17:00:00Z'));
  assert.equal(cal.zoneNote(event({ time_zone: 'Pacific/Kiritimati' })) === null, there === here);
  assert.equal(cal.zoneCity('America/New_York'), 'New York');
  assert.equal(cal.zoneCity('America/Argentina/Buenos_Aires'), 'Buenos Aires');
  assert.equal(cal.zoneCity('UTC'), 'UTC');
});

test('how an event repeats, its skipped and changed dates, read as the same kind of date as its start', () => {
  const weekly = { frequency: 'weekly', interval: 1, count: null, until: null, by_day: ['TU'], by_month_day: [], by_month: [], by_set_pos: [], by_year_day: [], by_week_no: [], week_start: 'SU', last_start: null };
  assert.equal(cal.repeatText({ recurrence: weekly, repeats: 'Every week on Tuesday' }), 'Repeats every week on Tuesday');
  assert.equal(cal.repeatText({ recurrence: weekly, repeats: null }), 'Repeats', 'an older engine without the words');
  assert.equal(cal.repeatText({ recurrence: null, repeats: null }), null);
  assert.equal(cal.repeatText({ recurrence: weekly, repeats: 'MWF only' }), 'Repeats MWF only', 'capitals that aren\'t a sentence start stay');

  const short = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  // All-day: the skipped days are days, in every zone
  const climbing = allDay('2026-06-02', '2026-06-02', { recurrence: weekly, exceptions: ['2026-06-09', '2026-06-16'] });
  assert.equal(cal.skippedText(climbing), `Skipped on ${short(new Date(2026, 5, 9))} and ${short(new Date(2026, 5, 16))}`);
  // Floating: wall times
  const f = floating('2026-06-02T18:00:00', '2026-06-02T20:00:00', { exceptions: ['2026-06-09T18:00:00'] });
  assert.equal(cal.skippedText(f), `Skipped on ${short(new Date(2026, 5, 9))}`);
  const many = allDay('2026-01-06', '2026-01-06', { exceptions: ['2026-01-13', '2026-01-20', '2026-01-27', '2026-02-03', '2026-02-10', '2026-02-17', '2026-02-24'] });
  assert.match(cal.skippedText(many), / and 2 other dates$/);
  assert.equal(cal.skippedText(allDay('2026-01-06')), null);

  const moved = allDay('2026-06-12', '2026-06-12', { detached_from: { event_id: 7, original_start: '2026-06-09' } });
  assert.equal(cal.changedText(moved), `Moved from ${short(new Date(2026, 5, 9))}`);
  const retimed = floating('2026-06-09T19:00:00', null, { detached_from: { event_id: 7, original_start: '2026-06-09T18:00:00' } });
  assert.equal(cal.changedText(retimed), 'Changed for this date');
  assert.equal(cal.changedText(allDay('2026-06-12')), null);
});

test('a changed date\'s original start is the kind of its series\' start, so a date switched between timed and all day reads right', () => {
  const short = d => d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  // An all-day series, one date made timed (7 am that day here): the original start is a day, never UTC midnight
  const timedChild = event({ start: new Date(2026, 2, 20, 7).toISOString(), end: null, detached_from: { event_id: 7, original_start: '2026-03-20' } });
  assert.equal(cal.changedText(timedChild), 'Changed for this date');
  // A timed series (6 pm here), one date made all day the day after: the original start keeps its time
  const was = new Date(2026, 2, 16, 18);
  const allDayChild = allDay('2026-03-17', '2026-03-17', { detached_from: { event_id: 7, original_start: was.toISOString().replace('.000Z', '+00:00') } });
  assert.equal(cal.changedText(allDayChild), `Moved from ${short(new Date(2026, 2, 16))}`);
  const sameDay = allDay('2026-03-16', '2026-03-16', { detached_from: { event_id: 7, original_start: was.toISOString() } });
  assert.equal(cal.changedText(sameDay), 'Changed for this date');
  // A floating series, one date made all day
  const fromWall = allDay('2026-03-17', '2026-03-17', { detached_from: { event_id: 7, original_start: '2026-03-16T23:30:00' } });
  assert.equal(cal.changedText(fromWall), `Moved from ${short(new Date(2026, 2, 16))}`);
});

test('a changed date switched between timed and all day, in Los Angeles', { skip: onlyIn('America/Los_Angeles') }, () => {
  // An all-day Friday series, Mar 20 made timed (14:00 UTC is 7 am there): nothing moved
  const market = event({ start: '2026-03-20T14:00:00+00:00', end: '2026-03-20T15:00:00+00:00', detached_from: { event_id: 7, original_start: '2026-03-20' } });
  assert.equal(cal.changedText(market), 'Changed for this date');
  // A Tokyo series at 08:00 (23:00 UTC the day before), Mar 17 made all day: in Los Angeles it was Mar 16
  const call = allDay('2026-03-17', '2026-03-17', { detached_from: { event_id: 7, original_start: '2026-03-16T23:00:00+00:00' } });
  assert.equal(cal.changedText(call), 'Moved from Mar 16, 2026');
});

test('row chips: cancelled or tentative, how it repeats, a changed date', () => {
  const weekly = { frequency: 'weekly', interval: 1, count: null, until: null, by_day: ['TU'], by_month_day: [], by_month: [], by_set_pos: [], by_year_day: [], by_week_no: [], week_start: null, last_start: null };
  assert.deepEqual(cal.eventChips(event({ status: 'cancelled', recurrence: weekly, repeats: 'Every week on Tuesday' })), ['Cancelled', 'Repeats every week on Tuesday']);
  assert.deepEqual(cal.eventChips(event({ status: 'cancelled', recurrence: weekly, repeats: 'Every week on Tuesday' }), true), ['Cancelled'], 'open: the details say how it repeats');
  assert.deepEqual(cal.eventChips(event({ status: 'tentative' })), ['Tentative']);
  assert.deepEqual(cal.eventChips(event({ status: 'confirmed' })), []);
  assert.deepEqual(cal.eventChips(event({ detached_from: { event_id: 2, original_start: '2026-03-03T17:00:00+00:00' } })), ['Changed for this date']);
});

test('places, people and their answers, alerts', () => {
  const loc = { title: 'Clinic', address: '1 Main St, Springfield', latitude: 40.7, longitude: -74 };
  assert.equal(cal.placeLine(event({ location: loc })), 'Clinic');
  assert.equal(cal.placeLine(event({ location: { ...loc, title: null } })), '1 Main St, Springfield');
  assert.equal(cal.placeLine(event()), '');
  assert.deepEqual(cal.placeLines(event({ location: loc })), ['Clinic', '1 Main St, Springfield']);
  assert.deepEqual(cal.placeLines(event({ location: { ...loc, address: 'Clinic' } })), ['Clinic'], 'said once');
  assert.deepEqual(cal.placeLines(event({ location: { ...loc, title: null } })), ['1 Main St, Springfield']);

  assert.equal(cal.personName({ name: 'Pat Doe', email: 'pat@example.com' }), 'Pat Doe');
  assert.equal(cal.personName({ name: null, email: 'pat@example.com' }), 'pat@example.com');
  assert.equal(cal.personName({ name: ' ', email: null, phone: '+1 555 0100' }), '+1 555 0100');
  assert.equal(cal.personName({ name: null, email: null }), 'Someone');
  assert.equal(cal.organizerText({ name: 'Pat Doe', email: 'pat@example.com', is_me: false }), 'Organized by Pat Doe');
  assert.equal(cal.organizerText({ name: 'Me', email: 'me@example.com', is_me: true }), 'You organized it');
  assert.equal(cal.organizerText(null), null);
  assert.deepEqual(['accepted', 'declined', 'tentative', 'needs_action', 'unknown'].map(cal.answerText),
    ['Accepted', 'Declined', 'Maybe', 'No answer yet', '']);

  assert.equal(cal.alertText({ seconds_before: 900 }), '15 minutes before');
  assert.equal(cal.alertText({ seconds_before: 60 }), '1 minute before');
  assert.equal(cal.alertText({ seconds_before: 5400 }), '90 minutes before');
  assert.equal(cal.alertText({ seconds_before: 7200 }), '2 hours before');
  assert.equal(cal.alertText({ seconds_before: 86400 }), '1 day before');
  assert.equal(cal.alertText({ seconds_before: 172800 }), '2 days before');
  assert.equal(cal.alertText({ seconds_before: 604800 }), '1 week before');
  assert.equal(cal.alertText({ seconds_before: 0 }), 'At time of event', 'the spreadsheet\'s words');
  assert.equal(cal.alertText({ seconds_before: 0 }, false), 'At time of event');
  assert.equal(cal.alertText({ seconds_before: -300 }), '5 minutes after');
  assert.equal(cal.alertText({ seconds_before: -32400 }), '9 hours after', 'a timed event keeps its offset');
  assert.match(cal.alertText({ at: '2026-07-03T16:00:00+00:00' }), /^On .+ at .+/);
  assert.match(cal.alertText({ at: '2026-07-03T16:00:00+00:00' }, true), /^On .+ at .+/);
});

test('an all-day event\'s alerts are a time of day, in the spreadsheet\'s words', () => {
  // It starts at midnight: -32400 is 9 am that day, 54000 is 9 am the day before
  assert.equal(cal.alertText({ seconds_before: -32400 }, true), 'On the day at 9:00 AM');
  assert.equal(cal.alertText({ seconds_before: 54000 }, true), '1 day before at 9:00 AM');
  assert.equal(cal.alertText({ seconds_before: 140400 }, true), '2 days before at 9:00 AM');
  assert.equal(cal.alertText({ seconds_before: 0 }, true), 'On the day at 12:00 AM');
  assert.equal(cal.alertText({ seconds_before: -45000 }, true), 'On the day at 12:30 PM');
  assert.equal(cal.alertText({ seconds_before: 7200 }, true), '1 day before at 10:00 PM');
  assert.equal(cal.alertText({ seconds_before: -118800 }, true), '1 day after at 9:00 AM');
  assert.equal(cal.alertText({ seconds_before: -205200 }, true), '2 days after at 9:00 AM');
});

test('search looks through the title, the place, the notes and the people', () => {
  const e = event({
    title: 'Planning', notes: 'Bring the sketches', location: { title: 'Studio', address: '9 Elm Rd', latitude: null, longitude: null },
    organizer: { name: 'Pat Doe', email: 'pat@example.com', is_me: false },
    attendees: [{ name: 'Robin Roe', email: 'robin@example.com', phone: null, status: 'accepted', role: 'required', type: 'person', is_me: false }],
  });
  const fields = cal.eventMatchFields(e);
  for (const word of ['Planning', 'Studio', '9 Elm Rd', 'Bring the sketches', 'Pat Doe', 'pat@example.com', 'Robin Roe', 'robin@example.com']) {
    assert.ok(fields.includes(word), word);
  }
  assert.equal(cal.eventSelectId(e), 'calendar:1');
  assert.equal(cal.eventName({ title: '  ' }), 'Untitled event');
});

// ── Calendars ───────────────────────────────────────────────────────────────

test('the person\'s own calendars are grouped by account, in the engine\'s order; the rest are kept apart', () => {
  const list = [
    calendar({ id: 1, title: 'Personal', account: { id: 1, name: 'Default', type: 'local', disabled: false } }),
    calendar({ id: 2, title: 'Home' }),
    calendar({ id: 3, title: 'Work' }),
    calendar({ id: 4, title: 'US Holidays', kind: 'holidays', account: { id: 9, name: 'Subscribed Calendars', type: 'subscribed', disabled: false } }),
    calendar({ id: 5, title: 'Birthdays', kind: 'birthdays', account: { id: 8, name: 'Other', type: 'other', disabled: false } }),
    calendar({ id: 6, title: 'Team', account: { id: 7, name: 'Exchange at Work', type: 'exchange', disabled: false } }),
    calendar({ id: 7, title: 'Found in Mail', kind: 'suggestions', account: { id: 8, name: 'Other', type: 'other', disabled: false } }),
  ];
  const { mine, others } = cal.groupCalendars(list);
  assert.deepEqual(mine.map(g => [g.label, g.calendars.map(c => c.id)]), [['On My iPhone', [1]], ['iCloud', [2, 3]], ['Exchange at Work', [6]]]);
  assert.deepEqual(others.map(c => c.id), [4, 5, 7]);
  // Other calendars without an event aren't listed (iOS makes Birthdays and Found in Mail on every
  // iPhone); the person's own empty calendars still are
  const empty = cal.groupCalendars(list.map(c => (c.id === 5 || c.id === 7 || c.id === 1 ? { ...c, event_count: 0 } : c)));
  assert.deepEqual(empty.others.map(c => c.id), [4]);
  assert.deepEqual(empty.mine[0].calendars.map(c => c.id), [1]);
  assert.deepEqual(cal.groupCalendars(list.filter(c => c.kind === 'normal' || c.id === 5).map(c => ({ ...c, event_count: c.id === 5 ? 0 : 3 }))).others, []);
  assert.equal(cal.isOwnCalendar(list[0]), true);
  assert.equal(cal.isOwnCalendar(list[3]), false);
  assert.equal(cal.accountLabel(null), 'Calendars');
  assert.equal(cal.accountLabel({ id: 2, name: null, type: 'exchange', disabled: false }), 'Exchange');
  assert.equal(cal.accountLabel({ id: 2, name: '', type: 'caldav', disabled: false }), 'CalDAV');
});

test('a calendar\'s line, header facts, colour and name', () => {
  assert.equal(cal.calendarLine(calendar({ event_count: 1 })), '1 event');
  assert.equal(cal.calendarLine(calendar({ event_count: 0 })), 'No events');
  assert.equal(cal.calendarLine(calendar({ kind: 'holidays', event_count: 120 })), `Holidays · ${(120).toLocaleString()} events`);
  // Found in Mail and Found in Natural Language are both Siri's
  assert.equal(cal.calendarLine(calendar({ kind: 'suggestions', event_count: 1 })), 'Siri Suggestions · 1 event');
  assert.equal(cal.otherKindLabel({ kind: 'suggestions' }), 'Siri Suggestions');
  assert.equal(cal.calendarLine(calendar(), 2, true), '2 events match');
  assert.equal(cal.calendarLine(calendar(), 1, true), '1 event matches');
  assert.equal(cal.matchCount(1), '1 event matches');
  assert.equal(cal.matchCount(0), '0 events match');
  assert.equal(cal.calendarLine(calendar(), 0, true), 'No matches');
  assert.deepEqual(cal.calendarFacts(calendar({ sharing: 'shared_by_me' })), ['iCloud', 'Shared by you', '3 events']);
  assert.deepEqual(cal.calendarFacts(calendar({ sharing: 'shared_with_me', owner_email: 'pat@example.com', read_only: true })),
    ['iCloud', 'Shared with you by pat@example.com', '3 events']);
  assert.deepEqual(cal.calendarFacts(calendar({ read_only: true })), ['iCloud', 'Read only', '3 events']);
  assert.deepEqual(cal.calendarFacts(calendar({ kind: 'subscribed', read_only: true })), ['Subscribed', '3 events']);
  assert.equal(cal.calendarColor(calendar({ color: '#ff2968' })), '#ff2968');
  assert.equal(cal.calendarColor(calendar({ color: 'blue' })), 'var(--text-tertiary)');
  assert.equal(cal.calendarColor(null), 'var(--text-tertiary)');
  assert.equal(cal.calendarName({ title: null }), 'Untitled calendar');
  assert.equal(cal.webAddress('https://example.com/meet'), 'https://example.com/meet');
  assert.equal(cal.webAddress('facetime://example'), null, 'only web addresses open');
});

// ── Empty states, saves, home ───────────────────────────────────────────────

test('empty states: calm when there are no events, an error or an old format to report', () => {
  assert.deepEqual(cal.emptyCopy('not_in_backup', null), {
    kind: 'empty', title: 'No calendar events in this backup', detail: "This iPhone's calendar wasn't in the backup.",
  });
  assert.deepEqual(cal.emptyCopy('no_records', null), {
    kind: 'empty', title: 'No calendar events in this backup', detail: "Calendar is on this iPhone, but it doesn't have any events.",
  });
  const old = cal.emptyCopy('unsupported_format', "This backup's calendar is in an older format OpenExtract can't read yet.");
  assert.equal(old.kind, 'unsupported');
  assert.equal(old.detail, "This backup's calendar is in an older format OpenExtract can't read yet.");
  const broken = cal.emptyCopy(null, 'Calendar is in this backup but could not be read.');
  assert.deepEqual([broken.kind, broken.title], ['error', "Couldn't read the calendar"]);
  assert.equal(cal.emptyCopy(null, null).kind, 'empty');
  assert.deepEqual(cal.noMatchCopy('zebra'), { title: 'No events match "zebra"', detail: "Try an event's title, its place, its notes or someone on it." });
  assert.equal(cal.agendaEmptyText('upcoming', ''), 'No upcoming events.');
  assert.equal(cal.agendaEmptyText('past', ''), 'No past events.');
  assert.equal(cal.agendaEmptyText('past', 'zebra'), 'No past events match "zebra"');
});

test('what a save says', () => {
  assert.equal(cal.calendarSaveDetail({ count: 40, calendars: 3, files: [] }, 'ics', false), '3 calendar files, for Calendar, Outlook or Google');
  assert.equal(cal.calendarSaveDetail({ count: 4, files: ['a.ics'] }, 'ics', false), '1 calendar file, for Calendar, Outlook or Google');
  assert.equal(cal.calendarSaveDetail({ count: 4, files: ['a.ics'] }, 'ics', true), 'A calendar file, for Calendar, Outlook or Google');
  assert.equal(cal.calendarSaveDetail({ count: 4, files: ['a.csv'] }, 'csv', true), 'A spreadsheet of the events');
});

test('the home tile: shown for any event or an unreadable calendar, with a line to match', () => {
  assert.equal(cal.calendarShown({ total_calendar_events: 0, total_subscribed_events: 0, calendar_status: 'not_in_backup' }), false);
  assert.equal(cal.calendarShown({ total_calendar_events: 0, total_subscribed_events: 12, calendar_status: 'ok' }), true, 'holidays alone');
  assert.equal(cal.calendarShown({ total_calendar_events: 0, calendar_status: 'error' }), true);
  assert.equal(cal.calendarShown({}), false, 'an older engine sends none of these');
  assert.equal(cal.calendarUnreadable({ calendar_status: 'unsupported_format' }), true);
  assert.equal(cal.calendarUnreadable({ calendar_status: 'no_records' }), false);
  assert.equal(cal.calendarHomeLine({ calendar_status: 'error' }), "Couldn't be read: open it to see why");
  assert.equal(cal.calendarHomeLine({ calendar_status: 'unsupported_format' }), "This Calendar version can't be read yet");
  assert.equal(cal.calendarHomeLine({ calendar_status: 'ok', total_calendar_events: 0, total_subscribed_events: 9 }), 'Holidays and subscribed calendars');
  assert.equal(cal.calendarHomeLine({ calendar_status: 'ok', total_calendar_events: 30, total_calendars: 2, total_calendars_with_events: 2 }), 'Events in 2 calendars');
  // Only calendars with events count: Hickman 13.3.1 has 5 of its own, and 1 event in 1 of them
  assert.equal(cal.calendarHomeLine({ calendar_status: 'ok', total_calendar_events: 1, total_calendars: 5, total_calendars_with_events: 1 }), 'Events in 1 calendar');
  // An older engine without that number: nothing about calendars, never total_calendars
  assert.equal(cal.calendarHomeLine({ calendar_status: 'ok', total_calendar_events: 3, total_calendars: 5 }), 'Events, invitations and alerts');
});

test('the home tile and Backup details don\'t say every calendar has events (Hickman 13.3.1: 5 calendars, 1 with its 1 event)', t => {
  const bridge = fakeBridge({});
  window.openextract.platform = 'darwin';
  t.after(bridge.restore);
  const overview = {
    device_name: 'Test iPhone', product_type: 'iPhone12,1', ios_version: '13.3.1', last_backup: '2026-11-20T18:00:00+00:00', encrypted: true, size_gb: 1,
    total_messages: 1, total_conversations: 1, total_photos: 1, total_videos: 0, photos_in_backup: 1, total_contacts: 1, total_calls: 1,
    total_notes: 1, total_voicemails: 1, total_whatsapp_messages: 0, total_whatsapp_chats: 0, whatsapp_status: 'not_in_backup',
    total_podcasts: 0, total_podcasts_followed: 0, total_podcast_episodes_listened: 0, podcasts_status: 'not_in_backup',
    total_voice_memos: 0, total_voice_memo_seconds: 0, total_deleted_voice_memos: 0, total_voice_memos_with_audio: 0, voice_memos_status: 'no_records',
    total_calendar_events: 1, total_subscribed_events: 118, total_calendars: 5, total_calendars_with_events: 1, calendar_status: 'ok',
  };
  const s = loadTs('src/components/explore/sections.ts');
  const BackupHome = loadTs('src/components/explore/BackupHome.tsx').default;
  const ctx = {
    udid: 'u1', session: null, stats: null, overview, hasBrowserHistory: false, index: { entries: [], addressBook: [] },
    data: s.availableData(overview, false), missing: [], activeTab: 'home', openTab: () => {}, onBack: () => {}, openSettings: () => {}, unfinished: false,
  };
  const home = renderToStaticMarkup(createElement(BackupHome, { ctx, onSearch: () => {} }));
  const tile = home.match(/<button[^>]*aria-label="Calendar[",][\s\S]*?<\/button>/)?.[0] ?? '';
  assert.match(tile, />Events in 1 calendar</);
  const stats = {
    overview,
    messages: { sent: 0, received: 1, imessage_count: 1, sms_count: 0, group_conversations: 0, one_on_one_conversations: 1, top_conversations: [], busiest_day: '', busiest_hour: 0, avg_messages_per_day: 0, total_attachments: 0, first_message_date: null, last_message_date: null },
    photos: { by_kind: {}, total_photos: 1, total_videos: 0, total_favorites: 0, with_location: 0, earliest_date: null, latest_date: null, total_video_duration_seconds: 0 },
    calls: { incoming: 0, outgoing: 1, answered: 1, missed: 0, total_duration_seconds: 0, avg_duration_seconds: 0, longest_call_seconds: 0, facetime_count: 0, regular_count: 1, top_contacts: [] },
    notes: { total: 1, avg_length_chars: 1, longest_chars: 1 },
    voicemails: { total: 1, total_duration_seconds: 0, read: 0, unread: 1 },
    errors: [],
  };
  const BackupDashboard = loadTs('src/components/explore/BackupDashboard.tsx').default;
  const details = renderToStaticMarkup(createElement(BackupDashboard, { stats, loading: false, error: null, onNavigate: () => {}, hasBrowserHistory: false }))
    .replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
  assert.match(details, /\|Your calendars\|5\|Events\|1\|/);
  assert.doesNotMatch(details, /Events in them/);
});

test('Calendar is a section after Voice Memos, shown for holidays alone, listed missing only with no events at all', () => {
  const s = loadTs('src/components/explore/sections.ts');
  const base = {
    total_messages: 1, total_whatsapp_messages: 0, photos_in_backup: 1, total_contacts: 1, total_calls: 1,
    total_notes: 1, total_voicemails: 1,
  };
  const ids = o => s.availableData(o, true).map(x => x.id);
  assert.ok(!ids({ ...base, total_calendar_events: 0, total_subscribed_events: 0, calendar_status: 'not_in_backup' }).includes('calendar'));
  assert.ok(ids({ ...base, total_calendar_events: 0, total_subscribed_events: 5, calendar_status: 'ok' }).includes('calendar'));
  assert.ok(ids({ ...base, total_calendar_events: 4, total_subscribed_events: 0, calendar_status: 'ok' }).includes('calendar'));
  assert.ok(ids({ ...base, calendar_status: 'error' }).includes('calendar'));
  const order = s.DATA_SECTIONS.map(x => x.id);
  assert.equal(order.indexOf('voice_memos'), order.indexOf('podcasts') + 1, 'Voice Memos after Podcasts');
  assert.equal(order.indexOf('calendar'), order.indexOf('voice_memos') + 1, 'Calendar after Voice Memos');
  assert.ok(s.missingKinds({ ...base, total_calendar_events: 0, total_subscribed_events: 0 }, true).includes('calendar'));
  assert.ok(!s.missingKinds({ ...base, total_calendar_events: 0, total_subscribed_events: 5 }, true).includes('calendar'));
  assert.ok(!s.missingKinds({ ...base, total_calendar_events: 0, calendar_status: 'error' }, true).includes('calendar'));
  assert.deepEqual(s.SCOPED.calendar, { placeholder: 'Search calendar', items: 'events' });
  assert.equal(s.sectionFor('calendar').label, 'Calendar');
  assert.notEqual(s.sectionFor('calendar').icon, s.YEAR.icon, 'Calendar and Year look different');
});

rerunInTimeZones(import.meta.url);
