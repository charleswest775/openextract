// Tests for the site's hreflang clusters: pages that are the same page in other languages
// (the free iMazing alternative in English, German, Spanish and so on). Every member must list
// every member, itself included, plus x-default, and each URL must be a page the site serves,
// so a language added to one page but not the others, or a renamed page, fails here.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE, pageUrl, sitemapUrls } from './indexnow.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const staticDir = path.join(root, 'website', 'static');
const sitemap = new Set(sitemapUrls(fs.readFileSync(path.join(staticDir, 'sitemap.xml'), 'utf-8')));

/** The value of `name` in one tag's attributes, or null. */
function attr(tag, name) {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`, 'i'));
  return m ? m[1] : null;
}

/** Every page under website/static/, by the URL the site serves it at. */
function pages() {
  const out = new Map();
  for (const entry of fs.readdirSync(staticDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    const rel = path.relative(staticDir, file).split(path.sep).join('/');
    out.set(pageUrl(`website/static/${rel}`), fs.readFileSync(file, 'utf-8'));
  }
  return out;
}

/** A page's <html lang>, canonical URL and hreflang alternates ({ lang: url }, in page order). */
function readPage(html) {
  const head = html.slice(0, html.indexOf('</head>'));
  const links = head.match(/<link\b[^>]*>/gi) ?? [];
  const alternates = [];
  let canonical = null;
  for (const tag of links) {
    const rel = (attr(tag, 'rel') ?? '').toLowerCase();
    if (rel === 'canonical') canonical = attr(tag, 'href');
    if (rel === 'alternate' && attr(tag, 'hreflang')) alternates.push([attr(tag, 'hreflang'), attr(tag, 'href')]);
  }
  const lang = (html.match(/<html\b[^>]*\slang="([^"]+)"/i) ?? [])[1] ?? null;
  return { lang, canonical, alternates };
}

/** The file a URL on this site is served from, or null for a URL elsewhere. */
function fileFor(url) {
  if (url === `${SITE}/`) return path.join(staticDir, 'index.html');
  if (!url.startsWith(`${SITE}/`)) return null;
  return path.join(staticDir, ...url.slice(SITE.length + 1).split('/')) + '.html';
}

const all = pages();
const clustered = [...all].map(([url, html]) => [url, readPage(html)]).filter(([, p]) => p.alternates.length > 0);
const primary = code => code.split('-')[0].toLowerCase();

test('there are hreflang clusters to check', () => {
  assert.ok(clustered.length >= 2, 'no page has hreflang alternates; did the head markup change?');
});

test('every hreflang URL is a page on this site, listed in the sitemap', () => {
  for (const [url, page] of clustered) {
    for (const [code, href] of page.alternates) {
      const file = fileFor(href);
      assert.ok(file, `${url}: hreflang="${code}" points off the site: ${href}`);
      assert.ok(fs.existsSync(file), `${url}: hreflang="${code}" points to ${href}, which has no file (${path.relative(root, file)})`);
      assert.ok(sitemap.has(href), `${url}: hreflang="${code}" points to ${href}, which isn't in sitemap.xml`);
    }
  }
});

test('each code is used once per page, and x-default is one of the pages', () => {
  for (const [url, page] of clustered) {
    const codes = page.alternates.map(([code]) => code.toLowerCase());
    assert.equal(new Set(codes).size, codes.length, `${url}: a hreflang code appears twice: ${codes.join(', ')}`);
    for (const code of codes) assert.match(code, /^(x-default|[a-z]{2,3}(-[a-z]{2}|-[a-z]{4})?)$/, `${url}: "${code}" isn't a hreflang code`);
    const xDefault = page.alternates.find(([code]) => code === 'x-default');
    assert.ok(xDefault, `${url}: no hreflang="x-default"`);
    const languages = page.alternates.filter(([code]) => code !== 'x-default').map(([, href]) => href);
    assert.ok(languages.includes(xDefault[1]), `${url}: x-default (${xDefault[1]}) isn't one of the cluster's pages`);
  }
});

test('each page lists itself, under the language in its <html lang>, at its canonical URL', () => {
  for (const [url, page] of clustered) {
    assert.equal(page.canonical, url, `${url}: canonical is ${page.canonical}`);
    const self = page.alternates.filter(([code, href]) => code !== 'x-default' && href === url);
    assert.equal(self.length, 1, `${url}: should list itself exactly once among its alternates`);
    assert.ok(page.lang, `${url}: <html> has no lang`);
    assert.equal(primary(self[0][0]), primary(page.lang), `${url}: listed as hreflang="${self[0][0]}" but <html lang="${page.lang}">`);
  }
});

test('every member of a cluster lists the same alternates (complete and reciprocal)', () => {
  const byUrl = new Map(clustered);
  for (const [url, page] of clustered) {
    const expected = [...page.alternates].map(([c, h]) => `${c.toLowerCase()} ${h}`).sort();
    for (const [code, href] of page.alternates) {
      if (code === 'x-default') continue;
      const other = byUrl.get(href);
      assert.ok(other, `${url} lists ${href} (${code}), but that page has no hreflang links back`);
      const got = [...other.alternates].map(([c, h]) => `${c.toLowerCase()} ${h}`).sort();
      assert.deepEqual(got, expected, `${href} and ${url} list different alternates`);
    }
  }
});

test('the free iMazing alternative has every language, with English as x-default', () => {
  const en = `${SITE}/use-cases/free-imazing-alternative`;
  const page = clustered.find(([url]) => url === en)?.[1];
  assert.ok(page, `${en} has no hreflang links`);
  const codes = new Map(page.alternates);
  for (const code of ['en', 'de', 'es', 'fr', 'pt', 'it', 'ja']) assert.ok(codes.has(code), `no hreflang="${code}" on ${en}`);
  assert.equal(codes.get('x-default'), en);
  assert.equal(codes.get('en'), en);
});
