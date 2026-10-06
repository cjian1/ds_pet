'use strict';
/**
 * 桌宠窗口：透明、置顶、不抢焦点的小窗，跟着宠物走。
 *
 * 几何模型沿用 dsh-pet 上游：窗口 = 宠物包围盒 + 四周各半只宠物的余量（给气泡用）；
 * 渲染端逐帧上报目标位置（pet:set-bounds），这里 setContentBounds 让窗口跟随。
 * macOS 不让无边框窗口越过菜单栏，窗口被顶住时把「实际落位」回传，渲染端把精灵在窗口内挪过去，
 * 宠物因此仍能贴到屏幕最上沿。
 *
 * 输入：窗口默认整窗点击穿透（透明处不挡下面的应用），光标压到她身体（HIT_BOX）上才变成可交互；
 * 渲染端（转发的 mousemove）和这里的光标轮询用同一块区域判定（见 pointer-target.js）。
 * 轮询只是兜底通道，光标远离窗口时放慢（60ms → 250ms）、窗口隐藏时彻底停表，别一直空转唤醒 CPU。
 * 拖拽 / 右键菜单期间由渲染端上报「正在用输入」，这段时间绝不翻回穿透（否则拖到一半会断）。
 *
 * 省电：窗口隐藏 / 锁屏时挂起渲染端（pet:suspend）；主人离开电脑 5 分钟（系统空闲时间，轮询里顺带查）
 * 时告诉渲染端（pet:away），她播完手上这段就歇着、不再解码视频。
 */
const { BrowserWindow, ipcMain, screen, powerMonitor } = require('electron');
const path = require('node:path');
const {
  decideWindowIgnore,
  pointerPollDelay,
  shouldCaptureFocus,
  HIT_BOX,
  POINTER_POLL_MS,
  POINTER_IDLE_AFTER_SEC,
} = require('./pointer-target.js');
const { store } = require('./store');
const { API, ORIGIN } = require('./service');

let win = null;
let pointerTimer = null;
let ignoring = true;
let inputBusy = false;
let spriteOffset = null;
/** 最近一次渲染端上报的几何（屏幕坐标）：聊天面板定位用 */
let lastBounds = null;
let crashTimes = [];
let hooks = {};
let positionTimer = null;
/** 屏幕锁了 / 屏保起来了：没人看她，视频解码和光标轮询都可以停 */
let screenLocked = false;
/** 上一拍光标在不在她窗口里（用来只在「进窗口那一下」提醒 focus-return 记一次） */
let pointerWasInside = false;
/** 兜底轮询的计数（排障 / 能耗定位用） */
const pollStats = { ticks: 0, fast: 0, slow: 0 };
/**
 * 页面就绪（渲染端 boot 完、精灵建好，发来 pet:ready）之前的动作先排着：那时没有精灵接，发了就丢。
 * 比如她藏着启动，从菜单栏点「说句话」—— 窗口这才开始加载，这句话以前就没了。
 */
let pageReady = false;
let queuedActions = [];
/**
 * 主人离开电脑多久算「不在」（秒）：之后她播完手上这段就歇着，停在最后一帧不再解码（见 sprite.js setAway）。
 * 视频解码 + 合成是她可见时几乎全部的耗电；屏幕熄了但系统没睡的时候（台式机、后台下载…）没人看，
 * 不该通宵空转。取 5 分钟：短暂走神不至于看到她不动，又赶在多数机器息屏之前。
 */
const AWAY_AFTER_SEC = 300;
/** 主人是否一会儿没碰键鼠了（每秒最多查一次系统空闲时间，别每拍都问） */
let userIdle = false;
/** 已推给渲染端的「主人不在」（只在翻转时发一条） */
let userAway = false;
let lastIdleCheck = -Infinity;

function refreshUserIdle() {
  const now = Date.now();
  if (now - lastIdleCheck < 1000) return;
  lastIdleCheck = now;
  let idleSec = 0;
  try {
    idleSec = powerMonitor.getSystemIdleTime();
  } catch {
    idleSec = 0;
  }
  userIdle = idleSec >= POINTER_IDLE_AFTER_SEC;
  const away = idleSec >= AWAY_AFTER_SEC;
  if (away !== userAway) {
    userAway = away;
    send('pet:away', away);
  }
}

function petWindowSize(size) {
  const height = (size * 9) / 16;
  const bottomPad = (size * (9 / 16) * (360 - 330)) / 360;
  const m = Math.round(size * 0.5);
  return { width: Math.round(size) + m * 2, height: Math.round(height + bottomPad) + m * 2 };
}

/** 逐显示器工作区 + 外接矩形 + 主屏下标（渲染端所有边界判定走工作区并集） */
function deskGeometry() {
  const displays = screen.getAllDisplays();
  const areas = displays.map((d) => ({ x: d.workArea.x, y: d.workArea.y, width: d.workArea.width, height: d.workArea.height }));
  const panels = displays.map((d) => ({ x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height }));
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const a of areas) {
    x0 = Math.min(x0, a.x);
    y0 = Math.min(y0, a.y);
    x1 = Math.max(x1, a.x + a.width);
    y1 = Math.max(y1, a.y + a.height);
  }
  const primaryId = screen.getPrimaryDisplay().id;
  const primaryIndex = Math.max(0, displays.findIndex((d) => d.id === primaryId));
  return { hull: { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }, areas, panels, primaryIndex };
}

function setIgnore(w, ignore) {
  if (!w || w.isDestroyed()) return;
  w.setIgnoreMouseEvents(ignore, { forward: true });
  ignoring = ignore;
}

function isPetSender(event) {
  return win && !win.isDestroyed() && event.sender === win.webContents;
}

// ---------------------------------------------------------------- 挂起（隐藏 / 锁屏）
/** 她现在该不该挂起：窗口不可见，或屏幕锁着 */
function suspendedNow() {
  return screenLocked || !isVisible();
}

function pushSuspend() {
  send('pet:suspend', suspendedNow());
}

/**
 * 屏幕锁定 / 解锁（主进程 powerMonitor 驱动）。锁屏期间没人看得见她：
 * 停掉视频解码、rAF 与碎碎念循环，连兜底轮询也不用跑了；解锁后按窗口实际可见性恢复。
 */
function setScreenLocked(on) {
  const locked = !!on;
  if (locked === screenLocked) return;
  screenLocked = locked;
  if (locked) stopPointerPoll();
  else startPointerPoll();
  pushSuspend();
}

// ---------------------------------------------------------------- 兜底穿透轮询
// 自调度 setTimeout 链（不是 setInterval）：隐藏时彻底停表、光标远离时放慢，
// 避免窗口一整天开着就每 60ms 醒一次（16 次/秒的系统调用纯属空耗）。
function stopPointerPoll() {
  if (pointerTimer !== null) {
    clearTimeout(pointerTimer);
    pointerTimer = null;
  }
}

let pointerRetries = 0;

/** 窗口「该显示却还没显示」时的重试：别让兜底轮询就此熄火（最多试 ~12s，防页面加载失败时无限空转） */
function retryPointerPollSoon() {
  if (pointerTimer !== null) return;
  if (pointerRetries++ > 200) return;
  pointerTimer = setTimeout(() => {
    pointerTimer = null;
    startPointerPoll();
  }, POINTER_POLL_MS);
}

function startPointerPoll() {
  if (pointerTimer !== null) return;
  if (!win || win.isDestroyed()) return;
  // showInactive() 触发的 'show' 事件有时比「可见」标志早到，这时 isVisible() 还是 false。
  // 以前直接 return：此后再没有事件来唤醒，兜底轮询就永久熄火了（实测累计 0 次，主进程 CPU 也从
  // 1.8% 掉到 0.6%）。这里改成「该显示就等一拍再试」，藏起来时（app.visible 为假）不排，免得空转。
  if (!win.isVisible()) {
    if (store.get().app.visible) retryPointerPollSoon();
    return;
  }
  pointerRetries = 0;
  pointerTimer = setTimeout(pointerTick, POINTER_POLL_MS);
}

function pointerTick() {
  pointerTimer = null;
  if (!win || win.isDestroyed()) return;
  if (!win.isVisible()) {
    // 隐藏（app.visible 已置假）就到此为止；只是暂时不可见（窗口重建/切换）则接着等
    if (store.get().app.visible) retryPointerPollSoon();
    return;
  }
  // 正在拖拽 / 菜单开着：decideWindowIgnore 一定返回 false（见 pointer-target.js），
  // 位置判定被否决 —— 那就别再取窗口矩形和光标了（两次原生调用，实测约 1ms）。
  // 拖拽正是最需要响应的时候，这里省下的正好花在她身上。
  if (inputBusy) {
    if (ignoring) setIgnore(win, false); // 显式保证「busy ⇒ 不穿透」，不依赖渲染端的消息顺序
    refreshUserIdle();
    pointerTimer = setTimeout(pointerTick, POINTER_POLL_MS);
    return;
  }
  const b = win.getBounds();
  if (b.width < 8 || b.height < 8) {
    pointerTimer = setTimeout(pointerTick, POINTER_POLL_MS);
    return;
  }
  const p = screen.getCursorScreenPoint();
  const next = decideWindowIgnore(b, p, inputBusy, spriteOffset);
  if (next !== ignoring) setIgnore(win, next);
  // 让 focus-return 记「原来最前面的应用」（点她之后好把焦点还回去）。两种时机：
  //   1) 光标刚进窗口：先记一次，用户可能马上点下来（留出提前量）；
  //   2) 光标真的压在她身上：随时可能点下去，按秒刷新（focus-return 内部限频 1s）。
  // 停在透明余量里就不再反复记了：那里的点击会穿透给下面的应用，本应用不会被激活，没有焦点要还。
  // 以前按整窗（840×676，身体只占一小块）持续判定，实测每秒起两个 lsappinfo 进程，
  // 正好是主进程 ~1.8% 的一个核 —— 全是白烧。
  const onBody = !next;
  const inside = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
  if (hooks.onPointerNear && shouldCaptureFocus({ onBody, inside, wasInside: pointerWasInside })) hooks.onPointerNear();
  pointerWasInside = inside;
  // 主人一分钟没碰键鼠 → 兜底放慢到 1s：没人会点她（真进窗口那一刻由转发通道负责，不受影响）
  refreshUserIdle();
  const delay = pointerPollDelay(b, p, inputBusy, userIdle);
  pollStats.ticks++;
  if (delay === POINTER_POLL_MS) pollStats.fast++;
  else pollStats.slow++;
  pointerTimer = setTimeout(pointerTick, delay);
}

function create() {
  const s = store.get();
  const geo = deskGeometry();
  const { width, height } = petWindowSize(s.pet.size);
  const w = new BrowserWindow({
    width,
    height,
    x: geo.hull.x,
    y: geo.hull.y,
    show: false,
    useContentSize: true,
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    // panel：能浮在全屏应用上方。注意它挡不住「点击激活本应用」（Electron 的 panel 是 NSWindow 子类，
    // 实测见 scripts/debug/real-input.mjs），焦点由 focus-return.js 在交互结束后还回去。
    // acceptFirstMouse 让第一下点击直接生效（不会先被「激活窗口」吃掉）
    type: 'panel',
    acceptFirstMouse: true,
    roundedCorners: false,
    title: store.petName(),
    webPreferences: {
      preload: path.join(__dirname, '..', 'pet', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 不节流渲染端：她是常驻的动画面板，被 Chromium 判为「后台」而卡住是致命的。
      // 代价是窗口隐藏/锁屏时系统不会替她停——那部分由主进程显式挂起负责（见 hide/setScreenLocked）。
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  win = w; // 后续的轮询 / 事件回调都以此为准（recreate 会先记下旧窗口再调进来）
  // 层级：在 Dock 和普通窗口之上，但在系统菜单（含她自己的右键菜单）之下
  w.setAlwaysOnTop(true, 'status');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: s.app.overFullscreen, skipTransformProcessType: true });
  w.webContents.setBackgroundThrottling(false);
  w.webContents.on('context-menu', (e) => e.preventDefault());
  setIgnore(w, true);
  inputBusy = false;
  spriteOffset = null;
  pointerWasInside = false;
  pageReady = false; // 新页面：之后的动作排队到它 boot 完（旧窗口在它就绪前不再接动作）
  userAway = false;
  lastIdleCheck = -Infinity;

  const query = new URLSearchParams({
    api: API,
    lang: store.lang(),
    scale: '1',
    petIndex: '0',
    workAreaX: String(geo.hull.x),
    workAreaY: String(geo.hull.y),
    workAreaW: String(geo.hull.width),
    workAreaH: String(geo.hull.height),
    areas: JSON.stringify(geo.areas),
    panels: JSON.stringify(geo.panels),
    primaryIndex: String(geo.primaryIndex),
  });
  if (s.position) query.set('pos', s.position.rx + ',' + s.position.ry);
  w.loadURL(ORIGIN + '/pet/index.html?' + query.toString()).catch((e) => {
    console.error('[pet] 页面加载失败', e);
  });

  w.webContents.on('render-process-gone', (_e, details) => {
    console.error('[pet] 渲染进程退出', details && details.reason);
    if (!details || details.reason === 'clean-exit') return;
    const now = Date.now();
    crashTimes = crashTimes.filter((t) => now - t < 10 * 60 * 1000);
    if (crashTimes.length >= 5) return; // 10 分钟内崩 5 次：别再反复拉起
    crashTimes.push(now);
    setTimeout(() => recreate(), 1000);
  });

  // 兜底穿透判定：按真实光标位置决定窗口要不要接收鼠标（不依赖 forward 转发链路）。
  // 显示/隐藏由窗口事件驱动：showInactive() 会触发 'show'，hide() 触发 'hide'。
  // 事件带窗口身份判断：recreate 销毁旧窗口时旧窗口也会发 hide/closed，不能让它停掉新窗口的轮询。
  stopPointerPoll();
  startPointerPoll();
  w.on('show', () => {
    if (win === w) startPointerPoll();
  });
  w.on('hide', () => {
    if (win === w) stopPointerPoll();
  });

  w.on('closed', () => {
    if (win === w) {
      win = null;
      stopPointerPoll();
    }
  });
  return w;
}

/** 新建窗口并在它就绪后替换旧窗口（改大小 / 改设置时用，几乎看不出闪烁） */
function recreate() {
  const old = win;
  const next = create();
  win = next;
  const reveal = () => {
    if (old && !old.isDestroyed()) old.destroy();
    if (store.get().app.visible && !next.isDestroyed()) next.showInactive();
    pushSuspend(); // 锁屏状态要能跨重建保留（不然锁着屏重建会把视频又放开）
  };
  next.once('ready-to-show', reveal);
  // paintWhenInitiallyHidden 偶尔不产出首帧 → ready-to-show 不触发：加载完成后兜底
  next.webContents.once('did-finish-load', () => setTimeout(() => {
    if (!next.isDestroyed() && !next.isVisible() && store.get().app.visible) reveal();
  }, 600));
  return next;
}

function show() {
  // 还没有窗口：新建，就绪后由 recreate 负责亮出来（调用方已把 visible 设为 true）
  if (!win || win.isDestroyed()) {
    recreate();
    return;
  }
  if (!win.isVisible()) win.showInactive();
  pushSuspend(); // 从隐藏恢复：让渲染端把视频与碎碎念循环接回来（屏幕锁着就仍然挂起）
}

function hide() {
  if (win && !win.isDestroyed()) {
    // 显式挂起仍然必要，两个原因：
    //   1) 锁屏时系统不会告诉我们「页面不可见」（Page Visibility 只覆盖隐藏/遮挡/息屏）；
    //   2) Chromium 也**不会**因为页面不可见就停掉 <video> 解码（媒体要继续出声），省电得自己停。
    win.hide();
    pushSuspend();
  }
}

function isVisible() {
  return !!(win && !win.isDestroyed() && win.isVisible());
}

function send(channel, payload) {
  if (!win || win.isDestroyed()) return;
  if (channel === 'pet:action' && !pageReady) {
    if (queuedActions.length < 20) queuedActions.push(payload);
    return;
  }
  win.webContents.send(channel, payload);
}

/** 改名字不必重建整窗：把新名字推给渲染端（视频 / 命中区的 title）并更新窗口标题 */
function setName(name) {
  const v = String(name || '');
  if (win && !win.isDestroyed()) win.setTitle(v);
  send('pet:name', v);
}

function window() {
  return win && !win.isDestroyed() ? win : null;
}

/** 排障用：兜底轮询打了多少次、快慢档各多少 */
function stats() {
  let onBody = null;
  if (win && !win.isDestroyed()) {
    const p = screen.getCursorScreenPoint();
    onBody = decideWindowIgnore(win.getBounds(), p, false, spriteOffset) === false;
  }
  return Object.assign({}, pollStats, {
    visible: isVisible(),
    appVisible: !!store.get().app.visible,
    screenLocked,
    userIdle,
    userAway,
    ignoring,
    onBody,
  });
}

/** 她身体在屏幕上的矩形（聊天面板贴着她放） */
function bodyRect() {
  const b = lastBounds;
  if (!b || !win || win.isDestroyed()) return null;
  const size = b.size;
  const stageH = (size * 9) / 16;
  const sx = b.x + b.offX;
  const sy = b.y + b.offY + (b.bottomPad || 0);
  return {
    x: sx + (HIT_BOX.x0 / 640) * size,
    y: sy + (HIT_BOX.y0 / 360) * stageH,
    width: ((HIT_BOX.x1 - HIT_BOX.x0) / 640) * size,
    height: ((HIT_BOX.y1 - HIT_BOX.y0) / 360) * stageH,
  };
}

function savePositionSoon(pos) {
  clearTimeout(positionTimer);
  positionTimer = setTimeout(() => {
    store.update({ position: pos && Number.isFinite(pos.rx) && Number.isFinite(pos.ry) ? { rx: pos.rx, ry: pos.ry } : null });
  }, 600);
}

let displaysTimer = null;
function pushDisplays() {
  clearTimeout(displaysTimer);
  displaysTimer = setTimeout(() => {
    send('pet:displays', deskGeometry());
  }, 300);
}

/** IPC 只注册一次；hooks 由 app 控制器提供（右键菜单 / 打开聊天 / 移动通知 / 焦点归还） */
function init(h) {
  hooks = h || {};

  ipcMain.on('pet:set-bounds', (event, bounds) => {
    if (!isPetSender(event)) return;
    const x = Number(bounds && bounds.x);
    const y = Number(bounds && bounds.y);
    const width = Number(bounds && bounds.width);
    const height = Number(bounds && bounds.height);
    if (![x, y, width, height].every(Number.isFinite)) return;
    const rect = { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) };
    // 不在这里再去重：渲染端只在几何真变了才发（sprite.js sendBounds），矩形相同的那几条是
    // 「精灵偏移变了」或「显示器变了 / 窗口被系统改了尺寸，渲染端要求复位」—— 都得照办。
    win.setContentBounds(rect, false);
    // 把系统实际落位回传：窗口被菜单栏 / 屏幕边缘顶住时渲染端据此校正。
    // 实际落位每条只向系统要一次（窗口服务器往返，实测约 1ms），下面的 lastBounds 也用它
    const got = win.getContentBounds();
    event.sender.send('pet:actual-bounds', { x: got.x, y: got.y, width: got.width, height: got.height });
    const offX = Number(bounds.offX);
    const offY = Number(bounds.offY);
    if (Number.isFinite(offX) && Number.isFinite(offY)) spriteOffset = { x: offX, y: offY };
    lastBounds = {
      x: got.x,
      y: got.y,
      offX: spriteOffset ? spriteOffset.x : Math.round(Number(bounds.size) * 0.5),
      offY: spriteOffset ? spriteOffset.y : Math.round(Number(bounds.size) * 0.5),
      size: Number(bounds.size) || store.get().pet.size,
      bottomPad: Number(bounds.bottomPad) || 0,
    };
    if (hooks.onMoved) hooks.onMoved();
  });

  ipcMain.on('pet:set-interactive', (event, interactive) => {
    if (!isPetSender(event)) return;
    setIgnore(win, !interactive);
  });

  ipcMain.on('pet:input-busy', (event, busy) => {
    if (!isPetSender(event)) return;
    inputBusy = !!busy;
    if (hooks.onInputBusy) hooks.onInputBusy(inputBusy);
  });

  ipcMain.on('pet:context-menu', (event) => {
    if (!isPetSender(event)) return;
    if (hooks.onContextMenu) hooks.onContextMenu(win);
  });

  ipcMain.on('pet:save-position', (event, pos) => {
    if (!isPetSender(event)) return;
    savePositionSoon(pos);
  });

  ipcMain.on('pet:open-chat', (event, payload) => {
    if (!isPetSender(event)) return;
    if (hooks.onOpenChat) hooks.onOpenChat(payload || {});
  });

  ipcMain.on('pet:ready', (event) => {
    if (!isPetSender(event)) return;
    pageReady = true;
    const queued = queuedActions;
    queuedActions = [];
    for (const a of queued) send('pet:action', a);
    if (hooks.onReady) hooks.onReady();
  });

  screen.on('display-metrics-changed', pushDisplays);
  screen.on('display-added', pushDisplays);
  screen.on('display-removed', pushDisplays);
}

function setOverFullscreen(on) {
  if (win && !win.isDestroyed()) {
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: !!on, skipTransformProcessType: true });
  }
}

module.exports = {
  AWAY_AFTER_SEC,
  init,
  create: recreate,
  recreate,
  show,
  hide,
  isVisible,
  send,
  setName,
  setScreenLocked,
  window,
  stats,
  bodyRect,
  deskGeometry,
  setOverFullscreen,
};
