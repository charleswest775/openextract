#!/usr/bin/env node
// One-shot setup for local development + E2E testing.
//
// Creates the .venv if missing, installs the Python sidecar deps (plus the
// sibling ios-backup-core checkout), installs Playwright's browser bundle,
// regenerates the test fixtures, and builds Electron so `npm run test:e2e`
// can run immediately after.

const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const isWindows = process.platform === 'win32';
const venvDir = path.join(REPO_ROOT, '.venv');
const pip = path.join(venvDir, isWindows ? 'Scripts' : 'bin', isWindows ? 'pip.exe' : 'pip');

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  // shell:true lets npm/npx/py resolve via PATHEXT on Windows where the
  // executable might be a .cmd or .bat shim.
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd: REPO_ROOT, shell: isWindows, ...opts });
  if (result.status !== 0) {
    console.error(`\n[setup] command failed: ${cmd} ${args.join(' ')}`);
    process.exit(result.status ?? 1);
  }
}

// Pick the first interpreter that responds to `--version`. On Windows the
// `py` launcher (installed with python.org's Python) is the most reliable;
// `python` works if "Add to PATH" was checked at install time. On POSIX we
// just prefer python3 over python.
function findHostPython() {
  const candidates = isWindows ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]];
  for (const [cmd, baseArgs] of candidates) {
    const probe = spawnSync(cmd, [...baseArgs, '--version'], { shell: isWindows });
    if (probe.status === 0) return { cmd, baseArgs };
  }
  console.error('[setup] no Python interpreter found. Install Python 3.11+ from python.org and re-run.');
  process.exit(1);
}

// 1. venv
if (!existsSync(venvDir)) {
  const { cmd, baseArgs } = findHostPython();
  run(cmd, [...baseArgs, '-m', 'venv', '.venv']);
}

// 2. Sidecar deps — ios-backup-core comes from a sibling checkout.
const siblingCore = path.resolve(REPO_ROOT, '..', 'ios-backup-core');
if (!existsSync(siblingCore)) {
  console.log(`\n[setup] cloning ios-backup-core to ${siblingCore}`);
  run('git', ['clone', 'https://github.com/charleswest775/ios-backup-core.git', siblingCore]);
}
run(pip, ['install', '-r', 'python/requirements.txt']);
run(pip, ['install', '-r', 'python/requirements-dev.txt']);

// 3. Playwright browser bundle (needed even for Electron driver).
run('npx', ['playwright', 'install', 'chromium']);

// 4. Regenerate fixtures + build Electron.
const python = path.join(venvDir, isWindows ? 'Scripts' : 'bin', isWindows ? 'python.exe' : 'python');
run(python, ['tests/fixtures/build_fixture.py']);
run('npm', ['run', 'build']);

console.log('\n[setup] done. Run tests with:  npm run test:e2e');
