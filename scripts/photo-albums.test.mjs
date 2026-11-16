// Tests for the Photos sidebar (src/lib/photoAlbums.ts, #215): Favorites and Hidden after All
// Photos, albums nested in their folders, shared albums last, and the save button's words.
// Run with: node --test scripts/photo-albums.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';

const { photoSidebar, hasSidebar, saveLabel, savedTitle, albumCount, ALL_PHOTOS, FAVORITES, HIDDEN } =
  loadTs('src/lib/photoAlbums.ts');

const album = (id, title, extra = {}) => ({ id, title, asset_count: 0, kind: 'user', parent_id: null, ...extra });
// A tree as titles: 'Album', or ['Folder', [...]].
const titles = nodes => nodes.map(n => (n.children.length || n.album.kind === 'folder'
  ? [n.album.title, titles(n.children)]
  : n.album.title));

const LIBRARY = [
  album(ALL_PHOTOS, 'All Photos', { kind: 'smart', asset_count: 900, in_backup: 640 }),
  album(FAVORITES, 'Favorites', { kind: 'smart', asset_count: 12, in_backup: 9 }),
  album(HIDDEN, 'Hidden', { kind: 'smart', asset_count: 3, in_backup: 3 }),
  album('11', 'Darkroom', { kind: 'folder' }),
  album('12', 'Flagged', { parent_id: '11', asset_count: 4 }),
  album('13', 'Rejected', { parent_id: '11', asset_count: 2 }),
  album('14', 'Exported', { kind: 'folder', parent_id: '11' }),
  album('15', 'Prints', { parent_id: '14' }),
  album('16', 'WhatsApp'),
  album('20', 'Family', { kind: 'shared' }),
];

test('Favorites and Hidden come apart from the albums, and All Photos keeps its own count', () => {
  const sidebar = photoSidebar(LIBRARY);
  assert.deepEqual(sidebar.smart.map(a => a.title), ['Favorites', 'Hidden']);
  assert.equal(albumCount(sidebar.allPhotos), 640);
  assert.equal(albumCount(sidebar.smart[0]), 9);
});

test('albums sit inside their folders, folders inside folders, in the order sent', () => {
  assert.deepEqual(titles(photoSidebar(LIBRARY).albums), [
    ['Darkroom', ['Flagged', 'Rejected', ['Exported', ['Prints']]]],
    'WhatsApp',
  ]);
});

test('shared albums are listed on their own', () => {
  assert.deepEqual(photoSidebar(LIBRARY).shared.map(a => a.title), ['Family']);
});

test('a flat list from an older engine shows as before', () => {
  const sidebar = photoSidebar([
    { id: ALL_PHOTOS, title: 'All Photos', asset_count: 5 },
    { id: '1', title: 'Trip', asset_count: 2 },
    { id: '2', title: 'Birthday', asset_count: 1 },
  ]);
  assert.deepEqual(titles(sidebar.albums), ['Trip', 'Birthday']);
  assert.deepEqual([sidebar.smart, sidebar.shared], [[], []]);
  assert.equal(hasSidebar(sidebar), true);
});

test("an album whose folder isn't listed is at the top level", () => {
  assert.deepEqual(titles(photoSidebar([album('12', 'Kept', { parent_id: '99' })]).albums), ['Kept']);
});

test('a loop of folders, which only a damaged library holds, still shows every album', () => {
  const sidebar = photoSidebar([
    album('1', 'A', { kind: 'folder', parent_id: '2' }),
    album('2', 'B', { kind: 'folder', parent_id: '1' }),
    album('3', 'C', { parent_id: '1' }),
  ]);
  const seen = [];
  const walk = nodes => nodes.forEach(n => { seen.push(n.album.title); walk(n.children); });
  walk(sidebar.albums);
  assert.deepEqual(seen.sort(), ['A', 'B', 'C']);
});

test("the backup's own album called All Photos isn't a second All Photos", () => {
  assert.deepEqual(titles(photoSidebar([album('7', ' all photos '), album('8', 'Trip')]).albums), ['Trip']);
});

test('no sidebar for a library with no albums and nothing in Favorites or Hidden', () => {
  const empty = [
    album(ALL_PHOTOS, 'All Photos', { kind: 'smart', asset_count: 0, in_backup: 0 }),
    album(FAVORITES, 'Favorites', { kind: 'smart', in_backup: 0 }),
    album(HIDDEN, 'Hidden', { kind: 'smart', in_backup: 0 }),
  ];
  assert.equal(hasSidebar(photoSidebar(empty)), false);
  empty[2].in_backup = 1;
  assert.equal(hasSidebar(photoSidebar(empty)), true);
});

test('the save button says what it saves', () => {
  assert.equal(saveLabel(null), 'Save all');
  assert.equal(saveLabel(ALL_PHOTOS), 'Save all');
  assert.equal(saveLabel(FAVORITES), 'Save favorites');
  assert.equal(saveLabel(HIDDEN), 'Save hidden');
  assert.equal(saveLabel('12'), 'Save album');
});

test('the saved message names the album', () => {
  assert.equal(savedTitle(null, LIBRARY), 'Saved photos and videos');
  assert.equal(savedTitle('12', LIBRARY), 'Saved Flagged');
  assert.equal(savedTitle(HIDDEN, LIBRARY), 'Saved Hidden');
  assert.equal(savedTitle('404', LIBRARY), 'Saved photos and videos');
});
