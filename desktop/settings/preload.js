// 设置窗口的 preload（沙箱）
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (patch) => ipcRenderer.invoke('settings:set', patch),
  testKey: (key) => ipcRenderer.invoke('settings:test-key', key),
  models: () => ipcRenderer.invoke('settings:models'),
  balance: () => ipcRenderer.invoke('settings:balance'),
  clearHistory: () => ipcRenderer.invoke('settings:clear-history'),
  openData: () => ipcRenderer.send('settings:open-data'),
  openLink: (key) => ipcRenderer.send('settings:open-link', key),
  home: () => ipcRenderer.send('settings:home'),
  say: () => ipcRenderer.send('settings:say'),
  updateState: () => ipcRenderer.invoke('settings:update-get'),
  checkUpdate: () => ipcRenderer.invoke('settings:update-check'),
  installUpdate: () => ipcRenderer.invoke('settings:update-install'),
  cancelUpdate: () => ipcRenderer.send('settings:update-cancel'),
  onUpdate: (cb) => ipcRenderer.on('settings:update', (_e, st) => cb(st)),
  onChanged: (cb) => ipcRenderer.on('settings:changed', (_e, view) => cb(view)),
  onTab: (cb) => ipcRenderer.on('settings:tab', (_e, tab) => cb(tab)),
});
