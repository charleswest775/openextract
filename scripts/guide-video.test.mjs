// Tests for the guide-video recorder's arithmetic (scripts/guide-video-lib.mjs), its step
// lists (scripts/guide-videos/*.mjs), and the watch pages that show the videos
// (website/static/videos/*.html, their files in videos/media/). Offline: nothing here records
// or plays anything.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  chaptersOf, clockTime, ffconcat, isoDuration, parseVtt, segmentStarts, segmentsOf,
  sliceEntries, timeline, validateVideo, vttTime, webvtt,
} from './guide-video-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stepsDir = path.join(root, 'scripts/guide-videos');
const videosDir = path.join(root, 'website/static/videos');
const mediaDir = path.join(videosDir, 'media');
const SITE = 'https://www.openextract.app';

const stepFiles = fs.readdirSync(stepsDir).filter(f => f.endsWith('.mjs'));
const watchPages = fs.existsSync(videosDir) ? fs.readdirSync(videosDir).filter(f => f.endsWith('.html')) : [];

test('every step list can be recorded', async () => {
  assert.ok(stepFiles.length > 0);
  for (const f of stepFiles) {
    const video = (await import(pathToFileURL(path.join(stepsDir, f)).href)).default;
    validateVideo(video);
    assert.equal(`${video.slug}.mjs`, f, 'a step list is named after its slug');
  }
});

test('a step list with a mistake in it says what the mistake is', () => {
  const ok = { slug: 'x-y', title: 'X', steps: [{ caption: 'Click it', do: [['click', { text: 'It' }]] }] };
  assert.doesNotThrow(() => validateVideo(ok));
  assert.throws(() => validateVideo({ ...ok, slug: 'Not A Slug' }), /slug/);
  assert.throws(() => validateVideo({ ...ok, steps: [{ caption: 'Tap', do: [['tap', 'It']] }] }), /unknown action/);
  assert.throws(() => validateVideo({ ...ok, steps: [{ caption: 'Both', do: [], pdf: {} }] }), /exactly one/);
  assert.throws(() => validateVideo({ ...ok, steps: [{ card: { title: 'Only a card' } }] }), /no step records/);
});

test('steps become segments: each card or PDF alone, recorded steps run together', () => {
  const steps = [{ card: {} }, { do: [] }, { do: [] }, { pdf: {} }, { do: [] }, { card: {} }];
  assert.deepEqual(segmentsOf(steps), [
    { kind: 'card', steps: [0] },
    { kind: 'recording', steps: [1, 2] },
    { kind: 'pdf', steps: [3] },
    { kind: 'recording', steps: [4] },
    { kind: 'card', steps: [5] },
  ]);
});

test('the timeline gives each frame until the next one, and cut waits disappear', () => {
  const frames = [{ file: 'a', ts: 100 }, { file: 'b', ts: 101 }, { file: 'c', ts: 103 }, { file: 'd', ts: 104 }, { file: 'e', ts: 108 }];
  // Without cuts: each frame lasts until the next, the last until recording stopped
  const plain = timeline(frames, [], 110);
  assert.deepEqual(plain.entries.map(e => [e.file, e.duration]), [['a', 1], ['b', 2], ['c', 1], ['d', 4], ['e', 2]]);
  assert.equal(plain.length, 10);
  // Cutting 102.5–107: c and d fall inside, d (the screen when the cut ended) moves to 107
  const cut = timeline(frames, [[102.5, 107]], 110);
  assert.deepEqual(cut.entries.map(e => [e.file, +e.duration.toFixed(3)]), [['a', 1], ['b', 1.5], ['d', 1], ['e', 2]]);
  assert.equal(cut.length, 5.5);
  assert.equal(cut.at(108), 3.5);
  assert.equal(cut.at(101), 1);
});

test('a recording splits where a card or the PDF goes in', () => {
  const entries = [{ file: 'a', duration: 2 }, { file: 'b', duration: 3 }, { file: 'c', duration: 1 }];
  assert.deepEqual(sliceEntries(entries, 0, 2.5), [{ file: 'a', duration: 2 }, { file: 'b', duration: 0.5 }]);
  assert.deepEqual(sliceEntries(entries, 2.5, 6), [{ file: 'b', duration: 2.5 }, { file: 'c', duration: 1 }]);
});

test('the concat script lists the last still twice, so its duration counts', () => {
  const text = ffconcat([{ file: '/x/a.jpg', duration: 0.5 }, { file: "/x/it's.jpg", duration: 1 }]);
  assert.equal(text, "ffconcat version 1.0\nfile '/x/a.jpg'\nduration 0.5000\nfile '/x/it'\\''s.jpg'\nduration 1.0000\nfile '/x/it'\\''s.jpg'\n");
});

test('crossfaded segments start before the one before them ends', () => {
  assert.deepEqual(segmentStarts([4, 10, 5], 0.5), { starts: [0, 3.5, 13], total: 18 });
  assert.deepEqual(segmentStarts([7], 0.5), { starts: [0], total: 7 });
});

test('times are written the way WebVTT, schema.org and YouTube each want them', () => {
  assert.equal(vttTime(83.4), '00:01:23.400');
  assert.equal(vttTime(0.0004), '00:00:00.000');
  assert.equal(isoDuration(65.5), 'PT1M6S');
  assert.equal(isoDuration(60.2), 'PT1M');
  assert.equal(isoDuration(42), 'PT42S');
  assert.equal(clockTime(65.9), '1:05');
  const cues = [{ start: 0, end: 4.25, text: 'One' }, { start: 4.25, end: 9, text: 'Two' }];
  assert.deepEqual(parseVtt(webvtt(cues)), cues);
  assert.deepEqual(parseVtt(webvtt(cues).replace(/\n/g, '\r\n')), cues, 'a CRLF checkout reads the same');
});

test('chapters start where their step starts, the first at 0', () => {
  const steps = [{ chapter: 'Intro' }, {}, { chapter: 'Save' }, { chapter: 'Result' }];
  assert.deepEqual(chaptersOf(steps, [0.4, 4, 20, 31], 40), [
    { name: 'Intro', start: 0, end: 20 },
    { name: 'Save', start: 20, end: 31 },
    { name: 'Result', start: 31, end: 40 },
  ]);
});

// ── The watch pages ──

function videoObject(html) {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => JSON.parse(m[1]));
  return blocks.find(b => b['@type'] === 'VideoObject');
}

const localFile = url => path.join(root, 'website/static', new URL(url).pathname);

test('every watch page has a playable video, its files, and markup that matches them', () => {
  assert.ok(watchPages.length > 0, 'website/static/videos has a watch page');
  const sitemap = fs.readFileSync(path.join(root, 'website/static/sitemap.xml'), 'utf-8');
  for (const f of watchPages) {
    const slug = f.replace(/\.html$/, '');
    const html = fs.readFileSync(path.join(videosDir, f), 'utf-8');
    const pageUrl = `${SITE}/videos/${slug}`;
    assert.match(html, new RegExp(`<link rel="canonical" href="${pageUrl}" />`));

    // The player: controls, no autoplay, a poster, captions, and only metadata (or nothing) up front
    const tag = html.match(/<video\b[^>]*>/)?.[0];
    assert.ok(tag, `${f} has a <video>`);
    assert.match(tag, /\bcontrols\b/);
    assert.doesNotMatch(tag, /\bautoplay\b/);
    assert.match(tag, /preload="(metadata|none)"/);
    assert.match(tag, new RegExp(`poster="/videos/media/${slug}\\.jpg"`));
    assert.match(html, new RegExp(`<source src="/videos/media/${slug}\\.mp4" type="video/mp4"`));
    assert.match(html, new RegExp(`<track kind="captions" src="/videos/media/${slug}\\.vtt" srclang="en"`));

    // The structured data points at the files that are there
    const v = videoObject(html);
    assert.ok(v, `${f} has VideoObject JSON-LD`);
    for (const key of ['name', 'description', 'thumbnailUrl', 'uploadDate', 'duration', 'contentUrl']) assert.ok(v[key], `${f}: ${key}`);
    assert.equal(v.contentUrl, `${SITE}/videos/media/${slug}.mp4`);
    assert.equal(v.thumbnailUrl, `${SITE}/videos/media/${slug}.jpg`);
    assert.match(v.uploadDate, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    for (const ext of ['mp4', 'jpg', 'vtt']) assert.ok(fs.existsSync(path.join(mediaDir, `${slug}.${ext}`)), `media/${slug}.${ext} exists`);
    assert.ok(fs.existsSync(localFile(v.contentUrl)));

    // Its length and chapters agree with the captions file, which the recorder wrote from the video
    const cues = parseVtt(fs.readFileSync(path.join(mediaDir, `${slug}.vtt`), 'utf-8'));
    assert.ok(cues.length > 0);
    assert.equal(v.duration, isoDuration(cues.at(-1).end));
    const starts = new Set(cues.map(c => Math.floor(c.start)));
    for (const clip of v.hasPart ?? []) {
      assert.equal(clip['@type'], 'Clip');
      assert.ok(clip.startOffset === 0 || starts.has(clip.startOffset), `${clip.name} starts where a step does`);
      assert.equal(clip.url, clip.startOffset ? `${pageUrl}?t=${clip.startOffset}` : pageUrl);
    }

    // In the sitemap, with its video
    assert.match(sitemap, new RegExp(`<loc>${pageUrl}</loc>[\\s\\S]*?<video:content_loc>${v.contentUrl}</video:content_loc>`));
  }
});
