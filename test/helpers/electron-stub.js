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

const electron = {
  app: {
    getPath: (name) => (name === 'userData' ? userData : os.tmpdir()),
    getPreferredSystemLanguages: () => env.langs,
    getLocale: () => env.langs[0] || 'en-US',
  },
  nativeImage: { createFromDataURL: () => ({ isEmpty: () => true }) },
  protocol: { registerSchemesAsPrivileged() {}, handle() {} },
  powerMonitor: { getSystemIdleTime: () => env.idleSeconds },
  Menu: { buildFromTemplate: (template) => template },
};

const load = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'electron') return electron;
  return load.call(this, request, ...rest);
};

module.exports = { electron, userData, env };
