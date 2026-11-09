// Tells IndexNow (Bing, Yandex, Seznam and the rest) which pages of openextract.app
// changed, so they recrawl them without waiting. .github/workflows/indexnow.yml runs it
// after each production deploy on Vercel.
//
//   node scripts/indexnow.mjs <from> <to>   pages changed between two commits
//   node scripts/indexnow.mjs --all         every page in the sitemap
//   add --dry-run to print the URLs without sending them
//
// The key is the name of website/static/<key>.txt, a file whose only content is the key.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const SITE = 'https://www.openextract.app';
const STATIC = 'website/static/';
const KEY_FILE = /^([0-9a-f]{32})\.txt$/;

/** The page a file under website/static/ is served as, or null for anything but a page. */
export function pageUrl(file) {
  if (!file.startsWith(STATIC) || !file.endsWith('.html')) return null;
  const page = file.slice(STATIC.length, -'.html'.length);
  return page === 'index' ? `${SITE}/` : `${SITE}/${page}`;
}

/** Every <loc> in the sitemap. */
export function sitemapUrls(xml) {
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map(m => m[1]);
}

/**
 * The URLs to submit for `git diff --name-status` output. A changed page counts only if
 * the sitemap lists it (so not 404.html or the noindex download pages); a deleted page
 * counts too, so engines learn it's gone.
 */
export function changedUrls(nameStatus, sitemap) {
  const listed = new Set(sitemapUrls(sitemap));
  const urls = new Set();
  for (const line of nameStatus.split('\n')) {
    const [status, ...files] = line.trim().split('\t');
    if (!status) continue;
    // A rename is the old page gone and the new one changed.
    const gone = status[0] === 'D' ? files : status[0] === 'R' ? files.slice(0, 1) : [];
    const changed = status[0] === 'D' ? [] : files.slice(-1);
    for (const f of gone) {
      const url = pageUrl(f);
      if (url) urls.add(url);
    }
    for (const f of changed) {
      const url = pageUrl(f);
      if (url && listed.has(url)) urls.add(url);
    }
  }
  return [...urls].sort();
}

/** The IndexNow key, from the name of its file in website/static/. */
export function findKey(dir) {
  const keys = fs.readdirSync(dir).map(f => f.match(KEY_FILE)?.[1]).filter(Boolean);
  if (keys.length !== 1) throw new Error(`expected one IndexNow key file in ${dir}, found ${keys.length}`);
  return keys[0];
}

async function submit(urls, key) {
  const res = await fetch('https://api.indexnow.org/indexnow', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      host: new URL(SITE).host,
      key,
      keyLocation: `${SITE}/${key}.txt`,
      urlList: urls,
    }),
  });
  // 200: accepted. 202: accepted, key not checked yet. Anything else is a problem worth a red run.
  if (res.status !== 200 && res.status !== 202) {
    throw new Error(`IndexNow answered ${res.status}: ${await res.text()}`);
  }
  return res.status;
}

async function main(args) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const staticDir = path.join(root, STATIC);
  const dryRun = args.includes('--dry-run');
  const rest = args.filter(a => a !== '--dry-run');
  const sitemap = fs.readFileSync(path.join(staticDir, 'sitemap.xml'), 'utf-8');

  let urls;
  if (rest[0] === '--all') {
    urls = sitemapUrls(sitemap);
  } else if (rest.length === 2) {
    const diff = execFileSync('git', ['diff', '--name-status', rest[0], rest[1], '--', STATIC], { cwd: root, encoding: 'utf-8' });
    urls = changedUrls(diff, sitemap);
  } else {
    console.error('usage: node scripts/indexnow.mjs <from> <to> | --all  [--dry-run]');
    process.exit(2);
  }

  if (urls.length === 0) {
    console.log('No pages changed; nothing to submit.');
    return;
  }
  console.log(`${urls.length} page(s):\n${urls.join('\n')}`);
  if (dryRun) return;
  const status = await submit(urls, findKey(staticDir));
  console.log(`IndexNow answered ${status}.`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(err => {
    console.error(err.message);
    process.exit(1);
  });
}
