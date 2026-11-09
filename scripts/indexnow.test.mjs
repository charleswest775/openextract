// Tests for which pages scripts/indexnow.mjs submits after a deploy.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pageUrl, sitemapUrls, changedUrls, findKey, SITE } from './indexnow.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staticDir = path.join(root, 'website/static');
const sitemap = fs.readFileSync(path.join(staticDir, 'sitemap.xml'), 'utf-8');

test('pages map to the URLs the site serves them at', () => {
  assert.equal(pageUrl('website/static/index.html'), `${SITE}/`);
  assert.equal(pageUrl('website/static/vs-imazing.html'), `${SITE}/vs-imazing`);
  assert.equal(pageUrl('website/static/use-cases/free-imazing-alternative.html'), `${SITE}/use-cases/free-imazing-alternative`);
  assert.equal(pageUrl('website/static/css/site.css'), null);
  assert.equal(pageUrl('website/static/llms.txt'), null);
  assert.equal(pageUrl('src/App.tsx'), null);
});

test('every page in the sitemap has a file behind it', () => {
  for (const url of sitemapUrls(sitemap)) {
    const page = url === `${SITE}/` ? 'index' : url.slice(SITE.length + 1);
    assert.ok(fs.existsSync(path.join(staticDir, `${page}.html`)), `${url} has no ${page}.html`);
  }
});

test('changed pages in the sitemap are submitted; noindex pages, assets and app code are not', () => {
  const diff = [
    'M\twebsite/static/index.html',
    'M\twebsite/static/blog/encrypted-backups-are-better.html',
    'M\twebsite/static/404.html',
    'M\twebsite/static/download/mac.html',
    'M\twebsite/static/css/site.css',
    'A\twebsite/static/llms.txt',
    'M\tsrc/App.tsx',
    '',
  ].join('\n');
  assert.deepEqual(changedUrls(diff, sitemap), [
    `${SITE}/`,
    `${SITE}/blog/encrypted-backups-are-better`,
  ]);
});

test('a deleted page is submitted so engines learn it is gone; a rename submits both', () => {
  const diff = [
    'D\twebsite/static/for/legal.html',
    'R092\twebsite/static/use-cases/old-name.html\twebsite/static/use-cases/free-iphone-backup-viewer.html',
  ].join('\n');
  assert.deepEqual(changedUrls(diff, sitemap), [
    `${SITE}/for/legal`,
    `${SITE}/use-cases/free-iphone-backup-viewer`,
    `${SITE}/use-cases/old-name`,
  ]);
});

test('nothing changed on the site means nothing to submit', () => {
  assert.deepEqual(changedUrls('M\tpython/main.py\n', sitemap), []);
  assert.deepEqual(changedUrls('', sitemap), []);
});

test('the key file is served from the site root and holds exactly the key', () => {
  const key = findKey(staticDir);
  assert.match(key, /^[0-9a-f]{32}$/);
  assert.equal(fs.readFileSync(path.join(staticDir, `${key}.txt`), 'utf-8'), key);
});
