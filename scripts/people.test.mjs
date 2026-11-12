// Tests for who a phone number or email belongs to (src/lib/people.ts): the
// person picker on the Timeline, People and Year views, and how numbers are shown;
// and for People's list of who you were in touch with (src/components/people/gather.ts).
// Rows are shaped like the engine's records once the app has normalised them:
// conversations (chat_identifier, display_name), calls (address, contact_name),
// voicemail (phone_number, contact_name), and list_contacts cards (phones, emails).
// Run with: node --test scripts/people.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';

const {
  normPhone, identifiersMatch, buildIdentifierGroupMap, getContactGroup,
  buildContactOptions, rowsForPerson, identifiersForPerson, formatPhone, displayName, isWhatsAppAddress,
} = loadTs('src/lib/people.ts');
const { gatherPeople, linkCards, idKey, PERSON_KINDS } = loadTs('src/components/people/gather.ts');
const { matches } = loadTs('src/lib/search.ts');

const row = (contactName, contactIdentifier, extra = {}) => ({ contactName, contactIdentifier, ...extra });

test('normPhone keeps the last 10 digits, so one number written many ways compares equal', () => {
  for (const s of ['+1 (555) 123-4567', '15551234567', '+15551234567', '5551234567', '555.123.4567', '‭+1 555‑123‑4567‬']) {
    assert.equal(normPhone(s), '5551234567', s);
  }
  // UK mobile, international and national forms
  assert.equal(normPhone('+44 7700 900123'), normPhone('07700 900123'));
  // Short codes and short local numbers stay as they are
  assert.equal(normPhone('72727'), '72727');
  assert.equal(normPhone('911'), '911');
  // No digits at all
  assert.equal(normPhone('jane@icloud.com'), '');
  assert.equal(normPhone(''), '');
  // Only ASCII digits count: a number typed in Arabic-Indic digits normalises to nothing
  assert.equal(normPhone('٥٥٥١٢٣٤٥٦٧'), '');
});

test('identifiersMatch: exact, or the same phone number written differently', () => {
  assert.ok(identifiersMatch('+15551234567', '+15551234567'));
  assert.ok(identifiersMatch('+15551234567', '(555) 123-4567'));
  assert.ok(identifiersMatch('jane@icloud.com', 'jane@icloud.com'));
  assert.ok(!identifiersMatch('+15551234567', '+15551234568'));
  // Short codes only match exactly: 5 digits are too few to be sure
  assert.ok(identifiersMatch('72727', '72727'));
  assert.ok(!identifiersMatch('72727', '+72727'));
  // Two emails share no digits
  assert.ok(!identifiersMatch('jane@icloud.com', 'john@icloud.com'));
});

// buildContactOptions merges Jane@Example.com and jane@example.com into one person
test('identifiersMatch ignores the case of an email address', () => {
  assert.ok(identifiersMatch('Jane@Example.com', 'jane@example.com'));
});

test('buildIdentifierGroupMap links every form of a card\'s numbers and emails', () => {
  const contacts = [
    { phones: ['+1 (555) 123-4567', '+1 555 987 6543'], emails: ['Jane.Doe@Example.com'] },
    { phones: ['+44 20 7946 0958'], emails: [] },
  ];
  const map = buildIdentifierGroupMap(contacts);
  const jane = map.get('5551234567');
  assert.ok(jane);
  for (const id of ['+1 (555) 123-4567', '5551234567', '+1 555 987 6543', '5559876543', 'Jane.Doe@Example.com', 'jane.doe@example.com']) {
    assert.equal(map.get(id), jane, id);
    assert.ok(jane.has(id), id);
  }
  assert.notEqual(map.get('2079460958'), jane);
  assert.equal(buildIdentifierGroupMap([]).size, 0);
});

test('a number on two cards (a shared landline) belongs to the card read last', () => {
  const map = buildIdentifierGroupMap([
    { phones: ['+1 503 555 0100'], emails: ['mom@example.com'] },
    { phones: ['+1 503 555 0100'], emails: ['dad@example.com'] },
  ]);
  assert.ok(map.get('5035550100').has('dad@example.com'));
  assert.ok(map.get('mom@example.com').has('5035550100'));
});

test('getContactGroup finds a card from any way of writing its number', () => {
  const map = buildIdentifierGroupMap([{ phones: ['+15551234567'], emails: ['jane@icloud.com'] }]);
  for (const id of ['+15551234567', '5551234567', '(555) 123-4567', '1-555-123-4567', 'jane@icloud.com']) {
    assert.ok(getContactGroup(id, map)?.has('jane@icloud.com'), id);
  }
  assert.equal(getContactGroup('+15559999999', map), null);
  assert.equal(getContactGroup('someone@else.com', map), null);
  assert.equal(getContactGroup('jane@icloud.com', new Map()), null);
});

test('the picker lists each person once, by name, across number formats', () => {
  const rows = [
    row('Mom', '+15035550123'),        // a conversation
    row('Mom', '5035550123'),          // a call
    row('Mom', '+1 (503) 555-0123'),   // a voicemail
    row('Zoë Ångström', 'zoe@example.se'),
    row('Zoë Ångström', 'ZOE@example.se'),
    row(null, '+15035550999'),         // no name: not listed
    row('Unknown', null),              // no identifier: not listed
    row('李雷', '+8613800138000'),
    row('محمد', '+971501234567'),
    row('👩‍👩‍👧 Family', 'chat123456789012345678'),
  ];
  const options = buildContactOptions(rows);
  assert.equal(options.length, 5);
  assert.deepEqual(options.find(o => o.name === 'Mom'), { identifier: '+15035550123', name: 'Mom' });
  assert.equal(options.filter(o => o.name === 'Zoë Ångström').length, 1);
  assert.ok(options.some(o => o.name === 'محمد' && o.identifier === '+971501234567'));
  assert.ok(options.some(o => o.name === '👩‍👩‍👧 Family'));
  // Sorted the way the person's language sorts names
  const names = options.map(o => o.name);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b)));
  assert.ok(names.indexOf('Mom') < names.indexOf('Zoë Ångström'));
});

test('the first name seen for a number is the one listed', () => {
  const options = buildContactOptions([row('Mom', '+15035550123'), row('Mother', '503-555-0123')]);
  assert.deepEqual(options, [{ identifier: '+15035550123', name: 'Mom' }]);
});

// One person's records across a backup
const MOM = '+15035550123';
const ROWS = [
  row('Mom', MOM, { id: 'conv' }),
  row('Mom', '5035550123', { id: 'call' }),
  row('+1 (503) 555-0123', '+1 (503) 555-0123', { id: 'voicemail-no-name' }),
  row('Mom', 'mom@icloud.com', { id: 'imessage-email' }),
  row('Mom & Dad', 'chat987654321098765432', { id: 'group' }),
  row('Dad', '+15035550188', { id: 'dad' }),
  row('Mom', null, { id: 'no-identifier' }),
  row('Momo', '+81312345678', { id: 'other-person' }),
];

test('rowsForPerson matches by number, by address-book card and by name', () => {
  const options = buildContactOptions(ROWS);
  // Without the address book, the email row still matches by name
  const ids = rowsForPerson(MOM, ROWS, options, new Map()).map(r => r.id);
  assert.deepEqual(ids, ['conv', 'call', 'voicemail-no-name', 'imessage-email']);
  // Picking the email finds the phone rows through the name too
  assert.deepEqual(rowsForPerson('mom@icloud.com', ROWS, options, new Map()).map(r => r.id),
    ['conv', 'call', 'imessage-email']);
});

test('the address book links an email to a number even when the names differ', () => {
  const rows = [row('Mom', MOM, { id: 'conv' }), row('mother@example.com', 'mother@example.com', { id: 'email' })];
  const options = buildContactOptions(rows);
  const map = buildIdentifierGroupMap([{ phones: ['(503) 555-0123'], emails: ['Mother@Example.com'] }]);
  assert.deepEqual(rowsForPerson(MOM, rows, options, map).map(r => r.id), ['conv', 'email']);
  assert.deepEqual(rowsForPerson(MOM, rows, options, new Map()).map(r => r.id), ['conv']);
});

test('a person picked with a differently-cased email still gets all their rows', () => {
  const rows = [row('Jane', 'Jane@Example.com', { id: 'conv' }), row('jane@example.com', 'jane@example.com', { id: 'facetime' })];
  const options = buildContactOptions(rows);
  assert.equal(options.length, 1);
  assert.deepEqual(rowsForPerson(options[0].identifier, rows, options, new Map()).map(r => r.id), ['conv', 'facetime']);
});

test('identifiersForPerson: everything the engine needs to count one person', () => {
  const options = buildContactOptions(ROWS);
  const map = buildIdentifierGroupMap([{ phones: ['+1 503-555-0123'], emails: ['mom@icloud.com', 'mom.work@example.com'] }]);
  const ids = identifiersForPerson(MOM, ROWS, options, map);
  assert.equal(ids[0], MOM);
  for (const id of ['5035550123', '+1 (503) 555-0123', 'mom@icloud.com', 'mom.work@example.com', '+1 503-555-0123']) {
    assert.ok(ids.includes(id), id);
  }
  assert.ok(!ids.includes('+15035550188'));
  assert.equal(new Set(ids).size, ids.length);
  // Someone with no records and no card is just their own identifier
  assert.deepEqual(identifiersForPerson('+15550000000', [], [], new Map()), ['+15550000000']);
});

test('formatPhone groups North American numbers and leaves everything else alone', () => {
  assert.equal(formatPhone('+14065550109'), '+1 406 555 0109');
  assert.equal(formatPhone('14065550109'), '+1 406 555 0109');
  assert.equal(formatPhone('4065550109'), '406 555 0109');
  for (const s of ['+442079460958', '+33612345678', '72727', '911', 'jane@icloud.com', '+1 406 555 0109', '', 'chat123456789012345678']) {
    assert.equal(formatPhone(s), s, s);
  }
  assert.equal(formatPhone(null), null);
});

test('displayName: the contact name, or the number when the name is just the number', () => {
  assert.equal(displayName('Mom', '+14065550109'), 'Mom');
  assert.equal(displayName(null, '+14065550109'), '+1 406 555 0109');
  assert.equal(displayName('', '+14065550109'), '+1 406 555 0109');
  assert.equal(displayName(undefined, 'jane@icloud.com'), 'jane@icloud.com');
  // The engine echoes the number back as the name when there's no contact
  assert.equal(displayName('+14065550109', '+14065550109'), '+1 406 555 0109');
  assert.equal(displayName('(406) 555-0109', '+14065550109'), '+1 406 555 0109');
  // A name with digits in it is still a name
  assert.equal(displayName('555 Pizza', '+14065550109'), '555 Pizza');
  assert.equal(displayName('Room 4065550109', '+14065550109'), 'Room 4065550109');
  // Names in any script, and emoji, come through untouched
  for (const name of ['محمد', 'שרה', '李雷', 'Zoë 🎉', '👨‍👩‍👧‍👦']) assert.equal(displayName(name, '+14065550109'), name);
});

test("isWhatsAppAddress: a WhatsApp chat's own address, not a number or an email", () => {
  for (const id of ['15035550142@s.whatsapp.net', '120363000000000001@g.us', '15035550142-1418000000@g.us',
    '99000000000001@lid', '1700000000@broadcast', '120363000000000002@newsletter', ' 120363000000000001@G.US ']) {
    assert.ok(isWhatsAppAddress(id), id);
  }
  for (const id of ['+15035550142', 'riley@example.com', 'chat123456789012345678', 'whatsapp@example.net', '', null, undefined]) {
    assert.ok(!isWhatsAppAddress(id), String(id));
  }
});

// ── People (gather.ts), with WhatsApp: entries shaped like useTimeline's normalizers make them ──
let seq = 0;
const at = day => `2024-03-${String(day).padStart(2, '0')}T12:00:00+00:00`;
const sms = (name, id, day, extra = {}) => ({
  id: `message:${++seq}`, type: 'message', timestamp: at(day), contactName: name, contactIdentifier: id,
  message: { text: 'hi', isFromMe: false, sender: id, messageType: 'text', conversationName: name, service: 'iMessage', chatId: 7, isGroup: false, ...extra },
});
const call = (name, id, day) => ({
  id: `call:${++seq}`, type: 'call', timestamp: at(day), contactName: name, contactIdentifier: id,
  call: { direction: 'incoming', status: 'answered', duration: 60, app: 'com.apple.Telephony' },
});
const wa = (name, id, day, extra = {}) => ({
  id: `whatsapp:${++seq}`, type: 'whatsapp', timestamp: at(day), contactName: name, contactIdentifier: id,
  whatsapp: { text: 'hi', isFromMe: false, sender: name, messageType: 'text', eventText: null, attachmentLabel: null,
    conversationName: name, chatId: 7, chatType: 'individual', isGroup: false, sort: seq, call: null, ...extra },
});

test('People counts WhatsApp alongside Messages, calls and voicemail', () => {
  assert.deepEqual(PERSON_KINDS, ['message', 'whatsapp', 'call', 'voicemail']);
  // Newest first, as the index hands them over
  const entries = [
    wa('Riley Okafor', '+15035550142', 9, { chatId: 12 }),
    wa('Riley Okafor', '+15035550142', 8, { chatId: 12 }),
    sms('Riley Okafor', '+15035550142', 7, { chatId: 7 }),
    call('Riley Okafor', '5035550142', 6),
  ];
  const [riley, ...rest] = gatherPeople(entries);
  assert.equal(rest.length, 0, 'one person across WhatsApp, Messages and calls');
  assert.deepEqual(riley.counts, { message: 1, whatsapp: 2, call: 1, voicemail: 0 });
  assert.equal(riley.total, 4);
  assert.equal(riley.last, at(9));
  // Each app's own conversation: WhatsApp's chat 12 is never taken for sms.db's chat 12
  assert.equal(riley.chatId, 7);
  assert.equal(riley.waChatId, 12);
  assert.equal(riley.waChatType, 'individual');
  assert.equal(riley.isGroup, false);
  assert.ok(riley.ids.has('5035550142'));
});

test('someone you only talk to on WhatsApp is in People, with no Messages conversation', () => {
  const [ana] = gatherPeople([wa('Ana Lindqvist', '+15035550177', 3, { chatId: 5 })]);
  assert.deepEqual(ana.counts, { message: 0, whatsapp: 1, call: 0, voicemail: 0 });
  assert.equal(ana.chatId, undefined);
  assert.equal(ana.waChatId, 5);
  assert.equal(ana.identifier, '+15035550177');
});

test('WhatsApp groups, broadcast lists and channels are listed with the groups', () => {
  const people = gatherPeople([
    wa('Family', '120363000000000001@g.us', 5, { chatType: 'group', isGroup: true, chatId: 30, sender: 'Ana' }),
    wa('Party list', '1700000000@broadcast', 4, { chatType: 'broadcast', chatId: 31, isFromMe: true, sender: 'me' }),
    wa('Garden club', '120363000000000002@newsletter', 3, { chatType: 'channel', chatId: 32 }),
  ]);
  const by = Object.fromEntries(people.map(p => [p.name, p]));
  for (const name of ['Family', 'Party list', 'Garden club']) assert.ok(by[name].isGroup, name);
  assert.deepEqual([by.Family.waChatType, by['Party list'].waChatType, by['Garden club'].waChatType], ['group', 'broadcast', 'channel']);
  assert.equal(by.Family.waChatId, 30);
  // A group's WhatsApp address isn't a number to search by
  assert.equal(by.Family.numbers.size, 0);
  // and never links to someone's card, whatever its digits
  const card = { id: 1, display_name: 'Lookalike', phones: ['+1 000 000 0001'], emails: [] };
  assert.equal(linkCards(people, [card]).personOf.size, 0);
});

test("a WhatsApp chat that couldn't be tied to a number isn't anyone in People", () => {
  const people = gatherPeople([
    wa('Unknown contact', null, 2, { chatId: 40 }),
    wa('Riley Okafor', '+15035550142', 1, { chatId: 12 }),
  ]);
  assert.deepEqual(people.map(p => p.name), ['Riley Okafor']);
});

test("a person's WhatsApp chat is the most recent one", () => {
  // Riley's number in two chats (the newest first): the button opens the newer
  const [riley] = gatherPeople([
    wa('Riley Okafor', '+15035550142', 9, { chatId: 14 }),
    wa('Riley Okafor', '+15035550142', 2, { chatId: 12 }),
  ]);
  assert.equal(riley.waChatId, 14);
});

// ── WhatsApp names and addresses aren't how people are told apart ──
// WhatsApp names an unsaved number by what its owner calls themselves, so two
// strangers can share a name, and every unnamed group shares a placeholder.

test('two WhatsApp numbers with the same name are two people', () => {
  const people = gatherPeople([
    wa('Alex', '+15035550101', 5, { chatId: 3 }),
    wa('Alex', '+447700900123', 4, { chatId: 4 }),
  ]);
  assert.equal(people.length, 2);
  const us = people.find(p => p.identifier === '+15035550101');
  const uk = people.find(p => p.identifier === '+447700900123');
  assert.deepEqual([us.waChatId, us.total, [...us.ids]], [3, 1, ['5035550101']]);
  assert.deepEqual([uk.waChatId, uk.total, [...uk.ids]], [4, 1, ['7700900123']]);
  assert.notEqual(us.key, uk.key);
});

test('unnamed WhatsApp groups, lists and channels are each their own entry', () => {
  const people = gatherPeople([
    wa('WhatsApp group', '120363000000000011@g.us', 9, { chatType: 'group', isGroup: true, chatId: 50 }),
    wa('WhatsApp group', '120363000000000012@g.us', 8, { chatType: 'group', isGroup: true, chatId: 51 }),
    wa('Broadcast list', '1700000000@broadcast', 7, { chatType: 'broadcast', chatId: 52 }),
    wa('Broadcast list', '1700000001@broadcast', 6, { chatType: 'broadcast', chatId: 53 }),
    wa('WhatsApp channel', '120363000000000013@newsletter', 5, { chatType: 'channel', chatId: 54 }),
    wa('WhatsApp channel', '120363000000000014@newsletter', 4, { chatType: 'channel', chatId: 55 }),
    // and never one of the same name from Messages
    sms('WhatsApp group', 'chat111111111111111111', 3, { isGroup: true, chatId: 8 }),
  ]);
  assert.equal(people.length, 7);
  assert.deepEqual(people.map(p => p.waChatId ?? p.chatId).sort((a, b) => a - b), [8, 50, 51, 52, 53, 54, 55]);
  assert.ok(people.every(p => p.isGroup && p.total === 1));
});

test('a WhatsApp chat joins whoever has its number, whatever either is called', () => {
  const [riley, ...rest] = gatherPeople([
    wa('Riley', '+15035550142', 9, { chatId: 12 }),             // WhatsApp's name for them
    sms('Riley Okafor', '(503) 555-0142', 8, { chatId: 7 }),    // the address book's
    call('Riley Okafor', '5035550142', 6),
  ]);
  assert.equal(rest.length, 0);
  assert.equal(riley.name, 'Riley Okafor', "the address book's name, not WhatsApp's");
  assert.deepEqual(riley.counts, { message: 1, whatsapp: 1, call: 1, voicemail: 0 });
  assert.equal(riley.waChatId, 12);
  assert.equal(riley.chatId, 7);
  // An unsaved number whose name is just the number joins too
  const [unsaved, ...others] = gatherPeople([
    sms('+15035550188', '+15035550188', 3),
    wa('Sam', '+15035550188', 2, { chatId: 20 }),
  ]);
  assert.equal(others.length, 0);
  assert.deepEqual(unsaved.counts, { message: 1, whatsapp: 1, call: 0, voicemail: 0 });
});

test('a WhatsApp number on someone\'s card joins them; numbers only on WhatsApp go by the card too', () => {
  const card = { id: 1, display_name: 'Riley Okafor', phones: ['+1 503 555 0142', '+44 7700 900999'], emails: [] };
  const entries = [
    sms('Riley Okafor', '+15035550142', 8, { chatId: 7 }),
    wa('Riley O', '+447700900999', 9, { chatId: 12 }),
  ];
  assert.equal(gatherPeople(entries, [card]).length, 1);
  // Without the address book, nothing says the UK number is theirs
  assert.equal(gatherPeople(entries).length, 2);
  // Two numbers on one card, both only on WhatsApp: one person
  const two = gatherPeople([
    wa('Riley', '+15035550142', 9, { chatId: 12 }),
    wa('Riley (UK)', '+447700900999', 8, { chatId: 13 }),
  ], [card]);
  assert.equal(two.length, 1);
  assert.deepEqual([two[0].identifier, two[0].waChatId, two[0].total], ['+15035550142', 12, 2]);
});

test("a WhatsApp chat never joins someone by name alone, or a group by its address's digits", () => {
  const people = gatherPeople([
    sms('Alex', '+15035550101', 5, { chatId: 7 }),
    wa('Alex', '+447700900123', 4, { chatId: 4 }),
    // A Messages group whose id ends in the same ten digits as a WhatsApp number
    sms('Book club', 'chat684461829582950397', 3, { isGroup: true, chatId: 9 }),
    wa('Jo', '+1 958 295 0397', 2, { chatId: 6 }),
  ]);
  assert.deepEqual(people.map(p => [p.name, p.total, p.isGroup]).sort(),
    [['Alex', 1, false], ['Alex', 1, false], ['Book club', 1, true], ['Jo', 1, false]]);
});

test("texts, calls and voicemail are still one person per name; WhatsApp's other number isn't added by it", () => {
  // Unchanged by WhatsApp being there: two numbers the address book calls Mom are one Mom
  const people = gatherPeople([
    sms('Mom', '+15035550123', 5),
    call('Mom', '+15035550124', 4),
    wa('Mom', '+15035550125', 3, { chatId: 2 }),
  ]);
  const moms = people.filter(p => p.name === 'Mom');
  assert.equal(moms.length, 2, "texts and calls together; WhatsApp's other number on its own");
  assert.deepEqual(moms.map(p => p.total).sort(), [1, 2]);
});

test('the picker and the Timeline never tie WhatsApp rows together by name', () => {
  const rows = [
    wa('Alex', '+15035550101', 5, { chatId: 3 }),
    wa('Alex', '+447700900123', 4, { chatId: 4 }),
  ];
  const options = buildContactOptions(rows);
  assert.equal(options.length, 2);
  assert.deepEqual(rowsForPerson('+447700900123', rows, options, new Map()).map(r => r.id), [rows[1].id]);
  assert.deepEqual(rowsForPerson('+15035550101', rows, options, new Map()).map(r => r.id), [rows[0].id]);
  // Nor a WhatsApp-only person to someone from Messages of the same name, either way round
  const mixed = [sms('Alex', '+15035550101', 5), wa('Alex', '+447700900123', 4)];
  const mixedOptions = buildContactOptions(mixed);
  assert.deepEqual(rowsForPerson('+447700900123', mixed, mixedOptions, new Map()).map(r => r.id), [mixed[1].id]);
  assert.deepEqual(rowsForPerson('+15035550101', mixed, mixedOptions, new Map()).map(r => r.id), [mixed[0].id]);
  // A WhatsApp chat with no number is no one's
  const noNumber = [sms('Riley', '+15035550142', 5), wa('Riley', null, 4)];
  assert.deepEqual(rowsForPerson('+15035550142', noNumber, buildContactOptions(noNumber), new Map()).map(r => r.id), [noNumber[0].id]);
});

test("the address book's name wins over WhatsApp's in the picker, and still ties their other rows", () => {
  const rows = [
    wa('Riley', '+15035550142', 9),                    // read first
    sms('Riley Okafor', '5035550142', 8),
    sms('Riley Okafor', 'riley@example.com', 7),       // their iMessage email, tied by name
  ];
  const options = buildContactOptions(rows);
  assert.deepEqual(options.map(o => o.name).sort(), ['Riley Okafor', 'Riley Okafor']);
  assert.deepEqual(rowsForPerson('+15035550142', rows, options, new Map()).map(r => r.id), rows.map(r => r.id));
  // Only WhatsApp has a name for a number: it's listed under it
  assert.deepEqual(buildContactOptions([wa('Sam', '+15035550188', 1)]), [{ identifier: '+15035550188', name: 'Sam' }]);
});

test("a WhatsApp chat's address is never compared as a phone number", () => {
  const GROUP = '120363025246125486@g.us';
  for (const id of [GROUP, '1700000000@broadcast', '120363000000000002@newsletter', '86123456789012@lid', '15035550142@s.whatsapp.net']) {
    assert.equal(normPhone(id), '', id);
  }
  // A phone number ending in the same ten digits as the group's address
  const PHONE = '+1 524 612 5486';
  assert.ok(!identifiersMatch(PHONE, GROUP));
  assert.ok(!identifiersMatch(GROUP, '5246125486'));
  assert.ok(identifiersMatch(GROUP, GROUP.toUpperCase()));
  assert.equal(getContactGroup(GROUP, buildIdentifierGroupMap([{ phones: [PHONE], emails: [] }])), null);
  assert.equal(idKey(GROUP), GROUP);
  assert.equal(idKey(' 120363025246125486@G.US '), GROUP);

  const rows = [
    wa('Book club', GROUP, 5, { chatType: 'group', isGroup: true, chatId: 30, sender: 'Ana' }),
    sms('Pat', PHONE, 4),
  ];
  // Listed apart in the picker, and picking one never brings in the other
  const options = buildContactOptions(rows);
  assert.equal(options.length, 2);
  assert.deepEqual(rowsForPerson(PHONE, rows, options, new Map()).map(r => r.id), [rows[1].id]);
  assert.deepEqual(rowsForPerson(GROUP, rows, options, new Map()).map(r => r.id), [rows[0].id]);
  // or on Pat's card
  const map = buildIdentifierGroupMap([{ phones: [PHONE], emails: [] }]);
  assert.deepEqual(rowsForPerson(PHONE, rows, options, map).map(r => r.id), [rows[1].id]);

  // People: searching part of a number doesn't find the group, and opening People on Pat's number opens Pat
  const people = gatherPeople(rows);
  const club = people.find(p => p.name === 'Book club');
  assert.deepEqual([...club.ids], [GROUP]);
  for (const q of ['612', '5246125486', '+15246125486']) {
    assert.ok(!matches(q, club.name, ...club.numbers, ...club.ids), q);
  }
  assert.ok(matches('book', club.name, ...club.numbers, ...club.ids));
  assert.equal(people.find(p => p.ids.has(idKey('+15246125486'))).name, 'Pat');
});
