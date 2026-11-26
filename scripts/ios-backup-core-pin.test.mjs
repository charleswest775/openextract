// Keeps every workflow on the pinned ios-backup-core commit (ios-backup-core.ref), so a merge in
// ios-backup-core can't change what this repo's CI, releases and installers build until a PR
// here moves the pin (scripts/bump-ios-backup-core.sh). Fails when:
//   - ios-backup-core.ref isn't one full 40-character commit SHA on one line;
//   - a workflow or action clones or fetches ios-backup-core itself, except in a step that
//     reads the pin (the composite action .github/actions/ios-backup-core, and the copy of its
//     fetch written out in installers.yml for tags older than the action);
//   - a step uses that action with a ref other than `pinned`, the run's own
//     ios_backup_core_ref input falling back to `pinned`, or a commit an earlier job of the
//     same workflow resolved through the action;
//   - an ios_backup_core_ref input defaults to anything but blank (blank = the pin), or falls
//     back to anything but `pinned`.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACTION = './.github/actions/ios-backup-core';

/** Problems with the pin file's text. */
export function pinProblems(text) {
  if (!/^[0-9a-f]{40}\r?\n?$/.test(text)) {
    return [`ios-backup-core.ref must be one full 40-character commit SHA (lowercase hex) on one line, but is ${JSON.stringify(text.slice(0, 120))}. Write it with scripts/bump-ios-backup-core.sh.`];
  }
  return [];
}

const indent = line => line.match(/^ */)[0].length;

/** [start, end) of the YAML list item (a workflow step) that holds line i. */
function stepAround(lines, i) {
  let start = i;
  while (start >= 0 && !(/^\s*- /.test(lines[start]) && (start === i || indent(lines[start]) < indent(lines[i])))) start--;
  if (start < 0) return [i, i + 1];
  let end = start + 1;
  while (end < lines.length && (!lines[end].trim() || indent(lines[end]) > indent(lines[start]))) end++;
  return [start, end];
}

/** [start, end) of job `name` (a key two spaces in, under jobs:). */
function jobBlock(lines, name) {
  const start = lines.findIndex(l => l === `  ${name}:` || l.startsWith(`  ${name}: `) || l.startsWith(`  ${name}:#`));
  if (start < 0) return null;
  let end = start + 1;
  while (end < lines.length && !/^ {2}[\w-]+:/.test(lines[end])) end++;
  return [start, end];
}

// A clone or fetch of ios-backup-core: its git URL, a pip install from GitHub, an archive
// download or actions/checkout's `repository:`. Links to commits, comparisons, PRs and issues
// (in run summaries and release notes) aren't fetches.
const FETCH = [
  /ios-backup-core\.git\b/,
  /github\.com[/:]charleswest775\/ios-backup-core(?![\w.-])(?!\/(?:commit|compare|pull|issues|blob|tree|releases)\/)/,
  /codeload\.github\.com\/charleswest775\/ios-backup-core/,
  /repository:\s*['"]?[\w.-]*\/?ios-backup-core\b/,
];

const unquote = v => v.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');

/** True if `${{ needs.J.outputs.O }}` is a commit job J of the same file resolved through the action. */
function resolvedThroughAction(lines, value) {
  const m = value.match(/^\$\{\{\s*needs\.([\w-]+)\.outputs\.([\w-]+)\s*\}\}$/);
  if (!m) return false;
  const job = jobBlock(lines, m[1]);
  if (!job) return false;
  const body = lines.slice(job[0], job[1]);
  const output = body.map(l => l.match(new RegExp(`^\\s+${m[2]}:\\s*\\$\\{\\{\\s*steps\\.([\\w-]+)\\.outputs\\.sha\\s*\\}\\}\\s*$`))).find(Boolean);
  if (!output) return false;
  const idLine = body.findIndex(l => new RegExp(`^\\s*(?:- )?id:\\s*['"]?${output[1]}['"]?\\s*$`).test(l));
  if (idLine < 0) return false;
  const [s, e] = stepAround(body, idLine);
  return body.slice(s, e).some(l => new RegExp(`^\\s*(?:- )?uses:\\s*${ACTION.replace(/[.\/]/g, '\\$&')}\\s*$`).test(l));
}

const PIN_OR_INPUT = new Set(['pinned', "${{ inputs.ios_backup_core_ref || 'pinned' }}"]);

/** Problems in one workflow or action file's text. */
export function workflowProblems(name, text) {
  const lines = text.split(/\r?\n/);
  const problems = [];
  const at = i => `${name}:${i + 1}`;
  lines.forEach((line, i) => {
    if (/^\s*#/.test(line)) return;

    if (FETCH.some(re => re.test(line))) {
      const [s, e] = stepAround(lines, i);
      const step = lines.slice(s, e).join('\n');
      if (!(step.includes('ios-backup-core.ref') && step.includes('[0-9a-f]{40}'))) {
        problems.push(`${at(i)} fetches ios-backup-core itself: use ${ACTION} with \`ref: ${"${{ inputs.ios_backup_core_ref || 'pinned' }}"}\` (or \`ref: pinned\`), which checks out the commit in ios-backup-core.ref`);
      }
    }

    if (new RegExp(`^\\s*(?:- )?uses:\\s*${ACTION.replace(/[.\/]/g, '\\$&')}\\s*$`).test(line)) {
      const [s, e] = stepAround(lines, i);
      const refLine = lines.slice(s, e).map(l => l.match(/^\s*ref:\s*(.*)$/)).find(Boolean);
      const ref = refLine ? unquote(refLine[1]) : '';
      if (!PIN_OR_INPUT.has(ref) && !resolvedThroughAction(lines, ref)) {
        problems.push(`${at(i)} checks out ios-backup-core at ${JSON.stringify(ref)}: give \`ref: pinned\`, \`ref: ${"${{ inputs.ios_backup_core_ref || 'pinned' }}"}\`, or a commit an earlier job resolved through ${ACTION} (\`\${{ needs.<job>.outputs.<name> }}\`)`);
      }
    }

    // A fallback for the ios_backup_core_ref input other than the pin.
    for (const m of line.matchAll(/inputs\.ios_backup_core_ref\s*\|\|\s*(['"])(.*?)\1/g)) {
      if (m[2] !== 'pinned') problems.push(`${at(i)} falls back to ios-backup-core '${m[2]}' when ios_backup_core_ref is blank: blank means the pinned commit, write || 'pinned'`);
    }

    // The input's definition (`ios_backup_core_ref:` on its own line, under on.*.inputs).
    if (/^\s*ios_backup_core_ref:\s*$/.test(line)) {
      const own = indent(line);
      let j = i + 1;
      const props = {};
      for (; j < lines.length && (!lines[j].trim() || indent(lines[j]) > own); j++) {
        const p = lines[j].match(/^\s*(default|description):\s*(.*)$/);
        if (p) props[p[1]] = unquote(p[2]);
      }
      if ('default' in props && props.default !== '') {
        problems.push(`${at(i)} ios_backup_core_ref defaults to '${props.default}': leave the default blank, which means the commit pinned in ios-backup-core.ref`);
      }
      if (!(props.description || '').includes('ios-backup-core.ref')) {
        problems.push(`${at(i)} ios_backup_core_ref's description should say that blank means the commit pinned in ios-backup-core.ref`);
      }
    }

    // Passing a ref on to a reusable workflow: the run's own input, or a commit resolved through the action.
    const passed = line.match(/^\s*ios_backup_core_ref:\s*(\S.*)$/);
    if (passed) {
      const value = unquote(passed[1]);
      if (value !== '${{ inputs.ios_backup_core_ref }}' && !resolvedThroughAction(lines, value)) {
        problems.push(`${at(i)} passes ios_backup_core_ref ${JSON.stringify(value)}: pass a commit an earlier job resolved through ${ACTION}, or this run's own input`);
      }
    }
  });
  return problems;
}

function yamlFiles() {
  const out = [];
  for (const dir of ['.github/workflows', '.github/actions']) {
    for (const e of fs.readdirSync(path.join(root, dir), { recursive: true, withFileTypes: true })) {
      if (e.isFile() && /\.ya?ml$/.test(e.name)) out.push(path.relative(root, path.join(e.parentPath ?? e.path, e.name)).split(path.sep).join('/'));
    }
  }
  return out.sort();
}

test('ios-backup-core.ref holds one full commit SHA', () => {
  assert.deepEqual(pinProblems(fs.readFileSync(path.join(root, 'ios-backup-core.ref'), 'utf-8')), []);
});

test('every workflow gets ios-backup-core through the pin', () => {
  const files = yamlFiles();
  assert.ok(files.includes('.github/workflows/ci.yml') && files.includes('.github/actions/ios-backup-core/action.yml'), `couldn't find the workflows: ${files.join(', ')}`);
  const problems = files.flatMap(f => workflowProblems(f, fs.readFileSync(path.join(root, f), 'utf-8')));
  assert.deepEqual(problems, []);
  // And something still checks it out: the guard passing on files that never mention it proves nothing.
  const users = files.filter(f => fs.readFileSync(path.join(root, f), 'utf-8').includes(`uses: ${ACTION}`));
  for (const f of ['ci.yml', 'corpus-weekly.yml', 'release.yml', 'installers.yml', 'prerelease-check.yml']) {
    assert.ok(users.includes(`.github/workflows/${f}`), `${f} no longer checks out ios-backup-core through ${ACTION}`);
  }
});

test('the action reads the pin when asked for `pinned`', () => {
  const action = fs.readFileSync(path.join(root, '.github/actions/ios-backup-core/action.yml'), 'utf-8');
  assert.match(action, /"\$REF" = pinned/);
  assert.match(action, /tr -d '\[:space:\]' < ios-backup-core\.ref/);
  assert.match(action, /\^\[0-9a-f\]\{40\}\$/);
});

// The guard itself: each kind of slip it exists for is caught.
test('the guard catches a bad pin and every way around it', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(pinProblems(`${sha}\n`), []);
  assert.deepEqual(pinProblems(`${sha}\r\n`), []);
  for (const bad of ['', 'master\n', `${sha.slice(0, 12)}\n`, `${sha.toUpperCase()}\n`, `${sha}\n${sha}\n`, ` ${sha}\n`]) {
    assert.equal(pinProblems(bad).length, 1, `accepted ${JSON.stringify(bad)}`);
  }

  const wf = body => `name: t\non:\n  workflow_dispatch:\n    inputs:\n      ios_backup_core_ref:\n        description: 'blank = the commit pinned in ios-backup-core.ref'\n        default: ''\njobs:\n  a:\n    runs-on: ubuntu-latest\n    outputs:\n      sha: \${{ steps.core.outputs.sha }}\n    steps:\n      - uses: actions/checkout@v5\n      - name: Core\n        id: core\n        uses: ${ACTION}\n        with:\n          ref: \${{ inputs.ios_backup_core_ref || 'pinned' }}\n  b:\n    needs: a\n    runs-on: ubuntu-latest\n    steps:\n${body}`;
  const ok = [
    `      - uses: ${ACTION}\n        with:\n          ref: pinned\n`,
    `      - name: Same commit as job a\n        uses: ${ACTION}\n        with:\n          ref: \${{ needs.a.outputs.sha }}\n`,
    `      - run: echo "[core](https://github.com/charleswest775/ios-backup-core/commit/$SHA)"\n`,
  ];
  for (const body of ok) assert.deepEqual(workflowProblems('ok.yml', wf(body)), [], body);

  const bad = [
    `      - run: git clone --depth=1 https://github.com/charleswest775/ios-backup-core.git ../ios-backup-core\n`,
    `      - run: |\n          git clone --depth=1 \\\n            https://github.com/charleswest775/ios-backup-core \\\n            ../ios-backup-core\n`,
    `      - run: pip install git+https://github.com/charleswest775/ios-backup-core@master\n`,
    `      - uses: actions/checkout@v5\n        with:\n          repository: charleswest775/ios-backup-core\n          path: core\n`,
    `      - uses: ${ACTION}\n        with:\n          ref: master\n`,
    `      - uses: ${ACTION}\n        with:\n          ref: \${{ inputs.ios_backup_core_ref || 'master' }}\n`,
    `      - uses: ${ACTION}\n        with:\n          ref: \${{ needs.a.outputs.other }}\n`,
    `      - uses: ${ACTION}\n`,
    `      - run: echo \${{ inputs.ios_backup_core_ref || 'main' }}\n`,
  ];
  for (const body of bad) assert.ok(workflowProblems('bad.yml', wf(body)).length > 0, `missed:\n${body}`);

  const masterDefault = wf(ok[0]).replace("default: ''", "default: 'master'");
  assert.match(workflowProblems('bad.yml', masterDefault).join('\n'), /defaults to 'master'/);
  const passMaster = `jobs:\n  c:\n    uses: ./.github/workflows/x.yml\n    with:\n      ios_backup_core_ref: master\n`;
  assert.match(workflowProblems('bad.yml', passMaster).join('\n'), /passes ios_backup_core_ref "master"/);
});
