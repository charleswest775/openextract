#!/usr/bin/env node
// Cross-platform runner for tools inside the project's `.venv` virtualenv.
//
//   node scripts/venv-bin.js pip install -r python/requirements.txt
//   node scripts/venv-bin.js pytest python/tests/ -v
//
// Resolves the binary differently on Windows (.venv/Scripts/*.exe) vs
// macOS/Linux (.venv/bin/*), so `package.json` scripts don't have to hard-
// code either layout.

const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

const [tool, ...toolArgs] = process.argv.slice(2);
if (!tool) {
  console.error('usage: node scripts/venv-bin.js <tool> [...args]');
  process.exit(2);
}

const isWindows = process.platform === 'win32';
const venvDir = path.resolve(__dirname, '..', '.venv');
const binDir = path.join(venvDir, isWindows ? 'Scripts' : 'bin');
const exe = path.join(binDir, isWindows ? `${tool}.exe` : tool);

if (!existsSync(exe)) {
  console.error(`[venv-bin] not found: ${exe}`);
  console.error('[venv-bin] create the venv first:  npm run setup:python');
  process.exit(1);
}

const result = spawnSync(exe, toolArgs, { stdio: 'inherit' });
process.exit(result.status ?? 1);
