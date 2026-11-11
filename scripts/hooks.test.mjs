// Tests for the plain logic inside the React hooks (src/hooks/*.ts), without a
// React test framework:
//  - the record normalizers in useTimeline.ts (engine rows → Timeline entries),
//    including private ones, exposed by load-ts;
//  - useTimeline's filtering, which is pure within one render: a stand-in for
//    React runs the hook once with useMemo/useCallback called straight through;
//  - useBackupIndex reading WhatsApp, against a fake engine: a stand-in for
//    React that keeps state between renders runs the load and reads the state;
//  - latestYear (useYearCounts.ts) and releaseNotesUrl (useUpdates.ts).
//  - useBackupIndex's other loads (calls) against a fake engine, the same way.
// Other hook state over time (paging, retries) is left to the end-to-end UI tests.
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
const { normalizeMessage, normalizeWhatsApp, normalizeCall, normalizeVoicemail, normalizePhoto, normalizeNote,
  normalizeBrowserVisit, dedupe, appDisplayName, useTimeline } = timeline;
const { latestYear } = loadTs('src/hooks/useYearCounts.ts', { stubs: { react: oneRender }, expose: ['latestYear'] });
const { releaseNotesUrl } = loadTs('src/hooks/useUpdates.ts', { stubs: { react: oneRender } });
const { buildContactOptions, buildIdentifierGroupMap } = loadTs('src/lib/people.ts');
const { gatherPeople } = loadTs('src/components/people/gather.ts');

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
    text: 'Running late 🚗', isFromMe: true, sender: '+15035550123', messageType: 'text', eventText: null,
    conversationName: 'Mom', service: 'iMessage', chatId: 12, isGroup: false,
  });
  // A group change or unsent message keeps the engine's words for it
  const event = normalizeMessage(msg(9002, local(2024, 3, 10, 8, 16), null, {
    message_type: 'group_member_added', event_text: 'Karin added Theo to the conversation',
  }), MOM_CHAT);
  assert.equal(event.message.messageType, 'group_member_added');
  assert.equal(event.message.eventText, 'Karin added Theo to the conversation');
  // An unnamed conversation goes by its handle
  const unnamed = normalizeMessage(msg(1, local(2024, 1, 1), null), { ...MOM_CHAT, display_name: '' });
  assert.equal(unnamed.contactName, '+15035550123');
  assert.equal(unnamed.message.conversationName, '+15035550123');
});

// ── WhatsApp, as the engine sends it (fictional people, 555 numbers) ────────────
const WA_RILEY = {
  chat_id: 12, chat_identifier: '15035550142@s.whatsapp.net', display_name: 'Riley Okafor', service: 'WhatsApp',
  message_count: 3, last_message_date: '2024-03-10T09:59:59+00:00', last_message_preview: 'ok', is_group: false,
  chat_jid: '15035550142@s.whatsapp.net', handle: '+15035550142', chat_type: 'individual', archived: false,
};
const WA_FAMILY = {
  ...WA_RILEY, chat_id: 30, chat_identifier: '120363000000000001@g.us', chat_jid: '120363000000000001@g.us',
  display_name: 'Family', handle: '', chat_type: 'group', is_group: true,
};
const waMsg = (id, date, text, over = {}) => ({
  message_id: id, text, message_type: 'text', event_text: null, link_preview: null,
  date: date === null ? null : engine(date), is_from_me: false, sender: 'Riley Okafor', sender_handle: '+15035550142',
  has_attachments: false, attachments: [], is_reaction: false, sort: id * 10, sender_jid: '15035550142@s.whatsapp.net',
  quoted: null, reactions: [], call: null, location: null, received_date: null, event_code: null, starred: false, vcard: null,
  ...over,
});

test('normalizeWhatsApp: a message in a one-to-one chat is with that number', () => {
  const e = normalizeWhatsApp(waMsg(1, local(2024, 3, 10, 8, 15), 'Running late 🚗'), WA_RILEY);
  assert.equal(e.id, 'whatsapp:1');
  assert.equal(e.type, 'whatsapp');
  assert.equal(e.contactName, 'Riley Okafor');
  // The number, so the chat joins Riley's texts and calls; never the chat's WhatsApp address
  assert.equal(e.contactIdentifier, '+15035550142');
  assert.deepEqual(e.whatsapp, {
    text: 'Running late 🚗', isFromMe: false, sender: 'Riley Okafor', messageType: 'text', eventText: null,
    attachmentLabel: null, conversationName: 'Riley Okafor', chatId: 12, chatType: 'individual', isGroup: false,
    sort: 10, call: null,
  });
  // No message field: nothing that reads sms.db ids would pick it up
  assert.equal(e.message, undefined);
});

test("normalizeWhatsApp: who a chat is with, by kind of chat", () => {
  const at = local(2024, 3, 10, 12);
  // A group, broadcast list or channel is the chat itself, like a group text
  const group = normalizeWhatsApp(waMsg(2, at, 'hi all', { sender: 'Ana' }), WA_FAMILY);
  assert.equal(group.contactIdentifier, '120363000000000001@g.us');
  assert.equal(group.contactName, 'Family');
  assert.deepEqual([group.whatsapp.isGroup, group.whatsapp.chatType, group.whatsapp.sender], [true, 'group', 'Ana']);
  const list = normalizeWhatsApp(waMsg(3, at, 'Party Saturday'),
    { ...WA_FAMILY, chat_identifier: '1700000000@broadcast', chat_jid: '1700000000@broadcast', chat_type: 'broadcast', is_group: false, display_name: 'Party list' });
  assert.equal(list.contactIdentifier, '1700000000@broadcast');
  assert.deepEqual([list.whatsapp.isGroup, list.whatsapp.chatType], [false, 'broadcast']);
  const channel = normalizeWhatsApp(waMsg(4, at, 'News'),
    { ...WA_FAMILY, chat_identifier: '120363000000000002@newsletter', chat_jid: '120363000000000002@newsletter', chat_type: 'channel', is_group: false, display_name: 'Garden club' });
  assert.equal(channel.contactIdentifier, '120363000000000002@newsletter');
  // A one-to-one chat WhatsApp couldn't tie to a number is with no one: it isn't anyone's in People
  const lid = normalizeWhatsApp(waMsg(5, at, 'hello'),
    { ...WA_RILEY, chat_identifier: '99000000000001@lid', chat_jid: '99000000000001@lid', handle: '', display_name: 'Unknown contact' });
  assert.equal(lid.contactIdentifier, null);
  assert.equal(lid.contactName, 'Unknown contact');
  // An engine without handles yet: still no WhatsApp address as a person
  const { handle, ...older } = WA_RILEY;
  assert.equal(normalizeWhatsApp(waMsg(6, at, 'x'), older).contactIdentifier, null);
  // A chat without a name goes by its number, never its address
  assert.equal(normalizeWhatsApp(waMsg(7, at, 'x'), { ...WA_RILEY, display_name: '' }).contactName, '+15035550142');
  assert.equal(normalizeWhatsApp(waMsg(8, at, 'x'), { ...WA_RILEY, display_name: '', handle: '' }).contactName, 'WhatsApp chat');
});

test('normalizeWhatsApp: messages with no usable date are left off the Timeline', () => {
  assert.equal(normalizeWhatsApp(waMsg(1, null, 'lost in time'), WA_RILEY), null);
  assert.equal(normalizeWhatsApp({ ...waMsg(1, null, 'x'), date: '' }, WA_RILEY), null);
  assert.ok(normalizeWhatsApp(waMsg(1, local(2024, 1, 1), 'x'), WA_RILEY));
});

test('normalizeWhatsApp keeps what a message without words was', () => {
  const at = local(2024, 3, 10, 12);
  const photo = normalizeWhatsApp(waMsg(1, at, '', {
    message_type: 'image', has_attachments: true,
    attachments: [{ attachment_id: 4, filename: '', mime_type: 'image/jpeg', transfer_name: 'Photo', total_bytes: null, thumbnail_path: null, width: null, height: null, duration: null, available: false }],
  }), WA_RILEY);
  assert.deepEqual([photo.whatsapp.text, photo.whatsapp.messageType, photo.whatsapp.attachmentLabel], [null, 'image', 'Photo']);
  const call = normalizeWhatsApp(waMsg(2, at, '', {
    message_type: 'call', event_text: 'Missed voice call',
    call: { is_video: false, duration: null, outcome: 'missed', direction: 'incoming' },
  }), WA_RILEY);
  assert.equal(call.whatsapp.eventText, 'Missed voice call');
  assert.deepEqual(call.whatsapp.call, { outcome: 'missed', direction: 'incoming', isVideo: false, duration: null });
  // A notice belongs to no one in the chat
  const notice = normalizeWhatsApp(waMsg(3, at, '', { message_type: 'system', sender: '', event_text: 'Riley joined' }), WA_FAMILY);
  assert.deepEqual([notice.whatsapp.sender, notice.whatsapp.eventText, notice.whatsapp.isFromMe], ['', 'Riley joined', false]);
  // A message with no sort keeps null rather than a made-up order
  assert.equal(normalizeWhatsApp(waMsg(4, at, 'x', { sort: null }), WA_RILEY).whatsapp.sort, null);
});

test('a WhatsApp message and an sms.db message with the same number both stay', () => {
  const sms = normalizeMessage(msg(1, local(2024, 1, 1), 'from Messages'), MOM_CHAT);
  const wa = normalizeWhatsApp(waMsg(1, local(2024, 1, 1), 'from WhatsApp'), WA_RILEY);
  assert.deepEqual(dedupe([sms, wa]).map(e => e.id), ['message:1', 'whatsapp:1']);
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
      counts: {}, loading: false, loadingTypes: new Set(), errors: {}, messageCap: null, whatsappCap: null,
      loadAllMessages: async () => {}, loadDay: day => days.push(day), refresh: () => {},
    },
  };
}
const ALL_TYPES = new Set(['message', 'whatsapp', 'call', 'photo', 'voicemail', 'note', 'browser']);
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

test('WhatsApp messages are in the Timeline by default, filtered and searched like the rest', () => {
  const { DEFAULT_FILTERS } = loadTs('src/types/timeline.ts');
  assert.ok(DEFAULT_FILTERS.types.has('whatsapp'));
  const entries = [
    normalizeMessage(msg(1, local(2024, 3, 10, 12), 'See you at the market'), MOM_CHAT),
    normalizeWhatsApp(waMsg(1, local(2024, 3, 10, 13), 'Bring the blue tent'), WA_RILEY),
    normalizeWhatsApp(waMsg(2, local(2024, 3, 10, 14), 'Ana is driving', { sender: 'Ana' }), WA_FAMILY),
  ];
  const { index } = indexOf(entries);
  assert.deepEqual(useTimeline(index).filteredEntries.map(e => e.id), ['whatsapp:2', 'whatsapp:1', 'message:1']);
  assert.deepEqual(filtered(index, { types: new Set(['whatsapp']) }), ['whatsapp:2', 'whatsapp:1']);
  assert.deepEqual(filtered(index, { types: new Set(['message']) }), ['message:1']);
  assert.deepEqual(filtered(index, { searchQuery: 'tent' }), ['whatsapp:1']);
  // Picking Riley by the number on their texts finds their WhatsApp chat too
  assert.deepEqual(filtered(index, { contactIdentifier: '(503) 555-0142' }), ['whatsapp:1']);
});

test("picking someone never brings in another WhatsApp chat just because WhatsApp gave it the same name", () => {
  // Two strangers who both call themselves Alex on WhatsApp
  const usAlex = { ...WA_RILEY, chat_id: 3, chat_identifier: '15035550101@s.whatsapp.net', chat_jid: '15035550101@s.whatsapp.net', display_name: 'Alex', handle: '+15035550101' };
  const ukAlex = { ...usAlex, chat_id: 4, chat_identifier: '447700900123@s.whatsapp.net', chat_jid: '447700900123@s.whatsapp.net', handle: '+447700900123' };
  const entries = [
    normalizeWhatsApp(waMsg(1, local(2024, 3, 10, 12), 'from the US'), usAlex),
    normalizeWhatsApp(waMsg(2, local(2024, 3, 10, 13), 'from the UK'), ukAlex),
  ];
  const { index } = indexOf(entries);
  assert.deepEqual(filtered(index, { contactIdentifier: '+447700900123' }), ['whatsapp:2']);
  assert.deepEqual(filtered(index, { contactIdentifier: '+15035550101' }), ['whatsapp:1']);
  // Nor someone from Messages with that name, whichever one is picked
  const smsAlex = normalizeMessage(msg(3, local(2024, 3, 10, 14), 'from Messages'), { ...MOM_CHAT, chat_id: 9, chat_identifier: '+15035550177', display_name: 'Alex' });
  const { index: mixed } = indexOf([entries[1], smsAlex]);
  assert.deepEqual(filtered(mixed, { contactIdentifier: '+447700900123' }), ['whatsapp:2']);
  assert.deepEqual(filtered(mixed, { contactIdentifier: '+15035550177' }), ['message:3']);
});

test("a WhatsApp chat with no number isn't anyone's, even with their name on it", () => {
  const RILEY_SMS = { ...MOM_CHAT, chat_id: 7, chat_identifier: '+15035550142', display_name: 'Riley' };
  // A one-to-one chat WhatsApp couldn't tie to a number, under the name WhatsApp has for it
  const unmapped = { ...WA_RILEY, chat_id: 40, chat_identifier: '86123456789012@lid', chat_jid: '86123456789012@lid', display_name: 'Riley', handle: '' };
  const entries = [
    normalizeMessage(msg(1, local(2024, 3, 10, 12), 'hi'), RILEY_SMS),
    normalizeWhatsApp(waMsg(1, local(2024, 3, 10, 13), 'hello'), unmapped),
  ];
  assert.equal(entries[1].contactIdentifier, null);
  const { index } = indexOf(entries);
  assert.deepEqual(filtered(index, { contactIdentifier: '+15035550142' }), ['message:1']);
  // People agrees: Riley has one message and no WhatsApp
  const [riley] = gatherPeople(index.entries);
  assert.deepEqual([riley.total, riley.counts.whatsapp], [1, 0]);
});

test("someone's stream has the WhatsApp chats People counts for them, through their card", () => {
  // Mom texts from her email; her calls come from her number, which shares a card
  // with the number she uses WhatsApp on. People puts all three together.
  const momEmail = { ...MOM_CHAT, chat_id: 14, chat_identifier: 'mom@icloud.com', display_name: 'Mom' };
  const momWhatsApp = { ...WA_RILEY, chat_id: 21, chat_identifier: '447700900999@s.whatsapp.net', chat_jid: '447700900999@s.whatsapp.net', display_name: 'Mum', handle: '+447700900999' };
  const entries = [
    normalizeMessage(msg(1, local(2024, 3, 10, 12), 'from iCloud'), momEmail),
    normalizeCall({ call_id: 2, address: '+15035550123', contact_name: 'Mom', date: engine(local(2024, 3, 9, 9)), duration: 60, direction: 'incoming', status: 'answered', app: '' }),
    normalizeWhatsApp(waMsg(3, local(2024, 3, 8, 9), 'from WhatsApp'), momWhatsApp),
  ];
  const card = { id: 1, display_name: 'Mom', phones: ['+1 503 555 0123', '+44 7700 900999'], emails: [] };
  const { index } = indexOf(entries, [card]);
  const people = gatherPeople(index.entries, [card]);
  assert.equal(people.length, 1);
  const [mom] = people;
  assert.equal(mom.identifier, 'mom@icloud.com');
  const stream = useTimeline(index, { types: new Set(['message', 'whatsapp', 'call', 'voicemail']), contactIdentifier: mom.identifier }).filteredEntries;
  assert.deepEqual(stream.map(e => e.id), ['message:1', 'call:2', 'whatsapp:3']);
  assert.equal(stream.length, mom.total);
  // Without the card, the WhatsApp number is no one else's
  const { index: noCard } = indexOf(entries);
  assert.deepEqual(filtered(noCard, { contactIdentifier: 'mom@icloud.com' }), ['message:1', 'call:2']);
});

test("picking a phone number never brings in a WhatsApp group whose address ends in its digits", () => {
  const club = { ...WA_FAMILY, chat_id: 31, chat_identifier: '120363025246125486@g.us', chat_jid: '120363025246125486@g.us', display_name: 'Book club' };
  const pat = { ...MOM_CHAT, chat_id: 8, chat_identifier: '+15246125486', display_name: 'Pat' };
  const entries = [
    normalizeWhatsApp(waMsg(1, local(2024, 3, 10, 12), 'chapter 3', { sender: 'Ana' }), club),
    normalizeMessage(msg(2, local(2024, 3, 10, 13), 'hi'), pat),
  ];
  const { index } = indexOf(entries);
  assert.deepEqual(filtered(index, { contactIdentifier: '+15246125486' }), ['message:2']);
  assert.deepEqual(filtered(index, { contactIdentifier: '120363025246125486@g.us' }), ['whatsapp:1']);
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

// ── useBackupIndex reading WhatsApp ──────────────────────────────────────────
// A stand-in for React that keeps each useState slot between renders, so the
// load's setState calls can be read back. Slots are in the hook's order:
// 0 the entries, 1 the kinds still loading, 2 the errors.
const RAW = 0, LOADING = 1, ERRORS = 2;

function fakeIndex(engine) {
  const slots = [];
  let at = 0;
  const runEffects = [];
  const react = {
    useState: init => {
      const k = at++;
      if (!(k in slots)) slots[k] = typeof init === 'function' ? init() : init;
      return [slots[k], v => { slots[k] = typeof v === 'function' ? v(slots[k]) : v; }];
    },
    useMemo: fn => fn(),
    useCallback: fn => fn,
    useRef: current => ({ current }),
    useEffect: fn => { runEffects.push(fn); },
  };
  const calls = [];
  const ipc = {
    sidecarCall: async (method, params) => {
      calls.push([method, params]);
      return engine(method, params);
    },
  };
  const { useBackupIndex } = loadTs('src/hooks/useTimeline.ts', { stubs: { react, '../lib/ipc': ipc } });
  const render = () => { at = 0; runEffects.length = 0; return useBackupIndex('UDID-1'); };
  return {
    calls,
    slots,
    /** Renders once, starts the load, and waits for the fake engine's answers to land. */
    async load() {
      const index = render();
      for (const effect of [...runEffects]) effect();
      await settle();
      return index;
    },
    render,
  };
}

const settle = async () => { for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r)); };

// Everything but WhatsApp: an empty backup
function emptyBackup(method) {
  switch (method) {
    case 'list_conversations': return { conversations: [] };
    case 'list_calls': return { calls: [] };
    case 'list_photos': return { photos: [], total: 0 };
    case 'list_voicemails': return { voicemails: [] };
    case 'list_notes': return { notes: [] };
    case 'has_browser_history': return { has_any: false };
    case 'list_contacts': return { contacts: [] };
    default: throw new Error(`the fake engine has no ${method}`);
  }
}

const withWhatsApp = chats => (method, params) =>
  method === 'list_whatsapp_chats' || method === 'get_whatsapp_messages' ? chats(method, params) : emptyBackup(method);

test('a backup without WhatsApp, or with none in it, finishes loading calmly', async () => {
  for (const reason of ['not_in_backup', 'no_records']) {
    const fake = fakeIndex(withWhatsApp(() => ({ conversations: [], empty_reason: reason })));
    await fake.load();
    assert.ok(!fake.slots[LOADING].has('whatsapp'), reason);
    assert.equal(fake.slots[LOADING].size, 0, reason);
    assert.deepEqual(fake.slots[ERRORS], {}, reason);
    assert.deepEqual(fake.slots[RAW], [], reason);
    assert.ok(!fake.calls.some(([m]) => m === 'get_whatsapp_messages'), reason);
  }
});

test("a WhatsApp version the app can't read yet is empty here, not a Timeline error", async () => {
  const fake = fakeIndex(withWhatsApp(() => ({
    conversations: [], error: "This WhatsApp version isn't supported yet", empty_reason: 'unsupported_format',
  })));
  await fake.load();
  assert.ok(!fake.slots[LOADING].has('whatsapp'));
  assert.deepEqual(fake.slots[ERRORS], {});
});

test("WhatsApp that's there but can't be read says so, and stops loading", async () => {
  const unreadable = fakeIndex(withWhatsApp(() => ({ conversations: [], error: "WhatsApp's chats couldn't be read" })));
  await unreadable.load();
  assert.ok(!unreadable.slots[LOADING].has('whatsapp'));
  assert.deepEqual(unreadable.slots[ERRORS], { whatsapp: "WhatsApp's chats couldn't be read" });

  // The engine call itself failing
  const failed = fakeIndex(withWhatsApp(() => { throw new Error('The engine stopped'); }));
  await failed.load();
  assert.ok(!failed.slots[LOADING].has('whatsapp'));
  assert.deepEqual(failed.slots[ERRORS], { whatsapp: 'The engine stopped' });
});

test('WhatsApp chats are read a page at a time, newest chat first, apart from Messages', async () => {
  // 600 messages with Riley (two pages), one undated; one notice in the family group
  const riley = Array.from({ length: 600 }, (_, i) => waMsg(i + 1, new Date(Date.UTC(2024, 0, 1) + i * 60_000), `r${i + 1}`));
  riley[0] = { ...riley[0], date: null };
  const family = [waMsg(700, new Date(Date.UTC(2024, 5, 1)), '', { message_type: 'system', sender: '', event_text: 'Ana joined' })];
  const sms = { ...MOM_CHAT, message_count: 1 };
  const fake = fakeIndex((method, params) => {
    switch (method) {
      case 'list_whatsapp_chats':
        return { conversations: [
          { ...WA_RILEY, message_count: 600, last_message_date: '2024-01-01T09:59:00+00:00' },
          { ...WA_FAMILY, message_count: 1, last_message_date: '2024-06-01T00:00:00+00:00' },
        ] };
      case 'get_whatsapp_messages': {
        const all = params.chat_id === WA_RILEY.chat_id ? riley : family;
        // offset counts back from the newest; each page comes oldest first
        const end = all.length - params.offset;
        const page = all.slice(Math.max(0, end - params.limit), Math.max(0, end));
        return { messages: page, total: all.length, offset: params.offset, limit: params.limit, next_offset: params.offset + page.length };
      }
      // Messages has its own message 1: it mustn't be lost to WhatsApp's, or the other way round
      case 'list_conversations': return { conversations: [sms] };
      case 'get_messages': return { messages: [msg(1, local(2024, 2, 1), 'from Messages')], total: 1, next_offset: 1 };
      default: return emptyBackup(method);
    }
  });
  await fake.load();

  const pages = fake.calls.filter(([m]) => m === 'get_whatsapp_messages').map(([, p]) => [p.chat_id, p.offset, p.limit, p.udid]);
  assert.deepEqual(pages, [[30, 0, 500, 'UDID-1'], [12, 0, 500, 'UDID-1'], [12, 500, 500, 'UDID-1']]);
  // No WhatsApp id ever went to a Messages call
  assert.deepEqual(fake.calls.filter(([m]) => m === 'get_messages').map(([, p]) => p.chat_id), [MOM_CHAT.chat_id]);

  const raw = fake.slots[RAW];
  const wa = raw.filter(e => e.type === 'whatsapp');
  assert.equal(wa.length, 600, 'every dated message, the undated one left out');
  assert.ok(!wa.some(e => e.id === 'whatsapp:1'));
  assert.ok(wa.some(e => e.id === 'whatsapp:700' && e.whatsapp.eventText === 'Ana joined'));
  assert.deepEqual(raw.filter(e => e.type === 'message').map(e => e.id), ['message:1']);
  assert.equal(fake.slots[LOADING].size, 0);
  assert.deepEqual(fake.slots[ERRORS], {});

  // The next render counts them
  const index = fake.render();
  assert.equal(index.counts.whatsapp, 600);
  assert.equal(index.whatsappCap, null, 'every message was read');
  assert.equal(index.counts.message, 1);
  assert.equal(index.entries[0].id, 'whatsapp:700'); // newest first, across both
});

test("one WhatsApp chat that can't be read is skipped; all of them failing is an error", async () => {
  const chats = { conversations: [WA_RILEY, WA_FAMILY] };
  const someFail = fakeIndex(withWhatsApp((method, params) => {
    if (method === 'list_whatsapp_chats') return chats;
    if (params.chat_id === WA_FAMILY.chat_id) return { messages: [], total: 0, error: "That chat couldn't be read" };
    return { messages: [waMsg(5, local(2024, 3, 1), 'hi')], total: 1 };
  }));
  await someFail.load();
  assert.deepEqual(someFail.slots[RAW].map(e => e.id), ['whatsapp:5']);
  assert.deepEqual(someFail.slots[ERRORS], {});
  assert.ok(!someFail.slots[LOADING].has('whatsapp'));

  const allFail = fakeIndex(withWhatsApp((method) => {
    if (method === 'list_whatsapp_chats') return chats;
    throw new Error("That chat couldn't be read");
  }));
  await allFail.load();
  assert.deepEqual(allFail.slots[RAW], []);
  assert.deepEqual(allFail.slots[ERRORS], { whatsapp: "That chat couldn't be read" });
  assert.ok(!allFail.slots[LOADING].has('whatsapp'));

  // A chat that's simply empty (the engine says why) isn't a failure
  const quiet = fakeIndex(withWhatsApp((method) => method === 'list_whatsapp_chats'
    ? chats
    : { messages: [], total: 0, error: 'Not in this backup', empty_reason: 'not_in_backup' }));
  await quiet.load();
  assert.deepEqual(quiet.slots[ERRORS], {});
  assert.ok(!quiet.slots[LOADING].has('whatsapp'));
});

test('past its allowance, WhatsApp says how much was read, and the oldest chats are left out', async () => {
  // 150,000 + 100,000 + 10 messages, newest chat first; only 200,000 are read.
  // The fake's messages have no date (so nothing is kept): only the counting matters here.
  const chats = [
    { ...WA_RILEY, chat_id: 1, message_count: 150_000, last_message_date: '2024-03-03T00:00:00+00:00' },
    { ...WA_RILEY, chat_id: 2, message_count: 100_000, last_message_date: '2024-03-02T00:00:00+00:00' },
    { ...WA_FAMILY, chat_id: 3, message_count: 10, last_message_date: '2024-03-01T00:00:00+00:00' },
  ];
  const fake = fakeIndex(withWhatsApp((method, params) => {
    if (method === 'list_whatsapp_chats') return { conversations: chats };
    const total = chats.find(c => c.chat_id === params.chat_id).message_count;
    const n = Math.max(0, Math.min(params.limit, total - params.offset));
    const messages = Array.from({ length: n }, (_, i) => ({ message_id: params.chat_id * 1e6 + params.offset + i, date: null }));
    return { messages, total, offset: params.offset, limit: params.limit, next_offset: params.offset + n };
  }));
  await fake.load();
  assert.ok(!fake.calls.some(([m, p]) => m === 'get_whatsapp_messages' && p.chat_id === 3), 'the oldest chat is never read');
  assert.ok(!fake.slots[LOADING].has('whatsapp'));
  assert.deepEqual(fake.slots[ERRORS], {});
  const index = fake.render();
  assert.deepEqual(index.whatsappCap, { loaded: 200_000, total: 250_010 });
  assert.equal(index.counts.whatsapp, 250_010, 'the chip counts every message');
  assert.equal(index.messageCap, null, "Messages' own cap is apart");
  // The Timeline hands it on
  assert.deepEqual(useTimeline(index).whatsappCap, { loaded: 200_000, total: 250_010 });
  // Reading the backup again starts over
  index.refresh();
  assert.equal(fake.render().whatsappCap, null);
  await settle();
});

test('a WhatsApp read that a newer load replaced writes nothing', async () => {
  let release;
  const first = new Promise(r => { release = r; });
  let asked = 0;
  const fake = fakeIndex(withWhatsApp((method, params) => {
    if (method === 'list_whatsapp_chats') {
      asked++;
      // The first load's answer comes late, after the backup was read again
      return asked === 1 ? first : { conversations: [WA_FAMILY] };
    }
    return { messages: [waMsg(params.chat_id === WA_FAMILY.chat_id ? 9 : 8, local(2024, 3, 1), 'x')], total: 1 };
  }));
  const index = await fake.load();
  index.refresh();
  await settle();
  release({ conversations: [WA_RILEY] });
  await settle();
  assert.deepEqual(fake.slots[RAW].map(e => e.id), ['whatsapp:9']);
  assert.ok(!fake.calls.some(([m, p]) => m === 'get_whatsapp_messages' && p.chat_id === WA_RILEY.chat_id));
});

// ── useBackupIndex against a fake engine ─────────────────────────────────────
// React that keeps state between renders: each hook call gets the slot it had
// last render, setters write to it, and render() runs the hook again.
function stateful() {
  const slots = [];
  let slot = 0;
  let effects = [];
  const react = {
    useState: init => {
      const i = slot++;
      if (!(i in slots)) slots[i] = typeof init === 'function' ? init() : init;
      return [slots[i], next => { slots[i] = typeof next === 'function' ? next(slots[i]) : next; }];
    },
    useRef: current => {
      const i = slot++;
      if (!(i in slots)) slots[i] = { current };
      return slots[i];
    },
    useMemo: fn => fn(),
    useCallback: fn => fn,
    useEffect: fn => { effects.push(fn); },
  };
  return {
    react,
    render(hook) {
      slot = 0;
      effects = [];
      const out = hook();
      return { out, runEffects: () => effects.forEach(fn => fn()) };
    },
  };
}

// Runs useBackupIndex once with the engine answering from `results` (method →
// data), lets every load finish, and returns what the hook hands over then.
async function loadIndex(results) {
  const react = stateful();
  const asked = [];
  globalThis.window = {
    openextract: {
      call: async (method, params) => {
        asked.push(method);
        return method in results
          ? { success: true, data: results[method] }
          : { success: false, error: `${method} isn't in this fake engine` };
      },
    },
  };
  try {
    const { useBackupIndex } = loadTs('src/hooks/useTimeline.ts', { stubs: { react: react.react } });
    react.render(() => useBackupIndex('fake-udid')).runEffects();
    for (let i = 0; i < 20; i++) await new Promise(resolve => setImmediate(resolve));
    return { index: react.render(() => useBackupIndex('fake-udid')).out, asked };
  } finally {
    delete globalThis.window;
  }
}

const QUIET_ENGINE = {
  list_conversations: { conversations: [] },
  list_photos: { photos: [], total: 0 },
  list_voicemails: { voicemails: [], empty_reason: 'not_in_backup' },
  list_notes: { notes: [] },
  has_browser_history: { has_any: false },
  list_contacts: { contacts: [] },
  list_whatsapp_chats: { conversations: [], empty_reason: 'not_in_backup' },
};

test('an unencrypted backup has no call history, and the Timeline says nothing is wrong', async () => {
  const { index, asked } = await loadIndex({
    ...QUIET_ENGINE,
    // What the engine sends for every unencrypted backup
    list_calls: {
      calls: [], total: 0, offset: 0, limit: 999999,
      empty_reason: 'requires_encryption',
      error: "Call history not found. Apple requires backups to be encrypted to include call logs. Please enable 'Encrypt local backup' in iTunes/Finder.",
    },
  });
  assert.ok(asked.includes('list_calls'));
  assert.equal(index.loadingTypes.has('call'), false);
  assert.equal(index.errors.call, undefined);
  assert.deepEqual(index.errors, {});
  assert.equal(index.loading, false);
  assert.equal(index.counts.call, 0);

  // The other calm empties end quietly too
  for (const empty_reason of ['not_in_backup', 'no_records']) {
    const { index: other } = await loadIndex({ ...QUIET_ENGINE, list_calls: { calls: [], total: 0, empty_reason } });
    assert.equal(other.loadingTypes.has('call'), false, empty_reason);
    assert.deepEqual(other.errors, {}, empty_reason);
  }
});

test("call history the engine couldn't read is still an error", async () => {
  const error = 'Call history is in this backup but could not be read. The backup may be incomplete or damaged.';
  const { index } = await loadIndex({ ...QUIET_ENGINE, list_calls: { calls: [], total: 0, error } });
  assert.equal(index.loadingTypes.has('call'), false);
  assert.equal(index.errors.call, error);
  assert.deepEqual(Object.keys(index.errors), ['call']);
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
