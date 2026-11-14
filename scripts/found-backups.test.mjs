// Tests for which found backups the home screen offers next to the recent list.
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
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-found-test-'));

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

const { notYetOpened, whenLine, UNFINISHED_MESSAGE } = load('src/lib/foundBackups.ts');

const backup = (udid, dir) => ({ udid, backup_dir: dir, device_name: udid });
const session = (id, backupDir) => ({ id, backupDir, type: 'device', name: id, subtitle: '', exportCount: 0, lastOpened: '' });
const udids = list => list.map(b => b.udid);

test('a backup already in the recent list is not offered again', () => {
  const found = [backup('A', '/Users/me/MobileSync/Backup/A'), backup('B', '/Users/me/MobileSync/Backup/B')];
  assert.deepEqual(udids(notYetOpened(found, [session('A', '/Users/me/MobileSync/Backup/A')])), ['B']);
});

test('the same phone backed up to another folder is still offered', () => {
  const found = [backup('A', '/Users/me/MobileSync/Backup/A')];
  assert.deepEqual(udids(notYetOpened(found, [session('A', '/Volumes/Drive/old/A')])), ['A']);
});

test('a recent without a folder matches by device', () => {
  const found = [backup('A', '/Users/me/MobileSync/Backup/A'), backup('B', '/Users/me/MobileSync/Backup/B')];
  assert.deepEqual(udids(notYetOpened(found, [session('B', undefined)])), ['A']);
});

test('Windows paths match without case or a trailing backslash', () => {
  const found = [backup('A', 'C:\\Users\\Me\\Apple\\MobileSync\\Backup\\A')];
  assert.deepEqual(notYetOpened(found, [session('A', 'c:\\users\\me\\apple\\mobilesync\\backup\\a\\')]), []);
});

test('nothing found offers nothing', () => {
  assert.deepEqual(notYetOpened([], [session('A', '/x')]), []);
});

test('when looking for backups fails, the home screen says so in plain words', () => {
  const { lookFailedMessage } = load('src/lib/foundBackups.ts');
  assert.equal(lookFailedMessage('Sidecar call timed out: list_backups'),
    "OpenExtract couldn't look for other backups on this computer.");
  // A stopped engine stays stopped until the app is reopened, so say that (OE-27).
  for (const error of ['Python sidecar is not running', 'Sidecar exited with code 1']) {
    assert.match(lookFailedMessage(error), /engine stopped\. Quit and reopen OpenExtract to look again\.$/);
  }
});

// A backup that stopped partway (OE-31). Its date is when the try started.
const day = iso => iso.slice(0, 10);

test('a finished backup says when it was made', () => {
  assert.equal(whenLine({ last_backup: '2026-11-03T10:00:00+00:00' }, day), 'Backed up 2026-11-03');
});

test('a backup that stopped partway says when it was started', () => {
  assert.equal(whenLine({ last_backup: '2026-11-03T10:00:00+00:00', unfinished: true }, day), 'Started 2026-11-03');
});

test('no date says nothing', () => {
  assert.equal(whenLine({ last_backup: '', unfinished: true }, day), undefined);
});

test('the message matches the engine', () => {
  // Windows checkouts can have CRLF line endings.
  const engine = fs.readFileSync(path.join(root, 'python', 'backup_status.py'), 'utf-8').replace(/\r\n/g, '\n');
  const said = engine.match(/^UNFINISHED = \(\n((?:\s+"[^"]*"\n)+)\)/m)[1];
  assert.equal(said.split('\n').map(l => l.trim().replace(/^"|"$/g, '')).join(''), UNFINISHED_MESSAGE);
});

// A recent backup whose folder was moved, renamed or deleted, or is on a drive that isn't
// plugged in (OE-40). The engine says so behind a prefix, and the home screen offers Find it.
test("a backup that isn't where it was gets its words without the prefix or the title's sentence", () => {
  const { backupMissingMessage } = load('src/lib/foundBackups.ts');
  assert.equal(
    backupMissingMessage("BACKUP_MISSING: OpenExtract can't find this backup. It was in E:\\Backups\\A, and that folder isn't there now."),
    "It was in E:\\Backups\\A, and that folder isn't there now.");
  // Worded differently some day: shown whole rather than lost.
  assert.equal(backupMissingMessage('BACKUP_MISSING: Something new.'), 'Something new.');
});

test("each of the engine's missing-backup messages says more than the title", () => {
  const { backupMissingMessage } = load('src/lib/foundBackups.ts');
  const engine = fs.readFileSync(path.join(root, 'python', 'backup.py'), 'utf-8');
  assert.match(engine, /return ValueError\(f"\{BACKUP_MISSING\} OpenExtract can't find this backup\. \{where\}"\)/);
  assert.equal(backupMissingMessage("BACKUP_MISSING: OpenExtract can't find this backup. It isn't in the usual backup folders on this computer."),
    "It isn't in the usual backup folders on this computer.");
});

test('any other open error is left to the usual message', () => {
  const { backupMissingMessage } = load('src/lib/foundBackups.ts');
  for (const error of ['Failed to decrypt backup: wrong password', 'FULL_DISK_ACCESS_REQUIRED: macOS is blocking', '', null, undefined]) {
    assert.equal(backupMissingMessage(error), null);
  }
});

test("the missing-backup prefix matches the engine's", () => {
  const { BACKUP_MISSING_PREFIX } = load('src/lib/foundBackups.ts');
  const engine = fs.readFileSync(path.join(root, 'python', 'backup.py'), 'utf-8');
  assert.equal(engine.match(/^BACKUP_MISSING = "([^"]+)"/m)[1], BACKUP_MISSING_PREFIX);
});
