// electron-builder's afterSign hook (package.json build.afterSign). Sends the signed app to
// Apple's notary service, waits for the verdict, and staples the ticket to the .app before
// electron-builder builds the dmg and zip from it. With the ticket stapled, Gatekeeper
// accepts the app on first launch without asking Apple, so it opens offline too.
//
// Any failure fails the build, which keeps the release a draft: a rejection (the notary
// log is printed), no verdict within the timeout, or a ticket that won't staple. A 403
// saying an agreement is missing means the account holder must accept Apple's latest
// Developer Program agreement at https://developer.apple.com/account.
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

// The release's build-macos job allows 90 minutes in all; notarizing usually takes a few.
const WAIT = '45m';

function run(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw r.error;
  return r;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = async function notarize(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    const missing = 'APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD and APPLE_TEAM_ID are needed to notarize';
    // A release must be notarized; a local build with a signing identity needn't be.
    if (process.env.CI) throw new Error(missing);
    console.log(`Skipping notarization: ${missing}`);
    return;
  }
  const auth = ['--apple-id', APPLE_ID, '--password', APPLE_APP_SPECIFIC_PASSWORD, '--team-id', APPLE_TEAM_ID];

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'notarize-'));
  try {
    const zip = path.join(tmp, 'OpenExtract.zip');
    const z = run('ditto', ['-c', '-k', '--keepParent', appPath, zip]);
    if (z.status !== 0) throw new Error(`ditto couldn't zip the app for notarizing: ${z.stderr}`);

    console.log(`Notarizing ${appPath} (waiting up to ${WAIT} for Apple)`);
    const t0 = Date.now();
    const s = run('xcrun', ['notarytool', 'submit', zip, '--wait', '--timeout', WAIT, '--output-format', 'json', ...auth]);
    // With --output-format json, notarytool prints one JSON object when it's done.
    let result = null;
    try {
      result = JSON.parse(s.stdout.slice(s.stdout.indexOf('{'), s.stdout.lastIndexOf('}') + 1));
    } catch {}
    const minutes = ((Date.now() - t0) / 60000).toFixed(1);
    console.log(`notarytool exited with ${s.status} after ${minutes} min: ${s.stdout.trim()}`);
    if (s.stderr.trim()) console.log(s.stderr.trim());

    if (result?.status !== 'Accepted') {
      if (result?.id) {
        const log = run('xcrun', ['notarytool', 'log', result.id, ...auth]);
        console.log(`Notary log for ${result.id}:\n${log.stdout || log.stderr}`);
      }
      const hint = /agreement/i.test(s.stdout + s.stderr)
        ? ' Apple wants the account holder to accept the latest Developer Program agreement at https://developer.apple.com/account.'
        : result?.status === 'In Progress'
          ? ` Apple gave no verdict within ${WAIT}; check later with xcrun notarytool info ${result.id}.`
          : '';
      throw new Error(`Notarization failed: ${result?.status ?? `notarytool exited with ${s.status}`}${result?.message ? ` (${result.message})` : ''}.${hint}`);
    }

    // Apple can take a moment to publish the ticket after accepting the app.
    let st;
    for (let attempt = 1; attempt <= 5; attempt++) {
      st = run('xcrun', ['stapler', 'staple', appPath]);
      if (st.status === 0) break;
      console.log(`stapler staple attempt ${attempt} failed: ${(st.stdout + st.stderr).trim()}`);
      if (attempt < 5) await sleep(30_000);
    }
    if (st.status !== 0) throw new Error(`Notarized (${result.id}) but the ticket couldn't be stapled: ${(st.stdout + st.stderr).trim()}`);
    const v = run('xcrun', ['stapler', 'validate', appPath]);
    if (v.status !== 0) throw new Error(`The stapled ticket doesn't validate: ${(v.stdout + v.stderr).trim()}`);
    console.log(`Notarized and stapled (${result.id})`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
};
