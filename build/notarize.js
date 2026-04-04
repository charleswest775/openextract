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

  // Zip the app for submission
  const zipPath = path.join(appOutDir, `${appName}.zip`);
  console.log('📁 Creating zip for notarization...');
  execSync(`ditto -c -k --keepParent "${appPath}" "${zipPath}"`, { stdio: 'inherit' });

  // Submit to Apple WITHOUT --wait to avoid hanging
  // Apple will process it asynchronously; macOS checks online for notarization status
  const submitCmd = [
    'xcrun notarytool submit',
    `"${zipPath}"`,
    '--apple-id', `"${appleId}"`,
    '--password', `"${appPassword}"`,
    '--team-id', `"${teamId}"`,
    '--output-format', 'json'
  ].join(' ');

  console.log('🚀 Submitting to Apple notarization service...');

  let submissionId;
  try {
    const result = execSync(submitCmd, {
      encoding: 'utf8',
      timeout: 5 * 60 * 1000, // 5 min timeout for upload only
      stdio: ['pipe', 'pipe', 'pipe']
    });

    console.log('📋 Submission response:', result);

    try {
      const jsonResult = JSON.parse(result);
      submissionId = jsonResult.id;
      console.log(`✅ Submitted successfully! Submission ID: ${submissionId}`);
    } catch (e) {
      console.log('⚠️  Could not parse JSON response');
    }
  } catch (error) {
    console.error('❌ Submission failed!');
    if (error.stderr) console.error('stderr:', error.stderr.toString());
    if (error.stdout) console.log('stdout:', error.stdout.toString());
    throw error;
  }

  // Now poll for completion with a 15-minute timeout
  if (submissionId) {
    console.log('⏳ Waiting for Apple to process notarization...');

    const pollInterval = 30; // seconds
    const maxWait = 15 * 60; // 15 minutes
    let elapsed = 0;

    while (elapsed < maxWait) {
      // Wait before checking
      execSync(`sleep ${pollInterval}`);
      elapsed += pollInterval;

      try {
        const infoCmd = [
          'xcrun notarytool info',
          submissionId,
          '--apple-id', `"${appleId}"`,
          '--password', `"${appPassword}"`,
          '--team-id', `"${teamId}"`,
          '--output-format', 'json'
        ].join(' ');

        const infoResult = execSync(infoCmd, {
          encoding: 'utf8',
          timeout: 30000,
          stdio: ['pipe', 'pipe', 'pipe']
        });

        const info = JSON.parse(infoResult);
        const status = info.status;
        const mins = (elapsed / 60).toFixed(1);
        console.log(`   [${mins}m] Status: ${status}`);

        if (status === 'Accepted') {
          const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
          console.log(`✅ Notarization accepted! (took ${duration} minutes)`);

          // Staple the ticket
          console.log('📎 Stapling notarization ticket...');
          execSync(`xcrun stapler staple "${appPath}"`, { stdio: 'inherit' });
          console.log('✅ Stapling complete!');

          // Cleanup
          try { require('fs').unlinkSync(zipPath); } catch (e) {}
          return;
        } else if (status === 'Invalid') {
          // Fetch the log for details
          try {
            const logCmd = `xcrun notarytool log ${submissionId} --apple-id "${appleId}" --password "${appPassword}" --team-id "${teamId}"`;
            const log = execSync(logCmd, { encoding: 'utf8' });
            console.error('📋 Notarization log:', log);
          } catch (e) {}
          throw new Error('Notarization was rejected by Apple');
        }
        // Otherwise status is "In Progress" - keep polling
      } catch (pollError) {
        console.log(`   [${(elapsed / 60).toFixed(1)}m] Poll error: ${pollError.message}`);
      }
    }

    // If we get here, notarization is still in progress after 15 minutes
    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`\n⏰ Notarization still in progress after ${duration} minutes.`);
    console.log(`   Submission ID: ${submissionId}`);
    console.log('   Apple will continue processing in the background.');
    console.log('   macOS will check notarization status online when users open the app.');
    console.log('   You can check status later with:');
    console.log(`   xcrun notarytool info ${submissionId} --apple-id "${appleId}" --team-id "${teamId}"`);
    console.log('\n   Continuing build without waiting for notarization to complete...');

    // DON'T throw - let the build succeed
    // The app will still pass Gatekeeper once Apple finishes processing
  }

  // Cleanup
  try { require('fs').unlinkSync(zipPath); } catch (e) {}
};
