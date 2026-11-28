// The Ask AI screen and its ways in (src/lib/askAi.ts, src/components/ai/*): when the header
// entry, the one-time "New" note and the Settings switch show (only with Ask AI on, an AI
// app found and not hidden), what the screen says before anything installs, that nothing
// installs or changes ChatGPT's settings until the person clicks (and says OK), the add-on's
// --status in words, and that none of it is in the save, pay or thanks moments.
// Run with: node --test scripts/ask-ai-screen.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeBridge, loadTs, root } from './test-helpers/load-ts.mjs';

// ── A stand-in for React that keeps state and runs effects (with their deps) between renders ──

function hooksRuntime() {
  let current = null;
  const R = {
    useState(init) {
      const c = current, k = c.i++;
      if (!(k in c.slots)) c.slots[k] = { value: typeof init === 'function' ? init() : init };
      const s = c.slots[k];
      return [s.value, v => { s.value = typeof v === 'function' ? v(s.value) : v; }];
    },
    useEffect(fn, deps) {
      const c = current, k = c.i++;
      const prev = c.slots[k];
      if (prev && deps && prev.deps && deps.length === prev.deps.length && deps.every((d, j) => Object.is(d, prev.deps[j]))) return;
      c.queue.push({ k, fn, deps, cleanup: prev?.cleanup });
    },
  };
  function mount(Component, props = {}) {
    const c = { slots: [], i: 0, queue: [], out: null };
    const render = () => {
      current = c;
      c.i = 0;
      try { c.out = Component(props); } finally { current = null; }
      for (const { k, fn, deps, cleanup } of c.queue.splice(0)) {
        if (typeof cleanup === 'function') cleanup();
        c.slots[k] = { deps, cleanup: fn() };
      }
      return c.out;
    };
    render();
    return { get out() { return c.out; }, rerender: render };
  }
  return { R, mount };
}

/** Calls plain function components (no hooks) so their buttons can be found and clicked. */
function expand(tree) {
  if (tree == null || typeof tree !== 'object') return tree;
  if (Array.isArray(tree)) return tree.map(expand);
  if (typeof tree.type === 'function') return expand(tree.type(tree.props));
  const props = { ...tree.props };
  for (const [k, v] of Object.entries(props)) if (k === 'children' || (v && typeof v === 'object' && v.$$typeof)) props[k] = expand(v);
  return { ...tree, props };
}
function findAll(tree, pick, out = []) {
  if (tree == null || typeof tree !== 'object') return out;
  if (Array.isArray(tree)) { tree.forEach(x => findAll(x, pick, out)); return out; }
  if (pick(tree)) out.push(tree);
  for (const v of Object.values(tree.props ?? {})) if (v && typeof v === 'object') findAll(v, pick, out);
  return out;
}
const text = el => (el == null || typeof el === 'boolean' ? '' : typeof el !== 'object' ? String(el)
  : Array.isArray(el) ? el.map(text).join('') : text(el.props?.children)).trim();
const html = out => (out ? renderToStaticMarkup(out).replaceAll('&#x27;', "'").replaceAll('&quot;', '"') : '');
const buttons = out => findAll(expand(out), el => el.type === 'button');
const button = (out, label) => buttons(out).find(b => text(b) === label || b.props['aria-label'] === label);
const tick = () => new Promise(resolve => setImmediate(resolve));

// Words the app never uses for this: no hype, and nothing that sounds like a licence or a paywall.
const BANNED = /AI-powered|powered by|smart|magic|unlock|revolution|seamless|effortless|supercharge|licen[cs]e|paywall|subscription/i;

// ── States ──────────────────────────────────────────────────────────────────

const OFF = { enabled: false };
const ON = {
  enabled: true, apps: ['claude', 'chatgpt', 'claude-code'], available: true, hidden: false, noteSeen: false,
  installed: null, update: null, claude: { connected: false, version: null, outdated: false },
  chatgpt: { connected: false, current: false, settingsFile: '~/.codex/config.toml' },
  claudeCode: { command: null }, fullDiskAccess: false, edition: null,
};
const COMMAND = 'claude mcp add --scope user openextract -- "/Users/sam/Library/Application Support/OpenExtract AI/program/0.2.0/openextract-ai"';
const INSTALLED = { ...ON, noteSeen: true, installed: { version: '0.2.0' }, claudeCode: { command: COMMAND } };

/**
 * A fake window: the bridge with askAi answering `state`, events (the screen opens through
 * one), and every call recorded. `askAi: false` leaves askAi out of the bridge altogether.
 */
function bridgeFor(t, state, { askAi = true, results = {} } = {}) {
  let current = state;
  let onProgress = null;
  const handlers = { copyText: async () => {}, openExternal: () => {} };
  const bridge = fakeBridge(handlers);
  const events = new EventTarget();
  const opened = [];
  Object.assign(globalThis.window, {
    addEventListener: (...a) => events.addEventListener(...a),
    removeEventListener: (...a) => events.removeEventListener(...a),
    dispatchEvent: e => { opened.push(e.type); return events.dispatchEvent(e); },
  });
  const record = (name, fn) => (...args) => { bridge.calls.push([`askAi.${name}`, ...args]); return fn(...args); };
  if (askAi) {
    bridge.api.askAi = {
      state: record('state', async () => current),
      status: record('status', async () => results.status ?? { ok: false, error: 'no' }),
      install: record('install', () => results.install ?? Promise.resolve({ ok: true })),
      connectClaude: record('connectClaude', () => results.connectClaude ?? Promise.resolve({ ok: true })),
      connectChatGpt: record('connectChatGpt', () => results.connectChatGpt ?? Promise.resolve({ ok: true })),
      setHidden: record('setHidden', async hidden => { if (current.enabled) current = { ...current, hidden }; }),
      noteSeen: record('noteSeen', async () => { if (current.enabled) current = { ...current, noteSeen: true }; }),
      openFullDiskAccess: record('openFullDiskAccess', async () => ({ ok: true })),
      onProgress: record('onProgress', cb => { onProgress = cb; return () => { onProgress = null; }; }),
    };
  }
  t.after(bridge.restore);
  return {
    bridge,
    opened,
    calls: name => bridge.calls.filter(c => c[0] === name),
    progress: p => onProgress?.(p),
    setState: s => { current = s; },
  };
}

async function render(t, file, state, options = {}) {
  const b = bridgeFor(t, state, options);
  const { R, mount } = hooksRuntime();
  const Component = loadTs(file, { stubs: { react: R } }).default;
  const probe = mount(Component, options.props ?? {});
  await tick();
  await tick();
  probe.rerender();
  return { ...b, probe, out: () => probe.out, html: () => html(probe.rerender()) };
}

// ── The rules (src/lib/askAi.ts) ────────────────────────────────────────────

describe('src/lib/askAi.ts', () => {
  const L = loadTs('src/lib/askAi.ts');

  test('the entry and the note need Ask AI on, an AI app found, a download for this computer, and not hidden', () => {
    assert.equal(L.askAiShown(null), false);
    assert.equal(L.askAiShown(OFF), false);
    assert.equal(L.askAiShown(ON), true);
    assert.equal(L.askAiShown({ ...ON, apps: [] }), false);
    assert.equal(L.askAiShown({ ...ON, available: false }), false);
    assert.equal(L.askAiShown({ ...ON, hidden: true }), false);
    assert.equal(L.newNoteShown(ON), true);
    assert.equal(L.newNoteShown({ ...ON, noteSeen: true }), false);
    assert.equal(L.newNoteShown({ ...ON, hidden: true }), false);
    assert.equal(L.newNoteShown(OFF), false);
    // Settings' switch shows hidden or not, so it can be turned back on; never without Ask AI or an app.
    assert.equal(L.settingShown({ ...ON, hidden: true }), true);
    assert.equal(L.settingShown(OFF), false);
    assert.equal(L.settingShown({ ...ON, apps: [] }), false);
  });

  test('the add-on\'s --status in words', () => {
    const s = (left, keys = []) => ({ version: '0.2.4', key: keys[0] ?? null, keys, freeQuestions: 3, freeQuestionsLeft: left });
    assert.equal(L.statusLine(s(3)), '3 of 3 free questions left');
    assert.equal(L.statusLine(s(1)), '1 of 3 free questions left');
    assert.equal(L.statusLine(s(0)), "The 3 free questions have been used. To keep asking about an iPhone, you'll need a key for it.");
    assert.deepEqual(L.statusLines(s(0, [{ name: 'Sarah', kind: 'friends', until: '2027-03-31', phone: null }])), ["Unlimited: Sarah's key"]);
    // The unrestricted edition reports itself as a key of its own kind (openextract-ai's access.py).
    assert.equal(L.statusLine(s(3, [{ name: 'Friends and family', kind: 'unrestricted', until: null, phone: null }])),
      'Unlimited questions: the friends-and-family edition');
    // Bought keys name their iPhone; a week's says its last day; other iPhones still count free questions.
    const phone = { name: 'Sam Lee', kind: 'phone', until: null, phone: 'JN35-Q4HN' };
    const week = { name: 'Sam Lee', kind: 'week', until: '2026-12-04', phone: 'PJAF-B2TD' };
    const lines = L.statusLines(s(2, [phone, week]));
    assert.equal(lines[0], 'Unlimited questions about the iPhone with phone code JN35-Q4HN');
    assert.match(lines[1], /^Unlimited questions about the iPhone with phone code PJAF-B2TD, through December 4$/);
    assert.equal(lines[2], 'Other iPhones: 2 of 3 free questions left');
    assert.equal(L.statusLines(s(0, [phone]))[1], "Other iPhones: the 3 free questions have been used. To keep asking about an iPhone, you'll need a key for it.");
    // An older add-on (before 0.2.4) gives only `key`.
    assert.deepEqual(L.statusLines({ version: '0.2.0', key: phone, keys: [], freeQuestions: 3, freeQuestionsLeft: 3 })[0],
      'Unlimited questions about the iPhone with phone code JN35-Q4HN');
  });

  test('needsKey: no free questions left and no key for any iPhone', () => {
    const s = (left, keys = []) => ({ version: '0.2.4', key: keys[0] ?? null, keys, freeQuestions: 3, freeQuestionsLeft: left });
    assert.equal(L.needsKey(null), false);
    assert.equal(L.needsKey(s(1)), false);
    assert.equal(L.needsKey(s(0)), true);
    assert.equal(L.needsKey(s(0, [{ name: 'S', kind: 'phone', until: null, phone: 'JN35-Q4HN' }])), true, 'other iPhones still need one');
    assert.equal(L.needsKey(s(0, [{ name: 'Sarah', kind: 'friends', until: null, phone: null }])), false);
  });

  test('how to ask, once connected: names the chat apps found', () => {
    assert.equal(L.howToSteps(['claude'])[0], 'Open Claude and start a new chat.');
    assert.equal(L.howToSteps(['claude', 'chatgpt'])[0], 'Open Claude or ChatGPT and start a new chat.');
    assert.equal(L.howToSteps(['claude', 'chatgpt', 'claude-code'])[0], 'Open Claude or ChatGPT and start a new chat (or a new Claude Code session).');
    assert.equal(L.howToSteps(['claude-code'])[0], 'Start a new Claude Code session.');
    assert.match(L.howToSteps(['claude'])[2], /the backup you last opened in OpenExtract/);
    for (const step of L.howToSteps(['claude', 'chatgpt', 'claude-code'])) assert.doesNotMatch(step, BANNED);
  });

  test('the pages it links to are on openextract.app, and the site has them', () => {
    for (const url of [L.AI_PAGE_URL, L.AI_GUIDE_URL, L.AI_BUY_URL]) assert.match(url, /^https:\/\/www\.openextract\.app\/[a-z/-]+$/);
    assert.equal(L.AI_BUY_URL, 'https://www.openextract.app/ai/buy');
    assert.ok(fs.existsSync(path.join(root, 'website', 'static', 'ai', 'buy.html')));
  });

  test('what an install is doing', () => {
    assert.equal(L.progressLine(null), 'Getting ready…');
    assert.equal(L.progressLine({ step: 'index' }), 'Getting ready…');
    assert.equal(L.progressLine({ step: 'download', received: 30_617_284, total: 61_234_567 }), 'Downloading OpenExtract AI… 50% of 61 MB');
    assert.equal(L.progressLine({ step: 'download' }), 'Downloading OpenExtract AI…');
    assert.equal(L.progressLine({ step: 'verify' }), 'Checking the download…');
    assert.equal(L.progressLine({ step: 'unpack' }), 'Unpacking…');
  });

  test('names and companies', () => {
    assert.equal(L.appNames(['claude']), 'Claude');
    assert.equal(L.appNames(['claude', 'chatgpt']), 'Claude and ChatGPT');
    assert.equal(L.appNames(['claude', 'chatgpt', 'claude-code']), 'Claude, ChatGPT and Claude Code');
    assert.equal(L.companiesLine(['claude', 'chatgpt', 'claude-code']), 'Anthropic for Claude and Claude Code, OpenAI for ChatGPT');
    assert.equal(L.companiesLine(['chatgpt']), 'OpenAI for ChatGPT');
  });

  test('the Full Disk Access step: for Claude and ChatGPT only, when the backup is in Finder\'s folder', () => {
    const fda = { ...ON, fullDiskAccess: true };
    assert.deepEqual(L.fullDiskAccessStep('claude', fda), {
      title: "Claude needs Full Disk Access to read backups in Finder's backup folder.",
      text: 'This lets Claude read any file on this Mac. In Settings, turn on Claude under Full Disk Access, then quit Claude and open it again. '
        + "If it's already on, there's nothing to do.",
    });
    assert.match(L.fullDiskAccessStep('chatgpt', fda).title, /^ChatGPT needs Full Disk Access/);
    assert.match(L.fullDiskAccessStep('chatgpt', fda).text, /^This lets ChatGPT read any file on this Mac\./);
    assert.equal(L.fullDiskAccessStep('claude-code', fda), null);
    assert.equal(L.fullDiskAccessStep('claude', ON), null);
  });

  test('the price: 3 questions free, then $29 per iPhone or $9 a week, as the site says; plain words', () => {
    assert.equal(L.PRICE_LINE, '3 questions free. After that, a key for each iPhone: $29 for good, or $9 for a week.');
    // The store's page sells the same two.
    const buy = fs.readFileSync(path.join(root, 'website', 'static', 'ai', 'buy.html'), 'utf-8');
    assert.match(buy, /\$29 <span>once<\/span>/);
    assert.match(buy, /\$9 <span>for 7 days<\/span>/);
    for (const line of [L.PRICE_LINE, L.KEYS_LINE, L.EXAMPLE_QUESTION, L.UNRESTRICTED_LINE, L.UNRESTRICTED_STATUS, L.UNRESTRICTED_NOTE,
      ...L.EXAMPLES.flatMap(e => [e.what, e.ask])]) {
      assert.doesNotMatch(line, BANNED);
    }
  });

  test('one shared state: asked for once, and hiding or seeing the note goes to the main process', async t => {
    const b = bridgeFor(t, ON);
    const M = loadTs('src/lib/askAi.ts');
    const seen = [];
    M.watchAskAi(s => seen.push(s));
    M.watchAskAi(() => {});
    await tick();
    assert.equal(b.calls('askAi.state').length, 1);
    assert.deepEqual(seen, [ON]);
    await M.setAskAiHidden(true);
    assert.equal(M.askAiState().hidden, true);
    assert.deepEqual(b.calls('askAi.setHidden'), [['askAi.setHidden', true]]);
    await M.markNoteSeen();
    await M.markNoteSeen();
    assert.equal(b.calls('askAi.noteSeen').length, 1, 'once');
    M.onOpenAskAi(() => seen.push('open'));
    M.openAskAi();
    assert.equal(seen.at(-1), 'open');
  });

  test('without Ask AI in the bridge, or off, nothing is asked or changed', async t => {
    const none = bridgeFor(t, OFF, { askAi: false });
    const M = loadTs('src/lib/askAi.ts');
    assert.equal(await M.refreshAskAi(), null);
    await M.setAskAiHidden(true);
    await M.markNoteSeen();
    assert.deepEqual(none.bridge.calls, []);

    const off = bridgeFor(t, OFF);
    const N = loadTs('src/lib/askAi.ts');
    assert.deepEqual(await N.refreshAskAi(), OFF);
    await N.markNoteSeen();
    assert.deepEqual(off.calls('askAi.noteSeen'), []);
  });
});

// ── Off: nothing shows anywhere ─────────────────────────────────────────────

describe('a build without Ask AI', () => {
  for (const file of ['src/components/ai/AskAiButton.tsx', 'src/components/ai/AskAiNote.tsx', 'src/components/ai/AskAiSetting.tsx']) {
    test(`${path.basename(file)} draws nothing`, async t => {
      assert.equal((await render(t, file, OFF)).out(), null);
      assert.equal((await render(t, file, OFF, { askAi: false })).out(), null);
      // On, but no AI app on this computer: nothing about AI either.
      assert.equal((await render(t, file, { ...ON, apps: [], claude: null, chatgpt: null, claudeCode: null })).out(), null);
    });
  }
});

// ── The ways in ─────────────────────────────────────────────────────────────

describe('the header entry, the note on Home, and Settings', () => {
  test('Ask AI in the header opens the screen; hidden, it\'s gone', async t => {
    const r = await render(t, 'src/components/ai/AskAiButton.tsx', ON);
    assert.equal(text(r.out()), 'Ask AI');
    r.out().props.onClick();
    assert.deepEqual(r.opened, ['openextract:ask-ai']);
    assert.equal((await render(t, 'src/components/ai/AskAiButton.tsx', { ...ON, hidden: true })).out(), null);
    assert.equal(text((await render(t, 'src/components/ai/AskAiButton.tsx', { ...ON, noteSeen: true })).out()), 'Ask AI', 'the entry stays after the note');
  });

  test('the note: new, what it is and costs; "See how it works" opens the screen and puts the note away', async t => {
    const r = await render(t, 'src/components/ai/AskAiNote.tsx', { ...ON, apps: ['claude', 'chatgpt'] });
    const page = r.html();
    assert.match(page, />New</);
    assert.match(page, /Claude and ChatGPT are on this computer\. With the OpenExtract AI add-on, they can read your backups and answer questions about them\./);
    assert.match(page, /3 questions free\. After that, a key for each iPhone: \$29 for good, or \$9 for a week\./);
    assert.doesNotMatch(page, /friends-and-family/);
    assert.doesNotMatch(page, BANNED);
    button(r.out(), 'See how it works').props.onClick();
    await tick();
    assert.equal(r.calls('askAi.noteSeen').length, 1);
    assert.deepEqual(r.opened, ['openextract:ask-ai']);
    assert.equal(r.probe.rerender(), null);
  });

  test('a copy carrying the unrestricted edition says so in the note, after the price', async t => {
    const page = (await render(t, 'src/components/ai/AskAiNote.tsx', { ...ON, edition: 'unrestricted' })).html();
    assert.match(page, /3 questions free\. After that, a key for each iPhone: \$29 for good, or \$9 for a week\. <span[^>]*>Your copy is the friends-and-family edition, with no limit and no key\.<\/span>/);
    assert.doesNotMatch(page, BANNED);
  });

  test('the note\'s × puts it away for good; "Don\'t show this again" hides Ask AI', async t => {
    const r = await render(t, 'src/components/ai/AskAiNote.tsx', { ...ON, apps: ['claude'] });
    assert.match(r.html(), /Claude is on this computer\. With the OpenExtract AI add-on, it can read/);
    button(r.out(), 'Dismiss').props.onClick();
    assert.equal(r.probe.rerender(), null);
    assert.equal(r.calls('askAi.noteSeen').length, 1);
    assert.equal((await render(t, 'src/components/ai/AskAiNote.tsx', { ...ON, noteSeen: true })).out(), null, 'seen once, never again');

    const h = await render(t, 'src/components/ai/AskAiNote.tsx', ON);
    button(h.out(), "Don't show this again").props.onClick();
    assert.deepEqual(h.calls('askAi.setHidden'), [['askAi.setHidden', true]]);
    assert.equal(h.probe.rerender(), null);
  });

  test('Settings turns it back on (and off)', async t => {
    const r = await render(t, 'src/components/ai/AskAiSetting.tsx', { ...ON, hidden: true });
    assert.match(r.html(), /Show Ask AI on the home screen/);
    const box = () => findAll(expand(r.out()), el => el.type === 'input')[0];
    assert.equal(box().props.checked, false);
    box().props.onChange({ target: { checked: true } });
    assert.equal(r.probe.rerender() && box().props.checked, true);
    box().props.onChange({ target: { checked: false } });
    assert.deepEqual(r.calls('askAi.setHidden'), [['askAi.setHidden', false], ['askAi.setHidden', true]]);
  });
});

// ── The screen ──────────────────────────────────────────────────────────────

describe('the Ask AI screen', () => {
  const SCREEN = 'src/components/ai/AskAiScreen.tsx';

  test('before anything installs: what it does, what you can ask, the price, where the data goes, read-only, no passwords', async t => {
    const r = await render(t, SCREEN, ON, { props: { onBack: () => {} } });
    const page = r.html();
    assert.match(page, /It lets them read your iPhone backups on this computer\s+\(messages, WhatsApp, calls, voicemail, contacts, notes, calendar and photos\) and answer your questions about them, pointing to what it used\./);
    assert.match(page, /What you can ask/);
    assert.match(page, /“What was the gate code Dana texted me last summer\?”/);
    assert.match(page, /“Show me the photos from the day Leo learned to ride his bike\.”/);
    assert.match(page, /3 questions free\. After that, a key for each iPhone: \$29 for good, or \$9 for a week\./);
    assert.match(page, /When the free questions run out, the AI gives you a link to buy a key for the iPhone you asked about\. OpenExtract itself stays free, with no limits\./);
    assert.doesNotMatch(page, /Charles West/, 'keys come from the store now, not by hand');
    assert.match(page, /What the AI reads goes to that AI's company: Anthropic for Claude and Claude Code, OpenAI for ChatGPT\./);
    assert.match(page, /It only reads your backups\. It never changes them\./);
    assert.match(page, /Passwords never go to the AI\./);
    assert.match(page, /Once it's connected/);
    assert.match(page, /Open Claude or ChatGPT and start a new chat \(or a new Claude Code session\)\./);
    assert.match(page, /It reads the backup you last opened in OpenExtract\./);
    assert.doesNotMatch(page, BANNED);
    // One card per app, each with its own action and state
    assert.deepEqual(buttons(r.out()).map(text).filter(l => ['Install', 'Connect'].includes(l)), ['Install', 'Connect', 'Install']);
    assert.match(page, /Not installed/);
    assert.match(page, /Not connected/);
    // Opening it puts the note away; nothing is installed, connected or run by opening it.
    assert.equal(r.calls('askAi.noteSeen').length, 1);
    for (const name of ['install', 'connectClaude', 'connectChatGpt', 'status']) assert.deepEqual(r.calls(`askAi.${name}`), [], name);
  });

  test('a copy carrying the unrestricted edition still shows the price, then says theirs needs none of it', async t => {
    const page = (await render(t, SCREEN, { ...ON, edition: 'unrestricted' }, { props: { onBack: () => {} } })).html();
    assert.match(page, /3 questions free\. After that, a key for each iPhone: \$29 for good, or \$9 for a week\..*OpenExtract itself stays free, with no limits\..*Your copy is the friends-and-family edition: your questions are unlimited and you won't need a key\./s);
    assert.doesNotMatch(page, BANNED);
    const usual = (await render(t, SCREEN, ON, { props: { onBack: () => {} } })).html();
    assert.doesNotMatch(usual, /friends-and-family edition/);
  });

  test('Claude: Install shows progress, then says to click Install in Claude\'s own window', async t => {
    let finish;
    const r = await render(t, SCREEN, ON, { props: { onBack: () => {} }, results: { connectClaude: new Promise(res => { finish = res; }) } });
    button(r.out(), 'Install').props.onClick();
    r.progress({ step: 'download', received: 30_617_284, total: 61_234_567 });
    assert.match(r.html(), /Downloading OpenExtract AI… 50% of 61 MB/);
    assert.ok(buttons(r.out()).filter(b => ['Install', 'Connect'].includes(text(b))).every(b => b.props.disabled), 'one thing at a time');
    finish({ ok: true });
    await tick();
    await tick();
    assert.match(r.html(), /Claude is showing its own Install window\. Click Install there, then come back here\./);
    assert.equal(r.calls('askAi.connectClaude').length, 1);
    const before = r.calls('askAi.state').length;
    button(r.out(), 'Check again').props.onClick();
    await tick();
    assert.ok(r.calls('askAi.state').length > before);
  });

  test('ChatGPT: Connect asks first; only "Add it" changes the settings file', async t => {
    const r = await render(t, SCREEN, ON, { props: { onBack: () => {} } });
    button(r.out(), 'Connect').props.onClick();
    let page = r.html();
    assert.match(page, /This adds one entry to ChatGPT's settings file\./);
    assert.match(page, /The file is ~\/\.codex\/config\.toml\. A copy of it as it is now is kept beside it, named config\.toml\.openextract-backup\./);
    assert.deepEqual(r.calls('askAi.connectChatGpt'), []);
    button(r.out(), 'Cancel').props.onClick();
    assert.doesNotMatch(r.html(), /This adds one entry/);
    assert.deepEqual(r.calls('askAi.connectChatGpt'), []);

    button(r.out(), 'Connect').props.onClick();
    r.probe.rerender();
    button(r.out(), 'Add it').props.onClick();
    await tick();
    await tick();
    assert.deepEqual(r.calls('askAi.connectChatGpt'), [['askAi.connectChatGpt', true]]);
    page = r.html();
    assert.match(page, /Done\. Quit ChatGPT and open it again to use OpenExtract AI\./);
  });

  test('a failure says what went wrong, in the app\'s card', async t => {
    const r = await render(t, SCREEN, ON, { props: { onBack: () => {} }, results: { connectChatGpt: Promise.resolve({ ok: false, error: "Couldn't reach the OpenExtract AI download. Check your internet connection and try again." }) } });
    button(r.out(), 'Connect').props.onClick();
    r.probe.rerender();
    button(r.out(), 'Add it').props.onClick();
    await tick();
    await tick();
    assert.match(r.html(), /Couldn't reach the OpenExtract AI download\. Check your internet connection and try again\./);
  });

  test('installed: the add-on\'s own count, and Claude Code\'s command to copy', async t => {
    const sarah = { name: 'Sarah', kind: 'friends', until: '2027-03-31', phone: null };
    const r = await render(t, SCREEN, { ...INSTALLED, claude: { connected: true, version: '0.2.0', outdated: false } }, {
      props: { onBack: () => {} },
      results: { status: { ok: true, status: { version: '0.2.0', key: sarah, keys: [sarah], freeQuestions: 3, freeQuestionsLeft: 0 } } },
    });
    await tick();
    const page = r.html();
    assert.equal(r.calls('askAi.status').length, 1, 'asked once');
    assert.match(page, /OpenExtract AI 0\.2\.0 is installed/);
    assert.match(page, /Unlimited: Sarah's key/);
    assert.match(page, /Connected/);
    assert.ok(page.includes(COMMAND));
    button(r.out(), 'Copy the command').props.onClick();
    await tick();
    assert.deepEqual(r.calls('copyText'), [['copyText', COMMAND]]);
    assert.ok(button(r.probe.rerender(), 'Copied'));
  });

  test('free questions left, from the add-on', async t => {
    const r = await render(t, SCREEN, INSTALLED, {
      props: { onBack: () => {} },
      results: { status: { ok: true, status: { version: '0.2.0', key: null, keys: [], freeQuestions: 3, freeQuestionsLeft: 2 } } },
    });
    await tick();
    assert.match(r.html(), /2 of 3 free questions left/);
    assert.equal(button(r.out(), 'Buy a key'), undefined, 'nothing to buy while free questions are left');
  });

  test('free questions used up: "Buy a key" opens the store in the browser', async t => {
    const r = await render(t, SCREEN, INSTALLED, {
      props: { onBack: () => {} },
      results: { status: { ok: true, status: { version: '0.2.4', key: null, keys: [], freeQuestions: 3, freeQuestionsLeft: 0 } } },
    });
    await tick();
    assert.match(r.html(), /The 3 free questions have been used\./);
    button(r.out(), 'Buy a key').props.onClick();
    assert.deepEqual(r.calls('openExternal'), [['openExternal', 'https://www.openextract.app/ai/buy']]);
  });

  test('the guide and the product page open in the browser', async t => {
    const r = await render(t, SCREEN, ON, { props: { onBack: () => {} } });
    button(r.out(), 'How to set it up and use it').props.onClick();
    button(r.out(), 'About OpenExtract AI').props.onClick();
    assert.deepEqual(r.calls('openExternal'), [
      ['openExternal', 'https://www.openextract.app/use-cases/ask-claude-about-your-iphone-backup'],
      ['openExternal', 'https://www.openextract.app/ai'],
    ]);
  });

  test('this copy carries a newer add-on: Update in the installed row, and in Claude\'s card when Claude has an older one', async t => {
    const state = { ...INSTALLED, installed: { version: '0.2.4' }, update: { version: '0.3.0' }, claude: { connected: true, version: '0.2.4', outdated: true } };
    const r = await render(t, SCREEN, state, { props: { onBack: () => {} } });
    const page = r.html();
    assert.match(page, /OpenExtract AI 0\.3\.0 came with this version of OpenExtract\./);
    assert.match(page, /Connected, with an older version \(0\.2\.4\)/);
    const updates = buttons(r.out()).filter(b => text(b) === 'Update');
    assert.equal(updates.length, 3, 'the installed row, Claude, Claude Code');
    updates[0].props.onClick();
    await tick();
    await tick();
    assert.equal(r.calls('askAi.install').length, 1);
    assert.match(r.html(), /Updated\. Each app below says if it needs a step too\./);
    buttons(r.out()).filter(b => text(b) === 'Update')[1].props.onClick();
    await tick();
    await tick();
    assert.equal(r.calls('askAi.connectClaude').length, 1);
    assert.match(r.html(), /Click Install there to update OpenExtract AI, then start a new chat\./);
  });

  test('a backup in Finder\'s folder on a Mac: Claude and ChatGPT show the Full Disk Access step; Open Settings asks main', async t => {
    const r = await render(t, SCREEN, { ...ON, fullDiskAccess: true }, { props: { onBack: () => {} } });
    const page = r.html();
    assert.match(page, /Claude needs Full Disk Access to read backups in Finder's backup folder\./);
    assert.match(page, /This lets Claude read any file on this Mac\./);
    assert.match(page, /ChatGPT needs Full Disk Access to read backups in Finder's backup folder\./);
    assert.match(page, /This lets ChatGPT read any file on this Mac\./);
    assert.doesNotMatch(page, /Claude Code needs/);
    assert.doesNotMatch(page, BANNED);
    const open = buttons(r.out()).filter(b => text(b) === 'Open Settings');
    assert.equal(open.length, 2);
    open[0].props.onClick({ target: 'anything the page has' });
    assert.deepEqual(r.calls('askAi.openFullDiskAccess'), [['askAi.openFullDiskAccess']], 'no address comes from the window');

    const elsewhere = await render(t, SCREEN, ON, { props: { onBack: () => {} } });
    assert.doesNotMatch(elsewhere.html(), /Full Disk Access/);
    assert.equal(buttons(elsewhere.out()).filter(b => text(b) === 'Open Settings').length, 0);
  });

  test('"Don\'t show this again" hides Ask AI and goes back Home', async t => {
    let back = 0;
    const r = await render(t, SCREEN, ON, { props: { onBack: () => { back++; } } });
    button(r.out(), "Don't show this again").props.onClick();
    assert.deepEqual(r.calls('askAi.setHidden'), [['askAi.setHidden', true]]);
    assert.ok(back >= 1);
    assert.match(r.html(), /You can turn Ask AI back on in Settings/);
  });
});

// ── Where it is, and where it never is ──────────────────────────────────────

describe('wiring', () => {
  const read = rel => fs.readFileSync(path.join(root, rel), 'utf-8');

  test('the entry is in the home screen\'s header, the note on Home (not the first-run welcome), the switch in Settings', () => {
    assert.match(read('src/components/shared/AppHeader.tsx'), /<AskAiButton \/>/);
    assert.match(read('src/components/home/WorkspaceView.tsx'), /<AskAiNote \/>/);
    assert.match(read('src/components/home/ReturnedView.tsx'), /<AskAiNote \/>/);
    assert.doesNotMatch(read('src/components/home/FirstVisitView.tsx'), /AskAi/);
    assert.match(read('src/components/shared/SettingsDialog.tsx'), /<AskAiSetting \/>/);
    const app = read('src/App.tsx');
    assert.match(app, /onOpenAskAi\(\(\) => setScreen\('ask-ai'\)\)/);
    assert.match(app, /screen === 'ask-ai' && <AskAiScreen/);
  });

  test('never in the save, pay or thanks moments', () => {
    const app = read('src/App.tsx');
    const stack = app.slice(app.indexOf('{/* Bottom-right notices'), app.indexOf('</div>', app.indexOf('{/* Bottom-right notices')));
    assert.match(stack, /PayItForwardPrompt/);
    assert.doesNotMatch(stack, /AskAi/);
    for (const file of ['src/components/shared/PayItForwardPrompt.tsx', 'src/components/shared/BusinessUsePrompt.tsx', 'src/components/shared/ExportCheckPrompt.tsx',
      'src/components/shared/Feedback.tsx', 'src/components/shared/SaveDialog.tsx', 'src/components/explore/ExportPanel.tsx', 'src/hooks/useSaveAction.ts']) {
      assert.doesNotMatch(read(file), /askAi|AskAi|ask-ai/, file);
    }
  });

  test('the renderer never reaches the add-on, the network or the disk itself: only the bridge', () => {
    for (const file of fs.readdirSync(path.join(root, 'src/components/ai')).map(f => `src/components/ai/${f}`).concat(['src/lib/askAi.ts', 'src/hooks/useAskAi.ts'])) {
      const src = read(file);
      assert.doesNotMatch(src, /\bfetch\(|XMLHttpRequest|require\(|from 'fs'|from 'node:/, file);
    }
  });
});
