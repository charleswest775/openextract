// Tests for the WhatsApp screen's wording and decisions (src/lib/whatsapp.ts):
// chat rows, calls, reactions, attachments and what to say when a file isn't in
// the backup, locations and contact cards, replies, empty states, and stepping
// through search matches in the order a chat reads. Data is fictional and
// shaped like the engine's get_whatsapp_messages / list_whatsapp_chats.
// Run with: node --test scripts/whatsapp.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';

const wa = loadTs('src/lib/whatsapp.ts');
const { parseQuery, matches, matchesTerms, searchText } = loadTs('src/lib/search.ts');

test('chat rows say what kind of chat it is, never "WhatsApp" or an address', () => {
  assert.equal(wa.chatTypeLabel('group'), 'Group');
  assert.equal(wa.chatTypeLabel('broadcast'), 'Broadcast list');
  assert.equal(wa.chatTypeLabel('channel'), 'Channel');
  assert.equal(wa.chatTypeLabel('individual'), '');
  assert.equal(wa.chatTypeLabel(undefined), '');
  assert.deepEqual(wa.chatDetails({ chat_type: 'group', archived: true }), ['Group', 'Archived']);
  assert.deepEqual(wa.chatDetails({ chat_type: 'individual', archived: false }), []);
  assert.deepEqual(wa.chatDetails({ chat_type: 'individual', archived: true }), ['Archived']);
  assert.deepEqual(wa.chatDetails({}), []);
  assert.equal(wa.chatName({ display_name: 'Riley Chen', handle: '+15035550101' }), 'Riley Chen');
  assert.equal(wa.chatName({ display_name: '', handle: '+15035550101' }), '+15035550101');
  assert.equal(wa.chatName({ display_name: '', handle: '' }), 'WhatsApp chat');
});

test('calls read like the engine says them, with how long they lasted', () => {
  const call = over => ({ is_video: false, duration: null, outcome: 'answered', direction: 'incoming', ...over });
  assert.equal(wa.callTitle(call()), 'Incoming voice call');
  assert.equal(wa.callTitle(call({ direction: 'outgoing', is_video: true })), 'Outgoing video call');
  assert.equal(wa.callTitle(call({ outcome: 'missed' })), 'Missed voice call');
  assert.equal(wa.callTitle(call({ outcome: 'declined', is_video: true })), 'Declined video call');
  assert.equal(wa.callTitle(call({ outcome: 'failed' })), 'Failed voice call');
  assert.equal(wa.callTitle(call({ outcome: 'no_answer', direction: 'outgoing' })), 'Unanswered voice call');
  assert.equal(wa.callTitle(call({ outcome: 'answered_elsewhere' })), 'Voice call answered on another device');
  assert.equal(wa.callTitle(call({ outcome: 'unknown', is_video: null })), 'WhatsApp call');
  assert.equal(wa.callTitle(call({ outcome: 'unknown', is_video: true })), 'Incoming video call');

  assert.equal(wa.callLength(call({ duration: 83 })), '1:23');
  assert.equal(wa.callLength(call({ duration: 45 })), '45 s');
  assert.equal(wa.callLength(call({ duration: 3723 })), '1:02:03');
  assert.equal(wa.callLength(call({ duration: 0 })), '');
  assert.equal(wa.callLength(call({ duration: null })), '');
  assert.equal(wa.callLength(call({ outcome: 'missed', duration: 12 })), '', 'a missed call has no length');

  assert.equal(wa.isMissedCall(call({ outcome: 'missed' })), true);
  assert.equal(wa.isMissedCall(call({ outcome: 'no_answer' })), true);
  assert.equal(wa.isMissedCall(call()), false);
  assert.equal(wa.durationText(59.6), '1:00');
  assert.equal(wa.durationText(undefined), '0 s');
  assert.equal(wa.durationText(-5), '0 s');
});

test('reactions group into one chip per emoji, in the order first used, "You" for the owner', () => {
  const r = (emoji, sender, is_from_me = false) => ({ emoji, sender, sender_handle: '', is_from_me, date: null });
  const groups = wa.groupReactions([r('❤️', 'Riley'), r('👍', 'me', true), r('❤️', 'Sam'), r('', 'Ghost'), r('❤️', 'Riley')]);
  assert.deepEqual(groups, [
    { emoji: '❤️', names: ['Riley', 'Sam'], mine: false },
    { emoji: '👍', names: ['You'], mine: true },
  ]);
  assert.deepEqual(wa.groupReactions(null), []);
  assert.deepEqual(wa.groupReactions([{ emoji: '😂', sender: '', sender_handle: '+15035550102', is_from_me: false }])[0].names, ['+15035550102']);
  assert.deepEqual(wa.groupReactions([{ emoji: '😂', sender: '', sender_handle: '', is_from_me: false }])[0].names, ['Someone']);
});

test('attachment kinds come from the type, the name, and the message they came with', () => {
  const a = (mime_type, name = '', filename = '') => ({ mime_type, transfer_name: name, filename });
  assert.equal(wa.attachmentKind(a('image/jpeg', 'IMG_1.jpg')), 'image');
  assert.equal(wa.attachmentKind(a('image/webp', 'x.webp'), 'sticker'), 'sticker');
  assert.equal(wa.attachmentKind(a('video/mp4', 'x.mp4'), 'gif'), 'gif');
  assert.equal(wa.attachmentKind(a('video/mp4', 'x.mp4')), 'video');
  assert.equal(wa.attachmentKind(a('audio/ogg', 'PTT-20250303.opus')), 'voice');
  assert.equal(wa.attachmentKind(a('', '', 'Message/Media/1/2/abc.opus')), 'voice');
  assert.equal(wa.attachmentKind(a('audio/mpeg', 'song.mp3')), 'audio');
  assert.equal(wa.attachmentKind(a('application/pdf', 'Lease.pdf'), 'document'), 'document');
  assert.equal(wa.attachmentKind(a('image/jpeg', 'scan.jpg'), 'document'), 'document', 'a photo sent as a file is a file');
  assert.equal(wa.attachmentKind(a('', 'IMG_2.HEIC')), 'image');
  assert.equal(wa.attachmentKind(a('', 'clip.MOV')), 'video');
  // Not in the backup: no file name, only the engine's label
  assert.equal(wa.attachmentKind(a('', 'Photo'), 'image'), 'image');
  assert.equal(wa.attachmentKind(a('', 'Video message'), 'video'), 'video');
  assert.equal(wa.attachmentKind(a('', 'Audio'), 'audio'), 'audio');
  assert.equal(wa.attachmentKind(a('', 'Attachment'), 'unknown'), 'document');
  assert.equal(wa.attachmentKind(a('application/zip', 'x.zip'), 'unknown'), 'document');
});

test('a file that isn\'t in the backup says so, in the engine\'s words when it has them', () => {
  assert.equal(wa.missingText('image'), 'Photo not in this backup');
  assert.equal(wa.missingText('voice'), 'Voice message not in this backup');
  assert.equal(wa.missingText('video', 'Video message'), 'Video message not in this backup');
  assert.equal(wa.missingText('image', 'View-once photo'), 'View-once photo not in this backup');
  assert.equal(wa.missingText('document', 'Attachment'), 'Document not in this backup');
  assert.equal(wa.missingText('document', 'Lease.pdf'), 'Document not in this backup');
  assert.equal(wa.missingText('sticker', ''), 'Sticker not in this backup');
  assert.equal(wa.kindLabel('gif'), 'GIF');

  assert.equal(wa.documentName({ transfer_name: 'Lease.pdf', filename: 'Message/Media/x/Lease.pdf' }), 'Lease.pdf');
  assert.equal(wa.documentName({ transfer_name: '', filename: 'Message/Media/x/y/abc.pdf' }), 'abc.pdf');
  assert.equal(wa.documentName({ transfer_name: 'Document', filename: '' }), '');
  assert.equal(wa.documentName({ transfer_name: 'Attachment', filename: '' }), '');
});

test('sounds Chromium can\'t play open in another app', () => {
  assert.equal(wa.playsInApp({ mime_type: 'audio/ogg', transfer_name: 'a.opus', filename: 'a.opus' }), true);
  assert.equal(wa.playsInApp({ mime_type: 'audio/mpeg', transfer_name: 'a.mp3', filename: '' }), true);
  assert.equal(wa.playsInApp({ mime_type: 'audio/x-caf', transfer_name: 'a.caf', filename: '' }), false);
  assert.equal(wa.playsInApp({ mime_type: '', transfer_name: '', filename: 'Message/a.amr' }), false);
});

test('pictures keep their shape inside the space a bubble gives them', () => {
  assert.deepEqual(wa.fitBox(4032, 3024, 240, 256), { width: 240, height: 180 });
  assert.deepEqual(wa.fitBox(1080, 1920, 240, 256), { width: 144, height: 256 });
  assert.deepEqual(wa.fitBox(100, 50, 240, 256), { width: 100, height: 50 }, 'small pictures aren\'t blown up');
  for (const [w, h] of [[null, 100], [100, 0], [-1, 5], [NaN, 3], [Infinity, 3]]) assert.equal(wa.fitBox(w, h, 240, 256), null);
});

test('file sizes', () => {
  assert.equal(wa.formatBytes(0), '');
  assert.equal(wa.formatBytes(null), '');
  assert.equal(wa.formatBytes(512), '512 bytes');
  assert.equal(wa.formatBytes(2048), '2 KB');
  assert.equal(wa.formatBytes(2.4 * 1024 * 1024), '2.4 MB');
  assert.equal(wa.formatBytes(12 * 1024 * 1024), '12 MB');
  assert.equal(wa.formatBytes(3 * 1024 ** 4), '3072 GB');
});

test('coordinates read with their hemisphere; none when the message has none', () => {
  assert.equal(wa.formatCoordinates(45.5231, -122.6765), '45.52310° N, 122.67650° W');
  assert.equal(wa.formatCoordinates(-33.8688, 151.2093), '33.86880° S, 151.20930° E');
  assert.equal(wa.formatCoordinates(null, 10), '');
  assert.equal(wa.formatCoordinates(10, undefined), '');
  assert.equal(wa.formatCoordinates(NaN, 10), '');
});

test('contact cards show the name and numbers on the vCard', () => {
  const vcard = 'BEGIN:VCARD\r\nVERSION:3.0\r\nN:Okafor;Dana;;;\r\nFN:Dana Okafor\r\nitem1.TEL;type=CELL:+1 503-555-0144\r\nTEL;TYPE=HOME:+1 503-555-0145\r\nEND:VCARD';
  assert.deepEqual(wa.readVcard(vcard), { name: 'Dana Okafor', phones: ['+1 503-555-0144', '+1 503-555-0145'] });
  assert.deepEqual(wa.readVcard('BEGIN:VCARD\nN:Reyes;Ana;;;\nEND:VCARD'), { name: 'Ana Reyes', phones: [] });
  assert.equal(wa.readVcard('BEGIN:VCARD\nFN:Smith\\, Jo\nEND:VCARD').name, 'Smith, Jo');
  assert.equal(wa.readVcard('BEGIN:VCARD\nFN:Long\n  Name\nEND:VCARD').name, 'Long Name', 'folded lines are joined');
  assert.deepEqual(wa.readVcard(null), { name: '', phones: [] });
  assert.deepEqual(wa.readVcard('not a card'), { name: '', phones: [] });
});

test('replies show what they quote, or what it was', () => {
  assert.equal(wa.quoteText({ text: 'See you at 6', message_type: 'text' }), 'See you at 6');
  assert.equal(wa.quoteText({ text: '', message_type: 'image' }), 'Photo');
  assert.equal(wa.quoteText({ text: '  ', message_type: 'audio' }), 'Voice message');
  assert.equal(wa.quoteText({ text: '', message_type: 'mystery' }), 'Message');
  assert.equal(wa.quoteSender({ is_from_me: true, sender: 'You' }), 'You');
  assert.equal(wa.quoteSender({ is_from_me: false, sender: 'Riley Chen' }), 'Riley Chen');
  assert.equal(wa.quoteSender({ is_from_me: false, sender: '' }), 'Someone');
});

test('empty states follow the voicemail contract: calm when WhatsApp isn\'t there, an error when it can\'t be read', () => {
  const notThere = wa.emptyCopy('not_in_backup', undefined);
  assert.equal(notThere.kind, 'empty');
  assert.equal(notThere.title, 'No WhatsApp chats in this backup');
  assert.match(notThere.detail, /wasn't on this iPhone/);
  assert.equal(wa.emptyCopy('no_records').kind, 'empty');
  assert.match(wa.emptyCopy('no_records').detail, /no chats/);
  assert.equal(wa.emptyCopy(undefined, undefined).kind, 'empty');
  assert.equal(wa.emptyCopy(undefined, undefined).detail, undefined);

  const broken = wa.emptyCopy(undefined, "WhatsApp's chat database couldn't be read.");
  assert.deepEqual(broken, { kind: 'error', title: "Couldn't read the WhatsApp chats", detail: "WhatsApp's chat database couldn't be read." });

  const newer = wa.emptyCopy('unsupported_format', 'This WhatsApp version stores chats differently.');
  assert.equal(newer.kind, 'unsupported');
  assert.equal(newer.detail, 'This WhatsApp version stores chats differently.');
  assert.ok(wa.emptyCopy('unsupported_format').detail, 'says something even without the engine\'s words');
  // An error alongside a calm reason stays calm (only a bare error is a failure)
  assert.equal(wa.emptyCopy('not_in_backup', 'odd').kind, 'empty');
});

test('search matches step through a chat in arrival order, not by date or id', () => {
  const entry = (id, chatId, text, sort, type = 'whatsapp', extra = {}) => ({
    id: `${type}:${id}`, type, timestamp: '', title: '', subtitle: '',
    ...(type === 'whatsapp'
      ? { whatsapp: { text, isFromMe: false, sender: 'Riley', messageType: 'text', eventText: null, attachmentLabel: null, conversationName: 'Riley', chatId, chatType: 'individual', isGroup: false, sort, ...extra } }
      : { message: { text, chatId } }),
  });
  // The index is newest first by date; sort (arrival) disagrees for 31 and 12
  const entries = [
    entry(40, 7, 'dinner at 8?', 40),
    entry(12, 7, 'dinner then', 45), // arrived last, stamped earlier
    entry(31, 7, 'Dinner!', 31),
    entry(9, 7, 'lunch', 9),
    entry(5, 8, 'dinner plans', 2),
    entry(77, 7, 'dinner (no order)', null),
    entry(40, 7, 'dinner from sms', null, 'message'), // same number, different database: never a WhatsApp hit
    entry(41, 7, null, 41),
    entry(50, 9, '', 50, 'whatsapp', { messageType: 'shared_location', eventText: 'Location: Dinner Spot' }),
    entry(51, 9, '', 51, 'whatsapp', { messageType: 'document', attachmentLabel: 'dinner-menu.pdf' }),
    entry(52, 9, '', 52, 'whatsapp', { messageType: 'call', eventText: 'Missed voice call' }),
  ];
  const hits = wa.whatsappHits(entries, parseQuery('dinner'));
  assert.deepEqual([...hits.keys()].sort(), [7, 8, 9]);
  // 77 has no arrival order: the engine pages it as the oldest (top of the chat), so it comes first
  assert.deepEqual(hits.get(7), [77, 31, 40, 12]);
  assert.deepEqual(hits.get(8), [5]);
  assert.deepEqual(hits.get(9), [50, 51], 'places and file names match too, as in the whole-backup search');
  assert.equal(wa.whatsappHits(entries, parseQuery('')).size, 0);
  assert.equal(wa.whatsappHits([{ id: 'whatsapp:x', type: 'whatsapp', whatsapp: { text: 'dinner', chatId: 1, sort: 1 } }], parseQuery('dinner')).size, 0, 'a bad id is skipped');
});

// A WhatsApp index entry shaped like useTimeline's normalizeWhatsApp makes one (fictional people)
function waEntry(id, chat, msg = {}) {
  const name = chat.name;
  return {
    id: `whatsapp:${id}`, type: 'whatsapp', timestamp: msg.date ?? '2025-03-03T10:00:00Z', title: '', subtitle: '',
    contactName: name,
    contactIdentifier: chat.type === 'individual' ? chat.handle || null : chat.jid,
    whatsapp: {
      text: msg.text ?? null, isFromMe: msg.isFromMe ?? false, sender: msg.sender ?? '',
      messageType: msg.messageType ?? 'text', eventText: msg.eventText ?? null, attachmentLabel: msg.attachmentLabel ?? null,
      conversationName: name, chatId: chat.id, chatType: chat.type, isGroup: chat.type === 'group',
      sort: 'sort' in msg ? msg.sort : id, call: msg.call ?? null,
    },
  };
}

test('in-chat hits match everything the whole-backup search matches, so a result opens on a hit in its own chat', () => {
  const riley = { id: 3, name: 'Riley Park', type: 'individual', handle: '+15035550190', jid: '15035550190@s.whatsapp.net' };
  const club = { id: 4, name: 'Book club', type: 'group', handle: '', jid: '120363000000000001@g.us' };
  const ana = { id: 5, name: 'Ana Silva', type: 'individual', handle: '+15035550123', jid: '15035550123@s.whatsapp.net' };
  const family = { id: 6, name: 'Family', type: 'group', handle: '', jid: '120363000000000002@g.us' };
  const entries = [
    // A captionless photo Riley sent to the group: found by the sender's name and by "photo"
    waEntry(101, club, { sender: 'Riley Park', messageType: 'image', attachmentLabel: 'Photo' }),
    waEntry(102, riley, { text: 'see you there', sender: 'Riley Park' }),
    waEntry(103, family, { text: 'see you at 6', sender: 'Ana Silva' }),
    waEntry(104, ana, { text: 'ok', sender: 'Ana Silva' }),
    waEntry(105, family, {
      messageType: 'call', eventText: 'Missed voice call', sender: 'Ana Silva',
      call: { outcome: 'missed', direction: 'incoming', isVideo: false, duration: null },
    }),
    // "me" isn't a name to search by
    waEntry(106, club, { text: 'my turn to host', sender: 'me', isFromMe: true }),
  ];
  for (const q of ['riley', 'photo', 'Ana', 'whatsapp call', 'missed whatsapp', 'book club', 'host', 'me', '5035550190']) {
    const terms = parseQuery(q);
    const hits = wa.whatsappHits(entries, terms);
    for (const e of entries) {
      const global = matchesTerms(searchText(e), terms);
      const screen = (hits.get(e.whatsapp.chatId) ?? []).includes(Number(e.id.slice('whatsapp:'.length)));
      assert.equal(screen, global, `"${q}" on ${e.id}: whole-backup search ${global ? 'finds' : "doesn't find"} it, the chat screen must agree`);
    }
  }
  assert.deepEqual(wa.whatsappHits(entries, parseQuery('riley')).get(4), [101], "the group photo is a hit in the group, not only Riley's own chat");
  assert.deepEqual(wa.whatsappHits(entries, parseQuery('missed whatsapp')).get(6), [105]);
  assert.equal(wa.whatsappHits(entries, parseQuery('me')).has(4), false, 'your own messages are not found by "me"');
});

test('hits with no arrival order come first and ties go by id, as the engine pages the chat', () => {
  const chat = { id: 7, name: 'Riley', type: 'individual', handle: '', jid: '' };
  // The index is newest first by date, which says nothing about where these sit
  const entries = [
    waEntry(70, chat, { text: 'tea', sort: 60 }),
    waEntry(65, chat, { text: 'tea', sort: 60 }),
    waEntry(90, chat, { text: 'tea', sort: null }),
    waEntry(80, chat, { text: 'tea', sort: null }),
    waEntry(10, chat, { text: 'tea', sort: 5 }),
  ];
  // sort NULL is last in the engine's "sort DESC, id DESC" pages, so the top of the chat; then sort, then id
  assert.deepEqual(wa.whatsappHits(entries, parseQuery('tea')).get(7), [80, 90, 10, 65, 70]);
});

test("the chat list's search looks at the name and number, never the chat's hidden address", () => {
  const riley = { display_name: 'Riley Park', handle: '+15035550190', chat_identifier: '15035550190@s.whatsapp.net' };
  const club = { display_name: 'Book club', handle: '', chat_identifier: '120363000000000001@g.us' };
  const lid = { display_name: 'Sam', handle: '', chat_identifier: '98765432101234@lid' };
  assert.deepEqual(wa.chatMatchFields(riley), ['Riley Park', '+15035550190'], 'the address is left out, not only filtered later');
  for (const q of ['what', 'app', 'net', 'whatsapp']) assert.equal(matches(q, ...wa.chatMatchFields(riley)), false, q);
  for (const q of ['us', '1203', '120363']) assert.equal(matches(q, ...wa.chatMatchFields(club)), false, q);
  assert.equal(matches('lid', ...wa.chatMatchFields(lid)), false);
  assert.equal(matches('9876', ...wa.chatMatchFields(lid)), false);
  assert.equal(matches('riley', ...wa.chatMatchFields(riley)), true);
  assert.equal(matches('book', ...wa.chatMatchFields(club)), true);
  assert.equal(matches('503-555-0190', ...wa.chatMatchFields(riley)), true, 'the number, however it is typed');
});

test('document names are shown without invisible characters that disguise them, with their real extension', () => {
  const rlo = 'Invoice‮fdp.exe'; // reads "Invoiceexe.pdf" on screen
  assert.equal(wa.cleanFileName(rlo), 'Invoicefdp.exe');
  assert.equal(wa.cleanFileName('a⁦b⁩c​d‎‏﻿e⁠.txt'), 'abcde.txt');
  assert.equal(wa.cleanFileName(null), '');
  assert.equal(wa.documentName({ transfer_name: rlo, filename: '' }), 'Invoicefdp.exe');
  assert.equal(wa.documentName({ transfer_name: '', filename: 'Message/Media/x/Re‮cod.scr' }), 'Recod.scr');
  assert.equal(wa.fileTypeLabel(rlo), 'EXE file');
  assert.equal(wa.fileTypeLabel('Lease.pdf'), 'PDF file');
  assert.equal(wa.fileTypeLabel('notes'), 'File');
  assert.deepEqual(wa.splitExtension('Quarterly report.final.docx'), { stem: 'Quarterly report.final', ext: '.docx' });
  assert.deepEqual(wa.splitExtension('README'), { stem: 'README', ext: '' });
  assert.deepEqual(wa.splitExtension('.hidden'), { stem: '.hidden', ext: '' });
});

test('a copied file is opened only when the engine says it is safe to open; anything else is shown in its folder', async () => {
  const files = () => {
    const calls = [];
    return {
      calls,
      openPath: async p => { calls.push(['open', p]); return ''; },
      showInFolder: async p => { calls.push(['show', p]); },
    };
  };
  let f = files();
  assert.equal(await wa.handOver({ path: '/tmp/oe/1/Lease.pdf', openable: true }, f), null);
  assert.deepEqual(f.calls, [['open', '/tmp/oe/1/Lease.pdf']]);

  for (const r of [{ path: '/tmp/oe/2/Invoice.exe', openable: false }, { path: '/tmp/oe/3/run.bat' }]) {
    f = files();
    assert.equal(await wa.handOver(r, f), wa.SHOWN_IN_FOLDER);
    assert.deepEqual(f.calls, [['show', r.path]], 'never opened (that would run it), only shown in its folder');
  }
  assert.doesNotMatch(wa.SHOWN_IN_FOLDER, /executable|openable|path/i, 'plain words');

  f = files();
  f.openPath = async () => 'No application knows how to open it';
  assert.equal(await wa.handOver({ path: '/tmp/oe/4/a.pdf', openable: true }, f), "Couldn't open it: No application knows how to open it");
  f = files();
  assert.equal(await wa.handOver({ error: "This file isn't in the backup", empty_reason: 'not_in_backup' }, f), "This file isn't in the backup");
  assert.equal(await wa.handOver({ error: 'Attachment not found' }, f), 'Attachment not found');
  assert.equal(await wa.handOver({}, f), "Couldn't copy the file out of the backup");
  assert.equal(await wa.handOver(null, f), "Couldn't copy the file out of the backup");
  assert.deepEqual(f.calls, [], 'nothing handed over when there is no copy');
});

test("the engine's whole-store search gets the longest word; its results are checked against every word and ordered", () => {
  assert.equal(wa.engineSearchText('the dinner'), 'dinner');
  assert.equal(wa.engineSearchText('"see you" tonight'), 'see you', 'a phrase in quotes is one piece');
  assert.equal(wa.engineSearchText('  '), '');
  assert.equal(wa.engineSearchText('Café'), 'Café', 'sent as typed, accents and all');

  const hit = (message_id, chat_id, text, date, over = {}) => ({
    message_id, chat_id, text, date, is_from_me: false, sender: 'Riley Park', chat_name: 'Book club', ...over,
  });
  // Chat 4 is partly in the index (its newest messages); chat 9 isn't at all
  const indexHits = new Map([[4, [40, 41]]]);
  const results = [
    hit(41, 4, 'dinner at 8', '2025-03-04T10:00:00Z'), // already an index hit
    hit(12, 4, 'dinner then', '2019-05-01T10:00:00Z'),
    hit(11, 4, 'dinner first', '2019-04-01T10:00:00Z'),
    hit(13, 4, 'dinner (no date)', null),
    hit(90, 9, 'dinner plans', '2018-01-02T00:00:00Z', { chat_name: 'Old friends' }),
    hit(88, 9, 'dinner plans', '2018-01-01T00:00:00Z', { chat_name: 'Old friends' }),
    hit(88, 9, 'dinner plans', '2018-01-01T00:00:00Z', { chat_name: 'Old friends' }), // listed twice
    hit(91, 9, 'dinner alone', '2018-01-03T00:00:00Z', { chat_name: 'Old friends' }),
  ];
  const merged = wa.mergeSearchHits(indexHits, results, parseQuery('dinner plans'));
  // Only results with every word stay; the index's own hits stay as they were
  assert.deepEqual(merged.get(4), [40, 41]);
  assert.deepEqual(merged.get(9), [88, 90]);

  const all = wa.mergeSearchHits(indexHits, results, parseQuery('dinner'));
  // What the index lacks is older than what it has (it reads each chat newest first): first, by date
  assert.deepEqual(all.get(4), [13, 11, 12, 40, 41]);
  assert.deepEqual(all.get(9), [88, 90, 91]);
  assert.deepEqual(indexHits.get(4), [40, 41], "the index's map isn't changed");

  // A word found only in the chat's name or the sender, as the index search would
  const byName = wa.mergeSearchHits(new Map(), results, parseQuery('dinner riley'));
  assert.deepEqual(byName.get(9), [88, 90, 91]);
  const mine = wa.mergeSearchHits(new Map(), [hit(5, 2, 'dinner', null, { is_from_me: true, sender: 'me' })], parseQuery('dinner me'));
  assert.equal(mine.has(2), false, '"me" is not a name to search by');
  assert.equal(wa.mergeSearchHits(indexHits, null, parseQuery('dinner')).get(4).length, 2);
});
