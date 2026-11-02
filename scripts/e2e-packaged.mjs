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
// again without overwriting, bulk separate, bulk merged). Writes <out-dir>/results.json and
// exits 1 if any check failed.
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

async function withApp(label, fn) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'oe-e2e-profile-'));
  const args = [`--user-data-dir=${profile}`];
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
    shot: async name => { if (label.startsWith('maren')) await page.screenshot({ path: path.join(outDir, `${name}.png`) }); },
    captureAlerts: () => page.evaluate(() => { window.__alerts = []; window.alert = m => window.__alerts.push(String(m)); }),
    alerts: () => page.evaluate(() => window.__alerts || []),
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
  for (let i = 0; i < 60 && !(await c.click('Explore my data')); i++) await sleep(500);
  let state;
  for (let i = 0; i < 240; i++) {
    await sleep(500);
    state = await c.page.evaluate(() => ({
      password: !!document.querySelector('input[type=password]'),
      overview: document.body.innerText.includes('OVERVIEW'),
      error: [...document.querySelectorAll('[role=alert], .text-red-600, .text-apple-error')].map(e => e.textContent.trim()).filter(Boolean)[0],
    }));
    if (state.overview) break;
    if (state.password && password) { await c.page.fill('input[type=password]', password); await c.click('Unlock'); password = null; }
    if (state.error) break;
  }
  check(`${label}: backup opens`, state.overview, state.error);
  return state.overview;
}

async function photos(c, label, expectInBackup, expectIcloud) {
  await c.click('Overview'); await sleep(2500);
  const ov = await c.text();
  const tile = num(ov.match(/([\d,]+)\nPhotos & Videos/)?.[1]);
  await c.shot(`${label}-overview`);
  await c.click('Photos'); await sleep(3000);
  const t = await c.text();
  const header = num(t.match(/PHOTOS · ([\d,]+) IN THIS BACKUP/i)?.[1]);
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
  check(`${label}: Overview tile = ${expectInBackup}`, tile === expectInBackup, tile);
  check(`${label}: Photos header = ${expectInBackup}`, header === expectInBackup, header);
  check(`${label}: iCloud-only note = ${expectIcloud}`, icloud === expectIcloud, icloud);
  check(`${label}: grid pages to all ${expectInBackup}, no duplicates, no error`, grid.tiles === expectInBackup && grid.unique === grid.tiles && !grid.error, grid);
  check(`${label}: no failed thumbnails`, !grid.counts?.failed, grid.counts);
}

async function waitAlert(c, ms = 300_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { const a = await c.alerts(); if (a.length) return { secs: (Date.now() - t0) / 1000, alert: a[0] }; await sleep(500); }
  return { secs: ms / 1000, alert: null };
}

async function exportSingle(c, label, convo, dir, expectPhotos) {
  await c.click('Messages'); await sleep(2000);
  check(`${label}: open "${convo}"`, await c.click(convo));
  await sleep(2500); await c.shot(`${label}-thread`);
  fs.mkdirSync(dir, { recursive: true }); await c.stubFolder(dir); await c.captureAlerts();
  const files = [];
  for (const round of [1, 2]) {
    const t0 = Date.now();
    await c.page.evaluate(() => [...document.querySelectorAll('button')].find(b => b.textContent.trim() === 'PDF (with images)').click());
    let pdfs = [];
    while (Date.now() - t0 < 300_000) {
      await sleep(500);
      pdfs = fs.readdirSync(dir).filter(f => f.endsWith('.pdf'));
      const busy = await c.page.evaluate(() => document.body.innerText.includes('Exporting...'));
      if ((pdfs.length >= round && !busy) || (await c.alerts()).length) break;
    }
    files.push({ round, secs: (Date.now() - t0) / 1000, pdfs });
  }
  const alerts = await c.alerts();
  const pdfs = fs.readdirSync(dir).filter(f => f.endsWith('.pdf')).sort();
  const stats = pdfs.map(f => ({ f, ...pdfStats(path.join(dir, f)) }));
  check(`${label}: single PDF export, no error alert`, alerts.length === 0, alerts);
  check(`${label}: second export kept the first ("(2)" file)`, pdfs.length === 2 && pdfs.some(f => f.includes(' (2).pdf')), { files, stats });
  check(`${label}: PDF valid with ${expectPhotos} photos`, stats.length > 0 && stats[0].header && stats[0].pages > 0 && stats[0].photos === expectPhotos, stats[0]);
  return stats;
}

async function exportBulk(c, label, convos, mode, dir, expectPhotos) {
  fs.mkdirSync(dir, { recursive: true });
  await c.click('Messages'); await sleep(1500);
  if (!(await c.page.evaluate(() => document.body.innerText.includes('Cancel select')))) await c.click('Select');
  await sleep(300);
  if (convos === 'all') await c.click('Select all');
  else for (const n of convos) await c.click(n);
  await sleep(300);
  const selected = await c.page.evaluate(() => document.body.innerText.match(/Export (\d+)/)?.[1]);
  await c.stubFolder(dir); await c.captureAlerts();
  await c.page.evaluate(async mode => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    [...document.querySelectorAll('button')].find(b => /^Export \d+/.test(b.textContent.trim())).click(); await sleep(400);
    [...document.querySelectorAll('input[type=radio]')][mode === 'merged' ? 1 : 0].click(); await sleep(100);
    const sel = [...document.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'pdf'));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(sel, 'pdf');
    sel.dispatchEvent(new Event('change', { bubbles: true })); await sleep(200);
    [...document.querySelectorAll('button')].filter(b => b.textContent.trim() === 'Export').at(-1).click();
  }, mode);
  const { secs, alert } = await waitAlert(c);
  const pdfs = fs.readdirSync(dir).filter(f => f.endsWith('.pdf'));
  const stats = pdfs.map(f => ({ f: f.slice(0, 40), ...pdfStats(path.join(dir, f)) }));
  const want = mode === 'merged' ? 1 : Number(selected);
  const photoCount = stats.reduce((a, s) => a + s.photos, 0);
  check(`${label}: bulk ${mode} PDF export of ${selected}${expectPhotos === undefined ? '' : ` with ${expectPhotos} photos`}`,
    alert?.startsWith('Exported') && pdfs.length === want && stats.every(s => s.header && s.pages > 0) && (expectPhotos === undefined || photoCount === expectPhotos),
    { secs, alert: alert?.split('\n')[0], files: pdfs.length, totalKB: stats.reduce((a, s) => a + s.kb, 0), photos: photoCount, pages: stats.reduce((a, s) => a + s.pages, 0) });
  await c.click('Cancel select'); await sleep(300);
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
