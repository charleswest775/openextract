// Records a short, silent how-to video of the real app from a step list, for a guide on
// the website: the dev app driven by Playwright (the run-openextract skill's driver), a
// screencast of its window, step captions burned in below it, title cards, the PDF the run
// saved, and a WebVTT captions file. See scripts/guide-videos/README.md.
//
//   node scripts/record-guide-video.mjs scripts/guide-videos/<slug>.mjs --backup <UDID folder>
//
// Options:
//   --backup <folder>   a synthetic backup (backupgen), shown on the start screen as found on
//                       this computer: it's cloned into a throwaway HOME, so no real backup
//                       can appear. Never pass a real one.
//   --renderer <url>    a Vite renderer that's already running (default: start one)
//   --out <dir>         where <slug>.mp4, .jpg and .vtt go (default website/static/videos/media)
//   --work <dir>        frames and stills (default: a new folder in the system temp folder)
//   --crf <n>           x264 quality, lower is better and bigger (default 23)
//   --no-build          don't rebuild dist-electron first
//
// Needs: the skill's setup (playwright-core, .venv), ffmpeg and pdftoppm (poppler) on PATH.
// macOS only so far: the start screen's found list reads ~/Library/Application Support/MobileSync.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  CROSSFADE, chaptersOf, ffconcat, isoDuration, segmentStarts, segmentsOf, sliceEntries,
  timeline, validateVideo, webvtt,
} from './guide-video-lib.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = { w: 1920, h: 1080, fps: 30 };
// The app window (CSS pixels, drawn at 2x) and where it sits in the frame; the caption band is below it.
const VIEW = { w: 1440, h: 900 };
const APP = { x: 192, y: 24, w: 1536, h: 960 };
const BAND = { y: APP.y + APP.h, h: OUT.h - APP.y - APP.h };
const COLORS = { ink: '#1e1a16', ink2: '#655a4f', cream: '#fbf6f1', coral: '#d97757', accent: '#b4532f', backdrop: '#26211d' };
const LEAD_MS = 1000; // each step's caption is up this long before anything moves
const sleep = ms => new Promise(r => setTimeout(r, ms));
const now = () => Date.now() / 1000;
const isMain = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

function parseArgs(argv) {
  const args = { build: true, crf: 23 };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-build') args.build = false;
    else if (a.startsWith('--')) args[a.slice(2)] = argv[++i];
    else rest.push(a);
  }
  args.steps = rest[0];
  args.crf = Number(args.crf);
  return args;
}

function run(cmd, argv, opts = {}) {
  const r = spawnSync(cmd, argv, { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8', ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${argv.join(' ')} failed:\n${r.stderr || r.stdout || r.error}`);
  return r.stdout;
}

const ffmpeg = argv => run(process.env.FFMPEG || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...argv]);

function probeSeconds(file) {
  const out = run(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  return Number(out.trim());
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); });
    srv.on('error', reject);
  });
}

async function waitForHttp(url, ms = 60_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`${url} didn't answer`);
}

/** Clone the synthetic backup into a throwaway HOME, so the start screen finds it and nothing else. */
function makeHome(work, backup) {
  const home = path.join(work, 'home');
  const into = path.join(home, 'Library/Application Support/MobileSync/Backup');
  fs.mkdirSync(into, { recursive: true });
  const target = path.join(into, path.basename(backup));
  if (!fs.existsSync(target)) {
    // APFS clone when it can (instant, no extra space); a plain copy otherwise.
    const r = process.platform === 'darwin' ? spawnSync('cp', ['-cR', backup, into]) : { status: 1 };
    if (r.status !== 0) fs.cpSync(backup, target, { recursive: true });
  }
  return home;
}

// ── In the app window: a visible cursor, a ring round what's about to be clicked, a ripple on click ──

const OVERLAY = `(() => {
  if (document.getElementById('gv-cursor')) return;
  const style = document.createElement('style');
  style.textContent = \`
    #gv-cursor { position: fixed; left: 0; top: 0; z-index: 2147483647; pointer-events: none; transform: translate(-80px, -80px); }
    #gv-ring { position: fixed; z-index: 2147483646; pointer-events: none; border: 3px solid ${COLORS.coral}; border-radius: 14px;
      box-shadow: 0 0 0 6px rgba(217,119,87,.22); opacity: 0; transition: opacity .25s ease; }
    .gv-ripple { position: fixed; z-index: 2147483646; pointer-events: none; width: 46px; height: 46px; margin: -23px 0 0 -23px;
      border-radius: 50%; background: rgba(217,119,87,.30); border: 2px solid rgba(180,83,47,.85); animation: gv-ripple .55s ease-out forwards; }
    @keyframes gv-ripple { from { transform: scale(.3); opacity: 1 } to { transform: scale(1.5); opacity: 0 } }\`;
  document.head.appendChild(style);
  const cursor = document.createElement('div');
  cursor.id = 'gv-cursor';
  cursor.innerHTML = '<svg width="26" height="38" viewBox="0 0 26 38"><path d="M3 2.5 L3 29 L9.6 22.8 L14.2 33.8 L18.9 31.8 L14.4 21.2 L23.4 21.2 Z" fill="#141210" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/></svg>';
  document.body.appendChild(cursor);
  const ring = document.createElement('div');
  ring.id = 'gv-ring';
  document.body.appendChild(ring);
  addEventListener('mousemove', e => { cursor.style.transform = 'translate(' + (e.clientX - 3) + 'px,' + (e.clientY - 2) + 'px)'; }, true);
  addEventListener('mousedown', e => {
    // The ring goes at once: a dialog the click opens must not appear under it.
    ring.style.transition = 'none';
    ring.style.opacity = 0;
    requestAnimationFrame(() => { ring.style.transition = ''; });
    const r = document.createElement('div');
    r.className = 'gv-ripple';
    r.style.left = e.clientX + 'px';
    r.style.top = e.clientY + 'px';
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 700);
  }, true);
  window.__gvRing = rect => {
    if (!rect) { ring.style.opacity = 0; return; }
    Object.assign(ring.style, { left: rect.x - 6 + 'px', top: rect.y - 6 + 'px', width: rect.w + 12 + 'px', height: rect.h + 12 + 'px', opacity: 1 });
  };
})()`;

/**
 * Where a target is on screen (CSS px), or null: its box, and the point the cursor goes to.
 * A target is { text }, { label }, { css } or { point: [x, y] }, optionally with { within: css }
 * and { at }, where the cursor goes: the part of it with that text, or [x, y] as fractions of it.
 */
async function locate(page, target) {
  if (target.point) return { x: target.point[0], y: target.point[1], w: 0, h: 0, px: target.point[0], py: target.point[1] };
  return page.evaluate(t => {
    const scope = t.within ? document.querySelector(t.within) : document;
    if (!scope) return null;
    const shown = e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    let el = null;
    if (t.css) el = [...scope.querySelectorAll(t.css)].find(shown);
    else if (t.label) el = [...scope.querySelectorAll('button[aria-label]')].filter(shown).find(b => b.getAttribute('aria-label').startsWith(t.label));
    else if (t.text) {
      const els = [...scope.querySelectorAll('button, a, label, [role=button], [role=tab], [role=radio]')].filter(shown);
      el = els.find(e => e.textContent.trim() === t.text) ?? els.find(e => e.textContent.trim().startsWith(t.text));
    }
    if (!el) return null;
    const r0 = el.getBoundingClientRect();
    if (r0.top < 0 || r0.bottom > innerHeight) el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    const box = { x: r.left, y: r.top, w: r.width, h: r.height };
    if (Array.isArray(t.at)) return { ...box, px: r.left + r.width * t.at[0], py: r.top + r.height * t.at[1] };
    const part = t.at ? [...el.querySelectorAll('*')].reverse().find(e => e.textContent.trim() === t.at) : null;
    const p = (part ?? el).getBoundingClientRect();
    return { ...box, px: p.left + p.width / 2, py: p.top + p.height / 2 };
  }, target);
}

async function waitFor(page, target, timeout = 60_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const found = target.text && !target.within
      ? await page.evaluate(t => document.body.innerText.includes(t), target.text)
      : await locate(page, target);
    if (found) return;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${JSON.stringify(target)}`);
}

class Cursor {
  constructor(page) { this.page = page; this.x = VIEW.w * 0.62; this.y = VIEW.h * 0.7; }
  async show() { await this.page.mouse.move(this.x, this.y); }
  // An eased glide, not a jump, so a viewer can follow it.
  async glide(x, y) {
    const dist = Math.hypot(x - this.x, y - this.y);
    const ms = Math.min(1100, Math.max(450, 300 + dist * 0.55));
    const [x0, y0] = [this.x, this.y];
    const t0 = Date.now();
    for (;;) {
      const p = Math.min(1, (Date.now() - t0) / ms);
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      this.x = x0 + (x - x0) * e;
      this.y = y0 + (y - y0) * e;
      await this.page.mouse.move(this.x, this.y);
      if (p === 1) break;
      await sleep(14);
    }
  }
  async ring(rect) { await this.page.evaluate(r => window.__gvRing?.(r), rect && rect.w ? rect : null); }
}

/** Runs one recorded step's actions. Returns the cut stretches (wall clock) it asked for. */
async function runActions(page, cursor, actions, ctx) {
  const cuts = [];
  for (const [verb, ...args] of actions) {
    if (verb === 'pause') await sleep(args[0]);
    else if (verb === 'click' || verb === 'hover' || verb === 'type') {
      const [target, third] = args;
      const rect = await locate(page, target);
      if (!rect) throw new Error(`${verb}: can't find ${JSON.stringify(target)}`);
      await sleep(120); // let a scrollIntoView settle
      await cursor.glide(rect.px, rect.py);
      await cursor.ring(rect);
      await sleep(verb === 'hover' ? (third ?? 1500) : 380);
      if (verb !== 'hover') {
        await page.mouse.down();
        await sleep(90);
        await page.mouse.up();
        await sleep(260);
      }
      await cursor.ring(null);
      if (verb === 'type') {
        await sleep(200);
        await page.keyboard.type(third, { delay: 190 });
      }
    } else if (verb === 'wheel') {
      const [target, dy, ms = 1500] = args;
      const rect = await locate(page, target);
      if (!rect) throw new Error(`wheel: can't find ${JSON.stringify(target)}`);
      await cursor.glide(rect.px, rect.py);
      const steps = Math.max(1, Math.round(ms / 16));
      for (let i = 0; i < steps; i++) {
        // Eased, so the scroll starts and stops gently
        const share = (Math.cos(Math.PI * i / steps) - Math.cos(Math.PI * (i + 1) / steps)) / 2;
        await page.mouse.wheel(0, dy * share);
        await sleep(16);
      }
    } else if (verb === 'waitFor') {
      const [target, opts = {}] = args;
      const t0 = now();
      await waitFor(page, target, opts.timeout);
      // Keep a moment of the wait (a spinner says something is happening), cut the rest.
      if (opts.cut && now() - t0 > 0.9) cuts.push([t0 + 0.5, now()]);
    } else if (verb === 'saveTo') {
      await ctx.app.evaluate(({ dialog }, f) => {
        dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [f] });
      }, ctx.savedDir);
    } else if (verb === 'press') await page.keyboard.press(args[0]);
    else if (verb === 'eval') await page.evaluate(args[0]);
  }
  return cuts;
}

// ── Stills: caption bands, title cards and the PDF's pages, drawn by Chromium in the same window ──

function fontFaces() {
  const font = (family, file, weight, style = 'normal') => {
    const data = fs.readFileSync(path.join(ROOT, 'node_modules/@fontsource', file)).toString('base64');
    return `@font-face { font-family: ${family}; font-weight: ${weight}; font-style: ${style}; src: url(data:font/woff2;base64,${data}) format('woff2'); }`;
  };
  return [
    font('Fraunces', 'fraunces/files/fraunces-latin-500-normal.woff2', 500),
    font('Fraunces', 'fraunces/files/fraunces-latin-500-italic.woff2', 500, 'italic'),
    font('Geist', 'geist/files/geist-latin-400-normal.woff2', 400),
    font('Geist', 'geist/files/geist-latin-500-normal.woff2', 500),
  ].join('\n');
}

const escapeHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// *words* in a card title are set in the app's coral italic, like its "unlocked." heading
const accent = s => escapeHtml(s).replace(/\*([^*]+)\*/g, '<em>$1</em>').replace(/\n/g, '<br>');

function stillPage(body, extraCss = '') {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
${fontFaces()}
* { box-sizing: border-box; margin: 0; }
html, body { background: transparent; }
body { font-family: Geist, sans-serif; -webkit-font-smoothing: antialiased; }
.frame { position: relative; width: ${OUT.w / 2}px; height: ${OUT.h / 2}px; overflow: hidden; }
${extraCss}
</style></head><body>${body}</body></html>`;
}

/** The frame behind a recorded step or the PDF: a dark backdrop, a shadow for the app, the caption below. */
function backdropHtml(caption, { appShadow = true } = {}) {
  const a = { x: APP.x / 2, y: APP.y / 2, w: APP.w / 2, h: APP.h / 2 };
  return stillPage(`<div class="frame">
    ${appShadow ? '<div class="app"></div>' : ''}
    <div class="band"><span>${escapeHtml(caption)}</span></div>
  </div>`, `
.frame { background: ${COLORS.backdrop}; }
.app { position: absolute; left: ${a.x}px; top: ${a.y}px; width: ${a.w}px; height: ${a.h}px; border-radius: 3px;
  background: ${COLORS.cream}; box-shadow: 0 10px 34px rgba(0,0,0,.45), 0 0 0 1px rgba(255,255,255,.06); }
.band { position: absolute; left: 0; right: 0; top: ${BAND.y / 2}px; height: ${BAND.h / 2}px; display: flex; align-items: center; justify-content: center; }
.band span { color: ${COLORS.cream}; font-weight: 500; font-size: 18.5px; letter-spacing: .005em; }
`);
}

function cardHtml(card) {
  return stillPage(`<div class="frame card">
    <div class="brand"><i></i>OpenExtract</div>
    <h1>${accent(card.title)}</h1>
    ${card.sub ? `<p>${escapeHtml(card.sub)}</p>` : ''}
  </div>`, `
.card { background: ${COLORS.cream}; display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; padding: 0 80px; }
.brand { position: absolute; top: 34px; left: 40px; display: flex; align-items: center; gap: 10px; font-family: Fraunces, serif; font-weight: 500; font-size: 19px; color: ${COLORS.ink}; }
.brand i { width: 20px; height: 20px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, #f3b27f, ${COLORS.coral} 55%, ${COLORS.accent}); }
h1 { font-family: Fraunces, serif; font-weight: 500; font-size: 50px; line-height: 1.1; color: ${COLORS.ink}; letter-spacing: -.01em; max-width: 760px; }
h1 em { color: ${COLORS.accent}; font-style: italic; }
p { margin-top: 22px; font-size: 20px; color: ${COLORS.ink2}; }`);
}

/** The PDF's first pages side by side, as tall as the app's place in the frame, to pan across. */
function pdfStripHtml(images) {
  const imgs = images.map(f => `<img src="data:image/png;base64,${fs.readFileSync(f).toString('base64')}">`).join('');
  return stillPage(`<div class="strip">${imgs}</div>`, `
.strip { display: inline-flex; gap: 16px; padding: 10px 20px; height: ${APP.h / 2}px; }
.strip img { height: 100%; display: block; background: #fff; box-shadow: 0 6px 22px rgba(0,0,0,.5); }`);
}

async function snap(page, cdp, html, file, { selector = '.frame', width = OUT.w / 2, height = OUT.h / 2 } = {}) {
  await cdp.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
  await page.setContent(html);
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(() => Promise.all([...document.images].map(i => i.decode())));
  await page.locator(selector).screenshot({ path: file, omitBackground: true });
  return file;
}

// ── Putting it together ──

async function record(video, args, work) {
  const savedDir = path.join(work, 'saved');
  const framesDir = path.join(work, 'frames');
  const profile = path.join(work, 'profile');
  // Fresh every run: a remembered backup would turn the start screen into "Your backups"
  for (const d of [framesDir, savedDir, profile]) fs.rmSync(d, { recursive: true, force: true });
  fs.mkdirSync(framesDir, { recursive: true });
  fs.mkdirSync(savedDir, { recursive: true });

  // Imported here, not at the top, so tests can load this file without Playwright.
  const { COMMANDS, session } = await import('../.claude/skills/run-openextract/driver.mjs');
  console.log(await COMMANDS.launch(profile));
  console.log(await COMMANDS.goto(args.renderer));
  const { app, page } = session();
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEW.w, height: VIEW.h, deviceScaleFactor: 2, mobile: false });
  await page.evaluate(() => document.fonts.ready);
  await waitFor(page, { text: 'Open a backup folder' });
  // The card after an export (the pay-it-forward ask, or "did it come out right?") isn't part
  // of any guide; tell this throwaway profile it's been answered, so it stays away.
  await page.evaluate(() => Promise.all([window.openextract.support.markPaid(), window.openextract.feedback.optOutOfExportCheck()]));
  await sleep(1500);
  await page.evaluate(OVERLAY);
  const cursor = new Cursor(page);
  await cursor.show();

  const frames = [];
  let n = 0;
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    const file = path.join(framesDir, `${String(++n).padStart(6, '0')}.jpg`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
    frames.push({ file, ts: metadata.timestamp ?? now() });
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 90, maxWidth: VIEW.w * 2, maxHeight: VIEW.h * 2, everyNthFrame: 1 });
  await sleep(400);

  const marks = []; // wall-clock start of each step (inserts get the moment between their neighbours)
  const cuts = [];
  for (const step of video.steps) {
    marks.push(now());
    if (!step.do) continue;
    console.log(`step: ${step.caption}`);
    await sleep(step.lead ?? LEAD_MS);
    cuts.push(...await runActions(page, cursor, step.do, { app, savedDir }));
  }
  const end = now();
  await sleep(300);
  await cdp.send('Page.stopScreencast');
  await sleep(300);
  console.log(`${frames.length} frames`);
  fs.writeFileSync(path.join(work, 'timing.json'), JSON.stringify({ frames: frames.map(f => f.ts), marks, cuts, end }));

  const pdfs = fs.readdirSync(savedDir).filter(f => f.endsWith('.pdf')).map(f => path.join(savedDir, f));
  const stills = await makeStills(video, page, cdp, work, pdfs);
  await app.close();
  return { frames, marks, cuts, end, stills, pdfs };
}

async function makeStills(video, page, cdp, work, pdfs) {
  const dir = path.join(work, 'stills');
  fs.mkdirSync(dir, { recursive: true });
  // A fresh document: the app's page has a content security policy that blocks the fonts below.
  await page.goto('about:blank');
  const stills = {};
  for (const [i, step] of video.steps.entries()) {
    const file = path.join(dir, `step-${String(i + 1).padStart(2, '0')}.png`);
    if (step.card) stills[i] = await snap(page, cdp, cardHtml(step.card), file);
    else if (step.do) stills[i] = await snap(page, cdp, backdropHtml(step.caption), file);
    else if (step.pdf) {
      const pdf = pdfs.at(-1);
      if (!pdf) throw new Error('a pdf step needs a PDF saved earlier in the run');
      const pagesDir = path.join(work, 'pdf-pages');
      fs.rmSync(pagesDir, { recursive: true, force: true });
      fs.mkdirSync(pagesDir);
      run('pdftoppm', ['-r', '150', '-f', '1', '-l', String(step.pdf.pages ?? 2), '-png', pdf, path.join(pagesDir, 'p')]);
      const pages = fs.readdirSync(pagesDir).sort().map(f => path.join(pagesDir, f));
      stills[i] = await snap(page, cdp, backdropHtml(step.caption, { appShadow: false }), file);
      stills[`${i}-strip`] = await snap(page, cdp, pdfStripHtml(pages), path.join(dir, `step-${String(i + 1).padStart(2, '0')}-strip.png`),
        { selector: '.strip', width: OUT.w, height: OUT.h / 2 });
    }
  }
  return stills;
}

function encode(video, rec, args, work) {
  const segDir = path.join(work, 'segments');
  fs.mkdirSync(segDir, { recursive: true });
  const { entries, at } = timeline(rec.frames, rec.cuts, rec.end);
  const recordedTotal = at(rec.end);
  // Each step's start in recording time; an insert's is the moment the next recorded step began.
  const stepAt = rec.marks.map(at);
  const lossless = ['-c:v', 'libx264', '-preset', 'veryfast', '-qp', '0', '-pix_fmt', 'yuv444p'];
  const segments = segmentsOf(video.steps);
  const files = [];
  const stepOffsets = {}; // step index -> seconds into its segment

  for (const [k, seg] of segments.entries()) {
    const file = path.join(segDir, `${String(k).padStart(2, '0')}-${seg.kind}.mp4`);
    const first = seg.steps[0];
    const step = video.steps[first];
    if (seg.kind === 'card') {
      const secs = (step.ms ?? 3000) / 1000;
      ffmpeg(['-loop', '1', '-framerate', String(OUT.fps), '-t', secs.toFixed(3), '-i', rec.stills[first], '-vf', 'format=yuv444p', ...lossless, file]);
      stepOffsets[first] = 0;
    } else if (seg.kind === 'pdf') {
      const secs = (step.ms ?? 10000) / 1000;
      const [stripW, stripH] = run(process.env.FFPROBE || 'ffprobe', ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', rec.stills[`${first}-strip`]])
        .trim().split(',').map(Number);
      const viewW = Math.min(APP.w, stripW);
      const travel = stripW - viewW;
      const [hold, moveFor] = [1.2, Math.max(1, secs - 3.2)];
      const x = `${travel}*(1-cos(PI*clip((t-${hold})/${moveFor},0,1)))/2`;
      ffmpeg([
        '-loop', '1', '-framerate', String(OUT.fps), '-t', secs.toFixed(3), '-i', rec.stills[first],
        '-loop', '1', '-framerate', String(OUT.fps), '-t', secs.toFixed(3), '-i', rec.stills[`${first}-strip`],
        '-filter_complex', `[1:v]crop=${viewW}:${stripH}:'${x}':0[strip];[0:v][strip]overlay=${(OUT.w - viewW) / 2}:${APP.y},format=yuv444p`,
        ...lossless, file,
      ]);
      stepOffsets[first] = 0;
    } else {
      const from = stepAt[first];
      const nextIndex = seg.steps.at(-1) + 1;
      const to = nextIndex < video.steps.length ? stepAt[nextIndex] : recordedTotal;
      const framesFile = path.join(segDir, `${k}-frames.ffconcat`);
      fs.writeFileSync(framesFile, ffconcat(sliceEntries(entries, from, to)));
      const backdrops = seg.steps.map((s, j) => ({
        file: rec.stills[s],
        duration: (j + 1 < seg.steps.length ? stepAt[seg.steps[j + 1]] : to) - stepAt[s],
      }));
      const bgFile = path.join(segDir, `${k}-backdrops.ffconcat`);
      fs.writeFileSync(bgFile, ffconcat(backdrops));
      for (const s of seg.steps) stepOffsets[s] = stepAt[s] - from;
      ffmpeg([
        '-f', 'concat', '-safe', '0', '-i', framesFile,
        '-f', 'concat', '-safe', '0', '-i', bgFile,
        '-filter_complex',
        `[0:v]fps=${OUT.fps},scale=${APP.w}:${APP.h}:flags=lanczos,setsar=1[app];` +
        `[1:v]fps=${OUT.fps},setsar=1[bg];[bg][app]overlay=${APP.x}:${APP.y}:shortest=1,format=yuv444p`,
        '-t', (to - from).toFixed(3), ...lossless, file,
      ]);
    }
    files.push(file);
  }

  // Measure what was made rather than trusting the arithmetic, then crossfade the segments.
  const measured = files.map(probeSeconds);
  const { starts, total } = segmentStarts(measured);
  const inputs = files.flatMap(f => ['-i', f]);
  let chain = '';
  let last = '[0:v]';
  files.slice(1).forEach((_, j) => {
    const label = j === files.length - 2 ? '[joined]' : `[x${j}]`;
    chain += `${last}[${j + 1}:v]xfade=transition=fade:duration=${CROSSFADE}:offset=${(starts[j + 1]).toFixed(3)}${label};`;
    last = label;
  });
  const joined = files.length > 1 ? '[joined]' : '[0:v]';
  const mp4 = path.join(args.out, `${video.slug}.mp4`);
  fs.mkdirSync(args.out, { recursive: true });
  ffmpeg([
    ...inputs,
    '-filter_complex', `${chain}${joined}settb=AVTB,fps=${OUT.fps},format=yuv420p[v]`,
    '-map', '[v]', '-an',
    '-c:v', 'libx264', '-preset', 'slow', '-crf', String(args.crf), '-tune', 'stillimage',
    '-x264-params', 'keyint=120:min-keyint=30', '-profile:v', 'high', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-metadata', `title=${video.title}`,
    mp4,
  ]);

  // Step start times in the finished video
  const segOf = {};
  segments.forEach((seg, k) => seg.steps.forEach(s => { segOf[s] = k; }));
  const stepStarts = video.steps.map((_, i) => starts[segOf[i]] + stepOffsets[i]);
  const duration = probeSeconds(mp4);
  const cues = video.steps.map((step, i) => ({
    start: stepStarts[i],
    end: i + 1 < video.steps.length ? stepStarts[i + 1] : duration,
    text: step.say ?? step.caption ?? step.card.title.replace(/\*/g, '').replace(/\n/g, ' '),
  }));
  const vtt = path.join(args.out, `${video.slug}.vtt`);
  fs.writeFileSync(vtt, webvtt(cues));

  // The poster: the poster step's frame, a little after the cursor gets where it's going.
  const posterIndex = Math.max(0, video.steps.findIndex(s => s.poster));
  const posterAt = Math.min(duration - 0.1, stepStarts[posterIndex] + (video.steps[posterIndex].posterAt ?? 2.2));
  const jpg = path.join(args.out, `${video.slug}.jpg`);
  ffmpeg(['-ss', posterAt.toFixed(3), '-i', mp4, '-frames:v', '1', '-vf', 'scale=1280:720:flags=lanczos', '-q:v', '3', jpg]);

  return {
    mp4, jpg, vtt, duration, iso: isoDuration(duration),
    bytes: fs.statSync(mp4).size,
    chapters: chaptersOf(video.steps, stepStarts, duration),
    cues, total,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.steps) throw new Error('usage: node scripts/record-guide-video.mjs <steps.mjs> --backup <UDID folder> [--renderer url]');
  const video = validateVideo((await import(pathToFileURL(path.resolve(args.steps)).href)).default);
  if (!args.backup || !fs.existsSync(path.join(args.backup, 'Manifest.plist'))) {
    throw new Error('--backup must be a synthetic backup folder (the one with Manifest.plist in it)');
  }
  args.out = path.resolve(args.out ?? path.join(ROOT, 'website/static/videos/media'));
  const work = path.resolve(args.work ?? fs.mkdtempSync(path.join(os.tmpdir(), `guide-video-${video.slug}-`)));
  fs.mkdirSync(work, { recursive: true });
  console.log(`working in ${work}`);

  // A throwaway HOME so only the synthetic backup can show, and no outside requests from the engine.
  Object.assign(process.env, {
    HOME: makeHome(work, path.resolve(args.backup)),
    https_proxy: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9', no_proxy: 'localhost,127.0.0.1',
  });

  const cleanups = [];
  try {
    if (args.build) {
      const pristine = run('git', ['status', '--porcelain', '--', 'dist-electron'], { cwd: ROOT }).trim() === '';
      fs.rmSync(path.join(ROOT, 'tsconfig.electron.tsbuildinfo'), { force: true });
      execFileSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['tsc', '-p', 'tsconfig.electron.json'], { cwd: ROOT, stdio: 'inherit', shell: process.platform === 'win32' });
      // dist-electron is committed; put it back unless it already had changes of its own.
      if (pristine) cleanups.push(() => {
        run('git', ['checkout', '--', 'dist-electron'], { cwd: ROOT });
        run('git', ['clean', '-fdq', '--', 'dist-electron'], { cwd: ROOT });
        fs.rmSync(path.join(ROOT, 'tsconfig.electron.tsbuildinfo'), { force: true });
      });
    }
    if (!args.renderer) {
      const port = await freePort();
      const vite = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', '--port', String(port), '--strictPort', '--host', '127.0.0.1'],
        { cwd: ROOT, stdio: 'ignore', shell: process.platform === 'win32' });
      cleanups.push(() => vite.kill());
      args.renderer = `http://127.0.0.1:${port}`;
      await waitForHttp(args.renderer);
    }
    const rec = await record(video, args, work);
    const result = encode(video, rec, args, work);
    fs.writeFileSync(path.join(work, 'summary.json'), JSON.stringify(result, null, 2));
    console.log(`\n${result.mp4}\n  ${result.duration.toFixed(1)} s (${result.iso}), ${(result.bytes / 1e6).toFixed(2)} MB`);
    console.log(`${result.jpg}\n${result.vtt}\nchapters:`);
    for (const c of result.chapters) console.log(`  ${c.start.toFixed(1)}  ${c.name}`);
    console.log(`summary: ${path.join(work, 'summary.json')}`);
  } finally {
    for (const fn of cleanups.reverse()) { try { fn(); } catch (e) { console.error(e.message); } }
  }
}

if (isMain) {
  main().then(() => process.exit(0), e => { console.error(e.stack || e.message); process.exit(1); });
}
