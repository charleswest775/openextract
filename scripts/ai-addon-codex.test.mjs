// Connecting ChatGPT (desktop) to OpenExtract AI (electron/aiAddon.ts): the openextract block
// is added to or replaced in ~/.codex/config.toml (or $CODEX_HOME/config.toml), and every
// other byte of the file stays as it was. Each case here checks the whole file, before and
// after: existing tables, comments, a block already there, no trailing newline, CRLF, a
// byte-order mark, brackets inside strings and arrays, the entry written some other way,
// and the file or its folder missing. The files live in temp folders, never ~/.codex.
// Run with: node --test scripts/ai-addon-codex.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshDir, loadElectronModule } from './test-helpers/electron-env.mjs';

const A = loadElectronModule('aiAddon').module;
const CMD = '/Users/sam/Library/Application Support/OpenExtract AI/program/0.2.0/openextract-ai';
const OLD = '/Users/sam/Library/Application Support/OpenExtract AI/program/0.1.0/openextract-ai';
const BLOCK = [
  '# Added by OpenExtract. Delete these lines to disconnect.',
  '[mcp_servers.openextract]',
  `command = "${CMD}"`,
  'args = []',
  '',
].join('\n');
const crlf = s => s.replace(/\n/g, '\r\n');

function edit(text, command = CMD) {
  const r = A.withCodexBlock(text, command);
  assert.equal(r.ok, true, r.error);
  // Whatever is written reads back as exactly one openextract block running this command.
  assert.deepEqual(A.codexEntry(r.text), { state: 'block', command });
  return r.text;
}

describe('the block', () => {
  test('is exactly the four lines FRIENDS-BUILD.md gives', () => {
    assert.equal(A.codexBlock(CMD), BLOCK);
    assert.equal(A.codexBlock(CMD, '\r\n'), crlf(BLOCK));
  });

  test('a Windows path is escaped so TOML reads it back unchanged', () => {
    const win = 'C:\\Users\\Sam "Q" Lee\\AppData\\Roaming\\OpenExtract AI\\program\\0.2.0\\openextract-ai.exe';
    assert.equal(A.tomlString(win), '"C:\\\\Users\\\\Sam \\"Q\\" Lee\\\\AppData\\\\Roaming\\\\OpenExtract AI\\\\program\\\\0.2.0\\\\openextract-ai.exe"');
    const text = edit('', win);
    assert.deepEqual(A.codexEntry(text), { state: 'block', command: win });
    assert.equal(A.tomlString('tab\there\u0001'), '"tab\\there\\u0001"');
  });
});

describe('adding it', () => {
  test('to an empty file, or to no file: just the block', () => {
    assert.equal(edit(''), BLOCK);
  });

  test('after existing tables and comments, which stay byte for byte', () => {
    const before = [
      '# My Codex settings',
      'model = "o3"  # the good one',
      'approval_policy = "on-request"',
      '',
      '[mcp_servers.github]',
      'command = "npx"',
      'args = ["-y", "@modelcontextprotocol/server-github"]',
      '',
      '[mcp_servers.github.env]',
      'GITHUB_TOKEN = "ghp_x"',
      '',
      '[profiles.fast]',
      'model = "o4-mini"',
      '',
    ].join('\n');
    const after = edit(before);
    assert.equal(after, `${before}\n${BLOCK}`);
  });

  test('to a file with no newline at the end: one is added before the block, nothing else changes', () => {
    assert.equal(edit('model = "o3"'), `model = "o3"\n\n${BLOCK}`);
    assert.equal(edit('[tui]\nnotifications = true'), `[tui]\nnotifications = true\n\n${BLOCK}`);
  });

  test('a file that already ends in a blank line gets no second one', () => {
    assert.equal(edit('model = "o3"\n\n'), `model = "o3"\n\n${BLOCK}`);
  });

  test('a CRLF file gets CRLF lines, and keeps its own', () => {
    const before = crlf('# settings\nmodel = "o3"\n\n[mcp_servers.x]\ncommand = "x"\n');
    const after = edit(before);
    assert.equal(after, `${before}\r\n${crlf(BLOCK)}`);
    assert.doesNotMatch(after.replace(/\r\n/g, ''), /\n/, 'no bare LF');
    // One line and no line break says nothing about which kind the file uses: LF, which ChatGPT reads on Windows too.
    assert.equal(edit('model = "o3"'), `model = "o3"\n\n${BLOCK}`);
    assert.equal(edit(crlf('# a\nmodel = "o3"')), `${crlf('# a\nmodel = "o3"')}\r\n\r\n${crlf(BLOCK)}`);
  });

  test('a byte-order mark stays where it is', () => {
    assert.equal(edit('\ufeffmodel = "o3"\n'), `\ufeffmodel = "o3"\n\n${BLOCK}`);
  });

  test('brackets inside strings, multi-line strings and arrays aren\'t mistaken for tables', () => {
    const before = [
      'instructions = """',
      '[mcp_servers.openextract]',
      'command = "not really"',
      '"""',
      "literal = '''",
      '[also.not.a.table]',
      "'''",
      'nested = [',
      '  ["a", "b"],',
      '  ["c"]',
      ']',
      'inline = { a = "[x]", b = [1, 2] }',
      'quote = "a \\" [mcp_servers.openextract] \\" b"',
      'when = 1979-05-27 07:32:00Z',
      '',
      '[mcp_servers.other]',
      'command = "x"  # [mcp_servers.openextract]',
      '',
    ].join('\n');
    assert.deepEqual(A.codexEntry(before), { state: 'absent' });
    assert.equal(edit(before), `${before}\n${BLOCK}`);
  });
});

describe('replacing it', () => {
  test('the block already right: the file is unchanged', () => {
    const text = `model = "o3"\n\n${BLOCK}`;
    assert.equal(edit(text), text);
    assert.equal(edit(BLOCK), BLOCK);
  });

  test('an older block is replaced in place; what comes before and after stays, the comment isn\'t doubled', () => {
    const top = 'model = "o3"\n\n';
    const old = BLOCK.replace(CMD, OLD);
    const rest = '\n# Work servers\n[mcp_servers.jira]\ncommand = "jira-mcp"\n';
    const after = edit(top + old + rest);
    assert.equal(after, top + BLOCK + rest);
    assert.equal(after.split('Added by OpenExtract').length, 2);
  });

  test('a hand-written block, with other keys and a multi-line array, becomes exactly ours', () => {
    const before = [
      '[mcp_servers.github]',
      'command = "gh"',
      '',
      '# my own note about it',
      '[mcp_servers.openextract] # set up by hand',
      `command = "${OLD}"`,
      'args = [',
      '  "--backups-dir",',
      '  "/Volumes/Backups",',
      ']',
      '# inside the block',
      'startup_timeout_sec = 20',
      '',
      '',
      '# comments above the next table belong to it',
      '[profiles.fast]',
      'model = "o4-mini"',
      '',
    ].join('\n');
    const after = edit(before);
    const expected = [
      '[mcp_servers.github]',
      'command = "gh"',
      '',
      '# my own note about it',
      BLOCK.trimEnd(),
      '',
      '',
      '# comments above the next table belong to it',
      '[profiles.fast]',
      'model = "o4-mini"',
      '',
    ].join('\n');
    assert.equal(after, expected);
  });

  test('the block at the very end with no newline: replaced, still no newline at the end', () => {
    const before = `model = "o3"\n\n[mcp_servers.openextract]\ncommand = "${OLD}"`;
    assert.equal(edit(before), `model = "o3"\n\n${BLOCK.trimEnd()}`);
  });

  test('in a CRLF file, the new block uses CRLF', () => {
    const before = crlf(`a = 1\n\n${BLOCK.replace(CMD, OLD)}\n[b]\nc = 2\n`);
    assert.equal(edit(before), crlf(`a = 1\n\n${BLOCK}\n[b]\nc = 2\n`));
  });

  test('openextract\'s own sub-tables are left alone', () => {
    const before = `${BLOCK.replace(CMD, OLD)}\n[mcp_servers.openextract.env]\nOPENEXTRACT_AI_HOME = "/tmp/x"\n`;
    assert.equal(edit(before), `${BLOCK}\n[mcp_servers.openextract.env]\nOPENEXTRACT_AI_HOME = "/tmp/x"\n`);
  });

  test('a quoted table name is the same table', () => {
    const before = `[mcp_servers."openextract"]\ncommand = "${OLD}"\n`;
    assert.equal(edit(before), BLOCK);
  });

  test('a byte-order mark before the block stays', () => {
    assert.equal(edit(`\ufeff${BLOCK.replace(CMD, OLD)}`), `\ufeff${BLOCK}`);
  });
});

describe('leaving it alone', () => {
  test('openextract written another way: a dotted key, an inline table, twice, or as an array of tables', () => {
    const cases = [
      '[mcp_servers]\nopenextract = { command = "x" }\n',
      '[mcp_servers]\nopenextract.command = "x"\n',
      'mcp_servers.openextract.command = "x"\n',
      'mcp_servers = { github = { command = "gh" } }\n',
      `${BLOCK}\n${BLOCK}`,
      '[[mcp_servers.openextract]]\ncommand = "x"\n',
      `${BLOCK}\n[mcp_servers]\nopenextract.args = ["x"]\n`,
    ];
    for (const text of cases) {
      assert.deepEqual(A.codexEntry(text), { state: 'other' }, text);
      assert.deepEqual(A.withCodexBlock(text, CMD), { ok: false, error: A.CODEX_ERRORS.other }, text);
    }
  });

  test('a file OpenExtract can\'t follow', () => {
    const cases = ['a = "unterminated\n', 'a = """never closed\n', '[broken\n', 'a = [1, 2\n', 'just words\n', '[a] b = 1\n', "a = 'x\n"];
    for (const text of cases) {
      assert.deepEqual(A.codexEntry(text), { state: 'unreadable' }, text);
      assert.deepEqual(A.withCodexBlock(text, CMD), { ok: false, error: A.CODEX_ERRORS.unreadable }, text);
    }
  });

  test('connected = the block is there', () => {
    assert.deepEqual(A.codexEntry(''), { state: 'absent' });
    assert.deepEqual(A.codexEntry(`x = 1\n${BLOCK}`), { state: 'block', command: CMD });
    assert.deepEqual(A.codexEntry('[mcp_servers.openextract]\nargs = []\n'), { state: 'block', command: null });
  });
});

// ── The file itself ─────────────────────────────────────────────────────────

describe('connectCodex', () => {
  test('where the file is: $CODEX_HOME, or ~/.codex', () => {
    const home = path.join(path.sep, 'Users', 'sam');
    assert.equal(A.codexConfigPath({ env: {}, homedir: home }), path.join(home, '.codex', 'config.toml'));
    const codexHome = freshDir('codex-home');
    assert.equal(A.codexConfigPath({ env: { CODEX_HOME: codexHome }, homedir: home }), path.join(codexHome, 'config.toml'));
    assert.equal(A.codexConfigPath({ env: { CODEX_HOME: '  ' }, homedir: home }), path.join(home, '.codex', 'config.toml'));
  });

  test('no folder and no file: both made, the file holding only the block, and no backup', () => {
    const file = path.join(freshDir('home'), '.codex', 'config.toml');
    assert.deepEqual(A.connectCodex(file, CMD), { ok: true, changed: true });
    assert.equal(fs.readFileSync(file, 'utf-8'), BLOCK);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['config.toml']);
  });

  test('a file there: backed up byte for byte first, then changed', () => {
    const dir = freshDir('codex');
    const file = path.join(dir, 'config.toml');
    const before = Buffer.from(crlf('# mine\nmodel = "o3"'), 'utf-8');
    fs.writeFileSync(file, before);
    if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
    assert.deepEqual(A.connectCodex(file, CMD), { ok: true, changed: true });
    assert.ok(fs.readFileSync(path.join(dir, A.CODEX_BACKUP)).equals(before));
    assert.equal(fs.readFileSync(file, 'utf-8'), `${before.toString()}\r\n\r\n${crlf(BLOCK)}`);
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600, 'its permissions are kept');
    assert.deepEqual(fs.readdirSync(dir).sort(), ['config.toml', A.CODEX_BACKUP], 'no temp file left');
  });

  test('already connected: nothing written, no backup', () => {
    const dir = freshDir('codex');
    const file = path.join(dir, 'config.toml');
    fs.writeFileSync(file, `model = "o3"\n\n${BLOCK}`);
    const mtime = fs.statSync(file).mtimeMs;
    assert.deepEqual(A.connectCodex(file, CMD), { ok: true, changed: false });
    assert.equal(fs.statSync(file).mtimeMs, mtime);
    assert.equal(fs.existsSync(path.join(dir, A.CODEX_BACKUP)), false);
  });

  test('a file it can\'t follow, or that isn\'t text, is left exactly as it was, with no backup', () => {
    const dir = freshDir('codex');
    const file = path.join(dir, 'config.toml');
    fs.writeFileSync(file, 'a = "broken\n');
    assert.deepEqual(A.connectCodex(file, CMD), { ok: false, error: A.CODEX_ERRORS.unreadable });
    assert.equal(fs.readFileSync(file, 'utf-8'), 'a = "broken\n');
    const binary = Buffer.from([0x61, 0x20, 0x3d, 0x20, 0x22, 0xff, 0xfe, 0x22, 0x0a]);
    fs.writeFileSync(file, binary);
    assert.deepEqual(A.connectCodex(file, CMD), { ok: false, error: A.CODEX_ERRORS.notText });
    assert.ok(fs.readFileSync(file).equals(binary));
    assert.deepEqual(fs.readdirSync(dir), ['config.toml']);
  });

  test('a config.toml that\'s a link (dotfiles) stays a link; the file it leads to is changed', { skip: process.platform === 'win32' && 'links need admin rights on Windows' }, () => {
    const base = freshDir('codex-link');
    const real = path.join(base, 'dotfiles', 'codex.toml');
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, 'model = "o3"\n');
    const codex = path.join(base, '.codex');
    fs.mkdirSync(codex);
    const link = path.join(codex, 'config.toml');
    fs.symlinkSync(real, link);
    assert.deepEqual(A.connectCodex(link, CMD), { ok: true, changed: true });
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
    assert.equal(fs.readFileSync(real, 'utf-8'), `model = "o3"\n\n${BLOCK}`);
    assert.equal(fs.readFileSync(path.join(codex, A.CODEX_BACKUP), 'utf-8'), 'model = "o3"\n');
  });
});
