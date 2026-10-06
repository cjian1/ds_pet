'use strict';
/**
 * 测试用的假 electron：主进程模块 require('electron') 时拿到这里的对象，不用真的启动 Electron。
 * 只提供被测代码会碰到的那几样；数据目录指向一个临时目录，进程退出时删掉。
 *
 * 用法：测试文件第一行 require('./helpers/electron-stub')，之后再 require 被测模块。
 */
const Module = require('node:module');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'ds_pet-test-'));
process.on('exit', () => fs.rmSync(userData, { recursive: true, force: true }));

/** 测试里可以改的环境：系统语言、空闲秒数 */
const env = { langs: ['zh-CN'], idleSeconds: 0 };

/** 最小的 BrowserWindow / screen 桩：够 chat-window、settings-window 这类窗口模块加载与单测用 */
class FakeWebContents {
  constructor() {
    this.sent = [];
    this.handlers = {};
  }
  send(channel, payload) {
    this.sent.push([channel, payload]);
  }
  on(event, fn) {
    (this.handlers[event] = this.handlers[event] || []).push(fn);
    return this;
  }
  once(event, fn) {
    return this.on(event, fn);
  }
  emit(event, ...args) {
    for (const fn of (this.handlers[event] || []).slice()) fn(...args);
  }
  setWindowOpenHandler() {}
  setBackgroundThrottling() {}
}

class FakeBrowserWindow {
  constructor(opts = {}) {
    this.opts = opts;
    this.webContents = new FakeWebContents();
    this.visible = false;
    this.destroyed = false;
    this.handlers = {};
    this.bounds = { x: opts.x || 0, y: opts.y || 0, width: opts.width || 0, height: opts.height || 0 };
  }
  setAlwaysOnTop() {}
  setVisibleOnAllWorkspaces() {}
  setIgnoreMouseEvents() {}
  setBackgroundThrottling() {}
  loadURL() {
    return Promise.resolve();
  }
  on(event, fn) {
    (this.handlers[event] = this.handlers[event] || []).push(fn);
    return this;
  }
  once(event, fn) {
    return this.on(event, fn);
  }
  emit(event, ...args) {
    for (const fn of (this.handlers[event] || []).slice()) fn(...args);
  }
  focus() {}
  setTitle(t) {
    this.title = t;
  }
  getSize() {
    return [this.bounds.width, this.bounds.height];
  }
  setBounds(b) {
    this.bounds = b;
  }
  setContentBounds(b) {
    this.bounds = b;
  }
  getBounds() {
    return this.bounds;
  }
  getContentBounds() {
    return this.bounds;
  }
  isVisible() {
    return this.visible;
  }
  show() {
    this.visible = true;
    this.emit('show');
  }
  showInactive() {
    this.visible = true;
    this.emit('show');
  }
  hide() {
    this.visible = false;
    this.emit('hide');
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    this.visible = false;
    this.emit('closed');
  }
}

const workArea = { x: 0, y: 0, width: 1440, height: 900 };
const primaryDisplay = { id: 1, workArea, bounds: workArea, scaleFactor: 2 };

const electron = {
  app: {
    getPath: (name) => (name === 'userData' ? userData : os.tmpdir()),
    getPreferredSystemLanguages: () => env.langs,
    getLocale: () => env.langs[0] || 'en-US',
  },
  BrowserWindow: FakeBrowserWindow,
  ipcMain: {
    /** 最近一次注册的处理函数（测试里可以直接调，模拟渲染端发来的消息） */
    listeners: {},
    on(channel, fn) {
      this.listeners[channel] = fn;
    },
    off() {},
    handle() {},
    removeHandler() {},
  },
  screen: {
    getPrimaryDisplay: () => primaryDisplay,
    getAllDisplays: () => [primaryDisplay],
    getDisplayNearestPoint: () => primaryDisplay,
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    on() {},
  },
  nativeImage: { createFromDataURL: () => ({ isEmpty: () => true }) },
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  powerMonitor: { getSystemIdleTime: () => env.idleSeconds, on() {}, off() {} },
  Menu: { buildFromTemplate: (template) => template },
};

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electron;
  return load.call(this, request, ...rest);
};

module.exports = { electron, userData, env };
