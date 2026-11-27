'use strict';

// OpenExtract AI keys for what people buy (the add-on's docs/LICENSING.md, in its own repo).
//
// A key unlocks questions about one iPhone, named by its phone code: the add-on works the code out from
// the phone's unique ID and puts it in the buy link (/ai/buy?phone=7F3KQ9M2). The buy page sends people to
// a Stripe payment link with that code as client_reference_id. Stripe sends them back to
// /ai/thanks?session_id=cs_..., and that page asks GET /api/ai-key?session_id=... for their key.
//
// Here: look the checkout up at Stripe, check it's paid, see which price it was (AI_PRICE_PHONE: $29, the
// iPhone for good; AI_PRICE_WEEK: $9, seven days), and sign the key with the store's signing key
// (AI_KEY_SIGNING_SEED, made by the add-on's tools/make_key.py --init-store). Nothing is stored: the same
// checkout always gives the same key (its id comes from the checkout's id, and Ed25519 signatures don't
// change), so the page can be opened again to see it, and Stripe is the record of who paid.
//
// A key is "OEAI1-" and base64url (no padding) of payload + its 64-byte signature. The payload is compact
// JSON in this order: {"v":1,"n":name,"k":kind,"i":issued,"e":last day or null,"id":six characters,
// "p":phone code}. tools/make_key.py in the add-on's repo writes the same bytes for the same fields, and
// scripts/ai-key.test.mjs checks a key from each against the other.

const crypto = require('node:crypto');

const KEY_PREFIX = 'OEAI1-';
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ID_CHARACTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';
const WEEK_DAYS = 7;
const NAME_LIMIT = 80;
const DEFAULT_NAME = 'OpenExtract AI customer';
const SESSION_PATTERN = /^cs_(test|live)_[A-Za-z0-9]{10,250}$/;
// An Ed25519 private key in PKCS#8 form is this prefix and the 32-byte seed.
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

const NOT_SET_UP = { status: 503, body: { error: 'Keys can’t be made right now. Please try again later.' } };

/** A phone code as typed ("7f3k-q9m2", O for 0, I or L for 1) in its stored form, or null. Same as the add-on's. */
function cleanCode(text) {
  const code = String(text ?? '').replace(/\s+/g, '').replace(/-/g, '').toUpperCase()
    .replace(/O/g, '0').replace(/[IL]/g, '1');
  return code.length === 8 && [...code].every(c => CROCKFORD.includes(c)) ? code : null;
}

/** "7F3K-Q9M2". */
function showCode(code) {
  return code ? `${code.slice(0, 4)}-${code.slice(4)}` : '';
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(text) {
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length % 4 === 1) throw new Error('not base64url');
  return Buffer.from(text.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

/** The 32-byte signing seed from AI_KEY_SIGNING_SEED (base64url), or null if it isn't one. */
function seedFrom(text) {
  try {
    const seed = unb64url(String(text || '').trim());
    return seed.length === 32 ? seed : null;
  } catch {
    return null;
  }
}

function privateKey(seed) {
  return crypto.createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

/** The public key as the add-on's PUBLIC_KEYS holds it: base64url of its 32 bytes. */
function publicKeyOf(seed) {
  const spki = crypto.createPublicKey(privateKey(seed)).export({ format: 'der', type: 'spki' });
  return b64url(spki.subarray(spki.length - 32));
}

/** A key: OEAI1- and base64url of the payload and its signature. */
function makeKey(seed, { name, kind, issued, until, id, phone }) {
  const fields = { v: 1, n: name, k: kind, i: issued, e: until ?? null, id };
  if (phone) fields.p = phone;
  const payload = Buffer.from(JSON.stringify(fields), 'utf8');
  const signature = crypto.sign(null, payload, privateKey(seed));
  return KEY_PREFIX + b64url(Buffer.concat([payload, signature]));
}

/** The key's six-character id, the same every time for one checkout. */
function keyId(sessionId) {
  const digest = crypto.createHash('sha256').update(`openextract-ai key:${sessionId}`).digest();
  let n = digest.readUInt32BE(0);
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += ID_CHARACTERS[n % 36];
    n = Math.floor(n / 36);
  }
  return id;
}

/** The buyer's name for the key ("Questions are unlimited with Sarah's key"): one line, no control characters. */
function nameFrom(session) {
  const raw = String(session?.customer_details?.name || '').replace(/\p{C}/gu, ' ').replace(/\s+/g, ' ').trim();
  return [...raw].slice(0, NAME_LIMIT).join('') || DEFAULT_NAME;
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** GET /api/ai-key?session_id=cs_...: the key a paid checkout bought. */
async function keyForCheckout(req, env, fetchFn) {
  if (req.method !== 'GET') return { status: 405, body: { error: 'Use GET.' } };
  const seed = seedFrom(env.AI_KEY_SIGNING_SEED);
  if (!env.STRIPE_SECRET_KEY || !seed || !env.AI_PRICE_PHONE || !env.AI_PRICE_WEEK) return NOT_SET_UP;

  const sessionId = String(req.query?.session_id || '');
  if (!SESSION_PATTERN.test(sessionId)) {
    return { status: 400, body: { error: 'This link is missing its purchase number. Open the page you were sent to after paying again.' } };
  }
  const res = await fetchFn(
    `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}?expand[]=line_items`,
    { headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` } },
  );
  if (res.status === 404) return { status: 404, body: { error: 'There’s no purchase with this number.' } };
  if (!res.ok) {
    console.error(`[ai-key] Stripe answered ${res.status}`);
    return { status: 502, body: { error: 'Stripe didn’t answer. Please try again in a minute.' } };
  }
  const session = await res.json();
  if (session.status !== 'complete' || session.payment_status !== 'paid') {
    return { status: 402, body: { error: 'This purchase isn’t paid yet. If you just paid, wait a minute and reload this page.' } };
  }
  const phone = cleanCode(session.client_reference_id);
  if (!phone) {
    return { status: 422, body: { error: 'This purchase has no phone code, so no key can be made for it. Use Send feedback in OpenExtract, with your receipt, and we’ll sort it out.' } };
  }
  const prices = (session.line_items?.data || []).map(item => item?.price?.id);
  const kind = prices.includes(env.AI_PRICE_PHONE) ? 'phone' : prices.includes(env.AI_PRICE_WEEK) ? 'week' : null;
  if (!kind) {
    return { status: 422, body: { error: 'This purchase isn’t for OpenExtract AI. If that’s wrong, use Send feedback in OpenExtract, with your receipt.' } };
  }
  const issued = new Date(Number(session.created) * 1000).toISOString().slice(0, 10);
  const until = kind === 'week' ? addDays(issued, WEEK_DAYS) : null;
  const name = nameFrom(session);
  const key = makeKey(seed, { name, kind, issued, until, id: keyId(sessionId), phone });
  return { status: 200, body: { key, phone: showCode(phone), kind, until, name } };
}

/** The Vercel Node handler. */
async function handler(req, res) {
  let out;
  try {
    out = await keyForCheckout({ method: req.method, query: req.query }, process.env, fetch);
  } catch (err) {
    console.error('[ai-key] failed:', err && err.message);
    out = { status: 500, body: { error: 'Something went wrong. Please try again later.' } };
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(out.status).json(out.body);
}

module.exports = {
  KEY_PREFIX,
  WEEK_DAYS,
  cleanCode,
  showCode,
  seedFrom,
  publicKeyOf,
  makeKey,
  keyId,
  nameFrom,
  addDays,
  keyForCheckout,
  handler,
};
