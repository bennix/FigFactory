// Dev helper: load a page in a hidden Electron window and save a screenshot.
// usage: npx electron scripts/snap.js <relative-page-with-query> <out.png> [width] [height] [delayMs]
const { app, BrowserWindow } = require('electron');
const path = require('path');
const fs = require('fs');

const [page, out, w = '1600', h = '1200', delay = '2500'] = process.argv.slice(2);
app.commandLine.appendSwitch('force-device-scale-factor', '1');
app.whenReady().then(async () => {
  const win = new BrowserWindow({
    width: Number(w), height: Number(h), show: false,
    webPreferences: { preload: path.join(__dirname, '..', 'preload.js'), contextIsolation: true },
  });
  const logs = [];
  win.webContents.on('console-message', (e, level, message) => logs.push(`[${level}] ${message}`));
  const [file, query] = page.split('?');
  await win.loadFile(path.join(__dirname, '..', file), query ? { search: query } : {});
  await new Promise((r) => setTimeout(r, Number(delay)));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(out, img.toPNG());
  if (logs.length) console.log(logs.join('\n'));
  console.log('saved', out);
  app.quit();
});
