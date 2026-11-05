// npm test: runs every scripts/**/*.test.mjs with Node's test runner. Node 20 doesn't expand
// globs itself and Windows shells don't either, so the files are listed here. Extra arguments
// go to `node --test` (e.g. --test-name-pattern).
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const files = fs.readdirSync(scripts, { recursive: true, withFileTypes: true })
  .filter(e => e.isFile() && e.name.endsWith('.test.mjs'))
  .map(e => path.join(e.parentPath ?? e.path, e.name))
  .filter(f => !f.split(path.sep).includes('test-helpers'))
  .sort();
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
process.exit(r.status ?? 1);
