// Preload: expose a minimal, safe bridge to the renderer
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bodyFactory', {
  isElectron: true,
  setTheme: (theme) => ipcRenderer.invoke('set-theme', theme),
  loadAISettings: () => ipcRenderer.invoke('ai-settings-load'),
  saveAISettings: (settings) => ipcRenderer.invoke('ai-settings-save', settings),
  validateAIKey: (args) => ipcRenderer.invoke('ai-validate-key', args),
  onAIText: (callback) => {
    const listener = (event, data) => callback(data);
    ipcRenderer.on('ai-text-chunk', listener);
    return () => ipcRenderer.removeListener('ai-text-chunk', listener);
  },
  requestAI: (args) => ipcRenderer.invoke('ai-request', args),
  savePSD: (data) => ipcRenderer.invoke('save-psd', data),
  copyImage: (dataURL) => ipcRenderer.invoke('copy-image', dataURL),
  saveImage: (dataURL, defaultName) => ipcRenderer.invoke('save-image', { dataURL, defaultName }),
  saveJSON: (data, defaultName) => ipcRenderer.invoke('save-json', { data, defaultName }),
  openJSON: () => ipcRenderer.invoke('open-json'),
});
