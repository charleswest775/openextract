// OpenExtract AI keys for what people buy: /api/ai-key makes the key a paid Stripe checkout bought,
// /ai/buy sends people to the payment links with their phone code, /ai/thanks shows the key.
// The add-on (its own repo) checks keys; scripts/fixtures/ai-key-vector.json is a vector both repos test,
// so a key made here is byte for byte the key the add-on's make-key makes.
// Run with: npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lib = require(path.join(root, 'website/static/api/_lib/ai-key.js'));
const buy = require(path.join(root, 'website/static/js/ai-buy.js'));
const thanks = require(path.join(root, 'website/static/js/ai-thanks.js'));
const vector = JSON.parse(fs.readFileSync(path.join(root, 'scripts/fixtures/ai-key-vector.json'), 'utf-8'));
const seed = lib.seedFrom(vector.seed);

const ENV = { STRIPE_SECRET_KEY: 'rk_test_x', AI_KEY_SIGNING_SEED: vector.seed, AI_PRICE_PHONE: 'price_phone', AI_PRICE_WEEK: 'price_week' };
const SESSION = 'cs_test_a1B2c3D4e5F6g7H8i9J0';

/** The fields of a key, after checking its signature against the vector's public key as the add-on does. */
function readKey(key) {
  assert.ok(key.startsWith('OEAI1-'));
  const raw = Buffer.from(key.slice(6).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const payload = raw.subarray(0, raw.length - 64);
  const signature = raw.subarray(raw.length - 64);
  const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'),
    Buffer.from(vector.public_key.replace(/-/g, '+').replace(/_/g, '/'), 'base64')]);
  const publicKey = crypto.createPublicKey({ key: spki, format: 'der', type: 'spki' });
  assert.ok(crypto.verify(null, payload, publicKey, signature), 'the signature checks out');
  return JSON.parse(payload.toString('utf8'));
}

/** A fetch that answers Stripe's checkout-session lookup with ``session`` (or a status). */
function stripe(session, status = 200) {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return { ok: status >= 200 && status < 300, status, json: async () => session };
  };
  return { fetchFn, calls };
}

function paid(overrides = {}) {
  return {
    id: SESSION, status: 'complete', payment_status: 'paid', client_reference_id: '7f3k-q9m2',
    created: Date.UTC(2026, 10, 26, 23, 30) / 1000, customer_details: { name: 'Sarah Jones', email: 's@example.com' },
    line_items: { data: [{ price: { id: 'price_phone' } }] }, ...overrides,
  };
}

const get = (query) => ({ method: 'GET', query });

// ── The key format, the same as the add-on's ──────────────────────────────────

test('the store makes the same keys as the add-on, from the shared vector', () => {
  assert.equal(lib.publicKeyOf(seed), vector.public_key);
  for (const c of vector.cases) assert.equal(lib.makeKey(seed, c), c.key, c.kind);
});

test('phone codes are cleaned as the add-on cleans them', () => {
  for (const [typed, code] of [['7f3k-q9m2', '7F3KQ9M2'], [' 7F3K Q9M2 ', '7F3KQ9M2'], ['7F3K-Q9MO', '7F3KQ9M0'],
    ['iL3K-Q9M2', '113KQ9M2'], ['7F3K-Q9M', null], ['7F3K-Q9MU', null], ['', null], [null, null]]) {
    assert.equal(lib.cleanCode(typed), code, String(typed));
    assert.equal(buy.cleanCode(typed), code, `buy page: ${typed}`);
  }
  assert.equal(lib.showCode('7F3KQ9M2'), '7F3K-Q9M2');
});

test('a key id is six characters and the same for the same checkout', () => {
  assert.match(lib.keyId(SESSION), /^[a-z0-9]{6}$/);
  assert.equal(lib.keyId(SESSION), lib.keyId(SESSION));
  assert.notEqual(lib.keyId(SESSION), lib.keyId(`${SESSION}x`));
});

test('the name in a key is one line without control characters, or a stand-in', () => {
  assert.equal(lib.nameFrom({ customer_details: { name: '  Zoë\n Ångström\t' } }), 'Zoë Ångström');
  assert.equal(lib.nameFrom({ customer_details: { name: 'x'.repeat(200) } }).length, 80);
  assert.equal(lib.nameFrom({ customer_details: {} }), 'OpenExtract AI customer');
});

// ── /api/ai-key ───────────────────────────────────────────────────────────────

test('a paid $29 checkout gets a key for its iPhone, for good', async () => {
  const { fetchFn, calls } = stripe(paid());
  const out = await lib.keyForCheckout(get({ session_id: SESSION }), ENV, fetchFn);
  assert.equal(out.status, 200);
  assert.deepEqual({ ...out.body, key: undefined },
    { key: undefined, phone: '7F3K-Q9M2', kind: 'phone', until: null, name: 'Sarah Jones' });
  assert.deepEqual(readKey(out.body.key),
    { v: 1, n: 'Sarah Jones', k: 'phone', i: '2026-11-26', e: null, id: lib.keyId(SESSION), p: '7F3KQ9M2' });
  assert.equal(calls[0].url, `https://api.stripe.com/v1/checkout/sessions/${SESSION}?expand[]=line_items`);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer rk_test_x');
  // Asked again, the same key
  const again = await lib.keyForCheckout(get({ session_id: SESSION }), ENV, stripe(paid()).fetchFn);
  assert.equal(again.body.key, out.body.key);
});

test('a paid $9 checkout gets seven days for its iPhone', async () => {
  const out = await lib.keyForCheckout(get({ session_id: SESSION }), ENV,
    stripe(paid({ line_items: { data: [{ price: { id: 'price_week' } }] } })).fetchFn);
  assert.equal(out.status, 200);
  assert.equal(out.body.kind, 'week');
  assert.equal(out.body.until, '2026-12-03');
  const fields = readKey(out.body.key);
  assert.equal(fields.k, 'week');
  assert.equal(fields.e, '2026-12-03');
  assert.equal(fields.p, '7F3KQ9M2');
});

test('what can go wrong, said plainly', async () => {
  const cases = [
    [get({ session_id: SESSION }), paid({ payment_status: 'unpaid' }), 200, 402, /isn’t paid yet/],
    [get({ session_id: SESSION }), paid({ status: 'open' }), 200, 402, /isn’t paid yet/],
    [get({ session_id: SESSION }), paid({ client_reference_id: null }), 200, 422, /no phone code/],
    [get({ session_id: SESSION }), paid({ client_reference_id: 'not a phone code' }), 200, 422, /no phone code/],
    [get({ session_id: SESSION }), paid({ line_items: { data: [{ price: { id: 'price_other' } }] } }), 200, 422, /isn’t for OpenExtract AI/],
    [get({ session_id: SESSION }), {}, 404, 404, /no purchase/],
    [get({ session_id: SESSION }), {}, 500, 502, /Stripe didn’t answer/],
    [get({ session_id: 'cs_live_short' }), paid(), 200, 400, /purchase number/],
    [get({ session_id: '../../v1/customers' }), paid(), 200, 400, /purchase number/],
    [get({}), paid(), 200, 400, /purchase number/],
    [{ method: 'POST', query: { session_id: SESSION } }, paid(), 200, 405, /GET/],
  ];
  for (const [req, session, stripeStatus, status, says] of cases) {
    const out = await lib.keyForCheckout(req, ENV, stripe(session, stripeStatus).fetchFn);
    assert.equal(out.status, status, JSON.stringify(req) + JSON.stringify(session).slice(0, 60));
    assert.match(out.body.error, says);
    assert.equal(out.body.key, undefined);
  }
});

test('without its settings it makes no key and asks Stripe nothing', async () => {
  for (const missing of ['STRIPE_SECRET_KEY', 'AI_KEY_SIGNING_SEED', 'AI_PRICE_PHONE', 'AI_PRICE_WEEK']) {
    const { fetchFn, calls } = stripe(paid());
    const out = await lib.keyForCheckout(get({ session_id: SESSION }), { ...ENV, [missing]: '' }, fetchFn);
    assert.equal(out.status, 503, missing);
    assert.equal(calls.length, 0);
  }
  const out = await lib.keyForCheckout(get({ session_id: SESSION }), { ...ENV, AI_KEY_SIGNING_SEED: 'short' }, stripe(paid()).fetchFn);
  assert.equal(out.status, 503);
});

// ── The pages ─────────────────────────────────────────────────────────────────

test('the buy page adds the phone code to real payment links only', () => {
  assert.equal(buy.payLink('https://buy.stripe.com/abc123', '7F3KQ9M2'),
    'https://buy.stripe.com/abc123?client_reference_id=7F3KQ9M2');
  assert.equal(buy.payLink('https://buy.stripe.com/abc?prefilled_email=a', '7F3KQ9M2'),
    'https://buy.stripe.com/abc?prefilled_email=a&client_reference_id=7F3KQ9M2');
  assert.equal(buy.payLink('https://evil.example/buy', '7F3KQ9M2'), null);
  assert.equal(buy.payLink('', '7F3KQ9M2'), null);
  assert.equal(buy.payLink('https://buy.stripe.com/abc123', null), null);
});

test('the buy page and thank-you page aren’t for search engines, and load only the site’s own scripts', () => {
  for (const page of ['ai/buy.html', 'ai/thanks.html']) {
    const html = fs.readFileSync(path.join(root, 'website/static', page), 'utf-8');
    assert.match(html, /<meta name="robots" content="noindex" \/>/, page);
    const scripts = [...html.matchAll(/<script[^>]*src="([^"]+)"/g)].map(m => m[1]);
    assert.ok(scripts.every(src => src.startsWith('/')), `${page}: ${scripts}`);
  }
  const sitemap = fs.readFileSync(path.join(root, 'website/static/sitemap.xml'), 'utf-8');
  assert.doesNotMatch(sitemap, /\/ai\//);
});

test('the buy page says the prices and that each iPhone needs its own key', () => {
  const html = fs.readFileSync(path.join(root, 'website/static/ai/buy.html'), 'utf-8');
  assert.match(html, /\$29 <span>once<\/span>/);
  assert.match(html, /\$9 <span>for 7 days<\/span>/);
  assert.match(html, /Each iPhone needs its own key/);
  assert.match(html, /A new iPhone needs a new key/);
  assert.match(html, /nothing renews/);
  assert.match(html, /OpenExtract itself stays free/);
  assert.match(html, /goes to that AI company/);
});

test('the thank-you page says what the key covers and copies a message the AI app understands', () => {
  assert.equal(thanks.describe({ phone: '7F3K-Q9M2', kind: 'phone', until: null }),
    'For the iPhone with phone code 7F3K-Q9M2, for good.');
  assert.equal(thanks.describe({ phone: '7F3K-Q9M2', kind: 'week', until: '2026-12-03' }),
    'For the iPhone with phone code 7F3K-Q9M2, through 2026-12-03.');
  assert.equal(thanks.message('OEAI1-abc'), 'Here is my OpenExtract AI key: OEAI1-abc');
});
