// Packages OpenExtract on this computer, carrying a given OpenExtract AI add-on inside it
// (resources/ai-addon/, as a release carries the pinned one), signed, and notarized when a
// notarytool profile is named. Nothing is published: the installer lands in release-friends/ for
// Charles to test or hand out himself. Two uses:
//  - a test build with an add-on that isn't published yet (a release candidate);
//  - the friends-and-family build, carrying the unrestricted edition (no question limit, no keys).
//
//   npm run python:bundle            (the engine, once per engine change)
//   node scripts/package-friends.mjs --mcpb <openextract-ai-….mcpb> [--notarize openextract-notary] [--version X]
//
// The .mcpb comes from the openextract-ai repository (packaging/build.py, --unrestricted for the
// friends' edition). Its name says its version, edition and computer, and it must be for this
// computer. It's staged in build/ai-addon/, the folder package.json's extraResources carries.
// The app's version defaults to <next patch>-ai.friends, which tells it apart in feedback
// reports, isn't offered the release it's built from, and is offered the next real release like
// everyone else.
//
// --notarize PROFILE: a keychain profile made once with
//   xcrun notarytool store-credentials PROFILE --apple-id <Apple ID> --team-id 6UBFPH2JZ7
// (build/notarize.js uses it as APPLE_KEYCHAIN_PROFILE). Without it the app is signed, not notarized.
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MCPB_NAME } from './write-build-info.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = 'release-friends';

export function nextPatch(version) {
  const [a, b, c] = version.split('.').map(Number);
  return [a, b, c + 1].join('.');
}

/** This computer's add-on, as aiAddon.ts platformKey names it. */
export function hostKey(platform = process.platform, arch = process.arch) {
  if (platform === 'darwin' && arch === 'arm64') return 'mac-arm64';
  if (platform === 'win32' && arch === 'x64') return 'win-x64';
  return null;
}

/** package.json's build, out to release-friends/ (the add-on comes from build/ai-addon/, as in a release). */
export function friendsConfig(build, version) {
  const mac = build.mac ? { ...build.mac, target: ['dmg'] } : undefined;
  return {
    ...build,
    directories: { ...build.directories, output: OUT },
    extraMetadata: { ...build.extraMetadata, version },
    ...(mac ? { mac } : {}),
  };
}

/** build/ai-addon/ holding only `mcpb`; returns the staged copy's path. */
export function stageAddon(mcpb, stageDir = path.join(root, 'build', 'ai-addon')) {
  // Read first: the file may already be in build/ai-addon/ (fetched there by ai-addon-pin.mjs).
  const bytes = fs.readFileSync(mcpb);
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });
  const dest = path.join(stageDir, path.basename(mcpb));
  fs.writeFileSync(dest, bytes);
  return dest;
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const [flag, value] = argv[i].includes('=') ? argv[i].split(/=(.*)/s) : [argv[i], argv[i + 1]];
    if (!['--mcpb', '--notarize', '--version'].includes(flag)) throw new Error(`Unknown argument: ${argv[i]}`);
    if (!value) throw new Error(`${flag} needs a value`);
    out[flag.slice(2)] = value;
    if (!argv[i].includes('=')) i++;
  }
  return out;
}

function run(command, commandArgs, env = process.env) {
  console.log('+', command, commandArgs.join(' '));
  const r = spawnSync(command, commandArgs, { cwd: root, stdio: 'inherit', env, shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${command} ${commandArgs[0] ?? ''} failed (${r.status ?? r.signal})`);
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const opts = args(process.argv.slice(2));
  if (!opts.mcpb) throw new Error('--mcpb <the add-on\'s .mcpb> is needed');
  const mcpb = path.resolve(opts.mcpb);
  const name = path.basename(mcpb);
  const m = MCPB_NAME.exec(name);
  if (!m) throw new Error(`${name} isn't named as openextract-ai's build names the add-on`);
  if (!fs.existsSync(mcpb)) throw new Error(`${mcpb} isn't there`);
  if (m[3] !== hostKey()) throw new Error(`${name} is for ${m[3]}, not this computer (${hostKey() ?? process.platform + '-' + process.arch})`);
  const engine = path.join(root, 'python', 'dist', 'openextract-engine');
  if (!fs.existsSync(engine)) throw new Error('The engine isn\'t built: run `npm run python:bundle` first');

  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf-8'));
  const version = opts.version ?? `${nextPatch(pkg.version)}-ai.friends`;
  console.log(`OpenExtract ${version}, carrying ${name}${m[2] ? " (the unrestricted edition)" : ""}`);

  // A stale tsbuildinfo can make tsc skip writing dist-electron (it's tracked in git): start clean.
  fs.rmSync(path.join(root, 'tsconfig.electron.tsbuildinfo'), { force: true });
  const staged = stageAddon(mcpb);
  const env = { ...process.env, OPENEXTRACT_AI_BUNDLED_MCPB: staged };
  delete env.OPENEXTRACT_AI_INDEX_URL;
  run('npm', ['run', 'build'], env);
  const info = JSON.parse(fs.readFileSync(path.join(root, 'dist-electron', 'build-info.json'), 'utf-8'));
  if (info.aiAddon?.file !== name || info.aiAddon?.sha256 !== sha256(mcpb)) throw new Error('build-info.json doesn\'t carry the add-on');

  const config = path.join(root, OUT, 'electron-builder.friends.json');
  fs.mkdirSync(path.dirname(config), { recursive: true });
  fs.writeFileSync(config, `${JSON.stringify(friendsConfig(pkg.build, version), null, 2)}\n`);
  const builderEnv = { ...env };
  delete builderEnv.APPLE_ID;
  delete builderEnv.APPLE_APP_SPECIFIC_PASSWORD;
  if (opts.notarize) builderEnv.APPLE_KEYCHAIN_PROFILE = opts.notarize;
  else delete builderEnv.APPLE_KEYCHAIN_PROFILE;
  run('npx', ['electron-builder', '--publish', 'never', '--config', config], builderEnv);

  // Check what was built: the add-on inside the app is the one asked for.
  const appDir = fs.readdirSync(path.join(root, OUT)).map(d => path.join(root, OUT, d))
    .find(d => fs.existsSync(path.join(d, 'OpenExtract.app')) || fs.existsSync(path.join(d, 'resources')));
  const resources = process.platform === 'darwin'
    ? path.join(appDir, 'OpenExtract.app', 'Contents', 'Resources')
    : path.join(appDir, 'resources');
  const carried = path.join(resources, 'ai-addon', name);
  if (!fs.existsSync(carried) || sha256(carried) !== sha256(mcpb)) throw new Error(`The app doesn't carry ${name}`);
  const others = fs.readdirSync(path.join(resources, 'ai-addon')).filter(f => f !== name);
  if (others.length) throw new Error(`The app carries other files beside ${name}: ${others.join(', ')}`);
  if (!fs.existsSync(path.join(resources, 'app.asar'))) throw new Error('No app.asar in the app');
  const installers = fs.readdirSync(path.join(root, OUT)).filter(f => /\.(dmg|exe)$/.test(f) && f.includes(version));
  console.log(`\nBuilt ${installers.map(f => path.join(OUT, f)).join(', ')}`);
  console.log(`carrying ${name} (sha256 ${sha256(mcpb)})${opts.notarize ? ', notarized' : ', signed, not notarized'}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
