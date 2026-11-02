// Tests for the in-app feedback report: what gets scrubbed, what the log
// excerpt keeps, and that the GitHub link stays within its limit.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-feedback-test-'));

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

const main = load('electron/feedback.ts');
const lib = load('src/lib/feedback.ts');

const secrets = new Map([
  ['/Users/jane', '~'],
  ['jane', '<user>'],
  ['/Users/jane/Library/Application Support/MobileSync/Backup/00008030-001A2B3C4D5E6F70', '<backup folder>'],
  ["Jane's iPhone", '<device name>'],
]);

test('scrubText replaces the backup folder before the home folder', () => {
  const out = main.scrubText(
    "No such file: '/Users/jane/Library/Application Support/MobileSync/Backup/00008030-001A2B3C4D5E6F70/Manifest.db'",
    secrets,
  );
  assert.equal(out, "No such file: '<backup folder>/Manifest.db'");
});

test('scrubText handles Windows paths, including escaped backslashes', () => {
  const win = new Map([['C:\\Users\\Jane', '~']]);
  assert.equal(main.scrubText('open C:\\Users\\Jane\\Desktop\\x', win), 'open ~\\Desktop\\x');
  assert.equal(main.scrubText("'C:\\\\Users\\\\Jane\\\\Desktop'", win), "'~\\\\Desktop'");
  assert.equal(main.scrubText('C:/Users/Jane/Desktop', win), '~/Desktop');
});

test('scrubText removes other home folders, emails, UDIDs, device names and phone numbers', () => {
  const out = main.scrubText(
    "Jane's iPhone: /home/bob/backups failed for bob@example.com, udid 3d0d7e5fb2ce288813306e4d4636395e047a3d28, call +1 (415) 555-0123",
    secrets,
  );
  assert.equal(out, '<device name>: ~/backups failed for <email>, udid <udid>, call <phone>');
});

test('scrubText only replaces a username as a whole word', () => {
  const s = new Map([['ann', '<user>']]);
  assert.equal(main.scrubText('ann ran annotate', s), '<user> ran annotate');
});

test('scrubText leaves dates, times, versions and sizes alone', () => {
  const text = '[12:34:56] 2026-11-02 10:15:00 iOS 17.4.1 size=123456789012 took 0.532s code -32000';
  assert.equal(main.scrubText(text, new Map()), text);
});

test('extractLogExcerpt keeps errors and crashes, drops timings, prints and normal exits', () => {
  const log = [
    '[TIMING 10:00:00] list_calls total=0.1s',
    '[STDERR] Hello from a stray print: secret message text',
    '[RPC ERROR] list_voicemails: Traceback (most recent call last):',
    '  File "voicemail.py", line 10, in list',
    "KeyError: 'ZDATE'",
    '[EXIT] code null',
    '[EXIT] code 0',
    '[EXIT] code 3221225477',
  ].join('\n');
  const out = main.extractLogExcerpt(log);
  assert.match(out, /RPC ERROR\] list_voicemails/);
  assert.match(out, /KeyError: 'ZDATE'/);
  assert.match(out, /\[EXIT\] code 3221225477/);
  assert.doesNotMatch(out, /TIMING|STDERR|secret message|code null|code 0\b/);
});

test('extractLogExcerpt trims long tracebacks but keeps the final error line', () => {
  const tb = ['[RPC ERROR] open_backup: Traceback (most recent call last):'];
  for (let i = 0; i < 40; i++) tb.push(`  File "x.py", line ${i}`);
  tb.push('ValueError: bad manifest');
  const out = main.extractLogExcerpt(tb.join('\n'));
  assert.ok(out.split('\n').length <= 18);
  assert.match(out, /ValueError: bad manifest$/);
});

test('extractLogExcerpt keeps the stderr traceback of a crash at startup', () => {
  const log = [
    '[STDERR] some stray print with message text',
    '[STDERR] Traceback (most recent call last):',
    '[STDERR] File "main.py", line 36, in <module>',
    '    from backup import BackupManager',
    "ModuleNotFoundError: No module named 'ios_backup_core'",
    '[EXIT] code 1',
  ].join('\n');
  const out = main.extractLogExcerpt(log);
  assert.match(out, /^\[STDERR\] Traceback/);
  assert.match(out, /ModuleNotFoundError/);
  assert.match(out, /\[EXIT\] code 1$/);
  assert.doesNotMatch(out, /stray print/);
});

test('FeedbackRecorder keeps backup facts but not names, and scrubs recorded errors', () => {
  const rec = new main.FeedbackRecorder(path.join(tmp, 'missing-log.txt'), '0.9.0');
  rec.recordCall('open_backup', { udid: 'abcd1234efgh', backup_dir: '/Volumes/Ext/MyBackups/abcd1234efgh' }, {
    ok: true,
    result: { status: 'open', info: { udid: 'abcd1234efgh', device_name: 'Kim Phone', product_type: 'iPhone14,2', product_version: '17.4', encrypted: true, size_gb: 54.23, backup_dir: '/Volumes/Ext/MyBackups/abcd1234efgh' } },
  });
  rec.recordCall('list_calls', {}, { ok: true, result: { calls: [] } });
  rec.recordCall('list_voicemails', {}, { ok: false, error: 'Kim Phone: cannot read /Volumes/Ext/MyBackups/abcd1234efgh/Manifest.db' });
  rec.recordCall('list_voicemails', {}, { ok: false, error: 'Kim Phone: cannot read /Volumes/Ext/MyBackups/abcd1234efgh/Manifest.db' });
  // An empty_reason is a legitimate empty state, not a failure.
  rec.recordCall('list_notes', {}, { ok: true, result: { error: 'needs encryption', empty_reason: 'requires_encryption' } });

  const d = rec.diagnostics('Error for Kim Phone');
  assert.deepEqual(d.backup, { model: 'iPhone14,2', iosVersion: '17.4', encrypted: true, sizeGB: 54.2 });
  assert.deepEqual(d.loaded, ['list_calls', 'list_notes', 'open_backup']);
  assert.deepEqual(d.failed, ['list_voicemails']);
  assert.equal(d.recentErrors.length, 1);
  assert.equal(d.recentErrors[0].count, 2);
  assert.equal(d.recentErrors[0].message, '<device name>: cannot read <backup folder>/Manifest.db');
  assert.equal(d.reportedError, 'Error for <device name>');
  assert.doesNotMatch(JSON.stringify(d), /Kim Phone|MyBackups|abcd1234efgh/);
});

const diag = {
  appVersion: '0.9.0', os: 'macOS 14.3.0 (arm64)',
  backup: { model: 'iPhone14,2', iosVersion: '17.4', encrypted: false, sizeGB: 12.5 },
  loaded: ['list_calls'], failed: ['list_voicemails'],
  recentErrors: [{ at: '2026-11-02T10:15:00.000Z', method: 'list_voicemails', message: 'boom', count: 3 }],
  logExcerpt: "[RPC ERROR] list_voicemails: Traceback\nKeyError: '```'",
  reportedError: 'boom',
};

test('formatDiagnostics lists the facts and keeps code fences balanced', () => {
  const text = lib.formatDiagnostics(diag);
  assert.match(text, /OpenExtract 0\.9\.0 on macOS/);
  assert.match(text, /iPhone14,2 · iOS 17\.4 · not encrypted · 12\.5 GB/);
  assert.match(text, /list_voicemails \(×3\): boom/);
  assert.equal((text.match(/```/g) || []).length % 2, 0);
});

test('githubIssueUrl uses the in-app template and prefills its fields', () => {
  const form = { kind: 'missing', area: 'calls', details: 'Export came out empty', diagnostics: lib.formatDiagnostics(diag) };
  const { url, shortened } = lib.githubIssueUrl(form);
  const u = new URL(url);
  assert.equal(u.origin + u.pathname, 'https://github.com/charleswest775/openextract/issues/new');
  assert.equal(u.searchParams.get('template'), 'in_app_feedback.yml');
  assert.equal(u.searchParams.get('title'), '[Feedback] Calls: Export came out empty');
  assert.equal(u.searchParams.get('kind'), 'Something in my backup is missing or wrong');
  assert.equal(u.searchParams.get('area'), 'Calls');
  assert.equal(u.searchParams.get('details'), 'Export came out empty');
  assert.equal(shortened, false);
});

test('long reports are shortened to fit and say so', () => {
  const huge = 'line of log output with some detail\n'.repeat(2000);
  const form = { kind: 'broken', area: 'general', details: 'It crashed', diagnostics: 'App: x\n```\n' + huge + '```' };
  const gh = lib.githubIssueUrl(form);
  assert.ok(gh.url.length <= lib.GITHUB_URL_BUDGET, `github url ${gh.url.length}`);
  assert.equal(gh.shortened, true);
  const diagnostics = new URL(gh.url).searchParams.get('diagnostics');
  assert.match(diagnostics, /full report is on your clipboard/);
  assert.equal((diagnostics.match(/```/g) || []).length % 2, 0);

  assert.match(lib.fullReport(form), /What happened:\nIt crashed\n/);
});

test('a very long description still fits in the GitHub link', () => {
  const form = { kind: 'idea', area: 'export', details: 'please '.repeat(3000), diagnostics: 'App: x' };
  const gh = lib.githubIssueUrl(form);
  assert.ok(gh.url.length <= lib.GITHUB_URL_BUDGET);
  assert.equal(gh.shortened, true);
});

test('every area and kind in the app has a label the workflow maps', () => {
  const wf = fs.readFileSync(path.join(root, '.github/workflows/feedback-labels.yml'), 'utf-8');
  for (const a of lib.FEEDBACK_AREAS) assert.ok(wf.includes(`'${a.label}'`), `workflow is missing area "${a.label}"`);
  for (const k of lib.FEEDBACK_KINDS) assert.ok(wf.includes(JSON.stringify(k.label)), `workflow is missing kind "${k.label}"`);
});
