const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');
const { WeightStore, selection, hashFile } = require('../src/local-weights.cjs');
const root = process.env.FIGFACTORY_DATA || path.join(os.homedir(), 'Library/Application Support/BodyFactory 形体工坊');
const store = new WeightStore(path.join(root, 'local-models'));
const encoder = process.env.FIGFACTORY_ENCODER || 'te-w4a8';
async function run(item) {
  if (store.verified(item)) return;
  const file = store.file(item.id), partial = file + '.part';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(partial) || fs.statSync(partial).size !== item.size || fs.existsSync(partial + '.aria2')) {
    const suffix = `/${item.repo}/resolve/${item.revision}/${item.file}`;
    const urls = [];
    for (const host of ['https://hf-mirror.com', 'https://huggingface.co']) {
      try { urls.push(execFileSync('curl', ['-sIL', '--fail', '--max-time', '30', '-o', '/dev/null', '-w', '%{url_effective}', host + suffix], { encoding: 'utf8' }).trim()); } catch { /* Try the other endpoint. */ }
    }
    if (!urls.length) throw new Error(`${item.id}: both endpoints unavailable`);
    await new Promise((resolve, reject) => {
      const child = spawn('aria2c', ['--continue=true', '--auto-file-renaming=false', '--allow-overwrite=true', '--file-allocation=none', '--max-connection-per-server=8', '--split=8', '--min-split-size=16M', '--max-tries=20', '--retry-wait=5', '--connect-timeout=20', '--timeout=60', '--summary-interval=30', '--console-log-level=warn', '--dir=' + path.dirname(file), '--out=' + path.basename(partial), ...urls], { stdio: 'inherit' });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${item.id}: download exited ${code}`)));
    });
  }
  console.log('SHA-256:', item.id);
  if (fs.statSync(partial).size !== item.size || await hashFile(partial) !== item.sha256) throw new Error(`${item.id}: integrity verification failed`);
  fs.renameSync(partial, file);
  fs.rmSync(partial + '.json', { force: true });
  fs.writeFileSync(file + '.verified.json', JSON.stringify({ sha256: item.sha256, mtimeMs: fs.statSync(file).mtimeMs }));
  console.log('Verified:', file);
}
(async () => {
  const catalog = await store.catalog();
  // Small dependencies are verified first; aria2 resumes its existing piece maps.
  for (const id of ['turbo-lora', 'vae', 'dit-Q4_K_M', encoder]) await run(catalog.find(item => item.id === id));
  const ready = await store.catalog();
  if (!selection('dit-Q4_K_M', encoder).every(id => ready.find(item => item.id === id)?.downloaded)) throw new Error('Selected weights are incomplete');
  console.log('All selected weights verified.');
})().catch(error => { console.error(error); process.exitCode = 1; });
