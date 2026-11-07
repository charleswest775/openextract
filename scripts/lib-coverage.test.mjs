// Every renderer logic module in src/lib must have tests: some scripts/**/*.test.mjs
// file has to load it by path (e.g. loadTs('src/lib/people.ts')), so a new module
// added without tests fails CI here.
// Run with: node --test scripts/lib-coverage.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scripts = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(scripts, '..');
const libDir = path.join(root, 'src', 'lib');

const modules = fs.readdirSync(libDir)
  .filter(f => /\.tsx?$/.test(f) && !f.endsWith('.d.ts'))
  .map(f => f.replace(/\.tsx?$/, ''))
  .sort();

function testFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (entry.name.endsWith('.test.mjs') && full !== fileURLToPath(import.meta.url)) out.push(full);
  }
  return out;
}
const tests = testFiles(scripts).map(file => ({ file, text: fs.readFileSync(file, 'utf-8') }));

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// 'src/lib/people.ts', "src/lib/people", or with Windows separators
const mentions = name => new RegExp(`src[\\\\/]+lib[\\\\/]+${escape(name)}(\\.tsx?)?['"\`]`);

test('the guard found the modules and the test files', () => {
  assert.ok(modules.length >= 10, `only found ${modules.length} modules in src/lib`);
  assert.ok(tests.length >= 2, `only found ${tests.length} test files under scripts/`);
});

for (const name of modules) {
  test(`src/lib/${name}.ts has tests`, () => {
    const loadedBy = tests.filter(t => mentions(name).test(t.text)).map(t => path.relative(root, t.file));
    assert.ok(loadedBy.length > 0, [
      `src/lib/${name}.ts isn't loaded by any test.`,
      `Add scripts/${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}.test.mjs that loads it with`,
      `  import { loadTs } from './test-helpers/load-ts.mjs';`,
      `  const { ... } = loadTs('src/lib/${name}.ts');`,
      'and tests what it does (scripts/people.test.mjs is a good example). Run it with',
      `  node --test scripts/<your file>.test.mjs`,
    ].join('\n'));
  });
}
