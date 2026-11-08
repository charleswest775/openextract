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

const { exportProgressFor, percentDone } = loadTs('src/lib/exportProgress.ts');
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
  useState: init => [state === undefined ? init : state, v => { state = v; }],
  useEffect: fn => { effects.push(fn); },
};
const { useExportProgress } = loadTs('src/hooks/useExportProgress.ts', { stubs: { react } });

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
