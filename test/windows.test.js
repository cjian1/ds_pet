'use strict';
// Windows 版：窗口选项、菜单、文案、文件写入这些按系统分开的地方（在 macOS 上也能跑：都是纯函数 / 指定了系统）
require('./helpers/electron-stub');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const I18n = require('../desktop/i18n/i18n.js');
const { DEFAULTS, renameWithRetry } = require('../desktop/main/store');
const petWindow = require('../desktop/main/pet-window');
const chatWindow = require('../desktop/main/chat-window');
const settingsWindow = require('../desktop/main/settings-window');
const chrome = require('../desktop/main/window-chrome');
const menus = require('../desktop/main/menus');
const { inertSystem, createFocusReturn } = require('../desktop/main/focus-return');
const U = require('../desktop/main/updater');

const ROOT = path.join(__dirname, '..');
const geo = petWindow.deskGeometry();

// ---------------------------------------------------------------- 窗口
test('桌宠窗口：Windows 上不抢焦点、不进任务栏和 Alt+Tab、压在任务栏上面；macOS 照旧', () => {
  const win = petWindow.windowOptions(DEFAULTS, geo, 'win32');
  assert.equal(win.focusable, false, '点她不把焦点从你正在用的窗口抢走');
  assert.equal(win.type, 'toolbar');
  assert.equal(win.thickFrame, false);
  assert.equal(win.transparent, true);
  assert.equal(win.skipTaskbar, true);
  assert.equal('acceptFirstMouse' in win, false);
  assert.equal(petWindow.topLevel('win32'), 'screen-saver');

  const mac = petWindow.windowOptions(DEFAULTS, geo, 'darwin');
  assert.equal(mac.type, 'panel');
  assert.equal(mac.acceptFirstMouse, true);
  assert.equal('focusable' in mac, false);
  assert.equal(petWindow.topLevel('darwin'), 'status');
  // 除了系统相关的几项，两边一模一样
  const strip = (o) => {
    const c = Object.assign({}, o);
    for (const k of ['type', 'focusable', 'thickFrame', 'acceptFirstMouse']) delete c[k];
    return c;
  };
  assert.deepEqual(strip(win), strip(mac));
});

test('聊天面板 / 设置窗口：Windows 上没有毛玻璃，用跟着深浅色的不透明底色；设置窗口带系统按钮', () => {
  const chatWin = chatWindow.windowOptions('win32');
  assert.equal(chatWin.vibrancy, undefined);
  assert.equal(chatWin.backgroundColor, chrome.color('chat', false));
  assert.equal(chatWindow.windowOptions('darwin').vibrancy, 'popover');

  const setWin = settingsWindow.windowOptions('win32');
  assert.equal(setWin.vibrancy, undefined);
  assert.equal(setWin.titleBarStyle, 'hidden');
  assert.deepEqual(setWin.titleBarOverlay, chrome.titleBarOverlay(false));
  assert.equal(setWin.backgroundColor, chrome.color('sidebar', false));
  assert.ok(fs.existsSync(setWin.icon), '窗口图标 ' + setWin.icon);
  const setMac = settingsWindow.windowOptions('darwin');
  assert.equal(setMac.vibrancy, 'sidebar');
  assert.equal(setMac.titleBarStyle, 'hiddenInset');
});

test('窗口底色：不透明的六位色，深色和浅色不一样', () => {
  for (const kind of Object.keys(chrome.COLORS)) {
    for (const dark of [false, true]) assert.match(chrome.color(kind, dark), /^#[0-9a-f]{6}$/, kind);
    assert.notEqual(chrome.color(kind, true), chrome.color(kind, false), kind);
  }
  assert.equal(chrome.titleBarOverlay(true).color, chrome.color('content', true), '系统按钮和内容区同色');
});

// ---------------------------------------------------------------- 菜单
function ctx(platform) {
  return {
    t: (k, v) => I18n.t('zh', k, v),
    lang: 'zh',
    platform,
    settings: DEFAULTS,
    name: '小鲸',
    hasKey: true,
    canBalance: false,
    visible: true,
    animations: null,
    update: { phase: 'idle' },
  };
}
const accels = (template) => template.map((i) => i.accelerator).filter(Boolean);

test('菜单：Windows 上不标 ⌘ 快捷键（只留显示 / 隐藏的全局快捷键）', () => {
  for (const build of [menus.petMenu, menus.trayMenu]) {
    const win = accels(build(ctx('win32')));
    assert.deepEqual(win, [DEFAULTS.app.shortcut], build.name);
    assert.ok(accels(build(ctx('darwin'))).includes('Command+Q'), build.name + '：macOS 照旧');
  }
});

// ---------------------------------------------------------------- 文案
const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test('Windows 专用说法：键都在总表里，中英都有，占位符和原文一致，不再提 Mac / 菜单栏', () => {
  const before = I18n.getPlatform();
  try {
    I18n.setPlatform('win32');
    for (const key of I18n.winKeys()) {
      assert.ok(I18n.has(key), key + ' 不在总表里');
      for (const lang of I18n.LANGS) {
        const s = I18n.t(lang, key);
        assert.ok(s.trim(), key + ' 缺 ' + lang);
        assert.ok(!/Mac|菜单栏|menu bar|程序坞|Dock/.test(s), key + '：' + s);
      }
      I18n.setPlatform('darwin');
      const base = placeholders(I18n.t('zh', key));
      I18n.setPlatform('win32');
      assert.deepEqual(placeholders(I18n.t('zh', key)), base, key + ' 占位符和原文不一致');
      assert.deepEqual(placeholders(I18n.t('en', key)), base, key + ' 英文占位符和原文不一致');
    }
    assert.equal(I18n.t('en', 'set.keyNone', { name: 'X' }), 'Your X API key — stored only on this PC');
    I18n.setPlatform('darwin');
    assert.equal(I18n.t('en', 'set.keyNone', { name: 'X' }), 'Your X API key — stored only on this Mac', 'macOS 照旧');
  } finally {
    I18n.setPlatform(before);
  }
});

test('出处说明写明是 macOS 与 Windows 的桌面应用（两种语言都提到原项目 dsh-pet）', () => {
  for (const lang of I18n.LANGS) {
    const s = I18n.t(lang, 'set.about.credit');
    assert.match(s, /dsh-pet/);
    assert.match(s, /PC2005-cloud/);
    assert.match(s, /Windows/);
  }
});

// ---------------------------------------------------------------- 其它
test('原子写的改名：被短暂占用（EPERM / EBUSY）会重试，别的错误直接抛', () => {
  let n = 0;
  const flaky = () => {
    if (++n < 3) throw Object.assign(new Error('busy'), { code: n === 1 ? 'EPERM' : 'EBUSY' });
  };
  renameWithRetry('a', 'b', flaky);
  assert.equal(n, 3);

  let m = 0;
  const missing = () => {
    m++;
    throw Object.assign(new Error('nope'), { code: 'ENOENT' });
  };
  assert.throws(() => renameWithRetry('a', 'b', missing), /nope/);
  assert.equal(m, 1, '不是占用类的错误不重试');

  let k = 0;
  const stuck = () => {
    k++;
    throw Object.assign(new Error('locked'), { code: 'EBUSY' });
  };
  assert.throws(() => renameWithRetry('a', 'b', stuck), /locked/);
  assert.equal(k, 9, '最多试 9 次就放弃');
});

test('Windows 不归还焦点：不起子进程，点完也不激活任何应用', async () => {
  const sys = inertSystem();
  const activated = [];
  const fr = createFocusReturn(Object.assign({}, sys, { activate: (pid) => activated.push(pid) }));
  assert.equal(await sys.frontPid(), null);
  fr.pointerNear();
  fr.becameActive();
  fr.interaction(true);
  fr.interaction(false);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(activated, []);
});

test('Windows 打包脚本和一键更新用同一套名字（安装程序 / 卸载程序 / 应用 ID 都从 updater.js 来）', () => {
  const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build-win.mjs'), 'utf8');
  assert.match(build, /U\.assetName\(VERSION, arch, 'win32'\)/);
  assert.match(build, /U\.WIN_UNINSTALLER/);
  assert.match(build, /U\.BUNDLE_ID/);
  const nsi = fs.readFileSync(path.join(ROOT, 'scripts', 'win-installer.nsi'), 'utf8');
  for (const define of ['UNINSTALLER', 'APP_ID', 'VERSION', 'ARCH', 'SRC_DIR', 'OUT_FILE']) {
    assert.ok(nsi.includes('${' + define + '}'), define);
  }
  assert.match(nsi, /RequestExecutionLevel user/, '装在自己的用户目录里，不要管理员权限');
  assert.match(nsi, /--quit/, '替换文件前先叫正在运行的她退出');
  assert.match(nsi, /dsh-pet/, '安装界面里写明出处');
  assert.equal(U.WIN_UNINSTALLER, 'Uninstall ds_pet.exe');
});

test('Windows 的图标资源都在', () => {
  for (const f of ['icon.ico', 'tray.ico']) {
    const buf = fs.readFileSync(path.join(ROOT, 'desktop', 'resources', f));
    assert.equal(buf.readUInt16LE(0), 0, f + '：ICO 文件头');
    assert.equal(buf.readUInt16LE(2), 1, f + '：类型是图标');
    assert.ok(buf.readUInt16LE(4) >= 4, f + '：至少 4 个尺寸');
  }
});
