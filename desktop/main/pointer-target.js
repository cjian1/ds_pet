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
/** 光标远离窗口时的兜底轮询间隔（ms）：快通道由渲染端转发的 mousemove 负责，兜底没必要一直高频 */
const POINTER_POLL_FAR_MS = 250;
/** 主人一段时间没碰键鼠时的兜底轮询间隔（ms）：没人会点她，兜底可以放得很慢 */
const POINTER_POLL_IDLE_MS = 1000;
/** 多久没输入算「主人不在」——用系统空闲时间，和碎碎念省略额度的判据一致（10 分钟）偏长，
 *  这里 60s 就够：光标停着不动时，兜底通道晚一点不影响（真正进窗口的那一刻由转发通道负责） */
const POINTER_IDLE_AFTER_SEC = 60;
/** 「离窗口近」的外扩判定（px）：光标进到这个范围就切回快档 */
const POINTER_NEAR_PAD = 48;

/** 光标是不是在窗口附近（窗口矩形外扩 pad 像素内） */
function isPointerNearWindow(bounds, point, pad = POINTER_NEAR_PAD) {
  return (
    point.x >= bounds.x - pad &&
    point.x < bounds.x + bounds.width + pad &&
    point.y >= bounds.y - pad &&
    point.y < bounds.y + bounds.height + pad
  );
}

/**
 * 下一次兜底轮询该等多久（ms）。
 *
 * 正在拖拽 / 菜单开着 → 必须快档（60ms）；
 * 主人一分钟没碰键鼠 → 最慢档（1000ms）：没人会点她；
 * 光标在她身上 / 身边 → 快档；离得远 → 慢档（250ms）。
 *
 * 放慢的前提都是同一条：真正光标压到她身上的那一刻，渲染端转发的 mousemove 会立刻翻转可交互，
 * 兜底只是转发链路失效时的退路，迟一点不改变行为。
 */
function pointerPollDelay(bounds, point, busy, idle) {
  if (busy) return POINTER_POLL_MS;
  if (idle) return POINTER_POLL_IDLE_MS;
  return isPointerNearWindow(bounds, point) ? POINTER_POLL_MS : POINTER_POLL_FAR_MS;
}

/**
 * 这一拍要不要提醒 focus-return 记一次「原来最前面的应用」（点完她把焦点还回去，见 focus-return.js）。
 *
 * 采样一次要起两个 lsappinfo 进程，所以只在真有用的时候采：
 *   1) 光标刚进窗口 —— 先记一次，用户可能马上点下来（留提前量）；
 *   2) 光标压在她身上 —— 随时可能点下去，交给 focus-return 自己按秒限频刷新。
 * 只是停在她身边的透明余量里就**不采**：那里的点击会穿透给下面的应用，本应用不会被激活，
 * 根本没有焦点要归还。曾经按整窗持续判定，光标停在余量里也会每秒起两个进程（实测主进程 ~1.8% 的一个核）。
 */
function shouldCaptureFocus({ onBody = false, inside = false, wasInside = false } = {}) {
  if (onBody) return true;
  return !!inside && !wasInside;
}

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
  HIT_BOX,
  CANVAS_H,
  FEET_Y,
  STAGE_W,
  POINTER_POLL_MS,
  POINTER_POLL_FAR_MS,
  POINTER_POLL_IDLE_MS,
  POINTER_IDLE_AFTER_SEC,
  POINTER_NEAR_PAD,
  spriteHitRect,
  decideWindowIgnore,
  isPointerNearWindow,
  pointerPollDelay,
  shouldCaptureFocus,
};
