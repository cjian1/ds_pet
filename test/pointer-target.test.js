'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const PT = require('../desktop/main/pointer-target.js');
const { loadSharedCore } = require('./helpers/shared-core');

// 一只 420 宽的她：窗口 = 包围盒 + 四周各半只宠物 → 宽 840
const SIZE = 420;
const MARGIN = SIZE / 2;
const STAGE_H = (SIZE * 9) / 16;
const BOTTOM_PAD = (STAGE_H * 30) / 360;
const WIN = { x: 100, y: 200, width: SIZE + MARGIN * 2, height: Math.round(STAGE_H + BOTTOM_PAD) + MARGIN * 2 };

/** 渲染端 sprite.js 的 hitRect 公式（窗口内坐标），换成屏幕坐标 */
function rendererHitRect(win, offset = { x: MARGIN, y: MARGIN }) {
  const { x0, y0, x1, y1 } = PT.HIT_BOX;
  return {
    left: win.x + offset.x + (x0 / 640) * SIZE,
    top: win.y + offset.y + BOTTOM_PAD + (y0 / 360) * STAGE_H,
    right: win.x + offset.x + (x1 / 640) * SIZE,
    bottom: win.y + offset.y + BOTTOM_PAD + (y1 / 360) * STAGE_H,
  };
}

test('命中区常量与渲染端 shared-core 一致', () => {
  const S = loadSharedCore();
  assert.deepEqual({ ...S.HIT_BOX }, PT.HIT_BOX);
  assert.equal(S.CANVAS_H, PT.CANVAS_H);
  assert.equal(S.FEET_Y, PT.FEET_Y);
});

test('主进程命中区与渲染端 hitRect 是同一块（含脚底下移的 bottomPad）', () => {
  const got = PT.spriteHitRect(WIN);
  const want = rendererHitRect(WIN);
  for (const k of ['left', 'top', 'right', 'bottom']) assert.ok(Math.abs(got[k] - want[k]) < 1e-9, k);
});

test('精灵偏移（窗口被菜单栏顶住时）会带着命中区一起移动', () => {
  const offset = { x: 30, y: 12 };
  const got = PT.spriteHitRect(WIN, offset);
  const want = rendererHitRect(WIN, offset);
  for (const k of ['left', 'top', 'right', 'bottom']) assert.ok(Math.abs(got[k] - want[k]) < 1e-9, k);
});

test('光标在她身上：可交互', () => {
  const r = PT.spriteHitRect(WIN);
  const center = { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
  assert.equal(PT.decideWindowIgnore(WIN, center, false), false);
});

test('她身边的透明画面：穿透，不挡下面的应用', () => {
  const r = PT.spriteHitRect(WIN);
  const stageLeft = WIN.x + MARGIN;
  // 画面左侧、身体左边（640 画布里 x≈64 的位置），以及身体正上方的画面顶部
  const besideBody = { x: stageLeft + SIZE * 0.1, y: (r.top + r.bottom) / 2 };
  const aboveHead = { x: (r.left + r.right) / 2, y: WIN.y + MARGIN + 2 };
  assert.equal(PT.decideWindowIgnore(WIN, besideBody, false), true);
  assert.equal(PT.decideWindowIgnore(WIN, aboveHead, false), true);
});

test('窗口余量和窗口外：穿透', () => {
  assert.equal(PT.decideWindowIgnore(WIN, { x: WIN.x + 5, y: WIN.y + 5 }, false), true);
  assert.equal(PT.decideWindowIgnore(WIN, { x: WIN.x - 50, y: WIN.y - 50 }, false), true);
});

test('拖拽 / 菜单期间（busy）：不论光标在哪都保持可交互', () => {
  for (const p of [
    { x: WIN.x + 5, y: WIN.y + 5 },
    { x: WIN.x - 500, y: WIN.y + 2000 },
  ]) {
    assert.equal(PT.decideWindowIgnore(WIN, p, true), false);
  }
});

test('边界：命中区边缘算在身上', () => {
  const r = PT.spriteHitRect(WIN);
  assert.equal(PT.decideWindowIgnore(WIN, { x: r.left, y: r.top }, false), false);
  assert.equal(PT.decideWindowIgnore(WIN, { x: r.right, y: r.bottom }, false), false);
  assert.equal(PT.decideWindowIgnore(WIN, { x: r.left - 1, y: r.top }, false), true);
});
