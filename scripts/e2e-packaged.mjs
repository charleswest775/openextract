// End-to-end check of a packaged OpenExtract build, run by .github/workflows/prerelease-check.yml.
//
//   npm install --no-save playwright-core@1.59.1
//   node scripts/e2e-packaged.mjs <app-executable> <out-dir> <maren-plain> <maren-encrypted> <hickman-15.3.1>
//
// Run it from the repository root. The three backup arguments are backup folders (the ones
// holding Manifest.db): the synthetic maren backups that ios-backup-core's backupgen makes
// (corpus/synthetic.json) and the public pub-hickman-15.3.1 corpus item.
//
// Drives the packaged app with Playwright: opens each backup, checks the Overview tile
// against the Photos header, pages the Photos grid to the end, and exports PDFs (single,
// again without overwriting, bulk separate, bulk merged). Also types in a search box with
// Chromium's net log on, and fails if the app contacted any other computer. Writes
// <out-dir>/results.json and exits 1 if any check failed.
//
// Hickman's terms forbid screenshots and redistribution: only counts are recorded for it,
// and its PDFs go to a temp folder that is deleted. Maren is fictional, so its screenshots
// and PDFs go to <out-dir>, which the workflow uploads.
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const args = process.argv.slice(2);
if (args.length !== 5) {
  console.error('usage: node scripts/e2e-packaged.mjs <app-executable> <out-dir> <maren-plain> <maren-encrypted> <hickman-15.3.1>');
  process.exit(2);
}
const require = createRequire(path.join(process.cwd(), 'package.json'));
const { _electron: electron } = require('playwright-core');
const [exe, outDir, marenPlain, marenEnc, hickman] = args;
fs.mkdirSync(outDir, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = { platform: `${process.platform}-${process.arch}`, checks: [], notes: [] };
const check = (name, ok, detail) => { results.checks.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail !== undefined ? ' — ' + JSON.stringify(detail) : ''}`); };
const num = s => (s == null ? null : Number(String(s).replace(/,/g, '')));

// Photos are the embedded images with a side over 200 px. Chromium also embeds color emoji
// as small bitmaps (each with an alpha mask) on Linux and macOS but draws them as vectors on
// Windows, so the raw image count differs by OS while the photo count doesn't.
function pdfStats(file) {
  const d = fs.readFileSync(file);
  const s = d.toString('latin1');
  let photos = 0;
  for (const [, dict] of s.matchAll(/\d+\s+0\s+obj\s*<<([\s\S]*?)>>\s*stream/g)) {
    if (!/\/Subtype\s*\/Image/.test(dict)) continue;
    const side = Math.max(Number(dict.match(/\/Width\s+(\d+)/)?.[1] ?? 0), Number(dict.match(/\/Height\s+(\d+)/)?.[1] ?? 0));
    if (side > 200) photos++;
  }
  return {
    kb: Math.round(d.length / 1024),
    header: d.subarray(0, 5).toString() === '%PDF-',
    pages: (s.match(/\/Type\s*\/Page[^s]/g) || []).length,
    photos,
  };
}
const leftoverTemp = () => fs.readdirSync(os.tmpdir()).filter(n => n.startsWith('openextract-pdf-'));

async function withApp(label, fn, extraArgs = []) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-e2e-profile-'));
  const args = [`--user-data-dir=${profile}`, ...extraArgs];
  if (process.platform === 'linux') args.push('--no-sandbox');
  const app = await electron.launch({ executablePath: exe, args, timeout: 120_000 });
  const page = await app.firstWindow();
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)); });
  page.on('dialog', d => d.accept().catch(() => {}));
  await page.waitForLoadState('domcontentloaded');
  await sleep(3000);
  const ctx = {
    app, page, errors,
    stubFolder: f => app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] }); }, f),
    click: t => page.evaluate(t => {
      const els = [...document.querySelectorAll('button, a, [role="button"], [role="tab"]')];
      const el = els.find(e => e.textContent?.trim() === t) ?? els.find(e => e.textContent?.trim().startsWith(t));
      if (!el) return false; el.click(); return true;
    }, t),
    text: () => page.evaluate(() => document.body.innerText),
    // A screen from the backup's home page, by its tile ("Messages", "Photos"): home first, then the tile.
    open: async name => {
      await page.evaluate(() => document.querySelector('.titlebar button[title=Home]')?.click());
      await sleep(500);
      return page.evaluate(n => {
        const tile = [...document.querySelectorAll('button[aria-label]')].find(b => b.getAttribute('aria-label').split(',')[0] === n);
        if (!tile) return null;
        const label = tile.getAttribute('aria-label');
        tile.click();
        return label;
      }, name);
    },
    shot: async name => { if (label.startsWith('maren')) await page.screenshot({ path: path.join(outDir, `${name}.png`) }); },
    // Saves report in in-app notices (role=status for success, role=alert for errors).
    notices: () => page.evaluate(() => [...document.querySelectorAll('[aria-live] > [role=status], [aria-live] > [role=alert]')]
      .map(n => ({ kind: n.getAttribute('role'), text: n.innerText.trim() }))),
    clearNotices: () => page.evaluate(() => document.querySelectorAll('[aria-live] button[aria-label=Dismiss]').forEach(b => b.click())),
    // The shared Save dialog: pick a format (and, for several conversations, one file or many), then Save.
    saveAs: (format, mode) => page.evaluate(async ([format, mode]) => {
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      for (let i = 0; i < 20 && !document.querySelector('[role=dialog]'); i++) await sleep(100);
      document.querySelector(`[role=dialog] input[name=save-format][value=${format}]`)?.click();
      if (mode) [...document.querySelectorAll('[role=dialog] input[name=save-mode]')][mode === 'merged' ? 1 : 0]?.click();
      await sleep(100);
      [...document.querySelectorAll('[role=dialog] button')].find(b => b.textContent.trim() === 'Save').click();
    }, [format, mode]),
  };
  try { await fn(ctx); }
  catch (e) { check(`${label}: no exception`, false, String(e.stack || e).slice(0, 800)); }
  finally {
    const serious = errors.filter(e => !/Autofill|DevTools|favicon/i.test(e));
    check(`${label}: no renderer errors`, serious.length === 0, serious.slice(0, 5));
    await app.close().catch(() => {});
  }
}

async function openBackup(c, label, dir, password) {
  await c.stubFolder(dir);
  for (let i = 0; i < 60 && !(await c.click('Open a backup folder')); i++) await sleep(500);
  let state;
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    state = await c.page.evaluate(() => ({
      password: !!document.querySelector('input[type=password]'),
      opened: !!document.querySelector('.titlebar input[type=search]'),
      error: [...document.querySelectorAll('[role=alert], .text-red-600, .text-apple-error')].map(e => e.textContent.trim()).filter(Boolean)[0],
    }));
    if (state.opened) break;
    if (state.password && password) { await c.page.fill('input[type=password]', password); await c.click('Unlock'); password = null; }
    if (state.error) break;
  }
  check(`${label}: backup opens`, state.opened, state.error);
  return state.opened;
}

async function photos(c, label, expectInBackup, expectIcloud) {
  // The home page's Photos tile says how many there are ("Photos, 170")
  await c.page.evaluate(() => document.querySelector('.titlebar button[title=Home]')?.click()); await sleep(2500);
  const tile = num((await c.page.evaluate(() =>
    document.querySelector('button[aria-label^="Photos,"]')?.getAttribute('aria-label')))?.match(/([\d,]+)$/)?.[1]);
  await c.shot(`${label}-home`);
  await c.open('Photos'); await sleep(3000);
  const t = await c.text();
  const header = num(t.match(/([\d,]+) photos? (?:and videos|or video) in this backup/i)?.[1]);
  const icloud = num(t.match(/([\d,]+) more are only in iCloud/)?.[1]) ?? 0;
  const grid = await c.page.evaluate(async () => {
    const g = [...document.querySelectorAll('div.grid')].find(g => g.querySelector('.aspect-square'));
    if (!g) return { tiles: 0 };
    const sc = g.parentElement; let last = -1, same = 0;
    for (let i = 0; i < 120 && same < 6; i++) {
      sc.scrollTop = sc.scrollHeight; await new Promise(r => setTimeout(r, 800));
      const n = g.children.length; if (n === last) same++; else { same = 0; last = n; }
    }
    await new Promise(r => setTimeout(r, 5000));
    const tiles = [...g.children];
    const kind = t => t.querySelector('img') ? 'img' : t.querySelector('.animate-spin') ? 'spinner' : t.querySelector('.bg-gray-800') ? 'video' : 'failed';
    const counts = {}; tiles.forEach(t => (counts[kind(t)] = (counts[kind(t)] || 0) + 1));
    const ids = tiles.map(t => (t.querySelector('img')?.alt || t.innerText) + '|' + (t.querySelector('img')?.src.length || 0));
    return { tiles: tiles.length, unique: new Set(ids).size, counts, error: (document.body.innerText.match(/Couldn't load more photos[^\n]*/) || [null])[0] };
  });
  await c.shot(`${label}-photos-end`);
  check(`${label}: home Photos tile = ${expectInBackup}`, tile === expectInBackup, tile);
  check(`${label}: Photos header = ${expectInBackup}`, header === expectInBackup, header);
  check(`${label}: iCloud-only note = ${expectIcloud}`, icloud === expectIcloud, icloud);
  check(`${label}: grid pages to all ${expectInBackup}, no duplicates, no error`, grid.tiles === expectInBackup && grid.unique === grid.tiles && !grid.error, grid);
  check(`${label}: no failed thumbnails`, !grid.counts?.failed, grid.counts);
}

async function waitNotice(c, ms = 300_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const n = await c.notices(); if (n.length) return { secs: (Date.now() - t0) / 1000, notice: n[0] }; await sleep(500); }
  return { secs: ms / 1000, notice: null };
}

async function exportSingle(c, label, convo, dir, expectPhotos) {
  await c.open('Messages'); await sleep(2000);
  check(`${label}: open "${convo}"`, await c.click(convo));
  await sleep(2500); await c.shot(`${label}-thread`);
  fs.mkdirSync(dir, { recursive: true }); await c.stubFolder(dir); await c.clearNotices();
  const files = [];
  const errors = [];
  for (const round of [1, 2]) {
    const t0 = Date.now();
    await c.click('Save conversation');
    await c.saveAs('pdf');
    let pdfs = [];
    while (Date.now() - t0 < 300_000) {
      await sleep(500);
      pdfs = fs.readdirSync(dir).filter(f => f.endsWith('.pdf'));
      const busy = await c.page.evaluate(() => document.body.innerText.includes('Saving…'));
      const failed = (await c.notices()).filter(n => n.kind === 'alert');
      if (failed.length) { errors.push(...failed); break; }
      if (pdfs.length >= round && !busy) break;
    }
    files.push({ round, secs: (Date.now() - t0) / 1000, pdfs });
  }
  const pdfs = fs.readdirSync(dir).filter(f => f.endsWith('.pdf')).sort();
  const stats = pdfs.map(f => ({ f, ...pdfStats(path.join(dir, f)) }));
  check(`${label}: single PDF export, no error notice`, errors.length === 0, errors);
  check(`${label}: second export kept the first ("(2)" file)`, pdfs.length === 2 && pdfs.some(f => f.includes(' (2).pdf')), { files, stats });
  check(`${label}: PDF valid with ${expectPhotos} photos`, stats.length > 0 && stats[0].header && stats[0].pages > 0 && stats[0].photos === expectPhotos, stats[0]);
  return stats;
}

async function exportBulk(c, label, convos, mode, dir, expectPhotos) {
  fs.mkdirSync(dir, { recursive: true });
  await c.open('Messages'); await sleep(1500);
  if (!(await c.page.evaluate(() => [...document.querySelectorAll('button')].some(b => b.textContent.trim() === 'Done')))) await c.click('Select');
  await sleep(300);
  if (convos === 'all') await c.click('Select all');
  else for (const n of convos) await c.click(n);
  await sleep(300);
  const selected = await c.page.evaluate(() => document.body.innerText.match(/Save (\d+) conversations?/)?.[1]);
  await c.stubFolder(dir); await c.clearNotices();
  await c.page.evaluate(() => [...document.querySelectorAll('button')].find(b => /^Save \d+ conversation/.test(b.textContent.trim())).click());
  await c.saveAs('pdf', mode);
  const { secs, notice } = await waitNotice(c);
  const pdfs = fs.readdirSync(dir).filter(f => f.endsWith('.pdf'));
  const stats = pdfs.map(f => ({ f: f.slice(0, 40), ...pdfStats(path.join(dir, f)) }));
  const want = mode === 'merged' ? 1 : Number(selected);
  const photoCount = stats.reduce((a, s) => a + s.photos, 0);
  check(`${label}: bulk ${mode} PDF export of ${selected}${expectPhotos === undefined ? '' : ` with ${expectPhotos} photos`}`,
    notice?.kind === 'status' && notice.text.startsWith('Saved') && pdfs.length === want && stats.every(s => s.header && s.pages > 0) && (expectPhotos === undefined || photoCount === expectPhotos),
    { secs, notice: notice?.text.split('\n')[0], files: pdfs.length, totalKB: stats.reduce((a, s) => a + s.kb, 0), photos: photoCount, pages: stats.reduce((a, s) => a + s.pages, 0) });
  await c.click('Done'); await sleep(300);
  return stats;
}

const before = leftoverTemp();

// Karin Lindqvist's thread holds 7 photos; with Theo Navarro and Switchbacks it's 28.
const marenThreads = ['Karin Lindqvist', 'Theo Navarro', 'Switchbacks'];

await withApp('maren-plain', async c => {
  if (!(await openBackup(c, 'maren-plain', marenPlain))) return;
  await photos(c, 'maren-plain', 170, 0);
  await exportSingle(c, 'maren-plain', 'Karin Lindqvist', path.join(outDir, 'pdf-single'), 7);
  await exportBulk(c, 'maren-plain', marenThreads, 'separate', path.join(outDir, 'pdf-bulk-separate'), 28);
  await exportBulk(c, 'maren-plain', marenThreads, 'merged', path.join(outDir, 'pdf-bulk-merged'), 28);
});

await withApp('maren-encrypted', async c => {
  if (!(await openBackup(c, 'maren-encrypted', marenEnc, 'test'))) return;
  await photos(c, 'maren-encrypted', 170, 0);
  await exportSingle(c, 'maren-encrypted', 'Karin Lindqvist', path.join(outDir, 'pdf-encrypted'), 7);
});

// The app promises no network requests beyond the opt-in update check, and a fresh profile
// hasn't opted in. Chromium's spell checker fetches its dictionaries from the browser process
// on Windows and Linux, which page.on('request') never sees, so read Chromium's own net log.
const netLogDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-e2e-netlog-'));
const netLog = path.join(netLogDir, 'net.json');
await withApp('maren-network', async c => {
  if (!(await openBackup(c, 'maren-network', marenPlain))) return;
  await c.open('Messages'); await sleep(1500);
  const box = c.page.locator('.titlebar input[type=search]');
  check('maren-network: search box to type in', (await box.count()) > 0);
  await box.first().click();
  await c.page.keyboard.type('hello wrold, is this spelled rihgt', { delay: 50 });
  await sleep(20_000);
}, [`--log-net-log=${netLog}`]);
// The log is complete only once the app has closed, which withApp has done by now.
const netLogText = fs.existsSync(netLog) ? fs.readFileSync(netLog, 'utf8') : '';
const contacted = [...new Set([...netLogText.matchAll(/"(?:url|original_url)":"(?:https?|wss?):\/\/([^"/:]+)/g)].map(m => m[1]))]
  .filter(h => !['localhost', '127.0.0.1', '[::1]'].includes(h));
check('maren-network: net log was written', netLogText.length > 0, { kb: Math.round(netLogText.length / 1024) });
check('maren-network: no other computer contacted', contacted.length === 0, contacted);
fs.rmSync(netLogDir, { recursive: true, force: true });

const hickmanOut = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-e2e-hickman-'));
await withApp('hickman-15.3.1', async c => {
  if (!(await openBackup(c, 'hickman-15.3.1', hickman, 'MyBackup123'))) return;
  await photos(c, 'hickman-15.3.1', 146, 85);
  await exportBulk(c, 'hickman-15.3.1', 'all', 'separate', path.join(hickmanOut, 'sep'));
  await exportBulk(c, 'hickman-15.3.1', 'all', 'merged', path.join(hickmanOut, 'merged'));
});
fs.rmSync(hickmanOut, { recursive: true, force: true });

// Bulk-separate copies of Karin are duplicates of pdf-single; don't upload them twice.
fs.rmSync(path.join(outDir, 'pdf-bulk-separate'), { recursive: true, force: true });
const leftovers = leftoverTemp().filter(n => !before.includes(n));
check('no openextract-pdf-* temp folders left behind', leftovers.length === 0, leftovers);

const failed = results.checks.filter(c => !c.ok);
results.summary = `${results.checks.length - failed.length}/${results.checks.length} passed`;
fs.writeFileSync(path.join(outDir, 'results.json'), JSON.stringify(results, null, 2));
console.log(results.summary);
process.exit(failed.length ? 1 : 0);
