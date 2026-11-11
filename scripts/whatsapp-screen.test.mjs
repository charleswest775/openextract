// Tests for the WhatsApp screen's components (src/components/explore/
// MessageExplorer, WhatsAppExplorer, WhatsAppAttachment, ChatBubble, BackupHome):
// which chats the list keeps while searching, the engine's whole-store search
// past the index's limit, how a copied file is handed to the computer, the
// hooks that outlive an await, the photo viewer's focus, and what screen
// readers hear. Components render with react-dom/server for their markup;
// hooks run in a small stand-in for React (below) that can mount, unmount and
// mount again the way StrictMode does in development. Data is fictional.
// Run with: node --test scripts/whatsapp-screen.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { fakeBridge, loadTs } from './test-helpers/load-ts.mjs';

const wa = loadTs('src/lib/whatsapp.ts');
const { parseQuery } = loadTs('src/lib/search.ts');

// ── A stand-in for React's hooks ─────────────────────────────────────────────
// Enough to run a component or hook function: state and refs kept between
// renders, effects run after a render and cleaned up on unmount. Elements are
// React's own (react/jsx-runtime isn't replaced). Host elements in the output
// get stand-in DOM nodes (focus, contains, querySelectorAll('button…')), and
// refs on them are filled in before effects run, as React DOM does.

function hooksRuntime() {
  let current = null;
  const R = {
    useState(init) {
      const c = current, k = c.i++;
      if (!(k in c.slots)) c.slots[k] = { value: typeof init === 'function' ? init() : init };
      const s = c.slots[k];
      return [s.value, v => { s.value = typeof v === 'function' ? v(s.value) : v; }];
    },
    useRef(init) {
      const c = current, k = c.i++;
      if (!(k in c.slots)) c.slots[k] = { current: init };
      return c.slots[k];
    },
    useEffect(fn, deps) {
      const c = current, k = c.i++;
      const prev = c.slots[k];
      if (prev && deps && prev.deps && deps.length === prev.deps.length && deps.every((d, j) => Object.is(d, prev.deps[j]))) return;
      c.queue.push({ k, fn, deps });
    },
    useMemo: fn => fn(),
    useCallback: fn => fn,
  };

  function mount(Component, props, { strict = false } = {}) {
    const c = { slots: [], i: 0, queue: [], props, out: null, nodes: [] };
    const render = () => {
      current = c;
      c.i = 0;
      try { c.out = Component(c.props); } finally { current = null; }
      c.nodes = attach(c.out);
      const queue = c.queue;
      c.queue = [];
      for (const { k, fn, deps } of queue) {
        c.slots[k]?.cleanup?.();
        c.slots[k] = { deps, cleanup: fn() };
      }
      return queue;
    };
    const ran = render();
    if (strict) {
      // React 18 StrictMode in development: effects are torn down and set up again, state and refs kept
      for (const { k } of ran) c.slots[k].cleanup?.();
      for (const { k, fn, deps } of ran) c.slots[k] = { deps, cleanup: fn() };
    }
    return {
      get out() { return c.out; },
      get nodes() { return c.nodes; },
      rerender() { render(); return c.out; },
      unmount() { for (const s of c.slots) if (s && 'cleanup' in s) s.cleanup?.(); },
    };
  }
  return { R, mount };
}

/** Stand-in DOM nodes for the host elements in a tree, with refs pointed at them. */
function attach(tree) {
  const all = [];
  const walk = (el, parent) => {
    if (el == null || typeof el !== 'object') return;
    if (Array.isArray(el)) { el.forEach(x => walk(x, parent)); return; }
    let node = parent;
    if (typeof el.type === 'string') {
      node = fakeNode(el, parent);
      all.push(node);
      if (el.ref && typeof el.ref === 'object') el.ref.current = node;
    }
    walk(el.props?.children, node);
  };
  walk(tree, null);
  return all;
}

function fakeNode(el, parent) {
  const node = {
    tag: el.type, props: el.props, parent, children: [], isConnected: true,
    focus() { globalThis.document.activeElement = node; },
    contains(other) { for (let n = other; n; n = n.parent) if (n === node) return true; return false; },
    querySelectorAll() {
      const out = [];
      const visit = n => { for (const k of n.children) { if (k.tag === 'button' && !k.props.disabled) out.push(k); visit(k); } };
      visit(node);
      return out;
    },
  };
  parent?.children.push(node);
  return node;
}

/** The first element in a tree that passes `test`. */
function find(tree, test) {
  if (tree == null || typeof tree !== 'object') return null;
  if (Array.isArray(tree)) {
    for (const x of tree) { const f = find(x, test); if (f) return f; }
    return null;
  }
  if (test(tree)) return tree;
  return find(tree.props?.children, test);
}

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise(r => setTimeout(r, 0));

// ── The chat list while searching ────────────────────────────────────────────

function waEntry(id, chat, msg = {}) {
  return {
    id: `whatsapp:${id}`, type: 'whatsapp', timestamp: '2025-03-03T10:00:00Z', title: '', subtitle: '',
    contactName: chat.display_name,
    contactIdentifier: chat.chat_type === 'individual' ? chat.handle || null : chat.chat_identifier,
    whatsapp: {
      text: msg.text ?? null, isFromMe: false, sender: msg.sender ?? '', messageType: msg.messageType ?? 'text',
      eventText: null, attachmentLabel: msg.attachmentLabel ?? null, conversationName: chat.display_name,
      chatId: chat.chat_id, chatType: chat.chat_type, isGroup: chat.chat_type === 'group', sort: id, call: null,
    },
  };
}

const chat = (chat_id, display_name, chat_type, handle, chat_identifier) => ({
  chat_id, display_name, chat_type, handle, chat_identifier, service: 'WhatsApp', message_count: 10,
  last_message_date: '2025-03-03T10:00:00Z', last_message_preview: '', is_group: chat_type === 'group', archived: false,
});
const RILEY = chat(3, 'Riley Park', 'individual', '+15035550190', '15035550190@s.whatsapp.net');
const CLUB = chat(4, 'Book club', 'group', '', '120363000000000001@g.us');
const CHATS = [RILEY, CLUB];

test('a group message found by its sender opens in the group and stays there (search result → WhatsApp)', () => {
  const me = loadTs('src/components/explore/MessageExplorer.tsx');
  const { WHATSAPP_SOURCE } = loadTs('src/components/explore/WhatsAppExplorer.tsx');
  // A captionless photo Riley sent to the book club: the whole-backup search finds it on "riley"
  const entries = [waEntry(101, CLUB, { sender: 'Riley Park', messageType: 'image', attachmentLabel: 'Photo' })];
  const query = 'riley';
  const hitsByChat = WHATSAPP_SOURCE.hitsByChat(entries, parseQuery(query));
  const opts = { query, hitsByChat, listMatchFields: WHATSAPP_SOURCE.listMatchFields, keptChat: null, minMessageCount: 0, activeSince: '' };
  const visible = me.visibleChats(CHATS, opts);
  assert.deepEqual(visible.map(c => c.chat_id), [3, 4], 'the group has a match, Riley\'s own chat matches by name');
  assert.equal(me.chatAfterSearch(visible, CLUB.chat_id, query), null, 'opened on the group: stays on the group');
});

test('the chat opened from a search result stays in the list until the search changes, even with no match yet', () => {
  const me = loadTs('src/components/explore/MessageExplorer.tsx');
  const { WHATSAPP_SOURCE } = loadTs('src/components/explore/WhatsAppExplorer.tsx');
  // The index hasn't read the book club yet: no hits anywhere
  const base = { query: 'riley', hitsByChat: new Map(), listMatchFields: WHATSAPP_SOURCE.listMatchFields, minMessageCount: 0, activeSince: '' };
  const kept = me.visibleChats(CHATS, { ...base, keptChat: CLUB.chat_id });
  assert.deepEqual(kept.map(c => c.chat_id), [3, 4]);
  assert.equal(me.chatAfterSearch(kept, CLUB.chat_id, 'riley'), null);
  // Once the person searches for something else, it's an ordinary chat again
  const notKept = me.visibleChats(CHATS, { ...base, keptChat: null });
  assert.deepEqual(notKept.map(c => c.chat_id), [3]);
  assert.equal(me.chatAfterSearch(notKept, CLUB.chat_id, 'riley'), 3, 'a search that hides the open chat opens the first match');
  // The filters still apply to it
  assert.deepEqual(me.visibleChats(CHATS, { ...base, keptChat: CLUB.chat_id, minMessageCount: 50 }), []);
  assert.equal(me.chatAfterSearch(kept, null, 'riley'), null);
  assert.equal(me.chatAfterSearch(kept, CLUB.chat_id, ''), null);
});

test("WhatsApp's list search ignores the chat's hidden address; Messages still matches its identifier", () => {
  const me = loadTs('src/components/explore/MessageExplorer.tsx');
  const { WHATSAPP_SOURCE } = loadTs('src/components/explore/WhatsAppExplorer.tsx');
  const opts = q => ({ query: q, hitsByChat: new Map(), listMatchFields: WHATSAPP_SOURCE.listMatchFields, keptChat: null, minMessageCount: 0, activeSince: '' });
  for (const q of ['what', 'net', 'us', '120363']) assert.deepEqual(me.visibleChats(CHATS, opts(q)), [], q);
  assert.deepEqual(me.visibleChats(CHATS, opts('5550190')).map(c => c.chat_id), [3]);
  const sms = [{ ...RILEY, display_name: '', chat_identifier: 'riley@example.com' }];
  const smsOpts = { ...opts('example'), listMatchFields: me.MESSAGES_SOURCE.listMatchFields };
  assert.equal(me.visibleChats(sms, smsOpts).length, 1, 'a Messages row with no name shows (and matches) its address');
});

test('Messages shows its calm empty line for a backup without sms.db, and an error only for a bare error', () => {
  const me = loadTs('src/components/explore/MessageExplorer.tsx');
  const missing = me.readChatList({ conversations: [], error: 'sms.db not found', empty_reason: 'not_in_backup' });
  assert.equal(missing.listError, null, 'not in the backup is not a failure: no Report button');
  assert.equal(missing.unreadableNote, null);
  assert.equal(me.emptyListText({ nouns: 'conversations', total: 0, query: '', unreadableNote: missing.unreadableNote }), 'No conversations in this backup');
  assert.equal(me.readChatList({ conversations: [], empty_reason: 'no_records' }).listError, null);

  const broken = me.readChatList({ conversations: [], error: 'database disk image is malformed' });
  assert.equal(broken.listError, 'database disk image is malformed');
  const old = me.readChatList({ conversations: [], error: 'This backup is from iOS 5', empty_reason: 'unsupported_format' });
  assert.equal(old.listError, null);
  assert.equal(me.emptyListText({ nouns: 'conversations', total: 0, query: '', unreadableNote: old.unreadableNote }), 'This backup is from iOS 5');
  assert.equal(me.emptyListText({ nouns: 'chats', total: 4, query: 'tea', unreadableNote: null }), 'No messages match "tea"');
  assert.deepEqual(me.readChatList(null).conversations, []);
});

// ── Searching every chat past the index's limit ──────────────────────────────

test('past the index limit WhatsApp searches the whole store through the engine; Messages is unchanged', async (t) => {
  const asked = [];
  let answer = { results: [{ message_id: 9, chat_id: 2, text: 'dinner plans', date: null, is_from_me: false, sender: 'Riley', chat_name: 'Old' }], query: 'dinner' };
  const bridge = fakeBridge({ call: async (method, params) => { asked.push([method, params]); return { success: true, data: answer }; } });
  t.after(bridge.restore);
  const { WHATSAPP_SOURCE, searchWholeStore } = loadTs('src/components/explore/WhatsAppExplorer.tsx');
  const { MESSAGES_SOURCE } = loadTs('src/components/explore/MessageExplorer.tsx');

  assert.equal(MESSAGES_SOURCE.fullSearch, undefined, 'Messages searches the index only, as before');
  const full = WHATSAPP_SOURCE.fullSearch;
  assert.equal(full.capped({ whatsappCap: { loaded: 200000, total: 350000 } }), true);
  assert.equal(full.capped({ whatsappCap: null }), false);
  assert.match(full.searched, /every chat/);
  assert.doesNotMatch(full.searched + full.searching, /index|engine|cap/i, 'plain words');

  const found = await searchWholeStore('udid-1', 'dinner plans');
  assert.deepEqual(asked, [['search_whatsapp_messages', { udid: 'udid-1', query: 'dinner' }]], 'one call, with the longest word');
  assert.equal(found.length, 1);
  assert.deepEqual([...full.merge(new Map(), found, parseQuery('dinner plans'))], [[2, [9]]]);

  assert.deepEqual(await searchWholeStore('udid-1', '   '), [], 'nothing to look for: no call');
  assert.equal(asked.length, 1);
  answer = { results: [], query: 'x', error: 'not here', empty_reason: 'not_in_backup' };
  assert.deepEqual(await searchWholeStore('udid-1', 'x'), [], 'WhatsApp not in the backup finds nothing');
  answer = { results: [], query: 'x', error: "WhatsApp's chats couldn't be read" };
  await assert.rejects(searchWholeStore('udid-1', 'x'), /couldn't be read/, 'an unreadable store is an error to show');
});

// ── Files handed to the computer ─────────────────────────────────────────────

function attachmentBridge(t, data) {
  const bridge = fakeBridge({
    call: async () => ({ success: true, data }),
    openPath: async () => '',
    showInFolder: async () => {},
  });
  t.after(bridge.restore);
  return bridge;
}

test('Open on a program shows it in its folder instead of running it, and says so (React StrictMode in development)', async (t) => {
  const bridge = attachmentBridge(t, { path: '/tmp/oe-wa/u/7/Invoice.exe', openable: false });
  const { R, mount } = hooksRuntime();
  const { useOpener } = loadTs('src/components/explore/WhatsAppAttachment.tsx', { stubs: { react: R } });
  const probe = mount(() => useOpener('u', 7), {}, { strict: true });
  await probe.out.open();
  probe.rerender();
  assert.deepEqual(bridge.calls.map(c => c[0]), ['call', 'showInFolder']);
  assert.equal(bridge.calls[1][1], '/tmp/oe-wa/u/7/Invoice.exe');
  assert.equal(probe.out.status, wa.SHOWN_IN_FOLDER, "what happened is shown, not a stuck 'Opening…'");
});

test('Open on a document opens it, and a failure to open is shown after StrictMode\'s second mount', async (t) => {
  const bridge = fakeBridge({
    call: async () => ({ success: true, data: { path: '/tmp/oe-wa/u/8/Lease.pdf', openable: true } }),
    openPath: async () => 'No app for this file',
    showInFolder: async () => {},
  });
  t.after(bridge.restore);
  const { R, mount } = hooksRuntime();
  const { useOpener } = loadTs('src/components/explore/WhatsAppAttachment.tsx', { stubs: { react: R } });
  const probe = mount(() => useOpener('u', 8), {}, { strict: true });
  await probe.out.open();
  probe.rerender();
  assert.deepEqual(bridge.calls.map(c => c[0]), ['call', 'openPath']);
  assert.equal(probe.out.status, "Couldn't open it: No app for this file");
});

test('nothing is set on an opener that has gone from the screen', async (t) => {
  attachmentBridge(t, { path: '/tmp/oe-wa/u/9/a.pdf', openable: true });
  const { R, mount } = hooksRuntime();
  const { useOpener } = loadTs('src/components/explore/WhatsAppAttachment.tsx', { stubs: { react: R } });
  const probe = mount(() => useOpener('u', 9), {});
  const opening = probe.out.open();
  probe.unmount();
  await opening;
  probe.rerender();
  assert.equal(probe.out.status, 'Opening…', 'the answer arrived after unmount and was dropped');
});

test("a document's name can't pose as another kind of file: invisible marks removed, real extension shown", () => {
  const { Document } = loadTs('src/components/explore/WhatsAppAttachment.tsx');
  const html = renderToStaticMarkup(createElement(Document, {
    udid: 'u', isMine: false,
    attachment: { attachment_id: 7, filename: 'Message/Media/x/Invoice.exe', mime_type: 'application/octet-stream', transfer_name: 'Invoice‮fdp.exe', total_bytes: 2048, available: true },
  }));
  assert.doesNotMatch(html, /[‪-‮⁦-⁩​-‏]/, 'no direction marks reach the screen');
  assert.match(html, /Invoicefdp<\/span><span class="flex-shrink-0">\.exe<\/span>/, 'the extension is kept in view');
  assert.match(html, /EXE file · 2 KB/);
});

// ── Voice messages ───────────────────────────────────────────────────────────

test("a voice message whose bubble goes away while it loads doesn't keep its sound in memory", async (t) => {
  const answer = deferred();
  const bridge = fakeBridge({ call: () => answer.promise });
  t.after(bridge.restore);
  const made = [], freed = [];
  const { createObjectURL, revokeObjectURL } = URL;
  URL.createObjectURL = () => { const u = `blob:test/${made.length}`; made.push(u); return u; };
  URL.revokeObjectURL = u => { freed.push(u); };
  t.after(() => { URL.createObjectURL = createObjectURL; URL.revokeObjectURL = revokeObjectURL; });

  const { R, mount } = hooksRuntime();
  const { Sound } = loadTs('src/components/explore/WhatsAppAttachment.tsx', { stubs: { react: R } });
  const props = {
    udid: 'u', kind: 'voice', isMine: false,
    attachment: { attachment_id: 3, filename: 'Message/Media/a.opus', mime_type: 'audio/ogg', transfer_name: 'PTT.opus', duration: 4, available: true },
  };
  const bubble = mount(Sound, props);
  const playing = find(bubble.out, el => el.type === 'button').props.onClick();
  bubble.unmount(); // another chat picked while it loads
  answer.resolve({ success: true, data: { data: Buffer.from('OggS').toString('base64'), mime_type: 'audio/ogg' } });
  await playing;
  await tick();
  assert.deepEqual(made.filter(u => !freed.includes(u)), [], 'every sound read into memory is let go');

  // On screen, it plays, and the sound is let go once the bubble goes
  const again = deferred();
  bridge.api.call = () => again.promise;
  const shown = mount(Sound, props);
  const play2 = find(shown.out, el => el.type === 'button').props.onClick();
  again.resolve({ success: true, data: { data: Buffer.from('OggS').toString('base64'), mime_type: 'audio/ogg' } });
  await play2;
  assert.equal(find(shown.rerender(), el => el.type === 'audio')?.props.src, made[made.length - 1]);
  shown.unmount();
  assert.deepEqual(made.filter(u => !freed.includes(u)), []);
});

// ── The photo viewer ─────────────────────────────────────────────────────────

test('the photo viewer takes focus, keeps Tab inside, and gives focus back to the photo when it closes', async (t) => {
  const bridge = fakeBridge({ call: () => new Promise(() => {}), openPath: async () => '', showInFolder: async () => {} });
  globalThis.window.addEventListener = () => {};
  globalThis.window.removeEventListener = () => {};
  t.after(bridge.restore);
  const thumbnail = { isConnected: true, focus() { globalThis.document.activeElement = thumbnail; } };
  const hadDocument = 'document' in globalThis;
  globalThis.document = { activeElement: thumbnail };
  t.after(() => { if (!hadDocument) delete globalThis.document; });

  const { R, mount } = hooksRuntime();
  const { Viewer } = loadTs('src/components/explore/WhatsAppAttachment.tsx', { stubs: { react: R } });
  const viewer = mount(Viewer, {
    udid: 'u', label: 'Photo', onClose: () => {},
    attachment: { attachment_id: 5, filename: 'Message/Media/p.jpg', mime_type: 'image/jpeg', transfer_name: 'Photo', available: true },
  }, { strict: true });
  const buttons = viewer.nodes.filter(n => n.tag === 'button');
  const close = buttons.find(n => n.props['aria-label'] === 'Close');
  const dialog = viewer.nodes.find(n => n.props.role === 'dialog');
  assert.equal(globalThis.document.activeElement, close, 'focus moves into the dialog, onto Close');

  // Tab from the last button goes round to the first, Shift+Tab from the first to the last
  const press = (shiftKey) => {
    const e = { key: 'Tab', shiftKey, prevented: false, preventDefault() { this.prevented = true; } };
    dialog.props.onKeyDown(e);
    return e;
  };
  assert.equal(press(false).prevented, true);
  assert.equal(globalThis.document.activeElement, buttons[0]);
  assert.equal(press(true).prevented, true);
  assert.equal(globalThis.document.activeElement, close);
  // Focus that somehow got behind the dialog comes back into it
  globalThis.document.activeElement = thumbnail;
  press(false);
  assert.equal(globalThis.document.activeElement, buttons[0]);
  globalThis.document.activeElement = buttons[0];
  assert.equal(press(false).prevented, false, 'Tab between the buttons is left alone');

  viewer.unmount();
  assert.equal(globalThis.document.activeElement, thumbnail, 'closing gives focus back to the photo');
});

// ── What screen readers hear ─────────────────────────────────────────────────

test('reaction chips are read out: who reacted with what', () => {
  const { default: ChatBubble } = loadTs('src/components/explore/ChatBubble.tsx');
  const r = (emoji, sender) => ({ emoji, sender, sender_handle: '', is_from_me: false, date: null });
  const html = renderToStaticMarkup(createElement(ChatBubble, {
    udid: 'u', variant: 'whatsapp',
    message: {
      message_id: 1, text: 'See you at 6', message_type: 'text', date: null, is_from_me: false, sender: 'Riley',
      has_attachments: false, is_reaction: false, reactions: [r('❤️', 'Riley'), r('❤️', 'Sam'), r('👍', 'Dana')],
    },
  }));
  assert.match(html, /<span class="sr-only">❤️ from Riley, Sam<\/span>/);
  assert.match(html, /<span class="sr-only">👍 from Dana<\/span>/);
  assert.doesNotMatch(html, /aria-label="❤️/, 'not a label on a plain span, which screen readers skip');
});

// ── Home ─────────────────────────────────────────────────────────────────────

test("the People tile's line covers every kind People gathers and fits on the tile", () => {
  const { PEOPLE_LINE } = loadTs('src/components/explore/BackupHome.tsx');
  assert.equal(PEOPLE_LINE, 'Everyone you were in touch with');
  // The tile shows about two lines of 16 characters; a longer line is cut off
  assert.ok(PEOPLE_LINE.length <= 32);
});
