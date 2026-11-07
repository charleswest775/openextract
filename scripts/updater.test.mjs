// Tests for electron/updater.ts: the auto-update states the renderer sees, the
// updates:* IPC handlers, and the promise that nothing is checked until the user
// opts in. electron and electron-updater are stubbed (test-helpers/electron-env.mjs).
// Run with: node --test scripts/updater.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createElectron, loadElectronModule, captureLongTimers, freshDir, flush } from './test-helpers/electron-env.mjs';

const ZERO_ID = '00000000-0000-0000-0000-000000000000';

function fakeAutoUpdater({ active = true } = {}) {
  const au = new EventEmitter();
  au.calls = [];
  au.isUpdaterActive = () => active;
  // What a check or download does; tests replace these to emit electron-updater's events.
  au.onCheck = async () => {};
  au.onDownload = async () => {};
  au.checkForUpdates = async () => {
    au.calls.push('checkForUpdates');
    return au.onCheck();
  };
  au.downloadUpdate = async () => {
    au.calls.push('downloadUpdate');
    return au.onDownload();
  };
  au.quitAndInstall = (...args) => au.calls.push(['quitAndInstall', ...args]);
  return au;
}

/**
 * Load a fresh updater.ts and call initUpdater. `autoCheck` is the stored
 * updatesAutoCheck value (undefined = never stored, like a new install).
 */
async function setup({ isPackaged = true, active = true, autoCheck, flatpak = false, window = true, userData } = {}) {
  userData ??= freshDir('updater-userdata');
  const env = createElectron({ paths: { userData }, isPackaged });
  const autoUpdater = fakeAutoUpdater({ active });
  const { module: updater } = loadElectronModule('updater', {
    electron: env.electron,
    'electron-updater': { autoUpdater },
  });

  const data = new Map();
  if (autoCheck !== undefined) data.set('updatesAutoCheck', autoCheck);
  const store = { get: (k, fallback) => (data.has(k) ? data.get(k) : fallback), set: (k, v) => data.set(k, v) };

  const win = window ? new env.electron.BrowserWindow({}) : null;
  const order = [];
  const beforeInstall = async () => {
    order.push('beforeInstall started');
    await new Promise(resolve => setTimeout(resolve, 20));
    order.push('beforeInstall finished');
  };
  autoUpdater.quitAndInstall = (...args) => {
    order.push('quitAndInstall');
    autoUpdater.calls.push(['quitAndInstall', ...args]);
  };

  const savedFlatpak = process.env.FLATPAK_ID;
  if (flatpak) process.env.FLATPAK_ID = 'app.openextract.OpenExtract';
  else delete process.env.FLATPAK_ID;
  let timers;
  try {
    ({ timers } = await captureLongTimers(() => updater.initUpdater({ store, getWindow: () => win, beforeInstall })));
  } finally {
    if (savedFlatpak === undefined) delete process.env.FLATPAK_ID;
    else process.env.FLATPAK_ID = savedFlatpak;
  }

  const statuses = () => (win ? win.webContents.sent.filter(([ch]) => ch === 'updates:status').map(([, s]) => s) : []);
  const networkCalls = () => autoUpdater.calls.filter(c => c === 'checkForUpdates' || c === 'downloadUpdate');
  return { env, invoke: env.invoke, autoUpdater, data, win, timers, order, statuses, networkCalls, userData };
}

/** Make a check find version 2.0.0, the way electron-updater reports it. */
function findsUpdate(autoUpdater, version = '2.0.0') {
  autoUpdater.onCheck = async () => {
    autoUpdater.emit('checking-for-update');
    autoUpdater.emit('update-available', { version });
  };
}

describe('no network unless the user opted in', () => {
  for (const [label, autoCheck] of [['never asked (no stored value)', undefined], ['never asked (null)', null], ['said no', false]]) {
    test(`nothing is checked or downloaded when the user ${label}`, async () => {
      const u = await setup({ autoCheck });
      assert.equal(u.timers.length, 0, 'a startup check was scheduled');
      const state = await u.invoke('updates:get-state');
      assert.equal(state.autoCheck, autoCheck ?? null);
      await u.invoke('updates:download');
      await u.invoke('updates:install');
      await u.invoke('updates:set-auto-check', false);
      await flush();
      assert.deepEqual(u.networkCalls(), []);
      assert.deepEqual(u.statuses(), []);
      assert.equal(u.data.get('updatesAutoCheck'), false);
    });
  }

  test('electron-updater is set up to never download on its own and to send no install id', async () => {
    const u = await setup();
    assert.equal(u.autoUpdater.autoDownload, false);
    assert.equal(u.autoUpdater.allowPrerelease, false);
    assert.equal(u.autoUpdater.autoInstallOnAppQuit, true);
    assert.equal(await u.autoUpdater.getOrCreateStagingUserId(), ZERO_ID);
    assert.deepEqual(u.networkCalls(), []);
  });

  test('with automatic checks on, one check runs 10 seconds after startup', async () => {
    const u = await setup({ autoCheck: true });
    assert.deepEqual(u.timers.map(t => t.ms), [10_000]);
    assert.deepEqual(u.networkCalls(), [], 'checked before the delay');
    u.timers[0].cb();
    await flush();
    assert.deepEqual(u.networkCalls(), ['checkForUpdates']);
  });

  test('turning automatic checks on remembers it and checks right away', async () => {
    const u = await setup({ autoCheck: null });
    await u.invoke('updates:set-auto-check', true);
    await flush();
    assert.equal(u.data.get('updatesAutoCheck'), true);
    assert.deepEqual(u.networkCalls(), ['checkForUpdates']);
    assert.equal((await u.invoke('updates:get-state')).autoCheck, true);
  });

  test('the Check for updates button checks, whatever the automatic setting', async () => {
    const u = await setup({ autoCheck: false });
    await u.invoke('updates:check');
    assert.deepEqual(u.networkCalls(), ['checkForUpdates']);
    assert.equal(u.data.get('updatesAutoCheck'), false);
  });
});

describe('builds that can\'t update themselves', () => {
  const cases = [
    ['a development build', { isPackaged: false }, { flatpak: false }],
    ['a build electron-updater can\'t update (e.g. Linux outside an AppImage)', { active: false }, { flatpak: false }],
    ['a Flatpak', { flatpak: true }, { flatpak: true }],
  ];
  for (const [label, options, expected] of cases) {
    test(`${label} never checks, even with automatic checks on`, async () => {
      const u = await setup({ autoCheck: true, ...options });
      assert.equal(u.timers.length, 0);
      const state = await u.invoke('updates:get-state');
      assert.equal(state.supported, false);
      assert.equal(state.flatpak, expected.flatpak);
      await u.invoke('updates:check');
      await u.invoke('updates:set-auto-check', true);
      await u.invoke('updates:download');
      await flush();
      assert.deepEqual(u.networkCalls(), []);
    });
  }
});

describe('what the renderer sees', () => {
  test('get-state reports support, the setting, the version and the releases page', async () => {
    const u = await setup({ autoCheck: null });
    const state = await u.invoke('updates:get-state');
    assert.deepEqual(state, {
      supported: true,
      flatpak: false,
      autoCheck: null,
      currentVersion: '1.2.3',
      releasesUrl: state.releasesUrl,
      status: { state: 'idle' },
    });
    assert.match(state.releasesUrl, /^https:\/\/github\.com\/[^/]+\/openextract\/releases$/);
  });

  test('check, download and install: each state reaches the window, and the engine stops before installing', async () => {
    const u = await setup({ autoCheck: false });
    findsUpdate(u.autoUpdater);
    await u.invoke('updates:check');
    let seen = u.statuses();
    assert.deepEqual(seen.map(s => s.state), ['checking', 'available']);
    assert.equal(seen[1].version, '2.0.0');
    assert.ok(!Number.isNaN(Date.parse(seen[1].checkedAt)), 'checkedAt is a date');
    assert.deepEqual((await u.invoke('updates:get-state')).status, seen[1]);

    u.autoUpdater.onDownload = async () => {
      u.autoUpdater.emit('download-progress', { percent: 12.4 });
      u.autoUpdater.emit('download-progress', { percent: 99.6 });
      u.autoUpdater.emit('download-progress', {});
      u.autoUpdater.emit('update-downloaded', { version: '2.0.0' });
    };
    await u.invoke('updates:download');
    seen = u.statuses().slice(2);
    assert.deepEqual(
      seen.map(s => [s.state, s.percent]),
      [['downloading', 0], ['downloading', 12], ['downloading', 100], ['downloading', 0], ['downloaded', 100]],
    );
    assert.equal(seen.at(-1).version, '2.0.0');
    assert.deepEqual(u.networkCalls(), ['checkForUpdates', 'downloadUpdate']);

    await u.invoke('updates:install');
    // quitAndInstall waits for beforeInstall, then runs on the next turn.
    assert.deepEqual(u.order, ['beforeInstall started', 'beforeInstall finished']);
    await flush();
    assert.deepEqual(u.order, ['beforeInstall started', 'beforeInstall finished', 'quitAndInstall']);
    assert.deepEqual(u.autoUpdater.calls.at(-1), ['quitAndInstall', true, true]);
    assert.match(fs.readFileSync(path.join(u.userData, 'updater_log.txt'), 'utf-8'), /installing 2\.0\.0/);
  });

  test('a check that finds nothing says so, with the time it checked', async () => {
    const u = await setup();
    u.autoUpdater.onCheck = async () => {
      u.autoUpdater.emit('checking-for-update');
      u.autoUpdater.emit('update-not-available', { version: '1.2.3' });
    };
    await u.invoke('updates:check');
    const last = u.statuses().at(-1);
    assert.equal(last.state, 'not-available');
    assert.ok(!Number.isNaN(Date.parse(last.checkedAt)));
  });

  for (const busy of ['checking', 'downloading', 'downloaded']) {
    test(`a second check while ${busy} is ignored`, async () => {
      const u = await setup();
      findsUpdate(u.autoUpdater);
      if (busy === 'checking') {
        u.autoUpdater.emit('checking-for-update');
      } else {
        await u.invoke('updates:check');
        await u.invoke('updates:download'); // downloading until an event says otherwise
        if (busy === 'downloaded') u.autoUpdater.emit('update-downloaded', { version: '2.0.0' });
      }
      assert.equal((await u.invoke('updates:get-state')).status.state, busy);
      const before = u.networkCalls().length;
      await u.invoke('updates:check');
      assert.equal(u.networkCalls().length, before);
    });
  }

  test('download and install do nothing until there is something to download or install', async () => {
    const u = await setup();
    await u.invoke('updates:download'); // idle
    await u.invoke('updates:install'); // idle
    findsUpdate(u.autoUpdater);
    await u.invoke('updates:check');
    await u.invoke('updates:install'); // available, not downloaded
    await flush();
    assert.deepEqual(u.networkCalls(), ['checkForUpdates']);
    assert.deepEqual(u.order, []);
  });

  test('a closed window or no window doesn\'t break anything, and the state is still kept', async () => {
    const none = await setup({ window: false });
    findsUpdate(none.autoUpdater);
    await none.invoke('updates:check');
    assert.equal((await none.invoke('updates:get-state')).status.state, 'available');

    const closed = await setup();
    closed.win.destroyed = true;
    findsUpdate(closed.autoUpdater);
    await closed.invoke('updates:check');
    assert.deepEqual(closed.statuses(), []);
    assert.equal((await closed.invoke('updates:get-state')).status.state, 'available');
  });
});

describe('errors', () => {
  const cases = [
    ['net::ERR_INTERNET_DISCONNECTED', /check your internet connection/i],
    ['getaddrinfo ENOTFOUND github.com', /check your internet connection/i],
    ['connect ETIMEDOUT 140.82.112.3:443', /check your internet connection/i],
    ['Cannot update while running on a read-only volume', /Applications folder/],
    ['The app is translocated', /Applications folder/],
    ['New version 2.0.0 is not signed by the application owner: publisherNames: Someone', /signature check/],
    ['sha512 checksum mismatch, expected abc, got def', /download the latest version from openextract\.app/],
  ];
  for (const [raw, friendly] of cases) {
    test(`"${raw}" reaches the renderer as a plain message`, async () => {
      const u = await setup();
      u.autoUpdater.onCheck = async () => {
        u.autoUpdater.emit('checking-for-update');
        const err = new Error(raw);
        u.autoUpdater.emit('error', err);
        throw err; // electron-updater both emits and rejects
      };
      await u.invoke('updates:check'); // resolves: the renderer hears through updates:status
      const last = u.statuses().at(-1);
      assert.equal(last.state, 'error');
      assert.match(last.error, friendly);
      assert.ok(!last.error.includes(raw), 'the raw error text leaked to the user');
      // The raw error goes to the updater log for diagnosis.
      assert.ok(fs.readFileSync(path.join(u.userData, 'updater_log.txt'), 'utf-8').includes(raw));
    });
  }

  test('errors that aren\'t Error objects still get a message', async () => {
    const u = await setup();
    u.autoUpdater.emit('error', 'something odd');
    u.autoUpdater.emit('error', undefined);
    const seen = u.statuses();
    assert.deepEqual(seen.map(s => s.state), ['error', 'error']);
    for (const s of seen) assert.match(s.error, /openextract\.app/);
  });

  test('a failed download is reported and doesn\'t throw to the renderer', async () => {
    const u = await setup();
    findsUpdate(u.autoUpdater);
    await u.invoke('updates:check');
    u.autoUpdater.onDownload = async () => {
      const err = new Error('net::ERR_CONNECTION_RESET');
      u.autoUpdater.emit('error', err);
      throw err;
    };
    await u.invoke('updates:download');
    const last = u.statuses().at(-1);
    assert.equal(last.state, 'error');
    assert.match(last.error, /internet connection/);
  });

  test('checking again after an error clears the error', async () => {
    const u = await setup();
    u.autoUpdater.emit('error', new Error('getaddrinfo EAI_AGAIN github.com'));
    findsUpdate(u.autoUpdater);
    await u.invoke('updates:check');
    const [, checking, available] = u.statuses();
    assert.equal(checking.state, 'checking');
    assert.equal(checking.error, undefined);
    assert.equal(available.state, 'available');
  });

  test('the updater log never breaks the app', async () => {
    const u = await setup({ userData: path.join(freshDir('gone'), 'missing', 'deeper') });
    assert.doesNotThrow(() => u.autoUpdater.logger.info('Checking for update'));
    assert.doesNotThrow(() => u.autoUpdater.logger.error(new Error('x')));
    assert.equal(u.autoUpdater.logger.debug('ignored'), undefined);

    const ok = await setup();
    ok.autoUpdater.logger.warn('a warning');
    assert.match(fs.readFileSync(path.join(ok.userData, 'updater_log.txt'), 'utf-8'), /warn {2}a warning/);
  });
});
