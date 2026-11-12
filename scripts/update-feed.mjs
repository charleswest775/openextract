// Gives Windows updates their own copy of the installer. GitHub counts each release file's
// downloads, and the app's updater fetched the same OpenExtract-Setup-<v>.exe that people download
// from the website, winget and Chocolatey, so a new install and an update counted the same. Now
// latest.yml (what the updater reads) names OpenExtract-Update-<v>.exe, a byte-for-byte copy:
// its sha512 and size are unchanged, and only the name differs.
//
// The updater also fetches <installer>.blockmap, so the blockmap is copied too. On the first update
// from a version released before this change, electron-updater finds no OpenExtract-Update blockmap
// for the old version, unless it kept one from its own last update, so that update downloads the
// whole installer instead of the changed parts. After that, every release has one.
//
// Usage: node scripts/update-feed.mjs <release dir> <version>
// Run after electron-builder, then upload the copy, its blockmap and the rewritten latest.yml.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

export const setupName = (version) => `OpenExtract-Setup-${version}.exe`;
export const updateName = (version) => `OpenExtract-Update-${version}.exe`;

/** latest.yml with every `url:` and `path:` naming `from` changed to `to`. Throws if a field doesn't name it. */
export function pointFeedAt(yml, from, to) {
  const lines = yml.split('\n');
  let urls = 0;
  let paths = 0;
  const out = lines.map((line) => {
    const m = /^(\s*(?:- )?)(url|path): (.*?)(\r?)$/.exec(line);
    if (!m) return line;
    const [, lead, key, value, cr] = m;
    if (value !== from) throw new Error(`latest.yml ${key} is ${value}, not ${from}`);
    if (key === 'url') urls++;
    else paths++;
    return `${lead}${key}: ${to}${cr}`;
  });
  if (urls !== 1 || paths !== 1) throw new Error(`latest.yml should name one installer, in one url and one path (found ${urls} and ${paths})`);
  return out.join('\n');
}

export function giveUpdatesTheirOwnCopy(dir, version) {
  // electron-builder names the file with spaces; GitHub (and latest.yml) with dashes.
  const built = path.join(dir, `OpenExtract Setup ${version}.exe`);
  const copy = path.join(dir, updateName(version));
  fs.copyFileSync(built, copy);
  fs.copyFileSync(`${built}.blockmap`, `${copy}.blockmap`);
  const feed = path.join(dir, 'latest.yml');
  fs.writeFileSync(feed, pointFeedAt(fs.readFileSync(feed, 'utf8'), setupName(version), updateName(version)));
  return [copy, `${copy}.blockmap`, feed];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, version] = process.argv.slice(2);
  if (!dir || !/^\d+\.\d+\.\d+$/.test(version || '')) {
    console.error('Usage: node scripts/update-feed.mjs <release dir> <version>');
    process.exit(2);
  }
  for (const file of giveUpdatesTheirOwnCopy(dir, version)) console.log(`wrote ${file}`);
}
