// electron/recentBackups.ts: which remembered backups the home screen lists. A backup deleted
// since it was opened is left out (in-app report OE-214); one on a drive that isn't plugged in,
// or one the system won't say anything about, stays.
// Run with: node --test scripts/recent-backups.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { freshDir, loadElectronModule } from './test-helpers/electron-env.mjs';

const { backupFolderState, listedSessions, FOLDER_CHECK_MS } = loadElectronModule('recentBackups').module;

const err = code => Object.assign(new Error(code), { code });
const dirStat = { isDirectory: () => true };
const fileStat = { isDirectory: () => false };

/** A stat that answers from a map of path → stat object or error code; anything else is ENOENT. */
function fakeStat(answers) {
  const asked = [];
  const stat = async p => {
    asked.push(p);
    const a = answers[p];
    if (a === undefined) throw err('ENOENT');
    if (typeof a === 'string') throw err(a);
    if (typeof a === 'function') return a();
    return a;
  };
  return { stat, asked };
}

describe('backupFolderState on real folders', () => {
  test('a backup whose folder is there', async () => {
    const dir = path.join(freshDir('backups'), '00008030-001A');
    fs.mkdirSync(dir);
    assert.equal(await backupFolderState(dir), 'here');
  });

  test('a backup deleted from the folder it was in is gone', async () => {
    const parent = freshDir('backups');
    const dir = path.join(parent, '00008030-001A');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'Manifest.db'), '');
    fs.rmSync(dir, { recursive: true });
    assert.equal(await backupFolderState(dir), 'gone');
  });

  test('a backup on a drive that is not plugged in (its folder and the one above are both missing) is unknown', async () => {
    const drive = path.join(freshDir('volumes'), 'Backup Drive');
    assert.equal(await backupFolderState(path.join(drive, 'iPhone Backups', '00008030-001A')), 'unknown');
  });

  test('a path through what is now a file: unknown, since the folder above isn\'t a folder', async () => {
    const parent = freshDir('backups');
    fs.writeFileSync(path.join(parent, 'not-a-folder'), '');
    assert.equal(await backupFolderState(path.join(parent, 'not-a-folder', 'udid')), 'unknown');
  });

  test('no folder saved (sessions from before folders were kept) is unknown', async () => {
    for (const dir of [undefined, null, '', 42, {}]) assert.equal(await backupFolderState(dir), 'unknown', String(dir));
  });
});

describe('backupFolderState when the system won\'t say', () => {
  test('macOS privacy controls (EPERM) or a locked folder (EACCES) keep it listed, and nothing more is asked', async () => {
    for (const code of ['EPERM', 'EACCES', 'EBUSY', 'EIO', 'UNKNOWN']) {
      const { stat, asked } = fakeStat({ '/MobileSync/Backup/udid': code, '/MobileSync/Backup': dirStat });
      assert.equal(await backupFolderState('/MobileSync/Backup/udid', stat), 'unknown', code);
      assert.deepEqual(asked, ['/MobileSync/Backup/udid'], code);
    }
  });

  test('ENOTDIR counts as not there', async () => {
    const { stat } = fakeStat({ '/Backups/udid': 'ENOTDIR', '/Backups': dirStat });
    assert.equal(await backupFolderState('/Backups/udid', stat), 'gone');
  });

  test('the folder above can\'t be read: unknown', async () => {
    const { stat } = fakeStat({ '/Backups': 'EPERM' });
    assert.equal(await backupFolderState('/Backups/udid', stat), 'unknown');
  });

  test('the folder above is a file: unknown', async () => {
    const { stat } = fakeStat({ '/Backups': fileStat });
    assert.equal(await backupFolderState('/Backups/udid', stat), 'unknown');
  });

  test('a backup at the top of a drive that is gone: unknown, never "gone"', async () => {
    const { stat } = fakeStat({});
    assert.equal(await backupFolderState('/', stat), 'unknown');
  });

  test('a network folder that doesn\'t answer stays listed, without holding up the list', async () => {
    const never = () => new Promise(() => {});
    const { stat } = fakeStat({ '\\\\nas\\backups\\udid': never });
    const t0 = Date.now();
    assert.equal(await backupFolderState('\\\\nas\\backups\\udid', stat, 50), 'unknown');
    assert.ok(Date.now() - t0 < 1000);
    // The same when the folder is missing and the one above is what hangs.
    const slowParent = fakeStat({ '/net/backups': never });
    assert.equal(await backupFolderState('/net/backups/udid', slowParent.stat, 50), 'unknown');
    assert.ok(FOLDER_CHECK_MS >= 1000 && FOLDER_CHECK_MS <= 5000, String(FOLDER_CHECK_MS));
  });
});

describe('listedSessions', () => {
  test('leaves out only deleted backups and keeps the order', async () => {
    const states = { a: 'here', b: 'gone', c: 'unknown', d: 'gone' };
    const sessions = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, backupDir: id === 'e' ? undefined : id }));
    const listed = await listedSessions(sessions, async dir => states[dir] ?? 'unknown');
    assert.deepEqual(listed.map(s => s.id), ['a', 'c', 'e']);
  });

  test('a check that throws keeps the backup listed', async () => {
    const listed = await listedSessions([{ id: 'a', backupDir: 'x' }], async () => { throw new Error('boom'); });
    assert.deepEqual(listed.map(s => s.id), ['a']);
  });

  test('checks every folder at once, not one after another', async () => {
    let running = 0;
    let most = 0;
    const stateOf = async () => {
      running++;
      most = Math.max(most, running);
      await new Promise(r => setTimeout(r, 20));
      running--;
      return 'here';
    };
    await listedSessions(Array.from({ length: 5 }, (_, i) => ({ id: String(i), backupDir: String(i) })), stateOf);
    assert.equal(most, 5);
  });

  test('on real folders', async () => {
    const parent = freshDir('backups');
    const here = path.join(parent, 'here');
    fs.mkdirSync(here);
    const sessions = [
      { id: 'here', backupDir: here },
      { id: 'deleted', backupDir: path.join(parent, 'deleted') },
      { id: 'unplugged', backupDir: path.join(parent, 'Drive', 'Backups', 'udid') },
      { id: 'old', name: 'saved before folders were kept' },
    ];
    assert.deepEqual((await listedSessions(sessions)).map(s => s.id), ['here', 'unplugged', 'old']);
  });
});
