/**
 * 点击穿透「兜底通道」的纯判定（源自 dsh-pet 上游 issue #55 报告者补丁的逻辑部分）。
 *
 * 背景：窗口默认整窗点击穿透（`setIgnoreMouseEvents(true, { forward: true })`），渲染端靠转发进来的
 * mousemove 做命中判定再 IPC 回来翻转可交互。这条链路只有一个入口：转发失效时（上游在 Windows 上
 * 遇到过），或者系统拖拽文件期间（根本没有 mousemove），就没有任何退路。所以主进程另外每 60ms
 * 按真实光标位置判定一次。
 *
 * 两条通道必须圈**同一块区域**：她的身体（HIT_BOX）。区域不一致时较大的那条会赢，
 * 她身边的透明区域就会挡住下面应用的点击。
 *
 * 这里不 require('electron')，可被 node:test 直接加载单测（test/pointer-target.test.js）。
 * 坐标系：全部用 DIP（`win.getBounds()` 与 `screen.getCursorScreenPoint()` 同为 DIP，可比）。
 */

'use strict';

/** 宠物身体命中区（画布坐标，与 desktop/pet/shared-core.js 的 HIT_BOX 一致；测试钉住二者同步） */
const HIT_BOX = { x0: 200, y0: 50, x1: 440, y1: 335 };
/** 动画画布尺寸与脚底线（与 shared-core 的 CANVAS_H / FEET_Y 一致；宽 640 是 sprite.js 里的字面量） */
const CANVAS_H = 360;
const FEET_Y = 330;
const STAGE_W = 640;

/**
 * 窗口矩形 → 她身体命中区的屏幕矩形（DIP），与渲染端 sprite.js 的 hitRect 同一公式。
 * 窗口 = 宠物包围盒 + 四周各半只宠物的余量（WINDOW_MARGIN_RATIO = 0.5），所以宽 = 2 × 宠物尺寸：
 * margin = width / 4、stageW = width − 2×margin。舞台被 translateY(bottomPad) 下移了一截
 * （给脚底留余量），命中区也要跟着下移。
 *
 * @param {{x:number,y:number,width:number,height:number}} bounds 窗口矩形
 * @param {{x:number,y:number}} [offset] 精灵在窗口内的实际偏移（窗口被菜单栏顶住时会变）；缺省 = 余量处
 */
function spriteHitRect(bounds, offset) {
  const margin = Math.round(bounds.width / 4);
  const stageW = bounds.width - margin * 2;
  const stageH = (stageW * CANVAS_H) / STAGE_W;
  const bottomPad = (stageH * (CANVAS_H - FEET_Y)) / CANVAS_H;
  const ox = offset && Number.isFinite(offset.x) ? offset.x : margin;
  const oy = offset && Number.isFinite(offset.y) ? offset.y : margin;
  return {
    left: bounds.x + ox + (HIT_BOX.x0 / STAGE_W) * stageW,
    top: bounds.y + oy + bottomPad + (HIT_BOX.y0 / CANVAS_H) * stageH,
    right: bounds.x + ox + (HIT_BOX.x1 / STAGE_W) * stageW,
    bottom: bounds.y + oy + bottomPad + (HIT_BOX.y1 / CANVAS_H) * stageH,
  };
}

/** 判定轮询间隔（ms，与 issue #55 报告者实测值一致） */
const POINTER_POLL_MS = 60;

/**
 * 该不该让窗口穿透（= `setIgnoreMouseEvents` 的第一个参数）。
 *
 *  - 渲染端正拿着鼠标输入（拖拽中 / 右键菜单开着）→ **不穿透**，最高优先级；
 *  - 光标在她身上 → 不穿透（可交互）；
 *  - 其它地方（窗口余量、身边的透明画面、窗口外）→ 穿透，点击落到下面的应用。
 *
 * 为什么 busy 必须优先于位置判定：窗口比她的身体大一圈，拖拽时她由弹簧追赶光标、**滞后**于光标；
 * 甩得快时光标会跑出身体甚至窗口。此时翻回穿透，渲染端的 pointermove/pointerup 全断（鼠标还按着，
 * 她却按最后一次采样的速度"飞"出去）。所以"正拿着输入"必须能否决位置判定，而且 busy 时位置完全不参与。
 *
 * 结果只取决于光标位置和 busy，与渲染端那条通道的判定一致，两边谁先翻转都不会互相打架。
 *
 * @param {{x:number,y:number,width:number,height:number}} bounds 窗口矩形（DIP）
 * @param {{x:number,y:number}} point 真实光标位置（screen.getCursorScreenPoint()，DIP）
 * @param {boolean} busy 渲染端是否正在用这个窗口的鼠标输入（见 sprite.js 的 inputBusy）
 * @param {{x:number,y:number}} [offset] 精灵在窗口内的偏移
 * @returns {boolean} 新的穿透状态
 */
function decideWindowIgnore(bounds, point, busy, offset) {
  if (busy) return false;
  const r = spriteHitRect(bounds, offset);
  const onBody = point.x >= r.left && point.x <= r.right && point.y >= r.top && point.y <= r.bottom;
  return !onBody;
}

module.exports = {
  HIT_BOX, CANVAS_H, FEET_Y, STAGE_W, POINTER_POLL_MS, spriteHitRect, decideWindowIgnore,
};
