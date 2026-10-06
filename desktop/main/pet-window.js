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
 * 渲染端（转发的 mousemove）和这里的 60ms 光标轮询用同一块区域判定（见 pointer-target.js）。
 * 拖拽 / 右键菜单期间由渲染端上报「正在用输入」，这段时间绝不翻回穿透（否则拖到一半会断）。
 */
const { BrowserWindow, ipcMain, screen } = require('electron');
const path = require('node:path');
const { decideWindowIgnore, HIT_BOX, POINTER_POLL_MS } = require('./pointer-target.js');
const { store } = require('./store');
const { API, ORIGIN } = require('./service');

let win = null;
let pointerTimer = null;
let lastKey = '';
let ignoring = true;
let inputBusy = false;
let spriteOffset = null;
/** 最近一次渲染端上报的几何（屏幕坐标）：聊天面板定位用 */
let lastBounds = null;
let crashTimes = [];
let hooks = {};
let positionTimer = null;

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
      backgroundThrottling: false,
      spellcheck: false,
    },
  });
  // 层级：在 Dock 和普通窗口之上，但在系统菜单（含她自己的右键菜单）之下
  w.setAlwaysOnTop(true, 'status');
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: s.app.overFullscreen, skipTransformProcessType: true });
  w.webContents.setBackgroundThrottling(false);
  w.webContents.on('context-menu', (e) => e.preventDefault());
  setIgnore(w, true);
  inputBusy = false;
  spriteOffset = null;
  lastKey = '';

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

  // 兜底穿透判定：按真实光标位置决定窗口要不要接收鼠标（不依赖 forward 转发链路）
  clearInterval(pointerTimer);
  pointerTimer = setInterval(() => {
    if (!win || win.isDestroyed() || !win.isVisible()) return;
    const b = win.getBounds();
    if (b.width < 8 || b.height < 8) return;
    const p = screen.getCursorScreenPoint();
    const next = decideWindowIgnore(b, p, inputBusy, spriteOffset);
    if (next !== ignoring) setIgnore(win, next);
    // 光标在她窗口里：让 focus-return 记下你正在用的应用（点她之后把焦点还回去）
    const near = p.x >= b.x && p.x < b.x + b.width && p.y >= b.y && p.y < b.y + b.height;
    if (near && hooks.onPointerNear) hooks.onPointerNear();
  }, POINTER_POLL_MS);

  w.on('closed', () => {
    if (win === w) {
      win = null;
      clearInterval(pointerTimer);
      pointerTimer = null;
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
}

function hide() {
  if (win && !win.isDestroyed()) win.hide();
}

function isVisible() {
  return !!(win && !win.isDestroyed() && win.isVisible());
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function window() {
  return win && !win.isDestroyed() ? win : null;
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
    lastKey = '';
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
    const key = rect.x + ',' + rect.y + ',' + rect.width + ',' + rect.height;
    if (key !== lastKey) {
      lastKey = key;
      win.setContentBounds(rect, false);
      // 把系统实际落位回传：窗口被菜单栏 / 屏幕边缘顶住时渲染端据此校正
      const got = win.getContentBounds();
      event.sender.send('pet:actual-bounds', { x: got.x, y: got.y, width: got.width, height: got.height });
    }
    const offX = Number(bounds.offX);
    const offY = Number(bounds.offY);
    if (Number.isFinite(offX) && Number.isFinite(offY)) spriteOffset = { x: offX, y: offY };
    const got = win.getContentBounds();
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
  init,
  create: recreate,
  recreate,
  show,
  hide,
  isVisible,
  send,
  window,
  bodyRect,
  deskGeometry,
  setOverFullscreen,
};
