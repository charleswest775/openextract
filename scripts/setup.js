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
  const result = spawnSync(cmd, args, { stdio: 'inherit', cwd: REPO_ROOT, ...opts });
  if (result.status !== 0) {
    console.error(`\n[setup] command failed: ${cmd} ${args.join(' ')}`);
    process.exit(result.status ?? 1);
  }
}

// 1. venv
if (!existsSync(venvDir)) {
  run(isWindows ? 'python' : 'python3', ['-m', 'venv', '.venv']);
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
