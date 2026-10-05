'use strict';
/**
 * 设置与数据：~/Library/Application Support/ds_pet/
 *
 *   settings.json   用户设置（含 API Key，权限 600）
 *   memory.json     聊天记录（结构与 dsh-pet 上游一致：{main: {main: {messages: [...]}}}）
 *   uploads/        主人递给她的图片（按内容哈希命名，天然去重）
 *
 * 设置只有这一份真相：主进程读写，渲染端（桌宠 / 设置 / 聊天）都经 IPC 或 deskpet:// 拿结果。
 */
const { app } = require('electron');
const { EventEmitter } = require('node:events');
const I18n = require('../i18n/i18n.js');
const fs = require('node:fs');
const path = require('node:path');

const APP_ROOT = path.join(__dirname, '..');
const ASSETS = path.join(APP_ROOT, 'assets');

const SIZE_MIN = 160;
const SIZE_MAX = 900;
const SIZE_PRESETS = [
  { key: 'size.tiny', size: 240 },
  { key: 'size.small', size: 320 },
  { key: 'size.medium', size: 420 },
  { key: 'size.large', size: 520 },
  { key: 'size.huge', size: 640 },
];
const WHISPER_INTERVALS = [300, 900, 1800, 3600];
const LANGUAGES = ['auto', 'zh', 'en'];
/** 活跃度 → 待机/转向权重（剩下的概率给小动作，见 shared rollKind） */
const LIVELINESS = {
  calm: { idle: 45, turn: 5 },
  normal: { idle: 10, turn: 5 },
  lively: { idle: 2, turn: 4 },
};
const CORNERS = ['bottom-right', 'bottom-left', 'top-right', 'top-left'];
const EFFORTS = ['low', 'high', 'max'];

const DEFAULTS = {
  version: 1,
  pet: {
    /** 空 = 按界面语言用默认名字（中文「蓝毛小女仆」/ 英文「Blue Maid」） */
    name: '',
    size: 420,
    roam: true,
    liveliness: 'normal',
    corner: 'bottom-right',
    confineToScreen: false,
    throwPower: 1,
  },
  talk: {
    whisperEnabled: true,
    whisperIntervalSec: 900,
    whisperImage: true,
    chatImage: true,
    balanceEnabled: true,
  },
  ai: {
    apiKey: '',
    model: 'deepseek-flash',
    effort: 'low',
    memoryRounds: 8,
    persona: '',
  },
  app: {
    /** auto = 跟随系统；zh / en */
    language: 'auto',
    openAtLogin: false,
    showInDock: false,
    shortcutEnabled: true,
    shortcut: 'Control+Alt+P',
    visible: true,
    overFullscreen: true,
  },
  /** 桌宠中心点在桌面外接矩形里的比例位置（null = 用 corner 角落） */
  position: null,
  /** 首次启动的引导是否已经完成 */
  onboarded: false,
};

function dataDir() {
  return app.getPath('userData');
}
function settingsFile() {
  return path.join(dataDir(), 'settings.json');
}
function memoryFile() {
  return path.join(dataDir(), 'memory.json');
}
function uploadsDir() {
  return path.join(dataDir(), 'uploads');
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 深合并：b 覆盖 a（数组整体替换）；不修改入参 */
function merge(a, b) {
  if (!isPlainObject(a) || !isPlainObject(b)) return b === undefined ? a : b;
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    out[k] = isPlainObject(v) && isPlainObject(a[k]) ? merge(a[k], v) : v;
  }
  return out;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** 把任意输入规整成合法设置（未知字段丢弃、越界值夹回、类型不对回默认） */
function sanitize(raw) {
  const s = merge(DEFAULTS, isPlainObject(raw) ? raw : {});
  const pet = s.pet;
  pet.name = String(pet.name || '').trim().slice(0, 24);
  // 和某种语言的默认名字一样 = 没改过名字：存成空，切换语言时跟着变
  if (I18n.LANGS.some((l) => pet.name === I18n.t(l, 'pet.defaultName'))) pet.name = '';
  pet.size = clamp(Math.round(Number(pet.size) || DEFAULTS.pet.size), SIZE_MIN, SIZE_MAX);
  pet.roam = pet.roam !== false;
  if (!LIVELINESS[pet.liveliness]) pet.liveliness = DEFAULTS.pet.liveliness;
  if (!CORNERS.includes(pet.corner)) pet.corner = DEFAULTS.pet.corner;
  pet.confineToScreen = pet.confineToScreen === true;
  pet.throwPower = clamp(Number(pet.throwPower) || 1, 0.3, 2);

  const talk = s.talk;
  for (const k of ['whisperEnabled', 'whisperImage', 'chatImage', 'balanceEnabled']) talk[k] = talk[k] !== false;
  talk.whisperIntervalSec = clamp(Math.round(Number(talk.whisperIntervalSec) || 900), 60, 4 * 3600);

  const ai = s.ai;
  ai.apiKey = String(ai.apiKey || '').trim();
  ai.model = String(ai.model || DEFAULTS.ai.model).trim();
  if (!EFFORTS.includes(ai.effort)) ai.effort = DEFAULTS.ai.effort;
  ai.memoryRounds = clamp(Math.round(Number(ai.memoryRounds) || 8), 1, 30);
  ai.persona = String(ai.persona || '').slice(0, 2000);

  const a = s.app;
  for (const k of ['openAtLogin', 'showInDock', 'shortcutEnabled', 'visible', 'overFullscreen']) a[k] = a[k] === true;
  a.shortcut = String(a.shortcut || DEFAULTS.app.shortcut);
  if (!LANGUAGES.includes(a.language)) a.language = 'auto';

  if (s.position && !(Number.isFinite(s.position.rx) && Number.isFinite(s.position.ry))) s.position = null;
  s.onboarded = s.onboarded === true;
  // 只保留已知顶层字段
  const known = {};
  for (const k of Object.keys(DEFAULTS)) known[k] = s[k];
  return known;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return undefined;
  }
}

/** 原子写（先写临时文件再改名），可指定权限 */
function writeJsonAtomic(file, data, mode = 0o644) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, mode);
  } catch {
    /* 忽略 */
  }
}

/** JSONC → JSON（去掉注释；与上游 stripJsonc 同规则） */
function loadJsonc(file) {
  try {
    const src = fs
      .readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^\\:"])\/\/.*$/gm, '$1');
    return JSON.parse(src);
  } catch {
    return null;
  }
}

class Store extends EventEmitter {
  constructor() {
    super();
    this.firstRun = false;
    this.data = sanitize({});
  }

  load() {
    const raw = readJson(settingsFile());
    this.firstRun = raw === undefined;
    this.data = sanitize(raw || {});
    return this.data;
  }

  get() {
    return this.data;
  }

  save() {
    writeJsonAtomic(settingsFile(), this.data, 0o600);
  }

  /** 合并一个补丁并持久化；返回新设置。值没变不发事件。 */
  update(patch) {
    const prev = this.data;
    const next = sanitize(merge(prev, patch || {}));
    if (JSON.stringify(prev) === JSON.stringify(next)) return next;
    this.data = next;
    this.save();
    this.emit('change', next, prev);
    return next;
  }

  hasApiKey() {
    return !!(process.env.DEEPSEEK_API_KEY || this.data.ai.apiKey);
  }

  apiKey() {
    return (process.env.DEEPSEEK_API_KEY || this.data.ai.apiKey || '').trim();
  }

  /** 实际使用的界面语言：zh / en（auto 时看系统首选语言，中文系统用中文，其余用英文） */
  lang() {
    const pref = this.data.app.language;
    if (pref === 'zh' || pref === 'en') return pref;
    let sys = '';
    try {
      sys = (app.getPreferredSystemLanguages()[0] || app.getLocale() || '').toLowerCase();
    } catch {
      /* 拿不到就当英文 */
    }
    return sys.startsWith('zh') ? 'zh' : 'en';
  }

  /** 翻译（按当前界面语言） */
  t(key, vars) {
    return I18n.t(this.lang(), key, vars);
  }

  /** 她现在叫什么（没改过名字就用当前语言的默认名） */
  petName() {
    return this.data.pet.name || this.t('pet.defaultName');
  }
}

const store = new Store();

// ---------------------------------------------------------------- 桌宠配置（渲染端 /config 的成品）
let baseConfigCache = null;
function baseConfig() {
  if (!baseConfigCache) baseConfigCache = loadJsonc(path.join(ASSETS, 'config.jsonc')) || {};
  return JSON.parse(JSON.stringify(baseConfigCache));
}

/** 默认人设（设置页「恢复默认」用）：中文用包内配置的原版人设，英文用翻译版 */
function defaultPersona(lang = store.lang()) {
  return lang === 'en' ? I18n.t('en', 'prompt.persona') : String(baseConfig().whisperPrompt || '');
}

/**
 * 渲染端要的配置（上游 readAllConfig 成品结构 {main: {...}}）：包内默认 + 用户设置覆盖。
 * 工作状态联动是 DSH 专属能力，独立版没有会话可联动，直接关掉。
 */
function petConfig(s = store.get()) {
  const cfg = baseConfig();
  const hasKey = store.hasApiKey();
  cfg.pets = [
    {
      id: 'main',
      name: s.pet.name || store.t('pet.defaultName'),
      size: s.pet.size,
      balanceEnabled: s.talk.balanceEnabled && hasKey,
      whisperEnabled: s.talk.whisperEnabled && hasKey,
      workStatusEnabled: false,
      display: 'desktop',
      position: { corner: s.pet.corner, marginX: 24, marginY: 16 },
    },
  ];
  cfg.whisperImageEnabled = s.talk.whisperImage;
  cfg.chatImageEnabled = s.talk.chatImage;
  cfg.chatMemoryRounds = s.ai.memoryRounds;
  cfg.confineToScreen = s.pet.confineToScreen;
  cfg.physics = Object.assign({}, cfg.physics, { throwPower: s.pet.throwPower, petCollision: false });
  cfg.eventsRefreshSec = Object.assign({}, cfg.eventsRefreshSec, {
    whisper: s.talk.whisperIntervalSec,
    balance: 1800,
  });
  const live = LIVELINESS[s.pet.liveliness] || LIVELINESS.normal;
  cfg.animationWeights = { idle: live.idle, turn: live.turn, move: s.pet.roam ? 5 : 0 };
  cfg.whisperPrompt = s.ai.persona.trim() || defaultPersona();
  cfg.lang = store.lang();
  return { main: cfg };
}

module.exports = {
  store,
  ASSETS,
  APP_ROOT,
  DEFAULTS,
  SIZE_MIN,
  SIZE_MAX,
  SIZE_PRESETS,
  WHISPER_INTERVALS,
  LANGUAGES,
  CORNERS,
  EFFORTS,
  dataDir,
  memoryFile,
  uploadsDir,
  settingsFile,
  petConfig,
  defaultPersona,
  loadJsonc,
  readJson,
  writeJsonAtomic,
  sanitize,
};
