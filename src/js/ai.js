import { marked } from '../vendor/markdown/marked.esm.js';
import DOMPurify from '../vendor/markdown/purify.es.mjs';
import { buildLocalStages } from './local-stages.mjs';
const $ = s => document.querySelector(s);
const DEFAULT_MODELS = [
  { id: 'inclusionai/ming-image-0.1-design', kind: 'image', protocol: 'openai-images', references: false, maxReferences: 0, note: '官方目录标记为仅文字输入，不能保留参考人脸。' },
  { id: 'inclusionai/ming-image-0.1-design-layer', kind: 'layer', protocol: 'openai-images', references: true, maxReferences: 1, note: '专用拆层：恰好一张参考图，返回多张透明 RGBA 层图，尺寸跟随原图。' },
  ...['openai/gpt-image-2.5-flare', 'openai/gpt-image-2.5-sunburst'].map(id => ({ id, kind: 'image', protocol: 'openai-images', references: true, maxReferences: 16, note: 'OpenAI Images：参考图编辑，开启高输入保真。' })),
  { id: 'klingai/kling-v3', kind: 'image', protocol: 'vertex-predict', references: true, maxReferences: 1, note: '公开目录未收录此名称；Kling 通用文档限制 1 张参考图，需验证具体模型。' },
  ...['qwen/qwen-image-3.0', 'qwen/qwen-image-3.0-pro'].map(id => ({ id, kind: 'image', protocol: 'vertex-predict', references: false, maxReferences: 0, note: '公开目录未收录此名称；参考图能力待确认，可在设置中修改。' })),
  ...['openai/gpt-6.1-sol', 'anthropic/claude-sonnet-5.5', 'google/gemini-3.8-flash'].map(id => ({ id, kind: 'text', protocol: 'chat', references: true, maxReferences: 16 })),
];
const PROTOCOLS = { 'openai-images': 'OpenAI Images', 'vertex-predict': 'Vertex :predict', 'gemini-content': 'Gemini Content', chat: 'Chat Completions' };

function openHistoryDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('bodyfactory-images', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('images', { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('无法打开本地图片历史。'));
  });
}
async function historyTransaction(mode, action) {
  const db = await openHistoryDB();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('images', mode);
    const request = action(transaction.objectStore('images'));
    transaction.oncomplete = () => { db.close(); resolve(request?.result); };
    transaction.onerror = () => { db.close(); reject(new Error('图片历史保存失败，可能本地存储空间不足。')); };
    transaction.onabort = transaction.onerror;
  });
}

export async function setupAI({ poseImage, characters, toast }) {
  const bridge = window.bodyFactory;
  const localMode = () => $('#ai-provider').value === 'local';
  let localStageLabel = '';
  const localModel = { id: 'local/Qwen-Image-2.1-Turbo-4step', kind: 'image', references: true, maxReferences: 16 };
  async function localCall(action, args = {}) {
    if (!bridge?.localAI) throw new Error('本地引擎需要 Electron 桌面应用。');
    const response = await bridge.localAI({ action, ...args });
    if (!response.ok) throw new Error(response.error);
    return response.result;
  }
  let localServiceSwitching = false;
  let localEngineStatus = null;
  function showLocalReadiness() {
    let message = '本地 AI：正在检查运行环境与权重…';
    if (localEngineStatus && localCatalog.length) {
      const { dit, encoder } = localSelection();
      const ids = [dit, encoder, ...(!['te-bf16', 'te-w4a8'].includes(encoder) ? ['vision'] : []), 'turbo-lora', 'vae'];
      const required = ids.map(id => localCatalog.find(item => item.id === id));
      const missing = required.filter(item => !item?.downloaded);
      if (required[0]?.runnable === false) {
        message = '本地 AI 尚未就绪：所选 MLX 主模型仅支持预下载，请选择 GGUF 主模型进行本地生图。';
      } else if (localEngineStatus.installed && !missing.length) {
        message = `✓ 本地 AI 已就绪：运行环境已安装，所选 ${required.length} 项权重均已下载并校验，可以本地生图。`;
      } else {
        const needs = [];
        if (!localEngineStatus.installed) needs.push(localEngineStatus.installing ? '运行环境正在安装' : '请在设置中安装本地引擎');
        if (missing.length) needs.push(`请下载并校验：${missing.map(item => item?.label || '所选模型').join('、')}`);
        message = `本地 AI 尚未就绪：${needs.join('；')}。`;
      }
    }
    for (const id of ['#local-readiness', '#local-settings-readiness']) $(id).textContent = message;
  }
  function renderLocalEngineState(state) {
    localEngineStatus = state;
    showLocalReadiness();
    let label = '本地生图服务：尚未启动';
    if (state.starting) label = '本地生图服务：正在启动…';
    else if (state.generating) label = '本地生图服务：正在生成；完成后空闲 2 分钟自动关闭';
    else if (state.running) label = `本地生图服务：运行中；空闲 ${Math.max(1, Math.ceil((state.idleRemainingMs ?? state.idleTimeoutMs) / 60000))} 分钟后自动关闭`;
    else if (state.installed) label = '本地生图服务：已关闭，需要生成时自动启动';
    else label = '本地生图服务：引擎尚未安装';
    ['#local-engine-state', '#local-engine-settings-state'].forEach(id => { if ($(id)) $(id).textContent = label; });
    for (const id of ['#local-service-toggle', '#local-service-settings-toggle']) {
      $(id).checked = state.running || state.starting;
      $(id).disabled = localServiceSwitching || state.starting || !state.installed;
    }
    if ($('#local-stop-now')) $('#local-stop-now').disabled = !state.running && !state.starting;
    if ($('#local-stop')) $('#local-stop').disabled = !state.running && !state.starting && !state.installing;
  }
  async function refreshLocalEngineState() {
    try { renderLocalEngineState(await localCall('status')); } catch { /* Refresh when the desktop bridge is available. */ }
  }
  for (const id of ['#local-service-toggle', '#local-service-settings-toggle']) $(id).onchange = async event => {
    if (localServiceSwitching) return;
    const action = event.target.checked ? 'start' : 'stop';
    localServiceSwitching = true;
    for (const toggle of ['#local-service-toggle', '#local-service-settings-toggle']) $(toggle).disabled = true;
    $('#local-engine-state').textContent = $('#local-engine-settings-state').textContent = action === 'start' ? '本地生图服务：正在启动…' : '本地生图服务：正在关闭…';
    try { await localCall(action); }
    catch (error) { $('#local-status').textContent = error.message; toast(error.message); }
    finally { localServiceSwitching = false; await refreshLocalEngineState(); }
  };
  let localCatalog = [], localBundled = false;
  function localSelection() { return { dit: $('#local-dit').value, encoder: $('#local-encoder').value, mirror: $('#local-mirror').value === 'mirror' }; }
  $('#local-mirror').value = localStorage.getItem('bodyfactory.local-mirror') || 'mirror';
  $('#local-mirror').onchange = () => localStorage.setItem('bodyfactory.local-mirror', $('#local-mirror').value);
  function showLocalCatalog() {
    const { dit, encoder } = localSelection();
    const ids = [dit, encoder, ...(!['te-bf16', 'te-w4a8'].includes(encoder) ? ['vision'] : []), 'turbo-lora', 'vae'];
    const items = localCatalog.filter(item => ids.includes(item.id));
    $('#local-catalog').textContent = items.map(item => `${item.label} · ${(item.size / 1024 ** 3).toFixed(2)} GiB · ${item.downloaded ? '已下载并校验' : '待下载'}`).join('；');
    $('#local-summary').textContent = `所选整套 ${(items.reduce((sum, item) => sum + item.size, 0) / 1024 ** 3).toFixed(2)} GiB；${items.length && items.every(item => item.downloaded) ? '权重齐全' : '权重未齐全'}。`;
    showLocalReadiness();
    if (localBundled) {
      $('#local-summary').textContent = '内置离线运行时：已包含并校验 Q4_K_M、Heretic、视觉投影、Turbo LoRA 与 VAE。';
      ['#local-refresh', '#local-download', '#local-cancel', '#local-install', '#local-mirror', '#local-download-dit', '#local-download-encoder'].forEach(id => { $(id).disabled = true; });
      $('#local-status').textContent = '内置引擎与权重已就绪；首次生成会加载到内存。';
    }
  }
  async function loadLocalCatalog(refresh = false) {
    localCatalog = await localCall('catalog', { refresh });
    localBundled = (await localCall('status')).bundled === true;
    for (const [id, group, fallback] of [['#local-dit', 'diffusion_models', 'dit-Q4_K_M'], ['#local-encoder', 'text_encoders', 'te-w4a8']]) {
      const old = $(id).value || localStorage.getItem('bodyfactory.' + id.slice(1)) || fallback;
      $(id).replaceChildren(...localCatalog.filter(item => item.group === group && (group !== 'text_encoders' || item.id.startsWith('te-'))).map(item => new Option(item.label, item.id)));
      $(id).value = old;
    }
    for (const key of ['dit', 'encoder']) { $('#local-download-' + key).replaceChildren(...[...$('#local-' + key).options].map(option => new Option(option.text, option.value))); $('#local-download-' + key).value = $('#local-' + key).value; }
    showLocalCatalog();
  }
  const cloudButtons = ['#btn-plan-layers', '#btn-discuss-layers', '#btn-split-layers'];
  function showProvider() {
    $('#local-controls').hidden = !localMode();
    $('#local-stage-controls').hidden = !localMode();
    $('#btn-optimize').textContent = localMode() ? '优化形体提示词' : '优化提示词';
    $('#ai-model-note').textContent = localMode() ? '本地 Qwen-Image-2.1 Turbo：固定 4 步 / CFG 1 / Euler / Simple；多参考合成可能重影，身份与服饰融合尚未通过画质验证。Apple Silicon + Q4_K_M + Heretic W4A8 已验证文生图和参考图编辑。首次使用请先在 AI 设置中下载并校验所需权重。' : models.find(model => model.id === $('#ai-model').value)?.note || '请确认模型的接口与参考图能力。';
    $('#ai-model').disabled = localMode() || busy;
    $('#edit-model').disabled = localMode() || busy;
    $('#ai-provider').disabled = busy;
    cloudButtons.forEach(id => { $(id).disabled = busy || localMode(); });
    $('#studio-layers').disabled = busy || localMode() || !currentImage;
  }
  $('#ai-provider').value = localStorage.getItem('bodyfactory.provider') || 'zenmux';
  $('#ai-provider').onchange = () => { localStorage.setItem('bodyfactory.provider', $('#ai-provider').value); showProvider(); if (localMode()) { refreshLocalEngineState(); if (!localCatalog.length) loadLocalCatalog().catch(error => status(error.message)); } };
  $('#local-settings').onclick = () => $('#settings-dialog').showModal();
  for (const key of ['dit', 'encoder']) for (const prefix of ['local-', 'local-download-']) $('#' + prefix + key).onchange = e => { $('#local-' + key).value = $('#local-download-' + key).value = e.target.value; localStorage.setItem('bodyfactory.local-' + key, e.target.value); showLocalCatalog(); };
  $('#settings-dialog').addEventListener('toggle', () => { if ($('#settings-dialog').open && !localCatalog.length) loadLocalCatalog().catch(error => { $('#local-status').textContent = error.message; }); });
  bridge?.onLocalProgress?.(data => {
    const text = data.message + (data.total ? ` · ${(100 * data.received / data.total).toFixed(1)}%` : '');
    $('#local-status').textContent = text;
    $('#local-progress').hidden = !data.total;
    if (data.total) { $('#local-progress').max = data.total; $('#local-progress').value = data.received; }
    if (busy && localMode()) status(localStageLabel ? `${localStageLabel}：${text}` : text, $('#image-dialog').open);
  });
  let localOperation = false;
  for (const [id, action] of [['#local-refresh', 'catalog'], ['#local-download', 'download'], ['#local-cancel', 'cancel-download'], ['#local-install', 'install'], ['#local-start', 'start'], ['#local-stop', 'stop'], ['#local-stop-now', 'stop'], ['#local-folder', 'open-models']]) $(id).onclick = async () => {
    const independent = ['stop', 'cancel-download', 'open-models'].includes(action);
    if (localOperation && !independent) return;
    if (!independent) localOperation = true;
    $(id).disabled = true;
    try {
      if (!localCatalog.length && action === 'download') await loadLocalCatalog();
      await localCall(action, { ...localSelection(), refresh: true });
      if (['catalog', 'download'].includes(action)) await loadLocalCatalog();
      const state = await localCall('status');
      renderLocalEngineState(state);
      $('#local-status').textContent = `${state.platform === 'darwin' && state.arch === 'arm64' ? 'Apple Silicon · MPS GPU · ' : ''}${(state.memory / 1024 ** 3).toFixed(0)} GiB 内存。${state.bundled ? '内置离线运行时；' : ''}${action === 'stop' ? '引擎已停止。' : action === 'cancel-download' ? '已请求取消下载。' : '操作完成。'}引擎${state.running ? '运行中' : state.installed ? '已安装' : '未安装'}。`;
    } catch (error) { $('#local-status').textContent = error.message; }
    finally { $(id).disabled = false; if (!independent) localOperation = false; }
  };
  $('#settings-dialog').addEventListener('toggle', () => { if ($('#settings-dialog').open) refreshLocalEngineState(); });
  const localStatePoll = setInterval(() => { if (localMode() || $('#settings-dialog').open) refreshLocalEngineState(); }, 2000);
  window.addEventListener('pagehide', () => clearInterval(localStatePoll), { once: true });
  const posePreference = 'bodyfactory.use-pose';
  $('#ai-use-pose').checked = localStorage.getItem(posePreference) === 'true';
  const savePosePreference = () => localStorage.setItem(posePreference, String($('#ai-use-pose').checked));
  $('#ai-use-pose').addEventListener('change', savePosePreference);
  window.addEventListener('pose-reference-changed', savePosePreference);
  $('#ui-theme').value = document.documentElement.dataset.theme || 'dark';
  bridge?.setTheme?.($('#ui-theme').value);
  $('#ui-theme').onchange = e => {
    const theme = e.target.value;
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('bodyfactory.theme', theme);
    bridge?.setTheme?.(theme);
  };
  let models = structuredClone(DEFAULT_MODELS), references = [], busy = false;
  let currentImage = null, original = null, strokes = [], drawing = false, panning = false;
  let zoom = 1, offsetX = 0, offsetY = 0, panStart = null;
  const editCanvas = $('#edit-canvas'), context = editCanvas.getContext('2d');
  let selectedHistory = new Set(), layerImages = [], savedModels = structuredClone(models);
  const promptStorageKey = 'bodyfactory.prompt-optimization';
  let promptState = { runs: [], final: '' };
  try {
    const saved = JSON.parse(localStorage.getItem(promptStorageKey));
    if (saved && Array.isArray(saved.runs) && typeof saved.final === 'string') promptState = { runs: saved.runs.slice(-1), final: saved.final, sceneSignature: saved.sceneSignature || '', scope: saved.scope || '' };
  } catch { /* No saved optimization yet. */ }
  function markdown(element, text) {
    element.innerHTML = DOMPurify.sanitize(marked.parse(text || ''), { USE_PROFILES: { html: true } });
  }
  function savePrompts() { localStorage.setItem(promptStorageKey, JSON.stringify(promptState)); }
  function showFinal() {
    $('#ai-final-prompt').value = promptState.final;
    $('#final-prompt-section').hidden = !promptState.final;
    markdown($('#final-prompt-preview'), promptState.final);
  }
  function addPromptRun(run) {
    $('#prompt-process').hidden = false;
    const section = document.createElement('details'); section.open = true;
    const heading = document.createElement('summary');
    heading.textContent = `${new Date(run.createdAt).toLocaleString()} · ${run.pipeline ? '三模型协作' : '提示词优化'}`;
    const source = document.createElement('div'); source.className = 'markdown-output';
    markdown(source, run.source);
    section.append(heading, source);
    const outputs = run.stages.map(stage => {
      const title = document.createElement('h4'); title.textContent = `${stage.label} · ${stage.model}`;
      const output = document.createElement('div'); output.className = 'markdown-output prompt-stage';
      markdown(output, stage.text); section.append(title, output); return output;
    });
    if (run.error) { const error = document.createElement('p'); error.textContent = run.error; section.append(error); }
    $('#prompt-runs').prepend(section); return outputs;
  }
  promptState.runs.forEach(addPromptRun); showFinal(); savePrompts();
  $('#ai-final-prompt').oninput = e => {
    promptState.final = e.target.value; markdown($('#final-prompt-preview'), promptState.final); savePrompts();
  };
  function status(message, edit = false) {
    $(edit ? '#edit-status' : '#ai-status').textContent = message;
    if (!edit) { $('#studio-feedback').textContent = message; $('#studio-progress p').textContent = message; }
  }
  function setBusy(value) {
    busy = value;
    $('#studio-progress').hidden = !value;
    $('#btn-generate').textContent = value ? '处理中…' : '生成图像';
    ['#btn-generate', '#btn-optimize', '#btn-pipeline', '#btn-edit-image', '#btn-plan-layers', '#btn-discuss-layers', '#btn-split-layers', '#btn-scene-prompt'].forEach(id => { $(id).disabled = value; });
    ['#btn-pose-editor', '#ai-identity-contract', '#ai-use-pose', '#ai-prompt', '#ai-final-prompt', '#ai-model', '#ai-optimizer', '#ref-kind', '#ref-person', '#btn-ref', '#ai-use-scene', '#ai-scene-source', '#ai-lighting-source', '#ai-scene-prompt', '#ai-clothing-prompt', '#ai-pose-prompt', '#local-use-face', '#local-use-clothing'].forEach(id => { $(id).disabled = value; });
    showProvider();
    $('#ref-person').disabled = value || $('#ref-kind').value === 'scene';
    ['#studio-copy', '#studio-save', '#studio-edit', '#studio-layers'].forEach(id => { $(id).disabled = value || !currentImage; });
  }
  function fillModelSelect(id, list) {
    const select = $(id), previous = select.value;
    select.replaceChildren(...list.map(m => new Option(m.id, m.id)));
    if (list.some(m => m.id === previous)) select.value = previous;
  }
  function refreshModels() {
    const hadImageModel = $('#ai-model').value;
    fillModelSelect('#ai-model', models.filter(m => m.kind === 'image'));
    if (!hadImageModel && models.some(m => m.id === 'openai/gpt-image-2.5-flare')) $('#ai-model').value = 'openai/gpt-image-2.5-flare';
    fillModelSelect('#edit-model', models.filter(m => m.kind === 'image' && m.references));
    fillModelSelect('#ai-optimizer', models.filter(m => m.kind === 'text'));
    fillModelSelect('#layer-planner', models.filter(m => m.kind === 'text'));
    fillModelSelect('#layer-model', models.filter(m => m.kind === 'layer'));
    $('#ai-model-note').textContent = $('#ai-model').value === 'x-ai/grok-imagine-image-2.0' ? 'Grok 2.0：自动使用 1k 分辨率档位，按出图比例设置画幅，不发送 GPT 专属参数。' : models.find(m => m.id === $('#ai-model').value)?.note || '请确认该模型的接口和参考图能力。';
    if (localMode()) showProvider();
  }
  function updatePeople() {
    const select = $('#ref-person'), previous = select.value;
    select.replaceChildren(...characters().map(person => new Option(`人偶 ${person.id}`, person.id)));
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  }
  $('#figure-count').addEventListener('change', updatePeople);
  $('#ref-person').addEventListener('focus', updatePeople);
  $('#ref-kind').onchange = () => { $('#ref-person').disabled = $('#ref-kind').value === 'scene'; };
  function renderReferences() {
    $('#ref-thumbs').replaceChildren(...references.map((reference, index) => {
      const box = document.createElement('div'); box.className = 'ref-thumb';
      const image = new Image(); image.src = reference.url; image.alt = '参考图';
      const label = document.createElement('span'); label.textContent = reference.kind === 'scene' ? ($('#ai-use-scene').checked ? '场景参考 · 已启用' : '场景参考 · 已关闭') : `人偶 ${reference.person}${reference.kind === 'face' ? ' · 权威身份图' : ''}`;
      const kind = document.createElement('select'); kind.className = 'ref-kind-select'; kind.setAttribute('aria-label', `参考图 ${index + 1} 类型`);
      kind.append(new Option('人脸', 'face'), new Option('服饰', 'clothing'), new Option('场景', 'scene')); kind.value = reference.kind;
      kind.onchange = () => { if (busy) { kind.value = reference.kind; return; } reference.kind = kind.value; if (reference.kind === 'scene') $('#ai-use-scene').checked = true; renderReferences(); saveScene(); };
      const remove = document.createElement('button'); remove.textContent = '×'; remove.title = '删除参考图';
      remove.onclick = () => { if (busy) return; references.splice(index, 1); renderReferences(); saveScene(); };
      box.append(image, remove, label, kind); return box;
    }));
  }
  async function addFiles(files) {
    if (busy) return;
    try {
      const person = Number($('#ref-person').value), kind = $('#ref-kind').value;
      for (const file of files) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请使用 PNG、JPEG 或 WebP 图片。');
        if (file.size > 20 * 1024 * 1024) throw new Error('单张参考图不能超过 20 MB。');
        const url = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
        references.push({ id: crypto.randomUUID(), url, person, kind });
        if (kind === 'scene') $('#ai-use-scene').checked = true;
      }
    } catch (err) { status(err.message); }
    renderReferences(); saveScene();
  }
  $('#btn-ref').onclick = () => $('#ref-file').click();
  $('#ref-file').onchange = async e => { await addFiles(e.target.files); e.target.value = ''; };
  window.addEventListener('paste', e => {
    if (document.querySelector('dialog[open]')) return;
    const files = [...(e.clipboardData?.items || [])].filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  async function request(args, onText, textOutput) {
    if (localMode() && args.purpose === 'image') {
      return await localCall('generate', { prompt: args.prompt, images: args.images, size: args.size, ...localSelection() });
    }
    if (!bridge?.requestAI) throw new Error('AI 功能需要 Electron 桌面应用，请使用 npm start 启动。');
    $('#ai-error-details').hidden = true;
    const requestId = crypto.randomUUID();
    const output = textOutput || ($('#image-dialog').open ? $('#layer-stream-output') : $('#ai-stream-output'));
    if (args.purpose === 'text') { output.hidden = false; output.textContent = ''; }
    const unsubscribe = args.purpose === 'text' ? bridge.onAIText?.(data => {
      if (data.requestId !== requestId) return;
      markdown(output, data.text);
      onText?.(data.text);
    }) : null;
    let response;
    try { response = await bridge.requestAI({ ...args, stream: args.purpose === 'text', requestId }); }
    finally { unsubscribe?.(); }
    if (args.purpose === 'text' && response.ok) { markdown(output, response.text); onText?.(response.text); }
    if (!response.ok) {
      if (response.diagnostics) {
        const info = response.diagnostics;
        $('#ai-error-diagnostics').textContent = `模型：${info.model}\n接口：${info.endpoint}\n提交方式：${info.transport}\n参考图：${info.referenceImages} 张\nHTTP：${info.status}\n错误类型：${info.errorType || '未提供'}\n请求编号：${info.requestId || '未提供'}`;
        $('#ai-error-details').hidden = false;
      }
      throw new Error(response.error);
    }
    return response;
  }
  function characterPrompt(people = characters()) {
    const clothing = references.filter(reference => reference.kind === 'clothing');
    const clothingConstraint = clothing.length ? `【服饰约束】${clothing.map(reference => `人偶 ${reference.person}`).join('、')}必须穿着对应服饰参考图中的衣服，忠实匹配款式、颜色、材质、长度、领型和细节。服饰参考优先于旧提示词中冲突的衣着描述，不得替换为默认日常服装或人脸照片里的衣服；保持当前姿态，衣物自然随姿态变形。` : '';
    if (!$('#ai-use-pose').checked) return references.length ? clothingConstraint + '参考图中的人脸仅用于对应人物身份，忠实保留脸型、五官、肤色，不混合不同人物面孔；服饰参考只用于对应人物衣着。人物编号仅用于参考图绑定，不在最终图像中显示。' : '';
    for (const reference of references) if (reference.kind !== 'scene' && !people.some(p => p.id === reference.person)) throw new Error(`参考图对应的人偶 ${reference.person} 已被移除，请删除该参考图。`);
    return `${clothingConstraint}\n【当前姿态强制约束】图片 ${references.filter(reference => reference.kind === 'face').length + 1} 是本次生图的人物姿态与相对位置依据，背景、环境和照明由场景参考与场景提示词决定，优先于后续参考照片和提示词中冲突的动作描述。逐一匹配各人物的头部朝向、躯干倾斜、髋部位置、手臂与手掌位置、腿部弯曲和双脚位置；坐姿必须保持坐姿，不得改为站姿。后续人脸和服饰照片只提取身份或衣着，禁止复制它们的身体动作、站姿、相机视角或构图。画面中必须有 ${people.length} 个人物。人物资料：${JSON.stringify(people)}（height 单位为厘米，weight 单位为公斤）。人偶形态参考图仅用于各人物的姿态、体型比例、相对位置和相机视角，不复制人偶的裸露表面、塑料材质或关节结构。服装以用户提示词和对应服饰参考为准；用户未指定衣着时，人物默认穿着完整日常服装（上衣、长裤和鞋），身体由衣物自然遮盖，不生成裸体或内衣造型。最终人物的真实感或风格以用户提示词为准。人偶编号以形态参考图头部蓝色数字标签为准，最终图像不保留数字标签。人脸参考用于对应人物身份，忠实保留脸型、眼睛、鼻子、嘴唇、肤色和独特五官，不混合不同人物的面孔。服饰参考仅用于对应人物的衣着。`;
  }
  const sceneStorageKey = 'bodyfactory.scene-lighting';
  let sceneState = { enabled: false, source: '', lighting: '', prompt: '' };
  try {
    const saved = JSON.parse(localStorage.getItem(sceneStorageKey));
    if (saved && typeof saved.source === 'string' && typeof saved.lighting === 'string' && typeof saved.prompt === 'string') sceneState = saved;
  } catch { /* No saved scene yet. */ }
  $('#ai-use-scene').checked = !!sceneState.enabled;
  $('#ai-scene-source').value = sceneState.source;
  $('#ai-lighting-source').value = sceneState.lighting;
  $('#ai-scene-prompt').value = sceneState.prompt;
  function sceneSettingsSignature() {
    return $('#ai-use-scene').checked ? JSON.stringify([$('#ai-scene-source').value, $('#ai-lighting-source').value, $('#ai-scene-prompt').value, references.filter(r => r.kind === 'scene').map(r => r.id)]) : '';
  }
  function saveScene() {
    sceneState = { enabled: $('#ai-use-scene').checked, source: $('#ai-scene-source').value, lighting: $('#ai-lighting-source').value, prompt: $('#ai-scene-prompt').value };
    localStorage.setItem(sceneStorageKey, JSON.stringify(sceneState));
    if (promptState.scope !== 'body' && promptState.final && promptState.sceneSignature && promptState.sceneSignature !== sceneSettingsSignature()) {
      promptState.final = ''; promptState.sceneSignature = ''; showFinal(); savePrompts();
      status('场景设置已变更，请重新优化提示词。');
    }
    $('#scene-prompt-preview').hidden = !sceneState.prompt;
    markdown($('#scene-prompt-preview'), sceneState.prompt);
  }
  saveScene();
  $('#ai-use-scene').onchange = () => { saveScene(); renderReferences(); };
  $('#ai-scene-prompt').oninput = saveScene;
  for (const id of ['#ai-scene-source', '#ai-lighting-source']) $(id).oninput = () => { $('#ai-scene-prompt').value = ''; saveScene(); };
  function scenePrompt(people = characters()) {
    const text = [$('#ai-scene-source').value.trim() && `场景要求：${$('#ai-scene-source').value.trim()}`, $('#ai-lighting-source').value.trim() && `照明要求：${$('#ai-lighting-source').value.trim()}`, $('#ai-scene-prompt').value.trim()].filter(Boolean).join('\n');
    return [characterPrompt(people), identityContract(), (references.some(r => r.kind === 'clothing') || $('#ai-clothing-prompt').value !== autoPrompts.clothingPrompt?.value) && $('#ai-clothing-prompt').value.trim() ? `服饰提示词：${$('#ai-clothing-prompt').value.trim()}` : '', $('#ai-use-pose').checked && $('#ai-pose-prompt').value.trim() ? `形态提示词：${$('#ai-pose-prompt').value.trim()}` : '', $('#ai-use-scene').checked && text ? `【场景与照明】${text}\n场景参考与当前场景要求优先于原始或旧最终提示词中冲突的背景描述；必须将人物置于指定环境中，不能以人偶截图、人脸或服饰照片的白底替代场景。人偶截图只提供人物姿态，不提供背景或灯光。仅用于环境、背景和照明。保持当前人物人数、人脸、服饰及姿态约束，光线作用于人物和环境时应一致。` : ''].filter(Boolean).join('\n');
  }
  $('#btn-scene-prompt').onclick = async () => {
    if (busy) return;
    setBusy(true); status('正在生成场景与照明提示词…');
    try {
      const source = $('#ai-scene-source').value.trim(), lighting = $('#ai-lighting-source').value.trim();
      const sceneImages = references.filter(reference => reference.kind === 'scene').map(reference => reference.url);
      if (!source && !lighting && !sceneImages.length) throw new Error('请填写场景或灯光要求，或添加场景参考图。');
      const model = models.find(m => m.id === $('#ai-optimizer').value && m.kind === 'text');
      if (!model) throw new Error('请选择可用的提示词优化模型。');
      if (sceneImages.length && !model.references) throw new Error('所选文字模型不支持场景参考图，请选择支持图像输入的模型。');
      $('#ai-scene-prompt').value = ''; saveScene();
      const result = await request({ model, purpose: 'text', images: sceneImages, prompt: `只生成场景与照明提示词。${sceneImages.length ? '结合输入场景参考图，提取空间布局、背景材质和照明关系，不复制图中人物的身份、衣着、动作。用户文字要求优先于场景照片中的环境细节。' : ''}，可用 Markdown 分为场景和照明两部分。场景要求：${source || '环境保持简洁，不虚构特定地点'}。照明要求：${lighting || '根据场景匹配自然且一致的光线'}。明确空间布局、背景元素、材质、景深，以及光源位置和方向、柔硬程度、色温、主光与补光、阴影和环境光。不要改变人物数量、身份、服饰、姿态或添加无关人物，不要输出讲解。` }, text => { $('#ai-scene-prompt').value = text; saveScene(); }, $('#scene-prompt-preview'));
      $('#ai-scene-prompt').value = result.text; saveScene();
      status('场景与照明提示词已生成；开启开关后用于生图。');
    } catch (err) { status(err.message); }
    finally { setBusy(false); }
  };
  $('#ai-identity-contract').value = localStorage.getItem('bodyfactory.identity-contract') || '';
  $('#ai-identity-contract').oninput = () => localStorage.setItem('bodyfactory.identity-contract', $('#ai-identity-contract').value);
  function identityContract() {
    const anchors = references.filter(reference => reference.kind === 'face');
    if (!anchors.length) return '';
    return `【身份合同：最高优先级】${anchors.map((reference, index) => `人偶 ${reference.person} 的唯一权威身份是图片 ${index + 1}。不可变：该图的脸型比例、眼型与眼色、鼻唇结构、发际线、发型、肤色、年龄感，以及可辨认的痣、疤、眼镜与耳饰。只借身份，不借该图的服装、动作、背景和打光。禁止混入其他参考图中的人脸、改变发型与标志特征、无要求添加配饰或美颜磨皮。`).join('\n')}\n允许修改：仅当前需求指定的服饰、场景、灯光和姿态，分别服从对应参考；不要改变身份。禁止将上一次生成结果当作新身份图，未经用户批准不得替换权威图。${$('#ai-identity-contract').value.trim() ? `\n用户固定身份合同（原样保留）：\n${$('#ai-identity-contract').value}` : ''}`;
  }
  function identityAnchors() {
    const anchors = references.filter(reference => reference.kind === 'face');
    for (const reference of anchors) if (anchors.filter(other => other.person === reference.person).length > 1) throw new Error(`人偶 ${reference.person} 有多张人脸参考。请仅保留一张权威身份图，避免面孔混合。`);
    return anchors;
  }
  function inputReferences() {
    const images = [], labels = [], anchors = localMode() && !$('#local-use-face').checked ? [] : identityAnchors();
    for (const reference of anchors) {
      images.push(reference.url); labels.push(`图片 ${images.length}：人偶 ${reference.person} 的人脸身份锚点，唯一权威身份图。借用脸型、五官、发际线、发型、肤色、年龄和标志特征；这些不可改变。不借服装、姿态、背景和打光。`);
    }
    if ($('#ai-use-pose').checked) { images.push(poseImage()); labels.push(`图片 ${images.length}：当前人偶姿态图，本次重新捕获，唯一姿态依据；只借姿态、体型比例和人物相对位置，忽略截图背景、地面网格、灯光及人偶材质。`); }
    for (const reference of references) {
      if (reference.kind === 'face') continue;
      if (reference.kind === 'clothing' && localMode() && !$('#local-use-clothing').checked) continue;
      if (reference.kind === 'scene') {
        if ($('#ai-use-scene').checked) { images.push(reference.url); labels.push(`图片 ${images.length}：场景与照明参考，必须应用该环境布局、背景材质与灯光，将人物融入此场景，优先于其他图片的背景，不复制图中人物、人脸、服饰或身体姿态。`); }
        continue;
      }
      images.push(reference.url); labels.push(anchors.length ? `图片 ${images.length}：人偶 ${reference.person} 的服饰参考，只借衣服剪裁、款式、颜色、材质、配饰和细节，不借面孔、发型、肤色、身体动作或背景；身份必须服从权威人脸图。` : `图片 ${images.length}：人偶 ${reference.person} 的服饰参考，仅用于衣服样式，忽略该照片的身体姿态与构图。`);
    }
    return { images, labels: labels.join('\n') };
  }
  function checkGenerationReferences(model, images, checkedReferences = references) {
    const people = characters();
    for (const reference of checkedReferences) {
      if (!['face', 'clothing', 'scene'].includes(reference.kind) || !reference.url) throw new Error('参考图类型或内容无效，请重新添加。');
      if (reference.kind !== 'scene' && !people.some(person => person.id === reference.person)) throw new Error(`参考图对应的人偶 ${reference.person} 已被移除，请重新绑定或删除该参考图。`);
    }
    if (!model || model.kind !== 'image') throw new Error('请选择可用的生图模型。');
    if (images.length && !model.references) throw new Error('所选生图模型不支持参考图，请更换模型。');
    if (images.length > model.maxReferences) throw new Error(`所选模型最多接收 ${model.maxReferences} 张参考图，当前 ${images.length} 张；请更换模型或减少参考图。`);
    const counts = kind => references.filter(reference => reference.kind === kind).length;
    const scene = counts('scene');
    $('#ai-reference-check').textContent = `本次参考检查：人脸 ${counts('face')} 张${counts('face') ? '（权威身份图）' : '（未锁定身份）'}；服饰 ${counts('clothing')} 张；形态${$('#ai-use-pose').checked ? '已启用（本次姿态）' : '已关闭'}；场景${$('#ai-use-scene').checked ? `已启用（${scene} 张图及场景、照明文字）` : `已关闭（${scene} 张场景图不发送）`}。涂鸦通过“涂鸦修图”使用。`;
  }
  async function remember(images, prompt, model, parentId = null, stage = null) {
    for (const url of images) {
      const item = { id: crypto.randomUUID(), url, prompt, model: model.id, created: Date.now(), parentId, stage };
      currentImage = item;
      try { await historyTransaction('readwrite', store => store.put(item)); }
      catch (err) { toast('图片已生成，但历史保存失败；请立即另存为。'); status(err.message); }
    }
    selectResult(currentImage);
    await refreshGallery();
    if (parentId) await showImage(currentImage);
  }
  const autoPromptKey = 'bodyfactory.auto-reference-prompts';
  let autoPrompts = {};
  try { autoPrompts = JSON.parse(localStorage.getItem(autoPromptKey)) || {}; } catch { /* No automatic descriptions yet. */ }
  const autoFields = { originalPrompt: '#ai-prompt', clothingPrompt: '#ai-clothing-prompt', posePrompt: '#ai-pose-prompt', sceneSource: '#ai-scene-source', lightingSource: '#ai-lighting-source', scenePrompt: '#ai-scene-prompt' };
  for (const key of ['clothingPrompt', 'posePrompt']) {
    const saved = autoPrompts[key]?.savedValue ?? autoPrompts[key]?.value;
    if (typeof saved === 'string') $(autoFields[key]).value = saved;
    $(autoFields[key]).oninput = () => { autoPrompts[key] = { ...autoPrompts[key], savedValue: $(autoFields[key]).value }; localStorage.setItem(autoPromptKey, JSON.stringify(autoPrompts)); };
  }
  function clearGenerationCache() {
    const final = $('#ai-final-prompt').value;
    for (const [key, id] of Object.entries(autoFields)) {
      if ($(id).value === autoPrompts[key]?.value) $(id).value = '';
    }
    autoPrompts = Object.fromEntries(['clothingPrompt', 'posePrompt'].map(key => [key, { savedValue: $(autoFields[key]).value }]));
    localStorage.removeItem(autoPromptKey);
    localStorage.setItem(autoPromptKey, JSON.stringify(autoPrompts));
    // Current final text is an explicit input to this review; never reuse the previous review.
    promptState.final = final; promptState.sceneSignature = ''; savePrompts(); saveScene();
    $('#ai-request-review').hidden = true;
    $('#ai-request-preview').replaceChildren();
  }
  async function completeReferencePrompts(images, labels, people) {
    const allowed = new Set(['originalPrompt', ...(references.some(r => r.kind === 'clothing') || $('#ai-clothing-prompt').value.trim() ? ['clothingPrompt'] : []), ...($('#ai-use-pose').checked ? ['posePrompt'] : []), ...($('#ai-use-scene').checked ? ['sceneSource', 'lightingSource', 'scenePrompt'] : [])]);
    const identityAnchored = references.some(reference => reference.kind === 'face');
    const manual = Object.fromEntries(Object.entries(autoFields).filter(([key]) => allowed.has(key)).map(([key, id]) => [key, $(id).value === autoPrompts[key]?.value ? '' : $(id).value]));
    const context = JSON.stringify({ images, labels, people: $('#ai-use-pose').checked ? people : [], manual, final: $('#ai-final-prompt').value, pose: $('#ai-use-pose').checked, scene: $('#ai-use-scene').checked });
    const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(context));
    const signature = [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2, '0')).join('');
    const active = [
      ...(!$('#ai-final-prompt').value.trim() && (!$('#ai-prompt').value.trim() || $('#ai-prompt').value === autoPrompts.originalPrompt?.value) ? ['originalPrompt'] : []),
      ...(references.some(r => r.kind === 'clothing') ? ['clothingPrompt'] : []),
      ...($('#ai-use-pose').checked ? ['posePrompt'] : []),
      ...($('#ai-use-scene').checked ? ['sceneSource', 'lightingSource', 'scenePrompt'] : []),
    ];
    for (const key of active) if (autoPrompts[key]?.signature !== signature && $(autoFields[key]).value === autoPrompts[key]?.value) { $(autoFields[key]).value = ''; autoPrompts[key].savedValue = ''; }
    const missing = active.filter(key => !$(autoFields[key]).value.trim());
    const reviewNeeded = identityAnchored || images.length && autoPrompts.referenceReview?.signature !== signature;
    if (!missing.length && !reviewNeeded) return;
    if (!images.length && !$('#ai-final-prompt').value.trim() && ![...allowed].some(key => $(autoFields[key]).value.trim())) throw new Error('请填写提示词或添加已启用的参考图。');
    const model = models.find(m => m.id === $('#ai-optimizer').value && m.kind === 'text');
    if (!model || (images.length && !model.references)) throw new Error('自动补全需要支持图像输入的文字模型；请切换模型或手动填写空白提示词。');
    status(identityAnchored ? '已清除上次自动内容，正在重新审视身份图、全部当前参考与最终提示词…' : '正在分析参考图，补全空白提示词…');
    const existing = Object.fromEntries(Object.entries(autoFields).filter(([key]) => allowed.has(key)).map(([key, id]) => [key, $(id).value]));
    const result = await request({ model, purpose: 'text', images, prompt: `生图前自动补全。只输出 JSON 对象，键为 ${[...missing, ...(reviewNeeded ? ['referenceReview'] : []), ...(identityAnchored ? ['identityIssues'] : [])].join('、')}，每个提示词值为非空中文文本。${identityAnchored ? 'identityIssues 为字符串数组（无问题时 []），仅列出无法解决的身份问题，例如权威脸图五官不可辨认，或用户要求改脸型、发型、年龄、眼色而违背固定身份合同；有问题必须说明需用户如何处理，不得擅自融合身份。' : ''}只补全这些空字段，不覆盖已有内容。referenceReview 必须逐一核对所有输入图片及当前文字要求，汇总对应人物的人脸身份、服饰、姿态与体型、场景空间布局、灯光和阴影，明确每类参考的用途及冲突处理：人偶只决定姿态与体型，服饰图只决定衣着，人脸图只决定身份，场景图决定背景与照明；忽略其他图片的背景，不遗漏任何已启用参考。没有图片的类别不虚构。场景开启时，将人物自然放入场景，禁止复制人偶的白底。图片用途：${labels}。身份合同：${identityContract()}。当前人物资料：${JSON.stringify($('#ai-use-pose').checked ? people : [])}。已有内容：${JSON.stringify(existing)}。最终提示词：${$('#ai-final-prompt').value}。originalPrompt 概括用户需求；clothingPrompt 按对应服饰图描述衣服的颜色、款式、材质和细节，注明人物编号，不复制衣服照片的姿态；posePrompt 按当前人偶描述身体朝向、躯干、手臂、腿和脚的位置及体型，不复制人脸或场景照片中的动作；sceneSource 描述场景图的空间布局与背景；lightingSource 描述图中光源方向、色温、柔硬程度、补光和阴影；scenePrompt 综合场景与照明。没有场景图时，仅按已有需求给出简洁适合的背景及一致照明，不编造特定地点、无关物件或新人物。人脸图只用于身份，不从中复制服装或背景。` }, null, document.createElement('div'));
    let values;
    try { values = JSON.parse(result.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
    catch { throw new Error('AI 自动补全未返回有效结果，请重试或手动填写空白提示词。'); }
    if (!values || (reviewNeeded && (typeof values.referenceReview !== 'string' || !values.referenceReview.trim())) || missing.some(key => typeof values[key] !== 'string' || !values[key].trim())) throw new Error('AI 未补全所有空白提示词，请重试或手动填写。');
    if (identityAnchored && (!Array.isArray(values.identityIssues) || values.identityIssues.some(issue => typeof issue !== 'string'))) throw new Error('AI 未完成身份一致性检查，请重试。');
    if (identityAnchored && values.identityIssues.length) throw new Error(`身份检查需要处理：${values.identityIssues.join('；')}`);
    for (const key of missing) {
      const value = values[key].trim(); $(autoFields[key]).value = value; autoPrompts[key] = { value, savedValue: value, signature };
    }
    if (reviewNeeded) autoPrompts.referenceReview = { value: values.referenceReview.trim(), signature };
    localStorage.setItem(autoPromptKey, JSON.stringify(autoPrompts));
    saveScene();
  }
  $('#btn-generate').onclick = async () => {
    if (busy) return;
    setBusy(true); status('正在生成，请稍候…');
    try {
      const model = localMode() ? localModel : models.find(m => m.id === $('#ai-model').value);
      if (localMode()) {
        await generateLocalStages(model);
        return;
      }
      if (references.some(reference => reference.kind === 'face')) clearGenerationCache();
      else { $('#ai-request-review').hidden = true; $('#ai-request-preview').replaceChildren(); }
      const { images, labels } = inputReferences();
      const people = structuredClone(characters());
      checkGenerationReferences(model, images);
      if (!localMode()) await completeReferencePrompts(images, labels, people);
      else clearGenerationCache();
      const text = ($('#ai-final-prompt').value || $('#ai-prompt').value).trim(); if (!text) throw new Error('请填写提示词。');
      status('提示词已就绪，正在生成图像…');
      const prompt = `${text}\n${localMode() && images.length > 1 ? '将各参考的指定特征整合到同一张自然完整的图像中。每个人物只有一个正常大小的头部与一具身体，服装真实穿在该人物身上；不要叠加参考照片、拼贴、双重曝光、透明人脸、重影或重复人物。' : ''}\n${scenePrompt(people)}\n${!localMode() && images.length && autoPrompts.referenceReview?.value ? `【本次参考综合检查】${autoPrompts.referenceReview.value}` : ''}\n${labels}`;
      markdown($('#ai-request-preview'), prompt); $('#ai-request-review').hidden = false;
      const result = await request({ model, prompt, images, size: imageSize(), purpose: 'image' });
      await remember(result.images, prompt, model); status('已生成并保存到本地历史。');
    } catch (err) { status(err.message); }
    finally { setBusy(false); if (!currentImage) { $('#studio-edit').disabled = $('#studio-layers').disabled = true; } }
  };
  for (const id of ['local-use-face', 'local-use-clothing']) {
    const saved = localStorage.getItem(`bodyfactory.${id}`);
    if (saved !== null) $('#' + id).checked = saved === 'true';
    $('#' + id).onchange = () => { localStorage.setItem(`bodyfactory.${id}`, String($('#' + id).checked)); renderReferences(); };
  }
  async function generateLocalStages(model) {
    clearGenerationCache();
    const text = (promptState.scope === 'body' ? ($('#ai-final-prompt').value || $('#ai-prompt').value) : $('#ai-prompt').value).trim();
    if (!text) throw new Error('请填写提示词。');
    const people = structuredClone(characters());
    const bodyText = promptState.scope === 'body' ? text : $('#ai-prompt').value.trim();
    if (!bodyText) throw new Error('请填写原始形体需求，或重新点击“优化形体提示词”；旧综合提示词不能直接作为形体步骤输入。');
    const face = $('#local-use-face').checked, clothing = $('#local-use-clothing').checked, scene = $('#ai-use-scene').checked;
    const activeReferences = references.filter(reference => ({ face, clothing, scene })[reference.kind]);
    if (face) identityAnchors();
    checkGenerationReferences(model, [], activeReferences);
    const stages = buildLocalStages({ text, bodyText, people, references: activeReferences, face, clothing, scene,
      poseImage: $('#ai-use-pose').checked ? poseImage() : null,
      posePrompt: $('#ai-use-pose').checked ? $('#ai-pose-prompt').value.trim() : '',
      clothingPrompt: $('#ai-clothing-prompt').value.trim(),
      scenePrompt: [$('#ai-scene-source').value, $('#ai-lighting-source').value, $('#ai-scene-prompt').value].filter(Boolean).join('\n'),
      identity: $('#ai-identity-contract').value.trim(),
    });
    const rows = stages.map(stage => { const row = document.createElement('li'); row.textContent = `${stage.label} · 等待`; return row; });
    $('#local-stage-progress').replaceChildren(...rows);
    $('#ai-reference-check').textContent = `本次人数：${people.length}；本地执行顺序：${stages.map(stage => stage.label).join(' → ')}。每一步只接收当前底图和该步参考，关闭或没有参考的步骤已跳过。`;
    let previous = null, parentId = null;
    try {
      for (let index = 0; index < stages.length; index++) {
        const stage = stages[index];
        localStageLabel = `第 ${index + 1}/${stages.length} 步 · ${stage.label}`;
        rows[index].textContent = `${stage.label} · 生成中`;
        status(localStageLabel);
        const images = previous ? [previous, stage.reference] : stage.reference ? [stage.reference] : [];
        if (images.length > model.maxReferences) throw new Error('本地模型无法接收本步所需的底图与参考图。');
        markdown($('#ai-request-preview'), `${localStageLabel}\n\n${stage.prompt}`); $('#ai-request-review').hidden = false;
        const result = await request({ model, prompt: stage.prompt, images, size: imageSize(), purpose: 'image' });
        if (!result.images?.[0]) throw new Error('本地引擎未返回图像。');
        await remember([result.images[0]], stage.prompt, model, parentId, { kind: stage.kind, label: stage.label, index: index + 1, total: stages.length });
        previous = result.images[0]; parentId = currentImage.id;
        rows[index].textContent = `${stage.label} · 已完成并保存`;
      }
      status(`分步生成完成，共 ${stages.length} 步；各步结果已保存到本地历史。`);
    } catch (error) {
      const index = rows.findIndex(row => row.textContent.endsWith('生成中'));
      if (index >= 0) { rows[index].textContent = `${stages[index].label} · 失败：${error.message}`; rows.slice(index + 1).forEach((row, offset) => { row.textContent = `${stages[index + 1 + offset].label} · 未执行`; }); }
      throw new Error(`${localStageLabel}失败：${error.message}${previous ? '；已保留前一步结果，可从历史打开。' : ''}`);
    } finally { localStageLabel = ''; }
  }
  function imageSize() { return $('#studio-size').value; }
  async function optimize(pipeline) {
    if (busy) return;
    setBusy(true);
    let run;
    const optimizationStatus = message => { $('#prompt-optimization-status').textContent = message; status(message); };
    optimizationStatus('正在通过 ZenMux 优化提示词…');
    promptState = { runs: [], final: $('#ai-final-prompt').value, sceneSignature: promptState.sceneSignature || '', scope: promptState.scope || '' };
    $('#prompt-runs').replaceChildren(); $('#prompt-process').hidden = true;
    $('#ai-stream-output').hidden = true;
    showFinal(); savePrompts();
    try {
      const source = $('#ai-prompt').value.trim(); if (!source) throw new Error('请先填写提示词。');
      const { images, labels } = localMode()
        ? { images: $('#ai-use-pose').checked ? [poseImage()] : [], labels: $('#ai-use-pose').checked ? '图片 1 是唯一姿态参考，只借体型与姿态。' : '' }
        : inputReferences();
      const optimizedScene = localMode() ? '' : sceneSettingsSignature();
      const context = localMode() ? `只优化第一步的形体提示词，输出一个完整画面的描述。人数固定为 ${characters().length}，不输出分栏、对照图、三联画或多个视角，不添加重复人物。不引用尚未提供的人脸、服饰或场景图片编号，不输出后续步骤的身份合同与编辑指令。人物资料：${JSON.stringify(characters())}。形态要求：${$('#ai-use-pose').checked ? $('#ai-pose-prompt').value : ''}` : scenePrompt();
      const constraints = `${context}\n${labels}\n原始用户需求：${source}`;
      let draft = source;
      const stages = pipeline ? [
        ['openai/gpt-6.1-sol', '优化生图提示词，明确姿态、人物身份、服饰、构图和画风。'],
        ['anthropic/claude-sonnet-5.5', '挑刺：检查遗漏、冲突、人物身份混淆和不明确的视觉指令，给出具体修改建议。'],
        ['google/gemini-3.8-flash', '综合原始需求、初稿与审查建议，输出最终可直接用于生图的提示词，只返回提示词。'],
      ] : [[$('#ai-optimizer').value, '优化或审查后改进这段生图提示词，只返回最终提示词。']];
      const selected = stages.map(([id]) => models.find(m => m.id === id && m.kind === 'text'));
      if (selected.some(m => !m)) throw new Error('三模型协作所需模型已被修改，请在设置中恢复对应名称。');
      run = { createdAt: new Date().toISOString(), pipeline, source, stages: selected.map((model, i) => ({ model: model.id, label: pipeline ? ['优化初稿', '审查建议', '最终综合'][i] : '优化结果', text: '' })) };
      promptState.runs.push(run); savePrompts();
      const outputs = addPromptRun(run); $('#prompt-process').open = true;
      let firstDraft = '';
      for (let i = 0; i < stages.length; i++) {
        optimizationStatus(`提示词处理 ${i + 1}/${stages.length}：${selected[i].id}`);
        const result = await request({ model: selected[i], purpose: 'text', images: selected[i].references ? images : [], prompt: `${stages[i][1]}\n不得改变人数和人脸身份要求，不添加用户未要求的角色。\n${constraints}\n${firstDraft ? `优化初稿：${firstDraft}\n` : ''}当前草稿或审查意见：${draft}` }, text => { run.stages[i].text = text; savePrompts(); }, outputs[i]);
        draft = result.text?.trim();
        if (!draft) throw new Error('ZenMux 未返回优化文本，请重试；已有最终提示词已保留。');
        savePrompts(); if (i === 0) firstDraft = draft;
      }
      promptState.final = draft; promptState.scope = localMode() ? 'body' : ''; promptState.sceneSignature = optimizedScene; showFinal(); savePrompts(); optimizationStatus('优化完成：下次生成使用下方最终提示词，可继续编辑。');
      $('#final-prompt-section').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } catch (err) { if (run) { run.error = err.message; savePrompts(); } optimizationStatus(`优化失败：${err.message}`); }
    finally { setBusy(false); if (!currentImage) { $('#studio-edit').disabled = $('#studio-layers').disabled = true; } }
  }
  $('#btn-optimize').onclick = () => optimize(false);
  $('#btn-pipeline').onclick = () => optimize(true);
  $('#ai-model').onchange = refreshModels;

  showProvider();
  if (localMode()) loadLocalCatalog().catch(error => status(error.message));
  // Permanent output canvas and history rail are visible in the main workspace.
  let resultZoom = 1, resultX = 0, resultY = 0, resultDrag = null;
  function transformResult() {
    $('#studio-image').style.transform = `translate(${resultX}px, ${resultY}px) scale(${resultZoom})`;
    $('#studio-zoom').textContent = `${Math.round(resultZoom * 100)}%`;
  }
  function zoomResult(factor) { resultZoom = Math.max(.2, Math.min(8, resultZoom * factor)); transformResult(); }
  function selectResult(item) {
    currentImage = item;
    $('#studio-image').hidden = !item;
    $('#studio-empty').hidden = !!item;
    if (item) $('#studio-image').src = item.url;
    else $('#studio-image').removeAttribute('src');
    $('#studio-image-meta').textContent = item ? `${item.model}${item.stage ? ` · ${item.stage.label}` : ''} · ${new Date(item.created).toLocaleString('zh-CN')}` : '等待生成';
    ['#studio-copy', '#studio-save', '#studio-edit', '#studio-layers'].forEach(id => { $(id).disabled = !item || busy; });
    showProvider();
    resultZoom = 1; resultX = resultY = 0; transformResult();
    document.querySelectorAll('.studio-history-card').forEach(button => button.classList.toggle('selected', button.dataset.id === item?.id));
  }
  async function refreshGallery() {
    const entries = await historyTransaction('readonly', store => store.getAll());
    entries.sort((a, b) => b.created - a.created);
    $('#studio-history-count').textContent = entries.length;
    $('#studio-history-empty').hidden = entries.length > 0;
    $('#studio-history').replaceChildren(...entries.map(item => {
      const button = document.createElement('button'); button.className = 'studio-history-card'; button.dataset.id = item.id;
      button.classList.toggle('selected', item.id === currentImage?.id);
      const image = new Image(); image.src = item.url; image.alt = '查看历史生成图';
      const label = document.createElement('span'); label.textContent = `${new Date(item.created).toLocaleString('zh-CN')}${item.stage ? ` · ${item.stage.label}` : item.parentId ? ' · 修图' : ''}${item.layers?.length ? ' · 已拆层' : ''}`;
      button.append(image, label); button.onclick = () => busy ? toast('请等待当前 AI 任务完成。') : selectResult(item); return button;
    }));
    if (!currentImage && entries.length) selectResult(entries[0]);
  }
  $('#studio-manage').onclick = () => $('#btn-history').click();
  $('#studio-edit').onclick = () => currentImage && showImage(currentImage);
  $('#studio-layers').onclick = async () => { if (currentImage) { await showImage(currentImage); $('#layer-section').open = true; $('#layer-section').scrollIntoView({ block: 'start' }); } };
  $('#studio-copy').onclick = async () => {
    try { if (!bridge?.copyImage || !currentImage) return; const image = await loadImage(currentImage.url), canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; canvas.getContext('2d').drawImage(image, 0, 0); const result = await bridge.copyImage(canvas.toDataURL('image/png')); if (!result.ok) throw new Error(result.error); status('图片已复制到剪贴板。'); }
    catch (err) { status(err.message); }
  };
  $('#studio-save').onclick = async () => {
    if (!currentImage) return;
    try { const image = await loadImage(currentImage.url), canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight; canvas.getContext('2d').drawImage(image, 0, 0); const url = canvas.toDataURL('image/png');
      if (bridge) { const result = await bridge.saveImage(url, `bodyfactory_${currentImage.id}.png`); if (result.ok) status('图片已另存为。'); }
      else { const a = document.createElement('a'); a.href = url; a.download = 'bodyfactory.png'; a.click(); }
    } catch (err) { status(err.message); }
  };
  $('#studio-zoom-in').onclick = () => zoomResult(1.25);
  $('#studio-zoom-out').onclick = () => zoomResult(.8);
  $('#studio-fit').onclick = () => { resultZoom = 1; resultX = resultY = 0; transformResult(); };
  $('#studio-display').addEventListener('wheel', e => { if (currentImage) { e.preventDefault(); zoomResult(e.deltaY < 0 ? 1.12 : 1 / 1.12); } }, { passive: false });
  $('#studio-image').addEventListener('pointerdown', e => { if (e.button !== 0) return; e.preventDefault(); e.target.setPointerCapture(e.pointerId); resultDrag = { x: e.clientX, y: e.clientY, resultX, resultY }; });
  $('#studio-image').addEventListener('pointermove', e => { if (resultDrag) { resultX = resultDrag.resultX + e.clientX - resultDrag.x; resultY = resultDrag.resultY + e.clientY - resultDrag.y; transformResult(); } });
  ['pointerup', 'pointercancel'].forEach(event => $('#studio-image').addEventListener(event, () => { resultDrag = null; }));
  window.addEventListener('pose-reference-changed', updatePeople);

  // Settings: only the main process reads the saved API key.
  document.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => button.closest('dialog').close(); });
  function renderModelEditor() {
    $('#model-editor').replaceChildren(...models.map((model, index) => {
      const row = document.createElement('div'); row.className = 'model-row'; row.dataset.index = index;
      const id = document.createElement('input'); id.value = model.id; id.placeholder = 'provider/model'; id.dataset.field = 'id'; id.title = model.kind === 'text' ? '提示词模型名称' : model.kind === 'layer' ? '拆层模型名称' : '生图模型名称';
      const protocol = document.createElement('select'); protocol.dataset.field = 'protocol';
      const options = model.kind === 'text' ? ['chat'] : ['openai-images', 'vertex-predict', 'gemini-content'];
      protocol.replaceChildren(...options.map(value => new Option(PROTOCOLS[value], value))); protocol.value = model.protocol;
      const label = document.createElement('label'); const ref = document.createElement('input'); ref.type = 'checkbox'; ref.checked = model.references; ref.dataset.field = 'references'; label.append(ref, ' 参考图');
      const limit = document.createElement('input'); limit.type = 'number'; limit.min = 0; limit.max = 16; limit.value = model.maxReferences; limit.dataset.field = 'maxReferences'; limit.title = '参考图上限';
      const remove = document.createElement('button'); remove.textContent = '×'; remove.title = '移除模型'; remove.onclick = () => { collectModels(); models.splice(index, 1); renderModelEditor(); };
      row.append(id, protocol, label, limit, remove); return row;
    }));
  }
  function collectModels() {
    models = [...$('#model-editor').children].map(row => {
      const previous = models[Number(row.dataset.index)];
      const id = row.querySelector('[data-field=id]').value.trim();
      return { ...previous, id, note: id === previous.id ? previous.note : '自定义模型，请确认接口与参考图支持。', protocol: row.querySelector('[data-field=protocol]').value, references: row.querySelector('[data-field=references]').checked, maxReferences: Number(row.querySelector('[data-field=maxReferences]').value) };
    });
  }
  function keyState(settings) { $('#key-state').textContent = `${settings.hasKey ? 'API Key 已加密保存在本机。' : '尚未保存 API Key。'}${settings.secureStorage ? '' : '系统加密服务当前不可用。'}`; }
  $('#settings-dialog').addEventListener('close', () => { models = structuredClone(savedModels); refreshModels(); });
  $('#btn-settings').onclick = () => { models = structuredClone(savedModels); renderModelEditor(); $('#api-key').value = ''; $('#settings-dialog').showModal(); };
  for (const kind of ['image', 'text', 'layer']) $(`#btn-add-${kind}`).onclick = () => { collectModels(); models.push({ id: '', kind, protocol: kind === 'text' ? 'chat' : 'vertex-predict', references: false, maxReferences: 0 }); renderModelEditor(); };
  $('#btn-save-ai').onclick = async () => {
    try {
      if (!bridge?.saveAISettings) throw new Error('请在 Electron 应用中保存 AI 设置。');
      collectModels();
      if (models.some(m => !/^[\w.-]+\/[\w./:-]+$/.test(m.id) || !Number.isInteger(m.maxReferences) || m.maxReferences < 0 || m.maxReferences > 16)) throw new Error('模型名称应为 provider/model；参考图上限为 0–16。');
      if (new Set(models.map(m => m.id)).size !== models.length) throw new Error('模型名称不能重复。');
      const result = await bridge.saveAISettings({ models, apiKey: $('#api-key').value.trim() });
      if (!result.ok) throw new Error(result.error);
      $('#api-key').value = ''; savedModels = structuredClone(models); keyState(result); refreshModels(); toast('AI 设置已保存'); $('#settings-dialog').close();
    } catch (err) { $('#key-state').textContent = err.message; }
  };
  $('#btn-validate-key').onclick = async () => {
    const button = $('#btn-validate-key'), output = $('#key-validation');
    button.disabled = true; $('#btn-save-ai').disabled = true; $('#btn-clear-key').disabled = true;
    $('#key-validation-image').hidden = true;
    output.textContent = '正在验证默认文字和生图模型，请稍候…';
    try {
      if (!bridge?.validateAIKey) throw new Error('请重启 Electron 应用以启用 Key 验证。');
      const results = await bridge.validateAIKey({ apiKey: $('#api-key').value.trim() });
      output.textContent = [['文字', results.text], ['生图（无参考图）', results.image]].map(([label, result]) =>
        `${label}：${result.ok ? '验证通过' : result.error}${result.diagnostics ? `\n模型：${result.diagnostics.model}\n接口：${result.diagnostics.endpoint}\n请求编号：${result.diagnostics.requestId || '未返回'}` : ''}`
      ).join('\n\n');
      if (results.image.ok) { $('#key-validation-image').src = results.image.images[0]; $('#key-validation-image').hidden = false; }
    } catch (err) { output.textContent = err.message; }
    finally { button.disabled = false; $('#btn-save-ai').disabled = false; $('#btn-clear-key').disabled = false; }
  };
  $('#btn-clear-key').onclick = async () => {
    if (!bridge?.saveAISettings) return;
    const result = await bridge.saveAISettings({ clearKey: true });
    if (result.ok) { $('#api-key').value = ''; keyState(result); } else $('#key-state').textContent = result.error;
  };

  // Local history supports multi-select deletion.
  async function renderHistory() {
    const entries = await historyTransaction('readonly', store => store.getAll());
    entries.sort((a, b) => b.created - a.created);
    $('#history-empty').hidden = entries.length > 0;
    $('#history-grid').replaceChildren(...entries.map(item => {
      const card = document.createElement('div'); card.className = 'history-card';
      const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.checked = selectedHistory.has(item.id); checkbox.dataset.id = item.id; checkbox.setAttribute('aria-label', '选择历史图片');
      checkbox.onchange = () => checkbox.checked ? selectedHistory.add(item.id) : selectedHistory.delete(item.id);
      const image = new Image(); image.src = item.url; image.alt = '生成图，点击查看与修图'; image.onclick = () => busy ? toast('请等待当前 AI 任务完成。') : showImage(item);
      const info = document.createElement('p'); info.textContent = `${new Date(item.created).toLocaleString('zh-CN')} · ${item.model}${item.stage ? ` · ${item.stage.label}` : item.parentId ? ' · 修图' : ''}`;
      card.append(checkbox, image, info); return card;
    }));
  }
  $('#btn-history').onclick = async () => { try { selectedHistory.clear(); await renderHistory(); $('#history-dialog').showModal(); } catch (err) { status(err.message); } };
  $('#history-all').onclick = () => {
    const inputs = [...$('#history-grid').querySelectorAll('input')], checked = inputs.some(input => !input.checked);
    selectedHistory.clear(); inputs.forEach(input => { input.checked = checked; if (checked) selectedHistory.add(input.dataset.id); });
  };
  $('#history-delete').onclick = async () => {
    if (!selectedHistory.size) return;
    try { await historyTransaction('readwrite', store => { selectedHistory.forEach(id => store.delete(id)); }); if (selectedHistory.has(currentImage?.id)) selectResult(null); selectedHistory.clear(); await renderHistory(); await refreshGallery(); toast('已删除所选历史图片'); }
    catch (err) { toast(err.message); }
  };

  function loadImage(url) { return new Promise((resolve, reject) => { const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('图片无法打开。')); image.src = url; }); }
  async function showImage(item) {
    try {
      original = await loadImage(item.url); currentImage = item; selectResult(item); strokes = [];
      layerImages = structuredClone(item.layers || []); renderLayers();
      $('#layer-status').textContent = '';
      if (item.layerPlan) $('#layer-plan').value = item.layerPlan;
      editCanvas.width = original.naturalWidth; editCanvas.height = original.naturalHeight;
      zoom = 1; offsetX = offsetY = 0; transformImage(); redraw();
      $('#edit-prompt').value = ''; $('#edit-status').textContent = '画笔涂鸦；滚轮缩放；按住空格拖动或右键拖动平移。';
      if (!$('#image-dialog').open) $('#image-dialog').showModal();
    } catch (err) { status(err.message); }
  }
  function redraw() {
    if (!original) return;
    context.clearRect(0, 0, editCanvas.width, editCanvas.height); context.drawImage(original, 0, 0);
    for (const stroke of strokes) {
      context.strokeStyle = stroke.color; context.fillStyle = stroke.color; context.lineWidth = stroke.size; context.lineCap = context.lineJoin = 'round';
      if (stroke.points.length === 1) { context.beginPath(); context.arc(stroke.points[0].x, stroke.points[0].y, stroke.size / 2, 0, Math.PI * 2); context.fill(); }
      else { context.beginPath(); stroke.points.forEach((point, i) => i ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)); context.stroke(); }
    }
  }
  const canvasWrap = editCanvas.parentElement;
  function transformImage() { editCanvas.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${zoom})`; $('#image-zoom').textContent = `${Math.round(zoom * 100)}%`; }
  function changeZoom(value) { zoom = Math.max(.2, Math.min(8, value)); transformImage(); }
  canvasWrap.addEventListener('wheel', e => { e.preventDefault(); changeZoom(zoom * (e.deltaY < 0 ? 1.12 : 1 / 1.12)); }, { passive: false });
  let space = false;
  window.addEventListener('keydown', e => { if ($('#image-dialog').open && e.code === 'Space' && !e.target.matches('input,textarea,select,button')) { e.preventDefault(); space = true; } });
  window.addEventListener('keyup', e => { if (e.code === 'Space') space = false; });
  window.addEventListener('blur', () => { space = false; drawing = panning = false; });
  $('#image-dialog').addEventListener('close', () => { space = false; drawing = panning = false; });
  function point(event) { const rect = editCanvas.getBoundingClientRect(); return { x: (event.clientX - rect.left) * editCanvas.width / rect.width, y: (event.clientY - rect.top) * editCanvas.height / rect.height }; }
  editCanvas.addEventListener('contextmenu', e => e.preventDefault());
  editCanvas.addEventListener('pointerdown', e => {
    editCanvas.setPointerCapture(e.pointerId);
    if (space || e.button === 2 || $('#image-pan').checked) { panning = true; panStart = { x: e.clientX, y: e.clientY, offsetX, offsetY }; return; }
    if (e.button !== 0) return;
    drawing = true; const rect = editCanvas.getBoundingClientRect();
    strokes.push({ color: $('#draw-color').value, size: Number($('#draw-size').value) * editCanvas.width / rect.width, points: [point(e)] }); redraw();
  });
  editCanvas.addEventListener('pointermove', e => {
    if (panning) { offsetX = panStart.offsetX + e.clientX - panStart.x; offsetY = panStart.offsetY + e.clientY - panStart.y; transformImage(); }
    else if (drawing) { strokes.at(-1).points.push(point(e)); redraw(); }
  });
  const stopDrawing = () => { drawing = panning = false; };
  editCanvas.addEventListener('pointerup', stopDrawing); editCanvas.addEventListener('pointercancel', stopDrawing);
  $('#draw-undo').onclick = () => { strokes.pop(); redraw(); };
  $('#draw-reset').onclick = () => { strokes = []; redraw(); };
  $('#image-zoom-in').onclick = () => changeZoom(zoom * 1.25);
  $('#image-zoom-out').onclick = () => changeZoom(zoom / 1.25);
  $('#image-fit').onclick = () => { zoom = 1; offsetX = offsetY = 0; transformImage(); };
  $('#image-save').onclick = async () => {
    if (!original) return;
    const url = editCanvas.toDataURL('image/png');
    if (bridge) { const result = await bridge.saveImage(url, `bodyfactory_${currentImage.id}.png`); if (result.ok) $('#edit-status').textContent = '图片已另存为。'; }
    else { const a = document.createElement('a'); a.href = url; a.download = 'bodyfactory.png'; a.click(); }
  };
  $('#image-copy').onclick = async () => {
    if (!original) return;
    try { if (!bridge?.copyImage) throw new Error('复制图片需要 Electron 桌面应用。'); const result = await bridge.copyImage(editCanvas.toDataURL('image/png')); if (!result.ok) throw new Error(result.error); $('#edit-status').textContent = '图片已复制到剪贴板。'; }
    catch (err) { status(err.message, true); }
  };
  $('#btn-edit-image').onclick = async () => {
    if (busy || !original) return;
    setBusy(true); status('正在根据涂鸦和修改说明修图…', true);
    try {
      const model = localMode() ? localModel : models.find(m => m.id === $('#edit-model').value);
      const anchors = identityAnchors();
      if (!model?.references || anchors.length + 1 > model.maxReferences) throw new Error('修图模型无法同时接收工作图与全部权威身份图，请更换支持多图的模型。');
      let instruction = $('#edit-prompt').value.trim();
      if (!instruction && strokes.length && localMode()) throw new Error('本地涂鸦修图请填写修改说明；参考图不会发送云端识别。');
      if (!instruction && strokes.length) {
        const reader = models.find(m => m.id === $('#ai-optimizer').value && m.kind === 'text' && m.references);
        if (!reader) throw new Error('自动识别涂鸦需要支持图像输入的文字模型，也可以手动填写修改说明。');
        status('正在对照原图识别涂鸦修改意图…', true);
        const response = await request({ model: reader, purpose: 'text', images: [...anchors.map(reference => reference.url), editCanvas.toDataURL('image/png'), currentImage.url], prompt: `涂鸦修图自动识别。${identityContract()}。图片 ${anchors.length + 1} 是带手工涂鸦的图，图片 ${anchors.length + 2} 是未涂鸦原图，仅作为工作图，不是身份锚点。只分析新增笔迹对应的区域、箭头、圈选和明确的修改意图，不把笔迹作为成品内容；未要求修改的区域和人物身份必须保持。涂鸦共 ${strokes.length} 笔，颜色：${[...new Set(strokes.map(s => s.color))].join('、')}。只输出 JSON：{"instruction":"可直接执行的中文修改说明","needsClarification":false}。若只有圈选、任意线条或无法明确判断修改目标，不猜测、不虚构修改，返回 needsClarification:true 并说明需要用户补充什么。` }, null, document.createElement('div'));
        let parsed;
        try { parsed = JSON.parse(response.text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
        catch { throw new Error('无法识别涂鸦意图，请手动填写修改说明。'); }
        if (parsed?.needsClarification !== false || typeof parsed.instruction !== 'string' || !parsed.instruction.trim()) throw new Error('涂鸦意图不够明确，请补充修改说明后再次修图。');
        instruction = parsed.instruction.trim(); $('#edit-prompt').value = instruction;
      }
      if (!instruction) throw new Error('请填写修改说明，或先绘制涂鸦。');
      const parentId = currentImage.id;
      const images = [...anchors.map(reference => reference.url), editCanvas.toDataURL('image/png')];
      const cleanIncluded = model.maxReferences > images.length && strokes.length;
      if (cleanIncluded) images.push(currentImage.url);
      const prompt = `修改说明：${instruction}\n${identityContract()}\n图片 ${anchors.length + 1} 是用户涂鸦后的工作图，涂鸦是编辑指示，不是最终成品内容。${cleanIncluded ? `图片 ${images.length} 是未涂鸦的工作原图，仅用于保留未改区域、服装、姿势、机位、构图、环境和光线；身份仍由权威图决定。` : ''}严格执行修改说明，保留未要求修改的区域、人物姿态和面部身份特征，去除指示性的涂鸦笔迹。`;
      const result = await request({ model, prompt, images, purpose: 'image', size: imageSize() });
      await remember(result.images, prompt, model, parentId); status('修图已完成并保存到本地历史。', true);
    } catch (err) { status(err.message, true); }
    finally { setBusy(false); if (!currentImage) { $('#studio-edit').disabled = $('#studio-layers').disabled = true; } }
  };
  // Layer decomposition: vision/text models plan; Ming Layer returns aligned RGBA images.
  function defaultPlan() {
    const count = Number($('#layer-count').value);
    const lines = count === 2 ? ['主体：人物或产品主体，准确边缘，背景透明。', '背景：完整背景，补全主体遮挡区域。'] : count === 3 ? ['文字：所有文字元素，保留字体、颜色和布局，其他区域透明。', '主体：人物或产品主体，背景透明。', '背景：完整背景，补全遮挡区域。'] : ['文字：所有标题、正文和标签文字，保留字体、颜色和位置，其他区域透明。', '文字底板：文字下的垫色色块、卡片或横幅，不含文字，其他区域透明。', '主体：主要人物或产品，准确边缘，不含文字、底板和背景。', '背景：完整背景，补全前景遮挡的区域，不包含前景元素。'];
    while (lines.length < count) lines.splice(lines.length - 1, 0, `独立元素 ${lines.length - 2}：请结合图片指定需要独立拆出的装饰或前景元素。`);
    $('#layer-plan').value = lines.join('\n');
  }
  $('#layer-count').onchange = defaultPlan; defaultPlan();
  function layerPlan() {
    const lines = $('#layer-plan').value.split('\n').map(line => line.trim()).filter(Boolean);
    if (lines.length < 2 || lines.length > 12) throw new Error('拆层说明需要 2–12 行，每行描述一层。');
    return lines.map((line, i) => ({ name: line.split(/[:：]/)[0].replace(/^\d+[.、)\s]*/, '') || `图层 ${i + 1}`, description: line }));
  }
  async function planLayers(discuss) {
    if (busy || !currentImage) return;
    setBusy(true);
    const count = Number($('#layer-count').value);
    try {
      if (!Number.isInteger(count) || count < 2 || count > 12) throw new Error('层数应为 2–12。');
      const ids = discuss ? ['openai/gpt-6.1-sol', 'anthropic/claude-sonnet-5.5', 'google/gemini-3.8-flash'] : [$('#layer-planner').value];
      let draft = $('#layer-plan').value;
      for (let i = 0; i < ids.length; i++) {
        const model = models.find(m => m.id === ids[i] && m.kind === 'text');
        if (!model?.references) throw new Error(`分析模型 ${ids[i]} 需要支持图片输入。`);
        $('#layer-status').textContent = `分析拆层 ${i + 1}/${ids.length}：${model.id}`;
        const task = discuss && i === 1 ? '审查方案，指出遗漏、重叠和层序问题，并改进。' : i === ids.length - 1 ? '综合方案，输出最终拆层设计。' : '分析图片并设计详细的拆层方案。';
        const response = await request({ model, purpose: 'text', images: [currentImage.url], prompt: `${task}拆成 ${count} 个图层，从最上层到最下层：先文字，再文字下的底板，然后主体，最后背景。色块、卡片、横幅应单独列层并放在相应文字下方。不存在的元素不虚构，应根据实际内容分配层数。描述具体的形状、颜色、位置、主体和透明区域。保留原布局，图层同尺寸，背景补全遮挡。用户方案：${$('#layer-plan').value}\n当前讨论结果：${draft}\n只输出 JSON，格式为 {"layers":[{"name":"层名","description":"具体拆层说明"}]}，layers 恰好 ${count} 项，按最上到最下排序。` });
        draft = response.text;
      }
      const json = JSON.parse(draft.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/, ''));
      if (!Array.isArray(json.layers) || json.layers.length !== count || json.layers.some(layer => typeof layer.name !== 'string' || typeof layer.description !== 'string')) throw new Error('AI 返回的拆层方案格式不正确，请重试或手动编写。');
      $('#layer-plan').value = json.layers.map(layer => `${layer.name.replace(/\n/g, ' ')}：${layer.description.replace(/\n/g, ' ')}`).join('\n');
      $('#layer-status').textContent = '拆层方案已生成，可以修改后发送给拆层模型。';
    } catch (err) { $('#layer-status').textContent = err.message; }
    finally { setBusy(false); if (!currentImage) { $('#studio-edit').disabled = $('#studio-layers').disabled = true; } }
  }
  $('#btn-plan-layers').onclick = () => planLayers(false);
  $('#btn-discuss-layers').onclick = () => planLayers(true);
  function renderLayers() {
    $('#btn-export-psd').disabled = layerImages.length === 0;
    $('#layer-results').replaceChildren(...layerImages.map((layer, i) => {
      const row = document.createElement('div'); row.className = 'layer-result';
      const image = new Image(); image.src = layer.url; image.alt = `图层 ${i + 1}`;
      const name = document.createElement('input'); name.value = layer.name; name.title = '图层名称';
      name.onchange = () => { layer.name = name.value; saveLayers(); };
      const up = document.createElement('button'); up.textContent = '↑'; up.title = '上移图层'; up.disabled = i === 0;
      const down = document.createElement('button'); down.textContent = '↓'; down.title = '下移图层'; down.disabled = i === layerImages.length - 1;
      const move = delta => { [layerImages[i], layerImages[i + delta]] = [layerImages[i + delta], layerImages[i]]; renderLayers(); saveLayers(); };
      up.onclick = () => move(-1); down.onclick = () => move(1); row.append(image, name, up, down); return row;
    }));
  }
  async function saveLayers() {
    currentImage.layers = structuredClone(layerImages); currentImage.layerPlan = $('#layer-plan').value;
    try { await historyTransaction('readwrite', store => store.put(currentImage)); }
    catch (err) { $('#layer-status').textContent = `拆层已完成，但历史保存失败：${err.message}`; }
  }
  $('#btn-split-layers').onclick = async () => {
    if (busy || !currentImage) return;
    setBusy(true); $('#layer-status').textContent = '正在拆成透明图层…';
    try {
      const plan = layerPlan(), model = models.find(m => m.id === $('#layer-model').value && m.kind === 'layer');
      if (!model) throw new Error('请先在设置中添加拆层模型。');
      const response = await request({ model, purpose: 'layers', images: [currentImage.url], prompt: `将输入图片拆成 ${plan.length} 个独立 RGBA 图层。严格按照以下从最上面到最下面的顺序输出每层一张透明 PNG，所有层与输入图尺寸相同、位置对齐，不缩放或改变画布。每层只保留指定内容，其他区域完全透明。拆层后叠加应尽量还原原图。文字保持原样，文字下的底板独立一层。背景补全被前景遮挡的区域。\n${plan.map((layer, i) => `${i + 1}. ${layer.description}`).join('\n')}` });
      const normalized = [];
      for (let i = 0; i < response.images.length; i++) {
        const image = await loadImage(response.images[i]);
        if (image.naturalWidth !== original.naturalWidth || image.naturalHeight !== original.naturalHeight) throw new Error('拆层模型返回的图层尺寸与原图不同，无法对齐导出 PSD。');
        const canvas = document.createElement('canvas'); canvas.width = image.naturalWidth; canvas.height = image.naturalHeight;
        canvas.getContext('2d').drawImage(image, 0, 0);
        normalized.push({ name: plan[i]?.name || `图层 ${i + 1}`, url: canvas.toDataURL('image/png') });
      }
      layerImages = normalized; renderLayers(); await saveLayers();
      $('#layer-status').textContent = `已得到 ${layerImages.length} 张层图${layerImages.length !== plan.length ? `，与目标 ${plan.length} 层不同` : ''}。请查看透明区域并核对从上到下的顺序，可调整层名和层序后导出 PSD。`;
    } catch (err) { $('#layer-status').textContent = err.message; }
    finally { setBusy(false); if (!currentImage) { $('#studio-edit').disabled = $('#studio-layers').disabled = true; } }
  };
  $('#btn-export-psd').onclick = async () => {
    try {
      if (!bridge?.savePSD) throw new Error('PSD 导出需要 Electron 桌面应用。');
      const composite = document.createElement('canvas'); composite.width = original.naturalWidth; composite.height = original.naturalHeight;
      const ctx = composite.getContext('2d');
      for (const layer of [...layerImages].reverse()) ctx.drawImage(await loadImage(layer.url), 0, 0);
      const result = await bridge.savePSD({ layers: layerImages, composite: composite.toDataURL('image/png') });
      if (result.ok) $('#layer-status').textContent = `PSD 已保存：${result.filePath}`;
      else if (!result.canceled) throw new Error(result.error);
    } catch (err) { $('#layer-status').textContent = err.message; }
  };

  try {
    if (bridge?.loadAISettings) { const settings = await bridge.loadAISettings(); if (!settings.ok) throw new Error(settings.error); if (Array.isArray(settings.models)) models = settings.models; keyState(settings); }
    else keyState({ hasKey: false, secureStorage: false });
  } catch (err) { status(err.message); }
  savedModels = structuredClone(models);
  refreshModels(); updatePeople();
  try { await refreshGallery(); } catch (err) { status(err.message); }
}
