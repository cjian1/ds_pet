'use strict';
// 改设置要不要重建桌宠整窗：只有渲染端真会读到的字段变了才重建（重建 = 重载页面 + 重载所有视频）
const test = require('node:test');
const assert = require('node:assert/strict');
const { needsPetWindowReload, INERT } = require('../desktop/main/pet-reload');
const { DEFAULTS } = require('../desktop/main/store');

const settings = (patch) => {
  const s = structuredClone(DEFAULTS);
  for (const [group, values] of Object.entries(patch || {})) Object.assign(s[group], values);
  return s;
};
const reload = (patch, flags) => needsPetWindowReload(settings(patch), settings(), flags);

test('什么都没改：不重建', () => {
  assert.equal(reload({}), false);
  assert.equal(reload({ pet: { size: DEFAULTS.pet.size } }), false);
});

test('只有换尺寸才重建窗口（几何在构造时定死，改不了）', () => {
  assert.equal(reload({ pet: { size: 512 } }), true);
});

test('行为类设置：就地生效，不重建窗口（渲染端都是用到那一刻才读）', () => {
  const cases = [
    { pet: { corner: 'top-left' } }, // 回到初始位置时才读
    { pet: { roam: false } }, // this.weights → 下次挑动画
    { pet: { liveliness: 'lively' } },
    { pet: { throwPower: 1.5 } }, // this.physics → 下次拖拽/抛掷
    { pet: { confineToScreen: true } },
    { talk: { whisperEnabled: false } }, // 停/起碎碎念定时器
    { talk: { balanceEnabled: false } }, // 余额轮询每拍判断
    { talk: { whisperIntervalSec: 300 } }, // 重排碎碎念定时器
  ];
  for (const patch of cases) assert.equal(reload(patch), false, JSON.stringify(patch));
});

test('只在主进程用的字段：改了不重建（省掉一次整页重载）', () => {
  assert.equal(reload({ talk: { whisperImage: false } }), false);
  assert.equal(reload({ talk: { chatImage: false } }), false);
  // 名字走 petWindow.setName 轻量通道
  assert.equal(reload({ pet: { name: '新名字' } }), false);
});

test('免重建清单：改这份名单必须同时改 live-config / setName（否则设置会悄悄失效）', () => {
  assert.deepEqual(INERT, {
    pet: ['name', 'corner', 'roam', 'liveliness', 'throwPower', 'confineToScreen'],
    talk: ['whisperImage', 'chatImage', 'whisperEnabled', 'whisperIntervalSec', 'balanceEnabled'],
  });
});

test('换语言 / 能不能聊天或报余额翻了：必须重建', () => {
  assert.equal(reload({}, { langChanged: true }), true);
  assert.equal(reload({}, { aiFlip: true }), true);
});

test('将来新增的字段默认走「重建」：宁可慢一点，也不能让设置改了不生效', () => {
  assert.equal(needsPetWindowReload(settings({ pet: { future: 1 } }), settings()), true);
  assert.equal(needsPetWindowReload(settings({ talk: { future: 1 } }), settings()), true);
});
