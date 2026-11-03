// Tests for how the one search box matches and marks text.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-search-test-'));

/** Transpile one TS file to CommonJS in a temp dir and require it. */
function load(rel) {
  const src = fs.readFileSync(path.join(root, rel), 'utf-8');
  const out = ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const file = path.join(tmp, rel.replace(/[\\/]/g, '_') + '.cjs');
  fs.writeFileSync(file, out);
  return require(file);
}

const { fold, parseQuery, matches, haystack, matchesTerms, searchText, highlightRanges } = load('src/lib/search.ts');

test('fold drops case and accents', () => {
  assert.equal(fold('Café Crème'), 'cafe creme');
  assert.equal(fold('ÅNGSTRÖM'), 'angstrom');
  // Already decomposed text folds the same way
  assert.equal(fold('Café'), 'cafe');
});

test('parseQuery splits words and keeps quoted phrases whole', () => {
  assert.deepEqual(parseQuery('  Bread  RECIPE '), ['bread', 'recipe']);
  assert.deepEqual(parseQuery('"sourdough starter" feed'), ['sourdough starter', 'feed']);
  assert.deepEqual(parseQuery('"unclosed phrase'), ['unclosed phrase']);
  assert.deepEqual(parseQuery('""'), []);
});

test('every word must appear, in any order', () => {
  assert.ok(matches('recipe bread', 'Bread recipe from Mom'));
  assert.ok(matches('bread', 'Title', 'Body mentions BREAD'));
  assert.ok(!matches('bread butter', 'Bread recipe'));
  assert.ok(matches('', 'anything'));
});

test('a quoted phrase must appear as written', () => {
  assert.ok(matches('"bread recipe"', 'my bread recipe'));
  assert.ok(!matches('"bread recipe"', 'recipe for bread'));
});

test('accents in the query or the text do not matter', () => {
  assert.ok(matches('cafe', 'Meet at the café'));
  assert.ok(matches('café', 'Meet at the cafe'));
});

test('phone numbers match however they are punctuated', () => {
  const hay = haystack(['Theo Navarro'], ['+1 (503) 555-0142']);
  assert.ok(matchesTerms(hay, parseQuery('555-0142')));
  assert.ok(matchesTerms(hay, parseQuery('(503) 5550142')));
  assert.ok(matchesTerms(hay, parseQuery('theo')));
  assert.ok(!matchesTerms(hay, parseQuery('555-9999')));
});

test('searchText covers the whole note body, not just its start', () => {
  const note = {
    id: 'note:1', type: 'note', timestamp: '2025-01-01T00:00:00Z', contactName: null, contactIdentifier: null,
    note: { noteId: 1, title: 'Plans', bodyPreview: 'short', body: 'x'.repeat(500) + ' sourdough', modified: '' },
  };
  assert.ok(matchesTerms(searchText(note), parseQuery('sourdough')));
  // Cached: the same object gives the same string
  assert.equal(searchText(note), searchText(note));
});

test('searchText says what kind of record it is', () => {
  const call = {
    id: 'call:1', type: 'call', timestamp: '', contactName: 'Greg', contactIdentifier: '+15035550111',
    call: { direction: 'incoming', status: 'missed', duration: 0, app: 'com.apple.Telephony' },
  };
  assert.ok(matchesTerms(searchText(call), parseQuery('missed greg')));
  const shot = {
    id: 'photo:1', type: 'photo', timestamp: '', contactName: null, contactIdentifier: null,
    photo: { filename: 'IMG_0001.PNG', fileHash: 'x', kind: 'screenshot', width: 1, height: 1, duration: 0 },
  };
  assert.ok(matchesTerms(searchText(shot), parseQuery('screenshot')));
});

test('highlightRanges marks every match, merged and in order', () => {
  assert.deepEqual(highlightRanges('Bread and more bread', parseQuery('bread')), [[0, 5], [15, 20]]);
  assert.deepEqual(highlightRanges('breadcrumbs', parseQuery('bread crumb')), [[0, 10]]);
  assert.deepEqual(highlightRanges('nothing here', parseQuery('bread')), []);
});

test('highlightRanges points at the original text when accents were folded', () => {
  const text = 'Le Café Noir';
  const [[from, to]] = highlightRanges(text, parseQuery('cafe'));
  assert.equal(text.slice(from, to), 'Café');
  const decomposed = 'Café au lait';
  const [[a, b]] = highlightRanges(decomposed, parseQuery('café'));
  assert.equal(decomposed.slice(a, b), 'Cafe\u0301');
});
