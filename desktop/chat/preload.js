// 聊天面板的 preload（沙箱）：只暴露聊天相关的几个调用
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatApi', {
  init: () => ipcRenderer.invoke('chat:init'),
  send: (payload) => ipcRenderer.invoke('chat:send', payload),
  stop: () => ipcRenderer.send('chat:stop'),
  clear: () => ipcRenderer.invoke('chat:clear'),
  close: () => ipcRenderer.send('chat:close'),
  openSettings: (tab) => ipcRenderer.send('chat:open-settings', tab),
  onStream: (cb) => ipcRenderer.on('chat:stream', (_e, m) => cb(m)),
  onAttach: (cb) => ipcRenderer.on('chat:attach', (_e, m) => cb(m)),
  onRefresh: (cb) => ipcRenderer.on('chat:refresh', (_e, m) => cb(m)),
  onFocus: (cb) => ipcRenderer.on('chat:focus', () => cb()),
});
