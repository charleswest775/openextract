// Tests for scripts/release-files.mjs: the CHANGELOG heading release.yml's preflight adds, and the
// winget, Chocolatey and Flatpak files its finalize job writes for the sync PR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  changelogSection, chocolateyNuspec, datedChangelog, flatpakManifest, metainfoWithRelease, plainWords, releaseNotes, wingetManifests, writePackaging,
} from './release-files.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXE = 'ab'.repeat(32);
const DEB = 'cd'.repeat(32);

const CHANGELOG = `# Changelog

Intro text.

## [Unreleased]

### Fixed
- Something broke and now it doesn't (OE-60)

## [0.15.1] - 2026-11-13

### Fixed
- An older fix
`;

test('the release gets its heading under an empty Unreleased, and its notes move with it', () => {
  const { text, warning } = datedChangelog(CHANGELOG, '0.15.2', '2026-11-14');
  assert.equal(warning, null);
  assert.equal(text, CHANGELOG.replace('## [Unreleased]\n\n', '## [Unreleased]\n\n## [0.15.2] - 2026-11-14\n\n'));
  assert.equal(changelogSection(text, '0.15.2'), '### Fixed\n- Something broke and now it doesn\'t (OE-60)');
  assert.equal(changelogSection(text, '0.15.1'), '### Fixed\n- An older fix');
});

test('an empty Unreleased still gets the heading, with a warning', () => {
  const empty = CHANGELOG.replace(/## \[Unreleased\]\n\n### Fixed\n.*\n/, '## [Unreleased]\n');
  const { text, warning } = datedChangelog(empty, '0.15.2', '2026-11-14');
  assert.match(warning, /nothing under \[Unreleased\]/);
  assert.match(text, /## \[Unreleased\]\n\n## \[0\.15\.2\] - 2026-11-14\n\n## \[0\.15\.1\]/);
});

test('a version already in the changelog, or a changelog without Unreleased, is refused', () => {
  assert.throws(() => datedChangelog(CHANGELOG, '0.15.1', '2026-11-14'), /already has a "## \[0\.15\.1\]"/);
  assert.throws(() => datedChangelog('# Changelog\n', '0.15.2', '2026-11-14'), /no "## \[Unreleased\]"/);
});

test('release notes: the opening paragraph when there is one, else the bullets in plain words', () => {
  const withIntro = 'Backing up works again.\nIt stopped in 0.15.0.\n\nSecond paragraph.\n\n### Fixed\n- Details';
  assert.deepEqual(releaseNotes(withIntro), { paragraphs: ['Backing up works again. It stopped in 0.15.0.', 'Second paragraph.'], bullets: [] });

  const bulletsOnly = [
    '### Added',
    '- Podcasts: a section for `podcasts`, contributed by gbaudic (ios-backup-core#25)',
    '### Changed',
    '- Windows: the updater downloads `OpenExtract-Update-X.Y.Z.exe`',
    '### Fixed',
    '- A [moved](https://example.com) backup says so (OE-40, OE-41)',
  ].join('\n');
  assert.deepEqual(releaseNotes(bulletsOnly), {
    paragraphs: [],
    bullets: ['Podcasts: a section for podcasts, contributed by gbaudic.', 'A moved backup says so.'],
  });
  assert.equal(plainWords('Saves **bold** and _quiet_ text (#12)'), 'Saves bold and quiet text.');
});

test('the metainfo gets one <release> first, escaped, and is left alone the second time', () => {
  const meta = '<component>\n  <releases>\n    <release version="0.15.1" date="2026-11-13"/>\n  </releases>\n</component>\n';
  const once = metainfoWithRelease(meta, '0.15.2', '2026-11-14', { paragraphs: ['Faster & "better" <now>.'], bullets: [] });
  assert.equal(once, meta.replace('  <releases>\n', [
    '  <releases>',
    '    <release version="0.15.2" date="2026-11-14">',
    '      <url type="details">https://github.com/charleswest775/openextract/releases/tag/v0.15.2</url>',
    '      <description>',
    '        <p>Faster &amp; &quot;better&quot; &lt;now&gt;.</p>',
    '      </description>',
    '    </release>',
    '',
  ].join('\n')));
  assert.equal(metainfoWithRelease(once, '0.15.2', '2026-11-14', { paragraphs: ['Other'], bullets: [] }), once);
  const list = metainfoWithRelease(meta, '0.15.2', '2026-11-14', { paragraphs: [], bullets: ['One.', 'Two.'] });
  assert.match(list, /\n {8}<ul>\n {10}<li>One\.<\/li>\n {10}<li>Two\.<\/li>\n {8}<\/ul>\n/);
});

test('files with Windows line endings keep them', () => {
  const crlf = s => s.replace(/\n/g, '\r\n');
  const changelog = datedChangelog(crlf(CHANGELOG), '0.15.2', '2026-11-14').text;
  assert.equal(changelog, crlf(datedChangelog(CHANGELOG, '0.15.2', '2026-11-14').text));
  assert.equal(changelogSection(changelog, '0.15.2'), '### Fixed\n- Something broke and now it doesn\'t (OE-60)');

  const meta = '<component>\n  <releases>\n    <release version="0.15.1" date="2026-11-13"/>\n  </releases>\n</component>\n';
  const notes = { paragraphs: ['New.'], bullets: ['One.'] };
  assert.equal(metainfoWithRelease(crlf(meta), '0.15.2', '2026-11-14', notes), crlf(metainfoWithRelease(meta, '0.15.2', '2026-11-14', notes)));

  const installer = 'PackageIdentifier: OpenExtract.OpenExtract\nPackageVersion: 0.15.1\nReleaseDate: 2026-11-13\nInstallers:\n  - Architecture: x64\n    InstallerUrl: https://github.com/charleswest775/openextract/releases/download/v0.15.1/OpenExtract-Setup-0.15.1.exe\n    InstallerSha256: ' + 'EF'.repeat(32) + '\nManifestType: installer\n';
  const name = 'OpenExtract.OpenExtract.installer.yaml';
  const lf = wingetManifests({ [name]: installer }, '0.15.2', '2026-11-14', EXE)[name];
  assert.equal(wingetManifests({ [name]: crlf(installer) }, '0.15.2', '2026-11-14', EXE)[name], crlf(lf));
  assert.match(lf, /^PackageVersion: 0\.15\.2\nReleaseDate: 2026-11-14\n/m);

  const manifest = '      - type: file\n        url: https://github.com/charleswest775/openextract/releases/download/v0.15.1/openextract_0.15.1_amd64.deb\n        sha256: ' + 'ef'.repeat(32) + '\n        dest-filename: openextract.deb\n';
  assert.equal(flatpakManifest(crlf(manifest), '0.15.2', DEB), crlf(flatpakManifest(manifest, '0.15.2', DEB)));
});

test('a file that no longer looks as expected is an error, not a silent no-op', () => {
  assert.throws(() => chocolateyNuspec('<package><version>1.0</version></package>', '0.15.2'), /openextract\.nuspec <version>: expected one match/);
  assert.throws(() => flatpakManifest('modules: []\n', '0.15.2', DEB), /Flatpak manifest \.deb source/);
});

test('the packaging files for a new version, from the repository\'s own', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-files-'));
  try {
    fs.cpSync(path.join(ROOT, 'packaging'), path.join(dir, 'packaging'), { recursive: true });
    const current = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
    const [major, minor, patch] = current.split('.').map(Number);
    const next = `${major}.${minor}.${patch + 1}`;
    // On Windows the checkout's CHANGELOG has CRLF line endings, so match either.
    const dated = datedChangelog(fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8'), next, '2027-01-02').text;
    const heading = new RegExp(`(## \\[${next.replace(/\./g, '\\.')}\\] - 2027-01-02)(\\r?\\n)\\2`);
    assert.match(dated, heading);
    const changelog = dated.replace(heading, '$1$2$2A plain-words summary.$2$2');
    fs.writeFileSync(path.join(dir, 'CHANGELOG.md'), changelog);

    const written = writePackaging(dir, { version: next, date: '2027-01-02', exeSha256: EXE, debSha256: DEB });
    assert.equal(written.length, 7);
    const read = rel => fs.readFileSync(path.join(dir, rel), 'utf8');
    const installer = read(`packaging/winget/${next}/OpenExtract.OpenExtract.installer.yaml`);
    assert.match(installer, new RegExp(`^PackageVersion: ${next}$`, 'm'));
    assert.match(installer, /^ReleaseDate: 2027-01-02$/m);
    assert.match(installer, new RegExp(`InstallerUrl: https://github\\.com/charleswest775/openextract/releases/download/v${next}/OpenExtract-Setup-${next}\\.exe$`, 'm'));
    assert.match(installer, new RegExp(`InstallerSha256: ${EXE.toUpperCase()}$`, 'm'));
    assert.match(read(`packaging/winget/${next}/OpenExtract.OpenExtract.locale.en-US.yaml`), new RegExp(`ReleaseNotesUrl: \\S+/tag/v${next}$`, 'm'));
    assert.match(read(`packaging/winget/${next}/OpenExtract.OpenExtract.yaml`), new RegExp(`^PackageVersion: ${next}$`, 'm'));
    assert.match(read('packaging/chocolatey/openextract.nuspec'), new RegExp(`<version>${next}</version>[\\s\\S]*/tag/v${next}</releaseNotes>`));
    assert.match(read('packaging/chocolatey/tools/chocolateyinstall.ps1'), new RegExp(`/v${next}/OpenExtract-Setup-${next}\\.exe'[\\s\\S]*checksum64\\s*= '${EXE}'`));
    assert.match(read('packaging/flathub/app.openextract.OpenExtract.yml'), new RegExp(`/v${next}/openextract_${next}_amd64\\.deb\\r?\\n\\s*sha256: ${DEB}`));
    assert.match(read('packaging/flathub/app.openextract.OpenExtract.metainfo.xml'), new RegExp(`<releases>\\r?\\n {4}<release version="${next.replace(/\./g, '\\.')}" date="2027-01-02">[\\s\\S]*?<p>A plain-words summary\\.</p>`));
    // Everything else in the folder is as it was.
    for (const rel of ['packaging/README.md', 'packaging/flathub/flathub.json', 'packaging/flathub/app.openextract.OpenExtract.desktop']) {
      assert.equal(read(rel), fs.readFileSync(path.join(ROOT, rel), 'utf8'), rel);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
