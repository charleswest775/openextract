// Tests for showing how far a long save has got (OE-14): the engine's export.progress
// notifications (python/export_progress.py) reach the renderer on 'sidecar:notification'
// (main-ipc.test.mjs checks the forwarding). Here: picking them out (src/lib/exportProgress.ts),
// the wording (photoSaveProgress in src/lib/photoCounts.ts), and useExportProgress
// subscribing while a save runs, with a stand-in for React.
// Run with: node --test scripts/export-progress.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs } from './test-helpers/load-ts.mjs';
import { enUS } from './test-helpers/time-zones.mjs';

const { chatSaveAfter, chatSaveStatus, exportProgressFor, NO_CHAT_SAVE, percentDone } = loadTs('src/lib/exportProgress.ts');
const { photoSaveProgress, photoSaveFailures } = loadTs('src/lib/photoCounts.ts');

const n = x => x.toLocaleString();
const note = params => ({ jsonrpc: '2.0', method: 'export.progress', params });

// ── Picking out the progress for one kind of save ────────────────────────────

test('export.progress for the kind asked about', () => {
  assert.deepEqual(exportProgressFor('photos', note({ kind: 'photos', done: 1234, total: 5678, failed: 3 })),
    { kind: 'photos', done: 1234, total: 5678, failed: 3 });
});

test('other notifications, other kinds and malformed ones are not progress for this save', () => {
  assert.equal(exportProgressFor('photos', { method: 'backup.progress', params: { kind: 'photos', done: 1, total: 2 } }), null);
  assert.equal(exportProgressFor('photos', note({ kind: 'messages', done: 1, total: 2, failed: 0 })), null);
  assert.equal(exportProgressFor('photos', note({ kind: 'photos', done: '1', total: 2 })), null);
  assert.equal(exportProgressFor('photos', note({ kind: 'photos', done: 1 })), null);
  assert.equal(exportProgressFor('photos', note(undefined)), null);
  assert.equal(exportProgressFor('photos', null), null);
  // Nothing to save: nothing to show either (the button still says Saving…)
  assert.equal(exportProgressFor('photos', note({ kind: 'photos', done: 0, total: 0, failed: 0 })), null);
});

test('an engine that leaves out failed counts none', () => {
  assert.equal(exportProgressFor('photos', note({ kind: 'photos', done: 1, total: 2 })).failed, 0);
});

test('the bar fills with files done, within 0 to 100', () => {
  const p = (done, total) => ({ kind: 'photos', done, total, failed: 0 });
  assert.equal(percentDone(p(0, 5678)), 0);
  assert.equal(percentDone(p(1234, 5678)), 22);
  assert.equal(percentDone(p(5678, 5678)), 100);
  assert.equal(percentDone(p(6000, 5678)), 100);
});

// ── Wording ──────────────────────────────────────────────────────────────────

test('counts the file it is on, up to the total', () => {
  assert.equal(photoSaveProgress(0, 40), 'Saving 1 of 40 photos and videos…');
  assert.equal(photoSaveProgress(12, 40), 'Saving 13 of 40 photos and videos…');
  assert.equal(photoSaveProgress(40, 40), 'Saving 40 of 40 photos and videos…');
  assert.equal(photoSaveProgress(0, 1), 'Saving 1 of 1 photo or video…');
  assert.equal(photoSaveProgress(1233, 5678), `Saving ${n(1234)} of ${n(5678)} photos and videos…`);
});

test('English digit grouping', { skip: !enUS && 'needs an en-US locale' }, () => {
  assert.equal(photoSaveProgress(1233, 5678), 'Saving 1,234 of 5,678 photos and videos…');
  assert.equal(photoSaveFailures(1250), "1,250 couldn't be copied");
});

test('failures show once there are any, in the words the finished notice uses', () => {
  assert.equal(photoSaveFailures(0), '');
  assert.equal(photoSaveFailures(3), "3 couldn't be copied");
});

// ── useExportProgress ────────────────────────────────────────────────────────

// React, enough for one hook: state that keeps between renders, effects run by hand.
let state;
let effects = [];
const react = {
  useState: init => [state === undefined ? init : state, v => { state = typeof v === 'function' ? v(state ?? init) : v; }],
  useEffect: fn => { effects.push(fn); },
};
const { useChatSaveProgress, useExportProgress } = loadTs('src/hooks/useExportProgress.ts', { stubs: { react } });

function render(kind, active) {
  effects = [];
  const value = useExportProgress(kind, active);
  const cleanups = effects.map(fn => fn()).filter(Boolean);
  return { value, cleanup: () => cleanups.forEach(c => c()) };
}

function bridge() {
  const listeners = new Set();
  globalThis.window = {
    openextract: {
      onNotification: cb => { listeners.add(cb); return () => listeners.delete(cb); },
    },
  };
  return { listeners, send: n => [...listeners].forEach(cb => cb(n)) };
}

test('useExportProgress listens while the save runs and shows the latest update for its kind', () => {
  state = undefined;
  const { listeners, send } = bridge();
  const first = render('photos', true);
  assert.equal(first.value, null, 'nothing to show before the first update');
  assert.equal(listeners.size, 1);

  send({ method: 'backup.progress', params: { percent: 5 } });
  send(note({ kind: 'messages', done: 1, total: 9, failed: 0 }));
  assert.equal(state, null);
  send(note({ kind: 'photos', done: 10, total: 40, failed: 0 }));
  send(note({ kind: 'photos', done: 20, total: 40, failed: 1 }));
  assert.deepEqual(render('photos', true).value, { kind: 'photos', done: 20, total: 40, failed: 1 });

  first.cleanup();
  assert.equal(listeners.size, 1, 'the second render still listens');
});

test('useExportProgress shows nothing and stops listening once the save is over', () => {
  state = undefined;
  const { listeners, send } = bridge();
  const running = render('photos', true);
  send(note({ kind: 'photos', done: 39, total: 40, failed: 0 }));
  running.cleanup();
  assert.equal(listeners.size, 0);

  const done = render('photos', false);
  assert.equal(done.value, null);
  assert.equal(listeners.size, 0);
  assert.equal(state, null, 'the next save starts from nothing, not from the last one');
});

test('useExportProgress without the app bridge (the renderer in a plain browser) shows nothing', () => {
  state = undefined;
  globalThis.window = {};
  assert.equal(render('photos', true).value, null);
  delete globalThis.window;
});

// ── Saving conversations and WhatsApp chats (OE-132) ─────────────────────────

const reading = (over = {}) => note({ kind: 'whatsapp', phase: 'reading', done: 500, total: 2000, failed: 0, chat: 1, chats: 1, percent: 2, ...over });
const saving = (over = {}) => reading({ phase: 'saving', done: 1200, percent: 64, ...over });
const step = params => ({ jsonrpc: '2.0', method: 'pdf.progress', params: { kind: 'whatsapp', ...params } });
const status = (...notes) => chatSaveStatus(notes.reduce((s, x) => chatSaveAfter(s, 'whatsapp', x), NO_CHAT_SAVE), 'chat');

test('a save of one chat says which message it is on', () => {
  assert.equal(status(), null);
  assert.equal(status(reading()).text, `Reading 500 of ${n(2000)} messages…`);
  assert.equal(status(saving()).text, `Saving ${n(1201)} of ${n(2000)} messages…`);
  assert.equal(status(saving({ done: 0, total: 1 })).text, 'Saving 1 of 1 message…');
  assert.equal(status(saving()).percent, 64);
});

test('a save of several chats says which chat', () => {
  assert.equal(status(saving({ chat: 3, chats: 40 })).text, `Saving chat 3 of 40: ${n(1201)} of ${n(2000)} messages…`);
  assert.equal(status(reading({ chat: 3, chats: 40 })).text, `Reading chat 3 of 40: 500 of ${n(2000)} messages…`);
});

test('a PDF save split by year says which PDF, and when it is printing', () => {
  const second = step({ part: 2, parts: 5 });
  assert.equal(status(second).text, 'Saving PDF 2 of 5…');
  assert.equal(status(second, reading()).text, 'Saving PDF 2 of 5…');
  assert.equal(status(second, saving()).text, `Saving PDF 2 of 5: ${n(1201)} of ${n(2000)} messages…`);
  assert.equal(status(step({ part: 2, parts: 5, printing: { file: 2, files: 5 } })).text, 'Making PDF 2 of 5…');
  assert.equal(status(step({ part: 1, parts: 1, printing: { file: 1, files: 1 } })).text, 'Making the PDF…');
});

test('a PDF save fills its bar once, from planning to the last page printed', () => {
  const printing = (part, parts, file, files) => step({ part, parts, printing: { file, files } });
  const saves = [
    [reading({ percent: 10 }), step({ part: 1, parts: 2 }), saving({ percent: 99 }), printing(1, 2, 1, 2),
      step({ part: 2, parts: 2 }), reading({ percent: 1 }), saving({ percent: 99 }), printing(2, 2, 2, 2)],
    [reading({ percent: 10 }), step({ part: 1, parts: 1 }), saving({ chats: 3, percent: 50 }), saving({ chat: 3, chats: 3, percent: 99 }),
      printing(1, 1, 1, 3), printing(1, 1, 2, 3), printing(1, 1, 3, 3)],
  ];
  for (const notes of saves) {
    const bar = notes.map((_, i) => status(...notes.slice(0, i + 1)).percent);
    assert.deepEqual(bar, [...bar].sort((a, b) => a - b), bar.join(', '));
    assert.ok(bar.at(-1) <= 100 && bar.at(-1) >= 85, bar.join(', '));
  }
});

test('other saves\' updates don\'t show on this one', () => {
  for (const other of [saving({ kind: 'messages' }), note({ kind: 'whatsapp', done: 1, total: 2 }), step({ kind: 'messages', part: 1, parts: 2 }), null]) {
    assert.equal(chatSaveAfter(NO_CHAT_SAVE, 'whatsapp', other), NO_CHAT_SAVE);
  }
});

test('useChatSaveProgress follows the save while it runs, then shows nothing', () => {
  state = undefined;
  const { listeners, send } = bridge();
  effects = [];
  assert.equal(useChatSaveProgress('whatsapp', true), null);
  const stop = effects.map(fn => fn()).filter(Boolean);
  send(step({ part: 2, parts: 5 }));
  send(saving());
  assert.match(useChatSaveProgress('whatsapp', true).text, /^Saving PDF 2 of 5: /);
  assert.equal(useChatSaveProgress('whatsapp', false), null);
  stop.forEach(fn => fn());
  assert.equal(listeners.size, 0);
  delete globalThis.window;
});
