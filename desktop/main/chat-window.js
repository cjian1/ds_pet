'use strict';
/**
 * 聊天面板：贴在她身边的小浮窗（macOS 原生 popover 毛玻璃），跟着她走。
 * 关掉只是隐藏，聊天记录在 memory.json 里，下次打开接着聊。
 */
const { BrowserWindow, screen } = require('electron');
const path = require('node:path');
const { ORIGIN } = require('./service');
const { store } = require('./store');

function pageUrl() {
  return ORIGIN + '/chat/index.html?lang=' + store.lang();
}

const W = 360;
const H = 540;
const GAP = 10;

let win = null;
let ready = false;
let pending = [];
/** 用户自己拖过面板：本次打开期间不再自动贴着她 */
let userPlaced = false;
let programmaticMove = false;
let quitting = false;
let getBodyRect = () => null;

function setBodyRectProvider(fn) {
  getBodyRect = fn;
}

function create() {
  ready = false;
  win = new BrowserWindow({
    width: W,
    height: H,
    minWidth: 300,
    minHeight: 380,
    maxWidth: 560,
    show: false,
    frame: false,
    resizable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    vibrancy: 'popover',
    visualEffectState: 'active',
    backgroundColor: '#00000000',
    roundedCorners: true,
    hasShadow: true,
    title: store.t('chat.window'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'chat', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.setAlwaysOnTop(true, 'status');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.loadURL(pageUrl());
  win.webContents.on('did-finish-load', () => {
    ready = true;
    const q = pending;
    pending = [];
    for (const [ch, payload] of q) win.webContents.send(ch, payload);
  });
  win.on('will-move', () => {
    if (!programmaticMove) userPlaced = true;
  });
  win.on('close', (e) => {
    if (!quitting) {
      e.preventDefault();
      win.hide();
    }
  });
  win.on('closed', () => {
    win = null;
    ready = false;
  });
  // 外链（比如设置里的帮助链接）一律不在面板里打开
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  return win;
}

function ensure() {
  if (!win || win.isDestroyed()) create();
  return win;
}

/** 贴着她摆：优先放左边，左边放不下放右边；上下居中对齐她的身体，夹在工作区内 */
function place() {
  if (!win || win.isDestroyed()) return;
  const body = getBodyRect();
  const [w, h] = win.getSize();
  let x;
  let y;
  if (body) {
    const center = { x: Math.round(body.x + body.width / 2), y: Math.round(body.y + body.height / 2) };
    const wa = screen.getDisplayNearestPoint(center).workArea;
    x = body.x - w - GAP;
    if (x < wa.x + 8) x = body.x + body.width + GAP;
    if (x + w > wa.x + wa.width - 8) x = wa.x + wa.width - w - 8;
    x = Math.max(wa.x + 8, x);
    y = Math.round(body.y + body.height / 2 - h / 2);
    y = Math.max(wa.y + 8, Math.min(wa.y + wa.height - h - 8, y));
  } else {
    const wa = screen.getPrimaryDisplay().workArea;
    x = wa.x + wa.width - w - 24;
    y = wa.y + wa.height - h - 24;
  }
  programmaticMove = true;
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h }, false);
  setTimeout(() => {
    programmaticMove = false;
  }, 50);
}

function send(channel, payload) {
  // 面板没开着就什么都不发：绝不为了一条消息把隐藏的聊天渲染进程建出来（白占内存）。
  // 打开面板走 show()，它自己会 ensure()，所以没有「先排队、以后再打开」的用法。
  if (!win || win.isDestroyed()) return;
  if (ready) win.webContents.send(channel, payload);
  else pending.push([channel, payload]);
}

function show() {
  const w = ensure();
  if (!w.isVisible()) {
    userPlaced = false;
    place();
  }
  w.show();
  w.focus();
  send('chat:focus');
}

function hide() {
  if (win && !win.isDestroyed()) win.hide();
}

function isVisible() {
  return !!(win && !win.isDestroyed() && win.isVisible());
}

/** 她动了：面板跟着（用户手动拖过就不跟） */
let followTimer = null;
function follow() {
  if (!isVisible() || userPlaced || followTimer) return;
  followTimer = setTimeout(() => {
    followTimer = null;
    if (isVisible() && !userPlaced) place();
  }, 40);
}

function setQuitting() {
  quitting = true;
}

/** 换语言后重新加载（聊天记录在磁盘上，重载不丢） */
function reload() {
  if (!win || win.isDestroyed()) return;
  ready = false;
  win.setTitle(store.t('chat.window'));
  win.loadURL(pageUrl());
}

function window() {
  return win && !win.isDestroyed() ? win : null;
}

module.exports = { show, hide, isVisible, send, follow, setQuitting, setBodyRectProvider, window, reload };
