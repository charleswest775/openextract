'use strict';

// Receives in-app feedback reports and files each one as an issue in a private
// GitHub repo, so users don't need a GitHub account and reports aren't public.
// Used by api/feedback.js and api/feedback-status.js; Vercel doesn't deploy
// files in an underscore folder as functions of their own.
//
// Setup (Vercel project settings → Environment Variables):
//   GITHUB_FEEDBACK_TOKEN  fine-grained token with Issues: read and write on the feedback repo only
//   FEEDBACK_REPO          optional, defaults to charleswest775/openextract-feedback

const crypto = require('crypto');
const { KNOWN_FIXES } = require('./known-fixes');

const DEFAULT_REPO = 'charleswest775/openextract-feedback';

// Ids and names must match FEEDBACK_KINDS / FEEDBACK_AREAS in src/lib/feedback.ts, and the
// GitHub labels must match .github/workflows/feedback-labels.yml (scripts/feedback.test.mjs checks both).
const KINDS = {
  broken: { label: "Something's broken", labels: ['bug'] },
  missing: { label: 'Something in my backup is missing or wrong', labels: ['bug'] },
  idea: { label: 'An idea or request', labels: ['enhancement'] },
  other: { label: 'Something else', labels: [] },
  // A thank-you: no diagnostics, no known fixes, and the app doesn't check on it afterwards.
  thanks: { label: 'It worked: say thanks', labels: ['thanks'] },
};

const AREAS = {
  general: { label: 'The app in general', labels: ['ui'] },
  open_backup: { label: 'Opening a backup', labels: ['python-engine'] },
  create_backup: { label: 'Making a backup', labels: ['python-engine'] },
  search: { label: 'Search', labels: ['ui'] },
  dashboard: { label: 'Backup details', labels: ['ui'] },
  people: { label: 'People', labels: ['ui'] },
  timeline: { label: 'Timeline', labels: ['ui'] },
  year: { label: 'Year', labels: ['ui'] },
  messages: { label: 'Messages', labels: ['messages'] },
  photos: { label: 'Photos', labels: ['photos'] },
  contacts: { label: 'Address book', labels: ['python-engine'] },
  calls: { label: 'Calls', labels: ['python-engine'] },
  notes: { label: 'Notes', labels: ['python-engine'] },
  voicemail: { label: 'Voicemail', labels: ['voicemail'] },
  browser_history: { label: 'Web history', labels: ['python-engine'] },
  record_recovery: { label: 'Recovering deleted messages', labels: ['messages'] },
  export: { label: 'Exporting', labels: ['export'] },
};

const LIMITS = { details: 8000, diagnostics: 20000, email: 254 };
const TOKEN_PATTERN = /^[0-9a-f]{32,128}$/;
const EMAIL_PATTERN = /^[^\s@<>()`"]+@[^\s@<>()`"]+\.[^\s@<>()`"]+$/;
// The last thing in every issue body. Only the hash of the app's random code is kept,
// so having the issue isn't enough to look up its status from the outside.
const MARKER_PATTERN = /<!-- openextract-report v1 token-sha256=([0-9a-f]{64}) -->\s*$/;
// A maintainer marks a report fixed by closing it and adding e.g. "fixed-in:0.9.2".
const FIXED_LABEL_PATTERN = /^fixed[- ]in[: -]v?(\d+(?:\.\d+){1,3})$/i;

const RATE_WINDOW_MS = 10 * 60 * 1000;
const RATE_PER_IP = 5;
const RATE_PER_INSTANCE = 60;

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function str(value) {
  return typeof value === 'string' ? value : '';
}

/** Checks a report from the app. Returns { report } or { error } with a message the app shows as is. */
function validateReport(body) {
  if (!body || typeof body !== 'object') return { error: 'The report was empty.' };
  const kind = str(body.kind);
  const area = str(body.area);
  if (!KINDS[kind] || !AREAS[area]) return { error: 'The report was missing its type or part of the app.' };

  const thanks = kind === 'thanks';
  const details = str(body.details).trim();
  if (!details && !thanks) return { error: 'Please describe what happened.' };
  if (details.length > LIMITS.details) {
    return { error: `The description is too long. Please keep it under ${LIMITS.details.toLocaleString('en-US')} characters.` };
  }

  const diagnostics = thanks ? '' : str(body.diagnostics).trim();
  if (diagnostics.length > LIMITS.diagnostics) {
    return { error: 'The details section is too long. Please delete some of it and try again.' };
  }

  const email = str(body.email).trim();
  if (email && (email.length > LIMITS.email || !EMAIL_PATTERN.test(email))) {
    return { error: "That email address doesn't look right. Check it, or leave it empty." };
  }

  const token = str(body.token);
  if (!TOKEN_PATTERN.test(token)) return { error: 'Please update OpenExtract and try again.' };

  // Only a thank-you with words in it can be quoted, and only when the sender ticked the box.
  const quote = thanks && Boolean(details) && body.quote === true;

  return { report: { kind, area, details, diagnostics, email, token, quote } };
}

/** Area plus the start of what the user wrote, so the issue list is scannable. Same as issueTitle() in src/lib/feedback.ts. */
function issueTitle(report) {
  const first = report.details.trim().split('\n')[0].replace(/\s+/g, ' ');
  const summary = first.length > 70 ? `${first.slice(0, 67).trimEnd()}…` : first;
  const area = AREAS[report.area].label;
  if (report.kind === 'thanks') return summary ? `[Thanks] ${area}: ${summary}` : `[Thanks] ${area}`;
  return `[Feedback] ${area}: ${summary || KINDS[report.kind].label}`;
}

/** Same headings as the public issue form (.github/ISSUE_TEMPLATE/in_app_feedback.yml), so triage reads both alike. */
function issueBody(report) {
  const thanks = report.kind === 'thanks';
  return [
    '### Type', '', KINDS[report.kind].label, '',
    '### Part of the app', '', AREAS[report.area].label, '',
    '### What happened?', '', report.details || '_No message, just a thank-you._', '',
    ...(thanks ? ['### OK to quote on openextract.app', '', report.quote ? 'Yes, without their name' : 'No', ''] : []),
    '### Diagnostics', '', thanks ? '_None. A thank-you never includes any._' : report.diagnostics || '_Removed by the sender._', '',
    '### Reply to', '',
    report.email
      ? `\`${report.email}\``
      : thanks ? '_No email given._' : '_No email given. The sender hears about a fix only in the app._',
    '',
    `<!-- openextract-report v1 token-sha256=${sha256(report.token)} -->`,
  ].join('\n');
}

function issueLabels(report) {
  // A thank-you skips the area's labels, so searching "messages" or "export" still finds only problems.
  const areaLabels = report.kind === 'thanks' ? [] : AREAS[report.area].labels;
  const labels = new Set(['feedback', ...KINDS[report.kind].labels, ...areaLabels]);
  // An iOS version newer than anything we've tested is worth a look on its own.
  const ios = report.diagnostics.match(/· iOS (\d+)/);
  if (ios && Number(ios[1]) >= 27) labels.add('ios-compat');
  if (report.email) labels.add('has-email');
  if (report.quote) labels.add('ok-to-quote');
  return [...labels];
}

/** Known problems this report looks like, in the shape the app shows. */
function matchKnownFixes(report, fixes = KNOWN_FIXES) {
  if (report.kind === 'thanks') return [];
  const text = `${report.details}\n${report.diagnostics}`;
  const matched = fixes.filter(f => f.match.test(text) && (!f.when || f.when.test(text)));
  // A fix can stand in for a vaguer one whose advice would be wrong here (`hides` in known-fixes.js).
  const hidden = new Set(matched.flatMap(f => f.hides || []));
  return matched
    .filter(f => !hidden.has(f.id))
    .slice(0, 2)
    // Each fix has its own section on the "Fixes for common problems" page (website/static/fixes.html).
    .map(f => ({ id: f.id, title: f.title, text: f.text, url: f.url || `https://www.openextract.app/fixes#${f.id}` }));
}

/** Where a report stands, from its issue. Labels win over open/closed so a fix can be marked before closing. */
function reportStatus(issue) {
  for (const l of issue.labels || []) {
    const m = String(typeof l === 'string' ? l : l?.name || '').match(FIXED_LABEL_PATTERN);
    if (m) return { status: 'fixed', fixedIn: m[1] };
  }
  return { status: issue.state === 'closed' ? 'closed' : 'open' };
}

function tokenMatches(issueBodyText, token) {
  const m = String(issueBodyText || '').match(MARKER_PATTERN);
  if (!m) return false;
  const expected = Buffer.from(m[1], 'hex');
  const actual = Buffer.from(sha256(token), 'hex');
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

/**
 * Best-effort limits, per running instance. They stop a stuck client or a casual
 * script; reports land in a private repo, so a determined spammer costs us
 * cleanup time, not exposure. Nothing here is stored beyond the window.
 */
class RateLimiter {
  constructor() {
    this.byIp = new Map();
    this.all = [];
  }

  allow(ip, now) {
    const fresh = (times) => times.filter(t => now - t < RATE_WINDOW_MS);
    this.all = fresh(this.all);
    const mine = fresh(this.byIp.get(ip) || []);
    if (mine.length >= RATE_PER_IP || this.all.length >= RATE_PER_INSTANCE) {
      this.byIp.set(ip, mine);
      return false;
    }
    mine.push(now);
    this.all.push(now);
    this.byIp.set(ip, mine);
    if (this.byIp.size > 5000) this.byIp.clear();
    return true;
  }
}

// A retry of the same report (same form, same random code) gets the first answer back.
class RecentReports {
  constructor() {
    this.seen = new Map();
  }

  get(key, now) {
    const hit = this.seen.get(key);
    return hit && now - hit.at < RATE_WINDOW_MS ? hit.answer : null;
  }

  set(key, answer, now) {
    for (const [k, v] of this.seen) if (now - v.at >= RATE_WINDOW_MS) this.seen.delete(k);
    this.seen.set(key, { answer, at: now });
  }
}

const limiter = new RateLimiter();
const recent = new RecentReports();

function clientIp(headers) {
  const forwarded = str(headers?.['x-forwarded-for']).split(',')[0].trim();
  return forwarded || str(headers?.['x-real-ip']) || 'unknown';
}

function github(env, fetchFn, path, init = {}) {
  return fetchFn(`https://api.github.com/repos/${env.FEEDBACK_REPO || DEFAULT_REPO}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${env.GITHUB_FEEDBACK_TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'openextract-feedback',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}

const NOT_SET_UP = { status: 503, body: { error: "Feedback can't be received right now. Please try again later." } };

function isJson(headers) {
  return str(headers?.['content-type']).toLowerCase().includes('application/json');
}

/** POST /api/feedback: file a report. Returns { status, body } for the handler to send. */
async function receiveReport(req, env, fetchFn, now = Date.now()) {
  if (req.method !== 'POST') return { status: 405, body: { error: 'Use POST.' } };
  if (!isJson(req.headers)) return { status: 415, body: { error: 'Send JSON.' } };
  if (!env.GITHUB_FEEDBACK_TOKEN) return NOT_SET_UP;

  const checked = validateReport(req.body);
  if (checked.error) return { status: 400, body: { error: checked.error } };
  const report = checked.report;

  const key = sha256(JSON.stringify([report.kind, report.area, report.details, report.diagnostics, report.email, report.token, report.quote]));
  const earlier = recent.get(key, now);
  if (earlier) return { status: 200, body: earlier };

  if (!limiter.allow(clientIp(req.headers), now)) {
    return { status: 429, body: { error: 'Too many reports were sent from your network in a short time. Please try again in a few minutes.' } };
  }

  const issue = { title: issueTitle(report), body: issueBody(report), labels: issueLabels(report) };
  let res = await github(env, fetchFn, '/issues', { method: 'POST', body: JSON.stringify(issue) });
  // A label that can't be applied shouldn't lose the report.
  if (res.status === 422) {
    res = await github(env, fetchFn, '/issues', { method: 'POST', body: JSON.stringify({ title: issue.title, body: issue.body }) });
  }
  if (!res.ok) {
    console.error(`[feedback] GitHub answered ${res.status} when filing a report`);
    return { status: 502, body: { error: "The report couldn't be saved. Please try again later." } };
  }
  const created = await res.json();

  const answer = { number: created.number, reference: `OE-${created.number}`, knownFixes: matchKnownFixes(report) };
  recent.set(key, answer, now);
  return { status: 200, body: answer };
}

/** POST /api/feedback-status: where one report stands. Only the app that sent it has its code. */
async function lookUpReport(req, env, fetchFn) {
  if (req.method !== 'POST') return { status: 405, body: { error: 'Use POST.' } };
  if (!isJson(req.headers)) return { status: 415, body: { error: 'Send JSON.' } };
  if (!env.GITHUB_FEEDBACK_TOKEN) return NOT_SET_UP;

  const number = req.body?.number;
  const token = str(req.body?.token);
  const notFound = { status: 404, body: { error: 'No such report.' } };
  if (!Number.isInteger(number) || number < 1 || !TOKEN_PATTERN.test(token)) return notFound;

  const res = await github(env, fetchFn, `/issues/${number}`);
  if (res.status === 404 || res.status === 410) return notFound;
  if (!res.ok) {
    console.error(`[feedback] GitHub answered ${res.status} when looking up a report`);
    return { status: 502, body: { error: 'Try again later.' } };
  }
  const issue = await res.json();
  if (issue.pull_request || !tokenMatches(issue.body, token)) return notFound;
  return { status: 200, body: reportStatus(issue) };
}

/** Wraps one of the functions above as a Vercel Node handler. */
function handler(fn) {
  return async function (req, res) {
    let body;
    try {
      body = req.body; // Vercel parses JSON lazily and throws on a malformed body.
    } catch {
      body = undefined;
    }
    let out;
    try {
      out = await fn({ method: req.method, headers: req.headers, body }, process.env, fetch);
    } catch (err) {
      console.error('[feedback] failed:', err && err.message);
      out = { status: 500, body: { error: 'Something went wrong. Please try again later.' } };
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(out.status).json(out.body);
  };
}

module.exports = {
  KINDS,
  AREAS,
  LIMITS,
  validateReport,
  issueTitle,
  issueBody,
  issueLabels,
  matchKnownFixes,
  reportStatus,
  tokenMatches,
  RateLimiter,
  receiveReport,
  lookUpReport,
  handler,
};
