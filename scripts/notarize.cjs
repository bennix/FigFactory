const path = require('node:path');
const { notarize } = require('@electron/notarize');
module.exports = async context => {
  if (context.electronPlatformName !== 'darwin') return;
  const keychainProfile = process.env.APPLE_KEYCHAIN_PROFILE;
  if (!keychainProfile) throw new Error('签名 macOS 分发包需要设置 APPLE_KEYCHAIN_PROFILE（notarytool 钥匙串凭据）。');
  console.log(`Submitting ${context.packager.appInfo.productFilename} for Apple notarization…`);
  await notarize({ appPath: path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`), keychainProfile });
  console.log('Apple notarization accepted; app ticket stapled.');
};
