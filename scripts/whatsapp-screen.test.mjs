// Tests for the WhatsApp screen's components (src/components/explore/
// MessageExplorer, WhatsAppExplorer, WhatsAppAttachment, MediaAttachment,
// ChatBubble, BackupHome) and src/hooks/useNearScreen: which chats the list keeps
// while searching, the engine's whole-store search past the index's limit, how a
// copied file is handed to the computer, the hooks that outlive an await, the
// photo viewer's focus, Messages' and WhatsApp's media (thumbnails, posters, video
// in the app, tiles on cards), and what screen readers hear. Components render
// with react-dom/server for their markup;
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

test("WhatsApp's screen explains chats left out of the backup, with no Report button", () => {
  const { WHATSAPP_SOURCE } = loadTs('src/components/explore/WhatsAppExplorer.tsx');
  const html = renderToStaticMarkup(WHATSAPP_SOURCE.emptyScreen('chats_left_out', null));
  assert.match(html, /WhatsApp&#x27;s chats aren&#x27;t in this backup/);
  assert.match(html, /end-to-end encrypted backup is turned on/);
  assert.doesNotMatch(html, /Report/);
});

test('Recover deleted says it looks for iMessages and texts, and why deleted WhatsApp messages aren\'t there, only when there is WhatsApp', () => {
  const { default: RecordRecoveryView } = loadTs('src/components/explore/RecordRecoveryView.tsx');
  const withWhatsApp = renderToStaticMarkup(createElement(RecordRecoveryView, { udid: 'u', query: '', whatsapp: true }));
  assert.match(withWhatsApp, /deleted iMessages and texts/);
  assert.match(withWhatsApp, /Deleted WhatsApp messages can&#x27;t be brought back/);
  const without = renderToStaticMarkup(createElement(RecordRecoveryView, { udid: 'u', query: '' }));
  assert.match(without, /deleted iMessages and texts/);
  assert.doesNotMatch(without, /WhatsApp/);
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

// ── Media from Messages and WhatsApp (MediaAttachment.tsx) ───────────────────
// One component draws both sources' files. Each file is asked for from its own
// source only (sms.db and WhatsApp number their files separately), pictures load
// small first, videos play in the app from a copy, and on a Timeline or People
// card a click on a file is the file's, not the card's.

const MEDIA = 'src/components/explore/MediaAttachment.tsx';
const photo = (id, extra = {}) => ({ attachment_id: id, filename: `~/Library/SMS/Attachments/ab/${id}/IMG_${id}.jpeg`, mime_type: 'image/jpeg', transfer_name: `IMG_${id}.jpeg`, total_bytes: 2048, ...extra });
const video = (id, extra = {}) => ({ attachment_id: id, filename: `~/Library/SMS/Attachments/cd/${id}/IMG_${id}.MOV`, mime_type: 'video/quicktime', transfer_name: `IMG_${id}.MOV`, total_bytes: 9_000_000, ...extra });
const JPEG = Buffer.from('jpeg').toString('base64');

/** A bridge whose engine answers by (method, params); every call is recorded. */
function mediaBridge(t, answer, extra = {}) {
  const bridge = fakeBridge({
    call: async (method, params) => ({ success: true, data: await answer(method, params) }),
    openPath: async () => '',
    showInFolder: async () => {},
    mediaThumbnail: async () => 'data:image/jpeg;base64,UE9TVEVS',
    ...extra,
  });
  bridge.api.platform = 'darwin';
  t.after(bridge.restore);
  return bridge;
}

const engineCalls = bridge => bridge.calls.filter(c => c[0] === 'call').map(([, method, params]) => [method, params]);

async function settle(times = 6) {
  for (let i = 0; i < times; i++) await tick();
}

/** All the words in a tree of elements. */
function textOf(tree) {
  if (tree == null || typeof tree === 'boolean') return '';
  if (typeof tree === 'string' || typeof tree === 'number') return String(tree);
  if (Array.isArray(tree)) return tree.map(textOf).join('');
  return textOf(tree.props?.children);
}

/** The window and document a viewer needs (focus, Escape) in node. */
function viewerGlobals(t) {
  globalThis.window.addEventListener = () => {};
  globalThis.window.removeEventListener = () => {};
  const hadDocument = 'document' in globalThis;
  if (!hadDocument) globalThis.document = { activeElement: null };
  t.after(() => { if (!hadDocument) delete globalThis.document; });
}

test('a file is asked for from its own source: Messages from get_attachment, WhatsApp from get_whatsapp_attachment', async (t) => {
  const bridge = mediaBridge(t, () => ({ path: '/tmp/openextract-messages-1-a/u/5/Lease.pdf', openable: true }));
  const { R, mount } = hooksRuntime();
  const { useOpener } = loadTs(MEDIA, { stubs: { react: R } });
  await mount(() => useOpener('u', 5, 'messages'), {}).out.open();
  await mount(() => useOpener('u', 5, 'whatsapp'), {}).out.open();
  await mount(() => useOpener('u', 5), {}).out.open();
  assert.deepEqual(engineCalls(bridge).map(([m]) => m), ['get_attachment', 'get_whatsapp_attachment', 'get_whatsapp_attachment'],
    'the same id goes to each source separately; the default is WhatsApp, as before');
  assert.ok(engineCalls(bridge).every(([, p]) => p.as_file === true && p.attachment_id === 5));
});

test('a Messages photo loads as the thumbnail the engine makes, then full size only in the viewer, each kept by source', async (t) => {
  const bridge = mediaBridge(t, (method, p) => (p.thumbnail
    ? { data: JPEG, mime_type: 'image/jpeg', width: 3024, height: 4032 }
    : { data: Buffer.from(`full ${method}`).toString('base64'), mime_type: 'image/jpeg' }));
  viewerGlobals(t);
  const { R, mount } = hooksRuntime();
  const { Picture, Viewer } = loadTs(MEDIA, { stubs: { react: R }, expose: ['Picture'] });
  const props = { source: 'messages', udid: 'u', attachment: photo(5), kind: 'image', onColour: false, tile: false };
  const bubble = mount(Picture, props);
  await settle();
  const img = find(bubble.rerender(), el => el.type === 'img');
  assert.equal(img?.props.src, `data:image/jpeg;base64,${JPEG}`);
  assert.deepEqual(engineCalls(bridge), [['get_attachment', { udid: 'u', attachment_id: 5, thumbnail: true }]]);
  const button = find(bubble.out, el => el.type === 'button');
  assert.deepEqual(button.props.style, { width: 220, height: 220 }, 'a fixed box before the shape is known, so the chat doesn\'t move');

  // Drawn again (scrolled back, chat reopened): the thumbnail is kept, and the box now has the photo's shape
  const again = mount(Picture, props);
  await settle();
  assert.equal(engineCalls(bridge).length, 1, 'not asked again');
  assert.deepEqual(find(again.out, el => el.type === 'button').props.style, { width: 192, height: 256 });

  // The viewer shows the kept thumbnail at once, then asks for the full photo
  const viewer = mount(Viewer, { source: 'messages', udid: 'u', attachment: photo(5), label: 'Photo', onClose: () => {} });
  assert.equal(find(viewer.out, el => el.type === 'img')?.props.src, `data:image/jpeg;base64,${JPEG}`);
  await settle();
  assert.equal(find(viewer.rerender(), el => el.type === 'img')?.props.src, `data:image/jpeg;base64,${Buffer.from('full get_attachment').toString('base64')}`);
  // WhatsApp's file 5 is somebody else's: not served from Messages' cache
  const wa = mount(Viewer, { source: 'whatsapp', udid: 'u', attachment: photo(5), label: 'Photo', onClose: () => {} });
  await settle();
  assert.equal(find(wa.rerender(), el => el.type === 'img')?.props.src, `data:image/jpeg;base64,${Buffer.from('full get_whatsapp_attachment').toString('base64')}`);
  assert.deepEqual(engineCalls(bridge).map(([m, p]) => `${m}${p.thumbnail ? ' thumbnail' : ''}`),
    ['get_attachment thumbnail', 'get_attachment', 'get_whatsapp_attachment']);
});

test('a Messages file the engine has no thumbnail for is shown from the file itself; a missing one says so', async (t) => {
  const bridge = mediaBridge(t, (_m, p) => (p.attachment_id === 9
    ? { error: "This file isn't in the backup", empty_reason: 'not_in_backup' }
    : p.thumbnail ? { no_thumbnail: true, mime_type: 'image/gif', filename: 'a.gif', size: 10 } : { data: JPEG, mime_type: 'image/gif' }));
  const { R, mount } = hooksRuntime();
  const { Picture } = loadTs(MEDIA, { stubs: { react: R }, expose: ['Picture'] });
  const gif = mount(Picture, { source: 'messages', udid: 'u', attachment: photo(8, { mime_type: 'image/gif' }), kind: 'image', onColour: false, tile: false });
  await settle();
  assert.equal(find(gif.rerender(), el => el.type === 'img')?.props.src, `data:image/gif;base64,${JPEG}`);
  const gone = mount(Picture, { source: 'messages', udid: 'u', attachment: photo(9), kind: 'image', onColour: false, tile: false });
  await settle();
  const missing = gone.rerender();
  assert.equal(missing.props.kind, 'image', 'the Missing note, not an empty box');
  assert.deepEqual(engineCalls(bridge).map(([, p]) => [p.attachment_id, !!p.thumbnail]), [[8, true], [8, false], [9, true]],
    'a file not in the backup isn\'t asked for again in full');
});

test('a file the engine says isn\'t in the backup is never asked for', (t) => {
  const bridge = mediaBridge(t, () => assert.fail('nothing should be asked'));
  const { default: MediaAttachment } = loadTs(MEDIA);
  const html = renderToStaticMarkup(createElement(MediaAttachment, {
    source: 'messages', udid: 'u', isMine: false, messageType: 'attachment', attachment: photo(4, { available: false }),
  }));
  assert.match(html, /Photo not in this backup/);
  const tile = renderToStaticMarkup(createElement(MediaAttachment, {
    source: 'messages', size: 'tile', udid: 'u', isMine: true, messageType: 'attachment', attachment: video(4, { available: false }),
  }));
  assert.match(tile, /Not in backup/);
  assert.match(tile, /aria-label="Video not in this backup"/);
  assert.deepEqual(bridge.calls, []);
});

test('a video without a stored thumbnail gets a poster from a copy, one copy at a time, only for tiles still on screen', async (t) => {
  const copying = [];
  const bridge = mediaBridge(t, (_m, p) => new Promise(resolve => copying.push(() => resolve({ path: `/tmp/openextract-messages-1-a/u/${p.attachment_id}/IMG.MOV`, openable: true }))));
  const { R, mount } = hooksRuntime();
  const { VideoTile } = loadTs(MEDIA, { stubs: { react: R }, expose: ['VideoTile'] });
  const tile = id => mount(VideoTile, { source: 'messages', udid: 'u', attachment: video(id), kind: 'video', onColour: false, tile: false });
  const first = tile(1);
  const second = tile(2);
  const third = tile(3);
  await settle();
  assert.equal(copying.length, 1, 'one copy at a time');
  second.unmount(); // scrolled away (another chat opened) before its turn
  copying.shift()();
  await settle();
  assert.equal(find(first.rerender(), el => el.type === 'img')?.props.src, 'data:image/jpeg;base64,UE9TVEVS');
  assert.equal(copying.length, 1);
  copying.shift()();
  await settle();
  assert.equal(find(third.rerender(), el => el.type === 'img')?.props.src, 'data:image/jpeg;base64,UE9TVEVS');
  assert.deepEqual(engineCalls(bridge).map(([m, p]) => [m, p.attachment_id, p.as_file]), [['get_attachment', 1, true], ['get_attachment', 3, true]],
    'the tile that left before its turn was never copied');
  assert.deepEqual(bridge.calls.filter(c => c[0] === 'mediaThumbnail').map(c => c.slice(1)),
    [['/tmp/openextract-messages-1-a/u/1/IMG.MOV', 480], ['/tmp/openextract-messages-1-a/u/3/IMG.MOV', 480]]);
  // Kept: drawn again, it isn't copied again
  tile(1);
  await settle();
  assert.equal(engineCalls(bridge).length, 2);
});

test('no copy for a poster of a very big video, on Linux, or when WhatsApp stored a thumbnail', async (t) => {
  const bridge = mediaBridge(t, (_m, p) => (p.thumbnail ? { data: JPEG, mime_type: 'image/jpeg' } : { path: '/tmp/x.mov' }));
  const { R, mount } = hooksRuntime();
  const { VideoTile } = loadTs(MEDIA, { stubs: { react: R }, expose: ['VideoTile'] });
  mount(VideoTile, { source: 'messages', udid: 'u', attachment: video(1, { total_bytes: 400_000_000 }), kind: 'video', onColour: false, tile: false });
  const stored = mount(VideoTile, { source: 'whatsapp', udid: 'u', attachment: video(2, { thumbnail_path: 'Media/x.thumb', total_bytes: null }), kind: 'video', onColour: false, tile: false });
  await settle();
  assert.equal(find(stored.rerender(), el => el.type === 'img')?.props.src, `data:image/jpeg;base64,${JPEG}`);
  bridge.api.platform = 'linux';
  mount(VideoTile, { source: 'messages', udid: 'u', attachment: video(3), kind: 'video', onColour: false, tile: false });
  await settle();
  assert.deepEqual(engineCalls(bridge), [['get_whatsapp_attachment', { udid: 'u', attachment_id: 2, thumbnail: true }]]);
  assert.equal(bridge.calls.filter(c => c[0] === 'mediaThumbnail').length, 0);
});

test('a video plays in the app from its copy; one that can\'t play here offers another app', async (t) => {
  const copy = '/private/var/folders/T/openextract-messages-1-a/u/7/Clip #7.MOV';
  const bridge = mediaBridge(t, () => ({ path: copy, openable: true }));
  viewerGlobals(t);
  const { R, mount } = hooksRuntime();
  const { VideoViewer } = loadTs(MEDIA, { stubs: { react: R } });
  const viewer = mount(VideoViewer, { source: 'messages', udid: 'u', attachment: video(7), label: 'Video', onClose: () => {} });
  assert.match(textOf(viewer.out), /Getting the video ready…/, 'the copy can take a moment for a long video');
  await settle();
  const player = find(viewer.rerender(), el => el.type === 'video');
  assert.equal(player?.props.src, 'local-media://media/private/var/folders/T/openextract-messages-1-a/u/7/Clip%20%237.MOV');
  assert.equal(player.props.autoPlay, true);
  assert.equal(player.props.controls, true);
  assert.deepEqual(engineCalls(bridge), [['get_attachment', { udid: 'u', attachment_id: 7, as_file: true }]]);

  player.props.onError(); // a codec this computer doesn't have
  const out = viewer.rerender();
  assert.equal(find(out, el => el.type === 'video'), null);
  assert.match(textOf(out), /This video can't play here. Open it in another app to watch it./);
  const other = find(out, el => el.type === 'button' && textOf(el).includes('Open in another app'));
  await other.props.onClick();
  assert.deepEqual(bridge.calls.filter(c => c[0] === 'openPath').map(c => c[1]), [copy]);
});

test('on a card a file is a small square, and clicking it (or Enter on it) doesn\'t open the card; Escape still closes its viewer', () => {
  const { default: MediaAttachment } = loadTs(MEDIA);
  const html = renderToStaticMarkup(createElement(MediaAttachment, {
    source: 'messages', size: 'tile', udid: 'u', isMine: true, messageType: 'attachment', attachment: photo(3),
  }));
  assert.match(html, /style="width:72px;height:72px"/);
  assert.doesNotMatch(html, /text-white/, 'a card has no bubble colour behind it');
  const wrapper = MediaAttachment({ source: 'messages', size: 'tile', udid: 'u', isMine: false, messageType: 'attachment', attachment: photo(3) });
  const stopped = [];
  const event = key => ({ key, stopPropagation: () => stopped.push(key ?? 'click') });
  wrapper.props.onClick(event());
  wrapper.props.onKeyDown(event('Enter'));
  wrapper.props.onKeyDown(event(' '));
  wrapper.props.onKeyDown(event('Escape'));
  assert.deepEqual(stopped, ['click', 'Enter', ' ']);
  // In a chat bubble there's no wrapper: the file is the bubble's own
  const bubble = MediaAttachment({ source: 'messages', udid: 'u', isMine: false, messageType: 'attachment', attachment: photo(3) });
  assert.equal(bubble.props.onClick, undefined);
});

test('Messages voice messages, stickers and documents look like what they are', () => {
  const { default: MediaAttachment } = loadTs(MEDIA);
  const draw = (attachment, messageType = 'attachment', size = 'bubble') =>
    renderToStaticMarkup(createElement(MediaAttachment, { source: 'messages', size, udid: 'u', isMine: false, messageType, attachment }));
  const caf = { attachment_id: 1, filename: '~/Library/SMS/Attachments/a/1/Audio Message.caf', mime_type: 'audio/x-caf', transfer_name: 'Audio Message.caf', total_bytes: 9000 };
  assert.match(draw(caf, 'audio'), /Play voice message/);
  assert.match(draw({ ...caf, filename: 'x/Song.mp3', mime_type: 'audio/mpeg', transfer_name: 'Song.mp3' }), /Play audio/);
  assert.match(draw(photo(2, { is_sticker: true, mime_type: 'image/png', transfer_name: 'sticker.png' })), /style="width:128px;height:128px"/);
  const pdf = draw({ attachment_id: 3, filename: 'x/Lease.pdf', mime_type: 'application/pdf', transfer_name: 'Lease.pdf', total_bytes: 52_000 });
  assert.match(pdf, /Lease<\/span><span class="flex-shrink-0">\.pdf<\/span>/);
  assert.match(pdf, /PDF file · 51 KB/);
  assert.match(draw({ attachment_id: 3, filename: 'x/Lease.pdf', mime_type: 'application/pdf', transfer_name: 'Lease.pdf' }, 'attachment', 'tile'), />PDF</);
});

test('useNearScreen waits for the element to come near its scrolling pane, then stays true', (t) => {
  const made = [];
  const had = 'IntersectionObserver' in globalThis;
  globalThis.IntersectionObserver = class {
    constructor(cb, options) { Object.assign(this, { cb, options, watched: [], disconnected: false }); made.push(this); }
    observe(el) { this.watched.push(el); }
    disconnect() { this.disconnected = true; }
  };
  t.after(() => { if (!had) delete globalThis.IntersectionObserver; });
  const { R, mount } = hooksRuntime();
  const { useNearScreen } = loadTs('src/hooks/useNearScreen.ts', { stubs: { react: R } });
  const pane = { name: 'pane' };
  const asked = [];
  const ref = { current: { closest: sel => { asked.push(sel); return pane; } } };
  const probe = mount(() => useNearScreen(ref, 600), {});
  assert.equal(probe.out, false);
  assert.deepEqual(asked, ['[data-scroll-root],[data-thread-scroll]']);
  assert.equal(made[0].options.root, pane);
  assert.equal(made[0].options.rootMargin, '600px 0px');
  assert.deepEqual(made[0].watched, [ref.current]);
  made[0].cb([{ isIntersecting: false }]);
  assert.equal(probe.rerender(), false);
  made[0].cb([{ isIntersecting: true }]);
  assert.equal(probe.rerender(), true);
  assert.equal(made[0].disconnected, true, 'one look is enough');
  assert.equal(made.length, 1, 'no new watcher once near');

  // The default look-ahead, and no pane: the window
  const free = { current: { closest: () => null } };
  mount(() => useNearScreen(free), {});
  assert.equal(made[1].options.rootMargin, '800px 0px');
  assert.equal(made[1].options.root, null);
});

test('useNearScreen is true at once where IntersectionObserver is missing', () => {
  assert.equal(typeof IntersectionObserver, 'undefined', 'node has none (the test above puts its fake back)');
  const { R, mount } = hooksRuntime();
  const { useNearScreen } = loadTs('src/hooks/useNearScreen.ts', { stubs: { react: R } });
  assert.equal(mount(() => useNearScreen({ current: null }), {}).out, true);
});

test('Messages photos, videos and stickers sent on their own sit outside a bubble; text and other files keep it', () => {
  const { default: ChatBubble } = loadTs('src/components/explore/ChatBubble.tsx');
  const seen = [];
  const Attachment = ({ attachment, isMine }) => { seen.push([attachment.attachment_id, isMine]); return createElement('i', null, 'file'); };
  const msg = (id, text, attachments, type = 'attachment') => ({
    message_id: id, text, message_type: type, date: null, is_from_me: true, sender: 'Me', has_attachments: true, is_reaction: false, attachments,
  });
  const draw = m => renderToStaticMarkup(createElement(ChatBubble, { udid: 'u', variant: 'messages', message: m, Attachment }));
  assert.doesNotMatch(draw(msg(1, null, [photo(1), video(2)])), /--bubble-me/, 'photos and videos alone: no bubble');
  assert.match(draw(msg(2, 'Look!', [photo(3)], 'text')), /--bubble-me/, 'with words: in the bubble');
  assert.match(draw(msg(3, null, [{ attachment_id: 4, filename: 'x/Lease.pdf', mime_type: 'application/pdf', transfer_name: 'Lease.pdf' }])), /--bubble-me/);
  assert.deepEqual(seen, [[1, false], [2, false], [3, true], [4, true]], 'outside a bubble a file isn\'t drawn on the bubble\'s colour');
  // Without a source to read from (a recovered message), only the file's name, nothing fetched
  const plain = renderToStaticMarkup(createElement(ChatBubble, { udid: 'u', message: msg(5, 'x', [photo(6, { transfer_name: 'IMG‮gpj.exe' })], 'text') }));
  assert.match(plain, /IMG/);
  assert.doesNotMatch(plain, /‮/, 'without the marks that disguise a name');
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

test('a viewer opened from a message view sits above it, and Escape closes only the viewer', async (t) => {
  mediaBridge(t, () => ({ data: JPEG, mime_type: 'image/jpeg' }));
  const listeners = [];
  globalThis.window.addEventListener = (type, fn, capture) => listeners.push({ type, fn, capture });
  globalThis.window.removeEventListener = () => {};
  const hadDocument = 'document' in globalThis;
  if (!hadDocument) globalThis.document = { activeElement: null };
  t.after(() => { if (!hadDocument) delete globalThis.document; });
  const { R, mount } = hooksRuntime();
  const { Viewer } = loadTs(MEDIA, { stubs: { react: R } });
  let closed = 0;
  const viewer = mount(Viewer, { source: 'messages', udid: 'u', attachment: photo(5), label: 'Photo', onClose: () => { closed++; } });
  await settle();
  const frame = find(viewer.rerender(), el => el.props?.role === 'dialog');
  assert.match(frame.props.className, /z-\[10000\]/, 'above a message view (z-index 9999) it may be opened from');
  const key = listeners.find(l => l.type === 'keydown');
  assert.equal(key?.capture, true, 'heard before the message view underneath');
  let prevented = false, stopped = false;
  key.fn({ key: 'Escape', preventDefault: () => { prevented = true; }, stopPropagation: () => { stopped = true; } });
  assert.deepEqual({ closed, prevented, stopped }, { closed: 1, prevented: true, stopped: true },
    'the message view behind ignores an Escape the viewer took (it checks defaultPrevented)');
  key.fn({ key: 'a', preventDefault: () => assert.fail('other keys pass'), stopPropagation: () => assert.fail('other keys pass') });
  assert.equal(closed, 1);
});
