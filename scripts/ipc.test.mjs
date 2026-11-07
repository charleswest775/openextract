// Tests for the renderer's side of the engine bridge (src/lib/ipc.ts): the
// preload's { success, data, error } replies become values or thrown Errors, and
// outside Electron (the renderer in a plain browser) every call fails clearly.
// Run with: node --test scripts/ipc.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadTs, fakeBridge } from './test-helpers/load-ts.mjs';

// ipc.ts decides once, when loaded, whether it runs in Electron; the bridge stays for the test
function loadWith(t, handlers) {
  const bridge = fakeBridge(handlers);
  t.after(bridge.restore);
  return { ipc: loadTs('src/lib/ipc.ts'), calls: bridge.calls };
}

test('sidecarCall hands back the engine\'s data', async t => {
  const backups = [{ udid: '00008030-001A2B3C4D5E6F70', device_name: 'Jane’s iPhone', encrypted: true, size_gb: null }];
  const { ipc, calls } = loadWith(t, { call: async () => ({ success: true, data: { backups } }) });
  assert.deepEqual(await ipc.sidecarCall('list_backups', { path: undefined }), { backups });
  assert.deepEqual(calls, [['call', 'list_backups', { path: undefined }]]);
});

test('sidecarCall sends empty params when none are given', async t => {
  const { ipc, calls } = loadWith(t, { call: async () => ({ success: true, data: { has_any: false } }) });
  await ipc.sidecarCall('has_browser_history');
  assert.deepEqual(calls[0], ['call', 'has_browser_history', {}]);
});

test('an engine error becomes a thrown Error with its message', async t => {
  const { ipc } = loadWith(t, {
    call: async method => (method === 'open_backup'
      ? { success: false, error: 'Wrong password for this backup' }
      : { success: false }),
  });
  await assert.rejects(ipc.sidecarCall('open_backup', { udid: 'x', password: 'nope' }),
    err => err instanceof Error && err.message === 'Wrong password for this backup');
  await assert.rejects(ipc.sidecarCall('list_notes', { udid: 'x' }), { message: 'Unknown error' });
});

test('an empty error message still reads as an error', async t => {
  const { ipc } = loadWith(t, { call: async () => ({ success: false, error: '' }) });
  await assert.rejects(ipc.sidecarCall('list_calls', {}), { message: 'Unknown error' });
});

test('a result that is falsy but successful comes through as-is', async t => {
  const { ipc } = loadWith(t, { call: async (_m, p) => ({ success: true, data: p.value }) });
  assert.equal(await ipc.sidecarCall('x', { value: 0 }), 0);
  assert.equal(await ipc.sidecarCall('x', { value: null }), null);
  assert.equal(await ipc.sidecarCall('x', { value: '' }), '');
  assert.equal(await ipc.sidecarCall('x', {}), undefined);
});

test('a broken bridge (the call itself rejects) reaches the caller', async t => {
  const { ipc } = loadWith(t, { call: async () => { throw new Error('Engine stopped (exit code 3221225477)'); } });
  await assert.rejects(ipc.sidecarCall('list_photos', {}), { message: 'Engine stopped (exit code 3221225477)' });
});

test('exportMessagesPdf returns the files written, or throws', async t => {
  const done = { files: ['C:\\Users\\Jane\\Desktop\\Mom.pdf'], message_count: 1532 };
  const { ipc, calls } = loadWith(t, {
    exportPdf: async (method, params) => {
      if (params.chat_id === 1) return { success: true, data: done };
      if (params.chat_id === 2) return { success: false, error: 'No printer-ready page' };
      if (params.chat_id === 3) return { success: true };
      return { success: false };
    },
  });
  assert.deepEqual(await ipc.exportMessagesPdf('export_conversation', { chat_id: 1 }), done);
  assert.deepEqual(calls[0], ['exportPdf', 'export_conversation', { chat_id: 1 }]);
  await assert.rejects(ipc.exportMessagesPdf('export_conversation', { chat_id: 2 }), { message: 'No printer-ready page' });
  await assert.rejects(ipc.exportMessagesPdf('export_conversation', { chat_id: 3 }), { message: 'PDF export failed' });
  await assert.rejects(ipc.exportMessagesPdf('export_conversations', { chat_id: 4 }), { message: 'PDF export failed' });
});

test('folder pickers pass the chosen folder through, or null when cancelled', async t => {
  const { ipc } = loadWith(t, { selectFolder: async () => '/Volumes/Backup Drive/MobileSync', saveFolder: async () => null });
  assert.equal(await ipc.selectFolder(), '/Volumes/Backup Drive/MobileSync');
  assert.equal(await ipc.saveFolder(), null);
});

test('outside Electron, calls fail with how to start the app, and pickers give null', async t => {
  const warn = t.mock.method(console, 'warn', () => {});
  const loaded = [];
  // No window at all (plain Node)
  assert.equal(typeof globalThis.window, 'undefined');
  loaded.push(loadTs('src/lib/ipc.ts'));
  // A window without the preload bridge (the renderer opened in a browser)
  globalThis.window = {};
  try { loaded.push(loadTs('src/lib/ipc.ts')); } finally { delete globalThis.window; }

  for (const ipc of loaded) {
    await assert.rejects(ipc.sidecarCall('list_backups'), { message: 'Not running in Electron. Start with: npm run dev' });
    await assert.rejects(ipc.exportMessagesPdf('export_conversation', {}), { message: 'Not running in Electron. Start with: npm run dev' });
    assert.equal(await ipc.selectFolder(), null);
    assert.equal(await ipc.saveFolder(), null);
  }
  assert.equal(warn.mock.callCount(), 2);
  assert.match(warn.mock.calls[0].arguments[0], /sidecar\.list_backups/);
});
