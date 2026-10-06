'use strict';
/**
 * ds_pet —— 应用入口（基于 PC2005-cloud/dsh-pet 二次创作）。
 *
 * 一个进程管全部：桌宠窗口、菜单栏图标、聊天面板、设置窗口、AI 服务调用（多家服务商，见 providers.js）、数据存储。
 * 关掉所有窗口不会退出（她还在桌面上）；退出只有 ⌘Q / 菜单「退出」。
 */
const {
  app,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  globalShortcut,
  powerMonitor,
  dialog,
  shell,
} = require('electron');
const path = require('node:path');

const APP_NAME = 'ds_pet';
app.setName(APP_NAME);
// 数据目录：~/Library/Application Support/ds_pet（DS_PET_DATA_DIR 可指定别处，开发/演示用）
app.setPath('userData', process.env.DS_PET_DATA_DIR || path.join(app.getPath('appData'), APP_NAME));
// 动画需要无手势自动播放
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const service = require('./service');
service.registerScheme();

const {
  store,
  petConfig,
  dataDir,
  SIZE_PRESETS,
  WHISPER_INTERVALS,
  LANGUAGES,
  SIZE_MIN,
  SIZE_MAX,
  defaultPersona,
} = require('./store');
const llm = require('./llm');
const menus = require('./menus');
const petWindow = require('./pet-window');
const chatWindow = require('./chat-window');
const settingsWindow = require('./settings-window');
const { migrate } = require('./migrate');
const Providers = require('./providers');
const { createFocusReturn, macSystem } = require('./focus-return');
const { createStreamBuffer } = require('./stream-buffer');
const { needsPetWindowReload } = require('./pet-reload');
const Updater = require('./updater');

const RES = path.join(__dirname, '..', 'resources');

/** 点她 / 拖她之后把焦点还给你原来在用的应用（见 focus-return.js） */
const focusReturn = createFocusReturn(macSystem());
let tray = null;
let greeted = false;
const LINKS = {
  upstream: 'https://github.com/PC2005-cloud/dsh-pet',
  repo: 'https://github.com/cjian1/ds_pet',
  release: Updater.RELEASES_PAGE,
};
/** 一键更新（见 updater.js）；app ready 之后创建 */
let updater = null;
/** 上次更新的结果（新版本启动时读到），她打招呼时说出来 */
let updateNote = null;
/** 她已经提醒过的新版本（同一个版本只提醒一次） */
let announcedVersion = '';
/** 更新是不是从菜单（菜单栏 / 右键）点的：是的话进度和失败由她来说 */
let updateFromMenu = false;
let updateTimers = [];
const t = (key, vars) => store.t(key, vars);

// ---------------------------------------------------------------- 动作
function ctx() {
  const s = store.get();
  return {
    settings: s,
    lang: store.lang(),
    t,
    name: store.petName(),
    hasKey: store.hasApiKey(),
    canBalance: store.hasApiKey() && store.provider().balance,
    visible: s.app.visible,
    animations: petConfig(s).main.animations,
    openChat,
    whisper: () => petAction({ type: 'whisper' }),
    balance: () => petAction({ type: 'balance' }),
    play: (anim) => petAction({ type: 'play', anim }),
    home,
    pickImage,
    setSize: (size) => store.update({ pet: { size } }),
    toggleRoam: () => store.update({ pet: { roam: !store.get().pet.roam } }),
    toggleWhisper: () => store.update({ talk: { whisperEnabled: !store.get().talk.whisperEnabled } }),
    toggleLogin: () => applyLoginItem(!store.get().app.openAtLogin),
    setVisible,
    openSettings: (tab) => settingsWindow.open(tab),
    about,
    quit: () => app.quit(),
    update: updateState(),
    startUpdate: () => startUpdate(true),
    checkUpdate: () => {
      settingsWindow.open('about');
      if (updater) void updater.check({ manual: true });
    },
  };
}

function petAction(action) {
  if (!store.get().app.visible) setVisible(true);
  petWindow.send('pet:action', action);
}

/**
 * 渲染端「用到时才读」的那部分配置：改了推一份过去就地生效即可，不必重建整窗（见 pet-reload.js）。
 * 这里一次带全，将来加字段只改这一处 + sprite.js 的 applyLiveConfig。
 */
function liveConfig() {
  const cfg = petConfig();
  const p = service.mainPet(cfg);
  return {
    animationWeights: cfg.main.animationWeights,
    physics: cfg.main.physics,
    confineToScreen: cfg.main.confineToScreen,
    eventsRefreshSec: cfg.main.eventsRefreshSec,
    position: p.position,
    whisperEnabled: !!p.whisperEnabled,
    balanceEnabled: !!p.balanceEnabled,
  };
}

function home() {
  store.update({ position: null });
  petAction({ type: 'home' });
}

function setVisible(visible) {
  store.update({ app: { visible: !!visible } });
  if (visible) petWindow.show();
  else {
    petWindow.hide();
    chatWindow.hide();
  }
}

function openChat(opts = {}) {
  focusReturn.cancel();
  chatWindow.show();
  if (opts.image) chatWindow.send('chat:attach', { image: opts.image, autoSend: true });
}

async function pickImage() {
  focusReturn.cancel();
  app.focus({ steal: true });
  const res = await dialog.showOpenDialog({
    title: t('pick.title'),
    buttonLabel: t('pick.button'),
    properties: ['openFile'],
    filters: [{ name: t('pick.filter'), extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'bmp', 'tiff'] }],
  });
  if (res.canceled || !res.filePaths[0]) return;
  const img = nativeImage.createFromPath(res.filePaths[0]);
  if (img.isEmpty()) {
    petAction({ type: 'say', text: t('pet.cantOpenImage') });
    return;
  }
  openChat({ image: img.toDataURL() });
}

function about() {
  focusReturn.cancel();
  app.focus({ steal: true });
  app.showAboutPanel();
}

function applyAboutPanel() {
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    version: 'Electron ' + process.versions.electron,
    copyright: t('about.copyright'),
    credits: t('about.credits'),
    iconPath: path.join(RES, 'icon.png'),
  });
}

// ---------------------------------------------------------------- 系统集成
function applyDock() {
  if (!app.dock) return;
  if (store.get().app.showInDock || settingsWindow.isOpen()) app.dock.show();
  else app.dock.hide();
}

function registerShortcut() {
  globalShortcut.unregisterAll();
  const a = store.get().app;
  if (!a.shortcutEnabled) return true;
  try {
    return globalShortcut.register(a.shortcut, () => setVisible(!store.get().app.visible));
  } catch {
    return false;
  }
}

function loginStatus() {
  if (!app.isPackaged) return 'dev';
  try {
    const st = app.getLoginItemSettings();
    return st.status || (st.openAtLogin ? 'enabled' : 'not-registered');
  } catch {
    return 'unknown';
  }
}

function applyLoginItem(on) {
  if (app.isPackaged) {
    try {
      app.setLoginItemSettings({ openAtLogin: !!on });
    } catch (e) {
      console.error('[login-item]', e);
    }
  }
  store.update({ app: { openAtLogin: !!on } });
  return loginStatus();
}

function refreshTray() {
  if (!tray) return;
  const s = store.get();
  const updating = ['downloading', 'installing', 'restarting'].includes(updateState().phase);
  tray.setToolTip(
    APP_NAME +
      (s.app.visible ? '' : t('tray.hidden')) +
      (store.hasApiKey() ? '' : t('tray.noKeyTip')) +
      (updating ? t('tray.updatingTip') : ''),
  );
}

// ---------------------------------------------------------------- 一键更新
function updateState() {
  return updater ? updater.get() : { phase: 'idle', current: app.getVersion(), latest: null, progress: 0, error: '', blocker: null };
}

function say(text) {
  if (store.get().app.visible) petWindow.send('pet:action', { type: 'say', text });
}

function onUpdateState(st) {
  settingsWindow.send('settings:update', st);
  refreshTray();
  // 自动检查发现新版本：她提醒一句（设置窗口开着的话页面上已经看得到，就不说了）
  if (st.phase === 'available' && st.latest && st.latest.version !== announcedVersion) {
    announcedVersion = st.latest.version;
    if (!settingsWindow.isOpen()) say(t('update.petFound', { v: st.latest.version }));
  }
  if (st.phase === 'error' && updateFromMenu) {
    updateFromMenu = false;
    say(t('update.petFailed', { msg: st.error }));
  }
}

function startUpdate(fromMenu) {
  if (!updater) return updateState();
  updateFromMenu = !!fromMenu;
  if (fromMenu && !updateState().blocker) say(t('update.petDownloading'));
  return updater.install();
}

/** 启动 15 秒后查一次，之后每 6 小时一次（关掉「自动检查更新」就都不查） */
function scheduleUpdateChecks() {
  for (const id of updateTimers) clearTimeout(id);
  updateTimers = [];
  if (!updater || !store.get().app.autoUpdate) return;
  updateTimers.push(setTimeout(() => void updater.check(), 15000));
  updateTimers.push(setInterval(() => void updater.check(), 6 * 3600 * 1000));
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(RES, 'trayTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  const pop = () => tray.popUpContextMenu(menus.trayMenu(ctx()));
  tray.on('click', pop);
  tray.on('right-click', pop);
  refreshTray();
}

// ---------------------------------------------------------------- 她的招呼
function greetingLine() {
  const h = new Date().getHours();
  if (h >= 5 && h < 11) return t('greet.morning');
  if (h >= 11 && h < 14) return t('greet.noon');
  if (h >= 14 && h < 18) return t('greet.afternoon');
  if (h >= 18 && h < 23) return t('greet.evening');
  return t('greet.night');
}

function onPetReady() {
  if (greeted) return;
  greeted = true;
  const s = store.get();
  if (updateNote) {
    // 刚更新完：说说结果，代替平常的招呼
    const note = updateNote;
    updateNote = null;
    setTimeout(() => say(note.ok ? t('update.done', { v: app.getVersion() }) : t('update.failed', { v: app.getVersion() })), 1500);
    return;
  }
  if (!s.onboarded) {
    store.update({ onboarded: true });
    setTimeout(() => {
      petWindow.send('pet:action', {
        type: 'say',
        text: t('onboard.hello', { name: store.petName() }),
        image: 'Ciallo',
      });
    }, 1200);
    // 还没有 API Key：她先提醒一句，再把设置窗口打开到「AI 对话」页，照着填就行
    if (!store.hasApiKey()) {
      setTimeout(() => {
        petWindow.send('pet:action', { type: 'say', text: t('onboard.needKey') });
        settingsWindow.open('ai');
      }, 6000);
    }
    return;
  }
  setTimeout(() => petWindow.send('pet:action', { type: 'say', text: greetingLine() }), 1500);
}

// ---------------------------------------------------------------- 聊天
function chatState() {
  const s = store.get();
  return {
    name: store.petName(),
    lang: store.lang(),
    hasKey: store.hasApiKey(),
    model: store.provider().model,
    provider: store.provider().name,
    api: service.API,
    history: llm
      .history('main')
      .slice(-80)
      .map((m) => ({ role: m.role, content: String(m.content || ''), image: m.image || null, ts: m.ts || 0 })),
  };
}

let chatAbort = null;
/** 流式回复的合帧间隔（ms）：模型按 token 吐字，攒到 ~25 帧/秒再发 IPC */
const STREAM_FLUSH_MS = 40;

function setupChatIpc() {
  ipcMain.handle('chat:init', () => chatState());

  ipcMain.handle('chat:send', async (event, payload) => {
    const { id, text, image } = payload || {};
    const sender = event.sender;
    const emit = (msg) => {
      if (!sender.isDestroyed()) sender.send('chat:stream', Object.assign({ id }, msg));
    };
    if (chatAbort) chatAbort.abort();
    const ac = new AbortController();
    chatAbort = ac;
    const cfg = petConfig();
    const pet = service.mainPet(cfg);
    let started = false;
    // 逐 token 发 IPC 会把渲染端刷爆（每条都要改文本 + 读 scrollHeight 回滚）：攒到 ~25 帧/秒再发（见 stream-buffer.js）
    const stream = createStreamBuffer({
      flushMs: STREAM_FLUSH_MS,
      onFlush: (piece) => {
        if (!started) {
          started = true;
          petWindow.send('pet:action', { type: 'talk' });
        }
        emit({ type: 'delta', text: piece });
      },
    });
    try {
      const res = await llm.chat(cfg.main, pet, { text, image }, {
        signal: ac.signal,
        onThinking: () => emit({ type: 'thinking' }),
        onDelta: (piece) => stream.push(piece),
      });
      // 面板没开着（比如主人把它关了）：让她把回复说出来
      if (!chatWindow.isVisible()) petWindow.send('pet:action', { type: 'say', text: res.reply, image: res.image });
      return { ok: true, reply: res.reply, image: res.image, userImage: res.userImage };
    } catch (e) {
      return { ok: false, reason: e.reason || 'error', message: e.message || String(e) };
    } finally {
      stream.flushNow(); // 尾部不足一帧的正文补齐，不丢字
      if (chatAbort === ac) chatAbort = null;
    }
  });

  ipcMain.on('chat:stop', () => {
    if (chatAbort) chatAbort.abort();
  });
  ipcMain.handle('chat:clear', () => {
    llm.clearHistory('main');
    return chatState();
  });
  ipcMain.on('chat:close', () => chatWindow.hide());
  ipcMain.on('chat:open-settings', (_e, tab) => settingsWindow.open(tab || 'ai'));
}

// ---------------------------------------------------------------- 设置
function keyHint(key) {
  if (!key) return '';
  return key.length > 10 ? key.slice(0, 5) + '••••' + key.slice(-4) : '••••';
}

/** 某家服务商在设置页里要显示的东西（不含 Key 原文，只给打码提示） */
function providerView(id) {
  const p = store.provider(id);
  const def = Providers.info(id);
  const saved = store.get().ai.providers[id] || {};
  return {
    id,
    name: p.name,
    type: p.type,
    baseUrl: saved.baseUrl || '',
    defaultBaseUrl: def.baseUrl,
    model: p.model,
    defaultModel: def.model,
    hasKey: !!p.apiKey,
    keyHint: keyHint(p.apiKey),
    keyFromEnv: p.keyFromEnv,
    noKey: p.noKey,
    custom: p.custom,
    effort: !!p.effort,
    balance: p.balance,
    keyUrl: !!def.keyUrl,
  };
}

function settingsView() {
  const s = store.get();
  const ai = Object.assign({}, s.ai);
  delete ai.providers; // Key 原文不出主进程
  return {
    settings: Object.assign({}, s, { ai }),
    hasKey: store.hasApiKey(),
    keyHint: keyHint(store.apiKey()),
    keyFromEnv: store.provider().keyFromEnv,
    provider: providerView(s.ai.provider),
    providers: Providers.PROVIDER_IDS.map((id) => ({ id, name: Providers.displayName(id, store.lang()) })),
    api: service.API,
    lang: store.lang(),
    petName: store.petName(),
    defaultName: t('pet.defaultName'),
    meta: {
      version: app.getVersion(),
      electron: process.versions.electron,
      sizePresets: SIZE_PRESETS.map((p) => ({ size: p.size, label: t(p.key) })),
      intervals: WHISPER_INTERVALS.map((sec) => ({ sec, label: t('interval.' + sec) })),
      languages: LANGUAGES,
      sizeMin: SIZE_MIN,
      sizeMax: SIZE_MAX,
      defaultPersona: defaultPersona(),
      dataDir: dataDir(),
      packaged: app.isPackaged,
      loginStatus: loginStatus(),
      shortcutOk: shortcutOk,
    },
  };
}

let shortcutOk = true;

function setupSettingsIpc() {
  ipcMain.handle('settings:get', () => settingsView());

  ipcMain.handle('settings:set', (_e, patch) => {
    const p = patch && typeof patch === 'object' ? JSON.parse(JSON.stringify(patch)) : {};
    if (p.app && typeof p.app.openAtLogin === 'boolean') {
      applyLoginItem(p.app.openAtLogin);
      delete p.app.openAtLogin;
    }
    if (p.app && p.app.visible !== undefined) {
      setVisible(!!p.app.visible);
      delete p.app.visible;
    }
    store.update(p);
    return settingsView();
  });

  // 测试一套配置（可以是还没保存的 Key / 地址）：通了返回模型清单（DeepSeek 附带余额）
  ipcMain.handle('settings:test-key', async (_e, arg) => {
    const o = typeof arg === 'string' ? { apiKey: arg } : arg && typeof arg === 'object' ? arg : {};
    const override = {
      id: Providers.PROVIDER_IDS.includes(o.id) ? o.id : store.get().ai.provider,
      apiKey: String(o.apiKey || '').trim(),
      baseUrl: String(o.baseUrl || '').trim(),
      model: String(o.model || '').trim(),
      type: Providers.API_TYPES.includes(o.type) ? o.type : '',
    };
    const p = store.provider(override.id);
    if (!override.apiKey && !p.apiKey && !p.noKey && !p.custom) return { ok: false, message: t('err.enterKey') };
    try {
      const r = await llm.testKey(override);
      return { ok: true, models: r.models.map((m) => m.id), balance: r.balance };
    } catch (e) {
      return { ok: false, message: e.message };
    }
  });

  ipcMain.handle('settings:models', async () => {
    try {
      return { ok: true, models: await llm.listModels() };
    } catch (e) {
      return { ok: false, message: e.message, models: [] };
    }
  });

  ipcMain.handle('settings:balance', async () => llm.balance({ force: true }));
  ipcMain.handle('settings:clear-history', () => {
    llm.clearHistory('main');
    if (chatWindow.window()) chatWindow.send('chat:refresh', chatState());
    return true;
  });
  ipcMain.on('settings:open-data', () => shell.openPath(dataDir()));
  ipcMain.on('settings:open-link', (_e, key) => {
    // providerKey：当前服务商「创建 API Key」的页面（地址来自内置目录，不接受页面传来的网址）
    const target = key === 'providerKey' ? Providers.info(store.get().ai.provider).keyUrl : LINKS[key];
    if (target) shell.openExternal(target);
  });
  ipcMain.handle('settings:update-get', () => updateState());
  ipcMain.handle('settings:update-check', () => (updater ? updater.check({ manual: true }) : updateState()));
  ipcMain.handle('settings:update-install', () => startUpdate(false));
  ipcMain.on('settings:update-cancel', () => updater && updater.cancel());
  ipcMain.on('settings:home', () => home());
  ipcMain.on('settings:say', () => ctx().whisper());
}

// ---------------------------------------------------------------- 设置变化 → 生效
/** 桌宠窗口关心的 AI 状态：能不能说话、能不能查余额（变了才需要重建窗口） */
let lastAiState = '';
function aiState() {
  return store.hasApiKey() + '|' + store.provider().balance;
}

function onSettingsChange(next, prev) {
  const changed = (k) => JSON.stringify(next[k]) !== JSON.stringify(prev[k]);
  const keyChanged = next.ai.provider !== prev.ai.provider || JSON.stringify(next.ai.providers) !== JSON.stringify(prev.ai.providers);
  if (keyChanged) llm.resetCaches();
  const langChanged = next.app.language !== prev.app.language;
  const ai = aiState();
  const aiFlip = ai !== lastAiState;
  lastAiState = ai;
  // 影响桌宠本身的设置：重建窗口（新窗口就绪后才替换旧窗口，几乎无闪烁）。
  // 只有渲染端真会读到的字段变了才重建——判定见 pet-reload.js（重建要重载整页 + 所有视频，很贵）。
  const petReload = needsPetWindowReload(next, prev, { langChanged, aiFlip });
  if (petReload && next.app.visible && petWindow.window()) {
    petWindow.recreate();
  }
  // 名字不在重建之列：推一次 title 就够（改名字是最常改的一项，不值得重载整页）
  if (!petReload && next.pet.name !== prev.pet.name) petWindow.setName(store.petName());
  // 行为类设置（走动 / 活跃度 / 甩力 / 初始角落 / 碎碎念开关与周期 / 报余额）：渲染端用时才读，
  // 推一份新配置就地生效 —— 不必重建整窗（重建要重载页面并让她从头开始播动画）
  if (!petReload && (changed('pet') || changed('talk'))) {
    petWindow.send('pet:action', { type: 'live-config', config: liveConfig() });
  }
  // 换语言：菜单、关于面板、聊天和设置窗口都换成新语言
  if (langChanged) {
    Menu.setApplicationMenu(menus.appMenu(ctx()));
    applyAboutPanel();
    chatWindow.reload();
    settingsWindow.reload('general');
  }
  if (next.app.overFullscreen !== prev.app.overFullscreen) petWindow.setOverFullscreen(next.app.overFullscreen);
  if (next.app.shortcut !== prev.app.shortcut || next.app.shortcutEnabled !== prev.app.shortcutEnabled) {
    shortcutOk = registerShortcut();
  }
  if (next.app.showInDock !== prev.app.showInDock) applyDock();
  if (next.app.autoUpdate !== prev.app.autoUpdate) scheduleUpdateChecks();
  // 窗口没开着就别算：chatState() 要读盘，settingsView() 要拼整份视图；而且 chatWindow.send 会把
  // 从未打开过的聊天面板顺手创建出来（一个隐藏渲染进程），白占内存。
  if (!langChanged && chatWindow.window() && (next.pet.name !== prev.pet.name || keyChanged)) {
    chatWindow.send('chat:refresh', chatState());
  }
  const onlyPosition = changed('position') && !['pet', 'talk', 'ai', 'app', 'onboarded'].some(changed);
  if (!onlyPosition && settingsWindow.isOpen()) settingsWindow.send('settings:changed', settingsView());
  refreshTray();
}

// ---------------------------------------------------------------- 启动
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    setVisible(true);
    settingsWindow.open();
  });

  // 点程序坞图标 / 再次打开应用：她藏起来了就叫出来，并打开设置
  app.on('activate', () => {
    if (!store.get().app.visible) setVisible(true);
    settingsWindow.open();
  });

  app.on('window-all-closed', () => {
    /* 菜单栏应用：窗口都关了也继续在桌面上 */
  });

  app.on('before-quit', () => {
    chatWindow.setQuitting();
    settingsWindow.setQuitting();
  });

  app.on('will-quit', () => globalShortcut.unregisterAll());

  app.on('did-become-active', () => focusReturn.becameActive());
  app.on('did-resign-active', () => focusReturn.resignedActive());

  app.whenReady().then(() => {
    service.installHandler();
    store.load();
    if (store.firstRun) {
      try {
        migrate();
      } catch (e) {
        console.error('[migrate] 失败', e);
      }
      store.save();
    }
    lastAiState = aiState();
    store.on('change', onSettingsChange);

    updater = Updater.createUpdater({
      current: app.getVersion(),
      packaged: app.isPackaged,
      exePath: app.getPath('exe'),
      dataDir: dataDir(),
      t,
      lang: () => store.lang(),
      onState: onUpdateState,
      quit: () => app.quit(),
    });
    updateNote = updater.takeMarker();
    void updater.cleanup();

    applyAboutPanel();
    if (!app.isPackaged && app.dock) app.dock.setIcon(path.join(RES, 'icon.png'));

    Menu.setApplicationMenu(menus.appMenu(ctx()));
    applyDock();
    createTray();
    setupChatIpc();
    setupSettingsIpc();

    petWindow.init({
      onContextMenu: (win) => {
        menus.petMenu(ctx()).popup({ window: win, callback: () => petWindow.send('pet:menu-closed') });
      },
      onOpenChat: (payload) => openChat(payload),
      onMoved: () => chatWindow.follow(),
      onReady: onPetReady,
      onPointerNear: () => focusReturn.pointerNear(),
      onInputBusy: (busy) => focusReturn.interaction(busy),
    });
    chatWindow.setBodyRectProvider(petWindow.bodyRect);
    settingsWindow.init({
      onShow: () => {
        focusReturn.cancel();
        if (app.dock) app.dock.show();
        app.focus({ steal: true });
      },
      onClose: applyDock,
    });

    if (store.get().app.visible) petWindow.create();
    shortcutOk = registerShortcut();
    scheduleUpdateChecks();
    // 锁屏 / 屏保：没人看得到她 → 停视频解码 + rAF + 碎碎念，连兜底轮询也停；解锁再按可见性恢复
    powerMonitor.on('lock-screen', () => petWindow.setScreenLocked(true));
    powerMonitor.on('unlock-screen', () => petWindow.setScreenLocked(false));
    // 开发态调试把手（node --inspect 连上主进程后可直接调用）
    if (!app.isPackaged) global.__whale = { store, petWindow, chatWindow, settingsWindow, menus, ctx, llm, openChat, petConfig, focusReturn, updater };

    // 登录项与设置对齐（用户可能在系统设置里手动关过）
    if (app.isPackaged) {
      try {
        const st = app.getLoginItemSettings();
        if (store.get().app.openAtLogin && !st.openAtLogin) app.setLoginItemSettings({ openAtLogin: true });
      } catch {
        /* 忽略 */
      }
    }
  });
}
