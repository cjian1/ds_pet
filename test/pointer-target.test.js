'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const PT = require('../desktop/main/pointer-target.js');
const { loadSharedCore } = require('./helpers/shared-core');
const { loadHitRect } = require('./helpers/hit-rect');

// 一只 420 宽的她：窗口 = 包围盒 + 四周各半只宠物 → 宽 840
const SIZE = 420;
const MARGIN = SIZE / 2;
const STAGE_H = (SIZE * 9) / 16;
const BOTTOM_PAD = (STAGE_H * 30) / 360;
const WIN = { x: 100, y: 200, width: SIZE + MARGIN * 2, height: Math.round(STAGE_H + BOTTOM_PAD) + MARGIN * 2 };

const rendererHitBox = loadHitRect();

/** 渲染端**真实源码**（hit-rect.js，sprite.js 用的就是它）算出的命中区，换成屏幕坐标 */
function rendererHitRect(win, offset = { x: MARGIN, y: MARGIN }) {
  const r = rendererHitBox(PT.HIT_BOX, SIZE, BOTTOM_PAD);
  return {
    left: win.x + offset.x + r.x,
    top: win.y + offset.y + r.y,
    right: win.x + offset.x + r.x + r.w,
    bottom: win.y + offset.y + r.y + r.h,
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

// ---------------------------------------------------------------- 兜底轮询节奏（省电）
test('兜底轮询：光标在窗口附近用快档，远离用慢档', () => {
  const onBody = { x: WIN.x + MARGIN + SIZE / 2, y: WIN.y + MARGIN + STAGE_H / 2 };
  assert.equal(PT.pointerPollDelay(WIN, onBody, false), PT.POINTER_POLL_MS);
  // 窗口边缘外 8px：还算附近（快档）
  assert.equal(PT.pointerPollDelay(WIN, { x: WIN.x - 8, y: WIN.y + 10 }, false), PT.POINTER_POLL_MS);
  // 远处：慢档，少唤醒
  assert.equal(PT.pointerPollDelay(WIN, { x: WIN.x - 600, y: WIN.y - 600 }, false), PT.POINTER_POLL_FAR_MS);
});

test('兜底轮询：拖拽 / 菜单期间永远是快档（光标甩得再远也不能丢采样）', () => {
  const far = { x: WIN.x - 600, y: WIN.y - 600 };
  assert.equal(PT.pointerPollDelay(WIN, far, true), PT.POINTER_POLL_MS);
});

test('兜底轮询：主人一分钟没碰键鼠 → 最慢档（没人会点她，别一直空转）', () => {
  const onBody = { x: WIN.x + MARGIN + SIZE / 2, y: WIN.y + MARGIN + STAGE_H / 2 };
  // 光标就停在她身上也一样放慢：真压上去那一刻是转发通道负责的，兜底只是退路
  assert.equal(PT.pointerPollDelay(WIN, onBody, false, true), PT.POINTER_POLL_IDLE_MS);
  assert.ok(PT.POINTER_POLL_IDLE_MS >= PT.POINTER_POLL_FAR_MS * 3, '最慢档至少是慢档的 3 倍间隔');
  // 但正在拖拽 / 菜单开着时，busy 优先于空闲：输入链不能断
  assert.equal(PT.pointerPollDelay(WIN, onBody, true, true), PT.POINTER_POLL_MS);
});

test('附近判定：外扩 pad 之内算近，之外算远；慢档确实更慢', () => {
  assert.equal(PT.isPointerNearWindow(WIN, { x: WIN.x - PT.POINTER_NEAR_PAD + 1, y: WIN.y + 5 }), true);
  assert.equal(PT.isPointerNearWindow(WIN, { x: WIN.x - PT.POINTER_NEAR_PAD - 1, y: WIN.y + 5 }), false);
  assert.ok(PT.POINTER_POLL_FAR_MS >= PT.POINTER_POLL_MS * 3, '慢档至少是快档的 3 倍间隔');
});

// ---------------------------------------------------------------- 焦点采样时机（每次采样要起两个 lsappinfo 进程）
test('焦点采样：只在她身上、或刚进窗口那一下才采', () => {
  // 压在她身上：随时可能点下去 → 采（focus-return 内部按秒限频）
  assert.equal(PT.shouldCaptureFocus({ onBody: true, inside: true, wasInside: true }), true);
  // 刚进窗口：先记一次，留出「快速划过来点她」的提前量
  assert.equal(PT.shouldCaptureFocus({ onBody: false, inside: true, wasInside: false }), true);
});

test('焦点采样：停在透明余量里、或窗口外，都不采（那里点了会穿透，不需要还焦点）', () => {
  // 一直在窗口里但不在身上（透明余量），且上一拍也在 → 不采
  assert.equal(PT.shouldCaptureFocus({ onBody: false, inside: true, wasInside: true }), false);
  // 窗口外
  assert.equal(PT.shouldCaptureFocus({ onBody: false, inside: false, wasInside: false }), false);
  assert.equal(PT.shouldCaptureFocus({ onBody: false, inside: false, wasInside: true }), false);
  // 缺省参数
  assert.equal(PT.shouldCaptureFocus(), false);
});
