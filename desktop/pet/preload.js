// 桌宠窗口的 preload：只暴露窗口控制原语，渲染端拿不到 Node / Electron。
//   setBounds        宠物窗口逐帧跟随（窗口内容区坐标 + 宠物尺寸 + 精灵在窗口内的偏移）
//   setInteractive   光标进/出她身上时翻转点击穿透
//   setInputBusy     拖拽 / 右键菜单期间：主进程绝不翻回穿透（翻了拖拽就断）
//   showContextMenu  右键 → 主进程弹系统原生菜单；关闭时回调 onMenuClosed
//   savePosition     她停稳后的位置（下次启动从这里出现）
//   openChat         打开聊天面板（拖图到她身上时带上图片）
//   onAction         主进程发来的动作：碎碎念 / 余额 / 点播动画 / 回家 / 说一句话…
//   onSuspend        窗口隐藏/恢复：隐藏期间挂起视频与定时任务，省电（见 sprite.js suspend/resume）
//   onName           改名字（不必重建整窗，只更新 title）
//   onAway           主人离开电脑 / 回来：离开时她播完这段就歇着（不再解码），回来接着播
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('petBridge', {
  setBounds(b) {
    const { x, y, width, height, size, bottomPad, offX, offY } = b || {};
    ipcRenderer.send('pet:set-bounds', { x, y, width, height, size, bottomPad, offX, offY });
  },
  setInteractive(interactive) {
    ipcRenderer.send('pet:set-interactive', !!interactive);
  },
  setInputBusy(busy) {
    ipcRenderer.send('pet:input-busy', !!busy);
  },
  showContextMenu() {
    ipcRenderer.send('pet:context-menu');
  },
  onMenuClosed(cb) {
    ipcRenderer.on('pet:menu-closed', () => cb());
  },
  savePosition(pos) {
    ipcRenderer.send('pet:save-position', pos || null);
  },
  openChat(payload) {
    ipcRenderer.send('pet:open-chat', payload || {});
  },
  ready() {
    ipcRenderer.send('pet:ready');
  },
  onAction(cb) {
    ipcRenderer.on('pet:action', (_e, action) => cb(action || {}));
  },
  onSuspend(cb) {
    ipcRenderer.on('pet:suspend', (_e, suspended) => cb(!!suspended));
  },
  onName(cb) {
    ipcRenderer.on('pet:name', (_e, name) => cb(String(name || '')));
  },
  onAway(cb) {
    ipcRenderer.on('pet:away', (_e, away) => cb(!!away));
  },
  onDisplays(cb) {
    ipcRenderer.on('pet:displays', (_e, geo) => cb(geo));
  },
  onActualBounds(cb) {
    ipcRenderer.on('pet:actual-bounds', (_e, b) => cb(b));
  },
});
