// Tests for one person's page on People (src/components/people/stream.ts): the
// chips over everything between you, what each one shows, what an empty stream
// says, and the Timeline's pointer to someone named in its search. People are fictional.
// Run with: node --test scripts/people-stream.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';

const { kindChips, streamTypes, nothingBetween, personNamed, countOf } = loadTs('src/components/people/stream.ts');

const zero = { message: 0, whatsapp: 0, call: 0, photo: 0, voicemail: 0, note: 0, browser: 0 };

test('the chips are Everything, then each kind between you, in order', () => {
  const chips = kindChips({ ...zero, message: 114, call: 1, photo: 7, note: 1 }, 'all');
  assert.deepEqual(chips.map(c => c.label), ['Everything · 116', '114 messages', '1 call', '7 photos', '1 shared note']);
  // Photos come inside their messages, so Everything doesn't count them again
  assert.equal(chips[0].kind, 'all');
  assert.equal(kindChips({ ...zero, message: 1234 }, 'all')[0].label, 'Everything · 1,234');
});

test('a kind the dates or search leave none of has no chip, unless it is the one picked', () => {
  assert.deepEqual(kindChips({ ...zero, message: 3 }, 'all').map(c => c.kind), ['all', 'message']);
  assert.deepEqual(kindChips({ ...zero, message: 3 }, 'voicemail').map(c => c.label), ['Everything · 3', '3 messages', '0 voicemails']);
  // Web visits are never between people
  assert.deepEqual(kindChips({ ...zero, browser: 9 }, 'all').map(c => c.label), ['Everything · 0']);
});

test('Everything shows every kind but photos on their own; Photos shows the messages that carry them', () => {
  assert.deepEqual([...streamTypes('all')].sort(), ['call', 'message', 'note', 'voicemail', 'whatsapp']);
  assert.deepEqual([...streamTypes('photo')], ['photo']);
  assert.deepEqual([...streamTypes('note')], ['note']);
});

test('the list says how many of each kind, singular or plural', () => {
  assert.equal(countOf('whatsapp', 1), '1 WhatsApp message');
  assert.equal(countOf('voicemail', 2), '2 voicemails');
  assert.equal(countOf('note', 3), '3 shared notes');
});

test('an empty stream says what left nothing', () => {
  assert.equal(nothingBetween('Karin', { kind: 'all', dates: true, within: '' }), 'Nothing with Karin in these dates');
  assert.equal(nothingBetween('Karin', { kind: 'all', dates: false, within: ' tent ' }), 'Nothing with Karin matches “tent”');
  assert.equal(nothingBetween('Karin', { kind: 'call', dates: true, within: 'tent' }), 'No calls with Karin in these dates match “tent”');
});

const person = (name, total, isGroup = false) => ({ name, total, isGroup, identifier: name, numbers: new Set(), ids: new Set() });
const PEOPLE = [person('Theo Navarro', 482), person('Climbing crew', 300, true), person('Karin Lindqvist', 114), person('Lucía Navarro', 41)];

test("a name in the Timeline's search points to that person, most in touch first", () => {
  assert.equal(personNamed(PEOPLE, 'karin')?.name, 'Karin Lindqvist');
  assert.equal(personNamed(PEOPLE, 'navarro')?.name, 'Theo Navarro');
  assert.equal(personNamed(PEOPLE, 'lucia')?.name, 'Lucía Navarro');
  // Groups, words that aren't anyone's name, and a single letter name no one
  assert.equal(personNamed(PEOPLE, 'climbing'), undefined);
  assert.equal(personNamed(PEOPLE, 'tent'), undefined);
  assert.equal(personNamed(PEOPLE, 'k'), undefined);
  assert.equal(personNamed(PEOPLE, 'karin tent'), undefined);
});
