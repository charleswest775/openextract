// OpenExtract AI on the website: the product page (/ai), its setup guide and launch post, and the
// rule that AI is offered only to people who already use an AI app. So the home page, the download
// pages, the main nav and the footer never mention it; only the app's Ask AI screen, the guide,
// the blog and the pages around /ai do. The app links to /ai and the guide by their exact paths.
// /ai/buy and /ai/thanks stay out of search engines (scripts/ai-key.test.mjs checks those too).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const site = path.join(root, 'website/static');
const read = rel => fs.readFileSync(path.join(site, rel), 'utf8');
const SITE = 'https://www.openextract.app';

const PRODUCT = 'ai.html';
const GUIDE = 'use-cases/ask-claude-about-your-iphone-backup.html';
const POST = 'blog/introducing-openextract-ai.html';
const NEW_PAGES = [PRODUCT, GUIDE, POST];

// Words that would put AI in front of someone who didn't come looking for it.
const AI_WORDS = [/\bAI\b/, /claude/i, /chatgpt/i, /anthropic/i, /openai/i, /\bMCP\b/, /artificial intelligence/i,
  /href="\/ai(?:[/"?#]|$)/, /openextract\.app\/ai\b/];
const aiWordsIn = text => AI_WORDS.filter(re => re.test(text)).map(String);

const pages = fs.readdirSync(site, { recursive: true })
  .filter(f => f.endsWith('.html'))
  .map(f => f.split(path.sep).join('/'));
const sitemap = read('sitemap.xml');
const urlOf = page => `${SITE}/${page.replace(/\.html$/, '')}`;

test('the app’s links have pages behind them: /ai and the setup guide', () => {
  for (const page of [PRODUCT, GUIDE]) {
    assert.ok(fs.existsSync(path.join(site, page)), `website/static/${page} exists (the app links to it)`);
  }
});

test('the home page and the download pages never mention AI', () => {
  const offLimits = ['index.html', ...pages.filter(p => p.startsWith('download/'))];
  assert.ok(offLimits.length >= 5, `home page and download pages found: ${offLimits}`);
  for (const page of offLimits) {
    assert.deepEqual(aiWordsIn(read(page)), [], `${page} mentions AI`);
  }
});

test('no page’s main nav or footer mentions AI', () => {
  for (const page of pages) {
    const html = read(page);
    for (const block of html.match(/<nav class="nav"[\s\S]*?<\/nav>/g) || []) {
      assert.deepEqual(aiWordsIn(block), [], `${page}: the main nav mentions AI`);
    }
    for (const block of html.match(/<footer[\s\S]*?<\/footer>/g) || []) {
      assert.deepEqual(aiWordsIn(block), [], `${page}: the footer mentions AI`);
    }
  }
});

test('the product page, guide and launch post are public: indexable, canonical and in the sitemap', () => {
  for (const page of NEW_PAGES) {
    const html = read(page);
    const url = urlOf(page);
    assert.match(html, /<meta name="robots" content="index, follow/, `${page} is indexable`);
    assert.ok(html.includes(`<link rel="canonical" href="${url}" />`), `${page}'s canonical is ${url}`);
    assert.ok(sitemap.includes(`<loc>${url}</loc>`), `${url} is in the sitemap`);
    for (const [, json] of html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
      assert.doesNotThrow(() => JSON.parse(json), `${page}: its JSON-LD parses`);
    }
  }
});

test('/ai/buy and /ai/thanks stay noindex and out of the sitemap', () => {
  for (const page of ['ai/buy.html', 'ai/thanks.html']) {
    assert.match(read(page), /<meta name="robots" content="noindex" \/>/, page);
    assert.ok(!sitemap.includes(urlOf(page)), `${page} isn't in the sitemap`);
  }
});

test('the product page’s prices are the buy page’s: $29 once, $9 for 7 days', () => {
  const buy = read('ai/buy.html');
  const prices = [...buy.matchAll(/<div class="ai-buy__price">(\$\d+ <span>[^<]+<\/span>)<\/div>/g)].map(m => m[1]);
  assert.deepEqual(prices, ['$29 <span>once</span>', '$9 <span>for 7 days</span>']);
  const product = read(PRODUCT);
  for (const price of prices) assert.ok(product.includes(price), `ai.html shows ${price}`);
  const offers = JSON.parse(product.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]).offers;
  assert.deepEqual(offers.map(o => o.price), ['29', '9']);
});

test('the new pages name no other price than $29 and $9', () => {
  for (const page of NEW_PAGES) {
    const amounts = [...read(page).matchAll(/\$(\d+(?:\.\d+)?)/g)].map(m => m[1]);
    assert.ok(amounts.length > 0, `${page} says what it costs`);
    assert.deepEqual([...new Set(amounts)].filter(a => a !== '29' && a !== '9'), [], `${page}: other prices`);
  }
});

test('the pages say plainly where what the AI reads goes, and that passwords never go to it', () => {
  for (const page of [PRODUCT, GUIDE, POST]) {
    const html = read(page);
    assert.match(html, /Anthropic for Claude|Claude app sends to Anthropic/, `${page} names Anthropic for Claude`);
    assert.match(html, /OpenAI/, `${page} names OpenAI`);
    assert.match(html, /OpenExtract sends nothing/, page);
    assert.match(html, /password never goes to the AI|[Pp]asswords? never go(?:es)? to the AI/, page);
  }
  assert.match(read('privacy.html'), /<h2 id="ai">OpenExtract AI<\/h2>/);
});

test('the guide and the post are linked from their lists, the buy page and each other', () => {
  assert.match(read('guides.html'), /href="\/use-cases\/ask-claude-about-your-iphone-backup"/);
  assert.match(read('guides.html'), /"url": "https:\/\/www\.openextract\.app\/use-cases\/ask-claude-about-your-iphone-backup"/);
  assert.match(read('blog.html'), /href="\/blog\/introducing-openextract-ai"/);
  assert.match(read('ai/buy.html'), /href="\/use-cases\/ask-claude-about-your-iphone-backup"/);
  assert.match(read(PRODUCT), /href="\/ai\/buy"/);
  assert.match(read(PRODUCT), /href="\/use-cases\/ask-claude-about-your-iphone-backup"/);
  assert.match(read(GUIDE), /href="\/ai"/);
  const llms = read('llms.txt');
  assert.ok(llms.includes(`${SITE}/ai)`) && llms.includes(urlOf(GUIDE)), 'llms.txt lists /ai and the guide');
});

test('the guide answers the questions the app sends people there with', () => {
  const guide = read(GUIDE);
  for (const id of ['first-questions', 'keys', 'encrypted', 'troubleshooting']) {
    assert.match(guide, new RegExp(`id="${id}"`), `the guide has #${id}`);
  }
  assert.match(guide, /last opened in OpenExtract/, 'which backup the AI reads');
  assert.match(guide, /Full Disk Access/);
  assert.match(guide, /Settings<\/strong>, then <strong>Extensions<\/strong>, click <strong>Advanced settings<\/strong>, then <strong>Install Extension/);
  assert.match(guide, /key is for another iPhone/);
  assert.match(guide, /Never paste a backup password into the chat/);
});

test('who makes it is said the usual way', () => {
  for (const page of NEW_PAGES) {
    const text = read(page);
    assert.doesNotMatch(text, /(?:made|built|run|maintained) by (?:one person|a community)|\bsolo (?:developer|dev|project)\b/i,
      `${page}: say "an independent developer, with help from contributors"`);
  }
  assert.match(read(PRODUCT), /independent developer, with help from contributors/);
});
