const { notarize } = require('@electron/notarize');

module.exports = async function notarizing(context) {
  const { electronPlatformName, appOutDir } = context;

  if (electronPlatformName !== 'darwin') {
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = `${appOutDir}/${appName}.app`;

  console.log(`\n📦 Starting notarization for ${appPath}`);
  console.log(`   Apple ID: ${process.env.APPLE_ID}`);
  console.log(`   Team ID: ${process.env.APPLE_TEAM_ID}`);

  const startTime = Date.now();

  try {
    await notarize({
      tool: 'notarytool',
      appPath: appPath,
      appleId: process.env.APPLE_ID,
      appleIdPassword: process.env.APPLE_APP_SPECIFIC_PASSWORD,
      teamId: process.env.APPLE_TEAM_ID,
    });

    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.log(`✅ Notarization complete! (took ${duration} minutes)`);
  } catch (error) {
    const duration = ((Date.now() - startTime) / 1000 / 60).toFixed(1);
    console.error(`❌ Notarization failed after ${duration} minutes`);
    console.error('Error:', error.message || error);
    throw error;
  }
};
