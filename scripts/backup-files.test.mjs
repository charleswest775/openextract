// The banner over a backup whose folder is missing files it lists (src/lib/backupFiles.ts, OE-102).
// It takes check_backup_files' answer (python/backup_files.py):
// { listed, missing, missing_by_area: { photos, messages, other } }.
// Run with: node --test scripts/backup-files.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';
import { enUS } from './test-helpers/time-zones.mjs';

const { missingFilesMessage } = loadTs('src/lib/backupFiles.ts');

const n = x => x.toLocaleString();
const ADVICE = 'If you copied or moved this backup, copy the whole folder again, or make a new backup.';
const check = (missing, photos = 0, messages = 0, other = 0) =>
  ({ listed: 50_000, missing, missing_by_area: { photos, messages, other } });

test('nothing to say when nothing is missing, or before the check has answered', () => {
  assert.equal(missingFilesMessage(check(0)), null);
  assert.equal(missingFilesMessage(null), null);
  assert.equal(missingFilesMessage(undefined), null);
  assert.equal(missingFilesMessage({ listed: 0, missing: 0 }), null);
});

test('OE-102: photos and videos missing from a finished backup', () => {
  assert.equal(missingFilesMessage(check(1200, 1200)),
    `${n(1200)} of this backup's files are missing from its folder, so some photos and videos won't open. ${ADVICE}`);
});

test('it names what won\'t open, by where the missing files are', () => {
  assert.match(missingFilesMessage(check(5, 0, 5)), /, so some message attachments won't open\./);
  assert.match(missingFilesMessage(check(5, 0, 0, 5)), /, so some things in it won't open\./);
  assert.match(missingFilesMessage(check(5, 3, 0, 2)), /, so some photos and videos or other things won't open\./);
  assert.match(missingFilesMessage(check(9, 3, 3, 3)), /, so some photos and videos, message attachments or other things won't open\./);
  // An engine that doesn't say where they are
  assert.match(missingFilesMessage({ listed: 10, missing: 3 }), /, so some things in it won't open\./);
});

test('one missing file reads in the singular', () => {
  assert.equal(missingFilesMessage(check(1, 1)),
    `1 of this backup's files is missing from its folder, so a photo or video won't open. ${ADVICE}`);
  assert.match(missingFilesMessage(check(1, 0, 1)), /so a message attachment won't open/);
  assert.match(missingFilesMessage(check(1, 0, 0, 1)), /so something in it won't open/);
  assert.match(missingFilesMessage({ listed: 10, missing: 1 }), /so something in it won't open/);
});

test('English digit grouping', { skip: !enUS && 'needs an en-US locale' }, () => {
  assert.match(missingFilesMessage(check(1234, 1200, 0, 34)), /^1,234 of this backup's files are missing/);
});
