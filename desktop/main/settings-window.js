'use strict';
/**
 * 设置窗口：标准 macOS 偏好设置样式（左侧毛玻璃侧栏 + 右侧分组卡片），改了立即生效，不需要「保存」。
 * Windows 上没有红绿灯和毛玻璃：隐藏标题栏，右上角是系统的最小化 / 最大化 / 关闭按钮，底色见 window-chrome.js。
 */
const { BrowserWindow } = require('electron');
const path = require('node:path');
const { ORIGIN } = require('./service');
const { store } = require('./store');
const chrome = require('./window-chrome');

function pageUrl(tab) {
  return ORIGIN + '/settings/index.html?lang=' + store.lang() + (tab ? '#' + tab : '');
}

let win = null;
let quitting = false;
let hooks = {};

function init(h) {
  hooks = h || {};
}

/** 窗口选项：macOS 是侧栏毛玻璃 + 内嵌红绿灯；Windows 是隐藏标题栏 + 系统按钮浮在右上角 */
function windowOptions(platform = process.platform) {
  const opts = {
    width: 780,
    height: 580,
    minWidth: 680,
    minHeight: 480,
    show: false,
    title: store.t('set.window'),
    fullscreenable: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'settings', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  };
  if (platform === 'win32') {
    Object.assign(opts, {
      titleBarStyle: 'hidden',
      titleBarOverlay: chrome.titleBarOverlay(),
      backgroundColor: chrome.color('sidebar'),
      icon: path.join(__dirname, '..', 'resources', 'icon.ico'),
    });
  } else {
    Object.assign(opts, {
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 18, y: 18 },
      vibrancy: 'sidebar',
      visualEffectState: 'followWindow',
      backgroundColor: '#00000000',
      maximizable: false,
    });
  }
  return opts;
}

function open(tab) {
  if (win && !win.isDestroyed()) {
    if (tab) win.webContents.send('settings:tab', tab);
    if (hooks.onShow) hooks.onShow();
    win.show();
    win.focus();
    return win;
  }
  const w = new BrowserWindow(windowOptions());
  win = w;
  if (process.platform === 'win32') {
    chrome.followTheme(w, (dark) => {
      w.setBackgroundColor(chrome.color('sidebar', dark));
      w.setTitleBarOverlay(chrome.titleBarOverlay(dark));
    });
  }
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

module.exports = { init, open, send, isOpen, setQuitting, reload, windowOptions };
