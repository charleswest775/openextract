// Tests for the thank-you quotes on openextract.app (website/static/api/_lib/thanks.js and the
// pages that show them): only published, OK-to-quote thank-yous go out, and only their words.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'website', 'static');
const thanks = require(path.join(site, 'api', '_lib', 'thanks.js'));
const feedback = require(path.join(site, 'api', '_lib', 'feedback.js'));

let n = 100;
/** An issue the way the feedback API files a thank-you, with the labels a review would add. */
function issue({ details = 'It worked, thank you!', quote = true, email = 'someone@example.com', area = 'photos', extra = [], date = '2026-11-11' } = {}) {
  const report = { kind: 'thanks', area, details, diagnostics: '', email, token: 'a'.repeat(32), quote: quote && Boolean(details) };
  return {
    number: ++n,
    title: feedback.issueTitle(report),
    body: feedback.issueBody(report),
    labels: [...feedback.issueLabels(report), ...extra].map(name => ({ name })),
    created_at: `${date}T18:04:05Z`,
    state: 'open',
  };
}

test('a published, OK-to-quote thank-you becomes a quote with only its words, area and day', () => {
  const q = thanks.quoteFromIssue(issue({ details: 'This program was a lifesaver!\n\nThanks!', extra: ['published'] }));
  assert.deepEqual(q, { text: 'This program was a lifesaver!\n\nThanks!', area: 'Photos', date: '2026-11-11' });
});

test('nothing else from the issue goes out: no email, no OE number, no labels', () => {
  const i = issue({ email: 'private.person@example.com', extra: ['published'] });
  const out = JSON.stringify(thanks.quoteFromIssue(i));
  assert.ok(!out.includes('private.person'));
  assert.ok(!out.includes(String(i.number)));
  assert.ok(!out.includes('ok-to-quote'));
  assert.ok(!out.includes('token'));
});

test('a thank-you needs thanks, ok-to-quote and published to appear', () => {
  assert.equal(thanks.quoteFromIssue(issue()), null, 'not reviewed yet');
  assert.equal(thanks.quoteFromIssue(issue({ quote: false, extra: ['published'] })), null, 'sender did not tick OK to quote');
  const noThanks = issue({ extra: ['published'] });
  noThanks.labels = noThanks.labels.filter(l => l.name !== 'thanks');
  assert.equal(thanks.quoteFromIssue(noThanks), null, 'not a thank-you');
  assert.equal(thanks.quoteFromIssue(issue({ extra: ['published', 'quote-held'] })) !== null, true, 'published wins: the developer can publish a held one');
});

test('a thank-you without words is never a quote', () => {
  const i = issue({ details: '', extra: ['published', 'ok-to-quote'] });
  assert.equal(thanks.quoteFromIssue(i), null);
});

test("someone's own ### line doesn't end the message early, and the next heading does", () => {
  const i = issue({ details: 'Line one\n### not a heading of ours\nLine three', extra: ['published'] });
  assert.equal(thanks.quoteFromIssue(i).text, 'Line one\n### not a heading of ours\nLine three');
});

test('Windows line endings in an edited issue body still parse', () => {
  const i = issue({ details: 'Great app', extra: ['published'] });
  i.body = i.body.replace(/\n/g, '\r\n');
  assert.equal(thanks.quoteFromIssue(i).text, 'Great app');
});

function fakeGitHub(pages) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    const page = Number(new URL(url).searchParams.get('page'));
    return { ok: true, status: 200, json: async () => pages[page - 1] || [] };
  };
  return { fetchFn, calls };
}

test('GET /api/thanks counts every thank-you and returns the published ones, newest first', async () => {
  const older = issue({ details: 'Older one', extra: ['published'], date: '2026-11-09' });
  const newer = issue({ details: 'Newer one', extra: ['published'], date: '2026-11-11' });
  const held = issue({ details: 'Has a name in it', extra: ['quote-held'] });
  const silent = issue({ details: '' });
  const { fetchFn, calls } = fakeGitHub([[older, held, newer, silent]]);
  const out = await thanks.getQuotes({ method: 'GET' }, { GITHUB_FEEDBACK_TOKEN: 't' }, fetchFn);
  assert.equal(out.status, 200);
  assert.equal(out.body.thanks, 4);
  assert.deepEqual(out.body.quotes.map(q => q.text), ['Newer one', 'Older one']);
  assert.match(calls[0].url, /labels=thanks&state=all/);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer t');
});

test('GET /api/thanks reads every page of thank-yous', async () => {
  const full = Array.from({ length: 100 }, () => issue({ details: '' }));
  const { fetchFn, calls } = fakeGitHub([full, [issue({ details: 'Last', extra: ['published'] })]]);
  const out = await thanks.getQuotes({ method: 'GET' }, { GITHUB_FEEDBACK_TOKEN: 't' }, fetchFn);
  assert.equal(calls.length, 2);
  assert.equal(out.body.thanks, 101);
  assert.equal(out.body.quotes.length, 1);
});

test('GET /api/thanks answers 503 without a token, 405 for POST, and throws when GitHub fails', async () => {
  assert.equal((await thanks.getQuotes({ method: 'GET' }, {}, null)).status, 503);
  assert.equal((await thanks.getQuotes({ method: 'POST' }, { GITHUB_FEEDBACK_TOKEN: 't' }, null)).status, 405);
  const failing = async () => ({ ok: false, status: 401, json: async () => ({}) });
  await assert.rejects(thanks.getQuotes({ method: 'GET' }, { GITHUB_FEEDBACK_TOKEN: 't' }, failing), /401/);
});

test('the handler caches good answers at the edge and never caches errors', async () => {
  const saved = process.env.GITHUB_FEEDBACK_TOKEN;
  const savedFetch = globalThis.fetch;
  const run = async () => {
    const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(s) { this.code = s; return this; }, json(b) { this.body = b; } };
    await thanks.handler({ method: 'GET' }, res);
    return res;
  };
  try {
    process.env.GITHUB_FEEDBACK_TOKEN = 't';
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => [] });
    const good = await run();
    assert.equal(good.code, 200);
    assert.match(good.headers['Cache-Control'], new RegExp(`s-maxage=${thanks.CACHE_SECONDS}`));
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    const bad = await run();
    assert.equal(bad.code, 502);
    assert.equal(bad.headers['Cache-Control'], 'no-store');
  } finally {
    globalThis.fetch = savedFetch;
    if (saved === undefined) delete process.env.GITHUB_FEEDBACK_TOKEN;
    else process.env.GITHUB_FEEDBACK_TOKEN = saved;
  }
});

test('every page with a quotes block loads js/thanks.js, and the script adds quotes as text only', () => {
  const pages = [];
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.html')) pages.push(p);
    }
  };
  walk(site);
  const withBlocks = pages.filter(p => /\sdata-thanks[\s>]/.test(fs.readFileSync(p, 'utf8')));
  assert.ok(withBlocks.length >= 5, `expected the quotes on at least 5 pages, found ${withBlocks.length}`);
  for (const p of withBlocks) {
    const html = fs.readFileSync(p, 'utf8');
    assert.ok(html.includes('<script defer src="/js/thanks.js"></script>'), `${path.relative(site, p)} has a quotes block but doesn't load the script`);
    assert.ok(html.includes('data-thanks-list'), `${path.relative(site, p)} has nowhere to put the quotes`);
  }
  const js = fs.readFileSync(path.join(site, 'js', 'thanks.js'), 'utf8');
  assert.ok(!/innerHTML|insertAdjacentHTML|outerHTML/.test(js), 'quotes must be added with textContent');
});

test('the What people say page is in the sitemap and the privacy page explains the check', () => {
  assert.ok(fs.readFileSync(path.join(site, 'sitemap.xml'), 'utf8').includes('https://www.openextract.app/what-people-say</loc>'));
  const privacy = fs.readFileSync(path.join(site, 'privacy.html'), 'utf8');
  assert.match(privacy, /checked automatically/);
  assert.match(privacy, /Anthropic/);
  assert.match(privacy, /email\s+address is never sent/);
});
