// Tests for the wording about photos only in iCloud (src/lib/photoCounts.ts, #106).
// photoExportSummary takes export_photos' result: { exported, errors, not_in_backup, output_dir }.
// Run with: node --test scripts/photo-counts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';
import { enUS } from './test-helpers/time-zones.mjs';

const { moreOnlyInIcloud, allOnlyInIcloud, photoExportSummary, moreMissingFromFolder, noPhotosHere } = loadTs('src/lib/photoCounts.ts');

const n = x => x.toLocaleString();

test('one photo reads in the singular', () => {
  assert.equal(moreOnlyInIcloud(1), "1 more is only in iCloud, so this backup doesn't have it.");
  assert.equal(allOnlyInIcloud(1), "The 1 photo here is only in iCloud, so this backup doesn't have it.");
});

test('more than one reads in the plural, with the count grouped for the locale', () => {
  assert.equal(moreOnlyInIcloud(2), "2 more are only in iCloud, so this backup doesn't have them.");
  assert.equal(moreOnlyInIcloud(5700), `${n(5700)} more are only in iCloud, so this backup doesn't have them.`);
  assert.equal(allOnlyInIcloud(48213), `All ${n(48213)} photos here are only in iCloud, so this backup doesn't have them.`);
});

test('English digit grouping', { skip: !enUS && 'needs an en-US locale' }, () => {
  assert.equal(moreOnlyInIcloud(5700), "5,700 more are only in iCloud, so this backup doesn't have them.");
  assert.equal(allOnlyInIcloud(1_234_567), "All 1,234,567 photos here are only in iCloud, so this backup doesn't have them.");
  assert.equal(photoExportSummary({ exported: 300, errors: 3, not_in_backup: 5700 }),
    "300 exported · 5,700 only in iCloud, not in this backup · 3 couldn't be copied");
});

test('the export summary leaves out what is zero', () => {
  assert.equal(photoExportSummary({ exported: 12, errors: 0, not_in_backup: 0, output_dir: '/tmp/x' }), '12 exported');
  assert.equal(photoExportSummary({ exported: 12, errors: 0 }), '12 exported');
  assert.equal(photoExportSummary({ exported: 0, errors: 0, not_in_backup: 0 }), '0 exported');
  assert.equal(photoExportSummary({ exported: 0, errors: 2, not_in_backup: 0 }), "0 exported · 2 couldn't be copied");
  assert.equal(photoExportSummary({ exported: 10, errors: 0, not_in_backup: 4 }), '10 exported · 4 only in iCloud, not in this backup');
});

test('the export summary with every part, in that order', () => {
  const s = photoExportSummary({ exported: 31_000, errors: 1_250, not_in_backup: 250_000 });
  assert.equal(s, `${n(31_000)} exported · ${n(250_000)} only in iCloud, not in this backup · ${n(1_250)} couldn't be copied`);
});

// Photos the backup lists but whose files aren't in its folder (OE-102): left out of the grid,
// and not called iCloud-only, because they aren't.
test('photos missing from the folder: under the title, one and many', () => {
  assert.equal(moreMissingFromFolder(1), "1 more is missing from the backup's folder, though the backup lists it.");
  assert.equal(moreMissingFromFolder(1200), `${n(1200)} more are missing from the backup's folder, though the backup lists them.`);
});

test('in place of the grid: missing from the folder, only in iCloud, or both', () => {
  assert.equal(noPhotosHere(0, 0), undefined);
  assert.equal(noPhotosHere(0, 6000), allOnlyInIcloud(6000));
  assert.equal(noPhotosHere(1, 0), "The 1 photo here is missing from the backup's folder, though the backup lists it.");
  assert.equal(noPhotosHere(1200, 0), `All ${n(1200)} photos here are missing from the backup's folder, though the backup lists them.`);
  assert.equal(noPhotosHere(1200, 4),
    `None of the photos here are in the backup's folder: ${n(1200)} are missing from it, though the backup lists them, and 4 are only in iCloud.`);
  assert.equal(noPhotosHere(1, 1),
    "None of the photos here are in the backup's folder: 1 is missing from it, though the backup lists it, and 1 is only in iCloud.");
});

// Saving into a folder used before copies only what isn't there yet (#315); the notice says so (OE-193).
test('the export summary says how many were already in the folder', () => {
  assert.equal(photoExportSummary({ exported: 12, already_there: 12, errors: 0 }), '0 exported · 12 were already in that folder');
  assert.equal(photoExportSummary({ exported: 13, already_there: 1, errors: 0 }), '12 exported · 1 was already in that folder');
  assert.equal(photoExportSummary({ exported: 12, already_there: 0, errors: 0 }), '12 exported');
  assert.equal(photoExportSummary({ exported: 40, already_there: 1200, errors: 2, not_in_backup: 5 }).split(' · ').length, 4);
});

test('English digit grouping in what was already there', { skip: !enUS && 'needs an en-US locale' }, () => {
  assert.equal(photoExportSummary({ exported: 1240, already_there: 1200, errors: 2, not_in_backup: 5700 }),
    "40 exported · 1,200 were already in that folder · 5,700 only in iCloud, not in this backup · 2 couldn't be copied");
});

test('the export summary says how many were missing from the folder', () => {
  assert.equal(photoExportSummary({ exported: 0, errors: 0, not_in_backup: 0, missing_from_folder: 1200 }),
    `0 exported · ${n(1200)} missing from the backup's folder`);
  assert.equal(photoExportSummary({ exported: 300, errors: 3, not_in_backup: 5700, missing_from_folder: 12 }),
    `300 exported · ${n(5700)} only in iCloud, not in this backup · 12 missing from the backup's folder · 3 couldn't be copied`);
});
