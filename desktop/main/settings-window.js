'use strict';
/**
 * 设置窗口：标准 macOS 偏好设置样式（左侧毛玻璃侧栏 + 右侧分组卡片），改了立即生效，不需要「保存」。
 */
const { BrowserWindow } = require('electron');
const path = require('node:path');
const { ORIGIN } = require('./service');
const { store } = require('./store');

function pageUrl(tab) {
  return ORIGIN + '/settings/index.html?lang=' + store.lang() + (tab ? '#' + tab : '');
}

let win = null;
let quitting = false;
let hooks = {};

function init(h) {
  hooks = h || {};
}

function open(tab) {
  if (win && !win.isDestroyed()) {
    if (tab) win.webContents.send('settings:tab', tab);
    if (hooks.onShow) hooks.onShow();
    win.show();
    win.focus();
    return win;
  }
  win = new BrowserWindow({
    width: 780,
    height: 580,
    minWidth: 680,
    minHeight: 480,
    show: false,
    title: store.t('set.window'),
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    fullscreenable: false,
    maximizable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'settings', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });
  win.loadURL(pageUrl(tab));
  win.once('ready-to-show', () => {
    if (hooks.onShow) hooks.onShow();
    win.show();
    win.focus();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.on('closed', () => {
    win = null;
    if (!quitting && hooks.onClose) hooks.onClose();
  });
  return win;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function isOpen() {
  return !!(win && !win.isDestroyed());
}

function setQuitting() {
  quitting = true;
}

/** 换语言后按新语言重新加载，停在指定的页 */
function reload(tab) {
  if (!win || win.isDestroyed()) return;
  win.setTitle(store.t('set.window'));
  win.loadURL(pageUrl(tab));
}

module.exports = { init, open, send, isOpen, setQuitting, reload };
