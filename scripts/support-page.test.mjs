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
