const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
module.exports = async result => {
  const files = result.artifactPaths.filter(file => file.endsWith('.dmg'));
  if (!files.length) return [];
  const profile = process.env.APPLE_KEYCHAIN_PROFILE;
  if (!profile) throw new Error('DMG 公证需要设置 APPLE_KEYCHAIN_PROFILE。');
  await Promise.all(files.map(async file => {
    const validTicket = await run('xcrun', ['stapler', 'validate', file]).then(() => true, () => false);
    if (!validTicket) {
      console.log(`Notarizing DMG: ${file}`);
      const { stdout } = await run('xcrun', ['notarytool', 'submit', file, '--keychain-profile', profile, '--wait', '--output-format', 'json']);
      const submission = JSON.parse(stdout);
      if (submission.status !== 'Accepted') throw new Error(`DMG 公证未通过：${submission.status}（${submission.id}）`);
      await run('xcrun', ['stapler', 'staple', file]);
      await run('xcrun', ['stapler', 'validate', file]);
    }
    await run('spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', file]);
    console.log(`Verified notarized DMG: ${file}`);
  }));
  return [];
};
