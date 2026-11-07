// Writes the problems on the "Fixes for common problems" page (website/static/fixes.html) from
// the known fixes the app shows after a report (website/static/api/_lib/known-fixes.js), so the
// page and the app never disagree. Run it after editing known-fixes.js:
//
//   node scripts/build-fixes-page.mjs
//
// It replaces only what's between the page's "fixes:" markers; the rest is ordinary HTML.
// scripts/fixes-page.test.mjs fails while the page is out of date.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const PAGE = path.join(root, 'website/static/fixes.html');
export const PAGE_URL = 'https://www.openextract.app/fixes';
export const { KNOWN_FIXES } = require(path.join(root, 'website/static/api/_lib/known-fixes.js'));

// The page's sections, in order. Every fix's `area` must be one of these.
export const AREAS = [
  ['backup', 'Backing up an iPhone'],
  ['open', 'Opening a backup'],
  ['app', 'Starting OpenExtract'],
];

const escape = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function fixHtml(fix) {
  const seen = fix.seen.map(s => `<code>${escape(s)}</code>`).join(' or ');
  return [
    `      <div class="fix" id="${escape(fix.id)}">`,
    `        <h3>${escape(fix.title)}</h3>`,
    `        <p class="fix__seen">What you see: ${seen}</p>`,
    ...(fix.fixedIn
      ? [`        <p class="fix__status">Fixed in OpenExtract ${escape(fix.fixedIn)}. <a href="/#download">Get the latest version</a>.</p>`]
      : []),
    `        <p>${escape(fix.text)}</p>`,
    '      </div>',
  ].join('\n');
}

/** The problems, one section per area, for between <!-- fixes:start --> and <!-- fixes:end -->. */
export function renderFixes(fixes = KNOWN_FIXES) {
  return AREAS
    .map(([area, heading]) => [area, heading, fixes.filter(f => f.area === area)])
    .filter(([, , list]) => list.length)
    .map(([area, heading, list]) => [`      <h2 id="${area}">${escape(heading)}</h2>`, ...list.map(fixHtml)].join('\n'))
    .join('\n\n');
}

/** schema.org FAQPage data, for between <!-- fixes-data:start --> and <!-- fixes-data:end -->. */
export function renderStructuredData(fixes = KNOWN_FIXES) {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    name: 'Fixes for common OpenExtract problems',
    url: PAGE_URL,
    mainEntity: fixes.map(f => ({
      '@type': 'Question',
      name: f.title,
      url: `${PAGE_URL}#${f.id}`,
      acceptedAnswer: { '@type': 'Answer', text: f.text },
    })),
  };
  // "<" can't end the script element early once it's escaped.
  const json = JSON.stringify(data, null, 2).replace(/</g, '\\u003c');
  return `  <script type="application/ld+json">\n${json.replace(/^/gm, '  ')}\n  </script>`;
}

function replaceBetween(html, name, content) {
  const re = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(\\n[ \\t]*<!-- ${name}:end -->)`);
  if (!re.test(html)) throw new Error(`${path.relative(root, PAGE)} has no <!-- ${name}:start --> … <!-- ${name}:end --> markers`);
  return html.replace(re, (_, start, end) => `${start}\n${content}${end}`);
}

/**
 * The page with its generated parts brought up to date, in the page's own line endings: a
 * Windows checkout can turn them into CRLF.
 */
export function buildPage(html, fixes = KNOWN_FIXES) {
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const lf = html.replace(/\r\n/g, '\n');
  return replaceBetween(replaceBetween(lf, 'fixes-data', renderStructuredData(fixes)), 'fixes', renderFixes(fixes))
    .replace(/\n/g, eol);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const before = fs.readFileSync(PAGE, 'utf8');
  const after = buildPage(before);
  if (after === before) {
    console.log(`${path.relative(root, PAGE)} is up to date.`);
  } else {
    fs.writeFileSync(PAGE, after);
    console.log(`Updated ${path.relative(root, PAGE)}.`);
  }
}
