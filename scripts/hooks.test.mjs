// Tests for the plain logic inside the React hooks (src/hooks/*.ts), without a
// React test framework:
//  - the record normalizers in useTimeline.ts (engine rows → Timeline entries),
//    including private ones, exposed by load-ts;
//  - useTimeline's filtering, which is pure within one render: a stand-in for
//    React runs the hook once with useMemo/useCallback called straight through;
//  - latestYear (useYearCounts.ts) and releaseNotesUrl (useUpdates.ts).
// Hook state over time (loading, paging, retries) is left to the end-to-end UI tests.
// Run with: node --test scripts/hooks.test.mjs (also re-runs itself in other time zones)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';
import { rerunInTimeZones } from './test-helpers/time-zones.mjs';

// One render's worth of React: state starts at its initial value, memos and
// callbacks run straight through, effects are collected to run by hand.
const effects = [];
const oneRender = {
  useState: init => [typeof init === 'function' ? init() : init, () => {}],
  useMemo: fn => fn(),
  useCallback: fn => fn,
  useRef: current => ({ current }),
  useEffect: fn => { effects.push(fn); },
};

const timeline = loadTs('src/hooks/useTimeline.ts', {
  stubs: { react: oneRender },
  expose: ['appDisplayName', 'normalizePhoto', 'normalizeNote', 'normalizeBrowserVisit', 'dedupe'],
});
const { normalizeMessage, normalizeCall, normalizeVoicemail, normalizePhoto, normalizeNote,
  normalizeBrowserVisit, dedupe, appDisplayName, useTimeline } = timeline;
const { latestYear } = loadTs('src/hooks/useYearCounts.ts', { stubs: { react: oneRender }, expose: ['latestYear'] });
const { releaseNotesUrl } = loadTs('src/hooks/useUpdates.ts', { stubs: { react: oneRender } });
const { buildContactOptions, buildIdentifierGroupMap } = loadTs('src/lib/people.ts');

const local = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(y, mo - 1, d, h, mi, s, ms);
const engine = date => date.toISOString().replace('Z', '+00:00');
const dayKey = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

// ── Records as the engine sends them ─────────────────────────────────────────
const MOM_CHAT = {
  chat_id: 12, chat_identifier: '+15035550123', display_name: 'Mom', service: 'iMessage',
  message_count: 1532, last_message_date: '2024-03-10T09:59:59+00:00', last_message_preview: 'ok', is_group: false,
};
const msg = (id, date, text, over = {}) => ({
  message_id: id, text, message_type: 'text', date: engine(date), is_from_me: false,
  sender: '+15035550123', sender_handle: '+15035550123', has_attachments: false, is_reaction: false, ...over,
});
const UUID = '5B9C7F2E-1D3A-4E8B-9F60-2A7C1E4D8B93';

test('normalizeMessage: a message in its conversation', () => {
  const e = normalizeMessage(msg(9001, local(2024, 3, 10, 8, 15), 'Running late 🚗', { is_from_me: true }), MOM_CHAT);
  assert.equal(e.id, 'message:9001');
  assert.equal(e.type, 'message');
  assert.equal(e.contactName, 'Mom');
  assert.equal(e.contactIdentifier, '+15035550123');
  assert.deepEqual(e.message, {
    text: 'Running late 🚗', isFromMe: true, sender: '+15035550123', messageType: 'text',
    conversationName: 'Mom', service: 'iMessage', chatId: 12, isGroup: false,
  });
  // An unnamed conversation goes by its handle
  const unnamed = normalizeMessage(msg(1, local(2024, 1, 1), null), { ...MOM_CHAT, display_name: '' });
  assert.equal(unnamed.contactName, '+15035550123');
  assert.equal(unnamed.message.conversationName, '+15035550123');
});

test('normalizeCall: names, numbers, and app calls with UUID addresses', () => {
  const base = { call_id: 77, date: '2024-03-10T18:02:11+00:00', duration: 125.4, direction: 'outgoing', status: 'answered', app: 'com.apple.Telephony' };
  const named = normalizeCall({ ...base, address: '+14065550109', contact_name: 'Mom' });
  assert.deepEqual([named.id, named.contactName, named.contactIdentifier], ['call:77', 'Mom', '+14065550109']);
  assert.deepEqual(named.call, { direction: 'outgoing', status: 'answered', duration: 125.4, app: 'com.apple.Telephony' });

  assert.equal(normalizeCall({ ...base, address: '+14065550109', contact_name: '' }).contactName, '+14065550109');
  // WhatsApp/Messenger calls: the address is a UUID, the app names the caller
  const fb = normalizeCall({ ...base, address: UUID, contact_name: UUID, app: 'T84QZS65DQ.com.facebook.Facebook' });
  assert.deepEqual([fb.contactName, fb.contactIdentifier], ['Facebook', null]);
  assert.equal(normalizeCall({ ...base, address: UUID.toLowerCase(), contact_name: '', app: 'net.whatsapp.WhatsApp' }).contactName, 'WhatsApp');
  assert.equal(normalizeCall({ ...base, address: UUID, contact_name: 'Ana', app: 'net.whatsapp.WhatsApp' }).contactName, 'Ana');
  assert.deepEqual([normalizeCall({ ...base, address: UUID, contact_name: '', app: '' }).contactName], [null]);
  // A missing address doesn't throw
  assert.equal(normalizeCall({ ...base, address: null, contact_name: null, app: '' }).contactName, null);
});

test('appDisplayName strips the team id and keeps the last part of the bundle id', () => {
  assert.equal(appDisplayName('T84QZS65DQ.com.facebook.Facebook'), 'Facebook');
  assert.equal(appDisplayName('net.whatsapp.WhatsApp'), 'WhatsApp');
  assert.equal(appDisplayName('com.apple.Telephony'), 'Telephony');
  assert.equal(appDisplayName('Signal'), 'Signal');
  assert.equal(appDisplayName('com.example.'), 'com.example.');
});

test('normalizeVoicemail: the number stands in for a missing name', () => {
  const vm = { id: 5, phone_number: '+14065550109', contact_name: '', date_received: '2024-03-10T09:59:59+00:00', duration: 45, is_read: false };
  const e = normalizeVoicemail(vm);
  assert.deepEqual([e.id, e.contactName, e.contactIdentifier, e.timestamp], ['voicemail:5', '+14065550109', '+14065550109', vm.date_received]);
  assert.deepEqual(e.voicemail, { duration: 45, transcript: '', phoneNumber: '+14065550109' });
  assert.equal(normalizeVoicemail({ ...vm, contact_name: 'Dr. Alvarez', transcript: 'Your appointment…' }).contactName, 'Dr. Alvarez');
});

test('normalizePhoto: photos without a date are left off the Timeline', () => {
  const p = { uuid: 'A1B2', filename: 'IMG_0001.HEIC', file_hash: 'f00d', kind: 'live_photo', width: 4032, height: 3024, duration: 0 };
  assert.equal(normalizePhoto({ ...p, date_created: null }), null);
  assert.equal(normalizePhoto({ ...p, date_created: '' }), null);
  const e = normalizePhoto({ ...p, date_created: '2024-03-10T09:59:59+00:00' });
  assert.deepEqual([e.id, e.timestamp, e.contactName], ['photo:A1B2', '2024-03-10T09:59:59+00:00', null]);
  assert.deepEqual(e.photo, { filename: 'IMG_0001.HEIC', fileHash: 'f00d', kind: 'live_photo', width: 4032, height: 3024, duration: 0 });
});

test('normalizeNote: dated by creation, titled, with a 120-character preview', () => {
  const body = 'x'.repeat(300);
  const e = normalizeNote({ note_id: 'p123', title: '', body, created: '', modified: '2024-03-10T09:59:59+00:00' });
  assert.equal(e.id, 'note:p123');
  assert.equal(e.timestamp, '2024-03-10T09:59:59+00:00');
  assert.equal(e.note.title, 'Untitled');
  assert.equal(e.note.bodyPreview.length, 120);
  assert.equal(e.note.body, body);
  const empty = normalizeNote({ note_id: 3, title: 'Groceries', body: null, created: '2024-01-01T00:00:00+00:00', modified: '' });
  assert.deepEqual([empty.timestamp, empty.note.bodyPreview, empty.note.body], ['2024-01-01T00:00:00+00:00', '', '']);
});

// Half an emoji shows as a broken character (U+FFFD once written to a file)
test("a note's preview doesn't cut an emoji in half", () => {
  const body = `${'a'.repeat(119)}🎂 birthday`;
  const preview = normalizeNote({ note_id: 1, title: 't', body, created: '', modified: '' }).note.bodyPreview;
  assert.ok(!/[\uD800-\uDBFF]$/.test(preview), 'preview ends with a lone high surrogate');
});

test('normalizeBrowserVisit: undated visits, and titles falling back to the domain or URL', () => {
  const v = { visit_id: 's_42', url: 'https://www.nhl.com/scores', title: '', domain: 'www.nhl.com', visit_date: null, browser: 'safari', visit_count: null };
  const e = normalizeBrowserVisit(v);
  assert.deepEqual([e.id, e.timestamp], ['browser:s_42', '']);
  assert.deepEqual(e.browser, { url: v.url, title: 'www.nhl.com', domain: 'www.nhl.com', browserName: 'safari' });
  assert.equal(normalizeBrowserVisit({ ...v, domain: '' }).browser.title, 'https://www.nhl.com/scores');
  assert.equal(normalizeBrowserVisit({ ...v, title: 'Scores' }).browser.title, 'Scores');
});

test('dedupe keeps the first copy of a message that is in two chats', () => {
  const a = normalizeMessage(msg(1, local(2024, 1, 1), 'hi'), MOM_CHAT);
  const b = normalizeMessage(msg(1, local(2024, 1, 1), 'hi'), { ...MOM_CHAT, chat_id: 13, display_name: 'Mom (SMS)' });
  const c = normalizeMessage(msg(2, local(2024, 1, 1), 'there'), MOM_CHAT);
  const out = dedupe([a, b, c]);
  assert.deepEqual(out.map(e => e.id), ['message:1', 'message:2']);
  assert.equal(out[0].message.conversationName, 'Mom');
  assert.deepEqual(dedupe([]), []);
});

// ── useTimeline's filters ────────────────────────────────────────────────────
function indexOf(entries, contacts = []) {
  const days = [];
  const sorted = [...entries].sort((a, b) => (b.timestamp ?? '').localeCompare(a.timestamp ?? ''));
  return {
    days,
    index: {
      entries: sorted,
      contacts: buildContactOptions(sorted),
      addressBook: [],
      identifierGroupMap: buildIdentifierGroupMap(contacts),
      counts: {}, loading: false, loadingTypes: new Set(), errors: {}, messageCap: null,
      loadAllMessages: async () => {}, loadDay: day => days.push(day), refresh: () => {},
    },
  };
}
const ALL_TYPES = new Set(['message', 'call', 'photo', 'voicemail', 'note', 'browser']);
const filtered = (index, filters) => useTimeline(index, { types: ALL_TYPES, ...filters }).filteredEntries.map(e => e.id);

const DAYS = [[2024, 3, 10], [2024, 3, 31], [2024, 4, 7], [2024, 10, 6], [2024, 11, 3], [2024, 2, 29], [2024, 12, 31]];

test('a day filter keeps local midnight to local midnight, including DST days', () => {
  for (const [y, m, d] of DAYS) {
    const at = (id, date) => normalizeMessage(msg(id, date, id), MOM_CHAT);
    const { index } = indexOf([
      at('before', local(y, m, d - 1, 23, 59, 59, 999)),
      at('start', local(y, m, d, 0, 0, 0)),
      at('night', local(y, m, d, 23, 30)),
      at('end', local(y, m, d, 23, 59, 59, 999)),
      at('after', local(y, m, d + 1, 0, 0, 0)),
    ]);
    const key = dayKey(y, m, d);
    assert.deepEqual(filtered(index, { dateFrom: key, dateTo: key }), ['message:end', 'message:night', 'message:start'], key);
    // Open-ended ranges
    assert.deepEqual(filtered(index, { dateFrom: key }), ['message:after', 'message:end', 'message:night', 'message:start'], key);
    assert.deepEqual(filtered(index, { dateTo: key }), ['message:end', 'message:night', 'message:start', 'message:before'], key);
  }
});

test('undated entries drop out of a date range, and show without one', () => {
  const undated = normalizeBrowserVisit({ visit_id: 's_1', url: 'https://a.test', title: 'A', domain: 'a.test', visit_date: null, browser: 'safari', visit_count: null });
  const dated = normalizeMessage(msg(1, local(2024, 3, 10, 12), 'hi'), MOM_CHAT);
  const { index } = indexOf([undated, dated]);
  assert.deepEqual(filtered(index, {}), ['message:1', 'browser:s_1']);
  assert.deepEqual(filtered(index, { dateFrom: '2024-03-01', dateTo: '2024-03-31' }), ['message:1']);
});

test('the type filter and the search box narrow the list', () => {
  const entries = [
    normalizeMessage(msg(1, local(2024, 3, 10, 12), 'Allergic to "peanuts"'), MOM_CHAT),
    normalizeMessage(msg(2, local(2024, 3, 10, 13), 'Café at noon?'), MOM_CHAT),
    normalizeCall({ call_id: 3, address: '+15035550123', contact_name: 'Mom', date: engine(local(2024, 3, 10, 14)), duration: 60, direction: 'incoming', status: 'answered', app: '' }),
  ];
  const { index } = indexOf(entries);
  assert.deepEqual(filtered(index, { types: new Set(['call']) }), ['call:3']);
  assert.deepEqual(filtered(index, { searchQuery: 'peanuts' }), ['message:1']);
  assert.deepEqual(filtered(index, { searchQuery: 'cafe' }), ['message:2']);
  assert.deepEqual(filtered(index, { searchQuery: '"at noon"' }), ['message:2']);
  assert.deepEqual(filtered(index, { searchQuery: 'nothing like this' }), []);
});

test('picking a person shows their records, and undated-by-person ones from while you were in touch', () => {
  const DAD_CHAT = { ...MOM_CHAT, chat_id: 13, chat_identifier: '+15035550188', display_name: 'Dad' };
  const photo = (uuid, date) => normalizePhoto({ uuid, filename: `${uuid}.HEIC`, file_hash: uuid, kind: 'photo', width: 1, height: 1, duration: 0, date_created: engine(date) });
  const entries = [
    normalizeMessage(msg(1, local(2024, 3, 1, 9), 'first'), MOM_CHAT),
    normalizeCall({ call_id: 2, address: '5035550123', contact_name: '', date: engine(local(2024, 3, 5, 9)), duration: 60, direction: 'incoming', status: 'answered', app: '' }),
    normalizeVoicemail({ id: 3, phone_number: '+1 (503) 555-0123', contact_name: '', date_received: engine(local(2024, 3, 9, 9)), duration: 20, is_read: true }),
    normalizeMessage(msg(4, local(2024, 3, 2, 9), 'from Dad'), DAD_CHAT),
    photo('inside', local(2024, 3, 4, 12)),
    photo('before', local(2024, 2, 20, 12)),
    photo('after', local(2024, 3, 20, 12)),
    // Her email address, linked to her number only through the address book
    normalizeMessage(msg(5, local(2024, 3, 6, 9), 'from iCloud'), { ...MOM_CHAT, chat_id: 14, chat_identifier: 'mom@icloud.com', display_name: 'mom@icloud.com' }),
  ];
  const card = [{ phones: ['+1 503 555 0123'], emails: ['mom@icloud.com'] }];
  const { index } = indexOf(entries, card);
  assert.deepEqual(filtered(index, { contactIdentifier: '+15035550123' }),
    ['voicemail:3', 'message:5', 'call:2', 'photo:inside', 'message:1']);
  // Without the address book her email isn't hers
  const { index: noCard } = indexOf(entries);
  assert.deepEqual(filtered(noCard, { contactIdentifier: '+15035550123' }),
    ['voicemail:3', 'call:2', 'photo:inside', 'message:1']);
});

test('the list is shown 100 at a time', () => {
  const entries = Array.from({ length: 250 }, (_, i) => normalizeMessage(msg(i, new Date(Date.UTC(2024, 0, 1) + i * 60_000), `m${i}`), MOM_CHAT));
  const { index } = indexOf(entries);
  const view = useTimeline(index, { types: ALL_TYPES });
  assert.equal(view.pageSize, 100);
  assert.equal(view.page, 0);
  assert.equal(view.totalFiltered, 250);
  assert.equal(view.entries.length, 100);
  assert.equal(view.entries[0].id, 'message:249'); // newest first
});

test("opening the Timeline on one day reads that day's messages first", () => {
  const { index, days } = indexOf([]);
  const run = filters => {
    effects.length = 0;
    useTimeline(index, filters);
    for (const effect of effects) effect();
  };
  run({ dateFrom: '2024-03-10', dateTo: '2024-03-10' });
  assert.deepEqual(days, ['2024-03-10']);
  run({ dateFrom: '2024-03-10', dateTo: '2024-03-11' });
  run({ dateFrom: '2024-03-10', dateTo: '2024-03-10', types: new Set(['photo']) });
  run({});
  assert.deepEqual(days, ['2024-03-10']);
});

// ── useYearCounts, useUpdates ────────────────────────────────────────────────
test("latestYear: this year if the backup has it, else the latest before it, ignoring a camera clock's future years", () => {
  assert.equal(latestYear([2019, 2020, 2026], 2026), 2026);
  assert.equal(latestYear([2019, 2020, 2024], 2026), 2024);
  assert.equal(latestYear([2019, 2026, 2031], 2026), 2026);
  assert.equal(latestYear([2016, 2031], 2026), 2016);
  assert.equal(latestYear([2031], 2026), 2031);
  assert.equal(latestYear([], 2026), null);
});

test('releaseNotesUrl points at the version\'s tag', () => {
  const releases = 'https://github.com/openextract/openextract/releases';
  assert.equal(releaseNotesUrl(releases, '0.10.1'), `${releases}/tag/v0.10.1`);
  assert.equal(releaseNotesUrl(releases, '1.0.0-beta.2'), `${releases}/tag/v1.0.0-beta.2`);
  assert.equal(releaseNotesUrl(releases), releases);
  assert.equal(releaseNotesUrl(releases, ''), releases);
});

rerunInTimeZones(import.meta.url);
