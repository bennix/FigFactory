import { marked } from '../vendor/markdown/marked.esm.js';
import DOMPurify from '../vendor/markdown/purify.es.mjs';
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
    if (saved && Array.isArray(saved.runs) && typeof saved.final === 'string') promptState = saved;
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
  promptState.runs.forEach(addPromptRun); showFinal();
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
    ['#btn-generate', '#btn-optimize', '#btn-pipeline', '#btn-edit-image', '#btn-plan-layers', '#btn-discuss-layers', '#btn-split-layers'].forEach(id => { $(id).disabled = value; });
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
    $('#ai-model-note').textContent = models.find(m => m.id === $('#ai-model').value)?.note || '请确认该模型的接口和参考图能力。';
  }
  function updatePeople() {
    const select = $('#ref-person'), previous = select.value;
    select.replaceChildren(...characters().map(person => new Option(`人偶 ${person.id}`, person.id)));
    if ([...select.options].some(option => option.value === previous)) select.value = previous;
  }
  $('#figure-count').addEventListener('change', updatePeople);
  $('#ref-person').addEventListener('focus', updatePeople);
  function renderReferences() {
    $('#ref-thumbs').replaceChildren(...references.map((reference, index) => {
      const box = document.createElement('div'); box.className = 'ref-thumb';
      const image = new Image(); image.src = reference.url; image.alt = '参考图';
      const label = document.createElement('span'); label.textContent = `人偶 ${reference.person} · ${reference.kind === 'face' ? '人脸' : '服饰'}`;
      const remove = document.createElement('button'); remove.textContent = '×'; remove.title = '删除参考图';
      remove.onclick = () => { references.splice(index, 1); renderReferences(); };
      box.append(image, remove, label); return box;
    }));
  }
  async function addFiles(files) {
    try {
      const person = Number($('#ref-person').value), kind = $('#ref-kind').value;
      for (const file of files) {
        if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请使用 PNG、JPEG 或 WebP 图片。');
        if (file.size > 20 * 1024 * 1024) throw new Error('单张参考图不能超过 20 MB。');
        const url = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(file); });
        references.push({ url, person, kind });
      }
    } catch (err) { status(err.message); }
    renderReferences();
  }
  $('#btn-ref').onclick = () => $('#ref-file').click();
  $('#ref-file').onchange = async e => { await addFiles(e.target.files); e.target.value = ''; };
  window.addEventListener('paste', e => {
    if (document.querySelector('dialog[open]')) return;
    const files = [...(e.clipboardData?.items || [])].filter(item => item.type.startsWith('image/')).map(item => item.getAsFile()).filter(Boolean);
    if (files.length) { e.preventDefault(); addFiles(files); }
  });
  async function request(args, onText, textOutput) {
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
  function scenePrompt() {
    const people = characters();
    if (!$('#ai-use-pose').checked) return references.length ? '参考图中的人脸仅用于对应人物身份，忠实保留脸型、五官、肤色，不混合不同人物面孔；服饰参考只用于对应人物衣着。人物编号仅用于参考图绑定，不在最终图像中显示。' : '';
    for (const reference of references) if (!people.some(p => p.id === reference.person)) throw new Error(`参考图对应的人偶 ${reference.person} 已被移除，请删除该参考图。`);
    return `画面中必须有 ${people.length} 个人物。人物资料：${JSON.stringify(people)}。人偶形态参考图仅用于各人物的姿态、体型比例、相对位置和相机视角，不复制人偶的裸露表面、塑料材质或关节结构。服装以用户提示词和对应服饰参考为准；用户未指定衣着时，人物默认穿着完整日常服装（上衣、长裤和鞋），身体由衣物自然遮盖，不生成裸体或内衣造型。最终人物的真实感或风格以用户提示词为准。人偶编号以形态参考图头部蓝色数字标签为准，最终图像不保留数字标签。人脸参考用于对应人物身份，忠实保留脸型、眼睛、鼻子、嘴唇、肤色和独特五官，不混合不同人物的面孔。服饰参考仅用于对应人物的衣着。`;
  }
  function inputReferences() {
    const images = [], labels = [];
    if ($('#ai-use-pose').checked) { images.push(poseImage()); labels.push('图片 1：整个人偶场景，仅参考姿态、比例和构图，不参考裸露外观或材质，服装另按文字和服饰参考生成。'); }
    for (const reference of references) {
      images.push(reference.url); labels.push(`图片 ${images.length}：人偶 ${reference.person} 的${reference.kind === 'face' ? '人脸身份' : '服饰'}参考。`);
    }
    return { images, labels: labels.join('\n') };
  }
  async function remember(images, prompt, model, parentId = null) {
    for (const url of images) {
      const item = { id: crypto.randomUUID(), url, prompt, model: model.id, created: Date.now(), parentId };
      currentImage = item;
      try { await historyTransaction('readwrite', store => store.put(item)); }
      catch (err) { toast('图片已生成，但历史保存失败；请立即另存为。'); status(err.message); }
    }
    selectResult(currentImage);
    await refreshGallery();
    if (parentId) await showImage(currentImage);
  }
  $('#btn-generate').onclick = async () => {
    if (busy) return;
    setBusy(true); status('正在生成，请稍候…');
    try {
      const model = models.find(m => m.id === $('#ai-model').value);
      const text = ($('#ai-final-prompt').value || $('#ai-prompt').value).trim(); if (!text) throw new Error('请填写提示词。');
      const { images, labels } = inputReferences();
      const prompt = `${text}\n${scenePrompt()}\n${labels}`;
      const result = await request({ model, prompt, images, size: imageSize(), purpose: 'image' });
      await remember(result.images, prompt, model); status('已生成并保存到本地历史。');
    } catch (err) { status(err.message); }
    finally { setBusy(false); if (!currentImage) { $('#studio-edit').disabled = $('#studio-layers').disabled = true; } }
  };
  function imageSize() { return $('#studio-size').value; }
  async function optimize(pipeline) {
    if (busy) return;
    setBusy(true);
    let run;
    try {
      const source = $('#ai-prompt').value.trim(); if (!source) throw new Error('请先填写提示词。');
      const { images, labels } = inputReferences();
      const constraints = `${scenePrompt()}\n${labels}\n原始用户需求：${source}`;
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
        status(`提示词处理 ${i + 1}/${stages.length}：${selected[i].id}`);
        const result = await request({ model: selected[i], purpose: 'text', images: selected[i].references ? images : [], prompt: `${stages[i][1]}\n不得改变人数和人脸身份要求，不添加用户未要求的角色。\n${constraints}\n${firstDraft ? `优化初稿：${firstDraft}\n` : ''}当前草稿或审查意见：${draft}` }, text => { run.stages[i].text = text; savePrompts(); }, outputs[i]);
        draft = result.text; savePrompts(); if (i === 0) firstDraft = draft;
      }
      promptState.final = draft; showFinal(); savePrompts(); status('提示词已优化，最终提示词可编辑后生图。');
    } catch (err) { if (run) { run.error = err.message; savePrompts(); } status(err.message); }
    finally { setBusy(false); if (!currentImage) { $('#studio-edit').disabled = $('#studio-layers').disabled = true; } }
  }
  $('#btn-optimize').onclick = () => optimize(false);
  $('#btn-pipeline').onclick = () => optimize(true);
  $('#ai-model').onchange = refreshModels;

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
    $('#studio-image-meta').textContent = item ? `${item.model} · ${new Date(item.created).toLocaleString('zh-CN')}` : '等待生成';
    ['#studio-copy', '#studio-save', '#studio-edit', '#studio-layers'].forEach(id => { $(id).disabled = !item || busy; });
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
      const label = document.createElement('span'); label.textContent = `${new Date(item.created).toLocaleString('zh-CN')}${item.parentId ? ' · 修图' : ''}${item.layers?.length ? ' · 已拆层' : ''}`;
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
      const info = document.createElement('p'); info.textContent = `${new Date(item.created).toLocaleString('zh-CN')} · ${item.model}${item.parentId ? ' · 修图' : ''}`;
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
      const model = models.find(m => m.id === $('#edit-model').value), instruction = $('#edit-prompt').value.trim();
      if (!instruction) throw new Error('请填写修改说明。');
      const parentId = currentImage.id;
      const images = [editCanvas.toDataURL('image/png')];
      // Preserve an unmarked identity reference when the model accepts multiple images.
      if (model?.maxReferences >= 2 && strokes.length) images.push(currentImage.url);
      const prompt = `修改说明：${instruction}\n图片 1 是用户涂鸦后的修图参考，涂鸦是编辑指示，不是最终成品内容。${images.length > 1 ? '图片 2 是未涂鸦的原图，用于保留人物身份和原始细节。' : ''}严格执行修改说明，保留未要求修改的区域、人物姿态和面部身份特征，去除指示性的涂鸦笔迹。`;
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
