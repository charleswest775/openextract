// Tests for how the one search box matches and marks text.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-search-test-'));

/** Transpile one TS file to CommonJS in a temp dir and require it. */
function load(rel) {
  const src = fs.readFileSync(path.join(root, rel), 'utf-8');
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const file = path.join(tmp, rel.replace(/[\\/]/g, '_') + '.cjs');
  fs.writeFileSync(file, out);
  return require(file);
}

const { fold, parseQuery, matches, haystack, matchesTerms, searchText, highlightRanges } = load('src/lib/search.ts');

const words = query => parseQuery(query).map(t => t.text);
// What the one search box finds: does `query` match these fields, the way global search builds them
const finds = (query, fields, numbers = []) => matchesTerms(haystack(fields, numbers), parseQuery(query));
// The parts of `text` a query marks
const marked = (text, query) => highlightRanges(text, parseQuery(query)).map(([a, b]) => text.slice(a, b));

test('fold drops case and accents', () => {
  assert.equal(fold('Café Crème'), 'cafe creme');
  assert.equal(fold('ÅNGSTRÖM'), 'angstrom');
  // Already decomposed text folds the same way
  assert.equal(fold('Café'), 'cafe');
});

test('parseQuery splits words and keeps quoted phrases whole', () => {
  assert.deepEqual(words('  Bread  RECIPE '), ['bread', 'recipe']);
  assert.deepEqual(words('"sourdough starter" feed'), ['sourdough starter', 'feed']);
  assert.deepEqual(words('"unclosed phrase'), ['unclosed phrase']);
  assert.deepEqual(words('""'), []);
});

test('parseQuery keeps a phone number typed with spaces as one number', () => {
  assert.deepEqual(words('+1 503 555 0123'), ['+1 503 555 0123']);
  assert.deepEqual(words('(503) 555-0123'), ['(503) 555-0123']);
  assert.deepEqual(words('503 555 0123'), ['503 555 0123']);
  assert.deepEqual(words('06 12 34 56 78'), ['06 12 34 56 78']);
  assert.deepEqual(words('call +1 503 555 0123 "vet" today'), ['call', '+1 503 555 0123', 'vet', 'today']);
  // A + starts a new number
  assert.deepEqual(words('+1 503 555 0123 +1 503 555 0199'), ['+1 503 555 0123', '+1 503 555 0199']);
  // Years and short codes stay separate words
  assert.deepEqual(words('2024 2025'), ['2024', '2025']);
  assert.deepEqual(words('555 0123'), ['555', '0123']);
  assert.deepEqual(words('9:30 2026'), ['9:30', '2026']);
  // Numbers typed side by side keep their words too, unless it starts with +
  assert.deepEqual(parseQuery('97201 97202')[0].words.map(t => t.text), ['97201', '97202']);
  assert.equal(parseQuery('+1 503 555 0123')[0].words, undefined);
});

test('numbers typed side by side still match one by one', () => {
  const vet = 'Vet: Dr. Alvarez at Alderbrook, 503-555-0123. Shots booked for 2026.';
  for (const query of ['503-555-0123 2026', '2026 503-555-0123', '(503) 555-0123 2026', '2026 503 555 0123', '5035550123 2026']) {
    assert.ok(finds(query, [vet]), `${query} in global search`);
    assert.ok(matches(query, 'Pets', vet), `${query} on the Notes screen`);
  }
  assert.deepEqual(marked(vet, '503-555-0123 2026'), ['503-555-0123', '2026']);
  // A message from the vet about an order
  assert.ok(finds('5035550123 98765', ['Order 98765 ready'], ['+15035550123']));
  // Zip codes, rooms and years, in any order
  assert.ok(finds('97201 97202', ['Deliveries to 97202 and 97201']));
  assert.ok(matches('101 102 103', 'Plans', 'Rooms 103, 101 and 102 booked'));
  assert.ok(finds('2024 2025 2026', ['Budgets: 2026, 2025, 2024']));
  assert.ok(!finds('97201 97202', ['Deliveries to 97202']));
});

test('every word must appear, in any order', () => {
  assert.ok(matches('recipe bread', 'Bread recipe from Mom'));
  assert.ok(matches('bread', 'Title', 'Body mentions BREAD'));
  assert.ok(!matches('bread butter', 'Bread recipe'));
  assert.ok(matches('', 'anything'));
});

test('a quoted phrase must appear as written', () => {
  assert.ok(matches('"bread recipe"', 'my bread recipe'));
  assert.ok(!matches('"bread recipe"', 'recipe for bread'));
});

test('accents in the query or the text do not matter', () => {
  assert.ok(matches('cafe', 'Meet at the café'));
  assert.ok(matches('café', 'Meet at the cafe'));
});

test('phone numbers match however they are punctuated', () => {
  const hay = haystack(['Theo Navarro'], ['+1 (503) 555-0142']);
  assert.ok(matchesTerms(hay, parseQuery('555-0142')));
  assert.ok(matchesTerms(hay, parseQuery('(503) 5550142')));
  assert.ok(matchesTerms(hay, parseQuery('theo')));
  assert.ok(!matchesTerms(hay, parseQuery('555-9999')));
});

// One number written every way people save it: each form must find every other one
const SAME_NUMBER = {
  'North America': [
    '(503) 555-0123', '503-555-0123', '503.555.0123', '503 555 0123', '5035550123',
    '15035550123', '1-503-555-0123', '+15035550123', '+1 503 555 0123', '+1 (503) 555-0123', '+1-503-555-0123',
  ],
  'United Kingdom': ['+44 20 7946 0958', '+442079460958', '+44 (0)20 7946 0958', '0044 20 7946 0958', '020 7946 0958', '02079460958'],
  France: ['+33 6 12 34 56 78', '+33612345678', '06 12 34 56 78', '06.12.34.56.78', '0612345678'],
  Germany: ['+49 30 1234567', '+49 (0)30 1234567', '030 1234567'],
};

for (const [country, forms] of Object.entries(SAME_NUMBER)) {
  test(`a ${country} number matches however it's typed or saved`, () => {
    for (const saved of forms) {
      const note = `Vet: Dr. Alvarez at Alderbrook, ${saved}. Ask for Sam.`;
      for (const typed of forms) {
        const said = `${JSON.stringify(typed)} finds ${JSON.stringify(saved)}`;
        assert.ok(finds(typed, [note]), `${said} inside a note, in global search`);
        assert.ok(matches(typed, 'Pets', note), `${said} inside a note, on the Notes screen`);
        assert.ok(finds(typed, ['Alderbrook Veterinary Clinic'], [saved]), `${said} as who a message is from`);
        assert.ok(matches(typed, 'Alderbrook Veterinary Clinic', null, saved), `${said} on an address-book card`);
        assert.ok(marked(note, typed).length > 0, `${said} and marks it`);
      }
    }
  });
}

// The same check for one saved number typed every way
function findsEverywhere(saved, typed) {
  const note = `Office: ${saved}. Ask for Sam.`;
  const said = `${JSON.stringify(typed)} finds ${JSON.stringify(saved)}`;
  assert.ok(finds(typed, [note]), `${said} inside a note, in global search`);
  assert.ok(matches(typed, 'Work', note), `${said} inside a note, on the Notes screen`);
  assert.ok(finds(typed, ['Sam'], [saved]), `${said} as who a message is from`);
  assert.ok(matches(typed, 'Sam', null, saved), `${said} on an address-book card`);
  assert.ok(marked(note, typed).length > 0, `${said} and marks it`);
}

test('a number saved with a slash matches however it is typed', () => {
  for (const saved of ['030/1234567', '+49 30/1234567', '+49 (0)30/1234567']) {
    for (const typed of [...SAME_NUMBER.Germany, '0301234567', '030-1234567', '+4930 1234567']) findsEverywhere(saved, typed);
  }
  // A date typed with slashes is still a plain word
  assert.equal(parseQuery('12/25')[0].digits, undefined);
});

test('a number written with non-breaking spaces or other dashes matches', () => {
  const french = ['06 12 34 56 78', '0612345678', '+33 6 12 34 56 78'];
  for (const space of [' ', ' ', ' ']) {
    for (const typed of french) findsEverywhere(['06', '12', '34', '56', '78'].join(space), typed);
  }
  const american = ['5035550123', '503-555-0123', '(503) 555-0123', '+1 503 555 0123'];
  for (const dash of ['‑', '–', '−']) {
    for (const typed of american) findsEverywhere(`503${dash}555${dash}0123`, typed);
  }
  findsEverywhere('(503) 555-0123', '5035550123');
  // Typed with an en dash, as when pasted from a web page
  findsEverywhere('503-555-0123', '503–555–0123');
});

test('global search finds a number in notes, messages and people however it is typed', () => {
  // The synthetic Maren backup: two notes mention the vet, and 11 messages come from them
  const notes = [1, 2].map(i => ({
    id: `note:${i}`, type: 'note', timestamp: '', contactName: null, contactIdentifier: null,
    note: { noteId: i, title: 'Pets', bodyPreview: '', body: 'Vet: Dr. Alvarez at Alderbrook, 503-555-0123', modified: '' },
  }));
  const messages = Array.from({ length: 11 }, (_, i) => ({
    id: `message:${i}`, type: 'message', timestamp: '', contactName: 'Alderbrook Veterinary Clinic', contactIdentifier: '+15035550123',
    message: { text: 'Biscuit is due for his shots', conversationName: 'Alderbrook Veterinary Clinic', chatId: 1 },
  }));
  const person = { name: 'Alderbrook Veterinary Clinic', identifier: '+15035550123', ids: ['5035550123'] };
  for (const query of ['(503) 555-0123', '503 555 0123', '5035550123', '503.555.0123', '1-503-555-0123', '+1 503 555 0123', '+15035550123']) {
    const terms = parseQuery(query);
    const found = [...notes, ...messages].filter(e => matchesTerms(searchText(e), terms)).length
      + (matches(query, person.name, person.identifier, ...person.ids) ? 1 : 0);
    assert.equal(found, 14, query);
  }
});

test('a country code on either side still matches', () => {
  // Typed with +1, saved without it, and the other way round
  assert.ok(matches('+15035550123', 'Sam', '(503) 555-0123'));
  assert.ok(matches('+1 503 555 0123', 'Sam', '503-555-0123'));
  assert.ok(matches('1-503-555-0123', 'Sam', '503.555.0123'));
  assert.ok(matches('(503) 555-0123', 'Sam', '+15035550123'));
  assert.ok(finds('503-555-0123', ['Sam'], ['+15035550123']));
  // Abroad, the 0 dialled at home stands in for the country code
  assert.ok(finds('06 12 34 56 78', ['Marie'], ['+33612345678']));
  assert.ok(matches('+33 6 12 34 56 78', 'Marie', '06 12 34 56 78'));
  assert.ok(matches('020 7946 0958', 'Office', '+44 (0)20 7946 0958'));
  assert.ok(matches('+44 20 7946 0958', 'Office', '020 7946 0958'));
  // Part of a number typed with its country code finds it saved without one
  assert.ok(matches('+1 503 555', 'Sam', '(503) 555-0123'));
});

test('People and saved cards match a number however it is typed', () => {
  // A person's ids are the last 10 digits of each number; their numbers are as the backup has them
  const vet = { name: 'Alderbrook Veterinary Clinic', numbers: ['+15035550123'], ids: ['5035550123'] };
  const marie = { name: 'Marie', numbers: ['+33698765432', '+33612345678'], ids: ['3698765432', '3612345678'] };
  for (const typed of SAME_NUMBER['North America']) assert.ok(matches(typed, vet.name, ...vet.numbers, ...vet.ids), typed);
  // Marie's second number, not just the first one seen, matches typed the way it's dialled in France
  for (const typed of SAME_NUMBER.France) assert.ok(matches(typed, marie.name, ...marie.numbers, ...marie.ids), typed);
  const card = { display_name: 'Alderbrook Veterinary Clinic', organization: null, phones: ['+1 503 555 0123'], emails: ['frontdesk@alderbrook.vet'] };
  for (const typed of SAME_NUMBER['North America']) {
    assert.ok(matches(typed, card.display_name, card.organization, ...card.phones, ...card.emails), typed);
  }
  // Part of a number still finds the card, as before
  assert.ok(matches('503-55', card.display_name, ...card.phones));
});

test('a number never matches across two different numbers', () => {
  // A card with two numbers: the area code of one and the line of the other
  const card = ['Sam', '+1 503 555 0199', '+1 206 555 0123'];
  assert.ok(!matches('+1 503 555 0123', ...card));
  assert.ok(!matches('503-555-0123', ...card));
  assert.ok(!finds('5035550123', ['Sam'], card.slice(1)));
  // Two numbers in one note, side by side
  const note = 'Call 503-555-0199 or 206-555-0123';
  assert.ok(!matches('5035550123', 'Plans', note));
  assert.ok(!finds('5035550123', [note]));
  assert.ok(!matches('01992065550123', 'Plans', note));
  const list = 'Numbers: 503-555-0123 503-555-0199';
  assert.ok(finds('5035550199', [list]) && finds('5035550123', [list]));
  assert.ok(!finds('01235035', [list]));
  // Other numbers in a note aren't glued together
  const codes = 'Gate code 1234, then room 5678.';
  for (const query of ['45', '4567', '12345678']) assert.ok(!matches(query, 'Plans', codes), query);
  // Nor when the note is only numbers, one per line or several on one line
  for (const body of ['503-555-0199\n206-555-0123', '503-555-0199 206-555-0123']) {
    for (const query of ['5550199206', '01992065', '+1 199 206 5550']) assert.ok(!matches(query, 'Numbers', body), `${query} in ${JSON.stringify(body)}`);
    assert.ok(matches('5035550199', 'Numbers', body) && matches('(206) 555-0123', 'Numbers', body));
  }
  for (const query of ['45', '345678', '12345678']) assert.ok(!matches(query, 'Locker', '1234\n5678'), query);
  assert.ok(matches('1234', 'Locker', '1234\n5678') && matches('5678', 'Locker', '1234\n5678'));
  // Close but different numbers
  assert.ok(!matches('503-555-0123', 'Sam', '603-555-0123'));
  assert.ok(!matches('+1 503 555 0123', 'Sam', '(603) 555-0123'));
  assert.ok(!matches('06 12 34 56 78', 'Marie', '+33 6 12 34 56 79'));
});

test('years, times and short numbers match as written, not as phone numbers', () => {
  assert.ok(matches('2026', 'Trip', 'Lisbon in June 2026'));
  assert.ok(!matches('2026', 'Trip', 'Lisbon on the 20th, 26 of us'));
  assert.ok(matches('9:30', 'Plans', 'Dentist at 9:30'));
  assert.ok(matches('2024 2025', 'Budget', '2025 was better than 2024'));
  assert.ok(matches('555', 'Vet', '(503) 555-0123'));
  // Inside a contact's number, as before
  assert.ok(finds('0123', ['Alderbrook'], ['+15035550123']));
  assert.ok(finds('(503)', ['Alderbrook'], ['+15035550123']));
  // A date isn't a phone number for a short query
  assert.ok(!matches('1103', 'Plans', 'Meeting 2026-11-03'));
  assert.ok(!finds('1103', ['Meeting 2026-11-03']));
});

test('text in quotes matches a number only as written', () => {
  assert.ok(matches('"503-555-0123"', 'Vet', 'Alderbrook, 503-555-0123'));
  assert.ok(!matches('"5035550123"', 'Vet', 'Alderbrook, 503-555-0123'));
  assert.ok(!finds('"(503) 555-0123"', ['Alderbrook'], ['+15035550123']));
});

test('highlightRanges marks a number found by its digits', () => {
  const note = 'Vet: Dr. Alvarez at Alderbrook, 503-555-0123.';
  assert.deepEqual(marked(note, '5035550123'), ['503-555-0123']);
  assert.deepEqual(marked(note, '(503) 555-0123'), ['503-555-0123']);
  // Found without its country code: all of it
  assert.deepEqual(marked(note, '+1 503 555 0123'), ['503-555-0123']);
  assert.deepEqual(marked('Marie: 06 12 34 56 78', '+33 6 12 34 56 78'), ['06 12 34 56 78']);
  // Part of a number: just that part
  assert.deepEqual(marked('Call +1 (503) 555-0123', '5550123'), ['555-0123']);
  // In quotes: only as written
  assert.deepEqual(marked(note, '"5035550123"'), []);
});

test('the phone numbers in a record are worked out only when a search asks for one', () => {
  const hay = haystack(['Vet: 503-555-0123'], ['+15035550199']);
  assert.ok(matchesTerms(hay, parseQuery('vet 2026 555')) === false && hay.numbers === undefined);
  assert.ok(matchesTerms(hay, parseQuery('5035550123')));
  assert.equal(hay.numbers, '5035550123\n15035550199');
});

test('searchText covers the whole note body, not just its start', () => {
  const note = {
    id: 'note:1', type: 'note', timestamp: '2025-01-01T00:00:00Z', contactName: null, contactIdentifier: null,
    note: { noteId: 1, title: 'Plans', bodyPreview: 'short', body: 'x'.repeat(500) + ' sourdough', modified: '' },
  };
  assert.ok(matchesTerms(searchText(note), parseQuery('sourdough')));
  // Cached: the same object gives the same string
  assert.equal(searchText(note), searchText(note));
});

test('searchText says what kind of record it is', () => {
  const call = {
    id: 'call:1', type: 'call', timestamp: '', contactName: 'Greg', contactIdentifier: '+15035550111',
    call: { direction: 'incoming', status: 'missed', duration: 0, app: 'com.apple.Telephony' },
  };
  assert.ok(matchesTerms(searchText(call), parseQuery('missed greg')));
  const shot = {
    id: 'photo:1', type: 'photo', timestamp: '', contactName: null, contactIdentifier: null,
    photo: { filename: 'IMG_0001.PNG', fileHash: 'x', kind: 'screenshot', width: 1, height: 1, duration: 0 },
  };
  assert.ok(matchesTerms(searchText(shot), parseQuery('screenshot')));
});

test('highlightRanges marks every match, merged and in order', () => {
  assert.deepEqual(highlightRanges('Bread and more bread', parseQuery('bread')), [[0, 5], [15, 20]]);
  assert.deepEqual(highlightRanges('breadcrumbs', parseQuery('bread crumb')), [[0, 10]]);
  assert.deepEqual(highlightRanges('nothing here', parseQuery('bread')), []);
});

test('highlightRanges points at the original text when accents were folded', () => {
  const text = 'Le Café Noir';
  const [[from, to]] = highlightRanges(text, parseQuery('cafe'));
  assert.equal(text.slice(from, to), 'Café');
  const decomposed = 'Café au lait';
  const [[a, b]] = highlightRanges(decomposed, parseQuery('café'));
  assert.equal(decomposed.slice(a, b), 'Cafe\u0301');
});
