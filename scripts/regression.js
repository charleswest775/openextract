#!/usr/bin/env node
/**
 * One command to run the regression suite from a clean checkout.
 *
 *   npm install
 *   npm run regression
 *
 * Idempotent. Works on macOS, Linux, Windows (PowerShell or cmd). Does:
 *   1. Resolve a Python 3 interpreter (py -3 on Windows, python3 on POSIX).
 *   2. Create .venv and install the Python sidecar deps, cloning the
 *      sibling ios-backup-core repo on first run.
 *   3. Download Playwright's Chromium bundle.
 *   4. Regenerate the synthetic-backup fixtures.
 *   5. Build the Electron main + renderer bundles.
 *   6. Run Playwright against the built app, wrapping with xvfb-run on
 *      headless Linux (detected via DISPLAY).
 */

const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const isLinux = process.platform === 'linux';
const needsXvfb = isLinux && !process.env.DISPLAY;

const VENV = path.join(REPO, '.venv');
const VENV_BIN = path.join(VENV, isWindows ? 'Scripts' : 'bin');
const PY = path.join(VENV_BIN, isWindows ? 'python.exe' : 'python');
const PIP = path.join(VENV_BIN, isWindows ? 'pip.exe' : 'pip');

function run(cmd, args, { optional = false, env, cwd = REPO } = {}) {
  console.log(`\n$ (cd ${path.relative(REPO, cwd) || '.'}) ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd,
    shell: isWindows,
    env: { ...process.env, ...(env || {}) },
  });
  if (r.status !== 0 && !optional) {
    console.error(`\n[regression] failed: ${cmd} ${args.join(' ')}`);
    process.exit(r.status ?? 1);
  }
  return r.status === 0;
}

function probe(cmd, args) {
  const r = spawnSync(cmd, args, { shell: isWindows });
  return r.status === 0;
}

// 1. Host Python (only needed to create the venv).
function findHostPython() {
  const candidates = isWindows
    ? [['py', ['-3']], ['python', []], ['python3', []]]
    : [['python3', []], ['python', []]];
  for (const [c, a] of candidates) {
    if (probe(c, [...a, '--version'])) return { cmd: c, baseArgs: a };
  }
  console.error('[regression] Python 3.11+ required but not found on PATH.');
  console.error('  macOS:   brew install python@3.11');
  console.error('  Windows: install from python.org (check "Add to PATH")');
  process.exit(1);
}

if (!existsSync(VENV)) {
  const { cmd, baseArgs } = findHostPython();
  run(cmd, [...baseArgs, '-m', 'venv', '.venv']);
}

// 2. Sidecar dependencies. ios-backup-core isn't on PyPI yet; the sibling
//    checkout is how requirements.txt's editable install resolves.
const sibling = path.resolve(REPO, '..', 'ios-backup-core');
if (!existsSync(sibling)) {
  run('git', ['clone', '--depth=1', 'https://github.com/charleswest775/ios-backup-core.git', sibling]);
}
run(PIP, ['install', '--upgrade', 'pip']);
// Run from python/ so the `-e ../../ios-backup-core` editable install in
// requirements.txt resolves to the sibling checkout cloned above.
run(PIP, ['install', '-r', 'requirements.txt'], { cwd: path.join(REPO, 'python') });

// 3. Playwright's Chromium bundle. Only needed for non-Electron browser
//    tests; `_electron.launch` uses the Electron from node_modules. Best-
//    effort — firewalled networks that block playwright.dev can still run
//    the Electron specs.
run('npx', ['playwright', 'install', 'chromium'], { optional: true });

// 4. Fixtures — committed, but rebuild to catch schema drift.
run(PY, [path.join('tests', 'fixtures', 'build_fixture.py')]);

// 5. Build.
run('npm', ['run', 'build']);

// 6. Run.
const testEnv = { OPENEXTRACT_TEST_PYTHON: PY };
if (needsXvfb) testEnv.OPENEXTRACT_E2E_NO_SANDBOX = '1';

const playwrightArgs = ['playwright', 'test', '--config', path.join('tests', 'e2e', 'playwright.config.ts')];
if (needsXvfb) {
  if (!probe('xvfb-run', ['--help'])) {
    console.error('[regression] xvfb-run not installed. apt-get install xvfb');
    process.exit(1);
  }
  run('xvfb-run', ['-a', 'npx', ...playwrightArgs], { env: testEnv });
} else {
  run('npx', playwrightArgs, { env: testEnv });
}

console.log('\n[regression] all tests passed.');
