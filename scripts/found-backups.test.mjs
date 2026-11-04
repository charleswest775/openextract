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

const { notYetOpened } = load('src/lib/foundBackups.ts');

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
