const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { parseImage } = require('./zenmux.cjs');
const { selection, hashFile } = require('./local-weights.cjs');
const run = promisify(execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const PYTHON = process.platform === 'win32' ? ['Scripts', 'python.exe'] : ['bin', 'python'];
class LocalEngine {
  // Packaged engines are read-only. Keep all ComfyUI inputs, outputs and generated
  // configuration in runtimeRoot so an installed app never mutates its bundle.
  constructor(engineRoot, weights, runtimeRoot = engineRoot) { this.engineRoot = engineRoot; this.runtimeRoot = runtimeRoot; this.root = engineRoot; this.weights = weights; this.process = null; this.port = 0; this.installing = false; this.logs = ''; this.ready = false; this.installController = null; this.generating = false; this.idleTimer = null; this.lastActivityAt = 0; this.idleTimeoutMs = 2 * 60 * 1000; }
  get bundled() { return this.engineRoot !== this.runtimeRoot; }
  get python() { return path.join(this.engineRoot, 'env', ...PYTHON); }
  status() {
    const idleRemainingMs = this.ready && !this.generating && this.lastActivityAt ? Math.max(0, this.idleTimeoutMs - (Date.now() - this.lastActivityAt)) : null;
    return { installed: fs.existsSync(this.python) && fs.existsSync(path.join(this.engineRoot, 'ready.json')), bundled: this.bundled, running: this.ready, starting: !!this.process && !this.ready, installing: this.installing, generating: this.generating, idleTimeoutMs: this.idleTimeoutMs, idleRemainingMs, memory: os.totalmem(), platform: process.platform, arch: process.arch, modelPath: this.weights.root };
  }
  async install(progress = () => {}, mirror = false) {
    if (this.installing) throw new Error('本地引擎正在安装。');
    if (this.status().installed) return this.status();
    if (process.platform === 'darwin' && process.arch !== 'arm64') throw new Error('当前托管 Mac 引擎面向 Apple Silicon；Intel Mac 可使用 ZenMux。');
    this.installing = true;
    const installController = this.installController = new AbortController();
    const installRun = (cmd, args, options = {}) => run(cmd, args, { ...options, signal: installController.signal });
    fs.mkdirSync(this.engineRoot, { recursive: true });
    const env = { ...process.env, UV_PYTHON_INSTALL_DIR: path.join(this.engineRoot, 'python'), UV_CACHE_DIR: path.join(this.engineRoot, 'uv-cache'), UV_HTTP_TIMEOUT: '120', UV_CONCURRENT_DOWNLOADS: '4' };
    try {
      let uv = path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'uv.exe' : 'uv');
      if (!fs.existsSync(uv)) {
        const triplet = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${process.platform === 'darwin' ? 'apple-darwin' : process.platform === 'win32' ? 'pc-windows-msvc' : 'unknown-linux-gnu'}`;
        const name = `uv-${triplet}.${process.platform === 'win32' ? 'zip' : 'tar.gz'}`;
        const release = await this.json('https://api.github.com/repos/astral-sh/uv/releases/latest');
        const asset = release.assets.find(a => a.name === name), sum = release.assets.find(a => a.name === name + '.sha256');
        if (!asset || !sum) throw new Error('当前系统没有可用的 Python 安装器。');
        progress({ message: '下载 Python 安装器…' });
        const archive = path.join(this.engineRoot, name); await this.archive(asset.browser_download_url, archive);
        const checksumResponse = await fetch(sum.browser_download_url, { signal: AbortSignal.any([installController.signal, AbortSignal.timeout(30000)]) });
        if (!checksumResponse.ok) throw new Error('无法读取 Python 安装器校验值。');
        const checksum = await checksumResponse.text();
        if (await hashFile(archive) !== checksum.match(/[a-f0-9]{64}/)?.[0]) throw new Error('Python 安装器校验失败。');
        await installRun('tar', ['-xf', archive, '-C', this.engineRoot]);
        uv = process.platform === 'win32' ? path.join(this.engineRoot, 'uv.exe') : path.join(this.engineRoot, `uv-${triplet}`, 'uv');
      }
      progress({ message: '安装隔离的 Python 3.12 环境…' });
      await installRun(uv, ['python', 'install', '3.12'], { env, maxBuffer: 8 * 1024 ** 2 });
      if (!fs.existsSync(this.python)) await installRun(uv, ['venv', '--python', '3.12', path.join(this.engineRoot, 'env')], { env });
      const sources = [
        ['Comfy-Org/ComfyUI', path.join(this.engineRoot, 'ComfyUI')],
        ['leejet/ComfyUI-GGUF', path.join(this.engineRoot, 'ComfyUI', 'custom_nodes', 'ComfyUI-GGUF')],
        ['pottokao-dotcom/ComfyUI-GGUF-Qwen3VL-TE', path.join(this.engineRoot, 'ComfyUI', 'custom_nodes', 'ComfyUI-GGUF-Qwen3VL-TE')],
      ];
      const revisions = {};
      for (const [repo, target] of sources) {
        progress({ message: `准备 ${repo.split('/')[1]}…` });
        const { sha } = await this.json(`https://api.github.com/repos/${repo}/commits/HEAD`);
        if (!/^[a-f0-9]{40}$/.test(sha || '')) throw new Error('引擎源码版本无效。');
        revisions[repo] = sha;
        const marker = path.join(target, '.figfactory-revision');
        if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === sha) continue;
        fs.mkdirSync(target, { recursive: true });
        const archive = path.join(this.engineRoot, `${repo.split('/')[1]}.tar.gz`);
        await this.archive(`https://github.com/${repo}/archive/${sha}.tar.gz`, archive);
        await installRun('tar', ['-xf', archive, '--strip-components=1', '-C', target]);
        fs.writeFileSync(marker, sha);
      }
      progress({ message: '安装 PyTorch 与本地推理依赖（首次可能需要较长时间）…' });
      const runtimeRequirements = path.join(this.engineRoot, 'runtime-requirements.txt');
      // FigFactory provides the UI; the engine only needs API/inference dependencies.
      fs.writeFileSync(runtimeRequirements, fs.readFileSync(path.join(this.root, 'ComfyUI', 'requirements.txt'), 'utf8').split(/\r?\n/).filter(line => !/^comfyui-(frontend-package|workflow-templates|embedded-docs)(?:[=<>]|$)/.test(line)).join('\n'));
      const pipArgs = ['pip', 'install', '--python', this.python, '-r', runtimeRequirements, '-r', path.join(this.root, 'ComfyUI', 'custom_nodes', 'ComfyUI-GGUF', 'requirements.txt')];
      try { await installRun(uv, [...pipArgs, ...(mirror ? ['--index-url', 'https://pypi.tuna.tsinghua.edu.cn/simple'] : [])], { env, maxBuffer: 16 * 1024 ** 2 }); }
      catch (error) {
        if (!mirror || installController.signal.aborted) throw error;
        progress({ message: 'PyPI 镜像安装失败，使用已有缓存尝试原站…' });
        await installRun(uv, pipArgs, { env, maxBuffer: 16 * 1024 ** 2 });
      }
      const { stdout } = await installRun(this.python, ['-c', 'import torch,json; print(json.dumps({"mps":torch.backends.mps.is_available(),"torch":torch.__version__}))']);
      const runtime = JSON.parse(stdout.trim());
      if (process.platform === 'darwin' && process.arch === 'arm64' && !runtime.mps) throw new Error('PyTorch 未识别 Apple Silicon MPS，请检查系统版本及引擎安装。');
      fs.writeFileSync(path.join(this.engineRoot, 'ready.json'), JSON.stringify({ revisions, runtime }));
      progress({ message: '本地引擎安装完成。' }); return this.status();
    } finally { this.installing = false; this.installController = null; }
  }
  async json(url, options = {}) {
    const response = await fetch(url, { ...options, signal: options.signal || (this.installController ? AbortSignal.any([this.installController.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000)) });
    if (!response.ok) throw new Error(`本地引擎接口失败：HTTP ${response.status}`);
    return response.json();
  }
  async archive(url, file) {
    const response = await fetch(url, { signal: this.installController ? AbortSignal.any([this.installController.signal, AbortSignal.timeout(300000)]) : AbortSignal.timeout(300000) });
    if (!response.ok) throw new Error(`引擎下载失败：HTTP ${response.status}`);
    const { pipeline } = require('node:stream/promises'), { Readable } = require('node:stream');
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(file));
  }
  async start(progress = () => {}) {
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startEngine(progress);
    try { return await this.startPromise; }
    finally { this.startPromise = null; }
  }
  async startEngine(progress = () => {}) {
    if (this.process) { clearTimeout(this.idleTimer); this.idleTimer = null; await this.json(this.url('/system_stats')); this.scheduleIdleStop(); return this.status(); }
    if (!this.status().installed) throw new Error('请先安装本地引擎。');
    const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
    fs.mkdirSync(this.runtimeRoot, { recursive: true });
    const config = path.join(this.runtimeRoot, 'models.yaml');
    fs.writeFileSync(config, `figfactory:\n  base_path: ${JSON.stringify(this.weights.root)}\n  diffusion_models: diffusion_models\n  text_encoders: text_encoders\n  vae: vae\n  loras: loras\n`);
    const frontend = path.join(this.runtimeRoot, 'api-frontend');
    fs.mkdirSync(frontend, { recursive: true });
    fs.writeFileSync(path.join(frontend, 'index.html'), '<!doctype html><title>FigFactory local engine</title>FigFactory local inference API');
    const input = path.join(this.runtimeRoot, 'input'), output = path.join(this.runtimeRoot, 'output');
    fs.mkdirSync(input, { recursive: true }); fs.mkdirSync(output, { recursive: true });
    const child = this.process = spawn(this.python, [path.join(this.engineRoot, 'ComfyUI', 'main.py'), '--listen', '127.0.0.1', '--port', String(port), '--disable-auto-launch', '--offline', '--front-end-root', frontend, '--extra-model-paths-config', config, '--input-directory', input, '--output-directory', output, '--cpu-vae'], { cwd: path.join(this.engineRoot, 'ComfyUI'), env: { ...process.env, PYTORCH_ENABLE_MPS_FALLBACK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    this.port = port; this.logs = '';
    const record = chunk => { this.logs = (this.logs + chunk.toString()).slice(-10000); };
    child.stdout.on('data', record); child.stderr.on('data', record);
    child.on('error', error => { record(error.message); if (this.process === child) { this.process = null; this.port = 0; this.ready = false; } });
    child.on('exit', () => { if (this.process === child) { this.process = null; this.port = 0; this.ready = false; } });
    progress({ message: '正在启动本地引擎…' });
    for (let attempt = 0; attempt < 120; attempt++) {
      if (!this.process) throw new Error(`本地引擎启动失败：${this.logs.slice(-1500)}`);
      try { await this.json(this.url('/system_stats'), { signal: AbortSignal.timeout(1500) }); if (this.process !== child) throw new Error('本地引擎启动已取消。'); this.ready = true; this.scheduleIdleStop(); progress({ message: '本地引擎已启动，仅监听本机。' }); return this.status(); } catch { await sleep(500); }
    }
    this.stop(); throw new Error(`本地引擎启动超时：${this.logs.slice(-1500)}`);
  }
  url(endpoint) { if (!this.port) throw new Error('本地引擎尚未启动。'); return `http://127.0.0.1:${this.port}${endpoint}`; }
  scheduleIdleStop() {
    clearTimeout(this.idleTimer); this.idleTimer = null;
    if (!this.ready || this.generating || !this.process) return;
    this.lastActivityAt = Date.now();
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.generating) return;
      this.stop();
    }, this.idleTimeoutMs);
    this.idleTimer.unref?.();
  }
  stop() { clearTimeout(this.idleTimer); this.idleTimer = null; this.lastActivityAt = 0; this.installController?.abort(); this.ready = false; this.process?.kill(); this.process = null; this.port = 0; }
  async generate(args, progress = () => {}) {
    if (this.generating) throw new Error('已有本地生成任务，请等待完成或停止引擎。');
    this.generating = true;
    clearTimeout(this.idleTimer); this.idleTimer = null;
    try { return await this.generateImage(args, progress); }
    finally { this.generating = false; this.scheduleIdleStop(); }
  }
  async generateImage({ prompt, images = [], size = '1024x1024', dit, encoder }, progress = () => {}) {
    if (!prompt?.trim()) throw new Error('请填写本地生图提示词。');
    if (images.length > 16) throw new Error('本地 Qwen 2.1 最多接收 16 张参考图。');
    const catalog = await this.weights.catalog();
    const parts = selection(dit, encoder).map(id => catalog.find(item => item.id === id));
    if (!parts[0].runnable) throw new Error('MLX 权重当前支持预下载；托管 ComfyUI 引擎请使用 GGUF 主模型。');
    if (parts.some(item => !this.weights.verified(item))) throw new Error('所选主模型、编码器、视觉投影、4 步 Turbo LoRA 或 VAE 尚未全部下载并校验。');
    await this.start(progress);
    const info = await this.json(this.url('/object_info'));
    const clipLoader = ['te-bf16', 'te-w4a8'].includes(encoder) ? 'CLIPLoader' : 'CLIPLoaderGGUF';
    const nodes = ['UnetLoaderGGUF', clipLoader, 'VAELoader', 'TextEncodeQwenImage21', 'KSampler', 'EmptyLatentImage', 'VAEDecode', 'SaveImage', 'LoraLoaderModelOnly', ...(images.length ? ['LoadImage'] : [])];
    if (nodes.some(node => !info[node])) throw new Error('本地引擎缺少 Qwen 2.1 或 GGUF 节点，请重新安装引擎。');
    const names = { dit: path.basename(parts[0].file), encoder: path.basename(parts[1].file), vae: path.basename(parts.at(-1).file), lora: path.basename(parts.find(item => item.id === 'turbo-lora').file) };
    if (!info.LoraLoaderModelOnly.input.required.lora_name[0].includes(names.lora)) throw new Error('引擎尚未识别 Turbo LoRA，请停止后重新启动引擎。');
    if (!info.UnetLoaderGGUF.input.required.unet_name[0].includes(names.dit) || !info[nodes[1]].input.required.clip_name[0].includes(names.encoder) || !info.VAELoader.input.required.vae_name[0].includes(names.vae)) throw new Error('引擎尚未识别所选权重，请停止后重新启动本地引擎。');
    const uploaded = [];
    for (const image of images) {
      const { mimeType, bytesBase64Encoded } = parseImage(image), form = new FormData();
      form.append('image', new Blob([Buffer.from(bytesBase64Encoded, 'base64')], { type: mimeType }), `figfactory-${crypto.randomUUID()}.${mimeType.split('/')[1]}`); form.append('type', 'input');
      const result = await this.json(this.url('/upload/image'), { method: 'POST', body: form });
      uploaded.push((result.subfolder ? result.subfolder + '/' : '') + result.name);
    }
    const workflow = buildWorkflow({ prompt, size, names, encoder, uploaded });
    const queued = await this.json(this.url('/prompt'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: workflow, client_id: crypto.randomUUID() }) });
    if (!queued.prompt_id || Object.keys(queued.node_errors || {}).length) throw new Error('本地工作流校验失败，请检查模型与节点。');
    progress({ message: '本地采样中，首次加载权重可能较慢…' });
    for (let attempt = 0; attempt < 7200; attempt++) {
      const history = await this.json(this.url(`/history/${encodeURIComponent(queued.prompt_id)}`)), item = history[queued.prompt_id];
      if (item?.status?.status_str === 'error') throw new Error('本地推理失败：' + JSON.stringify(item.status.messages).slice(-1800));
      const outputs = item?.outputs?.['8']?.images;
      if (outputs?.length) {
        const result = [];
        for (const image of outputs) {
          const query = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || '', type: image.type || 'output' });
          const response = await fetch(this.url('/view?' + query), { signal: AbortSignal.timeout(30000) });
          if (!response.ok) throw new Error('无法读取本地输出图像。');
          result.push(`data:image/png;base64,${Buffer.from(await response.arrayBuffer()).toString('base64')}`);
        }
        return { images: result };
      }
      await sleep(1000);
    }
    throw new Error('本地生成超时。');
  }
}
function buildWorkflow({ prompt, size, names, encoder, uploaded }) {
  if (!names.lora) throw new Error('4 步生图必须加载指定的 Turbo LoRA。');
  const [width, height] = size.split('x').map(Number);
  if (![1024, 1536].includes(width) || ![1024, 1536].includes(height)) throw new Error('不支持的本地出图尺寸。');
  const workflow = {
    '1': { class_type: 'UnetLoaderGGUF', inputs: { unet_name: names.dit } },
    '2': { class_type: ['te-bf16', 'te-w4a8'].includes(encoder) ? 'CLIPLoader' : 'CLIPLoaderGGUF', inputs: { clip_name: names.encoder, type: 'qwen_image' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: names.vae } },
    '4': { class_type: 'TextEncodeQwenImage21', inputs: { clip: ['2', 0], prompt, negative_prompt: '', vae: ['3', 0], resolution: 1024 } },
    '5': { class_type: 'EmptyLatentImage', inputs: { width, height, batch_size: 1 } },
    '6': { class_type: 'KSampler', inputs: { model: ['9', 0], positive: ['4', 0], negative: ['4', 1], latent_image: uploaded.length ? ['4', 2] : ['5', 0], seed: crypto.randomInt(0, 2 ** 48 - 1), steps: 4, cfg: 1, sampler_name: 'euler', scheduler: 'simple', denoise: 1 } },
    '7': { class_type: 'VAEDecode', inputs: { samples: ['6', 0], vae: ['3', 0] } },
    '9': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: names.lora, strength_model: 1 } },
    '8': { class_type: 'SaveImage', inputs: { images: ['7', 0], filename_prefix: 'FigFactory' } },
  };
  uploaded.forEach((image, index) => { const id = String(100 + index); workflow[id] = { class_type: 'LoadImage', inputs: { image } }; workflow['4'].inputs[`images.image_${index + 1}`] = [id, 0]; });
  return workflow;
}
module.exports = { LocalEngine, buildWorkflow };
