// Tests for electron/syncedFolder.ts: whether a chosen backup folder is in OneDrive, iCloud
// Drive, Dropbox or Google Drive, and the note a not-enough-space error gets then (OE-212).
// The handler and the error in main.ts are tested in main-ipc.test.mjs ("synced folders").
// Run with: node --test scripts/synced-folder.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadElectronModule, freshDir } from './test-helpers/electron-env.mjs';

const { module: lib } = loadElectronModule('syncedFolder');
const { syncedFolderService, syncedFolderAt, withSyncedFolderNote, syncedFolderNote, NOT_ENOUGH_SPACE } = lib;

const WIN_HOME = 'C:\\Users\\Ana';
const win = (folder, env = {}) => syncedFolderService(folder, { platform: 'win32', env, home: WIN_HOME });
const mac = (folder, env = {}) => syncedFolderService(folder, { platform: 'darwin', env, home: '/Users/ana' });

describe('Windows', () => {
  test('OneDrive\'s own folders, wherever they are, by the variables OneDrive sets', () => {
    const env = { OneDrive: 'D:\\Cloud\\Ana', OneDriveCommercial: 'C:\\Users\\Ana\\Contoso Files' };
    assert.equal(win('D:\\Cloud\\Ana\\iPhone backup', env), 'OneDrive');
    assert.equal(win('D:\\Cloud\\Ana', env), 'OneDrive');
    assert.equal(win('c:\\users\\ana\\contoso files\\Backups', env), 'OneDrive'); // case doesn't matter
    assert.equal(win('D:\\Cloud\\Ana2\\Backups', env), null); // only starts the same way
    assert.equal(win('D:\\Cloud', env), null); // above it
  });

  test('a folder named like OneDrive\'s, Dropbox\'s, iCloud\'s or Google Drive\'s', () => {
    assert.equal(win('C:\\Users\\Ana\\OneDrive\\Documents\\Backups'), 'OneDrive'); // Documents moved into OneDrive
    assert.equal(win('C:\\Users\\Ana\\OneDrive - Contoso\\iPhone'), 'OneDrive');
    assert.equal(win('C:\\Users\\Ana\\Dropbox\\Phone'), 'Dropbox');
    assert.equal(win('C:\\Users\\Ana\\Dropbox (Personal)'), 'Dropbox');
    assert.equal(win('C:\\Users\\Ana\\iCloudDrive\\Backups'), 'iCloud Drive');
    assert.equal(win('C:\\Users\\Ana\\Google Drive\\Backups'), 'Google Drive');
    assert.equal(win('G:\\My Drive\\iPhone'), 'Google Drive'); // Google Drive for desktop's own drive
  });

  test('ordinary folders and external drives are not synced', () => {
    for (const folder of [
      'C:\\Users\\Ana\\Documents\\iPhone backups',
      'E:\\Backups',
      'E:\\OneDrive backup of my photos', // only part of a name
      'D:\\Backups\\My Drive', // "My Drive" deeper down is just a name
      '\\\\nas\\share\\Backups',
      '',
    ]) {
      assert.equal(win(folder), null, folder);
    }
  });
});

describe('macOS', () => {
  test('apps in ~/Library/CloudStorage, named by the app', () => {
    assert.equal(mac('/Users/ana/Library/CloudStorage/OneDrive-Personal/Backups'), 'OneDrive');
    assert.equal(mac('/Users/ana/Library/CloudStorage/OneDrive-Contoso'), 'OneDrive');
    assert.equal(mac('/Users/ana/Library/CloudStorage/Dropbox/Phone'), 'Dropbox');
    assert.equal(mac('/Users/ana/Library/CloudStorage/GoogleDrive-ana@example.com/My Drive'), 'Google Drive');
    assert.equal(mac('/Users/ana/Library/CloudStorage/Box-Box/Backups'), 'Box');
    assert.equal(mac('/Users/ana/Library/CloudStorage/pCloud-Drive/Backups'), 'pCloud');
    assert.equal(mac('/Users/ana/Library/CloudStorage'), null); // the folder of folders itself
  });

  test('iCloud Drive', () => {
    assert.equal(mac('/Users/ana/Library/Mobile Documents/com~apple~CloudDocs/Backups'), 'iCloud Drive');
  });

  test('older apps\' folders in the home folder, and ordinary folders', () => {
    assert.equal(mac('/Users/ana/Dropbox/Backups'), 'Dropbox');
    assert.equal(mac('/Users/ana/OneDrive'), 'OneDrive');
    assert.equal(mac('/Users/ana/Documents/Backups'), null);
    assert.equal(mac('/Volumes/Backup Drive/iPhone'), null);
    assert.equal(mac('/Users/ana/Library/Application Support/MobileSync/Backup'), null);
  });

  test('OneDrive\'s Windows variables mean nothing on a Mac', () => {
    assert.equal(mac('/Users/ana/Backups', { OneDrive: '/Users/ana/Backups' }), null);
  });
});

describe('syncedFolderAt (this computer)', () => {
  test('a link into a synced folder counts as where it leads', { skip: process.platform === 'win32' ? 'links need admin on Windows' : false }, () => {
    const dir = freshDir('synced');
    const real = path.join(dir, 'OneDrive', 'Backups');
    fs.mkdirSync(real, { recursive: true });
    const link = path.join(dir, 'shortcut');
    fs.symlinkSync(real, link);
    assert.equal(syncedFolderAt(link), 'OneDrive');
    assert.equal(syncedFolderAt(path.join(dir, 'plain')), null);
  });

  test('anything that isn\'t a folder name is null, not an error', () => {
    for (const value of [undefined, null, 42, {}, '']) assert.equal(syncedFolderAt(value), null);
  });
});

describe('the note on a not-enough-space error', () => {
  // python/device_backup.py _disk_full_message(), as OE-212 got it, with the earlier backup kept.
  const ENGINE = 'Not enough free space for this backup. It needs more than 229 GB free, but the drive you chose has '
    + '175 GB free. Free up space or choose a folder on an external drive, then try again. The backup that was '
    + "already in that folder hasn't been changed. It's kept, so the drive needs room for both. Don't delete it "
    + 'to make room unless you have another copy.';

  test('goes after what the drive has and before the advice', () => {
    assert.equal(withSyncedFolderNote(ENGINE, 'OneDrive'),
      'Not enough free space for this backup. It needs more than 229 GB free, but the drive you chose has 175 GB '
      + "free. The folder you chose is in OneDrive, so the space in your OneDrive account doesn't count: the "
      + "backup is saved on this computer's own drive. Free up space or choose a folder on an external drive, then "
      + "try again. The backup that was already in that folder hasn't been changed. It's kept, so the drive needs "
      + "room for both. Don't delete it to make room unless you have another copy.");
  });

  test('is added at the end if the advice is worded differently', () => {
    assert.equal(withSyncedFolderNote(`${NOT_ENOUGH_SPACE} `, 'Dropbox'), `${NOT_ENOUGH_SPACE} ${syncedFolderNote('Dropbox')}`);
  });

  test('leaves other errors and unsynced folders alone', () => {
    assert.equal(withSyncedFolderNote(ENGINE, null), ENGINE);
    const other = 'DEVICE_DISCONNECTED: Your iPhone was disconnected before the backup finished.';
    assert.equal(withSyncedFolderNote(other, 'OneDrive'), other);
  });

  test('uses the engine\'s own words', () => {
    const engine = fs.readFileSync(new URL('../python/device_backup.py', import.meta.url), 'utf-8');
    assert.ok(engine.includes(`_NO_SPACE = "${NOT_ENOUGH_SPACE}"`));
    assert.match(engine, /Free up space or choose a "\s*"folder on an external drive/,
      '_disk_full_message() still words its advice "Free up space or choose a folder"');
  });
});
