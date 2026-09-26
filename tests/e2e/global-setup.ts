import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BUILDER = path.join(REPO_ROOT, 'tests', 'fixtures', 'build_fixture.py');
const isWindows = process.platform === 'win32';

// Fixtures are generated fresh for every run rather than committed: the app
// reads unencrypted backups in place (and adds indexes to sms.db), so a
// committed copy would drift and dirty the working tree.
function pythonCandidates(): [string, string[]][] {
  const venv = path.join(REPO_ROOT, '.venv', isWindows ? 'Scripts' : 'bin', isWindows ? 'python.exe' : 'python');
  const list: [string, string[]][] = [];
  if (process.env.OPENEXTRACT_TEST_PYTHON) list.push([process.env.OPENEXTRACT_TEST_PYTHON, []]);
  if (fs.existsSync(venv)) list.push([venv, []]);
  if (isWindows) list.push(['py', ['-3']], ['python', []]);
  else list.push(['python3', []], ['python', []]);
  return list;
}

export default function globalSetup() {
  for (const [cmd, baseArgs] of pythonCandidates()) {
    const r = spawnSync(cmd, [...baseArgs, BUILDER], { cwd: REPO_ROOT, encoding: 'utf-8', shell: isWindows });
    if (r.status === 0) return;
    if (r.error) continue; // interpreter not found — try the next one
    throw new Error(`build_fixture.py failed with ${cmd}:\n${r.stdout}\n${r.stderr}`);
  }
  throw new Error('No Python 3 interpreter found to build the test fixtures.');
}
