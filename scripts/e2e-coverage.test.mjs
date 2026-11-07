// Keeps the end-to-end suites (scripts/e2e) in step with the app: a new screen, a new export
// kind or format, a new function on the window bridge, or a new suite file fails here until
// the suites cover it. Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SCREENS } from './e2e/suites/screens.mjs';
import { PANEL_EXPORTS } from './e2e/suites/exports.mjs';
import { BRIDGE } from './e2e/suites/ipc.mjs';
import { SUITES } from './e2e/suites/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf-8');

test('every screen ExploreLayout can show is visited by the screens suite', () => {
  const src = read('src/components/explore/ExploreLayout.tsx');
  const body = src.slice(src.indexOf('function renderSection'));
  const tabs = [...body.slice(0, body.indexOf('\n  }\n')).matchAll(/case '([a-z_]+)':/g)].map(m => m[1]);
  assert.ok(tabs.length > 5, 'could not read the tabs from ExploreLayout.renderSection');
  const missing = tabs.filter(t => !(t in SCREENS));
  assert.deepEqual(missing, [], `ExploreLayout has screens the e2e suite doesn't visit: ${missing.join(', ')}. Add each to SCREENS in scripts/e2e/suites/screens.mjs and check it in that suite.`);
});

test('every kind and format on "Save to this computer" is exported by the exports suite', () => {
  const src = read('src/components/explore/ExportPanel.tsx');
  const kinds = {};
  for (const m of src.matchAll(/id: '([a-z_]+)', label:[\s\S]*?formats: \[([^\]]*)\]/g)) {
    kinds[m[1]] = [...m[2].matchAll(/FORMATS\.([a-z]+)/g)].map(f => f[1]);
  }
  assert.ok(Object.keys(kinds).length > 3, 'could not read KINDS from ExportPanel.tsx');
  assert.deepEqual(kinds, PANEL_EXPORTS, 'ExportPanel and PANEL_EXPORTS in scripts/e2e/suites/exports.mjs differ: export the new kind or format in that suite and list it there.');
});

test('every function on window.openextract is called by the ipc suite', () => {
  const src = read('electron/preload.ts');
  const body = src.slice(src.indexOf("exposeInMainWorld('openextract'"));
  // Top-level and one-level-nested keys whose value is a function: `name: (` or `name: () =>`.
  const exposed = [];
  const stack = [];
  for (const line of body.split('\n')) {
    const nest = line.match(/^\s+([a-zA-Z]+): \{\s*$/);
    if (nest) { stack.push(nest[1]); continue; }
    if (/^\s+\},?\s*$/.test(line) && stack.length) { stack.pop(); continue; }
    const fn = line.match(/^\s+([a-zA-Z]+): (?:\(|async \()/);
    if (fn) exposed.push([...stack.filter(Boolean), fn[1]].join('.'));
    // A function with a block body closes with its own `},`.
    if (fn && /\{\s*$/.test(line)) stack.push(null);
  }
  assert.ok(exposed.length > 20, 'could not read the bridge from electron/preload.ts');
  assert.deepEqual([...exposed].sort(), [...BRIDGE].sort(), 'electron/preload.ts and BRIDGE in scripts/e2e/suites/ipc.mjs differ: call the new function in the ipc suite and list it there.');
});

test('every suite file is registered in scripts/e2e/suites/index.mjs', () => {
  const files = fs.readdirSync(path.join(root, 'scripts/e2e/suites')).filter(f => f.endsWith('.mjs') && f !== 'index.mjs');
  const names = SUITES.map(s => s.name);
  assert.equal(files.length, SUITES.length, `suite files: ${files.join(', ')}; registered: ${names.join(', ')}`);
  for (const s of SUITES) {
    assert.ok(s.name && s.about && Array.isArray(s.needs) && typeof s.run === 'function', `suite ${s.name} is missing name, about, needs or run`);
  }
});

test('every performance budget is measured by some suite', () => {
  const budgets = Object.keys(JSON.parse(read('scripts/e2e/budgets.json'))).filter(k => !k.startsWith('_'));
  const sources = fs.readdirSync(path.join(root, 'scripts/e2e/suites')).map(f => read(`scripts/e2e/suites/${f}`)).join('\n');
  // Names are literal, or built from PANEL_EXPORTS (`export ${kind} ${format}`).
  const built = Object.entries(PANEL_EXPORTS).flatMap(([k, fs]) => fs.map(f => `export ${k} ${f}`));
  const unused = budgets.filter(b => !sources.includes(`'${b}'`) && !built.includes(b) && !sources.includes(b.replace(/ (separate|merged|pdf|html|csv|txt)$/, '')));
  assert.deepEqual(unused, [], `budgets.json has budgets nothing measures: ${unused.join(', ')}`);
});

test('known issues name checks that exist', () => {
  const issues = JSON.parse(read('scripts/e2e/known-issues.json')).issues;
  for (const i of issues) {
    assert.match(i.check, /^[a-z-]+: /, `known issue "${i.check}" must be "suite: check"`);
    assert.ok(i.reason, `known issue "${i.check}" needs a reason`);
    const suite = i.check.split(':')[0];
    assert.ok(SUITES.some(s => s.name === suite) || ['macos', 'windows', 'linux'].includes(suite), `known issue "${i.check}" names no suite`);
  }
});
