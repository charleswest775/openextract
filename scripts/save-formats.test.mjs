// Keeps every Save dialog's formats consistent (src/components/shared/SaveDialog.tsx):
// each list is made of FORMATS entries only, never an inline { id, label, detail } object;
// the kind's own format (original files, audio, contact cards, podcast subscriptions, the
// data bundle) comes first when it has one, then the core formats in one fixed order, PDF ·
// web page · spreadsheet · plain text; nothing offers Markdown; and each screen offers what
// it can make. Read from the source, so a new screen or list is checked as soon as it's written.
// Run with: node --test scripts/save-formats.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf-8');
const SAVE_DIALOG = 'src/components/shared/SaveDialog.tsx';

// A kind's own format comes first, then the core formats in this order.
const NATIVE = ['originals', 'audio', 'vcf', 'opml', 'bundle'];
const CORE = ['pdf', 'html', 'csv', 'txt'];

/** Every .ts/.tsx file under src/components, as paths from the repo root. */
function componentFiles(dir = 'src/components') {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap(e => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return componentFiles(rel);
    return /\.tsx?$/.test(e.name) ? [rel] : [];
  });
}

/** The text from `open` (an index of "{" or "[") to its matching close, brackets inside strings ignored. */
function balanced(src, open) {
  const pairs = { '{': '}', '[': ']', '(': ')' };
  const stack = [];
  let quote = null;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === '\\') i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') quote = c;
    else if (pairs[c]) stack.push(pairs[c]);
    else if (c === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return src.slice(open, i + 1);
    }
  }
  throw new Error(`unbalanced brackets from ${src.slice(open, open + 60)}`);
}

/**
 * Every format list in a file, in source order: `formats={…}` props and `formats: […]`
 * properties. A list is the ids it names (RECORD_FORMATS is the core four), or a string
 * saying why it can't be read. A prop that hands on another list (`choosing.formats`) is
 * skipped: the list it comes from is a `formats: […]` property, checked itself.
 */
function formatLists(src) {
  const lists = [];
  const readList = (expr, where) => {
    const trimmed = expr.trim();
    if (trimmed === 'RECORD_FORMATS') return lists.push({ where, ids: [...CORE] });
    if (/^[a-z]\w*\.formats$/i.test(trimmed)) return undefined;
    const arrays = [...trimmed.matchAll(/\[([^[\]]*)\]/g)].map(m => m[1]);
    if (arrays.length === 0) return lists.push({ where, error: `can't read the list: ${trimmed.slice(0, 80)}` });
    // A choice between lists (`followed ? [opml, csv] : [csv]`): each must hold
    for (const body of arrays) {
      const items = body.split(',').map(s => s.trim()).filter(Boolean);
      const bad = items.filter(item => !/^FORMATS\.[a-z]+$/.test(item));
      if (bad.length) lists.push({ where, error: `not a FORMATS entry: ${bad.join(', ')}` });
      else lists.push({ where, ids: items.map(item => item.slice('FORMATS.'.length)) });
    }
    return undefined;
  };
  for (const m of src.matchAll(/\bformats=\{/g)) {
    const at = m.index + m[0].length - 1;
    readList(balanced(src, at).slice(1, -1), `line ${src.slice(0, m.index).split('\n').length}`);
  }
  for (const m of src.matchAll(/\bformats: (\[)/g)) {
    readList(balanced(src, m.index + m[0].length - 1), `line ${src.slice(0, m.index).split('\n').length}`);
  }
  return lists.sort((a, b) => Number(a.where.slice(5)) - Number(b.where.slice(5)));
}

/** Why a list breaks the rule, or null when it keeps it. */
function orderProblem(ids, known) {
  const unknown = ids.filter(id => !known.includes(id));
  if (unknown.length) return `${unknown.join(', ')} isn't in FORMATS`;
  if (new Set(ids).size !== ids.length) return 'a format is listed twice';
  const natives = ids.filter(id => NATIVE.includes(id));
  if (natives.length > 1) return `more than one kind's own format: ${natives.join(', ')}`;
  if (natives.length === 1 && ids[0] !== natives[0]) return `${natives[0]} must come first`;
  const core = ids.filter(id => CORE.includes(id));
  const ordered = [...core].sort((a, b) => CORE.indexOf(a) - CORE.indexOf(b));
  if (core.join() !== ordered.join()) return `the core formats must be in the order ${CORE.join(', ')}, not ${core.join(', ')}`;
  return null;
}

const saveDialog = read(SAVE_DIALOG);
const formatsBlock = balanced(saveDialog, saveDialog.indexOf('{', saveDialog.indexOf('export const FORMATS =')));
const FORMAT_KEYS = [...formatsBlock.matchAll(/^ {2}([a-z]+): \{\s*id: '([a-z]+)'/gm)].map(m => [m[1], m[2]]);
const KNOWN = FORMAT_KEYS.map(([key]) => key);

test('FORMATS: each entry\'s id is its name, and each is a core or a kind\'s own format', () => {
  assert.ok(FORMAT_KEYS.length >= 9, `could not read FORMATS from ${SAVE_DIALOG}`);
  for (const [key, id] of FORMAT_KEYS) assert.equal(id, key, `FORMATS.${key} has id '${id}'`);
  assert.deepEqual([...KNOWN].sort(), [...CORE, ...NATIVE].sort(),
    'a new format must be added to CORE or NATIVE in scripts/save-formats.test.mjs, so the order rule knows where it goes');
  assert.ok(!/\bmd\b|markdown/i.test(formatsBlock), 'Markdown is not a format');
});

test('RECORD_FORMATS is PDF, web page, spreadsheet, plain text, in that order', () => {
  const m = saveDialog.match(/export const RECORD_FORMATS[^=]*= \[([^\]]*)\]/);
  assert.ok(m, `no RECORD_FORMATS in ${SAVE_DIALOG}`);
  assert.deepEqual(m[1].split(',').map(s => s.trim()), CORE.map(id => `FORMATS.${id}`));
});

test('every format list on every screen uses FORMATS entries, in the fixed order', () => {
  const problems = [];
  let checked = 0;
  for (const file of componentFiles()) {
    if (file === SAVE_DIALOG) continue;
    for (const list of formatLists(read(file))) {
      checked++;
      const problem = list.error ?? orderProblem(list.ids, KNOWN);
      if (problem) problems.push(`${file} ${list.where}: ${problem}`);
    }
  }
  assert.ok(checked >= 15, `only ${checked} format lists found: has the way screens list formats changed?`);
  assert.deepEqual(problems, []);
});

/** A JSX opening tag from its "<" to its ">", skipping over {expressions} (which may hold "=>" or "a > b"). */
function openingTag(src, at) {
  for (let i = at; i < src.length; i++) {
    if (src[i] === '{') i += balanced(src, i).length - 1;
    else if (src[i] === '>') return src.slice(at, i + 1);
  }
  throw new Error(`unclosed tag at ${src.slice(at, at + 40)}`);
}

test('every Save dialog is given its formats', () => {
  let dialogs = 0;
  for (const file of componentFiles()) {
    if (file === SAVE_DIALOG) continue;
    const src = read(file);
    for (const m of src.matchAll(/<SaveDialog\b/g)) {
      dialogs++;
      assert.match(openingTag(src, m.index), /\sformats=\{/, `${file}: a <SaveDialog> without formats=`);
    }
  }
  assert.ok(dialogs >= 10, `only ${dialogs} Save dialogs found`);
});

test('no inline format objects and no Markdown anywhere a save is made', () => {
  const inline = /\{\s*id:\s*['"][\w-]+['"],\s*label:\s*['"`][^'"`]*['"`],\s*detail:/;
  for (const file of componentFiles()) {
    if (file === SAVE_DIALOG) continue;
    const src = read(file);
    assert.ok(!inline.test(src), `${file}: an inline { id, label, detail } format; use FORMATS`);
    assert.ok(!/markdown|'md'|"md"/i.test(src), `${file}: offers Markdown`);
  }
  for (const file of ['src/lib/timelineExport.ts', 'src/lib/saveData.ts']) {
    assert.ok(!/markdown|'md'|"md"/i.test(read(file)), `${file}: still writes Markdown`);
  }
});

// What each screen can make (contract C3 of the People view fix). The Save to this computer
// panel's lists are checked against the e2e suite's PANEL_EXPORTS by scripts/e2e-coverage.test.mjs.
const SCREENS = {
  'src/components/explore/MessageExplorer.tsx': [CORE, CORE], // one conversation or chat; several
  'src/components/people/PeopleView.tsx': [CORE],
  'src/components/timeline/TimelineView.tsx': [CORE],
  'src/components/explore/RecordRecoveryView.tsx': [CORE],
  'src/components/explore/NoteExplorer.tsx': [['pdf', 'html', 'txt']],
  'src/components/explore/CallExplorer.tsx': [CORE],
  'src/components/explore/BrowserHistoryExplorer.tsx': [CORE],
  'src/components/explore/ContactExplorer.tsx': [['vcf', 'csv']],
  // Subscriptions only when a followed show has a feed
  'src/components/explore/PodcastExplorer.tsx': [['opml', 'csv'], ['csv']],
};

test('each screen offers the formats it can make', () => {
  for (const [file, want] of Object.entries(SCREENS)) {
    const got = formatLists(read(file)).map(l => l.ids ?? l.error);
    assert.deepEqual(got, want, file);
  }
});

test('the Save to this computer panel: Notes in one file as PDF, web page or text; calls and web history in every core format', () => {
  const src = read('src/components/explore/ExportPanel.tsx');
  const kinds = {};
  for (const m of src.matchAll(/id: '([a-z_]+)', label:[\s\S]*?formats: \[([^\]]*)\]/g)) {
    kinds[m[1]] = [...m[2].matchAll(/FORMATS\.([a-z]+)/g)].map(f => f[1]);
  }
  assert.deepEqual(kinds.notes, ['pdf', 'html', 'txt']);
  for (const kind of ['messages', 'whatsapp', 'calls', 'browser_history']) assert.deepEqual(kinds[kind], CORE, kind);
  assert.match(src, /formats=\{\[FORMATS\.bundle\]\}/);
});

test('the rule itself: what it lets through and what it stops', () => {
  const lists = src => formatLists(src).map(l => l.ids ?? l.error);
  assert.deepEqual(lists('<SaveDialog formats={RECORD_FORMATS} />'), [CORE]);
  assert.deepEqual(lists('<SaveDialog formats={x ? [FORMATS.opml, FORMATS.csv] : [FORMATS.csv]} />'), [['opml', 'csv'], ['csv']]);
  assert.deepEqual(lists("{ id: 'a', label: 'A', formats: [FORMATS.pdf,\n FORMATS.txt], }"), [['pdf', 'txt']]);
  assert.deepEqual(lists('<SaveDialog formats={choosing.formats} />'), []);
  assert.match(lists("<SaveDialog formats={[FORMATS.html, { id: 'md', label: 'Markdown', detail: 'x' }]} />")[0], /not a FORMATS entry/);
  assert.match(lists('<SaveDialog formats={SOME_LIST} />')[0], /can't read the list/);
  assert.equal(orderProblem(['vcf', 'csv'], KNOWN), null);
  assert.equal(orderProblem(['pdf', 'html', 'txt'], KNOWN), null);
  assert.match(orderProblem(['html', 'pdf', 'csv', 'txt'], KNOWN), /order pdf, html, csv, txt/);
  assert.match(orderProblem(['csv', 'vcf'], KNOWN), /vcf must come first/);
  assert.match(orderProblem(['opml', 'audio'], KNOWN), /more than one/);
  assert.match(orderProblem(['pdf', 'pdf'], KNOWN), /twice/);
  assert.match(orderProblem(['md'], KNOWN), /isn't in FORMATS/);
});
