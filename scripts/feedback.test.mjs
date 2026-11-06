// Tests for the in-app feedback report: what gets scrubbed, what the log
// excerpt keeps, and that the GitHub link stays within its limit.
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

// #169: the bootloader's summary line arrived in the same stderr chunk as the end of
// the traceback, and the report kept only "[EXIT] code 1".
test('extractLogExcerpt keeps the traceback when the bootloader error shares its chunk', () => {
  const log = [
    '[STDERR] Traceback (most recent call last):',
    '[STDERR] File "main.py", line 36, in <module>',
    '  File "Crypto\\Util\\_raw_api.py", line 319, in load_pycryptodome_raw_lib',
    "OSError: Cannot load native module 'Crypto.Util._cpuid_c': Cannot load '_cpuid_c.pyd': [WinError 4551] An Application Control policy has blocked this file",
    "[PYI-6512:ERROR] Failed to execute script 'main' due to unhandled exception!",
    '[EXIT] code 1',
  ].join('\r\n');
  const out = main.extractLogExcerpt(log);
  assert.match(out, /^\[STDERR\] Traceback/);
  assert.match(out, /WinError 4551/);
  assert.match(out, /\[PYI-6512:ERROR\] Failed to execute script/);
  assert.match(out, /\[EXIT\] code 1$/);
});

test('extractLogExcerpt keeps the bootloader error of a crash before Python started', () => {
  const log = [
    '[STDERR] [PYI-6512:ERROR] Failed to load Python DLL \'C:\\Users\\x\\AppData\\Local\\Temp\\_MEI2\\python311.dll\'.',
    'LoadLibrary: An Application Control policy has blocked this file.',
    '[EXIT] code 4294967295',
  ].join('\n');
  const out = main.extractLogExcerpt(log);
  assert.match(out, /Failed to load Python DLL/);
  assert.match(out, /LoadLibrary: An Application Control policy/);
  assert.match(out, /\[EXIT\] code 4294967295$/);
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

// ── Sending reports: the site's API (website/static/api) and the app's side (electron/feedbackReports.ts) ──

const site = require(path.join(root, 'website/static/api/_lib/feedback.js'));
const reports = load('electron/feedbackReports.ts');

const TOKEN = 'a'.repeat(48);
const goodReport = (over = {}) => ({
  kind: 'broken',
  area: 'open_backup',
  details: 'It says the engine is not running',
  diagnostics: 'App: OpenExtract 0.9.0 on Windows 10.0.26300 (x64)\nFailed: list_backups\n- 18:16:09 list_backups: Python sidecar is not running',
  token: TOKEN,
  ...over,
});

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

/** Just enough of GitHub's issues API: create and get. */
function fakeGitHub() {
  const issues = new Map();
  const calls = [];
  let next = 1;
  return {
    issues,
    calls,
    fetch: async (url, init = {}) => {
      calls.push({ url, init });
      const m = url.match(/\/repos\/[^/]+\/[^/]+\/issues(?:\/(\d+))?$/);
      if (!m) return reply(404, {});
      if (!m[1] && init.method === 'POST') {
        const b = JSON.parse(init.body);
        const issue = { ...b, number: next++, state: 'open', labels: (b.labels || []).map(name => ({ name })) };
        issues.set(issue.number, issue);
        return reply(201, issue);
      }
      const issue = issues.get(Number(m[1]));
      return issue ? reply(200, issue) : reply(404, {});
    },
  };
}

const env = { GITHUB_FEEDBACK_TOKEN: 'ghp_test' };
let ipCounter = 0;
const jsonReq = (body, ip = `198.51.100.${++ipCounter}`) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
  body,
});

function memoryStore() {
  const data = {};
  return {
    data,
    get: (k, fallback) => (k in data ? data[k] : fallback),
    set: (k, v) => { data[k] = JSON.parse(JSON.stringify(v)); },
  };
}

/** The app's fetch, answered by the site's functions instead of the network. */
function siteFetch(gh, ip = '192.0.2.1') {
  return async (url, init) => {
    const fn = new URL(url).pathname === '/api/feedback' ? site.receiveReport : site.lookUpReport;
    const out = await fn(jsonReq(JSON.parse(init.body), ip), env, gh.fetch);
    return reply(out.status, out.body);
  };
}

test('the site knows the same kinds and areas as the app, with the workflow\'s labels', () => {
  const wf = fs.readFileSync(path.join(root, '.github/workflows/feedback-labels.yml'), 'utf-8');
  const workflowLabels = (key) => {
    const m = wf.match(new RegExp(`${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: \\[([^\\]]*)\\]`));
    assert.ok(m, `workflow has no labels for ${key}`);
    return [...m[1].matchAll(/'([^']+)'/g)].map(x => x[1]);
  };
  assert.deepEqual(Object.keys(site.KINDS), lib.FEEDBACK_KINDS.map(k => k.id));
  assert.deepEqual(Object.keys(site.AREAS), lib.FEEDBACK_AREAS.map(a => a.id));
  for (const k of lib.FEEDBACK_KINDS) {
    assert.equal(site.KINDS[k.id].label, k.label);
    assert.deepEqual(site.KINDS[k.id].labels, workflowLabels(JSON.stringify(k.label)));
  }
  for (const a of lib.FEEDBACK_AREAS) {
    assert.equal(site.AREAS[a.id].label, a.label);
    assert.deepEqual(site.AREAS[a.id].labels, workflowLabels(`'${a.label}'`));
  }
});

test('the site rejects reports it can\'t file, with messages a user can act on', () => {
  assert.match(site.validateReport(goodReport({ kind: 'nope' })).error, /type/);
  assert.match(site.validateReport(goodReport({ details: '   ' })).error, /describe/);
  assert.match(site.validateReport(goodReport({ details: 'x'.repeat(8001) })).error, /too long/);
  assert.match(site.validateReport(goodReport({ email: 'not an email' })).error, /email/);
  assert.match(site.validateReport(goodReport({ token: 'short' })).error, /update/i);
  const ok = site.validateReport(goodReport({ email: '  pat@example.com ', details: '  spaced  ' }));
  assert.equal(ok.report.email, 'pat@example.com');
  assert.equal(ok.report.details, 'spaced');
});

test('a filed report has the issue form\'s headings, its labels, and the code\'s hash last', () => {
  const report = site.validateReport(goodReport({ email: 'pat@example.com', diagnostics: 'Backup: iPhone17,1 · iOS 27.0' })).report;
  assert.equal(site.issueTitle(report), lib.issueTitle({ ...report, diagnostics: '' }));
  const body = site.issueBody(report);
  for (const h of ['### Type', '### Part of the app', '### What happened?', '### Diagnostics', '### Reply to']) {
    assert.ok(body.includes(h), h);
  }
  assert.ok(body.includes('`pat@example.com`'));
  assert.ok(!body.includes(TOKEN), 'the code itself is never stored');
  assert.ok(site.tokenMatches(body, TOKEN));
  assert.ok(!site.tokenMatches(body, 'b'.repeat(48)));
  assert.deepEqual(site.issueLabels(report).sort(), ['feedback', 'bug', 'python-engine', 'ios-compat', 'has-email'].sort());
});

test('a lookalike code line in the user\'s text doesn\'t unlock the report', () => {
  const fake = site.issueBody(site.validateReport(goodReport({ token: 'b'.repeat(48) })).report).split('\n').pop();
  const report = site.validateReport(goodReport({ details: `hello\n${fake}` })).report;
  const body = site.issueBody(report);
  assert.ok(!site.tokenMatches(body, 'b'.repeat(48)));
  assert.ok(site.tokenMatches(body, TOKEN));
});

test('known fixes match on the error text and, where given, the system', () => {
  const engine = site.matchKnownFixes(site.validateReport(goodReport()).report);
  assert.deepEqual(engine.map(f => f.id), ['engine-did-not-start']);
  const fda = (os) => site.matchKnownFixes(site.validateReport(goodReport({
    diagnostics: `App: OpenExtract 0.9.0 on ${os}\n- open_backup: PermissionError: Operation not permitted`,
  })).report).map(f => f.id);
  assert.deepEqual(fda('macOS 15.1 (arm64)'), ['mac-full-disk-access']);
  assert.deepEqual(fda('Windows 10.0.26300 (x64)'), []);
  assert.deepEqual(site.matchKnownFixes(site.validateReport(goodReport({ details: 'Photos look fine', diagnostics: '' })).report), []);
});

// Known fixes against what the app really says. Each error below is copied from the
// code that produces it, so a fix whose pattern drifts from the real wording fails
// here instead of quietly never showing.

const { KNOWN_FIXES } = require(path.join(root, 'website/static/api/_lib/known-fixes.js'));
const MAC = 'macOS 15.1 (arm64)';
const WINDOWS = 'Windows 10.0.26300 (x64)';
let fixReports = 0;

/** Known fixes the site answers with, for a report built the way the app builds one. */
async function knownFixesFor({ kind = 'broken', area = 'open_backup', details = "Something isn't working", os = MAC, errors = [], log = '', reportedError } = {}) {
  const logPath = path.join(tmp, `engine-log-${++fixReports}.txt`);
  fs.writeFileSync(logPath, log);
  const rec = new main.FeedbackRecorder(logPath, '0.9.1');
  for (const [method, error] of errors) rec.recordCall(method, {}, { ok: false, error });
  const diagnostics = lib.formatDiagnostics({ ...rec.diagnostics(reportedError), os });
  const report = goodReport({ kind, area, details, diagnostics, token: fixReports.toString(16).padStart(48, '7') });
  const out = await site.receiveReport(jsonReq(report), env, fakeGitHub().fetch);
  assert.equal(out.status, 200, JSON.stringify(out.body));
  return out.body.knownFixes.map(f => f.id);
}

// iphone_backup_decrypt's IncorrectPassphraseError, wrapped by open_local_backup() in
// ios-backup-core (src/ios_backup_core/backup.py) and passed on by python/backup.py.
const WRONG_PASSWORD = 'Failed to decrypt backup: Failed to decrypt keys: incorrect passphrase?';

test('the password fix shows for the engine\'s real wrong-password error', async () => {
  // What the unlock dialog shows, which the report lists under recent errors.
  assert.deepEqual(await knownFixesFor({ errors: [['open_backup', WRONG_PASSWORD]] }), ['backup-password']);
  assert.deepEqual(await knownFixesFor({ os: WINDOWS, errors: [['open_backup', WRONG_PASSWORD]] }), ['backup-password']);
  // The same failure in the engine log (python/main.py writes "[RPC ERROR] <method>: <traceback>").
  const log = [
    '[RPC ERROR] open_backup: Traceback (most recent call last):',
    '  File "ios_backup_core/backup.py", line 432, in open_local_backup',
    '  File "iphone_backup_decrypt/iphone_backup.py", line 126, in _read_and_unlock_keybag',
    'iphone_backup_decrypt.exceptions.IncorrectPassphraseError: Failed to decrypt keys: incorrect passphrase?',
    '',
    'The above exception was the direct cause of the following exception:',
    '',
    'Traceback (most recent call last):',
    '  File "main.py", line 508, in handle_request',
    '  File "backup.py", line 419, in open_backup',
    `ValueError: ${WRONG_PASSWORD}`,
  ].join('\n');
  assert.deepEqual(await knownFixesFor({ log }), ['backup-password']);
});

test('the password fix shows when people describe the problem in their own words', async () => {
  for (const details of [
    'It keeps saying wrong passphrase',
    'I forgot the password I used for the backup',
    "I can't remember my backup password",
    "I've forgotten the encryption password",
    'It says my password is incorrect',
  ]) {
    assert.deepEqual(await knownFixesFor({ details }), ['backup-password'], details);
  }
});

test('the password fix doesn\'t show for other decryption, passcode or password problems', async () => {
  // A damaged backup: iphone_backup_decrypt's _open_temp_database(), wrapped by ios-backup-core.
  assert.deepEqual(await knownFixesFor({ errors: [['open_backup', 'Failed to decrypt backup: Manifest.db file does not contain any data!']] }), []);
  // The iPhone's own lock while making a backup (python/device_backup.py).
  assert.deepEqual(await knownFixesFor({
    errors: [['backup.start', 'PASSCODE_REQUIRED: Your iPhone is locked. Unlock it with your passcode, keep it unlocked while the backup starts, then click Retry.']],
  }), []);
  assert.deepEqual(await knownFixesFor({ details: 'Could the app remember my password?' }), []);
  // Other passwords people forget. The fix tells them to Reset All Settings, which erases
  // the saved Wi-Fi passwords some of them are hoping to get back.
  for (const [kind, area, details] of [
    ['idea', 'general', 'I forgot my Wi-Fi password. Can OpenExtract show saved Wi-Fi passwords from my backup?'],
    ['other', 'general', "I don't remember my Apple ID password, can I still use this?"],
    ['idea', 'general', "I can't remember my Instagram password, does the backup have my saved passwords"],
    ['missing', 'notes', "Forgot my notes password and the locked notes don't show"],
    ['missing', 'general', 'Forgot to mention: passwords from Keychain are missing too'],
    ['other', 'general', "I can't remember my Screen Time passcode or password"],
  ]) {
    assert.deepEqual(await knownFixesFor({ kind, area, details }), [], details);
  }
});

// python/device_backup.py _device_service_error(), now and up to 0.10.0.
const WINDOWS_NO_DEVICE_SERVICE = "DEVICE_SERVICE_REQUIRED: To find your iPhone, OpenExtract needs Apple Devices, Apple's free iPhone app for Windows, and it isn't installed. Install it from the Microsoft Store, then search again.";
const OLD_NO_DEVICE_SERVICE = 'Cannot connect to Apple Mobile Device Service. On Windows, install iTunes or the Apple Devices app from the Microsoft Store, then make sure it is running before searching for devices.';

// One real error per known fix; the last test checks that every fix has one.
const REAL_ERRORS = [
  // electron/sidecar.ts call(), once the engine has stopped (#169).
  { fix: 'engine-did-not-start', os: WINDOWS, errors: [['list_backups', 'Python sidecar is not running']] },
  // electron/sidecar.ts start(): the launch failed, written to the engine log.
  { fix: 'engine-did-not-start', log: '[ERROR STARTING] spawn /Applications/OpenExtract.app/Contents/Resources/engine/openextract-engine ENOENT' },
  // python/backup.py _permission_error() on macOS.
  {
    fix: 'mac-full-disk-access',
    errors: [['list_backups', 'FULL_DISK_ACCESS_REQUIRED: macOS is blocking OpenExtract from reading /Users/jane/Library/Application Support/MobileSync/Backup. Open System Settings → Privacy & Security → Full Disk Access, turn on OpenExtract, then quit and reopen OpenExtract.']],
  },
  // The same, for a folder whose long path pushes "Full Disk Access" past where the report cuts the line.
  {
    fix: 'mac-full-disk-access',
    errors: [['open_backup', `FULL_DISK_ACCESS_REQUIRED: macOS is blocking OpenExtract from reading /Volumes/Backups 2TB/${'Old Mac Migration/'.repeat(10)}MobileSync/Backup. Open System Settings → Privacy & Security → Full Disk Access, turn on OpenExtract, then quit and reopen OpenExtract.`]],
  },
  // Python's own error for a folder macOS blocks, in the engine log.
  {
    fix: 'mac-full-disk-access',
    log: "[RPC ERROR] get_backup_size: Traceback (most recent call last):\n  File \"backup.py\", line 505, in get_backup_size\nPermissionError: [Errno 1] Operation not permitted: '/Users/jane/Library/Application Support/MobileSync/Backup/00008030-001A2B3C4D5E6F70'",
  },
  // src/App.tsx, after browsing to a folder with no backup in it; sent with "Report this problem".
  {
    fix: 'no-backups-found',
    reportedError: 'No iPhone backups found in /Users/jane/Desktop/iPhone stuff. Pick the parent folder that contains a UDID-named subfolder (e.g. MobileSync/Backup).',
  },
  { fix: 'backup-password', errors: [['open_backup', WRONG_PASSWORD]] },
  // The iPhone's own storage full, which 0.10.1 blamed on the drive (OE-10).
  {
    fix: 'iphone-full',
    area: 'create_backup',
    details: "its says 960 Gigs of free space isn't enough on my external drive??",
    errors: [['backup.start', 'Not enough free space for this backup. The drive you chose only has 961 GB free. Free up space or choose a folder on an external drive, then try again.']],
    log: [
      '[RPC ERROR] backup.start: Traceback (most recent call last):',
      '  File "device_backup.py", line 654, in _run_backup',
      "pymobiledevice3.exceptions.NotEnoughDiskSpaceError: Device refused the backup: {'ErrorCode': 105, 'ErrorDescription': 'Failed to create snapshot: No space left on device (28) at path \"/private/var\" (MBErrorDomain/105)', 'MessageName': 'Response'}. The device counts every hardlink and clone at full size, because each is stored as a separate file in the backup, so this can far exceed the data stored on the device.",
      '',
      'The above exception was the direct cause of the following exception:',
      '',
      'Traceback (most recent call last):',
      '  File "main.py", line 509, in backup_start',
      'RuntimeError: Not enough free space for this backup. The drive you chose only has 961 GB free. Free up space or choose a folder on an external drive, then try again.',
    ].join('\n'),
  },
  // python/device_backup.py _IPHONE_FULL, from the version after 0.10.1.
  {
    fix: 'iphone-full',
    area: 'create_backup',
    errors: [['backup.start', 'Your iPhone is too full to make a backup: it needs some free space of its own to prepare one. Free up space on the iPhone (Settings > General > iPhone Storage shows what takes the most), then try again.']],
  },
  // python/device_backup.py _disk_full_message() when the iPhone said how much room it needs.
  {
    fix: 'backup-drive-full',
    os: WINDOWS,
    area: 'create_backup',
    errors: [['backup.start', 'Not enough free space for this backup. It needs more than 118 GB free, but the drive you chose has 62 GB free. Free up space or choose a folder on an external drive, then try again.']],
  },
  // pymobiledevice3's MissingValueError for an iPhone that never made an encrypted backup (OE-12).
  { fix: 'encrypted-backup-no-such-value', os: WINDOWS, area: 'create_backup', errors: [['backup.start', 'No such value.']] },
  // MBErrorDomain/104 as 0.10.1 showed it (OE-6, OE-8), and as later versions word it.
  {
    fix: 'iphone-could-not-send-files',
    os: WINDOWS,
    area: 'create_backup',
    errors: [['backup.start', "The device reported an error: {'ErrorCode': 104, 'ErrorDescription': 'Multiple errors uploading files (MBErrorDomain/104)', 'MessageName': 'Response'}.\nPlease report it at https://github.com/doronz88/pymobiledevice3/issues, with the output of the same command run with -v (`pymobiledevice3 -v ...`), so support for it can be added."]],
  },
  {
    fix: 'iphone-could-not-send-files',
    area: 'create_backup',
    errors: [['backup.start', "Your iPhone couldn't send some of its files. Restart your iPhone, plug it back in, then try again."]],
  },
  // MBErrorDomain/205 after an earlier try stopped partway (OE-6), and the later wording.
  {
    fix: 'unfinished-backup-folder',
    os: WINDOWS,
    area: 'create_backup',
    errors: [['backup.start', "The device reported an error: {'ErrorCode': 205, 'ErrorDescription': 'Error reading backup manifest properties (MBErrorDomain/205). Underlying error: Error deserializing properties: Cannot parse a NULL or zero-length data (MBErrorDomain/11).', 'MessageName': 'Response'}."]],
  },
  {
    fix: 'unfinished-backup-folder',
    area: 'create_backup',
    errors: [['backup.start', "The folder you chose has an unfinished backup of this iPhone from an earlier try, and the iPhone can't continue it. Choose a new, empty folder, then try again."]],
  },
  // Windows refusing to let the backup tidy up its own files (OE-11), and the later wording.
  {
    fix: 'backup-folder-access-denied',
    os: WINDOWS,
    area: 'create_backup',
    errors: [['backup.start', "[WinError 5] Access is denied: 'D:\\\\iPhone backups\\\\00008030-001A2B3C4D5E6F70\\\\Snapshot\\\\00'"]],
  },
  {
    fix: 'backup-folder-access-denied',
    os: WINDOWS,
    area: 'create_backup',
    errors: [['backup.start', "OpenExtract wasn't allowed to change a file in the backup folder. This can happen when another program, such as OneDrive or antivirus software, is using it. Choose a new, empty folder outside OneDrive or other synced folders, then try again."]],
  },
  // python/device_backup.py _device_service_error() on Windows without Apple Devices or iTunes.
  { fix: 'windows-apple-devices', os: WINDOWS, errors: [['backup.list_devices', WINDOWS_NO_DEVICE_SERVICE]] },
  // The same in 0.10.0, pasted into the report by hand (OE-4).
  {
    fix: 'windows-apple-devices',
    os: WINDOWS,
    area: 'general',
    details: OLD_NO_DEVICE_SERVICE,
    errors: [['backup.list_devices', OLD_NO_DEVICE_SERVICE]],
  },
];

test('each known fix shows for the app\'s real error, and only that fix', async () => {
  for (const [i, c] of REAL_ERRORS.entries()) {
    assert.deepEqual(await knownFixesFor(c), [c.fix], `REAL_ERRORS[${i}]`);
  }
  assert.deepEqual([...new Set(REAL_ERRORS.map(c => c.fix))].sort(), KNOWN_FIXES.map(f => f.id).sort());
});

test('reports about something else get no known fix', async () => {
  // electron/sidecar.ts call() timing out, and an engine error from python/main.py, on both systems.
  for (const os of [MAC, WINDOWS]) {
    assert.deepEqual(await knownFixesFor({
      os,
      errors: [['list_photos', 'Sidecar call timed out: list_photos'], ['list_voicemails', "'ZDATE'"]],
      log: "[RPC ERROR] list_voicemails: Traceback (most recent call last):\n  File \"voicemail.py\", line 10, in list\nKeyError: 'ZDATE'",
    }), []);
  }
  // Full Disk Access is only a macOS setting.
  assert.deepEqual(await knownFixesFor({ ...REAL_ERRORS[2], os: WINDOWS }), []);
  // A Mac without usbmuxd needs a restart, not Apple Devices.
  assert.deepEqual(await knownFixesFor({
    errors: [['backup.list_devices', "DEVICE_SERVICE_REQUIRED: OpenExtract can't reach the part of macOS that talks to iPhones (usbmuxd). Restart your Mac, then search again."]],
  }), []);
});

test('a report\'s status comes from its labels, then open or closed', () => {
  assert.deepEqual(site.reportStatus({ state: 'open', labels: [] }), { status: 'open' });
  assert.deepEqual(site.reportStatus({ state: 'closed', labels: [{ name: 'duplicate' }] }), { status: 'closed' });
  assert.deepEqual(site.reportStatus({ state: 'closed', labels: [{ name: 'bug' }, { name: 'fixed-in:0.9.2' }] }), { status: 'fixed', fixedIn: '0.9.2' });
  assert.deepEqual(site.reportStatus({ state: 'open', labels: ['Fixed in v1.0.0'] }), { status: 'fixed', fixedIn: '1.0.0' });
});

test('POST /api/feedback files a private issue and answers with a reference', async () => {
  const gh = fakeGitHub();
  assert.equal((await site.receiveReport({ method: 'GET', headers: {} }, env, gh.fetch)).status, 405);
  assert.equal((await site.receiveReport({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: '' }, env, gh.fetch)).status, 415);
  assert.equal((await site.receiveReport(jsonReq(goodReport()), {}, gh.fetch)).status, 503);
  assert.equal((await site.receiveReport(jsonReq(goodReport({ area: 'x' })), env, gh.fetch)).status, 400);
  assert.equal(gh.calls.length, 0);

  const report = goodReport({ token: 'c'.repeat(48) });
  const out = await site.receiveReport(jsonReq(report), env, gh.fetch);
  assert.equal(out.status, 200);
  assert.equal(out.body.reference, 'OE-1');
  assert.deepEqual(out.body.knownFixes.map(f => f.id), ['engine-did-not-start']);
  const call = gh.calls[0];
  assert.equal(call.url, 'https://api.github.com/repos/charleswest775/openextract-feedback/issues');
  assert.equal(call.init.headers.Authorization, 'Bearer ghp_test');
  assert.ok(JSON.parse(call.init.body).labels.includes('feedback'));

  // Pressing Send again on the same form gets the same answer, not a second issue.
  const again = await site.receiveReport(jsonReq(report), env, gh.fetch);
  assert.deepEqual(again.body, out.body);
  assert.equal(gh.issues.size, 1);
});

test('POST /api/feedback keeps the report when labels fail, and says so when GitHub fails', async () => {
  const calls = [];
  const labelsRejected = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return calls.length === 1 ? reply(422, {}) : reply(201, { number: 9 });
  };
  const out = await site.receiveReport(jsonReq(goodReport({ token: 'd'.repeat(48) })), env, labelsRejected);
  assert.equal(out.body.reference, 'OE-9');
  assert.equal(calls[1].labels, undefined);

  const down = await site.receiveReport(jsonReq(goodReport({ token: 'e'.repeat(48) })), env, async () => reply(500, {}));
  assert.equal(down.status, 502);
});

test('POST /api/feedback limits how often one network can send', async () => {
  const gh = fakeGitHub();
  const statuses = [];
  for (let i = 0; i < 6; i++) {
    const out = await site.receiveReport(jsonReq(goodReport({ token: String(i).repeat(48) }), '203.0.113.50'), env, gh.fetch);
    statuses.push(out.status);
  }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  const other = await site.receiveReport(jsonReq(goodReport({ token: 'f'.repeat(48) }), '203.0.113.51'), env, gh.fetch);
  assert.equal(other.status, 200);
});

test('POST /api/feedback-status answers only to the code the report was sent with', async () => {
  const gh = fakeGitHub();
  const sent = await site.receiveReport(jsonReq(goodReport({ token: '1a'.repeat(24) })), env, gh.fetch);
  const ask = (token, number = sent.body.number) => site.lookUpReport(jsonReq({ number, token }), env, gh.fetch);
  assert.deepEqual((await ask('1a'.repeat(24))).body, { status: 'open' });
  assert.equal((await ask('2b'.repeat(24))).status, 404);
  assert.equal((await ask('1a'.repeat(24), 999)).status, 404);
  assert.equal((await ask('not-hex')).status, 404);

  const issue = gh.issues.get(sent.body.number);
  issue.state = 'closed';
  issue.labels.push({ name: 'fixed-in:0.9.2' });
  assert.deepEqual((await ask('1a'.repeat(24))).body, { status: 'fixed', fixedIn: '0.9.2' });
});

test('compareVersions orders dotted versions numerically', () => {
  assert.equal(reports.compareVersions('0.9.10', '0.9.2'), 1);
  assert.equal(reports.compareVersions('0.9.1', '0.9.1'), 0);
  assert.equal(reports.compareVersions('0.9', '0.9.1'), -1);
});

test('the app turns failures into plain messages and keeps nothing', async () => {
  const offline = new reports.FeedbackReports(memoryStore(), async () => { throw new Error('ENOTFOUND'); }, '0.9.1');
  assert.match((await offline.send(goodReport())).error, /internet connection/);

  const busy = new reports.FeedbackReports(memoryStore(), async () => reply(429, { error: 'Too many reports were sent.' }), '0.9.1');
  assert.equal((await busy.send(goodReport())).error, 'Too many reports were sent.');

  const store = memoryStore();
  const down = new reports.FeedbackReports(store, async () => reply(503, { error: 'internal detail' }), '0.9.1');
  const res = await down.send(goodReport());
  assert.match(res.error, /couldn't be sent right now/);
  assert.equal(store.data.feedbackReports, undefined);
});

test('the app keeps the reference, and drops links in known fixes that point elsewhere', async () => {
  const store = memoryStore();
  const app = new reports.FeedbackReports(store, async () => reply(200, {
    number: 12,
    reference: 'OE-12',
    knownFixes: [
      { id: 'a', title: 'A', text: 'Do this', url: 'https://evil.example/x' },
      { id: 'b', title: 'B', text: 'Do that', url: 'https://www.openextract.app/help' },
    ],
  }), '0.9.1');
  const res = await app.send(goodReport({ email: ' pat@example.com ' }));
  assert.equal(res.reference, 'OE-12');
  assert.equal(res.knownFixes[0].url, undefined);
  assert.equal(res.knownFixes[1].url, 'https://www.openextract.app/help');
  assert.equal(store.data.feedbackEmail, 'pat@example.com');
  assert.equal(store.data.feedbackReports.length, 1);
  assert.equal(store.data.feedbackReports[0].token, TOKEN);
  assert.equal(store.data.feedbackReports[0].summary, 'It says the engine is not running');
});

test('send, fix, and the app finds out: the whole loop', async () => {
  const gh = fakeGitHub();
  const store = memoryStore();
  const app = new reports.FeedbackReports(store, siteFetch(gh), '0.9.1');

  const sent = await app.send(goodReport({ token: '3c'.repeat(24) }));
  assert.ok(sent.ok, sent.error);
  const day = 24 * 60 * 60 * 1000;

  // Nothing is asked for a few days after sending.
  const before = gh.calls.length;
  assert.equal(await app.checkIfDue(Date.now() + day), false);
  assert.equal(gh.calls.length, before);

  // Still open: asked once, nothing to tell.
  assert.equal(await app.checkIfDue(Date.now() + 4 * day), false);
  assert.equal(gh.calls.length, before + 1);
  assert.deepEqual(app.fixedToAnnounce(), []);

  // The maintainer ships the fix and labels the report.
  const issue = [...gh.issues.values()][0];
  issue.state = 'closed';
  issue.labels.push({ name: 'fixed-in:0.9.2' });

  assert.equal(await app.checkIfDue(Date.now() + 8 * day), true);
  const [fixed] = app.fixedToAnnounce();
  assert.equal(fixed.reference, sent.reference);
  assert.equal(fixed.fixedIn, '0.9.2');
  assert.equal(fixed.inThisVersion, false);

  // On 0.9.2 the same report reads as fixed in this version; once shown, it isn't shown again.
  assert.equal(new reports.FeedbackReports(store, siteFetch(gh), '0.9.2').fixedToAnnounce()[0].inThisVersion, true);
  app.markAnnounced(sent.reference);
  assert.deepEqual(app.fixedToAnnounce(), []);

  // A fixed report isn't asked about again.
  const calls = gh.calls.length;
  await app.checkIfDue(Date.now() + 20 * day);
  assert.equal(gh.calls.length, calls);
});
