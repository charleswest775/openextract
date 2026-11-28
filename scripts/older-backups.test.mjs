// electron/olderBackups.ts: the order of checking, asking and moving a backup to the Trash: an older
// one from inside a newer one, and any one from the home screen's list.
// Run with: node --test scripts/older-backups.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadElectronModule, quietConsole } from './test-helpers/electron-env.mjs';

const { trashOlderBackup, confirmation, takeMoveLock, trashBackup, backupConfirmation } = loadElectronModule('olderBackups').module;
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

  test('on Windows it says things deleted later can erase it for good', () => {
    assert.match(confirmation(OLDER, NEWER, 'win32').detail, /runs out of room.*for good, without asking/);
    assert.doesNotMatch(confirmation(OLDER, NEWER, 'darwin').detail, /runs out of room/);
  });

  test('says not to merge or replace when putting it back', () => {
    assert.match(confirmation(OLDER, NEWER, 'darwin').detail, /don't merge or replace/);
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

// ── Any backup on the home screen's list ────────────────────────────────────

const MINE = {
  backup_dir: '/Backups/udid', device_name: "Mom's iPhone", phone_number: '+1 555 0100',
  last_backup: '2024-05-06T12:00:00+00:00', encrypted: true, bytes: 40e9, unfinished: false,
};
const OTHER = { backup_dir: '/Backups/udid-20240615-120000', device_name: "Mom's iPhone", last_backup: '2024-06-15T12:00:00+00:00', encrypted: true, unfinished: false };
const OLDER_OTHER = { ...OTHER, backup_dir: '/Old/udid', last_backup: '2023-01-02T12:00:00+00:00' };
const allowed = (extra = {}) => ({ allowed: true, backup: MINE, others: [], more_others: 0, stamp: 's', ...extra });

function anyDeps({ checks = [allowed(), allowed()], response = 1, gone, locked = false, backingUp = [false, false], trash } = {}) {
  const log = [];
  let exists = true;
  return {
    log,
    platform: 'darwin',
    lock: async () => (locked ? null : () => log.push(['unlock'])),
    backingUp: () => { log.push(['backingUp']); return backingUp.shift() ?? false; },
    check: async dir => { log.push(['check', dir]); return checks.shift(); },
    confirm: async options => { log.push(['confirm', options]); return { response }; },
    release: async dir => { log.push(['release', dir]); },
    trashItem: async target => {
      log.push(['trash', target]);
      if (trash) await trash();
      exists = false;
    },
    exists: () => (gone === null ? null : gone === undefined ? exists : !gone),
  };
}
const anySteps = d => d.log.map(l => l[0]).filter(s => s !== 'unlock' && s !== 'backingUp');

describe('trashBackup', () => {
  test('check, ask, check, let go, move', async () => {
    const d = anyDeps();
    assert.deepEqual(await trashBackup(d, '/Backups/udid'), { status: 'moved' });
    assert.deepEqual(anySteps(d), ['check', 'confirm', 'check', 'release', 'trash']);
    assert.deepEqual(d.log.find(l => l[0] === 'release'), ['release', MINE.backup_dir]);
  });

  test("the folder moved is the engine's real one, not the window's", async () => {
    const d = anyDeps();
    await trashBackup(d, '/Backups/../Backups/udid/.');
    assert.deepEqual(d.log.filter(l => l[0] === 'check').map(l => l[1]), ['/Backups/../Backups/udid/.', '/Backups/../Backups/udid/.']);
    assert.deepEqual(d.log.find(l => l[0] === 'trash'), ['trash', MINE.backup_dir]);
  });

  test('a no, or closing the dialog, moves nothing and asks the engine nothing more', async () => {
    for (const response of [0, -1, 2]) {
      const d = anyDeps({ response });
      assert.deepEqual(await trashBackup(d, '/Backups/udid'), { status: 'cancelled' });
      assert.deepEqual(anySteps(d), ['check', 'confirm']);
    }
  });

  test("what the engine refuses isn't asked about", async () => {
    const d = anyDeps({ checks: [{ allowed: false, reason: 'Not that one.' }] });
    assert.deepEqual(await trashBackup(d, '/Backups/udid'), { status: 'refused', message: 'Not that one.' });
    assert.deepEqual(anySteps(d), ['check']);
  });

  for (const [what, later] of [
    ['the folder changed', allowed({ stamp: 'other' })],
    ['a newer backup appeared', allowed({ others: [OTHER] })],
    ['it got bigger', allowed({ backup: { ...MINE, bytes: 41e9 } })],
    ['the engine now refuses', { allowed: false, reason: 'No room now.' }],
  ]) {
    test(`nothing moves if, while the dialog was up, ${what}`, async () => {
      const d = anyDeps({ checks: [allowed(), later] });
      const result = await trashBackup(d, '/Backups/udid');
      assert.equal(result.status, 'refused');
      assert.ok(!anySteps(d).includes('trash') && !anySteps(d).includes('release'));
    });
  }

  test('refused while OpenExtract is making a backup, before or after the question', async () => {
    let d = anyDeps({ backingUp: [true] });
    let result = await trashBackup(d, '/Backups/udid');
    assert.equal(result.status, 'refused');
    assert.match(result.message, /making a backup/);
    assert.deepEqual(anySteps(d), []);

    d = anyDeps({ backingUp: [false, true] });
    result = await trashBackup(d, '/Backups/udid');
    assert.equal(result.status, 'refused');
    assert.deepEqual(anySteps(d), ['check', 'confirm']);
  });

  test('bad input is refused unasked', async () => {
    for (const dir of ['', null, undefined, 42, {}]) {
      const d = anyDeps();
      assert.equal((await trashBackup(d, dir)).status, 'refused');
      assert.deepEqual(anySteps(d), []);
    }
  });

  test('one move at a time, shared with the older-backup move', async () => {
    let letGo;
    const slow = anyDeps({ checks: [allowed(), allowed()] });
    slow.confirm = () => new Promise(resolve => { letGo = () => resolve({ response: 0 }); });
    const first = trashBackup(slow, '/Backups/udid');
    await new Promise(resolve => setImmediate(resolve));
    assert.match((await trashBackup(anyDeps(), '/Backups/udid')).message, /already moving/);
    assert.match((await trashOlderBackup(deps(), 'udid', OLDER.backup_dir)).message, /already moving/);
    letGo();
    assert.equal((await first).status, 'cancelled');
    assert.equal((await trashBackup(anyDeps(), '/Backups/udid')).status, 'moved');
  });

  test('refused while another OpenExtract is moving one', async () => {
    const d = anyDeps({ locked: true });
    assert.match((await trashBackup(d, '/Backups/udid')).message, /already moving/);
    assert.deepEqual(anySteps(d), []);
  });

  test('a success that left the folder there is a failure; not knowing is neither', async () => {
    let d = anyDeps({ gone: false });
    let result = await trashBackup(d, '/Backups/udid');
    assert.equal(result.status, 'failed');
    assert.match(result.message, /still where it was/);
    d = anyDeps({ gone: null });
    result = await trashBackup(d, '/Backups/udid');
    assert.equal(result.status, 'failed');
    assert.match(result.message, /couldn't tell/);
  });

  test('free again after the engine throws', async () => {
    const d = anyDeps();
    d.check = async () => { throw new Error('Sidecar exited'); };
    await assert.rejects(trashBackup(d, '/Backups/udid'));
    assert.equal((await trashBackup(anyDeps(), '/Backups/udid')).status, 'moved');
  });
});

describe('the question for any backup', () => {
  const ask = (extra = {}, platform = 'darwin') => backupConfirmation({ backup: MINE, others: [], more_others: 0, ...extra }, platform);

  test('keeping is the default, for Return and Esc', () => {
    const q = ask();
    assert.deepEqual(q.buttons, ['Keep it', 'Move to Trash']);
    assert.equal(q.defaultId, 0);
    assert.equal(q.cancelId, 0);
    assert.match(q.message, /^Move the backup of Mom's iPhone from .+ to the Trash\?$/);
  });

  test('with no other backup of the iPhone, says first that it may be the only copy', () => {
    const q = ask();
    assert.match(q.detail.split('\n\n')[0], /no other backup of this iPhone.*only copy/);
    assert.match(q.detail, /\/Backups\/udid/);
    assert.match(q.detail, /40\.0 GB/);
    assert.doesNotMatch(q.detail, /Other backups of this iPhone/);
  });

  test('with only older ones, says first that this is the newest', () => {
    const q = ask({ others: [OLDER_OTHER] });
    assert.match(q.detail.split('\n\n')[0], /newest backup of this iPhone/);
    assert.match(q.detail, /Other backups of this iPhone, which stay:\n.+\n\/Old\/udid/);
  });

  test('with a newer one, names it and what may be only in this one', () => {
    const q = ask({ others: [OTHER, OLDER_OTHER] });
    const first = q.detail.split('\n\n')[0];
    assert.match(first, /A newer backup of this iPhone, from .+, stays/);
    assert.match(first, /deleted or moved to iCloud/);
  });

  test("one that didn't finish isn't counted as a copy that stays", () => {
    const unfinished = { ...OTHER, unfinished: true };
    assert.match(ask({ others: [unfinished] }).detail.split('\n\n')[0], /didn't finish, so this may be the only whole copy/);
    assert.match(ask({ others: [unfinished, OLDER_OTHER] }).detail.split('\n\n')[0], /newest backup of this iPhone/);
    assert.doesNotMatch(ask({ others: [unfinished] }).detail, /A newer backup/);
  });

  test('counts the others it had no room to name', () => {
    assert.match(ask({ others: [OTHER], more_others: 4 }).detail, /and 4 more/);
  });

  test('warns when only this one is encrypted', () => {
    assert.match(ask({ others: [{ ...OTHER, encrypted: false }] }).detail, /only this one has Health data/);
    assert.doesNotMatch(ask({ others: [OTHER] }).detail, /Health data/);
    assert.doesNotMatch(ask().detail, /Health data/, 'with no others, "only copy" already says it');
  });

  test("says when it didn't finish", () => {
    assert.match(ask({ backup: { ...MINE, unfinished: true } }).detail, /didn't finish/);
    assert.doesNotMatch(ask().detail, /didn't finish/);
  });

  test("a crafted name or folder can't add lines or turn text round", () => {
    const q = ask({ backup: { ...MINE, device_name: 'Evil\n\nMove it, nothing is lost\u202e', backup_dir: '/x\n\nsafe' } });
    assert.ok(!q.message.includes('\n') && !q.message.includes('\u202e'));
    assert.match(q.detail.split('\n\n')[0], /only copy/);
    assert.ok(!q.detail.includes('\n\nMove it') && !q.detail.includes('\n\nsafe'));
  });

  test('no name or date still reads', () => {
    const q = ask({ backup: { ...MINE, device_name: '', last_backup: '' } });
    assert.match(q.message, /^Move the backup of this iPhone from an unknown date to the Trash\?$/);
  });

  test("on Windows: the Recycle Bin's name, and that later deletions can erase it for good", () => {
    const q = ask({}, 'win32');
    assert.equal(q.buttons[1], 'Move to Recycle Bin');
    assert.doesNotMatch(q.message + q.detail, /\bTrash\b/);
    assert.match(q.detail, /erases the oldest for good/);
  });

  test('says not to merge or replace when putting it back, and not to move it while copying', () => {
    assert.match(ask().detail, /don't merge or replace/);
    assert.match(ask().detail, /being restored or copied/);
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
