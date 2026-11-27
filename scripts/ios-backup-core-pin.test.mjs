// Keeps every workflow on the pinned ios-backup-core commit (ios-backup-core.ref), so a merge in
// ios-backup-core can't change what this repo's CI, releases and installers build until a PR
// here moves the pin (scripts/bump-ios-backup-core.sh). Fails when:
//   - ios-backup-core.ref isn't one full 40-character commit SHA on one line;
//   - a workflow or action names ios-backup-core's repository anywhere but in a link to a
//     commit, comparison, PR or issue (a git or pip URL, `owner/ios-backup-core`, a
//     `repository:` or `gh repo clone` line), except in the two steps that read the pin: the
//     composite action .github/actions/ios-backup-core, and the copy of its fetch written out
//     in installers.yml's test job for tags older than the action. Those two are run here
//     with bash and a stand-in git, to check that they fetch the pinned commit;
//   - a step uses that action, however its path is spelled, with a ref other than `pinned`,
//     the run's own ios_backup_core_ref input falling back to `pinned`, or a commit an earlier
//     job of the same workflow resolved through the action;
//   - an ios_backup_core_ref input defaults to anything but blank (blank = the pin), or falls
//     back to anything but `pinned`.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ACTION = './.github/actions/ios-backup-core';

// The steps allowed to fetch ios-backup-core themselves, because they read the pin. Each is run
// below to check it fetches the pinned commit; `input` is the env var its ref arrives in, and
// `blank` the value that means "the pin".
export const PIN_READERS = [
  { file: '.github/actions/ios-backup-core/action.yml', job: null, step: 'id: checkout', input: 'ASKED', blank: 'pinned' },
  { file: '.github/workflows/installers.yml', job: 'test', step: 'name: Check out ios-backup-core (sibling for editable install)', input: 'CORE_REF', blank: '' },
];

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

/** The job line i is in, or null outside `jobs:` (an action's steps, say). */
function jobOf(lines, i) {
  for (let k = i; k >= 0; k--) {
    const m = lines[k].match(/^ {2}([\w-]+):/);
    if (m) return lines.slice(0, k).some(l => /^jobs:\s*(#.*)?$/.test(l)) ? m[1] : null;
    if (/^\S/.test(lines[k])) return null;
  }
  return null;
}

/** The PIN_READERS entry for the step starting at line s of file `name`, if it is one. */
function pinReaderAt(name, lines, s) {
  return PIN_READERS.find(r => r.file === name && lines[s].trim() === `- ${r.step}` && jobOf(lines, s) === r.job);
}

// Naming ios-backup-core's repository is how a workflow fetches it, whatever the tool: a path
// segment `/ios-backup-core` that isn't the sibling checkout (`../ios-backup-core`), the pin
// file, the action's folder, a longer name (ios-backup-core-pin) or a link to a commit,
// comparison, PR, issue or file view. Plus `gh repo clone`, which also takes the bare name.
const REPO = /(?<!\.\.)(?<!\.github\/actions)\/ios-backup-core(?![\w-])(?!\.ref\b)(?!\/(?:commit|compare|pull|issues|blob|tree)\/)(?!#\d)/;
const FETCH = [
  REPO,
  /ios-backup-core\.git\b/,
  /^\s*(?:- )?repository:.*ios-backup-core/,
  /\bgh\s+repo\s+clone\b.*ios-backup-core/,
];

const unquote = v => v.replace(/\s+#.*$/, '').trim().replace(/^(['"])(.*)\1$/, '$2');

/** True if a `uses:` value is the ios-backup-core action, however it's spelled (quoted, a
 *  trailing slash, ./ segments, or this repository's copy referenced remotely). */
function isAction(value) {
  const v = unquote(value).replace(/@[^/]*$/, '').replace(/\/+$/, '');
  return path.posix.normalize(v) === path.posix.normalize(ACTION) || /(?:^|\/)\.github\/actions\/ios-backup-core$/.test(path.posix.normalize(v));
}

const usesValue = line => line.match(/^\s*(?:- )?uses:\s*(.+?)\s*$/)?.[1];

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
  return body.slice(s, e).some(l => usesValue(l) !== undefined && isAction(usesValue(l)));
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
      const [s] = stepAround(lines, i);
      if (!pinReaderAt(name, lines, s)) {
        problems.push(`${at(i)} fetches ios-backup-core itself: use ${ACTION} with \`ref: ${"${{ inputs.ios_backup_core_ref || 'pinned' }}"}\` (or \`ref: pinned\`), which checks out the commit in ios-backup-core.ref`);
      }
    }

    const uses = usesValue(line);
    if (uses !== undefined && isAction(uses)) {
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

/** True if the file checks ios-backup-core out through the action somewhere. */
const usesAction = text => text.split(/\r?\n/).some(l => !/^\s*#/.test(l) && usesValue(l) !== undefined && isAction(usesValue(l)));

/** The `run: |` script of a PIN_READERS step in that file's text, or null if the step is gone. */
export function pinReaderScript(reader, text) {
  const lines = text.split(/\r?\n/);
  const s = lines.findIndex((l, k) => /^\s*- /.test(l) && pinReaderAt(reader.file, lines, k) === reader);
  if (s < 0) return null;
  const [, e] = stepAround(lines, s);
  const r = lines.slice(s, e).findIndex(l => /^\s*(?:- )?run:\s*\|[-+]?\s*$/.test(l));
  if (r < 0) return null;
  const body = [];
  let block = null;
  for (let k = s + r + 1; k < e; k++) {
    if (!lines[k].trim()) { body.push(''); continue; }
    block ??= indent(lines[k]);
    if (indent(lines[k]) < block) break;
    body.push(lines[k].slice(block));
  }
  return body.join('\n') + '\n';
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
  const users = files.filter(f => usesAction(fs.readFileSync(path.join(root, f), 'utf-8')));
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

// A stand-in for git: `fetch` records the ref asked for (its last argument), `rev-parse` answers
// with it (or a made-up commit for a branch name), everything else does nothing.
const STUB_GIT = `#!/bin/sh
dir=.
while [ $# -gt 0 ]; do
  case "$1" in
    -C) dir=$2; shift 2 ;;
    -c) shift 2 ;;
    *) break ;;
  esac
done
cmd=$1; shift
case "$cmd" in
  init) for a in "$@"; do case "$a" in -*) ;; *) mkdir -p "$a" ;; esac; done ;;
  fetch) for a in "$@"; do last=$a; done; echo "$last" >> "$GIT_LOG"; echo "$last" > "$dir/.fetched" ;;
  rev-parse)
    ref=$(cat "$dir/.fetched")
    if echo "$ref" | grep -Eq '^[0-9a-f]{40}$'; then echo "$ref"; else echo 0123456789abcdef0123456789abcdef01234567; fi ;;
esac
exit 0
`;

/** Runs a pin reader's script as Actions would (bash -eo pipefail, in the workspace) with the
 *  stand-in git. `pin` is ios-backup-core.ref's text (undefined: no file), `ref` the input. */
function runPinReader(reader, script, { pin, ref }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-pin-'));
  try {
    const ws = path.join(dir, 'openextract');
    const bin = path.join(dir, 'bin');
    fs.mkdirSync(ws);
    fs.mkdirSync(bin);
    if (pin !== undefined) fs.writeFileSync(path.join(ws, 'ios-backup-core.ref'), pin);
    fs.writeFileSync(path.join(bin, 'git'), STUB_GIT, { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'step.sh'), script);
    const output = path.join(dir, 'github_output');
    const log = path.join(dir, 'fetched');
    fs.writeFileSync(output, '');
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', path.join(dir, 'step.sh')], {
      cwd: ws, encoding: 'utf-8',
      env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, GITHUB_WORKSPACE: ws, GITHUB_OUTPUT: output, GIT_LOG: log, GITHUB_REF_NAME: 'main', TAG: '', [reader.input]: ref },
    });
    return {
      status: r.status,
      said: `${r.stdout}${r.stderr}`,
      fetched: fs.existsSync(log) ? fs.readFileSync(log, 'utf-8').split('\n').filter(Boolean) : [],
      output: fs.readFileSync(output, 'utf-8'),
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('the steps that read the pin fetch the pinned commit', { skip: process.platform === 'win32' ? 'runs the steps with bash and a stand-in git, which needs a POSIX shell' : false }, () => {
  const sha = '0d56074c355d62506db39276d94164ecfd0c688d';
  for (const reader of PIN_READERS) {
    const script = pinReaderScript(reader, fs.readFileSync(path.join(root, reader.file), 'utf-8'));
    assert.ok(script, `${reader.file}: no step "${reader.step}"${reader.job ? ` in job ${reader.job}` : ''} with a run: | script. If it moved or was renamed, update PIN_READERS`);
    assert.doesNotMatch(script, /\$\{\{/, `${reader.file}: the pin-reading script should take its inputs from env, not \${{ }} (this test can't fill those in)`);
    const what = `${reader.file} (${reader.input}=${JSON.stringify(reader.blank)})`;

    for (const pin of [`${sha}\n`, `${sha}\r\n`]) {
      const r = runPinReader(reader, script, { pin, ref: reader.blank });
      assert.equal(r.status, 0, `${what} failed with the pin ${JSON.stringify(pin)}:\n${r.said}`);
      assert.deepEqual(r.fetched, [sha], `${what} should fetch the pinned commit`);
      if (reader.input === 'ASKED') assert.match(r.output, new RegExp(`^sha=${sha}$`, 'm'));
    }

    const branch = runPinReader(reader, script, { pin: `${sha}\n`, ref: 'some-branch' });
    assert.equal(branch.status, 0, branch.said);
    assert.deepEqual(branch.fetched, ['some-branch'], `${reader.file} should fetch the ref it's given instead of the pin`);

    for (const pin of [undefined, 'master\n', `${sha.slice(0, 12)}\n`]) {
      const r = runPinReader(reader, script, { pin, ref: reader.blank });
      assert.notEqual(r.status, 0, `${what} should fail with the pin ${JSON.stringify(pin)}`);
      assert.match(r.said, /::error/);
      assert.deepEqual(r.fetched, [], `${what} fetched with the pin ${JSON.stringify(pin)}`);
    }
  }
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
    `      - uses: "${ACTION}/"\n        with:\n          ref: pinned\n`,
    `      - name: Same commit as job a\n        uses: ${ACTION}\n        with:\n          ref: \${{ needs.a.outputs.sha }}\n`,
    `      - run: echo "[core](https://github.com/charleswest775/ios-backup-core/commit/$SHA)"\n`,
    `      - run: echo "https://github.com/charleswest775/ios-backup-core/compare/$OLD...$NEW and charleswest775/ios-backup-core#36"\n`,
    `      - run: pip install "$GITHUB_WORKSPACE/../ios-backup-core" && cat "$GITHUB_WORKSPACE/ios-backup-core.ref"\n`,
    `      - run: node --test scripts/ios-backup-core-pin.test.mjs && scripts/bump-ios-backup-core.sh\n`,
  ];
  for (const body of ok) assert.deepEqual(workflowProblems('ok.yml', wf(body)), [], body);

  const bad = [
    `      - run: git clone --depth=1 https://github.com/charleswest775/ios-backup-core.git ../ios-backup-core\n`,
    `      - run: |\n          git clone --depth=1 \\\n            https://github.com/charleswest775/ios-backup-core \\\n            ../ios-backup-core\n`,
    `      - run: pip install git+https://github.com/charleswest775/ios-backup-core@master\n`,
    `      - uses: actions/checkout@v5\n        with:\n          repository: charleswest775/ios-backup-core\n          path: core\n`,
    `      - run: gh repo clone charleswest775/ios-backup-core ../ios-backup-core\n`,
    `      - run: gh repo clone ios-backup-core ../ios-backup-core\n`,
    `      - uses: actions/checkout@v5\n        with:\n          repository: \${{ github.repository_owner }}/ios-backup-core\n`,
    `      - run: git clone "$GITHUB_SERVER_URL/charleswest775/ios-backup-core" ../ios-backup-core\n`,
    `      - run: curl -L https://api.github.com/repos/charleswest775/ios-backup-core/tarball/master | tar xz\n`,
    `      - run: curl -LO https://raw.githubusercontent.com/charleswest775/ios-backup-core/master/backupgen/generate.py\n`,
    `      - env:\n          CORE: charleswest775/ios-backup-core\n        run: git clone "https://github.com/$CORE" ../ios-backup-core\n`,
    `      - uses: ${ACTION}\n        with:\n          ref: master\n`,
    `      - uses: "${ACTION}"\n        with:\n          ref: master\n`,
    `      - uses: '${ACTION}'\n        with:\n          ref: master\n`,
    `      - uses: ${ACTION}/\n        with:\n          ref: master\n`,
    `      - uses: ./.github/actions/./ios-backup-core\n        with:\n          ref: master\n`,
    `      - uses: charleswest775/openextract/.github/actions/ios-backup-core@main\n        with:\n          ref: master\n`,
    `      - uses: ${ACTION}\n        with:\n          ref: \${{ inputs.ios_backup_core_ref || 'master' }}\n`,
    `      - uses: ${ACTION}\n        with:\n          ref: \${{ needs.a.outputs.other }}\n`,
    `      - uses: ${ACTION}\n`,
    `      - run: echo \${{ inputs.ios_backup_core_ref || 'main' }}\n`,
    // A comment naming the pin no longer excuses a step: only the two steps in PIN_READERS may fetch.
    `      - run: |\n          # reads ios-backup-core.ref, checks [0-9a-f]{40}\n          git clone https://github.com/charleswest775/ios-backup-core.git ../ios-backup-core\n`,
  ];
  for (const body of bad) assert.ok(workflowProblems('bad.yml', wf(body)).length > 0, `missed:\n${body}`);

  // A fetch in a step named like installers' pin reader but in another job, or in another file, is not exempt.
  const reader = `      - name: Check out ios-backup-core (sibling for editable install)\n        run: git -C core fetch https://github.com/charleswest775/ios-backup-core.git master\n`;
  assert.ok(workflowProblems('.github/workflows/installers.yml', wf(reader)).length > 0, 'exempted a step outside installers.yml\'s test job');
  assert.deepEqual(workflowProblems('.github/workflows/installers.yml', wf(reader).replace('\n  b:\n', '\n  test:\n')), []);

  const masterDefault = wf(ok[0]).replace("default: ''", "default: 'master'");
  assert.match(workflowProblems('bad.yml', masterDefault).join('\n'), /defaults to 'master'/);
  const passMaster = `jobs:\n  c:\n    uses: ./.github/workflows/x.yml\n    with:\n      ios_backup_core_ref: master\n`;
  assert.match(workflowProblems('bad.yml', passMaster).join('\n'), /passes ios_backup_core_ref "master"/);
});
