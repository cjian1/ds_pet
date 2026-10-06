'use strict';
// 包内配置（desktop/assets/config.jsonc）和素材文件对得上
require('./helpers/electron-stub');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const I18n = require('../desktop/i18n/i18n.js');
const { ASSETS, loadJsonc } = require('../desktop/main/store');
const { animationGroups } = require('../desktop/main/menus');

const cfg = loadJsonc(path.join(ASSETS, 'config.jsonc'));
const listDir = (dir, ext) =>
  fs
    .readdirSync(path.join(ASSETS, dir))
    .filter((f) => f.endsWith(ext))
    .map((f) => f.slice(0, -ext.length));

/** 配置里出现过的全部动画名 */
function allAnimations(a) {
  const names = [...a.idle, ...a.turn, ...a.drag, ...a.clicks, ...a.moves.actions.map((m) => m.name)];
  for (const c of a.categories) names.push(...c.actions);
  for (const pool of Object.values(a.events)) for (const slot of pool) names.push(...[].concat(slot));
  return names;
}

test('config.jsonc 能解析，且没有上游残留字段', () => {
  assert.ok(cfg && cfg.animations, '解析失败');
  for (const k of ['pets', 'workStatusTexts', 'notificationsEnabled']) assert.equal(k in cfg, false, k);
  assert.equal('petCollision' in cfg.physics, false);
});

test('配置里的每个动画都有 webm 文件，每个 webm 都被配置用到', () => {
  const used = new Set(allAnimations(cfg.animations));
  const files = new Set(listDir('webm', '.webm'));
  assert.deepEqual([...used].filter((n) => !files.has(n)), [], '缺文件');
  assert.deepEqual([...files].filter((n) => !used.has(n)), [], '没被用到的文件');
});

test('每个动画都有英文名（英文界面的「动作」菜单）', () => {
  const missing = allAnimations(cfg.animations).filter((n) => I18n.anim('en', n) === n);
  assert.deepEqual(missing, []);
});

test('右键「动作」菜单能点到配置里的全部动画', () => {
  const inMenu = new Set(animationGroups(cfg.animations, (k) => k).flatMap((g) => g.items));
  assert.deepEqual(allAnimations(cfg.animations).filter((n) => !inMenu.has(n)), []);
});

test('表情包：描述表和 png 一一对应', () => {
  const keys = Object.keys(cfg.memes);
  const files = listDir('memes', '.png');
  assert.deepEqual(keys.filter((k) => !files.includes(k)), [], '缺图片');
  assert.deepEqual(files.filter((f) => !keys.includes(f)), [], '图片没有描述');
  for (const k of keys) assert.ok(String(cfg.memes[k]).trim(), k + ' 描述为空');
});

test('聊天窗口和设置页直接引用的素材都在', () => {
  for (const f of ['memes/可爱.png', 'webm/待机呼吸休闲.webm', 'webm/点击回应-元气挥手.webm', 'pic/cursor-grab.png', 'pic/cursor-grabbing.png']) {
    assert.ok(fs.existsSync(path.join(ASSETS, f)), f);
  }
});
