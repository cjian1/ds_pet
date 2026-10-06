'use strict';
require('./helpers/electron-stub');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const I18n = require('../desktop/i18n/i18n.js');
const { DEFAULTS } = require('../desktop/main/store');
const menus = require('../desktop/main/menus');

const t = (key, vars) => I18n.t('zh', key, vars);
const clicked = [];
function ctx(update) {
  return {
    t,
    lang: 'zh',
    settings: DEFAULTS,
    name: '小鲸',
    hasKey: true,
    canBalance: false,
    visible: true,
    animations: null,
    update,
    startUpdate: () => clicked.push('start'),
    checkUpdate: () => clicked.push('check'),
  };
}
const labels = (template) => template.map((i) => i.label).filter(Boolean);

test('有新版本：菜单栏第二项、她的右键菜单里都有「更新到 x」，点了就开始更新', () => {
  const c = ctx({ phase: 'available', latest: { version: '1.2.0' } });
  const tray = menus.trayMenu(c);
  assert.equal(tray[1].label, t('tray.update', { v: '1.2.0' }));
  tray[1].click();
  const pet = menus.petMenu(c);
  const item = pet.find((i) => i.label === t('tray.update', { v: '1.2.0' }));
  assert.ok(item);
  item.click();
  assert.deepEqual(clicked.splice(0), ['start', 'start']);
});

test('下载中 / 安装中：显示进度，点不了', () => {
  const dl = menus.updateItem(ctx({ phase: 'downloading', progress: 0.426 }));
  assert.deepEqual(dl, { label: t('tray.updating', { p: 43 }), enabled: false });
  const inst = menus.updateItem(ctx({ phase: 'installing' }));
  assert.equal(inst.enabled, false);
});

test('没有新版本：没有更新项；菜单栏里始终有「检查更新…」', () => {
  for (const phase of ['idle', 'latest', 'checking', 'error']) {
    const c = ctx({ phase, latest: null });
    assert.equal(menus.updateItem(c), null, phase);
    assert.ok(!labels(menus.petMenu(c)).some((l) => l.startsWith('⬆︎')), phase);
  }
  const tray = menus.trayMenu(ctx({ phase: 'idle' }));
  const check = tray.find((i) => i.label === t('tray.checkUpdate'));
  assert.ok(check);
  check.click();
  assert.deepEqual(clicked.splice(0), ['check']);
});
