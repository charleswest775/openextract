// Tests for the Photos screen's People list (src/lib/photoPeople.ts): who's listed before
// "Show more", how unnamed people are called, and the words above the grid and on Save.
// Run with: node --test scripts/photo-people.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';

const {
  personLabel, personDescription, peopleShown, showMorePeople, peopleShowing, peopleSavedTitle, togglePerson,
  SAVE_PEOPLE, PEOPLE_SHOWN_FROM, PEOPLE_SHOWN_AT_LEAST,
} = loadTs('src/lib/photoPeople.ts');

const person = (id, in_backup, name = null) => ({
  id, name, contact_uri: null, photo_count: in_backup, in_backup, not_in_backup: 0, missing_from_folder: 0, face: null,
});
const ids = list => list.map(p => p.id);

test('most people are never named, so they are "Unnamed person"', () => {
  assert.equal(personLabel(person('1', 3)), 'Unnamed person');
  assert.equal(personLabel(person('1', 3, '  ')), 'Unnamed person');
  assert.equal(personLabel(person('1', 3, 'Riley Sample')), 'Riley Sample');
  assert.equal(personDescription(person('1', 58)), 'Unnamed person, 58 photos');
  assert.equal(personDescription(person('1', 1, 'Riley')), 'Riley, 1 photo');
  assert.equal(personDescription(person('1', 1200)), `Unnamed person, ${(1200).toLocaleString()} photos`);
});

test(`people with ${PEOPLE_SHOWN_FROM}+ photos are listed first, the rest behind Show more`, () => {
  const people = [person('a', 58), person('b', 55), person('c', 44), person('d', 10), person('e', 9),
    person('f', 3), person('g', 2), person('h', 1), person('i', 0)];
  assert.deepEqual(ids(peopleShown(people, false)), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.deepEqual(ids(peopleShown(people, true)), ids(people));
});

test(`at least ${PEOPLE_SHOWN_AT_LEAST} are listed when few have many photos, but never someone with none here`, () => {
  assert.deepEqual(ids(peopleShown([person('a', 4), person('b', 2), person('c', 1)], false)), ['a', 'b', 'c']);
  const few = [person('a', 4), person('b', 2), person('c', 1), person('d', 1), person('e', 1), person('f', 1), person('g', 0)];
  assert.deepEqual(ids(peopleShown(few, false)), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(ids(peopleShown([person('a', 0)], false)), []);
});

test('someone picked stays listed even when they would be behind Show more', () => {
  const people = [person('a', 9), person('b', 9), person('c', 9), person('d', 9), person('e', 9), person('f', 1)];
  assert.deepEqual(ids(peopleShown(people, false, ['f'])), ['a', 'b', 'c', 'd', 'e', 'f']);
});

test('Show more says how many more', () => {
  assert.equal(showMorePeople(1), 'Show 1 more person');
  assert.equal(showMorePeople(236), 'Show 236 more people');
});

test('the words before the chips follow how many are picked and the switch', () => {
  assert.equal(peopleShowing(1, 'any'), 'Photos of');
  assert.equal(peopleShowing(1, 'all'), 'Photos of');
  assert.equal(peopleShowing(2, 'any'), 'Photos with any of');
  assert.equal(peopleShowing(3, 'all'), 'Photos with all of');
});

test('saving people: the button and the saved message', () => {
  assert.equal(SAVE_PEOPLE, 'Save their photos');
  assert.equal(peopleSavedTitle([person('1', 2, 'Riley Sample')], 'any'), 'Saved photos of Riley Sample');
  assert.equal(peopleSavedTitle([person('1', 2)], 'any'), 'Saved photos of an unnamed person');
  assert.equal(peopleSavedTitle([person('1', 2), person('2', 2)], 'any'), 'Saved photos of 2 people');
  assert.equal(peopleSavedTitle([person('1', 2), person('2', 2)], 'all'), 'Saved photos of 2 people together');
});

test('picking and unpicking someone keeps the order they were picked in', () => {
  assert.deepEqual(togglePerson([], '5'), ['5']);
  assert.deepEqual(togglePerson(['5'], '2'), ['5', '2']);
  assert.deepEqual(togglePerson(['5', '2'], '5'), ['2']);
});
