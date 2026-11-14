// Tests for scripts/update-feed.mjs: Windows updates get their own copy of the installer, and
// latest.yml names it, so GitHub's download counts tell new installs from updates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { giveUpdatesTheirOwnCopy, pointFeedAt } from './update-feed.mjs';

// v0.14.0's latest.yml, as electron-builder wrote it.
const FEED = `version: 0.14.0
files:
  - url: OpenExtract-Setup-0.14.0.exe
    sha512: 33qSic++jT9sVJkrLs+xMWyp4nD1GT7Mn9mBMZ1HHj3wDQ7YXAET5juXcARhCriWW7SId5oT6V81tJuOOkloog==
    size: 132337352
path: OpenExtract-Setup-0.14.0.exe
sha512: 33qSic++jT9sVJkrLs+xMWyp4nD1GT7Mn9mBMZ1HHj3wDQ7YXAET5juXcARhCriWW7SId5oT6V81tJuOOkloog==
releaseDate: '2026-11-11T23:59:09.185Z'
`;

test('latest.yml names the update copy, and nothing else changes', () => {
  const out = pointFeedAt(FEED, 'OpenExtract-Setup-0.14.0.exe', 'OpenExtract-Update-0.14.0.exe');
  assert.equal(out, FEED.replaceAll('OpenExtract-Setup-0.14.0.exe', 'OpenExtract-Update-0.14.0.exe'));
  assert.match(out, /^ {2}- url: OpenExtract-Update-0\.14\.0\.exe$/m);
  assert.match(out, /^path: OpenExtract-Update-0\.14\.0\.exe$/m);
});

test('Windows line endings are kept', () => {
  const out = pointFeedAt(FEED.replaceAll('\n', '\r\n'), 'OpenExtract-Setup-0.14.0.exe', 'OpenExtract-Update-0.14.0.exe');
  assert.equal(out, FEED.replaceAll('OpenExtract-Setup-0.14.0.exe', 'OpenExtract-Update-0.14.0.exe').replaceAll('\n', '\r\n'));
});

test('a feed that names some other file, or none, is refused rather than half-changed', () => {
  assert.throws(() => pointFeedAt(FEED, 'OpenExtract-Setup-0.15.0.exe', 'OpenExtract-Update-0.15.0.exe'), /url is OpenExtract-Setup-0\.14\.0\.exe/);
  // Run twice: the feed already names the copy.
  const once = pointFeedAt(FEED, 'OpenExtract-Setup-0.14.0.exe', 'OpenExtract-Update-0.14.0.exe');
  assert.throws(() => pointFeedAt(once, 'OpenExtract-Setup-0.14.0.exe', 'OpenExtract-Update-0.14.0.exe'));
  assert.throws(() => pointFeedAt('version: 0.14.0\n', 'OpenExtract-Setup-0.14.0.exe', 'x'), /one url and one path/);
});

test('the copy and its blockmap are the built files, byte for byte', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-feed-'));
  try {
    fs.writeFileSync(path.join(dir, 'OpenExtract Setup 0.14.0.exe'), 'installer bytes');
    fs.writeFileSync(path.join(dir, 'OpenExtract Setup 0.14.0.exe.blockmap'), 'blockmap bytes');
    fs.writeFileSync(path.join(dir, 'latest.yml'), FEED);
    const written = giveUpdatesTheirOwnCopy(dir, '0.14.0');
    assert.deepEqual(written.map((f) => path.basename(f)), ['OpenExtract-Update-0.14.0.exe', 'OpenExtract-Update-0.14.0.exe.blockmap', 'latest.yml']);
    assert.equal(fs.readFileSync(path.join(dir, 'OpenExtract-Update-0.14.0.exe'), 'utf8'), 'installer bytes');
    assert.equal(fs.readFileSync(path.join(dir, 'OpenExtract-Update-0.14.0.exe.blockmap'), 'utf8'), 'blockmap bytes');
    assert.match(fs.readFileSync(path.join(dir, 'latest.yml'), 'utf8'), /^path: OpenExtract-Update-0\.14\.0\.exe$/m);
    // The installer people download stays where it was.
    assert.ok(fs.existsSync(path.join(dir, 'OpenExtract Setup 0.14.0.exe')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
