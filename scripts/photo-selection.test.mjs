// Tests for picking photos and narrowing Photos to some dates (src/lib/photoSelection.ts,
// OE-193 and OE-195): which photos a click picks, what the screen says, and the dates as
// list_photos and export_photos take them (Unix seconds; the day after To left out).
// Run with: node --test scripts/photo-selection.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';
import { enUS, onlyIn, rerunInTimeZones } from './test-helpers/time-zones.mjs';

const {
  pickPhoto, pickedWords, pickingHint, photoDates, hasDates, datesWords, savedNarrowedTitle, isVideo,
} = loadTs('src/lib/photoSelection.ts');
const { saveLabel, albumTitle, ALL_PHOTOS, FAVORITES } = loadTs('src/lib/photoAlbums.ts');

const ORDER = ['a', 'b', 'c', 'd', 'e', 'f'];
const sorted = set => [...set].sort();

test('a click picks a photo, and a second click unpicks it', () => {
  const one = pickPhoto(new Set(), ORDER, 'c', null, false);
  assert.deepEqual(sorted(one), ['c']);
  assert.deepEqual(sorted(pickPhoto(one, ORDER, 'e', 'c', false)), ['c', 'e']);
  assert.deepEqual(sorted(pickPhoto(one, ORDER, 'c', 'c', false)), []);
});

test('a click never changes the picks it was given', () => {
  const before = new Set(['a']);
  pickPhoto(before, ORDER, 'b', 'a', false);
  pickPhoto(before, ORDER, 'e', 'a', true);
  assert.deepEqual(sorted(before), ['a']);
});

test('Shift picks every photo from the last one clicked, either way along the grid', () => {
  assert.deepEqual(sorted(pickPhoto(new Set(['b']), ORDER, 'e', 'b', true)), ['b', 'c', 'd', 'e']);
  assert.deepEqual(sorted(pickPhoto(new Set(['e']), ORDER, 'b', 'e', true)), ['b', 'c', 'd', 'e']);
});

test('Shift adds to what is picked, and never unpicks', () => {
  const picked = new Set(['a', 'c']);
  assert.deepEqual(sorted(pickPhoto(picked, ORDER, 'd', 'c', true)), ['a', 'c', 'd']);
  // The photo Shift-clicked is in the run even if it was picked already
  assert.deepEqual(sorted(pickPhoto(new Set(['a', 'f']), ORDER, 'f', 'd', true)), ['a', 'd', 'e', 'f']);
});

test('Shift with nothing clicked before, or a photo no longer shown, picks just the one', () => {
  assert.deepEqual(sorted(pickPhoto(new Set(), ORDER, 'd', null, true)), ['d']);
  assert.deepEqual(sorted(pickPhoto(new Set(['z']), ORDER, 'd', 'z', true)), ['d', 'z']);
});

const photo = (kind, duration = 0) => ({ kind, duration });

test('what is picked, in words', () => {
  assert.equal(pickedWords([photo('photo')]), '1 photo');
  assert.equal(pickedWords([photo('photo'), photo('live_photo')]), '2 photos');
  assert.equal(pickedWords([photo('video', 12)]), '1 video');
  assert.equal(pickedWords([photo('video', 12), photo('video', 3)]), '2 videos');
  assert.equal(pickedWords([photo('photo'), photo('photo'), photo('video', 3)]), '2 photos and 1 video');
  assert.equal(pickedWords([]), '0 photos');
});

test('anything with a length counts as a video, as the grid draws it', () => {
  assert.equal(isVideo(photo('unknown', 4)), true);
  assert.equal(isVideo(photo('video')), true);
  assert.equal(isVideo(photo('live_photo')), false);
});

test('English numbers in what is picked', { skip: !enUS && 'needs an en-US locale' }, () => {
  assert.equal(pickedWords(Array.from({ length: 1234 }, () => photo('photo'))), '1,234 photos');
});

test('while picking, the screen says how to pick until something is picked', () => {
  assert.equal(pickingHint([]), 'Click the photos and videos to save. Shift-click selects every one in between.');
  assert.equal(pickingHint([photo('photo'), photo('video', 2)]), '1 photo and 1 video selected');
});

test('the Save button names what it saves', () => {
  assert.equal(saveLabel(null), 'Save all');
  assert.equal(saveLabel('12'), 'Save album');
  assert.equal(saveLabel(FAVORITES, 0, true), 'Save these');
  assert.equal(saveLabel(null, 0, true), 'Save these');
  assert.equal(saveLabel('12', 3, true), 'Save 3 selected');
  assert.equal(saveLabel(null, 1), 'Save 1 selected');
});

test('an album is named, All Photos is not', () => {
  const albums = [{ id: ALL_PHOTOS, title: 'All Photos', asset_count: 9 }, { id: '12', title: 'Trip', asset_count: 3 }];
  assert.equal(albumTitle(null, albums), null);
  assert.equal(albumTitle(ALL_PHOTOS, albums), null);
  assert.equal(albumTitle('12', albums), 'Trip');
  assert.equal(albumTitle('404', albums), null);
});

// ── Dates ──

const local = (y, m, d) => new Date(y, m - 1, d).getTime() / 1000;

test('no dates, no limits', () => {
  assert.deepEqual(photoDates('', ''), {});
  assert.equal(hasDates(photoDates('', '')), false);
});

test('From is the start of that day here, and To takes in all of its day', () => {
  const dates = photoDates('2024-07-01', '2024-07-31');
  assert.deepEqual(dates, { date_from: local(2024, 7, 1), date_to: local(2024, 8, 1) });
  assert.equal(hasDates(dates), true);
});

test('one end is enough', () => {
  assert.deepEqual(photoDates('2024-07-01', ''), { date_from: local(2024, 7, 1) });
  assert.deepEqual(photoDates('', '2024-07-31'), { date_to: local(2024, 8, 1) });
});

test('the last day of the year runs to the first of the next', () => {
  assert.deepEqual(photoDates('2023-12-31', '2023-12-31'), { date_from: local(2023, 12, 31), date_to: local(2024, 1, 1) });
});

test('a leap day', () => {
  assert.deepEqual(photoDates('2024-02-29', '2024-02-29'), { date_from: local(2024, 2, 29), date_to: local(2024, 3, 1) });
});

test('days the wrong way round are swapped', () => {
  assert.deepEqual(photoDates('2024-07-31', '2024-07-01'), photoDates('2024-07-01', '2024-07-31'));
});

test('a day that does not exist is no limit', () => {
  assert.deepEqual(photoDates('2023-02-29', 'soon'), {});
  assert.deepEqual(photoDates('2024-13-01', '2024-07-31'), { date_to: local(2024, 8, 1) });
});

test('a day in a daylight saving change still covers the whole day', () => {
  // US clocks went forward on 2024-03-10 and back on 2024-11-03: 23 and 25 hours here
  for (const [day, next] of [['2024-03-10', [2024, 3, 11]], ['2024-11-03', [2024, 11, 4]]]) {
    const { date_from, date_to } = photoDates(day, day);
    assert.equal(date_to, local(...next));
    assert.ok(date_to - date_from >= 22.5 * 3600 && date_to - date_from <= 25 * 3600);
  }
});

test('the days in a sentence', { skip: onlyIn('America/Los_Angeles') }, () => {
  assert.equal(datesWords('2024-07-01', '2024-07-31'), ' from July 1, 2024 to July 31, 2024');
  assert.equal(datesWords('2024-07-31', '2024-07-01'), ' from July 1, 2024 to July 31, 2024');
  assert.equal(datesWords('2024-07-04', '2024-07-04'), ' on July 4, 2024');
  assert.equal(datesWords('2024-07-01', ''), ' from July 1, 2024 on');
  assert.equal(datesWords('', '2024-07-31'), ' up to July 31, 2024');
  assert.equal(datesWords('', ''), '');
});

test('the saved notice says what the dates and the kind left', { skip: onlyIn('America/Los_Angeles') }, () => {
  assert.equal(savedNarrowedTitle(null, 'all', '2024-07-01', '2024-07-31'),
    'Saved photos and videos from July 1, 2024 to July 31, 2024');
  assert.equal(savedNarrowedTitle('Trip', 'video', '2024-07-01', ''), 'Saved videos in Trip from July 1, 2024 on');
  assert.equal(savedNarrowedTitle('Favorites', 'live_photo', '', ''), 'Saved Live Photos in Favorites');
  assert.equal(savedNarrowedTitle(null, 'screenshot', '', '2024-07-31'), 'Saved screenshots up to July 31, 2024');
});

rerunInTimeZones(import.meta.url);
