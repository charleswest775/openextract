// electron/olderBackups.ts: the order of checking, asking and moving an older backup to the Trash.
// Run with: node --test scripts/older-backups.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadElectronModule, quietConsole } from './test-helpers/electron-env.mjs';

const { trashOlderBackup, confirmation } = loadElectronModule('olderBackups').module;
const quiet = quietConsole(['Moving a backup to the Trash failed']);
process.on('exit', () => quiet.restore());

const OLDER = {
  backup_dir: '/Backups/udid', device_name: "Mom's iPhone", phone_number: '+1 555 0100',
  last_backup: '2024-05-06T12:00:00+00:00', encrypted: true, bytes: 40e9,
};
const NEWER = { ...OLDER, backup_dir: '/Backups/udid-20240615-120000', last_backup: '2024-06-15T12:00:00+00:00' };
const yes = (stamp = 's', extra = {}) => ({ allowed: true, older: OLDER, newer: NEWER, stamp, ...extra });

function deps({ checks = [yes(), yes()], response = 1, trash, gone } = {}) {
  const log = [];
  let exists = true;
  return {
    log,
    platform: 'darwin',
    check: async (udid, dir) => { log.push(['check', udid, dir]); return checks.shift(); },
    confirm: async options => { log.push(['confirm', options]); return { response }; },
    trashItem: async target => {
      log.push(['trash', target]);
      if (trash) await trash();
      exists = false;
    },
    exists: () => (gone === undefined ? exists : !gone),
  };
}
const run = (d, udid = 'udid', dir = OLDER.backup_dir) => trashOlderBackup(d, udid, dir);
const steps = d => d.log.map(l => l[0]);

describe('trashOlderBackup', () => {
  test('check, ask, check, move', async () => {
    const d = deps();
    assert.deepEqual(await run(d), { status: 'moved' });
    assert.deepEqual(steps(d), ['check', 'confirm', 'check', 'trash']);
  });

  test("the folder moved is the engine's, not the window's", async () => {
    const d = deps();
    await run(d, 'udid', '/Backups/../Backups/udid');
    assert.deepEqual(d.log.at(-1), ['trash', OLDER.backup_dir]);
  });

  for (const [what, second] of [
    ['it changed', yes('another')],
    ['it became another folder', yes('s', { older: { ...OLDER, backup_dir: '/Backups/other' } })],
    ['the one staying changed', yes('s', { newer: { ...NEWER, backup_dir: '/Backups/other' } })],
    ["the engine won't allow it now", { allowed: false, reason: 'The Recycle Bin filled up.' }],
  ]) {
    test(`nothing moves if, while the dialog was up, ${what}`, async () => {
      const d = deps({ checks: [yes(), second] });
      assert.equal((await run(d)).status, 'refused');
      assert.deepEqual(steps(d), ['check', 'confirm', 'check']);
    });
  }

  for (const allowed of [false, undefined, 'true', 1]) {
    test(`only allowed: true counts, not ${JSON.stringify(allowed)}`, async () => {
      const d = deps({ checks: [{ ...yes(), allowed, reason: 'No.' }] });
      assert.equal((await run(d)).status, 'refused');
      assert.deepEqual(steps(d), ['check']);
    });
  }

  for (const [udid, dir] of [['', '/x'], ['udid', ''], [null, '/x'], ['udid', { toString: () => '/x' }], ['udid', ['/x']]]) {
    test(`bad input is refused unasked: ${JSON.stringify([udid, dir])}`, async () => {
      const d = deps();
      assert.equal((await run(d, udid, dir)).status, 'refused');
      assert.deepEqual(steps(d), []);
    });
  }

  test('one at a time', async () => {
    let answer;
    const first = deps();
    first.confirm = () => new Promise(resolve => { answer = resolve; });
    const running = run(first);
    await new Promise(resolve => setImmediate(resolve));
    const second = deps();
    assert.equal((await run(second)).status, 'refused');
    assert.deepEqual(steps(second), []);
    answer({ response: 0 });
    assert.deepEqual(await running, { status: 'cancelled' });
    assert.equal((await run(deps())).status, 'moved', 'free again afterwards');
  });

  test('free again after the check throws', async () => {
    const d = deps();
    d.check = async () => { throw new Error('engine stopped'); };
    await assert.rejects(run(d));
    assert.equal((await run(deps())).status, 'moved');
  });

  test('a success that left the folder there is a failure', async () => {
    const result = await run(deps({ gone: false }));
    assert.equal(result.status, 'failed');
    assert.match(result.message, /still where it was/);
  });

  test("an error with the folder gone doesn't claim it moved", async () => {
    const result = await run(deps({ gone: true, trash: async () => { throw new Error('x'); } }));
    assert.equal(result.status, 'failed');
    assert.match(result.message, /Look for it in the Trash/);
  });
});

describe('the question', () => {
  test('keeping is the default, for Return and Esc', () => {
    const q = confirmation(OLDER, NEWER, 'darwin');
    assert.deepEqual(q.buttons, ['Keep it', 'Move to Trash']);
    assert.equal(q.defaultId, 0);
    assert.equal(q.cancelId, 0);
  });

  test('names both folders, and what is lost', () => {
    const { detail } = confirmation(OLDER, NEWER, 'darwin');
    assert.ok(detail.includes(`${OLDER.backup_dir}\n`) && detail.includes(NEWER.backup_dir));
    assert.match(detail, /only in the older one/);
    assert.doesNotMatch(detail, /encrypted|bigger|handed on/);
  });

  test('warns when only the older one is encrypted', () => {
    assert.match(confirmation(OLDER, { ...NEWER, encrypted: false }, 'darwin').detail, /only the older one has Health/);
  });

  test('warns when the older one is bigger', () => {
    assert.match(confirmation(OLDER, { ...NEWER, bytes: 8e9 }, 'darwin').detail, /bigger \(40\.0 GB, against 8\.0 GB\)/);
  });

  for (const change of [{ device_name: "Sam's iPhone" }, { phone_number: '+1 555 0199' }]) {
    test(`warns that the iPhone may have been handed on: ${Object.keys(change)}`, () => {
      assert.match(confirmation(OLDER, { ...NEWER, ...change }, 'darwin').detail, /only copy/);
    });
  }

  test("uses Windows' name for the Trash", () => {
    const q = confirmation(OLDER, NEWER, 'win32');
    assert.equal(q.buttons[1], 'Move to Recycle Bin');
    assert.doesNotMatch(q.message + q.detail, /\bTrash\b/);
  });
});
