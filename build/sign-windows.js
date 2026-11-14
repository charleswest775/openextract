// electron-builder's afterPack hook (package.json build.afterPack). On Windows, with Azure Trusted
// Signing configured, signs every PE file in the packed app except the .exe files in one batch
// (build/sign-windows.ps1), before electron-builder signs the app.
//
// Why: Smart App Control refuses to load unsigned DLLs (#169), so every DLL and .pyd in the
// engine has to be signed, about 190 files with Electron's own DLLs. electron-builder signs
// one file at a time, each in a new PowerShell with its own sign-in to Azure: about 2.5 s a
// file, 8 of the Windows build's 13 minutes. One Invoke-TrustedSigning call signs them all.
//
// electron-builder still signs the .exe files itself: OpenExtract.exe (after it sets the icon
// and version, which would undo a signature made here), the engine's .exe, elevate.exe, and the
// installer and uninstaller. win.signExts is left unset so it signs nothing else. release.yml's
// "Verify Authenticode signatures" step checks every PE file afterwards, and the App Control
// check loads them under an enforced policy, so a file missed here keeps the release a draft.
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/** Every file under `dir` that starts with "MZ" (as scripts/app-control/common.ps1 finds them), except .exe files. */
function peFilesToSign(dir) {
  const found = [];
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const file = path.join(entry.parentPath ?? entry.path, entry.name);
    if (file.toLowerCase().endsWith('.exe')) continue;
    const fd = fs.openSync(file, 'r');
    try {
      const head = Buffer.alloc(2);
      if (fs.readSync(fd, head, 0, 2, 0) === 2 && head[0] === 0x4d && head[1] === 0x5a) found.push(file);
    } finally {
      fs.closeSync(fd);
    }
  }
  return found.sort();
}

/** What the hook should do for this pack: 'sign', or why it skips. */
function decide(context, env = process.env) {
  if (context.electronPlatformName !== 'win32') return { action: 'skip', reason: 'not a Windows build' };
  const azure = context.packager.platformSpecificBuildOptions?.azureSignOptions;
  // Pre-release and installer test builds delete azureSignOptions: they're unsigned.
  if (!azure) return { action: 'skip', reason: 'no win.azureSignOptions (an unsigned build)' };
  const missing = ['AZURE_TENANT_ID', 'AZURE_CLIENT_ID', 'AZURE_CLIENT_SECRET'].filter(k => !env[k]);
  if (missing.length) {
    const why = `${missing.join(', ')} ${missing.length === 1 ? 'is' : 'are'} needed to sign with Azure Trusted Signing`;
    // A release must be signed; a local build without the secrets needn't be.
    if (env.CI) throw new Error(why);
    return { action: 'skip', reason: why };
  }
  return { action: 'sign', azure };
}

function powershell() {
  const probe = spawnSync('pwsh.exe', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' });
  return probe.status === 0 ? 'pwsh.exe' : 'powershell.exe';
}

module.exports = async function signWindows(context) {
  const d = decide(context);
  if (d.action === 'skip') {
    if (context.electronPlatformName === 'win32') console.log(`  • batch signing skipped: ${d.reason}`);
    return;
  }
  const files = peFilesToSign(context.appOutDir);
  if (files.length === 0) throw new Error(`No DLLs found to sign in ${context.appOutDir}`);

  // The module reads the list's lines relative to the list's own folder, so it sits next to
  // the app folder (not inside it, where it would ship) with paths relative to there.
  const listDir = path.dirname(context.appOutDir);
  const list = path.join(listDir, 'sign-windows-files.txt');
  fs.writeFileSync(list, files.map(f => path.relative(listDir, f)).join('\r\n') + '\r\n');
  try {
    console.log(`  • batch signing ${files.length} DLLs with Azure Trusted Signing (build/sign-windows.js)`);
    const t0 = Date.now();
    const r = spawnSync(powershell(), [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', path.join(__dirname, 'sign-windows.ps1'),
      '-List', list,
      '-Endpoint', d.azure.endpoint,
      '-CodeSigningAccountName', d.azure.codeSigningAccountName,
      '-CertificateProfileName', d.azure.certificateProfileName,
    ], { stdio: 'inherit' });
    if (r.error) throw r.error;
    if (r.status !== 0) throw new Error(`build/sign-windows.ps1 exited with ${r.status}`);
    console.log(`  • batch signed ${files.length} DLLs in ${Math.round((Date.now() - t0) / 1000)} s`);
  } finally {
    fs.rmSync(list, { force: true });
  }
};

module.exports.peFilesToSign = peFilesToSign;
module.exports.decide = decide;
