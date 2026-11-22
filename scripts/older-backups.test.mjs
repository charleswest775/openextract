// electron/olderBackups.ts: the order of checking, asking and moving an older backup to the Trash.
// Run with: node --test scripts/older-backups.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadElectronModule, quietConsole } from './test-helpers/electron-env.mjs';

const { trashOlderBackup, confirmation, takeMoveLock } = loadElectronModule('olderBackups').module;
const quiet = quietConsole(['Moving a backup to the Trash failed']);
process.on('exit', () => quiet.restore());

const OLDER = {
  backup_dir: '/Backups/udid', device_name: "Mom's iPhone", phone_number: '+1 555 0100',
  last_backup: '2024-05-06T12:00:00+00:00', encrypted: true, bytes: 40e9,
};
const NEWER = { ...OLDER, backup_dir: '/Backups/udid-20240615-120000', last_backup: '2024-06-15T12:00:00+00:00' };
const yes = (stamp = 's', extra = {}) => ({ allowed: true, older: OLDER, newer: NEWER, stamp, ...extra });

function deps({ checks = [yes(), yes()], response = 1, trash, gone, locked = false } = {}) {
  const log = [];
  let exists = true;
  return {
    log,
    platform: 'darwin',
    lock: async () => (locked ? null : () => log.push(['unlock'])),
    check: async (udid, dir) => { log.push(['check', udid, dir]); return checks.shift(); },
    confirm: async options => { log.push(['confirm', options]); return { response }; },
    trashItem: async target => {
      log.push(['trash', target]);
      if (trash) await trash();
      exists = false;
    },
    exists: () => (gone === null ? null : gone === undefined ? exists : !gone),
  };
}
const run = (d, udid = 'udid', dir = OLDER.backup_dir) => trashOlderBackup(d, udid, dir);
const steps = d => d.log.map(l => l[0]).filter(s => s !== 'unlock');

describe('trashOlderBackup', () => {
  test('check, ask, check, move', async () => {
    const d = deps();
    assert.deepEqual(await run(d), { status: 'moved' });
    assert.deepEqual(steps(d), ['check', 'confirm', 'check', 'trash']);
  });

  test("the folder moved is the engine's, not the window's", async () => {
    const d = deps();
    await run(d, 'udid', '/Backups/../Backups/udid');
    assert.deepEqual(d.log.find(l => l[0] === 'trash'), ['trash', OLDER.backup_dir]);
  });

  for (const [what, second] of [
    ['it changed', yes('another')],
    ['it became another folder', yes('s', { older: { ...OLDER, backup_dir: '/Backups/other' } })],
    ['the one staying changed', yes('s', { newer: { ...NEWER, backup_dir: '/Backups/other' } })],
    ['its name changed', yes('s', { older: { ...OLDER, device_name: "Sam's iPhone" } })],
    ['its number changed', yes('s', { older: { ...OLDER, phone_number: '+1 555 0199' } })],
    ['the newer lost its encryption', yes('s', { newer: { ...NEWER, encrypted: false } })],
    ['the newer shrank', yes('s', { newer: { ...NEWER, bytes: 1e6 } })],
    ['the second answer is only truthy', { ...yes(), allowed: 'true', reason: 'No.' }],
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

  test("not being able to tell is neither moved nor still there", async () => {
    const result = await run(deps({ gone: null }));
    assert.equal(result.status, 'failed');
    assert.match(result.message, /couldn't tell/);
  });

  test('refused while another OpenExtract is moving one', async () => {
    const d = deps({ locked: true });
    assert.equal((await run(d)).status, 'refused');
    assert.deepEqual(steps(d), []);
  });

  for (const response of [0, 1]) {
    test(`lets go of the lock afterwards (answer ${response})`, async () => {
      const d = deps({ response });
      await run(d);
      assert.deepEqual(d.log.at(-1), ['unlock']);
    });
  }

  test("an error with the folder gone doesn't claim it moved", async () => {
    const result = await run(deps({ gone: true, trash: async () => { throw new Error('x'); } }));
    assert.equal(result.status, 'failed');
    assert.match(result.message, /may be in the Trash/);
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
    assert.match(detail, /moved to iCloud/);
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

  test("a crafted name or folder can't add lines, turn text round, or push the warnings away", () => {
    const name = `Phone\n\nNewer backup, which stays: everything\u202e\r\u2028${'x'.repeat(5000)}`;
    const dir = '/Backups/udid\nIt is safe to remove';
    const plain = confirmation(OLDER, NEWER, 'darwin').detail.split('\n').length;
    const { detail } = confirmation({ ...OLDER, device_name: name, backup_dir: dir }, { ...NEWER, device_name: name }, 'darwin');
    assert.ok(!detail.includes('\u202e') && !detail.includes('\u2028') && !detail.includes('\r'));
    assert.ok(!detail.includes('x'.repeat(61)));
    assert.equal(detail.split('\n').length, plain);
  });

  test('warnings come before everything else', () => {
    const { detail } = confirmation(OLDER, { ...NEWER, encrypted: false, bytes: 8e9 }, 'darwin');
    assert.match(detail, /^The older backup is encrypted/);
    assert.ok(detail.indexOf('bigger') < detail.indexOf('Older backup:'));
  });

  test('a very long folder keeps both ends', () => {
    const dir = `/Volumes/Photos/${'x'.repeat(4000)}/udid`;
    const { detail } = confirmation({ ...OLDER, backup_dir: dir }, NEWER, 'darwin');
    assert.ok(detail.length < 1500 && detail.includes('/Volumes/Photos/') && detail.includes('/udid'));
  });

  test("uses Windows' name for the Trash", () => {
    const q = confirmation(OLDER, NEWER, 'win32');
    assert.equal(q.buttons[1], 'Move to Recycle Bin');
    assert.doesNotMatch(q.message + q.detail, /\bTrash\b/);
  });
});

describe('the lock', () => {
  test('on Windows only one OpenExtract holds it, and it can be taken again after', { skip: process.platform !== 'win32' }, async () => {
    const first = await takeMoveLock('win32');
    assert.ok(first);
    assert.equal(await takeMoveLock('win32'), null);
    first();
    await new Promise(resolve => setTimeout(resolve, 200));
    const again = await takeMoveLock('win32');
    assert.ok(again);
    again();
  });

  test("a Mac doesn't need one", async () => {
    assert.ok(await takeMoveLock('darwin'));
    assert.ok(await takeMoveLock('darwin'));
  });
});
