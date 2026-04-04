const { execSync } = require('child_process');
const path = require('path');

module.exports = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') {
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  const appleId = process.env.APPLE_ID;
  const appPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
  const teamId = process.env.APPLE_TEAM_ID;

  console.log(`\n📦 Starting notarization for ${appPath}`);
  console.log(`   Apple ID: ${appleId}`);
  console.log(`   Team ID: ${teamId}`);

  const startTime = Date.now();

  // First, zip the app for submission
  const zipPath = path.join(appOutDir, `${appName}.zip`);
  console.log('📁 Creating zip for notarization...');
  execSync(`ditto -c -k --keepParent "${appPath}" "${zipPath}"`, { stdio: 'inherit' });

  // Submit to Apple notarization with --wait and --timeout
  // Using xcrun notarytool directly to control timeout (20 minutes)
  const cmd = [
    'xcrun notarytool submit',
    `"${zipPath}"`,
    '--apple-id', `"${appleId}"`,
    '--password', `"${appPassword}"`,
    '--team-id', `"${teamId}"`,
    '--wait',
    '--timeout', '20m',
    '--output-format', 'json'
  ].join(' ');

  console.log('🚀 Submitting to Apple notarization service (timeout: 20 minutes)...');

  try {
    const result = execSync(cmd, {
      encoding: 'utf8',
      timeout: 25 * 60 * 1000, // 25 min Node timeout as safety net
      stdio: ['pipe', 'pipe', 'pipe']
    });

    console.log('📋 Notarization response:', result);

    let jsonResult;
    try {
      jsonResult = JSON.parse(result);
    } catch (e) {
      console.log('⚠️  Could not parse JSON response, checking raw output...');
    }

    if (jsonResult && jsonResult.status === 'Accepted') {
      const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
      console.log(`✅ Notarization accepted! (took ${duration} minutes)`);

      // Staple the notarization ticket
      console.log('📎 Stapling notarization ticket...');
      execSync(`xcrun stapler staple "${appPath}"`, { stdio: 'inherit' });
      console.log('✅ Stapling complete!');
    } else if (jsonResult && jsonResult.status === 'Invalid') {
      const logCmd = `xcrun notarytool log ${jsonResult.id} --apple-id "${appleId}" --password "${appPassword}" --team-id "${teamId}"`;
      try {
        const log = execSync(logCmd, { encoding: 'utf8' });
        console.error('📋 Notarization log:', log);
      } catch (e) {
        console.error('Could not fetch notarization log');
      }
      throw new Error(`Notarization failed with status: ${jsonResult.status}`);
    } else {
      // Timeout or unknown status - check if it was accepted anyway
      console.log('⚠️  Notarization did not complete within timeout, but submission was accepted by Apple.');
      console.log('    The app may still be notarized. Attempting to staple...');
      try {
        execSync(`xcrun stapler staple "${appPath}"`, { stdio: 'inherit' });
        console.log('✅ Stapling succeeded - app was notarized!');
      } catch (e) {
        console.log('⚠️  Stapling failed - notarization may still be in progress.');
        console.log('    You can check status later and staple manually.');
        // Don\'t throw - let the build succeed without notarization
      }
    }
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);

    if (error.status !== undefined || error.message.includes('timed out')) {
      console.error(`❌ Notarization timed out after ${duration} minutes`);
      console.error('   The submission is still being processed by Apple.');

      // Try to staple in case it completed
      try {
        execSync(`xcrun stapler staple "${appPath}"`, { stdio: 'inherit' });
        console.log('✅ Stapling succeeded despite timeout - app was notarized!');
        return;
      } catch (e) {
        console.log('⚠️  Stapling failed - notarization still in progress.');
      }

      // Print stderr for debugging
      if (error.stderr) {
        console.error('stderr:', error.stderr.toString());
      }
      if (error.stdout) {
        console.log('stdout:', error.stdout.toString());
      }
      throw new Error(`Notarization timed out after ${duration} minutes`);
    }

    console.error(`❌ Notarization failed after ${duration} minutes`);
    if (error.stderr) {
      console.error('stderr:', error.stderr.toString());
    }
    if (error.stdout) {
      console.log('stdout:', error.stdout.toString());
    }
    throw error;
  } finally {
    // Clean up zip file
    try {
      require('fs').unlinkSync(zipPath);
    } catch (e) {
      // ignore cleanup errors
    }
  }
};
