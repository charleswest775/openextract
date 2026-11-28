// The OpenExtract AI add-on that Mac and Windows builds carry: ai-addon.json pins it, and
// scripts/ai-addon-pin.mjs fetches and checks it (release.yml, installers.yml, test-build.yml).
// Nothing here touches the network: downloads are stood in for.
// Run with: node --test scripts/ai-addon-pin.test.mjs
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as P from './ai-addon-pin.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');
const fresh = name => fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
const read = rel => fs.readFileSync(path.join(root, rel), 'utf-8');

function pinFor(version, bytes) {
  return {
    version,
    files: Object.fromEntries(P.PLATFORMS.map(key => [key, {
      file: `openextract-ai-${version}-${key}.mcpb`, size: bytes[key].length, sha256: sha(bytes[key]),
    }])),
  };
}

describe('ai-addon.json', () => {
  test('the pin in the repository is well formed and names the usual add-on for both computers', () => {
    const pin = P.readPin();
    assert.deepEqual(Object.keys(pin.files), P.PLATFORMS);
    for (const [key, entry] of Object.entries(pin.files)) {
      assert.equal(entry.file, `openextract-ai-${pin.version}-${key}.mcpb`);
      assert.equal(entry.url, `https://github.com/charleswest775/openextract-ai-releases/releases/download/v${pin.version}/${entry.file}`);
    }
  });

  test('anything off is refused, saying what', () => {
    const bytes = { 'mac-arm64': Buffer.from('mac'), 'win-x64': Buffer.from('win') };
    const good = pinFor('0.3.0', bytes);
    assert.equal(P.parsePin(good).version, '0.3.0');
    const broken = [
      [{ ...good, version: 'latest' }, /version must look like 0\.3\.0/],
      [{ ...good, files: { 'mac-arm64': good.files['mac-arm64'] } }, /files\.win-x64\.file/],
      [{ ...good, files: { ...good.files, 'win-x64': { ...good.files['win-x64'], file: 'openextract-ai-0.2.4-win-x64.mcpb' } } }, /is not version 0\.3\.0/],
      [{ ...good, files: { ...good.files, 'win-x64': { ...good.files['mac-arm64'] } } }, /is not version 0\.3\.0 for win-x64/],
      [{ ...good, files: { ...good.files, 'mac-arm64': { ...good.files['mac-arm64'], file: 'openextract-ai-0.3.0-unrestricted-mac-arm64.mcpb' } } }, /not the unrestricted edition/],
      [{ ...good, files: { ...good.files, 'mac-arm64': { ...good.files['mac-arm64'], sha256: 'ABC' } } }, /sha256 must be 64 lowercase hex/],
      [{ ...good, files: { ...good.files, 'mac-arm64': { ...good.files['mac-arm64'], size: 0 } } }, /size must be/],
    ];
    for (const [pin, message] of broken) assert.throws(() => P.parsePin(pin), message);
  });
});

describe('fetch', () => {
  const bytes = { 'mac-arm64': Buffer.from('the mac add-on'), 'win-x64': Buffer.from('the windows add-on') };
  const pin = P.parsePin(pinFor('0.3.0', bytes));

  test('downloads the pinned file for the computer asked, checks it, and stages only it', async () => {
    const stageDir = path.join(fresh('stage'), 'ai-addon');
    fs.mkdirSync(stageDir, { recursive: true });
    fs.writeFileSync(path.join(stageDir, 'openextract-ai-0.2.4-mac-arm64.mcpb'), 'an old one');
    const asked = [];
    const get = async url => { asked.push(url); return bytes['win-x64']; };
    const dest = await P.fetchPinned({ platform: 'win-x64', pin, stageDir, get });
    assert.deepEqual(asked, [pin.files['win-x64'].url]);
    assert.equal(dest, path.join(stageDir, 'openextract-ai-0.3.0-win-x64.mcpb'));
    assert.deepEqual(fs.readdirSync(stageDir), ['openextract-ai-0.3.0-win-x64.mcpb'], 'the old one is gone');
  });

  test('a download or local copy that isn\'t the pinned file stops the build', async () => {
    const stageDir = path.join(fresh('stage'), 'ai-addon');
    await assert.rejects(P.fetchPinned({ platform: 'mac-arm64', pin, stageDir, get: async () => Buffer.from('the mac add-oN') }), /SHA-256 is .*, not the pinned/);
    await assert.rejects(P.fetchPinned({ platform: 'mac-arm64', pin, stageDir, get: async () => Buffer.from('short') }), /bytes, not the pinned/);
    const local = path.join(fresh('local'), 'openextract-ai-0.3.0-mac-arm64.mcpb');
    fs.writeFileSync(local, bytes['mac-arm64']);
    assert.equal(path.basename(await P.fetchPinned({ platform: 'mac-arm64', pin, stageDir, from: local, get: async () => assert.fail('no download with --from') })),
      'openextract-ai-0.3.0-mac-arm64.mcpb');
    await assert.rejects(P.fetchPinned({ platform: 'linux-x64', pin, stageDir }), /No add-on is made for linux-x64/);
  });

  test('which add-on this computer gets', () => {
    assert.equal(P.hostKey('darwin', 'arm64'), 'mac-arm64');
    assert.equal(P.hostKey('win32', 'x64'), 'win-x64');
    assert.equal(P.hostKey('darwin', 'x64'), null);
    assert.equal(P.hostKey('linux', 'x64'), null);
  });
});

describe('check', () => {
  const bytes = { 'mac-arm64': Buffer.from('the mac add-on'), 'win-x64': Buffer.from('the windows add-on') };
  const pin = P.parsePin(pinFor('0.3.0', bytes));
  const entry = pin.files['mac-arm64'];
  const info = { aiIndexUrl: null, aiAddon: { file: entry.file, size: entry.size, sha256: entry.sha256 } };
  function resources(files) {
    const dir = fresh('resources');
    fs.mkdirSync(path.join(dir, 'ai-addon'));
    for (const [name, data] of Object.entries(files)) fs.writeFileSync(path.join(dir, 'ai-addon', name), data);
    return dir;
  }

  test('the app carries exactly the pinned file, and build-info.json names it', () => {
    assert.equal(P.checkCarried(resources({ [entry.file]: bytes['mac-arm64'] }), { pin, buildInfo: info }).file, entry.file);
  });

  test('a missing, extra, changed or unnamed add-on fails', () => {
    assert.throws(() => P.checkCarried(fresh('none'), { pin, buildInfo: info }), /should hold one pinned \.mcpb/);
    assert.throws(() => P.checkCarried(resources({ [entry.file]: bytes['mac-arm64'], 'other.mcpb': 'x' }), { pin, buildInfo: info }), /should hold one/);
    assert.throws(() => P.checkCarried(resources({ [entry.file]: 'changed' }), { pin, buildInfo: info }), /not the pinned/);
    assert.throws(() => P.checkCarried(resources({ [entry.file]: bytes['mac-arm64'] }), { pin, buildInfo: { aiIndexUrl: null, aiAddon: null } }), /doesn't name/);
  });
});

describe('the builds that carry it', () => {
  const stepsOf = (yml, job) => {
    const start = yml.indexOf(`\n  ${job}:`);
    assert.ok(start >= 0, `no job ${job}`);
    const next = yml.slice(start + 1).search(/\n {2}[a-z][\w-]*:\n/);
    return next === -1 ? yml.slice(start) : yml.slice(start, start + 1 + next);
  };

  test('a release\'s Mac and Windows builds fetch the pinned add-on before building and check the app carries it; Linux doesn\'t', () => {
    const yml = read('.github/workflows/release.yml');
    for (const [job, resourcesDir] of [['build-macos', 'release/mac-arm64/OpenExtract.app/Contents/Resources'], ['build-windows', 'release/win-unpacked/resources']]) {
      const steps = stepsOf(yml, job);
      const fetchAt = steps.indexOf('node scripts/ai-addon-pin.mjs fetch');
      assert.ok(fetchAt > 0, `${job} fetches the add-on`);
      assert.match(steps, /set -euo pipefail\n\s+MCPB="\$\(node scripts\/ai-addon-pin\.mjs fetch\)"\n\s+echo "OPENEXTRACT_AI_BUNDLED_MCPB=\$MCPB" >> "\$GITHUB_ENV"/,
        `${job}: a failed fetch fails the step instead of building without the add-on`);
      assert.ok(fetchAt < steps.indexOf('run: npm run build'), `${job} fetches before npm run build (write-build-info.mjs reads it)`);
      assert.ok(steps.indexOf(`node scripts/ai-addon-pin.mjs check ${resourcesDir}`) > steps.indexOf('npx electron-builder'), `${job} checks after packaging`);
    }
    assert.doesNotMatch(stepsOf(yml, 'build-linux'), /ai-addon-pin/);
  });

  test('test builds carry it the same way, and installer tests run when the pin moves', () => {
    const testBuild = read('.github/workflows/test-build.yml');
    assert.equal(testBuild.match(/node scripts\/ai-addon-pin\.mjs fetch/g).length, 2);
    assert.equal(testBuild.match(/node scripts\/ai-addon-pin\.mjs check /g).length, 2);
    assert.doesNotMatch(testBuild, /OPENEXTRACT_AI_INDEX_URL/, 'test builds carry the add-on; nothing downloads it');
    const installers = read('.github/workflows/installers.yml');
    assert.match(installers, /- name: Fetch the OpenExtract AI add-on\n\s+if: runner\.os != 'Linux'/);
    assert.match(installers, /- 'ai-addon\.json'/);
  });

  test('package.json carries build/ai-addon/*.mcpb as resources/ai-addon/, and git ignores the staged copy', () => {
    const build = JSON.parse(read('package.json')).build;
    assert.deepEqual(build.extraResources.find(r => r.to === 'ai-addon'), { from: 'build/ai-addon', to: 'ai-addon', filter: ['*.mcpb'] });
    assert.match(read('.gitignore'), /^build\/ai-addon\/$/m);
  });
});
