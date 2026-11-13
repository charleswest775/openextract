// Tests for openextract.app's download links (website/static/api/_lib/download.js, the vercel.json
// rewrite in front of it, and the pages that use it): each link gives the newest release's file,
// and falls back to GitHub's release page when GitHub can't say which release that is.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'website', 'static');
const lib = path.join(site, 'api', '_lib', 'download.js');
const download = require(lib);

const RELEASES = 'https://github.com/charleswest775/openextract/releases';
const quiet = { error() {} };

/** A fetch that answers /releases/latest the way github.com does: a redirect to the tag page. */
function github(location, status = 302) {
  const calls = [];
  const fetchFn = async (url, options) => {
    calls.push({ url, options });
    return { status, headers: new Headers(location ? { location } : {}) };
  };
  return { fetchFn, calls };
}

test('each platform gets the file electron-builder uploads for that version', () => {
  assert.deepEqual(
    Object.keys(download.FILES).map(p => download.fileName(p, '0.16.0')),
    ['OpenExtract-0.16.0-arm64.dmg', 'OpenExtract-Setup-0.16.0.exe', 'openextract_0.16.0_amd64.deb', 'OpenExtract-0.16.0.AppImage'],
  );
  assert.equal(download.fileUrl('windows', '0.16.0'), `${RELEASES}/download/v0.16.0/OpenExtract-Setup-0.16.0.exe`);
  assert.equal(download.fileName('toString', '0.16.0'), null, 'only real platforms, not object properties');
  assert.equal(download.fileName('ios', '0.16.0'), null);
});

test('the version comes from the tag page /releases/latest redirects to', () => {
  assert.equal(download.versionFromTagUrl(`${RELEASES}/tag/v0.15.1`), '0.15.1');
  assert.equal(download.versionFromTagUrl(`${RELEASES}/tag/v0.16.0-beta.1`), null);
  assert.equal(download.versionFromTagUrl('https://github.com/login'), null);
  assert.equal(download.versionFromTagUrl(null), null);
});

test('a download link redirects to the newest release\'s file, cached briefly at the edge', async () => {
  const { fetchFn, calls } = github(`${RELEASES}/tag/v0.15.2`);
  const out = await download.download({ method: 'GET', query: { platform: 'mac' } }, fetchFn, quiet);
  assert.equal(out.status, 302);
  assert.equal(out.headers.Location, `${RELEASES}/download/v0.15.2/OpenExtract-0.15.2-arm64.dmg`);
  assert.match(out.headers['Cache-Control'], /s-maxage=60\b/);
  assert.match(out.headers['Cache-Control'], /max-age=0\b/, "browsers mustn't keep an old redirect");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${RELEASES}/latest`);
  assert.equal(calls[0].options.redirect, 'manual', 'reads the redirect instead of following it');
});

test('when GitHub doesn\'t name a release, the link goes to the release page, uncached', async () => {
  const cases = [
    github(null, 200).fetchFn, // no redirect at all
    github('https://github.com/login', 302).fetchFn, // a redirect somewhere else
    async () => { throw new Error('network down'); },
  ];
  for (const fetchFn of cases) {
    const out = await download.download({ method: 'GET', query: { platform: 'windows' } }, fetchFn, quiet);
    assert.equal(out.status, 302);
    assert.equal(out.headers.Location, `${RELEASES}/latest`);
    assert.equal(out.headers['Cache-Control'], 'no-store');
  }
});

test('an unknown platform is a 404 and other methods a 405, without asking GitHub', async () => {
  const { fetchFn, calls } = github(`${RELEASES}/tag/v0.15.2`);
  assert.equal((await download.download({ method: 'GET', query: { platform: 'ios' } }, fetchFn, quiet)).status, 404);
  assert.equal((await download.download({ method: 'GET', query: {} }, fetchFn, quiet)).status, 404);
  assert.equal((await download.download({ method: 'POST', query: { platform: 'mac' } }, fetchFn, quiet)).status, 405);
  assert.equal((await download.latest({ method: 'POST', query: {} }, fetchFn, quiet)).status, 405);
  assert.equal(calls.length, 0);
});

test('/api/latest answers the newest version, or 502 when GitHub can\'t say', async () => {
  const ok = await download.latest({ method: 'GET', query: {} }, github(`${RELEASES}/tag/v0.15.2`).fetchFn, quiet);
  assert.deepEqual([ok.status, ok.body], [200, { version: '0.15.2' }]);
  const bad = await download.latest({ method: 'GET', query: {} }, github(null, 200).fetchFn, quiet);
  assert.equal(bad.status, 502);
  assert.equal(bad.headers['Cache-Control'], 'no-store');
});

test('the handler reads the platform from the rewrite\'s query, or from the URL', () => {
  assert.deepEqual(download.queryOf({ url: '/download/mac/file?check=1', query: { platform: 'mac', check: '1' } }), { platform: 'mac', check: '1' });
  assert.deepEqual(download.queryOf({ url: '/api/download?platform=linux' }), { platform: 'linux' });
  assert.deepEqual(download.queryOf({ url: '/api/download', query: { platform: ['windows', 'mac'] } }), { platform: 'windows' });
});

test('vercel.json sends every platform\'s link to the function, and has no fixed version left', () => {
  const config = JSON.parse(fs.readFileSync(path.join(site, 'vercel.json'), 'utf8'));
  const fixed = (config.redirects || []).filter(r => r.source.startsWith('/download/'));
  assert.deepEqual(fixed, [], 'no /download redirect names a version');
  const rewrite = (config.rewrites || []).find(r => r.destination.startsWith('/api/download'));
  assert.ok(rewrite, 'a rewrite to /api/download');
  assert.equal(rewrite.destination, '/api/download?platform=:platform');
  const platforms = rewrite.source.match(/^\/download\/:platform\(([^)]+)\)\/file$/)?.[1].split('|');
  assert.deepEqual(platforms?.sort(), Object.keys(download.FILES).sort(), 'the rewrite covers exactly the platforms the function knows');
  assert.ok(!JSON.stringify(config).match(/releases\/download\/v\d/), 'vercel.json names no release');
});

test('each download page sends the browser on to its platform\'s link', () => {
  for (const platform of Object.keys(download.FILES)) {
    const page = fs.readFileSync(path.join(site, 'download', `${platform}.html`), 'utf8');
    assert.match(page, new RegExp(`http-equiv="refresh" content="1;url=/download/${platform}/file"`), platform);
    assert.match(page, new RegExp(`href="/download/${platform}/file"`), `${platform} has a direct link too`);
  }
});

test('the home page asks /api/latest for the version label', () => {
  const page = fs.readFileSync(path.join(site, 'index.html'), 'utf8');
  assert.match(page, /<span class="nav__version">v\d+\.\d+\.\d+<\/span>/, 'a written version for when the request fails');
  assert.match(page, /fetch\('\/api\/latest'\)/);
});

test('the command line lists each platform\'s file for release.yml to check', () => {
  const out = execFileSync(process.execPath, [lib, '0.16.0'], { encoding: 'utf8' });
  assert.equal(out, [
    'mac OpenExtract-0.16.0-arm64.dmg',
    'windows OpenExtract-Setup-0.16.0.exe',
    'linux openextract_0.16.0_amd64.deb',
    'linux-appimage OpenExtract-0.16.0.AppImage',
    '',
  ].join('\n'));
  assert.throws(() => execFileSync(process.execPath, [lib, 'v0.16'], { stdio: 'pipe' }));
});
