// Tests for the Calendar screen (src/components/explore/CalendarExplorer.tsx):
// what it asks the engine for, the list of calendars (the person's own grouped
// by account, then the quiet Other calendars, never part of All calendars),
// Upcoming and Past split at the backup's date, the agenda's days and rows
// (all-day, several days, floating, in a time zone), a repeating event listed
// once with how it repeats, an event's details, search, saving (all calendars,
// or the open one), and the empty and unreadable states. The component runs in
// a small stand-in for React's hooks (as in podcasts-screen.test.mjs) and
// renders with react-dom/server. The file re-runs itself in other time zones
// (last line): an all-day or floating event must land on the same day in all of
// them. Data is fictional, with example.com addresses.
// Run with: node --test scripts/calendar-screen.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeBridge, loadTs } from './test-helpers/load-ts.mjs';
import { enUS, rerunInTimeZones } from './test-helpers/time-zones.mjs';

// ── A stand-in for React's hooks ─────────────────────────────────────────────

// With `memo`, useMemo keeps its value until a dependency changes, as React's does
function hooksRuntime({ memo = false } = {}) {
  let current = null;
  const R = {
    useState(init) {
      const c = current, k = c.i++;
      if (!(k in c.slots)) c.slots[k] = { value: typeof init === 'function' ? init() : init };
      const s = c.slots[k];
      return [s.value, v => { s.value = typeof v === 'function' ? v(s.value) : v; }];
    },
    useRef(init) {
      const c = current, k = c.i++;
      if (!(k in c.slots)) c.slots[k] = { current: init };
      return c.slots[k];
    },
    useEffect(fn, deps) {
      const c = current, k = c.i++;
      const prev = c.slots[k];
      if (prev && deps && prev.deps && deps.length === prev.deps.length && deps.every((d, j) => Object.is(d, prev.deps[j]))) return;
      c.queue.push({ k, fn, deps });
    },
    useMemo: memo
      ? (fn, deps) => {
        const c = current;
        if (!c) return fn(); // a child react-dom renders (Highlight)
        const k = c.i++;
        const prev = c.slots[k];
        if (prev && deps && prev.deps && deps.length === prev.deps.length && deps.every((d, j) => Object.is(d, prev.deps[j]))) return prev.value;
        c.slots[k] = { deps, value: fn() };
        return c.slots[k].value;
      }
      : fn => fn(),
    useCallback: fn => fn,
  };

  function mount(Component, props) {
    const c = { slots: [], i: 0, queue: [], props, out: null };
    const render = () => {
      current = c;
      c.i = 0;
      try { c.out = Component(c.props); } finally { current = null; }
      const queue = c.queue;
      c.queue = [];
      for (const { k, fn, deps } of queue) {
        c.slots[k]?.cleanup?.();
        c.slots[k] = { deps, cleanup: fn() };
      }
    };
    render();
    return {
      get out() { return c.out; },
      rerender(next) { if (next) c.props = { ...c.props, ...next }; render(); return c.out; },
    };
  }
  return { R, mount };
}

function find(tree, test) {
  if (tree == null || typeof tree !== 'object') return null;
  if (Array.isArray(tree)) {
    for (const x of tree) { const f = find(x, test); if (f) return f; }
    return null;
  }
  if (test(tree)) return tree;
  return find(tree.props?.children, test) ?? find(tree.props?.actions, test);
}

function findAll(tree, test, out = []) {
  if (tree == null || typeof tree !== 'object') return out;
  if (Array.isArray(tree)) { tree.forEach(x => findAll(x, test, out)); return out; }
  if (test(tree)) out.push(tree);
  findAll(tree.props?.children, test, out);
  return out;
}

const settle = async () => { for (let i = 0; i < 6; i++) await new Promise(r => setTimeout(r, 0)); };
const plain = s => s.replace(/\s+/g, ' ');

// ── Fictional data ───────────────────────────────────────────────────────────

const ICLOUD = { id: 2, name: 'iCloud', type: 'caldav', disabled: false };
const calendar = over => ({
  id: 1, title: 'Home', color: '#34AADC', account: ICLOUD, kind: 'normal', read_only: false, subscription_url: null,
  sharing: 'not_shared', owner_email: 'me@example.com', event_count: 0, ...over,
});
const event = over => ({
  id: 1, uid: null, calendar_id: 1, title: 'Event', notes: null, url: null, conference_url: null,
  all_day: false, floating: false, start: null, end: null, start_day: null, end_day: null, days: null,
  wall_start: null, wall_end: null, time_zone: null, end_time_zone: null, status: 'none', availability: 'busy',
  location: null, recurrence: null, exceptions: [], detached_from: null, organizer: null, attendees: [], alarms: [],
  year_unknown: false, created_date: null, modified_date: null, repeats: null, ...over,
});
const allDay = (start_day, end_day, over) => event({ all_day: true, floating: true, start_day, end_day, days: 1, ...over });
const WEEKLY = { frequency: 'weekly', interval: 1, count: null, until: null, by_day: ['TU'], by_month_day: [], by_month: [], by_set_pos: [], by_year_day: [], by_week_no: [], week_start: 'SU', last_start: null };

const PERSONAL = calendar({ id: 3, title: 'Personal', account: { id: 1, name: 'Default', type: 'local', disabled: false }, color: '#FF9500' });
const HOME = calendar({ id: 1, title: 'Home', event_count: 4 });
const WORK = calendar({ id: 2, title: 'Work', color: '#CC73E1', event_count: 2 });
const HOLIDAYS = calendar({ id: 4, title: 'US Holidays', kind: 'holidays', account: { id: 5, name: 'Subscribed Calendars', type: 'subscribed', disabled: false }, read_only: true, event_count: 2 });
const BIRTHDAYS = calendar({ id: 5, title: 'Birthdays', kind: 'birthdays', account: { id: 6, name: 'Other', type: 'other', disabled: false }, event_count: 0 });
const CALENDARS = [PERSONAL, HOME, WORK, HOLIDAYS, BIRTHDAYS];

// The backup was made on Nov 20, 2026
const BACKUP = '2026-11-20T18:00:00+00:00';
const EVENTS = [
  // Home: a trip after the backup, a weekly series that started in January, a floating appointment, a cancelled evening
  allDay('2026-12-24', '2026-12-26', { id: 10, calendar_id: 1, title: 'Trip to the coast', days: 3, alarms: [{ seconds_before: -32400 }, { seconds_before: 54000 }] }),
  event({
    id: 11, calendar_id: 1, title: 'Climbing', start: '2026-01-07T02:00:00+00:00', end: '2026-01-07T04:00:00+00:00',
    time_zone: 'America/Los_Angeles', recurrence: WEEKLY, repeats: 'Every week on Tuesday', exceptions: ['2026-02-03T02:00:00+00:00'],
    location: { title: 'Example Gym', address: '12 Rock St', latitude: null, longitude: null },
  }),
  event({ id: 12, calendar_id: 1, title: 'Dentist', floating: true, wall_start: '2026-03-02T09:00:00', wall_end: '2026-03-02T10:00:00', location: { title: 'Bright Smiles', address: null, latitude: null, longitude: null } }),
  event({ id: 13, calendar_id: 1, title: 'Book club', status: 'cancelled', start: '2026-04-10T02:00:00+00:00', end: '2026-04-10T04:00:00+00:00', time_zone: 'America/Los_Angeles' }),
  // Work: a meeting after the backup, with people, an alert and a meeting link; a kickoff before it
  event({
    id: 20, calendar_id: 2, title: 'Design review', start: '2026-12-01T17:00:00+00:00', end: '2026-12-01T18:00:00+00:00',
    time_zone: 'America/New_York', conference_url: 'https://meet.example.com/abc', url: 'https://example.com/agenda',
    notes: 'Bring the floor plans', alarms: [{ seconds_before: 900 }],
    organizer: { name: 'Pat Doe', email: 'pat@example.com', is_me: false },
    attendees: [
      { name: 'Jane Roe', email: 'me@example.com', phone: null, status: 'accepted', role: 'required', type: 'person', is_me: true },
      { name: null, email: 'robin@example.com', phone: null, status: 'tentative', role: 'optional', type: 'person', is_me: false },
    ],
  }),
  event({ id: 21, calendar_id: 2, title: 'Kickoff', start: '2026-02-02T17:00:00+00:00', end: '2026-02-02T18:00:00+00:00', time_zone: 'America/Los_Angeles' }),
  // US Holidays: one before the backup, one after it
  allDay('2026-07-04', '2026-07-04', { id: 40, calendar_id: 4, title: 'Independence Day' }),
  allDay('2026-11-26', '2026-11-26', { id: 41, calendar_id: 4, title: 'Thanksgiving' }),
];

const engine = method => {
  if (method === 'list_calendars') return { calendars: CALENDARS };
  if (method === 'list_calendar_events') return { events: EVENTS, hidden_count: 0 };
  throw new Error(`unexpected ${method}`);
};

function screen(t, answers, extra = {}, { memo = false, stubs: more = {} } = {}) {
  const bridge = fakeBridge({
    call: async (method, params) => {
      const a = answers(method, params);
      return a && 'success' in a ? a : { success: true, data: a };
    },
    openExternal: () => {},
    saveFolder: async () => '/Users/jane/Desktop',
    ...extra,
  });
  t.after(bridge.restore);
  const { R, mount } = hooksRuntime({ memo });
  const saves = [];
  const areas = [];
  const stubs = {
    react: R,
    '../../hooks/useSaveAction': { useSaveAction: area => { areas.push(area); return { busy: false, run: fn => { saves.push(fn); } }; } },
    '../shared/Feedback': { ReportProblemButton: ({ area }) => createElement('button', { 'data-report': area }, 'Report this problem') },
    '../shared/OrganicLoader': () => createElement('span', { 'data-loader': '' }),
    ...more,
  };
  const CalendarExplorer = loadTs('src/components/explore/CalendarExplorer.tsx', { stubs }).default;
  return { bridge, saves, areas, mount: props => mount(CalendarExplorer, { udid: 'u1', query: '', backupDate: BACKUP, ...props }) };
}

const calls = bridge => bridge.calls.filter(c => c[0] === 'call').map(c => [c[1], c[2]]);
const html = probe => renderToStaticMarkup(probe.out);
const navButton = (probe, title) => find(probe.out, el => el.props?.title === title && typeof el.props?.onClick === 'function' && 'dot' in el.props);
const header = probe => find(probe.out, el => typeof el.props?.onView === 'function');
const eventRow = (probe, id) => findAll(probe.out, el => el.props?.event && typeof el.props?.onToggle === 'function').find(r => r.props.event.id === id);

async function opened(t, answers = engine, props = {}) {
  const s = screen(t, answers);
  const probe = s.mount(props);
  await settle();
  probe.rerender();
  await settle();
  probe.rerender();
  return { ...s, probe };
}

async function pick(probe, title) {
  navButton(probe, title).props.onClick();
  probe.rerender();
  await settle();
  probe.rerender();
}

// ── With events ──────────────────────────────────────────────────────────────

test('opens on All calendars, upcoming first: the person\'s own events, grouped by account, other calendars apart', async t => {
  const { bridge, probe, areas } = await opened(t);
  assert.deepEqual(calls(bridge), [['list_calendars', { udid: 'u1' }], ['list_calendar_events', { udid: 'u1' }]]);
  assert.ok(areas.every(a => a === 'calendar'), 'saves report under Calendar');
  const out = html(probe);
  assert.match(out, /6 events/, 'the person\'s own events; holidays aren\'t counted');
  // The list: All calendars, then each account's calendars, then Other calendars
  for (const label of ['All calendars', '>On My iPhone<', '>iCloud<', '>Other calendars<', 'US Holidays']) assert.match(out, new RegExp(label));
  assert.ok(out.indexOf('>On My iPhone<') < out.indexOf('>iCloud<') && out.indexOf('>iCloud<') < out.indexOf('>Other calendars<'));
  assert.ok(out.indexOf('>Other calendars<') < out.indexOf('US Holidays'));
  assert.match(out, /aria-current="true"[^>]*>.*?All calendars/);
  assert.match(out, /Holidays · 2 events/);
  // An other calendar without events (Birthdays, always empty in a backup) isn't listed; an empty one of the person's own is
  assert.doesNotMatch(out, /Birthdays/);
  assert.match(out, />Personal<[\s\S]*?No events/);
  assert.match(out, /style="background-color:#CC73E1"/, 'each calendar has its colour');
  // Upcoming, as of the backup: the meeting and the trip; not Thanksgiving (another calendar), nothing past
  assert.match(out, /aria-pressed="true"[^>]*>Upcoming <span class="tabular-nums">2<\/span>/);
  assert.match(out, />Past <span class="tabular-nums">4<\/span>/);
  assert.ok(out.indexOf('Design review') < out.indexOf('Trip to the coast'), 'upcoming runs forward');
  assert.doesNotMatch(out, /Thanksgiving|Independence Day/);
  assert.doesNotMatch(out, /Dentist|Kickoff/);
  if (enUS) {
    // The backup's day on this computer's calendar (Nov 21 east of about UTC+6)
    const day = new Date(BACKUP).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    assert.ok(out.includes(`Upcoming and past as of the backup on ${day}. A repeating event is listed once, on the day it started.`));
    assert.match(out, /Thursday, December 24, 2026/, 'the trip under its own day');
    assert.match(out, />Dec 24 – Dec 26</, 'several days');
  }
  assert.doesNotMatch(out, /<img/);
  assert.doesNotMatch(out, /\bError\b/);
});

test('Past runs back from the backup a day at a time: the series once, at its start, with how it repeats', async t => {
  const { probe } = await opened(t);
  header(probe).props.onView('past');
  const out = html({ out: probe.rerender() });
  assert.match(out, /aria-pressed="true"[^>]*>Past/);
  const order = ['Book club', 'Dentist', 'Kickoff', 'Climbing'].map(x => out.indexOf(x));
  assert.ok(order.every((x, i) => x > 0 && (i === 0 || x > order[i - 1])), `newest first: ${order}`);
  assert.equal(out.split('>Climbing<').length, 2, 'a repeating event is listed once');
  assert.match(out, />Repeats every week on Tuesday</);
  assert.match(out, />Cancelled</);
  assert.match(out, /line-through/);
  if (enUS) {
    assert.match(out, /Monday, March 2, 2026/, 'a floating event is on its own day in every zone');
    assert.match(plain(out), />9:00 – 10:00 AM</, 'and at its own time');
  }
});

test('an event\'s details: when, where, who and their answers, alerts, links (through openExternal), notes, calendar', async t => {
  const { bridge, probe } = await opened(t);
  eventRow(probe, 20).props.onToggle();
  probe.rerender();
  const row = eventRow(probe, 20);
  assert.equal(row.props.open, true);
  const out = renderToStaticMarkup(row);
  assert.match(out, /aria-expanded="true"/);
  assert.match(out, />When</);
  assert.match(out, /Organized by Pat Doe/);
  assert.match(out, /Jane Roe<\/span> \(you\)|Jane Roe \(you\)/);
  assert.match(out, /· Accepted/);
  assert.match(out, /robin@example\.com/);
  assert.match(out, /· Maybe/);
  assert.match(out, />Alert</);
  assert.match(out, /15 minutes before/);
  assert.match(out, /Bring the floor plans/);
  assert.match(out, />Calendar</);
  assert.match(out, /Work/);
  const details = find(row.type(row.props), el => el.props?.event && el.props?.calendar !== undefined && !el.props.onToggle);
  const tree = details.type(details.props);
  find(tree, el => el.type === 'button' && el.props.children === 'Open the meeting link').props.onClick();
  find(tree, el => el.type === 'button' && el.props.children === "Open the event's link").props.onClick();
  assert.deepEqual(bridge.calls.filter(c => c[0] === 'openExternal'), [
    ['openExternal', 'https://meet.example.com/abc'], ['openExternal', 'https://example.com/agenda'],
  ]);
});

test('an all-day event\'s alerts are a time of day, as the spreadsheet says them', async t => {
  const { probe } = await opened(t);
  eventRow(probe, 10).props.onToggle();
  probe.rerender();
  const out = renderToStaticMarkup(eventRow(probe, 10));
  assert.match(out, />Alerts</);
  assert.match(out, /On the day at 9:00 AM, 1 day before at 9:00 AM/);
  assert.doesNotMatch(out, /hours (after|before)/);
});

test('a repeating event\'s details: how it repeats and the dates it skipped; a floating one says it has no time zone', async t => {
  const { probe } = await opened(t);
  header(probe).props.onView('past');
  probe.rerender();
  eventRow(probe, 11).props.onToggle();
  probe.rerender();
  let out = renderToStaticMarkup(eventRow(probe, 11));
  assert.match(out, />Repeats</);
  assert.match(out, /Repeats every week on Tuesday/);
  assert.match(out, /Skipped on /);
  assert.match(out, /Example Gym/);
  assert.match(out, /12 Rock St/);
  eventRow(probe, 12).props.onToggle();
  probe.rerender();
  out = renderToStaticMarkup(eventRow(probe, 12));
  assert.match(out, /This event has no time zone, so it&#x27;s at this time wherever you are\./);
  assert.equal(eventRow(probe, 11).props.open, false, 'one open at a time');
});

test('another calendar opens on its own, apart from All calendars, on what\'s coming', async t => {
  const { bridge, probe } = await opened(t);
  await pick(probe, 'US Holidays');
  const out = html(probe);
  assert.match(out, /aria-label="US Holidays"/);
  assert.match(out, /2 events/);
  assert.match(out, /Holidays · Read only|Holidays · 2 events/);
  assert.match(out, /Thanksgiving/);
  assert.doesNotMatch(out, /Design review|Trip to the coast/);
  assert.match(out, />All day</);
  if (enUS) assert.match(out, /Thursday, November 26, 2026/, 'an all-day holiday on its own day in every zone');
  assert.equal(calls(bridge).filter(([m]) => m === 'list_calendar_events').length, 1, 'the events were read once');
  // Its Past: the other holiday
  header(probe).props.onView('past');
  assert.match(html({ out: probe.rerender() }), /Independence Day/);
  // A calendar of the person's own
  await pick(probe, 'Work');
  const work = html(probe);
  assert.match(work, /aria-label="Work"/);
  assert.match(work, /iCloud · 2 events/);
  assert.match(work, /Design review/);
  assert.doesNotMatch(work, /Trip to the coast/);
});

test('with nothing coming, a calendar opens on its past', async t => {
  const { probe } = await opened(t);
  await pick(probe, 'Home');
  assert.match(html(probe), /aria-pressed="true"[^>]*>Upcoming/, 'Home has the trip');
  const past = EVENTS.filter(e => e.id !== 10);
  const s2 = await opened(t, method => (method === 'list_calendar_events' ? { events: past } : engine(method)));
  await pick(s2.probe, 'Home');
  assert.match(html(s2.probe), /aria-pressed="true"[^>]*>Past/);
});

test('with no other calendar that has events, there\'s no Other calendars heading', async t => {
  const { probe } = await opened(t, method => (
    method === 'list_calendars' ? { calendars: [PERSONAL, HOME, WORK, BIRTHDAYS] } : { events: EVENTS.filter(e => e.calendar_id !== 4) }
  ));
  const out = html(probe);
  assert.match(out, /Trip to the coast/);
  assert.doesNotMatch(out, /Other calendars|Birthdays/);
});

test('with no events of the person\'s own, the screen opens on the first other calendar that has some', async t => {
  const cals = [calendar({ id: 1, title: 'Home', event_count: 0 }), HOLIDAYS];
  const { probe } = await opened(t, method => (
    method === 'list_calendars' ? { calendars: cals } : { events: EVENTS.filter(e => e.calendar_id === 4) }
  ));
  const out = html(probe);
  assert.match(out, /aria-label="US Holidays"/);
  assert.match(out, /Thanksgiving/);
});

test('the search box looks through titles, places, notes and people, and says where matches are', async t => {
  const { probe } = await opened(t);
  let out = html({ out: probe.rerender({ query: 'pat doe' }) });
  assert.match(out, /1 of 6 events/);
  assert.match(out, /Design review/);
  assert.match(out, /1 event matches/);
  assert.doesNotMatch(out, /1 event match</);
  assert.match(out, /No matches/, 'Home has none');
  out = html({ out: probe.rerender({ query: 'bright smiles' }) });
  assert.match(out, /No upcoming events match &quot;bright smiles&quot;/, 'a match in the past isn\'t in Upcoming');
  assert.match(out, />Past <span class="tabular-nums">1<\/span>/);
  out = html({ out: probe.rerender({ query: 'xylophone' }) });
  assert.match(out, /0 of 6 events/);
  assert.match(out, /No events match &quot;xylophone&quot;/);
  assert.match(out, /Try an event&#x27;s title, its place, its notes or someone on it\./);
});

test('Save offers calendar files and a spreadsheet: every calendar from All, the open one from a calendar', async t => {
  const { bridge, probe, saves } = await opened(t, (method, params) => (
    method === 'export_calendar'
      ? params.calendar_id == null
        ? { status: 'success', count: 8, calendars: 3, path: `${params.output_dir}/Calendar`, files: ['a', 'b', 'c'] }
        : { status: 'success', count: 2, path: `${params.output_dir}/Work.ics`, files: [`${params.output_dir}/Work.ics`] }
      : engine(method)
  ));
  const button = () => find(probe.out, el => el.props?.label === 'Save' && el.props?.onClick);
  assert.equal(button().props.disabled, false);
  button().props.onClick();
  let dialog = find(probe.rerender(), el => Array.isArray(el.props?.formats));
  assert.equal(dialog.props.title, 'Save every calendar');
  assert.deepEqual(dialog.props.formats.map(f => f.id), ['ics', 'csv']);
  assert.equal(dialog.props.formats[0].label, 'Calendar file');
  dialog.props.onSave('ics');
  let result = await saves[0]();
  assert.deepEqual(calls(bridge).at(-1), ['export_calendar', { udid: 'u1', output_dir: '/Users/jane/Desktop', format: 'ics' }]);
  assert.deepEqual(result, { title: 'Saved 8 events', detail: '3 calendar files, for Calendar, Outlook or Google', path: '/Users/jane/Desktop/Calendar' });

  probe.rerender();
  await pick(probe, 'Work');
  button().props.onClick();
  dialog = find(probe.rerender(), el => Array.isArray(el.props?.formats));
  assert.equal(dialog.props.title, 'Save "Work"');
  dialog.props.onSave('ics');
  result = await saves[1]();
  assert.deepEqual(calls(bridge).at(-1), ['export_calendar', { udid: 'u1', output_dir: '/Users/jane/Desktop', format: 'ics', calendar_id: 2 }]);
  assert.equal(result.title, 'Saved 2 events');
  assert.equal(result.path, '/Users/jane/Desktop/Work.ics');
});

test('without the backup\'s date, upcoming and past are as of today', async t => {
  const { probe } = await opened(t, engine, { backupDate: null });
  assert.match(html(probe), /Upcoming and past as of today\./);
});

test('without the backup\'s date, "today" is taken once, so the agenda isn\'t rebuilt on every render', async t => {
  const real = loadTs('src/lib/calendar.ts');
  let built = 0;
  const lib = { ...real, agenda: (...args) => { built++; return real.agenda(...args); } };
  const s = screen(t, engine, {}, { memo: true, stubs: { '../../lib/calendar': lib } });
  const probe = s.mount({ backupDate: null });
  await settle();
  probe.rerender();
  await settle();
  probe.rerender();
  const before = built;
  assert.ok(before > 0, 'the agenda was built');
  await new Promise(r => setTimeout(r, 5));
  probe.rerender();
  probe.rerender();
  assert.equal(built, before, 'and not built again while nothing changed');
  assert.match(html(probe), /Upcoming and past as of today\./);
  assert.match(html(probe), /Design review/);
});

// ── Without events ───────────────────────────────────────────────────────────

test('no calendar in the backup: calm, with nothing to report, nothing to save and nothing more asked', async t => {
  const { bridge, probe } = await opened(t, () => ({ calendars: [], empty_reason: 'not_in_backup' }));
  const out = html(probe);
  assert.match(out, /No calendar events in this backup/);
  assert.match(out, /This iPhone&#x27;s calendar wasn&#x27;t in the backup\./);
  assert.doesNotMatch(out, /data-report/);
  assert.doesNotMatch(out, /Couldn|\bError\b/);
  assert.equal(find(probe.out, el => el.props?.label === 'Save' && el.props?.onClick).props.disabled, true);
  assert.deepEqual(calls(bridge), [['list_calendars', { udid: 'u1' }]]);
});

test('calendars without a single event are calm too, and their events aren\'t asked for', async t => {
  const { bridge, probe } = await opened(t, method => (method === 'list_calendars' ? { calendars: [calendar({ event_count: 0 })] } : assert.fail(method)));
  const out = html(probe);
  assert.match(out, /Calendar is on this iPhone, but it doesn&#x27;t have any events\./);
  assert.doesNotMatch(out, /data-report/);
  assert.deepEqual(calls(bridge), [['list_calendars', { udid: 'u1' }]]);
  const s2 = await opened(t, () => ({ calendars: [], empty_reason: 'no_records' }));
  assert.match(html(s2.probe), /Calendar is on this iPhone, but it doesn&#x27;t have any events\./);
});

test('a calendar that can\'t be read, or an older format, says so with a Report button', async t => {
  let answer = { calendars: [], error: 'Calendar is in this backup but could not be read. The backup may be incomplete or damaged.' };
  const s1 = await opened(t, () => answer);
  let out = html(s1.probe);
  assert.match(out, /Couldn&#x27;t read the calendar/);
  assert.match(out, /could not be read/);
  assert.match(out, /data-report="calendar"/);

  answer = { calendars: [], error: "This backup's calendar is in an older format OpenExtract can't read yet.", empty_reason: 'unsupported_format' };
  const s2 = await opened(t, () => answer);
  out = html(s2.probe);
  assert.match(out, /This version of Calendar can&#x27;t be read yet/);
  assert.match(out, /older format/);
  assert.match(out, /data-report="calendar"/);

  const s3 = await opened(t, () => ({ success: false, error: 'The engine stopped.' }));
  out = html(s3.probe);
  assert.match(out, /Couldn&#x27;t read the calendar/);
  assert.match(out, /data-report="calendar"/);
});

test('events that can\'t be read show the error and a Report button, and are asked for again when another calendar opens', async t => {
  let broken = true;
  const { bridge, probe } = await opened(t, method => (
    method === 'list_calendar_events' && broken ? { events: [], error: 'Calendar is in this backup but could not be read.' } : engine(method)
  ));
  let out = html(probe);
  assert.match(out, /Couldn&#x27;t read the events/);
  assert.match(out, /data-report="calendar"/);
  assert.match(out, /6 events/, 'the calendars\' own counts, meanwhile');
  broken = false;
  await pick(probe, 'Work');
  assert.equal(calls(bridge).filter(([m]) => m === 'list_calendar_events').length, 2);
  out = html(probe);
  assert.match(out, /Design review/);
  assert.doesNotMatch(out, /Couldn&#x27;t read the events/);
});

rerunInTimeZones(import.meta.url);
