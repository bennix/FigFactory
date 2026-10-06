const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const DIT_REPO = 'abenzerps/Qwen-Image-2.1-Uncensored-GGUF';
const TE_REPO = 'pottokao/Qwen-Image-2.1-Text-Encoder-Heretic-GGUF';
const TE_W4A8_REPO = 'pottokao/Qwen-Image-2.1-Text-Encoder-Heretic-W4A8';
const TE_INT8_REPO = 'Stick9190/qwen3vl_8b_int8_convrot';
const NOCT_V3_VERSION_ID = '3355719';
const NOCT_V3_FILE_ID = '3243735';
const TURBO_REPO = 'Viggle/Qwen-Image-2.1-viggle-turbo';
const SAFETENSORS_ENCODERS = ['te-bf16', 'te-w4a8', 'te-int8-convrot'];
const FILES = [
  { id: 'turbo-lora', group: 'loras', repo: TURBO_REPO, file: 'Qwen-Image-2.1-viggle-turbo-4step-lora-r64.safetensors', label: 'Viggle Turbo · 4 步 LoRA', runnable: true },
  { id: 'dit-noct-v3-turbo', group: 'diffusion_models', source: 'civitai', versionId: NOCT_V3_VERSION_ID, fileId: NOCT_V3_FILE_ID, downloadUrl: `https://civitai.com/api/download/models/${NOCT_V3_VERSION_ID}?fileId=${NOCT_V3_FILE_ID}`, file: 'NoctQ_V3_turbo_int8_convrot.safetensors', label: 'Noct-Q V3 Turbo · int8 · 6 步', runnable: true, profile: 'noct', steps: 6, cfg: 1, local: { size: 7256784376, sha256: '87d7fbf7b2123c26cc7f474a3b77b448e339ee2e3fdd4c8170b93ed8e517ca96' } },
  ...['Q4_0', 'Q4_K_M', 'Q5_K_M', 'Q6_K', 'Q8_0', 'BF16'].map(q => ({ id: `dit-${q}`, group: 'diffusion_models', repo: DIT_REPO, file: `qwen-image-2.1-UC-${q}.gguf`, label: `GGUF ${q}`, runnable: true, profile: 'turbo' })),
  ...[4, 6, 8].map(q => ({ id: `mlx-${q}`, group: 'diffusion_models', repo: DIT_REPO, file: `qwen-image-2.1-UC-MLX-${q}bit.safetensors`, label: `MLX ${q}-bit（仅预下载）`, runnable: false, profile: 'turbo' })),
  { id: 'te-bf16', group: 'text_encoders', repo: TE_REPO, file: 'qwen3vl_8b_bf16_heretic.safetensors', label: 'BF16 · Mac 原生编码器', runnable: true },
  { id: 'te-w4a8', group: 'text_encoders', repo: TE_W4A8_REPO, file: 'qwen3vl_8b_w4a8_heretic.safetensors', label: 'Heretic W4A8 · Qwen Image 编码器', runnable: true },
  { id: 'te-int8-convrot', group: 'text_encoders', repo: TE_INT8_REPO, file: 'qwen3vl_8b_int8_convrot.safetensors', label: 'Qwen3VL int8 convrot', runnable: true },
  ...['Q4_K_M', 'Q6_K', 'Q8_0'].map(q => ({ id: `te-${q}`, group: 'text_encoders', repo: TE_REPO, file: `qwen3vl_8b_heretic-${q}.gguf`, label: `GGUF ${q}（Mac 实验性）`, runnable: true })),
  { id: 'vision', group: 'text_encoders', repo: TE_REPO, file: 'mmproj-qwen3vl_8b_heretic-f16.gguf', label: 'GGUF 视觉投影', runnable: true },
  { id: 'vae', group: 'vae', repo: DIT_REPO, file: 'vae/qwen_image_2.1_vae_bf16.safetensors', label: 'Qwen 2.1 VAE', runnable: true },
];
const hashFile = async (file, signal) => {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file, { signal })) hash.update(chunk);
  return hash.digest('hex');
};
function profileOf(dit) {
  return FILES.find(f => f.id === dit)?.profile || 'turbo';
}
function samplerOf(dit) {
  const item = FILES.find(f => f.id === dit);
  if (item?.profile === 'noct') return { steps: item.steps ?? 6, cfg: item.cfg ?? 1 };
  return { steps: 4, cfg: 1 };
}
function selection(dit, encoder) {
  const model = FILES.find(f => f.id === dit && f.group === 'diffusion_models');
  const text = FILES.find(f => f.id === encoder && f.id.startsWith('te-'));
  if (!model || !text) throw new Error('本地权重选择无效。');
  if (model.profile === 'noct') {
    if (!SAFETENSORS_ENCODERS.includes(encoder)) throw new Error('Noct-Q 需要 safetensors 文本编码器，请选择 int8 convrot、Heretic W4A8 或 BF16。');
    return [dit, encoder, 'vae'];
  }
  return [dit, encoder, ...(SAFETENSORS_ENCODERS.includes(encoder) ? [] : ['vision']), 'turbo-lora', 'vae'];
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
  async catalog(refresh = false, mirror = true) {
    fs.mkdirSync(this.root, { recursive: true });
    let metadata;
    if (!refresh) try { metadata = JSON.parse(fs.readFileSync(path.join(this.root, 'catalog.json'))); } catch { /* First download. */ }
    metadata ||= {};
    const missing = [...new Set(FILES.map(item => item.repo).filter(Boolean))].filter(repo => !metadata[repo]);
    if (missing.length) {
      for (const repo of missing) metadata[repo] = await this.repoMetadata(repo, mirror);
      fs.writeFileSync(path.join(this.root, 'catalog.json'), JSON.stringify(metadata));
    }
    return FILES.map(item => {
      const repo = item.repo ? metadata[item.repo] : null, sibling = repo?.siblings?.find(f => f.rfilename === item.file);
      const size = item.local?.size || sibling?.lfs?.size, sha256 = item.local?.sha256 || sibling?.lfs?.sha256;
      const revision = item.source === 'civitai' ? item.versionId : (/^[a-f0-9]{40}$/.test(repo?.sha || '') ? repo.sha : '');
      if (!Number.isSafeInteger(size) || size <= 0 || !/^[a-f0-9]{64}$/.test(sha256 || '') || !(item.source === 'civitai' ? /^\d+$/.test(revision || '') : /^[a-f0-9]{40}$/.test(revision || ''))) throw new Error(`权重元数据不完整：${item.file}。请刷新目录。`);
      const result = { ...item, size, sha256, revision };
      return { ...result, downloaded: this.verified(result), path: this.file(item.id) };
    });
  }
  async repoMetadata(repo, mirror) {
    const urls = mirror ? [`https://hf-mirror.com/api/models/${repo}?blobs=true`, `https://huggingface.co/api/models/${repo}?blobs=true`] : [`https://huggingface.co/api/models/${repo}?blobs=true`];
    let last = '请求失败';
    for (const url of urls) {
      try {
        const response = await this.fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!response.ok) { last = `HTTP ${response.status}`; await response.body?.cancel?.(); continue; }
        const body = await response.json();
        if (body?.sha && Array.isArray(body.siblings)) return body;
        last = '目录内容不完整';
      } catch (error) {
        if (error?.name === 'AbortError' && !String(error.message).includes('Timeout')) throw error;
        last = error.message || last;
      }
    }
    throw new Error(`无法读取 Hugging Face 权重目录：${last}`);
  }
  async download(dit, encoder, progress = () => {}, mirror = true, civitaiToken = '') {
    if (this.controller) throw new Error('已有权重下载正在进行。');
    const controller = this.controller = new AbortController();
    try {
      const catalog = await this.catalog(false, mirror), items = selection(dit, encoder).map(id => catalog.find(f => f.id === id));
      for (const item of items) {
        if (this.verified(item)) { progress({ stage: 'weights', message: `${item.label} 已校验，可复用`, id: item.id, received: item.size, total: item.size }); continue; }
        const file = this.file(item.id), partial = file + '.part', marker = partial + '.json';
        if (fs.existsSync(file) && fs.statSync(file).size === item.size) {
          progress({ stage: 'weights', message: `校验已放入的 ${item.label}…`, id: item.id, received: item.size, total: item.size });
          const placed = fs.statSync(file);
          if (await hashFile(file, controller.signal) === item.sha256) {
            fs.writeFileSync(file + '.verified.json', JSON.stringify({ sha256: item.sha256, mtimeMs: placed.mtimeMs }));
            progress({ stage: 'weights', message: `${item.label} 已校验，可复用`, id: item.id, received: item.size, total: item.size });
            continue;
          }
        }
        fs.mkdirSync(path.dirname(file), { recursive: true });
        let old; try { old = JSON.parse(fs.readFileSync(marker)); } catch { /* New file. */ }
        if (old?.sha256 !== item.sha256 || old?.size !== item.size) { fs.rmSync(partial, { force: true }); fs.writeFileSync(marker, JSON.stringify({ sha256: item.sha256, size: item.size })); }
        let offset = fs.existsSync(partial) ? fs.statSync(partial).size : 0;
        if (offset > item.size) { fs.rmSync(partial); offset = 0; }
        const disk = fs.statfsSync(this.root);
        if (disk.bavail * disk.bsize < item.size - offset + 1024 ** 3) throw new Error('磁盘空间不足，请先腾出所选权重和至少 1GB 余量。');
        if (offset < item.size) {
          const options = { headers: offset ? { Range: `bytes=${offset}-` } : {}, signal: controller.signal };
          let response;
          if (item.source === 'civitai') {
            progress({ stage: 'weights', message: `从 Civitai 下载 ${item.label}`, received: offset, total: item.size });
            const headers = { ...(civitaiToken ? { Authorization: `Bearer ${civitaiToken}` } : {}), ...options.headers };
            response = await this.fetch(item.downloadUrl, { ...options, headers });
          } else {
            const suffix = `/${item.repo}/resolve/${item.revision}/${item.file}`;
            if (mirror) {
              progress({ stage: 'weights', message: `通过 HF 镜像续传 ${item.label}`, received: offset, total: item.size });
              try { response = await this.fetch('https://hf-mirror.com' + suffix, options); } catch (error) { if (controller.signal.aborted) throw error; }
            }
            if (!response?.ok || mirror && (offset && response.status !== 206 || /text\/html|application\/json/.test(response.headers.get('content-type') || ''))) {
              if (mirror) { await response?.body?.cancel(); progress({ message: 'HF 镜像不可用或不支持该断点，尝试原站续传…' }); }
              response = await this.fetch('https://huggingface.co' + suffix, options);
            }
          }
          if (!response.ok || !response.body) {
            if (item.source === 'civitai' && [401, 403].includes(response.status)) {
              await response.body?.cancel?.();
              throw new Error(civitaiToken
                ? 'Civitai 拒绝了此下载授权。请确认 API Key 有效且该账号可下载此模型；也可登录 Civitai 手动下载后放入权重目录。'
                : 'Civitai 要求登录后才能下载此模型。请先在「AI 设置」保存 Civitai API Key；也可登录 Civitai 手动下载后放入权重目录。');
            }
            throw new Error(`权重下载失败：HTTP ${response.status}，已保留断点。`);
          }
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
module.exports = { WeightStore, FILES, selection, hashFile, SAFETENSORS_ENCODERS, profileOf, samplerOf };
