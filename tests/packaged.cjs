// Smoke-test the actual packaged renderer, including bundled module resolution.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const archive = path.resolve(process.argv[2]);
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'figfactory-packaged-'));
app.setPath('userData', temp);
require(path.join(archive, 'main.js'));
app.whenReady().then(async () => {
  try {
    const win = BrowserWindow.getAllWindows()[0];
    if (win.webContents.isLoading()) await new Promise(resolve => win.webContents.once('did-finish-load', resolve));
    const deadline = Date.now() + 20000;
    while (!await win.webContents.executeJavaScript('!!window.__bf && document.querySelector("#ai-model").options.length > 0')) {
      if (Date.now() > deadline) throw new Error('Packaged renderer did not initialize');
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert.ok(await win.webContents.executeJavaScript(`document.querySelector('#ai-prompt').getBoundingClientRect().width > 200 && document.querySelector('#btn-settings').getBoundingClientRect().width > 0 && document.querySelector('#btn-generate').getBoundingClientRect().width > 0`));
    await win.webContents.executeJavaScript(`document.querySelector('#btn-settings').click()`);
    assert.ok(await win.webContents.executeJavaScript(`document.querySelector('#settings-dialog').open && document.querySelector('#api-key').getBoundingClientRect().width > 0`));
    console.log('PASS: packaged AI input, generate button, settings dialog and API Key input');
    app.exit(0);
  } catch (error) { console.error(error); app.exit(1); }
});
