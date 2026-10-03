// Desktop integration test: isolated userData, mocked network, no real API usage.
const { app, BrowserWindow, safeStorage, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'bodyfactory-test-'));
app.setPath('userData', temp);
let calls = [];
let failNextImage = false;
dialog.showSaveDialog = async (window, options) => ({ canceled: false, filePath: path.join(temp, options.filters[0].extensions[0] === 'psd' ? 'output.psd' : 'output.png') });
global.fetch = async (url, options) => {
  let body;
  if (options.body instanceof FormData) {
    assert.equal(options.headers['Content-Type'], undefined);
    body = Object.fromEntries([...options.body.entries()].filter(([name]) => name !== 'image[]'));
    body.images = await Promise.all(options.body.getAll('image[]').map(async file => ({ image_url: `data:${file.type};base64,${Buffer.from(await file.arrayBuffer()).toString('base64')}` })));
  } else body = JSON.parse(options.body);
  calls.push({ url, body, multipart: options.body instanceof FormData });
  if (url.endsWith('/chat/completions')) {
    const planner = body.messages[0].content[0].text.includes('只输出 JSON');
    const content = planner ? JSON.stringify({ layers: ['文字', '文字底板', '主体', '背景'].map(name => ({ name, description: `保留${name}，其他区域透明。` })) }) : '优化后的提示词：保留人物身份与构图。';
    if (body.stream) return {
      ok: true, headers: { get: name => name === 'content-type' ? 'text/event-stream' : null },
      body: (async function* () {
        for (const part of [content.slice(0, 3), content.slice(3)]) {
          yield Buffer.from(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
          await new Promise(resolve => setTimeout(resolve, 30));
        }
        yield Buffer.from('data: [DONE]\n\n');
      })(),
    };
    return { ok: true, text: async () => JSON.stringify({ choices: [{ message: { content } }] }) };
  }
  if (body.model === 'inclusionai/ming-image-0.1-design-layer') {
    assert.ok(url.endsWith('/images/edits'));
    assert.equal(options.body instanceof FormData, true);
    assert.equal(body.size, undefined); assert.equal(body.input_fidelity, undefined);
    const pixels = body.images[0].image_url.split(',')[1];
    return { ok: true, text: async () => JSON.stringify({ data: Array.from({ length: 4 }, () => ({ b64_json: pixels })) }) };
  }
  if (failNextImage) {
    failNextImage = false;
    return { ok: false, status: 500, headers: { get: () => 'test-request-500' }, text: async () => JSON.stringify({ error: { type: 'provider_api_error', message: 'Server encountered an unexpected error.' } }) };
  }
  const image = body.images?.[0]?.image_url || 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
  return { ok: true, text: async () => JSON.stringify({ data: [{ b64_json: image.split(',')[1] }] }) };
};
require('../main.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0]; win.show(); win.webContents.setBackgroundThrottling(false);
  const errors = [];
  win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  const run = code => { if (process.env.BF_TEST_TRACE) console.log('Renderer:', code.slice(0, 100)); return Promise.race([win.webContents.executeJavaScript(code), sleep(15000).then(() => { throw new Error('Renderer timeout: ' + code.slice(0, 80)); })]); };
  const until = async expression => { for (let i = 0; i < 100; i++) { if (await run(expression)) return; await sleep(100); } throw new Error(`Timed out: ${expression}`); };
  try {
    if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await until('!!window.__bf && document.querySelector("#ai-model").options.length === 6');
    assert.equal(await run(`document.body.dataset.workspace`), 'studio');
    assert.equal(await run(`document.querySelector('#ai-use-pose').checked`), false);
    if (process.env.BF_SCREENSHOT) fs.writeFileSync(process.env.BF_SCREENSHOT, (await win.webContents.capturePage()).toPNG());
    assert.ok(await run(`document.querySelector('#ai-prompt').getBoundingClientRect().width > 200 && document.querySelector('#studio-display').getBoundingClientRect().width > 300 && document.querySelector('#btn-generate').getBoundingClientRect().bottom <= innerHeight`));
    await run(`document.querySelector('#btn-pose-editor').click(); window.__bf.setFigureCount(5); window.__bf.activateFigure(1); document.querySelector('#figure-gender').value = 'male'; document.querySelector('#figure-gender').dispatchEvent(new Event('change'));`);
    const figures = await run(`window.__bf.figures.map(m => ({ gender: m.gender, bust: m.shape.bust, x: m.group.position.x }))`);
    assert.equal(figures.length, 5); assert.equal(figures[1].gender, 'male'); assert.equal(figures[1].bust, 0); assert.equal(figures[0].bust, 1);
    assert.equal(new Set(figures.map(f => f.x)).size, 5);
    await run(`document.querySelector('#btn-undo').click()`);
    assert.equal(await run(`window.__bf.figures[1].gender`), 'female');
    await run(`document.querySelector('#btn-redo').click()`);
    assert.equal(await run(`window.__bf.figures[1].gender`), 'male');
    await run(`window.__bf.setFigureCount(2); document.querySelector('#btn-back-studio').click(); document.querySelector('#btn-settings').click(); document.querySelector('#ui-theme').value = 'light'; document.querySelector('#ui-theme').dispatchEvent(new Event('change')); document.querySelector('#api-key').value = 'desktop-test-key'; document.querySelector('#btn-save-ai').click();`);
    if (!safeStorage.isEncryptionAvailable()) throw new Error('OS secure storage unavailable');
    await until(`!document.querySelector('#settings-dialog').open`);
    const saved = fs.readFileSync(path.join(temp, 'zenmux-settings.json'), 'utf8');
    assert.ok(!saved.includes('desktop-test-key')); assert.ok(JSON.parse(saved).encryptedKey);
    const legacy = JSON.parse(saved);
    legacy.models.find(m => m.id === 'inclusionai/ming-image-0.1-design-layer').protocol = 'vertex-predict';
    fs.writeFileSync(path.join(temp, 'zenmux-settings.json'), JSON.stringify(legacy));
    assert.equal(await run(`window.bodyFactory.loadAISettings().then(s => s.models.find(m => m.id === 'inclusionai/ming-image-0.1-design-layer').protocol)`), 'openai-images');
    assert.equal(await run(`document.querySelector('#api-key').value`), '');
    await run(`document.querySelector('#ai-model').value = 'openai/gpt-image-2.5-flare'; document.querySelector('#ai-model').dispatchEvent(new Event('change')); document.querySelector('#ai-prompt').value = '两个人物的摄影参考'; document.querySelector('#btn-generate').click()`);
    await until(`!document.querySelector('#studio-image').hidden && !document.querySelector('#studio-edit').disabled`);
    assert.equal(await run(`document.querySelector('#image-dialog').open`), false);
    assert.equal(await run(`document.querySelectorAll('.studio-history-card').length`), 1);
    await run(`document.querySelector('#studio-edit').click()`);
    await until(`document.querySelector('#image-dialog').open`);
    assert.ok(calls[0].url.endsWith('/images/edits')); assert.equal(calls[0].body.images.length, 1); assert.equal(calls[0].multipart, true);
    assert.ok(calls[0].body.prompt.includes('默认穿着完整日常服装') && calls[0].body.prompt.includes('不复制人偶的裸露表面'));
    await run(`document.querySelector('#image-zoom-in').click(); document.querySelector('#image-copy').click()`);
    assert.equal(await run(`document.querySelector('#image-zoom').textContent`), '125%');
    await until(`document.querySelector('#edit-status').textContent.includes('已复制')`);
    await run(`document.querySelector('#image-save').click()`);
    await until(`document.querySelector('#edit-status').textContent.includes('已另存为')`);
    assert.ok(fs.existsSync(path.join(temp, 'output.png')));
    const rect = await run(`(() => { const r = document.querySelector('#edit-canvas').getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) }; })()`);
    win.webContents.sendInputEvent({ type: 'mouseDown', ...rect, button: 'left', clickCount: 1 });
    win.webContents.sendInputEvent({ type: 'mouseUp', ...rect, button: 'left', clickCount: 1 });
    await sleep(100);
    await run(`document.querySelector('#edit-prompt').value = '改为蓝色外套'; document.querySelector('#btn-edit-image').click()`);
    await until(`document.querySelector('#edit-status').textContent.includes('修图已完成')`);
    assert.equal(calls[1].body.images.length, 2);
    await run(`document.querySelector('#image-dialog').close(); document.querySelector('#btn-history').click()`);
    await until(`document.querySelectorAll('.history-card').length === 2`);
    await run(`document.querySelector('#history-dialog').close(); window.__streamUpdates = []; window.__stopStream = window.bodyFactory.onAIText(data => window.__streamUpdates.push(data.text)); document.querySelector('#btn-pipeline').click()`);
    await until(`document.querySelector('#ai-status').textContent.includes('提示词已优化')`);
    assert.ok(await run(`window.__streamUpdates.length >= 6 && window.__streamUpdates.some(text => text.length === 3)`));
    await run(`window.__stopStream()`);
    assert.ok(await run(`!document.querySelector('#ai-stream-output').hidden && document.querySelector('#ai-stream-output').textContent.includes('优化后的提示词')`));
    assert.deepEqual(calls.slice(2).map(call => call.body.model), ['openai/gpt-6.1-sol', 'anthropic/claude-sonnet-5.5', 'google/gemini-3.8-flash']);
    await run(`document.querySelector('#btn-history').click()`);
    await until(`document.querySelectorAll('.history-card').length === 2`);
    await run(`document.querySelector('.history-card img').click()`);
    await until(`document.querySelector('#image-dialog').open`);
    await run(`document.querySelector('#layer-section').open = true; document.querySelector('#btn-discuss-layers').click()`);
    await until(`document.querySelector('#layer-status').textContent.includes('方案已生成')`);
    await run(`document.querySelector('#btn-split-layers').click()`);
    await until(`document.querySelectorAll('.layer-result').length === 4 && !document.querySelector('#btn-split-layers').disabled`);
    await run(`document.querySelector('#btn-export-psd').click()`);
    await until(`document.querySelector('#layer-status').textContent.includes('PSD 已保存')`);
    assert.equal(fs.readFileSync(path.join(temp, 'output.psd')).toString('ascii', 0, 4), '8BPS');
    await run(`document.querySelector('#image-dialog').close(); document.querySelector('#history-dialog').close()`);
    await sleep(500); win.reload(); await sleep(500);
    await until('!!window.__bf && document.querySelector("#ai-model").options.length === 6');
    assert.equal(await run(`document.documentElement.dataset.theme`), 'light');
    assert.equal(await run(`getComputedStyle(document.documentElement).getPropertyValue('--text').trim()`), '#182338');
    assert.equal(await run(`window.__bf.figures.length`), 2);
    assert.equal(await run(`window.__bf.figures[1].gender`), 'male');
    await run(`document.querySelector('#btn-history').click()`);
    await until(`document.querySelectorAll('.history-card').length === 2`);
    await run(`document.querySelector('#history-all').click(); document.querySelector('#history-delete').click()`);
    await until(`document.querySelectorAll('.history-card').length === 0`);
    await run(`document.querySelector('#history-dialog').close(); document.querySelector('#ai-model').value = 'openai/gpt-image-2.5-sunburst'; document.querySelector('#ai-use-pose').checked = true; document.querySelector('#ai-prompt').value = '一个男人 在走路'`);
    const beforeFailure = calls.length; failNextImage = true;
    await run(`document.querySelector('#btn-generate').click()`);
    await until(`!document.querySelector('#ai-error-details').hidden && !document.querySelector('#btn-generate').disabled`);
    assert.equal(calls.length, beforeFailure + 1);
    assert.ok(calls.at(-1).url.endsWith('/images/edits'));
    assert.ok(await run(`document.querySelector('#ai-error-diagnostics').textContent.includes('test-request-500')`));
    const diagnostic = fs.readFileSync(path.join(temp, 'zenmux-last-error.json'), 'utf8');
    assert.ok(!diagnostic.includes('desktop-test-key') && !diagnostic.includes('一个男人') && !diagnostic.includes('base64'));
    await run(`document.querySelector('#btn-settings').click(); document.querySelector('#api-key').value = 'unsaved-test-key'; document.querySelector('#btn-validate-key').click()`);
    await until(`!document.querySelector('#btn-validate-key').disabled`);
    assert.ok(await run(`document.querySelector('#key-validation').textContent.includes('文字：验证通过') && document.querySelector('#key-validation').textContent.includes('生图（无参考图）：验证通过')`));
    assert.ok(calls.at(-1).url.endsWith('/images/generations'));
    assert.equal(calls.at(-1).body.model, 'openai/gpt-image-2.5-flare');
    assert.equal(calls.at(-2).body.model, 'openai/gpt-6.1-sol');
    assert.ok(!fs.readFileSync(path.join(temp, 'zenmux-settings.json'), 'utf8').includes('unsaved-test-key'));
    failNextImage = true;
    await run(`document.querySelector('#btn-validate-key').click()`);
    await until(`!document.querySelector('#btn-validate-key').disabled`);
    assert.ok(await run(`document.querySelector('#key-validation').textContent.includes('文字：验证通过') && document.querySelector('#key-validation').textContent.includes('500')`));
    await run(`document.querySelector('#settings-dialog').close(); document.querySelector('#btn-generate').click()`);
    await until(`document.querySelector('#ai-error-details').hidden && !document.querySelector('#btn-generate').disabled`);
    assert.deepEqual(errors, []);
    console.log('PASS: visible AI input/output, optional pose editor, inline results/history, figures, independent gender/shape, undo/redo, encrypted settings, image generation, zoom/copy, doodle editing, optimization pipeline, reload persistence and batch history deletion, layer planning, RGBA splitting, PSD export persistent light theme, sanitized 500 diagnostics, explicit retry recovery and separate text/image Key validation and incremental SSE rendering.');
  } catch (error) { console.error(error); process.exitCode = 1; }
  finally { win.destroy(); fs.rmSync(temp, { recursive: true, force: true }); app.exit(process.exitCode || 0); }
});
