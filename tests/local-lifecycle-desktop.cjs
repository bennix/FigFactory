// Real ComfyUI lifecycle through the application's visible service switches.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { LocalEngine } = require('../src/local-ai.cjs');
const source = process.env.FIGFACTORY_DATA || path.join(os.homedir(), 'Library/Application Support/BodyFactory 形体工坊');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'figfactory-lifecycle-'));
for (const name of ['local-models', 'local-engine']) fs.symlinkSync(path.join(source, name), path.join(root, name), 'dir');
app.setPath('userData', root);
let engine;
const originalStart = LocalEngine.prototype.start;
LocalEngine.prototype.start = function (...args) { engine = this; return originalStart.apply(this, args); };
require('../main.js');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(predicate, label, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await predicate()) return; await sleep(250); }
  throw new Error('Timed out: ' + label);
}
async function closed(port, pid) {
  try { process.kill(pid, 0); return false; } catch (error) { if (error.code !== 'ESRCH') throw error; }
  try { await fetch(`http://127.0.0.1:${port}/system_stats`, { signal: AbortSignal.timeout(500) }); return false; } catch { return true; }
}
app.whenReady().then(async () => {
  const win = BrowserWindow.getAllWindows()[0];
  const run = code => win.webContents.executeJavaScript(code);
  const toggle = async (id, checked) => run(`document.querySelector('${id}').checked=${checked}; document.querySelector('${id}').dispatchEvent(new Event('change')); void 0`);
  const result = { status: 'running', checks: [] };
  try {
    if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    await waitFor(() => run(`document.querySelector('#ai-model').options.length > 0`), 'application setup');
    await run(`document.querySelector('#ai-provider').value='local'; document.querySelector('#ai-provider').dispatchEvent(new Event('change')); document.querySelector('#local-settings').click(); void 0`);
    await waitFor(() => run(`!document.querySelector('#local-service-settings-toggle').disabled`), 'installed engine recognized');
    assert.equal(await run(`document.querySelector('#local-service-toggle').checked`), false);
    await toggle('#local-service-settings-toggle', true);
    await waitFor(() => engine?.status().running, 'real ComfyUI startup');
    const port = engine.port, pid = engine.process.pid;
    const stats = await engine.json(engine.url('/system_stats'));
    assert.equal(stats.devices[0].type, 'mps');
    await waitFor(() => run(`document.querySelector('#local-service-toggle').checked && !document.querySelector('#local-service-settings-toggle').disabled`), 'both switches on');
    result.checks.push({ step: 'start-from-settings', port, pid, device: stats.devices[0].type });
    await toggle('#local-service-toggle', false);
    await waitFor(() => closed(port, pid), 'process and port closed');
    await waitFor(() => run(`!document.querySelector('#local-service-settings-toggle').checked`), 'both switches off');
    result.checks.push({ step: 'stop-from-workspace', processExited: true, portClosed: true });
    // Accelerate only the idle timeout in this test, exercising real process shutdown.
    engine.idleTimeoutMs = 3000;
    await toggle('#local-service-settings-toggle', true);
    await waitFor(() => engine.status().running, 'restart');
    const idlePort = engine.port, idlePid = engine.process.pid;
    await waitFor(() => closed(idlePort, idlePid), 'automatic idle shutdown');
    await waitFor(() => run(`!document.querySelector('#local-service-toggle').checked && !document.querySelector('#local-service-settings-toggle').checked`), 'idle shutdown reflected in UI');
    result.checks.push({ step: 'restart-and-idle-stop', processExited: true, portClosed: true, switchesOff: true });
    result.status = 'passed';
    console.log('PASS real startup, manual stop, restart, idle shutdown and synchronized application switches');
  } catch (error) { result.status = 'failed'; result.error = error.stack; console.error(error); console.error('Engine status:', engine?.status(), 'Engine log:', engine?.logs?.slice(-2500)); process.exitCode = 1; }
  finally {
    engine?.stop();
    const output = path.join(source, 'local-smoke', 'lifecycle-result.json');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, JSON.stringify(result, null, 2));
    win.destroy(); fs.rmSync(root, { recursive: true, force: true }); app.exit(process.exitCode || 0);
  }
});
