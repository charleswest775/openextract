// Tests for the wording about photos only in iCloud (src/lib/photoCounts.ts, #106).
// photoExportSummary takes export_photos' result: { exported, errors, not_in_backup, output_dir }.
// Run with: node --test scripts/photo-counts.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';
import { enUS } from './test-helpers/time-zones.mjs';

const { moreOnlyInIcloud, allOnlyInIcloud, photoExportSummary } = loadTs('src/lib/photoCounts.ts');

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
