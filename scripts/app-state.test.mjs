// Tests for src/lib/appState.ts, the shape of the home screen's state. It holds
// only types, so this checks they still describe what the main process sends:
// electron/main.ts builds the object in its 'get-app-state' handler with `any`
// types, so tsc can't catch the two drifting apart.
// Run with: node --test scripts/app-state.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { loadTs, root } from './test-helpers/load-ts.mjs';

const parse = rel => ts.createSourceFile(rel, fs.readFileSync(path.join(root, rel), 'utf-8'), ts.ScriptTarget.Latest, true);

function find(node, predicate) {
  if (predicate(node)) return node;
  return ts.forEachChild(node, child => find(child, predicate));
}
function findAll(node, predicate, out = []) {
  if (predicate(node)) out.push(node);
  ts.forEachChild(node, child => { findAll(child, predicate, out); });
  return out;
}

// ── What appState.ts declares ────────────────────────────────────────────────
const lib = parse('src/lib/appState.ts');
const typeAlias = name => find(lib, n => ts.isTypeAliasDeclaration(n) && n.name.text === name);
const iface = name => find(lib, n => ts.isInterfaceDeclaration(n) && n.name.text === name);
const members = name => new Map(iface(name).members.map(m => [m.name.text, { optional: !!m.questionToken }]));
const STATES = typeAlias('AppState').type.types.map(t => t.literal.text);

// ── What main.ts sends ───────────────────────────────────────────────────────
const main = parse('electron/main.ts');
const handler = find(main, n => ts.isCallExpression(n)
  && n.expression.getText(main) === 'ipcMain.handle'
  && ts.isStringLiteral(n.arguments[0]) && n.arguments[0].text === 'get-app-state')?.arguments[1];

test('appState.ts holds only types (add tests here if it gains code)', () => {
  const runtime = Object.keys(loadTs('src/lib/appState.ts')).filter(k => k !== '__esModule');
  assert.deepEqual(runtime, [], 'appState.ts now exports values; test them in scripts/app-state.test.mjs');
  assert.deepEqual(STATES, ['first_visit', 'returned_no_data', 'has_data']);
});

test("main.ts still has a 'get-app-state' handler", () => {
  assert.ok(handler, "no ipcMain.handle('get-app-state', ...) in electron/main.ts");
});

test('every state main.ts sends is one the home screen knows', { skip: !handler && 'no handler' }, () => {
  const sent = findAll(handler, n => ts.isBinaryExpression(n)
    && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
    && n.left.getText(main) === 'state' && ts.isStringLiteral(n.right)).map(n => n.right.text);
  assert.ok(sent.length > 0, "found no `state = '...'` in the handler");
  for (const s of sent) assert.ok(STATES.includes(s), `main.ts sends state '${s}', which AppState doesn't list`);
  assert.deepEqual([...new Set(sent)].sort(), [...STATES].sort());
});

test('main.ts sends every AppStateData field, and nothing else', { skip: !handler && 'no handler' }, () => {
  const returned = findAll(handler, n => ts.isReturnStatement(n) && n.expression && ts.isObjectLiteralExpression(n.expression));
  assert.equal(returned.length, 1, 'expected one `return { ... }` in the handler');
  const sent = returned[0].expression.properties.map(p => p.name.getText(main)).sort();
  assert.deepEqual(sent, [...members('AppStateData').keys()].sort());
});

test('RecentSession: the fields every saved session has', () => {
  const required = [...members('RecentSession')].filter(([, m]) => !m.optional).map(([k]) => k);
  assert.deepEqual(required, ['id', 'type', 'name', 'subtitle', 'exportCount', 'lastOpened']);
  // main.ts sorts sessions by lastOpened and counts devices by type
  const text = handler?.getText(main) ?? '';
  assert.match(text, /\.lastOpened/);
  assert.match(text, /s\.type === 'device'/);
  const sessionType = iface('RecentSession').members.find(m => m.name.text === 'type').type;
  assert.deepEqual(sessionType.types.map(t => t.literal.text), ['device', 'case']);
});
