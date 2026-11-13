// Tests for build/sign-windows.js, the afterPack hook that signs the Windows app's DLLs in one
// batch: which files it picks, and when it signs or skips. The signing itself needs Azure and
// runs only in release.yml, whose "Verify Authenticode signatures" step checks the result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { peFilesToSign, decide } = require('../build/sign-windows.js');

const AZURE = { endpoint: 'https://eus.codesigning.azure.net/', codeSigningAccountName: 'a', certificateProfileName: 'p' };
const SECRETS = { AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c', AZURE_CLIENT_SECRET: 's' };
const ctx = (platform, azure = AZURE) => ({ electronPlatformName: platform, packager: { platformSpecificBuildOptions: azure ? { azureSignOptions: azure } : {} } });

test('picks every PE file by content, whatever its extension, and leaves .exe files to electron-builder', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sign-windows-'));
  try {
    const put = (rel, bytes) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), bytes);
    };
    const pe = Buffer.from('MZ\x90\x00rest of a PE file');
    put('ffmpeg.dll', pe);
    put('OpenExtract.exe', pe);
    put('resources/python/openextract-engine.exe', pe);
    put('resources/python/_internal/python311.dll', pe);
    put('resources/python/_internal/Crypto/Cipher/_raw_aes.pyd', pe);
    put('resources/python/_internal/odd/native.node', pe);
    put('resources/python/_internal/base_library.zip', Buffer.from('PK\x03\x04'));
    put('resources/python/_internal/notes.dll.txt', Buffer.from('not a PE file'));
    put('resources/python/_internal/empty.dll', Buffer.alloc(0));
    put('resources/python/_internal/one-byte.dll', Buffer.from('M'));

    const picked = peFilesToSign(dir).map(f => path.relative(dir, f).split(path.sep).join('/'));
    assert.deepEqual(picked, [
      'ffmpeg.dll',
      'resources/python/_internal/Crypto/Cipher/_raw_aes.pyd',
      'resources/python/_internal/odd/native.node',
      'resources/python/_internal/python311.dll',
    ]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('signs a Windows build that has Azure signing configured and its secrets', () => {
  assert.deepEqual(decide(ctx('win32'), { ...SECRETS, CI: 'true' }), { action: 'sign', azure: AZURE });
});

test('skips macOS and Linux builds, and the unsigned test builds that drop azureSignOptions', () => {
  assert.equal(decide(ctx('darwin'), SECRETS).action, 'skip');
  assert.equal(decide(ctx('linux'), SECRETS).action, 'skip');
  assert.match(decide(ctx('win32', null), { CI: 'true' }).reason, /unsigned build/);
});

test('missing secrets fail a CI build but only skip a local one', () => {
  assert.throws(() => decide(ctx('win32'), { CI: 'true', AZURE_TENANT_ID: 't' }), /AZURE_CLIENT_ID, AZURE_CLIENT_SECRET are needed/);
  const local = decide(ctx('win32'), { AZURE_TENANT_ID: 't', AZURE_CLIENT_ID: 'c' });
  assert.equal(local.action, 'skip');
  assert.match(local.reason, /AZURE_CLIENT_SECRET is needed/);
});
