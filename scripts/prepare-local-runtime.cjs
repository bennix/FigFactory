// Copies only a complete, verified Apple Silicon runtime into build input.
// This intentionally fails rather than creating a misleading "offline" package.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { WeightStore, selection } = require('../src/local-weights.cjs');
const source = path.join(os.homedir(), 'Library', 'Application Support', 'BodyFactory 形体工坊');
const destination = path.join(__dirname, '..', 'build', 'local-ai');
const models = path.join(source, 'local-models');
const engine = path.join(source, 'local-engine');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('完整离线运行时只能在 Apple Silicon Mac 上准备。');
if (!fs.existsSync(path.join(engine, 'ready.json'))) throw new Error('本地引擎尚未安装完成，不能打包。');
const store = new WeightStore(models);
(async () => {
  const catalog = await store.catalog();
  const required = selection('dit-Q4_K_M', 'te-Q4_K_M').map(id => catalog.find(item => item.id === id));
  if (required.some(item => !item || !store.verified(item))) throw new Error('本地 Turbo 权重尚未全部下载并通过 SHA-256 校验，不能打包。');
  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(destination, { recursive: true });
  fs.cpSync(models, path.join(destination, 'models'), { recursive: true, preserveTimestamps: true });
  fs.cpSync(engine, path.join(destination, 'engine'), { recursive: true, preserveTimestamps: true, filter: file => !/\/(uv-cache|python|__pycache__)\//.test(file) && !/\.(tar\.gz|part|pyc)$/.test(file) });
  console.log(`Prepared verified offline runtime: ${destination}`);
})().catch(error => { console.error(error.message); process.exitCode = 1; });
