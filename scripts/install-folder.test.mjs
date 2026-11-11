// Tests for electron/installFolder.ts: which folder an update replaces, and whether a
// chosen backup or export location is inside it. The handlers that use it are tested
// in main-ipc.test.mjs ("saving inside the program folder").
// Run with: node --test scripts/install-folder.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadElectronModule, freshDir } from './test-helpers/electron-env.mjs';

const { module: lib } = loadElectronModule('installFolder');
const { installFolderFor, isInsideFolder, resolveReal, installFolderWarning } = lib;

describe('installFolderFor', () => {
  test('Windows: the folder holding OpenExtract.exe', () => {
    assert.equal(
      installFolderFor('C:\\Users\\Ana\\AppData\\Local\\Programs\\openextract\\OpenExtract.exe', 'win32'),
      'C:\\Users\\Ana\\AppData\\Local\\Programs\\openextract',
    );
    assert.equal(installFolderFor('C:\\Program Files\\OpenExtract\\OpenExtract.exe', 'win32'), 'C:\\Program Files\\OpenExtract');
  });

  test('macOS: the whole .app bundle, the outermost one if bundles are nested', () => {
    assert.equal(installFolderFor('/Applications/OpenExtract.app/Contents/MacOS/OpenExtract', 'darwin'), '/Applications/OpenExtract.app');
    assert.equal(
      installFolderFor('/Applications/OpenExtract.app/Contents/Frameworks/OpenExtract Helper.app/Contents/MacOS/OpenExtract Helper', 'darwin'),
      '/Applications/OpenExtract.app',
    );
    assert.equal(installFolderFor('/Users/ana/Downloads/OpenExtract.APP/Contents/MacOS/OpenExtract', 'darwin'), '/Users/ana/Downloads/OpenExtract.APP');
    // Not in a bundle at all: the executable's folder.
    assert.equal(installFolderFor('/opt/oe/OpenExtract', 'darwin'), '/opt/oe');
  });

  test('Linux: the AppImage mount or the deb install folder', () => {
    assert.equal(installFolderFor('/tmp/.mount_OpenExAbC123/openextract', 'linux'), '/tmp/.mount_OpenExAbC123');
    assert.equal(installFolderFor('/opt/OpenExtract/openextract', 'linux'), '/opt/OpenExtract');
    // A folder ending in .app only means something on macOS.
    assert.equal(installFolderFor('/home/ana/tools.app/oe/openextract', 'linux'), '/home/ana/tools.app/oe');
  });
});

describe('isInsideFolder on Windows', () => {
  const install = 'C:\\Users\\Ana\\AppData\\Local\\Programs\\openextract';
  const inside = (p, folder = install) => isInsideFolder(p, folder, 'win32');

  test('the folder itself and anything below it', () => {
    assert.ok(inside(install));
    assert.ok(inside(`${install}\\Backups`));
    assert.ok(inside(`${install}\\resources\\app\\Exports\\Mom`));
    // A name that merely starts with two dots is still a folder inside.
    assert.ok(inside(`${install}\\..stuff`));
  });

  test('case does not matter', () => {
    assert.ok(inside('c:\\users\\ana\\appdata\\local\\programs\\OPENEXTRACT\\Backups'));
    assert.ok(inside(`${install}\\Backups`, install.toUpperCase()));
  });

  test('trailing separators, forward slashes and dot segments do not matter', () => {
    assert.ok(inside(`${install}\\`));
    assert.ok(inside(`${install}\\\\Backups\\\\`));
    assert.ok(inside(`${install}\\Backups`, `${install}\\`));
    assert.ok(inside('C:/Users/Ana/AppData/Local/Programs/openextract/Backups'));
    assert.ok(inside(`${install}\\resources\\..\\Backups`));
    assert.ok(inside(`${install}\\.\\Backups`));
  });

  test('outside: the parent, a sibling with the same start, another drive, a share', () => {
    assert.ok(!inside('C:\\Users\\Ana\\AppData\\Local\\Programs'));
    assert.ok(!inside('C:\\Users\\Ana\\AppData\\Local\\Programs\\openextract2'));
    assert.ok(!inside('C:\\Users\\Ana\\AppData\\Local\\Programs\\openextract-backups\\Mom'));
    assert.ok(!inside(`${install}\\..\\Backups`));
    assert.ok(!inside(`${install}2\\`));
    assert.ok(!inside('D:\\Users\\Ana\\AppData\\Local\\Programs\\openextract\\Backups'));
    assert.ok(!inside('\\\\nas\\share\\openextract\\Backups'));
    assert.ok(!inside('C:\\Users\\Ana\\Documents\\iPhone backup'));
  });
});

describe('isInsideFolder on macOS and Linux', () => {
  test('macOS ignores case, like its default file system', () => {
    const app = '/Applications/OpenExtract.app';
    assert.ok(isInsideFolder(`${app}/Contents/Backups`, app, 'darwin'));
    assert.ok(isInsideFolder('/applications/openextract.APP/Exports', app, 'darwin'));
    assert.ok(isInsideFolder(`${app}/`, app, 'darwin'));
    assert.ok(isInsideFolder(`${app}/Exports`, `${app}/`, 'darwin'));
    assert.ok(!isInsideFolder('/Applications/OpenExtract.app.backup/Exports', app, 'darwin'));
    assert.ok(!isInsideFolder('/Applications', app, 'darwin'));
    assert.ok(!isInsideFolder('/Users/ana/Documents', app, 'darwin'));
  });

  test('Linux compares case exactly', () => {
    const install = '/opt/OpenExtract';
    assert.ok(isInsideFolder('/opt/OpenExtract/Backups', install, 'linux'));
    assert.ok(isInsideFolder('/opt/OpenExtract/', install, 'linux'));
    assert.ok(isInsideFolder('/opt/OpenExtract/Backups', '/opt/OpenExtract/', 'linux'));
    assert.ok(isInsideFolder('/opt/OpenExtract/x/../Backups', install, 'linux'));
    assert.ok(!isInsideFolder('/opt/openextract/Backups', install, 'linux'));
    assert.ok(!isInsideFolder('/opt/OpenExtract2', install, 'linux'));
    assert.ok(!isInsideFolder('/opt/OpenExtract/../Backups', install, 'linux'));
  });
});

describe('resolveReal (on this computer)', () => {
  test('an existing folder comes back as its real path; a trailing separator is dropped', () => {
    const dir = freshDir('real');
    assert.equal(resolveReal(dir), fs.realpathSync.native(dir));
    assert.equal(resolveReal(dir + path.sep), fs.realpathSync.native(dir));
  });

  test('a file that does not exist yet: the existing part is resolved, the rest added back', () => {
    const dir = freshDir('real');
    assert.equal(resolveReal(path.join(dir, 'not', 'yet', 'contacts.vcf')), path.join(fs.realpathSync.native(dir), 'not', 'yet', 'contacts.vcf'));
  });

  test('links are followed (a junction on Windows, which needs no special rights)', () => {
    const target = freshDir('real-target');
    fs.mkdirSync(path.join(target, 'sub'));
    const link = path.join(freshDir('real-link'), 'shortcut');
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal(resolveReal(path.join(link, 'sub', 'new.txt')), path.join(fs.realpathSync.native(target), 'sub', 'new.txt'));
  });

  test('on a case-insensitive disk, the on-disk case comes back', t => {
    const parent = freshDir('real-case');
    fs.mkdirSync(path.join(parent, 'Programs'));
    const shouted = path.join(parent, 'PROGRAMS');
    if (!fs.existsSync(shouted)) return t.skip('this disk is case-sensitive');
    assert.equal(resolveReal(path.join(shouted, 'Backups')), path.join(fs.realpathSync.native(parent), 'Programs', 'Backups'));
  });

  test('a path with no existing part comes back resolved as is', () => {
    const missing = process.platform === 'win32' ? 'Q:\\no\\such\\drive' : '/no-such-root-oe/x/y';
    assert.equal(resolveReal(missing), path.resolve(missing));
  });
});

test('the warning says what happens and what to do, in plain words', () => {
  for (const platform of ['win32', 'linux']) {
    const { message, detail } = installFolderWarning(platform);
    assert.equal(message, "This folder is inside OpenExtract's program folder, which is replaced every time OpenExtract updates.");
    assert.equal(detail, 'Anything saved there would be deleted. Choose another folder.');
  }
  assert.match(installFolderWarning('darwin').message, /^This folder is inside the OpenExtract app, which is replaced every time OpenExtract updates\.$/);
});
