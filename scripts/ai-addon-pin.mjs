// The OpenExtract AI add-on that OpenExtract's Mac and Windows builds carry, so Ask AI's Install
// needs no download. ai-addon.json (at the top of the repository) pins it: the add-on's version and,
// for each computer, the .mcpb's name, size and SHA-256, as published on
// github.com/charleswest775/openextract-ai-releases. The add-on itself is built in the private
// openextract-ai repository (its packaging/build.py); only the published files are used here.
//
//   node scripts/ai-addon-pin.mjs fetch [--platform mac-arm64|win-x64] [--from <a local .mcpb>]
//     Puts this computer's pinned .mcpb in build/ai-addon/ (emptied first), checked against the
//     pin, and prints its path: give it to the build as OPENEXTRACT_AI_BUNDLED_MCPB. With --from,
//     a local copy (the same file, checked the same way) instead of the download.
//
//   node scripts/ai-addon-pin.mjs check <the packaged app's resources folder>
//     After electron-builder: the app carries the pinned file, and build-info.json names it.
//
// package.json's build.extraResources copies build/ai-addon/*.mcpb into the app's
// resources/ai-addon/; with no file there (Linux, a developer's build) the app carries nothing and
// Ask AI stays off. To move the pin: RELEASING.md, "OpenExtract AI".
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MCPB_NAME } from './write-build-info.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PIN_FILE = path.join(root, 'ai-addon.json');
export const STAGE_DIR = path.join(root, 'build', 'ai-addon');
export const PLATFORMS = ['mac-arm64', 'win-x64'];
const RELEASES = 'https://github.com/charleswest775/openextract-ai-releases/releases/download/';

/** This computer's add-on, as electron/aiAddon.ts platformKey names it (null: none is made for it). */
export function hostKey(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win-x64';
  return null;
}

/** ai-addon.json, checked field by field: { version, files: { [platform]: { file, size, sha256, url } } }. */
export function parsePin(json) {
  const problems = [];
  const version = json?.version;
  if (typeof version !== 'string' || !/^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(version)) problems.push(`version must look like 0.3.0, not ${JSON.stringify(version)}`);
  const files = {};
  for (const key of PLATFORMS) {
    const entry = json?.files?.[key];
    const m = MCPB_NAME.exec(entry?.file ?? '');
    if (!m) {
      problems.push(`files.${key}.file must be openextract-ai-<version>-${key}.mcpb`);
      continue;
    }
    if (m[2]) problems.push(`files.${key}: a release carries the usual add-on, not the unrestricted edition`);
    if (m[1] !== version || m[3] !== key) problems.push(`files.${key}.file (${entry.file}) is not version ${version} for ${key}`);
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0) problems.push(`files.${key}.size must be the file's size in bytes`);
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(entry.sha256)) problems.push(`files.${key}.sha256 must be 64 lowercase hex digits`);
    files[key] = { file: entry.file, size: entry.size, sha256: entry.sha256, url: `${RELEASES}v${version}/${entry.file}` };
  }
  if (problems.length) throw new Error(`ai-addon.json: ${problems.join('; ')}`);
  return { version, files };
}

export function readPin(file = PIN_FILE) {
  return parsePin(JSON.parse(fs.readFileSync(file, 'utf-8')));
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

/** The bytes are the pinned file's, or an error saying how they differ. */
export function checkBytes(bytes, entry, where) {
  if (bytes.length !== entry.size) throw new Error(`${where} is ${bytes.length} bytes, not the pinned ${entry.size}`);
  const got = sha256(bytes);
  if (got !== entry.sha256) throw new Error(`${where}'s SHA-256 is ${got}, not the pinned ${entry.sha256}`);
}

async function download(url, { attempts = 3 } = {}) {
  let last;
  for (let i = 1; i <= attempts; i++) {
    try {
      const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(300_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      last = err;
      if (i < attempts) await new Promise(r => setTimeout(r, 5000 * i));
    }
  }
  throw new Error(`Couldn't download ${url} (${last?.message ?? last}). Is OpenExtract AI ${path.basename(path.dirname(url))} published on openextract-ai-releases?`);
}

/** build/ai-addon/<file>, emptied first, from the download or a local copy; returns its path. */
export async function fetchPinned({ platform = hostKey(), from = null, pin = readPin(), stageDir = STAGE_DIR, get = download } = {}) {
  if (!platform || !pin.files[platform]) throw new Error(`No add-on is made for ${platform ?? `${process.platform}-${process.arch}`}`);
  const entry = pin.files[platform];
  const bytes = from ? fs.readFileSync(from) : await get(entry.url);
  checkBytes(bytes, entry, from ?? entry.url);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  const dest = path.join(stageDir, entry.file);
  fs.writeFileSync(dest, bytes);
  return dest;
}

/** The packaged app carries exactly the pinned file, and its build-info.json names it. */
export function checkCarried(resourcesDir, { pin = readPin(), buildInfo } = {}) {
  const dir = path.join(resourcesDir, 'ai-addon');
  const names = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  const entry = Object.values(pin.files).find(e => names.includes(e.file));
  if (!entry || names.length !== 1) throw new Error(`${dir} should hold one pinned .mcpb, but holds ${JSON.stringify(names)}`);
  checkBytes(fs.readFileSync(path.join(dir, entry.file)), entry, path.join(dir, entry.file));
  const info = buildInfo ?? JSON.parse(fs.readFileSync(path.join(root, 'dist-electron', 'build-info.json'), 'utf-8'));
  if (info.aiAddon?.file !== entry.file || info.aiAddon?.sha256 !== entry.sha256 || info.aiAddon?.size !== entry.size) {
    throw new Error(`build-info.json's aiAddon (${JSON.stringify(info.aiAddon)}) doesn't name ${entry.file}`);
  }
  return entry;
}

function option(argv, name) {
  const i = argv.indexOf(name);
  if (i === -1) return null;
  if (!argv[i + 1]) throw new Error(`${name} needs a value`);
  return argv[i + 1];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2);
  try {
    if (command === 'fetch') {
      const dest = await fetchPinned({ platform: option(rest, '--platform') ?? hostKey(), from: option(rest, '--from') });
      console.log(dest);
    } else if (command === 'check' && rest[0]) {
      const entry = checkCarried(rest[0]);
      console.log(`The app carries ${entry.file} (sha256 ${entry.sha256})`);
    } else {
      throw new Error('Usage: ai-addon-pin.mjs fetch [--platform mac-arm64|win-x64] [--from <file>] | check <resources folder>');
    }
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
