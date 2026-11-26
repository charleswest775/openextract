// Writes dist-electron/build-info.json: what this build of the app is built with, read by the
// packaged app's main process (electron/aiAddon.ts aiIndexUrl), the way the engine's
// build_info.json is written before PyInstaller runs (python/build_info.py). `npm run
// build:electron` runs it after tsc, and package.json's build.files packs it.
//
// It holds one thing for now: OPENEXTRACT_AI_INDEX_URL, the OpenExtract AI add-on's
// index.json. Only a build made with it set has the Ask AI screen; every public release is
// built without it, and the file then says null. It's written either way, so a file left
// over from an earlier build can't switch Ask AI on.
//
//   OPENEXTRACT_AI_INDEX_URL=https://…/index.json npm run build && npx electron-builder
//
// --out <folder> writes it somewhere else (the tests).
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The same rule as isAllowedUrl in electron/aiAddon.ts: https, or http to this computer. */
export function allowedIndexUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password) return false;
  return url.protocol === 'https:' || (url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
}

export function buildInfo(env = process.env) {
  const url = (env.OPENEXTRACT_AI_INDEX_URL ?? '').trim();
  if (url && !allowedIndexUrl(url)) {
    throw new Error(`OPENEXTRACT_AI_INDEX_URL must be an https:// address (or http:// to this computer for testing), not "${url}".`);
  }
  return { aiIndexUrl: url || null };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--out');
  const outDir = at > 0 ? path.resolve(process.argv[at + 1]) : path.join(root, 'dist-electron');
  let info;
  try {
    info = buildInfo();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'build-info.json'), `${JSON.stringify(info, null, 2)}\n`);
  console.log(info.aiIndexUrl ? `build-info.json: Ask AI on (${info.aiIndexUrl})` : 'build-info.json: Ask AI off');
}
