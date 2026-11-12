'use strict';

// The thank-you quotes shown on openextract.app ("What people say", the home page and the
// iMazing pages). They come from the private feedback repo: a thank-you from the app's
// Say thanks form is an issue labelled `thanks`. One appears on the site only when it has
// all three of:
//   - `thanks`       it came from the Say thanks form (api/_lib/feedback.js files it)
//   - `ok-to-quote`  the sender ticked "OK to quote what I wrote on openextract.app, without my name"
//   - `published`    the quote review in the feedback repo (or the developer, by hand) approved it
// Removing `published` takes a quote down; the site catches up within CACHE_SECONDS.
//
// Only the sender's own words, the part of the app and the day go out. Never the email
// address, the OE number or anything else from the issue.
//
// Uses the same GITHUB_FEEDBACK_TOKEN as the feedback form (Issues: read is enough here).

const DEFAULT_REPO = 'charleswest775/openextract-feedback';
const REQUIRED_LABELS = ['thanks', 'ok-to-quote', 'published'];
const NO_MESSAGE = '_No message, just a thank-you._';
// The headings issueBody() in feedback.js writes after the message. The message ends at
// whichever comes first. Same rule as scripts/save-thanks.cjs in the feedback repo.
const AFTER_MESSAGE = ['### OK to quote on openextract.app', '### Diagnostics', '### Reply to'];
const MAX_PAGES = 10; // 1,000 thank-yous; past that the count is "at least".
const CACHE_SECONDS = 600;

function labelNames(issue) {
  return (issue.labels || []).map(l => (typeof l === 'string' ? l : l?.name || ''));
}

/** The section of an issue body that starts at `heading`, up to the first of `endings`. */
function section(body, heading, endings) {
  const start = body.indexOf(`${heading}\n`);
  if (start < 0) return null;
  const from = start + heading.length + 1;
  let to = body.length;
  for (const end of endings) {
    const i = body.indexOf(`\n${end}`, from);
    if (i >= 0 && i < to) to = i;
  }
  return body.slice(from, to).trim();
}

/** What the sender wrote, or '' when they sent a thank-you without words. */
function thanksMessage(issue) {
  const body = String(issue.body || '').replace(/\r\n/g, '\n');
  const message = section(body, '### What happened?', AFTER_MESSAGE) || '';
  return message === NO_MESSAGE ? '' : message;
}

/** The part of the app the thank-you was sent from, e.g. "Photos". */
function thanksArea(issue) {
  const body = String(issue.body || '').replace(/\r\n/g, '\n');
  return (
    section(body, '### Part of the app', ['### '])?.split('\n')[0].trim() ||
    String(issue.title || '').match(/^\[Thanks\]\s*([^:]+)/)?.[1].trim() ||
    ''
  );
}

/** The public form of one issue, or null when it mustn't appear on the site. */
function quoteFromIssue(issue) {
  if (!issue || issue.pull_request) return null;
  const labels = labelNames(issue);
  if (!REQUIRED_LABELS.every(l => labels.includes(l))) return null;
  const text = thanksMessage(issue);
  if (!text) return null;
  return { text, area: thanksArea(issue), date: String(issue.created_at || '').slice(0, 10) };
}

async function listThanks(env, fetchFn) {
  const repo = env.FEEDBACK_REPO || DEFAULT_REPO;
  const issues = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await fetchFn(
      `https://api.github.com/repos/${repo}/issues?labels=thanks&state=all&sort=created&direction=desc&per_page=100&page=${page}`,
      {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${env.GITHUB_FEEDBACK_TOKEN}`,
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'openextract-thanks',
        },
      },
    );
    if (!res.ok) throw new Error(`GitHub answered ${res.status} when listing thank-yous`);
    const batch = await res.json();
    issues.push(...batch);
    if (batch.length < 100) break;
  }
  return issues.filter(i => !i.pull_request);
}

/** GET /api/thanks: { thanks: how many thank-yous so far, quotes: the published ones, newest first }. */
async function getQuotes(req, env, fetchFn) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return { status: 405, body: { error: 'Use GET.' } };
  if (!env.GITHUB_FEEDBACK_TOKEN) return { status: 503, body: { error: 'Not set up.' } };
  const issues = await listThanks(env, fetchFn);
  const quotes = issues
    .map(quoteFromIssue)
    .filter(Boolean)
    .sort((a, b) => (b.date > a.date) - (b.date < a.date));
  return { status: 200, body: { thanks: issues.length, quotes } };
}

/** Vercel Node handler. Answers are cached at the edge, so GitHub sees a few calls an hour at most. */
function handler(req, res) {
  return getQuotes({ method: req.method }, process.env, fetch)
    .catch(err => {
      console.error('[thanks] failed:', err && err.message);
      return { status: 502, body: { error: 'Try again later.' } };
    })
    .then(out => {
      res.setHeader(
        'Cache-Control',
        out.status === 200 ? `public, max-age=0, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=86400` : 'no-store',
      );
      res.status(out.status).json(out.body);
    });
}

module.exports = { quoteFromIssue, thanksMessage, thanksArea, getQuotes, handler, REQUIRED_LABELS, CACHE_SECONDS };
