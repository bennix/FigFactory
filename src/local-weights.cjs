const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const DIT_REPO = 'abenzerps/Qwen-Image-2.1-Uncensored-GGUF';
const TE_REPO = 'pottokao/Qwen-Image-2.1-Text-Encoder-Heretic-GGUF';
const TE_W4A8_REPO = 'pottokao/Qwen-Image-2.1-Text-Encoder-Heretic-W4A8';
const TURBO_REPO = 'Viggle/Qwen-Image-2.1-viggle-turbo';
const FILES = [
  { id: 'turbo-lora', group: 'loras', repo: TURBO_REPO, file: 'Qwen-Image-2.1-viggle-turbo-4step-lora-r64.safetensors', label: 'Viggle Turbo · 4 步 LoRA', runnable: true },
  ...['Q4_0', 'Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0', 'BF16'].map(q => ({ id: `dit-${q}`, group: 'diffusion_models', repo: DIT_REPO, file: `qwen-image-2.1-UC-${q}.gguf`, label: `GGUF ${q}`, runnable: true })),
  ...[4, 6, 8].map(q => ({ id: `mlx-${q}`, group: 'diffusion_models', repo: DIT_REPO, file: `qwen-image-2.1-UC-MLX-${q}bit.safetensors`, label: `MLX ${q}-bit（仅预下载）`, runnable: false })),
  { id: 'te-bf16', group: 'text_encoders', repo: TE_REPO, file: 'qwen3vl_8b_bf16_heretic.safetensors', label: 'BF16 · Mac 原生编码器', runnable: true },
  { id: 'te-w4a8', group: 'text_encoders', repo: TE_W4A8_REPO, file: 'qwen3vl_8b_w4a8_heretic.safetensors', label: 'Heretic W4A8 · Qwen Image 编码器', runnable: true },
  ...['Q4_K_M', 'Q6_K', 'Q8_0'].map(q => ({ id: `te-${q}`, group: 'text_encoders', repo: TE_REPO, file: `qwen3vl_8b_heretic-${q}.gguf`, label: `GGUF ${q}（Mac 实验性）`, runnable: true })),
  { id: 'vision', group: 'text_encoders', repo: TE_REPO, file: 'mmproj-qwen3vl_8b_heretic-f16.gguf', label: 'GGUF 视觉投影', runnable: true },
  { id: 'vae', group: 'vae', repo: DIT_REPO, file: 'vae/qwen_image_2.1_vae_bf16.safetensors', label: 'Qwen 2.1 VAE', runnable: true },
];
const hashFile = async (file, signal) => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
};
function selection(dit, encoder) {
  if (!FILES.some(f => f.id === dit && f.group === 'diffusion_models') || !FILES.some(f => f.id === encoder && f.id.startsWith('te-'))) throw new Error('本地权重选择无效。');
  return [dit, encoder, ...(!['te-bf16', 'te-w4a8'].includes(encoder) ? ['vision'] : []), 'turbo-lora', 'vae'];
}
class WeightStore {
  constructor(root, fetcher = fetch) { this.root = root; this.fetch = fetcher; this.controller = null; }
  file(id) {
    const item = FILES.find(f => f.id === id);
    if (!item) throw new Error('未知权重。');
    return path.join(this.root, item.group, path.basename(item.file));
  }
  verified(item) {
    try {
      const file = this.file(item.id), stat = fs.statSync(file), record = JSON.parse(fs.readFileSync(file + '.verified.json'));
      return stat.size === item.size && record.sha256 === item.sha256 && record.mtimeMs === stat.mtimeMs;
    } catch { return false; }
  }
  async catalog(refresh = false) {
    fs.mkdirSync(this.root, { recursive: true });
    let metadata;
    if (!refresh) try { metadata = JSON.parse(fs.readFileSync(path.join(this.root, 'catalog.json'))); } catch { /* First download. */ }
    metadata ||= {};
    const missing = [...new Set(FILES.map(item => item.repo))].filter(repo => !metadata[repo]);
    if (missing.length) {
      for (const repo of missing) {
        const response = await this.fetch(`https://huggingface.co/api/models/${repo}?blobs=true`, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) throw new Error(`无法读取 Hugging Face 权重目录：HTTP ${response.status}`);
        metadata[repo] = await response.json();
      }
      fs.writeFileSync(path.join(this.root, 'catalog.json'), JSON.stringify(metadata));
    }
    return FILES.map(item => {
      const repo = metadata[item.repo], sibling = repo?.siblings?.find(f => f.rfilename === item.file);
      const size = sibling?.lfs?.size, sha256 = sibling?.lfs?.sha256, revision = repo?.sha;
      if (!Number.isSafeInteger(size) || size <= 0 || !/^[a-f0-9]{64}$/.test(sha256 || '') || !/^[a-f0-9]{40}$/.test(revision || '')) throw new Error(`权重元数据不完整：${item.file}。请刷新目录。`);
      const result = { ...item, size, sha256, revision };
      return { ...result, downloaded: this.verified(result), path: this.file(item.id) };
    });
  }
  async download(dit, encoder, progress = () => {}, mirror = true) {
    if (this.controller) throw new Error('已有权重下载正在进行。');
    const controller = this.controller = new AbortController();
    try {
      const catalog = await this.catalog(), items = selection(dit, encoder).map(id => catalog.find(f => f.id === id));
      for (const item of items) {
        if (this.verified(item)) { progress({ stage: 'weights', message: `${item.label} 已校验，可复用`, id: item.id, received: item.size, total: item.size }); continue; }
        const file = this.file(item.id), partial = file + '.part', marker = partial + '.json';
        fs.mkdirSync(path.dirname(file), { recursive: true });
        let old; try { old = JSON.parse(fs.readFileSync(marker)); } catch { /* New file. */ }
        if (old?.sha256 !== item.sha256 || old?.size !== item.size) { fs.rmSync(partial, { force: true }); fs.writeFileSync(marker, JSON.stringify({ sha256: item.sha256, size: item.size })); }
        let offset = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
        if (offset > item.size) { fs.rmSync(partial); offset = 0; }
        const disk = fs.statfsSync(this.root);
        if (disk.bavail * disk.bsize < item.size - offset + 1024 ** 3) throw new Error('磁盘空间不足，请先腾出所选权重和至少 1GB 余量。');
        if (offset < item.size) {
          const suffix = `/${item.repo}/resolve/${item.revision}/${item.file}`;
          const options = { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: controller.signal };
          let response;
          if (mirror) {
            progress({ stage: 'weights', message: `通过 HF 镜像续传 ${item.label}`, received: offset, total: item.size });
            try { response = await this.fetch('https://hf-mirror.com' + suffix, options); } catch (error) { if (controller.signal.aborted) throw error; }
          }
          if (!response?.ok || mirror && (offset && response.status !== 206 || /text\/html|application\/json/.test(response.headers.get('content-type') || ''))) {
            if (mirror) { await response?.body?.cancel(); progress({ message: 'HF 镜像不可用或不支持该断点，尝试原站续传…' }); }
            response = await this.fetch('https://huggingface.co' + suffix, options);
          }
          if (!response.ok || !response.body) throw new Error(`权重下载失败：HTTP ${response.status}，已保留断点。`);
          if (offset && response.status === 200) offset = 0;
          if (response.status === 206 && !response.headers.get('content-range')?.startsWith(`bytes ${offset}-`)) throw new Error('下载断点与服务器不一致，请重试。');
          let received = offset, last = 0;
          const meter = new Transform({ transform(chunk, encoding, done) {
            received += chunk.length;
            if (received > item.size) return done(new Error('下载文件超过目录标明的大小。'));
            if (Date.now() - last > 400) { last = Date.now(); progress({ stage: 'weights', message: `下载 ${item.label}`, id: item.id, received, total: item.size }); }
            done(null, chunk);
          } });
          await pipeline(Readable.fromWeb(response.body), meter, fs.createWriteStream(partial, { flags: offset ? 'a' : 'w' }), { signal: controller.signal });
        }
        progress({ stage: 'weights', message: `校验 ${item.label} SHA-256…`, id: item.id, received: item.size, total: item.size });
        if (fs.statSync(partial).size !== item.size || await hashFile(partial, controller.signal) !== item.sha256) {
          fs.rmSync(partial, { force: true }); throw new Error(`${item.label} 完整性校验失败，未作为可用权重。请重试下载。`);
        }
        fs.renameSync(partial, file); fs.rmSync(marker, { force: true });
        fs.writeFileSync(file + '.verified.json', JSON.stringify({ sha256: item.sha256, mtimeMs: fs.statSync(file).mtimeMs }));
      }
      return await this.catalog();
    } finally { this.controller = null; }
  }
  cancel() { this.controller?.abort(); }
}
module.exports = { WeightStore, FILES, selection, hashFile };
