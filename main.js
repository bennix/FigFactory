// Electron main process for BodyFactory
const { app, BrowserWindow, ipcMain, dialog, nativeTheme, safeStorage, clipboard, ClipboardItem, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const { buildRequest, readResponse, requestPayload } = require('./src/zenmux.cjs');
const { makePSD } = require('./src/psd.cjs');
const { readTextStream } = require('./src/zenmux-stream.cjs');
const { responseFailure } = require('./src/zenmux-errors.cjs');

const { WeightStore } = require('./src/local-weights.cjs');
const { LocalEngine } = require('./src/local-ai.cjs');
let localWeights, localEngine;
function localServices() {
  if (!localWeights) {
    const bundled = path.join(process.resourcesPath, 'local-ai');
    const hasBundledRuntime = app.isPackaged && fs.existsSync(path.join(bundled, 'models', 'catalog.json')) && fs.existsSync(path.join(bundled, 'engine', 'ready.json'));
    const modelsRoot = hasBundledRuntime ? path.join(bundled, 'models') : path.join(app.getPath('userData'), 'local-models');
    const engineRoot = hasBundledRuntime ? path.join(bundled, 'engine') : path.join(app.getPath('userData'), 'local-engine');
    const runtimeRoot = hasBundledRuntime ? path.join(app.getPath('userData'), 'local-engine-runtime') : engineRoot;
    localWeights = new WeightStore(modelsRoot);
    localEngine = new LocalEngine(engineRoot, localWeights, runtimeRoot);
  }
  return { weights: localWeights, engine: localEngine };
}
ipcMain.handle('local-ai', async (event, { action, ...args }) => {
  const { weights, engine } = localServices();
  const progress = data => { if (!event.sender.isDestroyed()) event.sender.send('local-ai-progress', data); };
  try {
    let result;
    switch (action) {
      case 'status': result = engine.status(); break;
      case 'catalog': result = await weights.catalog(args.refresh); break;
      case 'download': if (engine.bundled) throw new Error('此离线版已内置并校验 Turbo 权重，不能修改应用包内文件。'); result = await weights.download(args.dit, args.encoder, progress, args.mirror); break;
      case 'cancel-download': weights.cancel(); break;
      case 'install': result = await engine.install(progress, args.mirror); break;
      case 'start': result = await engine.start(progress); break;
      case 'stop': engine.stop(); break;
      case 'generate': result = await engine.generate(args, progress); break;
      case 'open-models': fs.mkdirSync(weights.root, { recursive: true }); await shell.openPath(weights.root); break;
      default: throw new Error('未知本地操作。');
    }
    return { ok: true, result };
  } catch (error) { return { ok: false, error: error.name === 'AbortError' ? '已取消，下载断点已保留。' : error.message }; }
});
app.on('before-quit', () => { localWeights?.cancel(); localEngine?.stop(); });

function createWindow() {
  nativeTheme.themeSource = 'dark';
  const win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#0e1016',
    title: 'BodyFactory 形体工坊',
    icon: path.join(__dirname, 'src', 'assets', 'app-icon.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url === 'https://zenmux.ai/invite/GBQMC5') shell.openExternal(url);
    return { action: 'deny' };
  });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

ipcMain.handle('set-theme', (event, theme) => {
  if (theme === 'light' || theme === 'dark') nativeTheme.themeSource = theme;
});

// Save a PNG given as data URL
ipcMain.handle('save-image', async (event, { dataURL, defaultName }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '导出形体参考图',
    defaultPath: path.join(app.getPath('pictures'), defaultName || 'pose.png'),
    filters: [{ name: 'PNG 图片', extensions: ['png'] }],
  });
  if (canceled || !filePath) return { ok: false };
  const base64 = dataURL.replace(/^data:image\/png;base64,/, '');
  fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  return { ok: true, filePath };
});

// Save pose JSON
ipcMain.handle('save-json', async (event, { data, defaultName }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: '保存姿势',
    defaultPath: path.join(app.getPath('documents'), defaultName || 'pose.json'),
    filters: [{ name: '姿势文件', extensions: ['json'] }],
  });
  if (canceled || !filePath) return { ok: false };
  fs.writeFileSync(filePath, data, 'utf-8');
  return { ok: true, filePath };
});

// Open pose JSON
ipcMain.handle('open-json', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  const { canceled, filePaths } = await dialog.showOpenDialog(win, {
    title: '载入姿势',
    filters: [{ name: '姿势文件', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (canceled || !filePaths.length) return { ok: false };
  return { ok: true, data: fs.readFileSync(filePaths[0], 'utf-8') };
});

// Keep credentials encrypted on disk and out of renderer responses.
const settingsPath = () => path.join(app.getPath('userData'), 'zenmux-settings.json');
function readAISettings() {
  try {
    const data = JSON.parse(fs.readFileSync(settingsPath(), 'utf8'));
    if (Array.isArray(data.models)) for (const model of data.models) {
      if (['inclusionai/ming-image-0.1-design', 'inclusionai/ming-image-0.1-design-layer', 'x-ai/grok-imagine-image-2.0'].includes(model.id) && model.protocol === 'vertex-predict') model.protocol = 'openai-images';
    }
    return data;
  }
  catch (err) { if (err.code === 'ENOENT') return {}; throw err; }
}
function publicSettings(data) { return { models: data.models, hasKey: !!data.encryptedKey, secureStorage: safeStorage.isEncryptionAvailable() }; }
ipcMain.handle('ai-settings-load', () => {
  try { return { ok: true, ...publicSettings(readAISettings()) }; }
  catch { return { ok: false, error: '无法读取本地 AI 设置。' }; }
});
ipcMain.handle('ai-settings-save', (event, { models, apiKey, clearKey }) => {
  try {
    const data = readAISettings();
    if (clearKey) delete data.encryptedKey;
    if (apiKey) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统加密服务不可用，无法安全保存 Key。');
      data.encryptedKey = safeStorage.encryptString(apiKey.trim()).toString('base64');
    }
    if (models) data.models = models;
    const filename = settingsPath();
    fs.writeFileSync(filename + '.tmp', JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(filename + '.tmp', filename);
    return { ok: true, ...publicSettings(data) };
  } catch (err) { return { ok: false, error: err.message }; }
});
async function requestAI(args, testKey, onText = () => {}) {
  try {
    const settings = readAISettings();
    if (!testKey && !settings.encryptedKey) throw new Error('请先在设置中保存 ZenMux API Key。');
    const key = testKey || safeStorage.decryptString(Buffer.from(settings.encryptedKey, 'base64'));
    const request = buildRequest(args);
    const payload = requestPayload(request);
    const response = await fetch(request.url, {
      method: 'POST', headers: { Authorization: `Bearer ${key}`, ...payload.headers },
      body: payload.body, signal: AbortSignal.timeout(300000),
    });
    if (response.ok && args.purpose === 'text' && response.headers?.get?.('content-type')?.includes('text/event-stream')) {
      return { ok: true, ...await readTextStream(response.body, onText) };
    }
    const raw = await response.text();
    let data;
    try { data = JSON.parse(raw); }
    catch { data = { error: { message: `服务返回了非 JSON 响应（HTTP ${response.status}）。` } }; }
    if (!response.ok) {
      const failure = responseFailure({
        status: response.status, data, key, model: args.model.id, endpoint: request.url,
        imageCount: args.images?.length || 0, transport: payload.transport,
        requestId: response.headers?.get?.('x-zenmux-requestid') || response.headers?.get?.('x-request-id'),
      });
      try { fs.writeFileSync(path.join(app.getPath('userData'), 'zenmux-last-error.json'), JSON.stringify(failure.diagnostics, null, 2), { mode: 0o600 }); } catch {}
      return { ok: false, ...failure };
    }
    const result = readResponse(data, args.purpose);
    if (result.images) result.images = await Promise.all(result.images.map(async url => {
      if (url.startsWith('data:')) return url;
      if (!url.startsWith('https://')) throw new Error('模型返回了不支持的图片地址。');
      const imageResponse = await fetch(url, { signal: AbortSignal.timeout(60000) });
      if (!imageResponse.ok) throw new Error('下载生成图失败。');
      const type = imageResponse.headers.get('content-type')?.split(';')[0];
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(type)) throw new Error('生成图格式不受支持。');
      return `data:${type};base64,${Buffer.from(await imageResponse.arrayBuffer()).toString('base64')}`;
    }));
    return { ok: true, ...result };
  } catch (err) { return { ok: false, error: err.name === 'TimeoutError' ? '请求超时，请稍后重试。' : err.message }; }
}
ipcMain.handle('ai-request', (event, args) => requestAI(args, undefined, text => {
  if (!event.sender.isDestroyed()) event.sender.send('ai-text-chunk', { requestId: args.requestId, text });
}));
ipcMain.handle('ai-validate-key', async (event, { apiKey }) => {
  const key = typeof apiKey === 'string' ? apiKey.trim() : '';
  const text = await requestAI({ model: { id: 'openai/gpt-6.1-sol' }, purpose: 'text', prompt: '请只回复：验证成功。' }, key);
  const image = await requestAI({ model: { id: 'openai/gpt-image-2.5-flare', protocol: 'openai-images' }, purpose: 'image', prompt: 'A simple blue circle on a white background.', images: [] }, key);
  return { text, image };
});
ipcMain.handle('save-psd', async (event, data) => {
  try {
    const buffer = makePSD(data);
    const { canceled, filePath } = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: '另存为分层 PSD', defaultPath: path.join(app.getPath('pictures'), 'bodyfactory_layers.psd'),
      filters: [{ name: 'Photoshop 文档', extensions: ['psd'] }],
    });
    if (canceled || !filePath) return { ok: false, canceled: true };
    fs.writeFileSync(filePath, buffer); return { ok: true, filePath };
  } catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('copy-image', async (event, dataURL) => {
  const image = nativeImage.createFromDataURL(dataURL);
  if (image.isEmpty()) return { ok: false, error: '图片无法复制。' };
  try {
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([image.toPNG()], { type: 'image/png' }) })]);
    return { ok: true };
  } catch { return { ok: false, error: '无法写入系统剪贴板。' }; }
});

app.whenReady().then(() => {
  if (process.platform === 'darwin') app.dock.setIcon(path.join(__dirname, 'src', 'assets', 'app-icon.png'));
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  localEngine?.stop();
  if (process.platform !== 'darwin') app.quit();
});
