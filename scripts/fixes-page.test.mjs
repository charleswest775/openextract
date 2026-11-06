// The "Fixes for common problems" page (website/static/fixes.html) is generated from the known
// fixes the app shows after a report (website/static/api/_lib/known-fixes.js) by
// scripts/build-fixes-page.mjs. These tests keep the two in step.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { AREAS, KNOWN_FIXES, PAGE, PAGE_URL, buildPage } from './build-fixes-page.mjs';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = require(path.join(root, 'website/static/api/_lib/feedback.js'));
const page = fs.readFileSync(PAGE, 'utf8');

test('the page shows the known fixes as they are now', () => {
  assert.ok(buildPage(page) === page, 'website/static/fixes.html is out of date: run `node scripts/build-fixes-page.mjs`');
  // A Windows checkout can have CRLF line endings, which mustn't count as out of date.
  const crlf = page.replace(/\r?\n/g, '\r\n');
  assert.ok(buildPage(crlf) === crlf, 'CRLF line endings make the page look out of date');
});

test('every known fix has what the page needs', () => {
  const areas = new Set(AREAS.map(([area]) => area));
  const ids = new Set();
  for (const fix of KNOWN_FIXES) {
    assert.match(fix.id, /^[a-z0-9-]+$/, `${fix.id}: ids are used in links, so lowercase letters, digits and dashes only`);
    assert.ok(!ids.has(fix.id), `${fix.id} is used twice`);
    ids.add(fix.id);
    assert.ok(areas.has(fix.area), `${fix.id}: area must be one of ${[...areas].join(', ')}`);
    assert.ok(Array.isArray(fix.seen) && fix.seen.length && fix.seen.every(s => typeof s === 'string' && s.trim()),
      `${fix.id}: seen must list the words the app shows`);
    if (fix.fixedIn !== undefined) assert.match(fix.fixedIn, /^\d+\.\d+\.\d+$/, `${fix.id}: fixedIn is a version like 0.10.2`);
    // The page is public: nothing that points back at a private report.
    for (const s of [fix.title, fix.text, ...fix.seen]) {
      assert.doesNotMatch(s, /\bOE-\d+\b|[\w.+-]+@[\w-]+\.[\w.]+/, `${fix.id}: no report references or email addresses`);
    }
  }
});

test('the app\'s "Read more" opens the fix\'s own section of the page', () => {
  const [fix] = site.matchKnownFixes({ details: 'No such value.', diagnostics: 'App: OpenExtract 0.10.1 on Windows' });
  assert.equal(fix.url, `${PAGE_URL}#encrypted-backup-no-such-value`);
  for (const { id } of KNOWN_FIXES) assert.ok(page.includes(`<div class="fix" id="${id}">`), `no section for ${id}`);
});

test('search engines can find the page', () => {
  const sitemap = fs.readFileSync(path.join(root, 'website/static/sitemap.xml'), 'utf8');
  assert.ok(sitemap.includes(`<loc>${PAGE_URL}</loc>`), 'add the page to website/static/sitemap.xml');
  assert.ok(page.includes(`<link rel="canonical" href="${PAGE_URL}" />`));
  const data = JSON.parse(page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data['@type'], 'FAQPage');
  assert.equal(data.mainEntity.length, KNOWN_FIXES.length);
});
