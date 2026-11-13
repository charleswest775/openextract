'use strict';

// openextract.app's download links (/download/<platform>/file, which vercel.json rewrites to
// /api/download) and the home page's version label (/api/latest) follow the newest published
// release on their own. The site switches within a couple of minutes of a release being
// published, without waiting for the release's sync PR to merge.
//
// The newest release comes from github.com/<repo>/releases/latest, which redirects to that
// release's tag page. It's a plain page redirect, not the GitHub API, so it needs no token and
// isn't held to the API's 60-an-hour limit for callers without one (a limit shared by every
// site on Vercel's addresses). Answers are cached at the edge for CACHE_SECONDS. If GitHub
// can't be reached, a download link goes to the release page instead, where every file is.
//
// FILES must match the names electron-builder uploads. Before publishing, release.yml checks
// every one against the draft's files: `node website/static/api/_lib/download.js <version>`
// prints one "<platform> <file>" line per platform.

const REPO = 'charleswest775/openextract';
const RELEASES = `https://github.com/${REPO}/releases`;
const CACHE_SECONDS = 60;

const FILES = {
  mac: version => `OpenExtract-${version}-arm64.dmg`,
  windows: version => `OpenExtract-Setup-${version}.exe`,
  linux: version => `openextract_${version}_amd64.deb`,
  'linux-appimage': version => `OpenExtract-${version}.AppImage`,
};

/** The file a platform's download link gives for a version, or null for an unknown platform. */
function fileName(platform, version) {
  return Object.hasOwn(FILES, platform) ? FILES[platform](version) : null;
}

function fileUrl(platform, version) {
  return `${RELEASES}/download/v${version}/${fileName(platform, version)}`;
}

/** The version in a release's tag page address (…/releases/tag/v0.15.1), or null. */
function versionFromTagUrl(url) {
  const match = /\/releases\/tag\/v(\d+\.\d+\.\d+)$/.exec(String(url || ''));
  return match ? match[1] : null;
}

/** The newest published release's version, from where /releases/latest redirects. */
async function latestVersion(fetchFn) {
  const res = await fetchFn(`${RELEASES}/latest`, {
    method: 'HEAD',
    redirect: 'manual',
    headers: { 'User-Agent': 'openextract-download' },
  });
  const location = res.headers.get('location');
  const version = versionFromTagUrl(location);
  if (!version) throw new Error(`GitHub answered ${res.status} for the latest release, not a release tag (${location})`);
  return version;
}

const CACHED = `public, max-age=0, s-maxage=${CACHE_SECONDS}, stale-while-revalidate=300`;

/** GET /api/download?platform=windows: a redirect to the newest release's file for that platform. */
async function download(req, fetchFn, log = console) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return { status: 405, headers: { 'Cache-Control': 'no-store' }, body: 'Use GET.' };
  }
  const platform = req.query.platform;
  if (!fileName(platform, '0.0.0')) {
    return { status: 404, headers: { 'Cache-Control': 'no-store' }, body: 'No download for that platform.' };
  }
  try {
    const version = await latestVersion(fetchFn);
    return { status: 302, headers: { Location: fileUrl(platform, version), 'Cache-Control': CACHED } };
  } catch (err) {
    log.error('[download] falling back to the release page:', err && err.message);
    return { status: 302, headers: { Location: `${RELEASES}/latest`, 'Cache-Control': 'no-store' } };
  }
}

/** GET /api/latest: { version } of the newest published release. */
async function latest(req, fetchFn, log = console) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return { status: 405, headers: { 'Cache-Control': 'no-store' }, body: { error: 'Use GET.' } };
  }
  try {
    const version = await latestVersion(fetchFn);
    return { status: 200, headers: { 'Cache-Control': CACHED }, body: { version } };
  } catch (err) {
    log.error('[latest] failed:', err && err.message);
    return { status: 502, headers: { 'Cache-Control': 'no-store' }, body: { error: 'Try again later.' } };
  }
}

/** The request's query: Vercel's parsed req.query (which has a rewrite's parameters), else req.url's. */
function queryOf(req) {
  const query = Object.fromEntries(new URL(req.url || '/', 'http://localhost').searchParams);
  for (const [name, value] of Object.entries(req.query || {})) query[name] = Array.isArray(value) ? value[0] : value;
  return query;
}

/** Wraps one of the above as a Vercel Node handler. */
function handler(answer) {
  return async (req, res) => {
    const out = await answer({ method: req.method, query: queryOf(req) }, fetch);
    for (const [name, value] of Object.entries(out.headers || {})) res.setHeader(name, value);
    res.statusCode = out.status;
    if (out.body === undefined || req.method === 'HEAD') return res.end();
    if (typeof out.body === 'string') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.end(out.body);
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify(out.body));
  };
}

module.exports = { FILES, fileName, fileUrl, versionFromTagUrl, latestVersion, download, latest, queryOf, handler };

if (require.main === module) {
  const version = process.argv[2];
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) {
    console.error('Usage: node website/static/api/_lib/download.js <version>');
    process.exit(2);
  }
  for (const platform of Object.keys(FILES)) console.log(`${platform} ${fileName(platform, version)}`);
}
