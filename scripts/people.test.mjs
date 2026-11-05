// Tests for who a phone number or email belongs to (src/lib/people.ts): the
// person picker on the Timeline, People and Year views, and how numbers are shown.
// Rows are shaped like the engine's records once the app has normalised them:
// conversations (chat_identifier, display_name), calls (address, contact_name),
// voicemail (phone_number, contact_name), and list_contacts cards (phones, emails).
// Run with: node --test scripts/people.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';

const {
  normPhone, identifiersMatch, buildIdentifierGroupMap, getContactGroup,
  buildContactOptions, rowsForPerson, identifiersForPerson, formatPhone, displayName,
} = loadTs('src/lib/people.ts');

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

test('identifiersMatch ignores the case of an email address', {
  todo: 'BUG: buildContactOptions merges Jane@Example.com and jane@example.com into one person (lower-cased key), '
    + 'but identifiersMatch/getContactGroup compare emails case-sensitively, so picking that person drops rows with the other casing',
}, () => {
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

test('a person picked with a differently-cased email still gets all their rows', {
  todo: 'BUG: the picker merges the two casings, but rowsForPerson only matches the exact casing (no address book, different names)',
}, () => {
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
