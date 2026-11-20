// Writes the backup file reference on openextract.app: one page per file at
// website/static/backup-files/<slug>.html, plus the lookup table and its list data on the hub,
// website/static/backup-files.html (between the hub's "backup-files:" markers). Both come from
// website/backup-files/:
//
//   files.json     hand-written: what each file is, which app writes it, what OpenExtract does with it
//   verified.json  written by scripts/verify-backup-files.py from real backups: the iOS versions
//                  each file was seen in, its table names, and which key columns it has
//
// Run it after editing either one, or the hub's nav or footer (the file pages copy them):
//
//   node scripts/build-backup-file-pages.mjs
//
// scripts/backup-file-pages.test.mjs fails while a page is out of date.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(root, 'website/backup-files');
export const HUB = path.join(root, 'website/static/backup-files.html');
export const PAGES_DIR = path.join(root, 'website/static/backup-files');
export const SITE = 'https://www.openextract.app';
export const HUB_URL = `${SITE}/backup-files`;
export const OG_IMAGE = `${SITE}/img/og-image.png`;

const readJson = name => JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
export const DATA = readJson('files.json');
export const FILES = DATA.files;
export const VERIFIED = readJson('verified.json');

/** What an iPhone backup names a file: the SHA-1 of "<domain>-<relativePath>". */
export const fileId = (domain, relativePath) =>
  crypto.createHash('sha1').update(`${domain}-${relativePath}`, 'utf8').digest('hex');

export const pageUrl = file => `${HUB_URL}/${file.slug}`;
export const pagePath = file => path.join(PAGES_DIR, `${file.slug}.html`);
export const storedAt = file => `${file.fileID.slice(0, 2)}/${file.fileID}`;

/** The page title: the full hash and the name if they fit in 60 characters, else the name and the hash's start. */
export function pageTitle(file) {
  const candidates = [
    `${file.fileID} is ${file.name}`,
    `${file.fileID}: ${file.name}`,
    `${file.titleName ?? file.name} (${file.fileID.slice(0, 8)}…) in an iPhone backup`,
  ];
  return candidates.find(t => t.length <= 60) ?? candidates[candidates.length - 1];
}

const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** files.json text to HTML: `code` and [text](/link); everything else is escaped. */
export function inline(text) {
  return String(text).split('`').map((part, i) => (i % 2
    ? `<code>${esc(part)}</code>`
    : esc(part).replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, href) => `<a href="${href}">${label}</a>`)
  )).join('');
}

/** files.json text with the markup taken out, for structured data. */
export const plain = text => String(text).replace(/`/g, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

const versionParts = v => v.split('.').map(Number);
export function compareVersions(a, b) {
  const x = versionParts(a), y = versionParts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** "a", "a and b", "a, b and c". */
export function andList(items) {
  if (items.length < 2) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}
const iosList = versions => `iOS ${andList(versions)}`;
const codeList = names => names.map(n => `<code>${esc(n)}</code>`).join(', ');

function verifiedFor(file) {
  const v = VERIFIED.files[file.slug];
  if (!v) throw new Error(`${file.slug} isn't in verified.json: run scripts/verify-backup-files.py`);
  return v;
}

// ── Structured data ─────────────────────────────────────────────────────

const ORGANIZATION = {
  '@type': 'Organization',
  name: 'OpenExtract',
  url: `${SITE}/`,
  logo: { '@type': 'ImageObject', url: `${SITE}/img/logo.png` },
};
const APP = {
  '@type': 'SoftwareApplication',
  name: 'OpenExtract',
  applicationCategory: 'UtilityApplication',
  applicationSubCategory: 'DataExtraction',
  operatingSystem: 'Windows 10, Windows 11, macOS (Apple Silicon), Linux',
  url: `${SITE}/`,
  screenshot: `${SITE}/img/screens/home-2000.png`,
  downloadUrl: 'https://github.com/charleswest775/openextract/releases',
  license: 'https://opensource.org/licenses/MIT',
  isAccessibleForFree: true,
  offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
};

function jsonLd(data) {
  // "<" can't end the script element early once it's escaped.
  return `  <script type="application/ld+json">\n${JSON.stringify(data, null, 2).replace(/</g, '\\u003c')}\n  </script>`;
}

// ── A file's page ───────────────────────────────────────────────────────

function head(file) {
  const url = pageUrl(file);
  const title = pageTitle(file);
  const article = {
    '@context': 'https://schema.org',
    '@type': 'TechArticle',
    headline: `${file.fileID} is ${file.name}`,
    name: title,
    description: file.description,
    url,
    datePublished: DATA.published,
    dateModified: DATA.updated,
    image: OG_IMAGE,
    keywords: [file.fileID, file.name, `${file.domain}-${file.relativePath}`, 'iPhone backup'],
    isPartOf: { '@type': 'WebSite', name: 'OpenExtract', url: `${SITE}/` },
    publisher: ORGANIZATION,
    about: APP,
  };
  const breadcrumbs = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: `${SITE}/` },
      { '@type': 'ListItem', position: 2, name: 'Backup files', item: HUB_URL },
      { '@type': 'ListItem', position: 3, name: file.name, item: url },
    ],
  };
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta name="theme-color" content="#faf6f1" />
  <title>${esc(title)}</title>
  <meta name="description" content="${esc(file.description)}" />
  <link rel="canonical" href="${url}" />
  <meta name="robots" content="index, follow, max-image-preview:large" />
  <meta property="og:type" content="article" />
  <meta property="og:url" content="${url}" />
  <meta property="og:title" content="${esc(`${file.name} in an iPhone backup (${file.fileID})`)}" />
  <meta property="og:description" content="${esc(plain(file.summary))}" />
  <meta property="og:image" content="${OG_IMAGE}" />
  <meta name="twitter:card" content="summary_large_image" />
  <link rel="icon" href="/favicon.ico" sizes="any" />
  <link rel="icon" type="image/svg+xml" href="/img/logo.svg" />
${jsonLd(article)}
${jsonLd(breadcrumbs)}
  <script defer src="/_vercel/insights/script.js"></script>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist:wght@300;400;500;600;700&family=Instrument+Serif:ital@0;1&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/site.css" />
</head>`;
}

function factsTable(file, v) {
  const seen = [`${iosList(v.seenIn)}.`];
  if (v.notSeenIn.length) seen.push(`Not in the ${iosList(v.notSeenIn)} ${v.notSeenIn.length === 1 ? 'backup' : 'backups'} we checked.`);
  const encrypted = file.encryptedOnly
    ? `Yes. ${inline(file.encryptionNote ?? '')}`.trim()
    : `No. ${inline(file.encryptionNote ?? 'Unencrypted backups have it too.')}`;
  const oe = file.openextract
    ? `Yes, on the ${esc(file.openextract.screens[0])} screen. Guide: <a href="${file.openextract.guide}">${esc(file.openextract.guideTitle)}</a>`
    : 'Not yet.';
  const rows = [
    ['Real name', `<code>${esc(file.name)}</code>`],
    ['Domain', `<code>${esc(file.domain)}</code>`],
    ['Path', `<code>${esc(file.relativePath)}</code>`],
    ['In the backup folder', `<code>${esc(storedAt(file))}</code>`],
    ['Its name is the SHA-1 of', `<code>${esc(`${file.domain}-${file.relativePath}`)}</code>`],
    ['App', esc(file.app)],
    ['Seen in', seen.join(' ')],
    ['Needs an encrypted backup', encrypted],
    ['OpenExtract reads it', oe],
  ];
  return [
    '      <div class="matrix ref-scroll">',
    '        <table>',
    '          <tbody>',
    ...rows.map(([k, val]) => `            <tr><td class="matrix__k">${k}</td><td class="matrix__cell">${val}</td></tr>`),
    '          </tbody>',
    '        </table>',
    '      </div>',
  ].join('\n');
}

/** Key columns, one line each, with the iOS versions a column is missing from (if any). */
function keyColumns(file, v) {
  const aliases = file.tableAliases ?? {};
  const versionsWithTables = Object.keys(v.tables ?? {});
  const lines = [];
  for (const [table, columns] of Object.entries(file.keyColumns ?? {})) {
    if (aliases[table]) continue; // shown under the table it's another name for
    const names = [table, ...Object.keys(aliases).filter(a => aliases[a] === table)];
    for (const column of columns) {
      const present = versionsWithTables.filter(ver => names.some(t => (v.columns?.[ver]?.[t] ?? []).includes(column)));
      const missing = versionsWithTables.filter(ver => !present.includes(ver));
      if (!present.length) throw new Error(`${file.slug}: ${table}.${column} isn't in any backup we read; check files.json`);
      const note = file.columnNotes?.[`${table}.${column}`];
      if (!note) throw new Error(`${file.slug}: no columnNotes entry for ${table}.${column}`);
      const gap = missing.length ? ` Not in ${iosList(missing)}.` : '';
      lines.push(`        <li><code>${esc(table)}.${esc(column)}</code>: ${inline(note)}${gap}</li>`);
    }
  }
  if (!lines.length) return '';
  const renamed = Object.entries(aliases).map(([alias, table]) => {
    const versions = versionsWithTables.filter(ver => (v.tables[ver] ?? []).includes(alias));
    return versions.length
      ? `      <p>In ${iosList(versions)}, <code>${esc(table)}</code> is called <code>${esc(alias)}</code>, with the same columns.</p>`
      : '';
  }).filter(Boolean);
  return [
    '      <h2 id="columns">Key columns</h2>',
    ...renamed,
    '      <ul>',
    ...lines,
    '      </ul>',
  ].join('\n');
}

function plistKeys(file, v) {
  if (!file.keyNames?.length) return '';
  const versions = Object.keys(v.keys ?? {});
  const lines = file.keyNames.map(key => {
    const present = versions.filter(ver => v.keys[ver].includes(key));
    if (!present.length) throw new Error(`${file.slug}: key ${key} isn't in any backup we read`);
    const missing = versions.filter(ver => !present.includes(ver));
    const gap = missing.length ? ` In ${iosList(present)}; not in ${iosList(missing)}.` : '';
    return `        <li><code>${esc(key)}</code>: ${inline(file.keyNotes[key])}${gap}</li>`;
  });
  return [
    '      <h2 id="keys">Keys OpenExtract reads</h2>',
    '      <ul>',
    ...lines,
    '      </ul>',
  ].join('\n');
}

function tablesByVersion(file, v) {
  const versions = Object.keys(v.tables ?? {}).sort(compareVersions);
  if (!versions.length) return '';
  const unread = v.seenIn.filter(ver => !versions.includes(ver));
  const out = ['      <h2 id="tables">Tables by iOS version</h2>'];
  const first = v.tables[versions[0]];
  const same = versions.every(ver => v.tables[ver].join() === first.join());
  if (same) {
    out.push(`      <p>The same ${first.length} tables in every backup we opened (${iosList(versions)}):</p>`);
    out.push(`      <p>${codeList(first)}</p>`);
  } else {
    out.push(`      <p>iOS ${versions[0]} has ${first.length} tables:</p>`);
    out.push(`      <p>${codeList(first)}</p>`);
    out.push('      <p>Then, version by version:</p>');
    out.push('      <ul>');
    for (let i = 1; i < versions.length; i++) {
      const before = new Set(v.tables[versions[i - 1]]);
      const now = v.tables[versions[i]];
      const added = now.filter(t => !before.has(t));
      const dropped = [...before].filter(t => !now.includes(t));
      const changes = [
        added.length ? `adds ${codeList(added)}` : '',
        dropped.length ? `drops ${codeList(dropped)}` : '',
      ].filter(Boolean).join('; ');
      out.push(`        <li><strong>iOS ${versions[i]}</strong> (${now.length} tables): ${changes ? `${changes}.` : `the same as iOS ${versions[i - 1]}.`}</li>`);
    }
    out.push('      </ul>');
  }
  if (unread.length) {
    out.push(`      <p>The ${iosList(unread)} backup is encrypted with a password that isn't public, so only its list of files was checked, not its tables.</p>`);
  }
  return out.join('\n');
}

function howToOpen(file) {
  const out = ['      <h2 id="open">How to open it</h2>'];
  const oe = file.openextract;
  if (oe) {
    const [screen, ...more] = oe.screens;
    const also = more.length ? ` ${andList(more)} ${more.length === 1 ? 'uses' : 'use'} it too.` : '';
    out.push(`      <p><strong>Free, in OpenExtract.</strong> Open the backup in <a href="/#download">OpenExtract</a> and choose ${esc(screen)}.${also} ${inline(oe.note)} Step by step: <a href="${oe.guide}">${esc(oe.guideTitle)}</a>.</p>`);
  } else {
    out.push(`      <p><strong>OpenExtract doesn't read it yet.</strong> ${inline(file.notRead)}</p>`);
  }
  const copy = `<code>${esc(storedAt(file))}</code>`;
  const viewer = file.kind === 'plist'
    ? 'any property list viewer, or with <code>plutil -p</code> on a Mac'
    : 'any SQLite browser, such as <a href="https://sqlitebrowser.org/">DB Browser for SQLite</a>';
  if (!file.encryptedOnly) {
    out.push(`      <p><strong>By hand.</strong> In a backup that isn't encrypted, ${copy} is an ordinary ${file.kind === 'plist' ? 'property list' : 'SQLite database'} with no extension. Copy it out of the backup folder and open the copy with ${viewer}. Work on a copy: changing anything inside a backup can stop it from restoring.</p>`);
  }
  const decrypt = oe
    ? 'OpenExtract does that when you open the backup and type its password.'
    : 'Tools such as <a href="https://github.com/jsharkey13/iphone_backup_decrypt">iphone_backup_decrypt</a>, the open-source library OpenExtract uses, can decrypt a single file; then open the decrypted copy with ' + viewer + '.';
  out.push(file.encryptedOnly
    ? `      <p><strong>Always encrypted on disk.</strong> This file is only in encrypted backups, so the copy in the backup folder is encrypted with a key of its own, which only the backup password unlocks. Nothing can open it until it's decrypted. ${decrypt}</p>`
    : `      <p><strong>In an encrypted backup,</strong> the file in the backup folder is encrypted with a key of its own, which only the backup password unlocks, so nothing can open it until it's decrypted. ${decrypt}</p>`);
  return out.join('\n');
}

function related(file) {
  if (!file.related?.length) return '';
  const bySlug = new Map(FILES.map(f => [f.slug, f]));
  const items = file.related.map(slug => {
    const other = bySlug.get(slug);
    if (!other) throw new Error(`${file.slug}: related file ${slug} isn't in files.json`);
    return `        <li><a href="/backup-files/${other.slug}">${esc(other.name)}</a>: ${inline(other.summary)}</li>`;
  });
  return ['      <h2 id="related">Related files</h2>', '      <ul>', ...items, '      </ul>'].join('\n');
}

function checkedNote(v) {
  const read = VERIFIED.backups.filter(b => b.contents === 'read').map(b => b.ios);
  const listOnly = VERIFIED.backups.filter(b => b.contents !== 'read').map(b => b.ios);
  const extra = listOnly.length ? `, and the file list of an ${iosList(listOnly)} backup` : '';
  return `      <p class="matrix-note">Checked against public test backups from ${iosList(read)}${extra}, reading only file, table and column names. <a href="/backup-files#method">How we checked</a> · <a href="/backup-files">All backup files</a></p>`;
}

/** The nav and footer every page shares, taken from the hub so the file pages match it. */
export function sharedParts(hubHtml) {
  const lf = hubHtml.replace(/\r\n/g, '\n');
  const nav = lf.match(/ {2}<nav class="nav"[\s\S]*?<\/nav>/);
  const footer = lf.match(/ {2}<footer class="footer">[\s\S]*?<\/footer>/);
  if (!nav || !footer) throw new Error('website/static/backup-files.html has no <nav class="nav"> or <footer class="footer">');
  return { nav: nav[0], footer: footer[0] };
}

/** A file's page, with LF line endings. */
export function renderPage(file, shared) {
  const v = verifiedFor(file);
  const body = [
    shared.nav,
    '',
    '  <header class="page-head ref-head">',
    `    <div class="page-head__eyebrow"><a href="/backup-files">Backup files</a> · ${esc(file.app)}</div>`,
    `    <h1><span class="ref-hash">${file.fileID}</span>is <span class="it">${esc(file.name)}</span></h1>`,
    `    <p class="page-head__lede">In an iPhone backup, the file <code>${file.fileID}</code> is <code>${esc(file.name)}</code>. ${inline(file.summary)}</p>`,
    '  </header>',
    '',
    '  <section class="prose">',
    '    <div class="prose__inner">',
    factsTable(file, v),
    '',
    '      <h2 id="what">What it holds</h2>',
    ...file.about.map(p => `      <p>${inline(p)}</p>`),
    ...(file.companions ?? []).map(c => {
      const seen = Object.entries(v.companions?.[c.relativePath] ?? {}).filter(([, present]) => present).map(([ver]) => ver);
      const id = fileId(c.domain ?? file.domain, c.relativePath);
      const where = seen.length ? ` We saw it next to ${esc(file.name)} in ${iosList(seen)}.` : '';
      return `      <p><code>${esc(c.relativePath)}</code> (<code>${id}</code>): ${inline(c.note)}${where}</p>`;
    }),
    '',
    keyColumns(file, v) || plistKeys(file, v),
    '',
    tablesByVersion(file, v),
    '',
    howToOpen(file),
    '',
    related(file),
    '',
    checkedNote(v),
    '    </div>',
    '  </section>',
    '',
    '  <section class="cta-strip">',
    '    <div class="cta-strip__inner">',
    '      <div>',
    '        <div class="cta-strip__label">Read the backup, not the hashes.</div>',
    '        <div class="cta-strip__sub">OpenExtract opens iPhone backups for you. Free, open source, nothing uploaded. Mac · Windows · Linux.</div>',
    '      </div>',
    '      <a class="cta-strip__btn" href="/#download">Download OpenExtract →</a>',
    '    </div>',
    '  </section>',
    '',
    shared.footer,
  ].filter((line, i, all) => !(line === '' && all[i - 1] === ''));
  return `${head(file)}\n<body>\n${body.join('\n')}\n</body>\n</html>\n`;
}

// ── The hub ─────────────────────────────────────────────────────────────

/** The lookup table, for between <!-- backup-files:start --> and <!-- backup-files:end -->. */
export function renderHubTable(files = FILES) {
  const rows = files.map(f => [
    '            <tr>',
    `              <td class="matrix__k"><a href="/backup-files/${f.slug}"><code>${f.fileID}</code></a></td>`,
    `              <td class="matrix__cell"><code>${esc(f.name)}</code><span class="matrix__sub">${esc(f.domain)}</span></td>`,
    `              <td class="matrix__cell">${inline(f.summary)}</td>`,
    '            </tr>',
  ].join('\n'));
  return [
    '      <div class="matrix ref-scroll ref-lookup">',
    '        <table>',
    '          <thead>',
    '            <tr><th class="matrix__head--label">Hash</th><th class="matrix__head--plain">File</th><th class="matrix__head--plain">What it is</th></tr>',
    '          </thead>',
    '          <tbody>',
    ...rows,
    '          </tbody>',
    '        </table>',
    '      </div>',
  ].join('\n');
}

/** schema.org ItemList of the file pages, for between <!-- backup-files-data:start --> and <!-- backup-files-data:end -->. */
export function renderHubData(files = FILES) {
  return jsonLd({
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'iPhone backup files',
    itemListElement: files.map((f, i) => ({
      '@type': 'ListItem', position: i + 1, name: `${f.fileID} is ${f.name}`, url: pageUrl(f),
    })),
  });
}

function replaceBetween(html, name, content) {
  const re = new RegExp(`(<!-- ${name}:start -->)[\\s\\S]*?(\\n[ \\t]*<!-- ${name}:end -->)`);
  if (!re.test(html)) throw new Error(`website/static/backup-files.html has no <!-- ${name}:start --> … <!-- ${name}:end --> markers`);
  return html.replace(re, (_, start, end) => `${start}\n${content}${end}`);
}

/** The hub with its generated parts brought up to date, in the hub's own line endings. */
export function buildHub(html, files = FILES) {
  const eol = html.includes('\r\n') ? '\r\n' : '\n';
  const lf = html.replace(/\r\n/g, '\n');
  return replaceBetween(replaceBetween(lf, 'backup-files-data', renderHubData(files)), 'backup-files', renderHubTable(files))
    .replace(/\n/g, eol);
}

/** Every page this script writes: [path, content]. File pages have LF line endings. */
export function buildAll(hubHtml = fs.readFileSync(HUB, 'utf8')) {
  const shared = sharedParts(hubHtml);
  return [[HUB, buildHub(hubHtml)], ...FILES.map(f => [pagePath(f), renderPage(f, shared)])];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(PAGES_DIR, { recursive: true });
  let changed = 0;
  for (const [file, content] of buildAll()) {
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n') : null;
    if (before === content.replace(/\r\n/g, '\n')) continue;
    fs.writeFileSync(file, content);
    changed++;
    console.log(`Wrote ${path.relative(root, file)}`);
  }
  const expected = new Set(FILES.map(f => `${f.slug}.html`));
  for (const name of fs.readdirSync(PAGES_DIR)) {
    if (!expected.has(name)) console.warn(`website/static/backup-files/${name} isn't in files.json: delete it, and its sitemap entry, if it's gone for good.`);
  }
  console.log(changed ? `${changed} page(s) updated.` : 'Every page is up to date.');
}
