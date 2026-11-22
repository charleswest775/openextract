// The parts of scripts/record-guide-video.mjs that are plain arithmetic and text: the step
// list's shape, the recording's timeline, and the captions file. Kept apart so tests can
// load them without Playwright or Electron.

/** What a recorded step may do. See scripts/guide-videos/README.md. */
export const ACTIONS = new Set(['pause', 'click', 'hover', 'type', 'wheel', 'press', 'waitFor', 'saveTo', 'eval']);

/** Steps that aren't recorded but made from stills: a title card, or the PDF the run saved. */
export const INSERTS = new Set(['card', 'pdf']);

/** Seconds the segments overlap where one fades into the next. */
export const CROSSFADE = 0.5;

/** Throws with a readable message if a step list can't be recorded. */
export function validateVideo(video) {
  const problems = [];
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(video?.slug ?? '')) problems.push('slug must be lowercase words joined by hyphens');
  if (!video?.title) problems.push('title is missing');
  if (!Array.isArray(video?.steps) || video.steps.length === 0) problems.push('steps is empty');
  (video?.steps ?? []).forEach((step, i) => {
    const where = `step ${i + 1}`;
    const kinds = ['do', ...INSERTS].filter(k => step[k] !== undefined);
    if (kinds.length !== 1) problems.push(`${where} needs exactly one of do, card, pdf`);
    if (!step.card && !step.caption) problems.push(`${where} has no caption`);
    if (step.caption && step.caption.length > 70) problems.push(`${where}'s caption is over 70 characters`);
    for (const action of step.do ?? []) {
      if (!Array.isArray(action) || !ACTIONS.has(action[0])) problems.push(`${where}: unknown action ${JSON.stringify(action)}`);
    }
    if (step.card && !step.card.title) problems.push(`${where}'s card has no title`);
  });
  const recorded = (video?.steps ?? []).filter(s => s.do);
  if (recorded.length === 0) problems.push('no step records the app');
  if ((video?.steps ?? []).filter(s => s.poster).length > 1) problems.push('only one step can be the poster');
  if (problems.length) throw new Error(`${video?.slug ?? 'video'}: ${problems.join('; ')}`);
  return video;
}

/**
 * Splits the steps into the video's segments, in order: each card or PDF step is a segment
 * of its own, and each run of recorded steps between them is one recorded segment.
 */
export function segmentsOf(steps) {
  const segments = [];
  for (const [index, step] of steps.entries()) {
    if (step.do) {
      const last = segments.at(-1);
      if (last?.kind === 'recording') last.steps.push(index);
      else segments.push({ kind: 'recording', steps: [index] });
    } else {
      segments.push({ kind: step.card ? 'card' : 'pdf', steps: [index] });
    }
  }
  return segments;
}

/**
 * The screencast's frames as a list of stills and how long each shows, with the cut
 * stretches (waits nobody needs to watch) taken out. Frames arrive only when the screen
 * changes, each with a wall-clock timestamp in seconds; `cuts` are [from, to] in the same
 * clock, and `end` is when recording stopped. Also returns `at(ts)`, which maps a wall-clock
 * time to its time in the video.
 */
export function timeline(frames, cuts, end) {
  const sorted = [...cuts].sort((a, b) => a[0] - b[0]);
  const removedBefore = ts => sorted.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(ts, b) - a), 0);
  const start = frames[0]?.ts ?? end;
  const at = ts => Math.max(0, ts - start - removedBefore(ts) + removedBefore(start));
  // Frames inside a cut never show, except the last one, which is what the screen looked
  // like when the cut ended (frames only come when something changes): it moves to the end.
  const kept = [];
  for (const f of frames) {
    const cut = sorted.find(([a, b]) => f.ts > a && f.ts < b);
    if (!cut) kept.push(f);
    else if (kept.at(-1)?.cut === cut) kept[kept.length - 1] = { ...f, ts: cut[1], cut };
    else kept.push({ ...f, ts: cut[1], cut });
  }
  const entries = kept.map((f, i) => {
    const next = i + 1 < kept.length ? kept[i + 1].ts : end;
    return { file: f.file, duration: Math.max(0, at(next) - at(f.ts)) };
  }).filter(e => e.duration > 0.0005);
  return { entries, at, length: at(end) };
}

/**
 * The part of a timeline's entries between two of its times (seconds into the recording),
 * so a recording can be split where a card or the PDF goes in between its steps.
 */
export function sliceEntries(entries, from, to) {
  const out = [];
  let t = 0;
  for (const e of entries) {
    const a = Math.max(t, from);
    const b = Math.min(t + e.duration, to);
    if (b - a > 0.0005) out.push({ file: e.file, duration: b - a });
    t += e.duration;
    if (t >= to) break;
  }
  return out;
}

/** An ffmpeg concat-demuxer script: each still for its duration. */
export function ffconcat(entries) {
  const quote = f => `'${f.replace(/'/g, "'\\''")}'`;
  const lines = ['ffconcat version 1.0'];
  for (const e of entries) lines.push(`file ${quote(e.file)}`, `duration ${e.duration.toFixed(4)}`);
  // The demuxer ignores the last entry's duration unless the file is listed once more.
  if (entries.length) lines.push(`file ${quote(entries.at(-1).file)}`);
  return lines.join('\n') + '\n';
}

/** Where each segment starts in the finished video, given each one's length and the crossfade. */
export function segmentStarts(lengths, crossfade = CROSSFADE) {
  const starts = [];
  let t = 0;
  for (const [i, length] of lengths.entries()) {
    starts.push(t);
    t += length - (i + 1 < lengths.length ? crossfade : 0);
  }
  return { starts, total: t };
}

/** 83.4 -> "00:01:23.400" */
export function vttTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor(ms / 60000) % 60;
  const s = Math.floor(ms / 1000) % 60;
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms % 1000, 3)}`;
}

/** A WebVTT file from [{ start, end, text }] in seconds. */
export function webvtt(cues) {
  const blocks = cues.map((c, i) => `${i + 1}\n${vttTime(c.start)} --> ${vttTime(c.end)}\n${c.text}`);
  return `WEBVTT\n\n${blocks.join('\n\n')}\n`;
}

/** The cues back out of a WebVTT file, for checks. */
export function parseVtt(text) {
  const toSeconds = t => t.split(':').reduce((sum, part) => sum * 60 + Number(part), 0);
  // A Windows checkout with core.autocrlf turns the file's line endings into CRLF.
  return [...text.replace(/\r\n?/g, '\n').matchAll(/(\d\d:\d\d:\d\d\.\d{3}) --> (\d\d:\d\d:\d\d\.\d{3})\n([^\n]+(?:\n[^\n]+)*)/g)]
    .map(m => ({ start: toSeconds(m[1]), end: toSeconds(m[2]), text: m[3] }));
}

/** 83.4 -> "PT1M23S", the ISO 8601 form VideoObject's duration takes. */
export function isoDuration(seconds) {
  const whole = Math.round(seconds);
  const m = Math.floor(whole / 60);
  const s = whole % 60;
  return `PT${m ? `${m}M` : ''}${s || !m ? `${s}S` : ''}`;
}

/** 83.4 -> "1:23", as YouTube chapters write it. */
export function clockTime(seconds) {
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * Chapters for YouTube and for VideoObject's Clip markup: a step with `chapter` starts one,
 * and it runs until the next. The first always starts at 0, as YouTube requires.
 */
export function chaptersOf(steps, stepStarts, total) {
  const chapters = [];
  steps.forEach((step, i) => {
    if (step.chapter) chapters.push({ name: step.chapter, start: chapters.length ? stepStarts[i] : 0 });
  });
  chapters.forEach((c, i) => { c.end = i + 1 < chapters.length ? chapters[i + 1].start : total; });
  return chapters;
}
