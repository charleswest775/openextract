// The files a release changes besides the version and the website links, written by release.yml
// so they reach main in the one sync PR instead of a hand-made CHANGELOG commit and a separate
// packaging PR.
//
//   node scripts/release-files.mjs changelog <version> <date>
//     preflight: puts `## [<version>] - <date>` under an empty `## [Unreleased]` in CHANGELOG.md.
//
//   node scripts/release-files.mjs packaging <version> <date> --exe-sha256 <hex> --deb-sha256 <hex>
//     finalize, after publishing: packaging/winget/<version>/ (from the newest earlier folder),
//     the Chocolatey package's version, URL and checksum, the Flatpak manifest's .deb and its
//     checksum, and a <release> in the Flatpak metainfo.
//
// The metainfo's release notes come from the version's CHANGELOG section: its opening paragraph
// when it has one (a plain-words summary written above the ### headings), or else its bullets.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.GITHUB_REPOSITORY || 'charleswest775/openextract';
const V = String.raw`\d+\.\d+\.\d+`;

/** `text` with the one match of `re` replaced; throws if `re` matches no line, or more than one, in `what`. */
function replaceOnce(text, re, replacement, what) {
  const global = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g');
  const count = [...text.matchAll(global)].length;
  if (count !== 1) throw new Error(`${what}: expected one match for ${re}, found ${count}`);
  return text.replace(re, replacement);
}

// ── CHANGELOG.md ────────────────────────────────────────────────────────────

/** CHANGELOG.md with `## [version] - date` under an empty `## [Unreleased]`, and a warning if Unreleased had nothing in it. */
export function datedChangelog(text, version, date) {
  const lines = text.split('\n');
  const at = lines.findIndex(l => /^## \[Unreleased\]\s*$/.test(l));
  if (at < 0) throw new Error('CHANGELOG.md has no "## [Unreleased]" heading');
  if (lines.some(l => l.startsWith(`## [${version}]`))) throw new Error(`CHANGELOG.md already has a "## [${version}]" heading`);
  let next = at + 1;
  while (next < lines.length && lines[next].trim() === '') next++;
  const empty = next >= lines.length || lines[next].startsWith('## ');
  lines.splice(at + 1, next - at - 1, '', `## [${version}] - ${date}`, '');
  const warning = empty ? `CHANGELOG.md has nothing under [Unreleased], so ${version}'s section is empty` : null;
  return { text: lines.join('\n'), warning };
}

/** The body of `## [version]` in CHANGELOG.md, up to the next `## ` heading. */
export function changelogSection(text, version) {
  const lines = text.split('\n');
  const at = lines.findIndex(l => l.startsWith(`## [${version}]`));
  if (at < 0) throw new Error(`CHANGELOG.md has no "## [${version}]" section`);
  const end = lines.findIndex((l, i) => i > at && l.startsWith('## '));
  return lines.slice(at + 1, end < 0 ? undefined : end).join('\n').trim();
}

/** Markdown inline text as plain words: no code ticks, emphasis or link targets, and no trailing issue references. */
export function plainWords(md) {
  const ref = String.raw`(?:[A-Za-z][\w-]*#\d+|#\d+|OE-\d+)`;
  return md
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|\W)[*_]([^*_]+)[*_](?=\W|$)/g, '$1$2')
    .replace(new RegExp(String.raw`\s*\(${ref}(?:,\s*${ref})*\)\s*$`), '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/([^.!?])$/, '$1.');
}

/**
 * What the metainfo says about a release, from its CHANGELOG section: the paragraphs above the
 * first ### heading if there are any, or else every bullet. Bullets that start "Windows:" or
 * "macOS:" are left out, since the metainfo is for the Linux Flatpak.
 */
export function releaseNotes(section) {
  const intro = section.split(/^### /m)[0].trim();
  if (intro) return { paragraphs: intro.split(/\n\s*\n/).map(plainWords).filter(Boolean), bullets: [] };
  const bullets = section
    .split('\n')
    .filter(l => /^\s*- /.test(l))
    .map(l => l.replace(/^\s*- /, ''))
    .filter(l => !/^(Windows|macOS|Mac):/i.test(l))
    .map(plainWords);
  return { paragraphs: [], bullets };
}

// ── Flatpak ─────────────────────────────────────────────────────────────────

const xml = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The metainfo with a <release> for `version` first in <releases>. Unchanged if it has one already. */
export function metainfoWithRelease(text, version, date, notes) {
  if (new RegExp(`<release version="${version.replace(/\./g, '\\.')}"`).test(text)) return text;
  const m = /^(\s*)<releases>\s*$/m.exec(text);
  if (!m) throw new Error('metainfo has no <releases> element');
  const i = m[1];
  const lines = [`${i}  <release version="${version}" date="${date}">`, `${i}    <url type="details">https://github.com/${REPO}/releases/tag/v${version}</url>`];
  if (notes.paragraphs.length || notes.bullets.length) {
    lines.push(`${i}    <description>`);
    for (const p of notes.paragraphs) lines.push(`${i}      <p>${xml(p)}</p>`);
    if (notes.bullets.length) {
      lines.push(`${i}      <ul>`);
      for (const b of notes.bullets) lines.push(`${i}        <li>${xml(b)}</li>`);
      lines.push(`${i}      </ul>`);
    }
    lines.push(`${i}    </description>`);
  }
  lines.push(`${i}  </release>`);
  const at = m.index + m[0].length;
  return text.slice(0, at) + '\n' + lines.join('\n') + text.slice(at);
}

/** The Flatpak manifest with its .deb source pointing at `version`'s .deb and its checksum. */
export function flatpakManifest(text, version, debSha256) {
  const re = new RegExp(String.raw`^(\s*url: https://github\.com/[^/]+/[^/]+/releases/download/)v${V}/openextract_${V}_amd64\.deb(\r?\n\s*sha256: )[0-9a-f]{64}`, 'm');
  return replaceOnce(text, re, `$1v${version}/openextract_${version}_amd64.deb$2${debSha256.toLowerCase()}`, 'Flatpak manifest .deb source');
}

// ── Chocolatey ──────────────────────────────────────────────────────────────

export function chocolateyNuspec(text, version) {
  let out = replaceOnce(text, new RegExp(`<version>${V}</version>`), `<version>${version}</version>`, 'openextract.nuspec <version>');
  out = replaceOnce(out, new RegExp(`(<releaseNotes>[^<]*/releases/tag/)v${V}(</releaseNotes>)`), `$1v${version}$2`, 'openextract.nuspec <releaseNotes>');
  return out;
}

export function chocolateyInstall(text, version, exeSha256) {
  let out = replaceOnce(text, new RegExp(`(url64bit\\s*=\\s*'[^']*/releases/download/)v${V}/OpenExtract-Setup-${V}\\.exe'`), `$1v${version}/OpenExtract-Setup-${version}.exe'`, 'chocolateyinstall.ps1 url64bit');
  out = replaceOnce(out, /(checksum64\s*=\s*')[0-9a-fA-F]{64}'/, `$1${exeSha256.toLowerCase()}'`, 'chocolateyinstall.ps1 checksum64');
  return out;
}

// ── winget ──────────────────────────────────────────────────────────────────

const semver = v => v.split('.').map(Number);
const newer = (a, b) => { const x = semver(a), y = semver(b); for (let k = 0; k < 3; k++) if (x[k] !== y[k]) return x[k] > y[k]; return false; };

/** The three manifests for `version`, made from `from` (file name → text of the newest earlier version's). */
export function wingetManifests(from, version, date, exeSha256) {
  const out = {};
  for (const [name, text] of Object.entries(from)) {
    let t = replaceOnce(text, new RegExp(`^PackageVersion: ${V}\\s*$`, 'm'), `PackageVersion: ${version}`, `${name} PackageVersion`);
    if (name.endsWith('.installer.yaml')) {
      t = replaceOnce(t, /^ReleaseDate: \S+\s*$/m, `ReleaseDate: ${date}`, `${name} ReleaseDate`);
      t = replaceOnce(t, new RegExp(`^(\\s*InstallerUrl: \\S*/releases/download/)v${V}/OpenExtract-Setup-${V}\\.exe\\s*$`, 'm'), `$1v${version}/OpenExtract-Setup-${version}.exe`, `${name} InstallerUrl`);
      t = replaceOnce(t, /^(\s*InstallerSha256: )[0-9A-Fa-f]{64}\s*$/m, `$1${exeSha256.toUpperCase()}`, `${name} InstallerSha256`);
    }
    if (/\.locale\.[^.]+\.yaml$/.test(name)) {
      t = replaceOnce(t, new RegExp(`^(ReleaseNotesUrl: \\S*/releases/tag/)v${V}\\s*$`, 'm'), `$1v${version}`, `${name} ReleaseNotesUrl`);
    }
    out[name] = t;
  }
  return out;
}

// ── Writing the files ───────────────────────────────────────────────────────

const read = (root, rel) => fs.readFileSync(path.join(root, rel), 'utf8');
const write = (root, rel, text) => fs.writeFileSync(path.join(root, rel), text);

export function writeChangelog(root, version, date) {
  const { text, warning } = datedChangelog(read(root, 'CHANGELOG.md'), version, date);
  write(root, 'CHANGELOG.md', text);
  return warning;
}

export function writePackaging(root, { version, date, exeSha256, debSha256 }) {
  const written = [];
  const wingetDir = path.join(root, 'packaging/winget');
  const earlier = fs.readdirSync(wingetDir).filter(d => new RegExp(`^${V}$`).test(d) && newer(version, d));
  if (earlier.length === 0) throw new Error(`packaging/winget has no folder older than ${version} to start from`);
  const base = earlier.reduce((a, b) => (newer(b, a) ? b : a));
  const from = Object.fromEntries(fs.readdirSync(path.join(wingetDir, base)).filter(f => f.endsWith('.yaml')).map(f => [f, read(root, `packaging/winget/${base}/${f}`)]));
  fs.mkdirSync(path.join(wingetDir, version), { recursive: true });
  for (const [name, text] of Object.entries(wingetManifests(from, version, date, exeSha256))) {
    write(root, `packaging/winget/${version}/${name}`, text);
    written.push(`packaging/winget/${version}/${name}`);
  }

  const edits = {
    'packaging/chocolatey/openextract.nuspec': t => chocolateyNuspec(t, version),
    'packaging/chocolatey/tools/chocolateyinstall.ps1': t => chocolateyInstall(t, version, exeSha256),
    'packaging/flathub/app.openextract.OpenExtract.yml': t => flatpakManifest(t, version, debSha256),
    'packaging/flathub/app.openextract.OpenExtract.metainfo.xml': t => metainfoWithRelease(t, version, date, releaseNotes(changelogSection(read(root, 'CHANGELOG.md'), version))),
  };
  for (const [rel, edit] of Object.entries(edits)) {
    write(root, rel, edit(read(root, rel)));
    written.push(rel);
  }
  return written;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, version, date, ...rest] = process.argv.slice(2);
  const flag = name => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
  const usage = () => {
    console.error('Usage: node scripts/release-files.mjs changelog <version> <date>');
    console.error('       node scripts/release-files.mjs packaging <version> <date> --exe-sha256 <hex> --deb-sha256 <hex>');
    process.exit(2);
  };
  if (!/^\d+\.\d+\.\d+$/.test(version || '') || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) usage();
  if (command === 'changelog') {
    const warning = writeChangelog(ROOT, version, date);
    if (warning) console.log(`::warning::${warning}`);
    console.log(`CHANGELOG.md: ## [${version}] - ${date}`);
  } else if (command === 'packaging') {
    const exeSha256 = flag('--exe-sha256');
    const debSha256 = flag('--deb-sha256');
    if (!/^[0-9a-f]{64}$/i.test(exeSha256 || '') || !/^[0-9a-f]{64}$/i.test(debSha256 || '')) usage();
    for (const file of writePackaging(ROOT, { version, date, exeSha256, debSha256 })) console.log(`wrote ${file}`);
  } else {
    usage();
  }
}
