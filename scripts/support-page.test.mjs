// "Pay it forward": the app's "Pay $5" buttons open openextract.app/support/pay, the site's
// "Pay it forward" links go to /support, and that page's buttons go to /support/pay, which
// vercel.json redirects to the Stripe payment link. Keeping the link in that one redirect means
// the payment service can change without an app release. These tests keep the pieces pointing
// at each other.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const site = 'website/static';
const pages = fs.readdirSync(path.join(root, site), { recursive: true }).filter(f => f.endsWith('.html'));

test('the app pays through the site\'s /support/pay redirect', () => {
  const m = read('src/lib/payItForward.ts').match(/export const SUPPORT_PAY_URL = '([^']+)'/);
  assert.ok(m, 'src/lib/payItForward.ts exports SUPPORT_PAY_URL');
  assert.equal(m[1], 'https://www.openextract.app/support/pay');
  assert.ok(fs.existsSync(path.join(root, site, 'support.html')), 'website/static/support.html exists');
});

test('the support page pays through /support/pay', () => {
  const page = read(`${site}/support.html`);
  assert.match(page, /href="\/support\/pay"/);
  assert.match(page, /<link rel="canonical" href="https:\/\/www\.openextract\.app\/support" \/>/);
  assert.match(read(`${site}/sitemap.xml`), /<loc>https:\/\/www\.openextract\.app\/support<\/loc>/);
});

test('/support/pay redirects to a live Stripe payment link', () => {
  const { redirects } = JSON.parse(read(`${site}/vercel.json`));
  const pay = redirects.find(r => r.source === '/support/pay');
  assert.ok(pay, 'vercel.json has a /support/pay redirect');
  assert.equal(pay.permanent, false, 'temporary, so a new link takes effect for people who already followed it');
  // Live links are buy.stripe.com/<code>; test-mode links are buy.stripe.com/test_<code>.
  assert.match(pay.destination, /^https:\/\/buy\.stripe\.com\/(?!test_)[A-Za-z0-9]+$/,
    `${pay.destination} isn't a live Stripe payment link`);
});

test('every amount on the support page has a /support/pay/... redirect to a live Stripe link', () => {
  // $5, $25, $100 and the paid-work rates each get their own path, so each points at its own Stripe
  // link and a link can change without touching the page. $5 shares the pay-what-you-want link
  // (it opens at $5); the others are fixed-price links of their own.
  const page = read(`${site}/support.html`);
  const paths = [...new Set([...page.matchAll(/href="(\/support\/pay\/[^"]+)"/g)].map(m => m[1]))];
  assert.deepEqual(paths.sort(), ['/support/pay/100', '/support/pay/25', '/support/pay/5', '/support/pay/case', '/support/pay/year']);
  const { redirects } = JSON.parse(read(`${site}/vercel.json`));
  for (const p of paths) {
    const r = redirects.find(x => x.source === p);
    assert.ok(r, `vercel.json has a ${p} redirect`);
    assert.equal(r.permanent, false, `${p} is temporary`);
    assert.match(r.destination, /^https:\/\/buy\.stripe\.com\/(?!test_)[A-Za-z0-9]+$/, `${p} → ${r.destination}`);
  }
  const dest = p => redirects.find(x => x.source === p).destination;
  assert.equal(dest('/support/pay/5'), dest('/support/pay'), '$5 opens the pay-what-you-want link');
  const fixed = ['/support/pay/25', '/support/pay/100', '/support/pay/case', '/support/pay/year'].map(dest);
  assert.equal(new Set([...fixed, dest('/support/pay')]).size, 5, 'each fixed amount has its own link');
});

test('every page footer links to the support page', () => {
  const withFooter = pages.filter(f => read(`${site}/${f}`).includes('<li><a href="/about">About</a></li>'));
  assert.ok(withFooter.length > 10);
  for (const f of withFooter) {
    assert.ok(read(`${site}/${f}`).includes('<li><a href="/support">Pay it forward</a></li>'), `${f} footer`);
  }
});

test('every page with the top bar has "Pay it forward" in it, next to GitHub', () => {
  const withNav = pages.filter(f => read(`${site}/${f}`).includes('class="nav__gh"'));
  assert.ok(withNav.length > 10);
  for (const f of withNav) {
    const html = read(`${site}/${f}`);
    assert.match(html, /<a class="nav__pay" href="\/support" aria-label="[^"]+"><svg[^>]*aria-hidden="true">.*?<\/svg><span class="nav__pay-label">[^<]+<\/span><\/a>\s*<a class="nav__gh"/, `${f} top bar`);
  }
});
