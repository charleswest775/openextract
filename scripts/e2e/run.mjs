// End-to-end tests: drive the real OpenExtract app (Electron window + engine) with Playwright
// and check every screen, every export, the IPC bridge, performance budgets and that nothing
// talks to the network. CI runs them on Linux, macOS and Windows for every pull request
// (development build) and against installed packages before a release (see docs/TESTING.md).
//
//   npm install --no-save playwright-core@1.59.1
//   python scripts/e2e/backups.py e2e-backups.json          # generates the fictional test backups
//   node scripts/e2e/run.mjs --backups e2e-backups.json [--app <executable>] [--out <dir>] [--suites a,b]
//
// Without --app it runs this checkout's development build: run `npm run build` first. The
// engine is python/main.py run by $OPENEXTRACT_PYTHON, the .venv at the repository root, or
// python3/python on PATH. On Linux without a display, wrap it in `xvfb-run -a`.
//
// Writes <out>/results.json and exits 1 if any check failed. Screenshots are only taken of the
// fictional synthetic backups; third-party corpus backups (Hickman) never leave the temp folder.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { results, setSuite, check, ROOT } from './harness.mjs';
import { SUITES } from './suites/index.mjs';

const { values: opts } = parseArgs({
  options: {
    backups: { type: 'string' },
    app: { type: 'string' },
    out: { type: 'string', default: path.join(ROOT, 'e2e-out') },
    suites: { type: 'string' },
    list: { type: 'boolean', default: false },
  },
});

if (opts.list) {
  for (const s of SUITES) console.log(`${s.name.padEnd(12)} ${s.needs.join(', ') || '-'}  ${s.about}`);
  process.exit(0);
}
if (!opts.backups) {
  console.error('usage: node scripts/e2e/run.mjs --backups <backups.json> [--app <executable>] [--out <dir>] [--suites a,b] [--list]');
  process.exit(2);
}

const backups = JSON.parse(fs.readFileSync(opts.backups, 'utf-8'));
for (const [key, b] of Object.entries(backups)) {
  const expectedFile = path.join(path.dirname(b.dir), 'expected.json');
  b.expected = fs.existsSync(expectedFile) ? JSON.parse(fs.readFileSync(expectedFile, 'utf-8')) : null;
  b.key = key;
}

const out = path.resolve(opts.out);
fs.mkdirSync(out, { recursive: true });
// Exports of third-party backups go here and are deleted at the end.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-e2e-scratch-'));
const target = { app: opts.app ? path.resolve(opts.app) : null, kind: opts.app ? 'packaged' : 'dev' };
results.target = target;

const wanted = opts.suites ? opts.suites.split(',').map(s => s.trim()) : SUITES.filter(s => s.default !== false).map(s => s.name);
const unknown = wanted.filter(w => !SUITES.some(s => s.name === w));
if (unknown.length) { console.error(`Unknown suite(s): ${unknown.join(', ')}. Use --list.`); process.exit(2); }

const tempBefore = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('openextract-pdf-'));

for (const suite of SUITES.filter(s => wanted.includes(s.name))) {
  setSuite(suite.name);
  const missing = suite.needs.filter(n => !backups[n]);
  if (missing.length) {
    // A suite asked for by name must run; default suites may skip when an optional backup is absent.
    check(`needs ${missing.join(', ')}`, !opts.suites && suite.optional, { skipped: true, missing });
    continue;
  }
  console.log(`\n── ${suite.name}: ${suite.about}`);
  const t0 = performance.now();
  try {
    await suite.run({ target, backups, out, scratch: fs.mkdtempSync(path.join(scratch, suite.name + '-')) });
  } catch (e) {
    check('no exception', false, String(e.stack || e).slice(0, 1500));
  }
  results.timings.push({ name: `suite ${suite.name}`, ms: Math.round(performance.now() - t0) });
}

setSuite('cleanup');
const leftovers = fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('openextract-pdf-') && !tempBefore.includes(n));
check('no openextract-pdf-* temp folders left behind', leftovers.length === 0, leftovers);
fs.rmSync(scratch, { recursive: true, force: true });

const failed = results.checks.filter(c => !c.ok);
results.summary = `${results.checks.length - failed.length}/${results.checks.length} passed`;
results.finished = new Date().toISOString();
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
console.log(`\n${results.summary}`);
if (failed.length) {
  console.log('\nFailed:');
  for (const f of failed) console.log(`  ${f.name}${f.detail !== undefined ? ' — ' + JSON.stringify(f.detail).slice(0, 400) : ''}`);
}
process.exit(failed.length ? 1 : 0);
