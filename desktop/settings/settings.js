'use strict';
/* 设置窗口：改了立即生效（像系统设置一样，没有「保存」按钮；只有 API Key 需要点保存） */

const $ = (id) => document.getElementById(id);
const api = window.settingsApi;
const LANG = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh';
const tr = (key, vars) => window.I18n.t(LANG, key, vars);
window.I18n.apply(document, LANG);

let view = null;
let models = [];
/** 模型列表的加载状态：'' | 'loading' | 'error'；modelsFor = 这份列表属于哪套配置 */
let modelsState = '';
let modelsError = '';
let modelsFor = '';

// ---------------------------------------------------------------- 小工具
function hintEl(text) {
  const d = document.createElement('div');
  d.className = 'hint';
  d.textContent = text;
  return d;
}

function toast(text) {
  const t = $('toast');
  t.textContent = text;
  t.classList.add('on');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('on'), 1800);
}

async function set(patch, message) {
  applyView(await api.set(patch));
  if (message) toast(message);
}

/**
 * 同一份视图只渲染一次。
 *
 * 改一个设置会走两条路回到这里：主进程的 settings:changed 推送，和 set() 的 invoke 返回值——
 * 内容完全一样。不挡的话每改一项都要整页渲染两遍（40 多处 DOM 写入 × 2）。
 * 返回 true 表示这次确实重画了。
 */
let renderedSig = '';
function applyView(v) {
  if (!v) return false;
  const sig = JSON.stringify(v);
  if (sig === renderedSig) return false;
  renderedSig = sig;
  view = v;
  render();
  return true;
}

function fillRange(el) {
  const min = Number(el.min);
  const max = Number(el.max);
  el.style.setProperty('--p', ((Number(el.value) - min) / (max - min)) * 100 + '%');
}

function setSeg(el, value, enabled) {
  for (const b of el.querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.v === value);
    if (enabled) b.disabled = !enabled.includes(b.dataset.v);
  }
}

/** 正在编辑的输入框不被回填覆盖 */
function setValue(el, v) {
  if (document.activeElement !== el) el.value = v;
}

const KEY_SYMBOLS = { Command: '⌘', Control: '⌃', Alt: '⌥', Option: '⌥', Shift: '⇧', CommandOrControl: '⌘' };
function prettyAccel(acc) {
  const order = ['Control', 'Alt', 'Option', 'Shift', 'Command', 'CommandOrControl'];
  const parts = String(acc || '').split('+');
  const key = parts.pop() || '';
  parts.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  const named = { Space: LANG === 'en' ? 'Space' : '空格', Up: '↑', Down: '↓', Left: '←', Right: '→', Return: '↩', Backspace: '⌫' };
  return parts.map((p) => KEY_SYMBOLS[p] || p).join('') + (named[key] || key.toUpperCase());
}

// ---------------------------------------------------------------- 标签页
function showTab(tab) {
  if (!document.querySelector('[data-page="' + tab + '"]')) tab = 'pet';
  for (const a of document.querySelectorAll('nav a')) a.classList.toggle('on', a.dataset.tab === tab);
  for (const p of document.querySelectorAll('.page')) p.classList.toggle('on', p.dataset.page === tab);
  $('content').scrollTop = 0;
  if (tab === 'ai') void loadModels();
  // 顶部的预览视频只在「桌宠」页看得见：切到别的页就停，别在看不见的地方一直解码
  if (tab === 'pet') preview.play().catch(() => {});
  else preview.pause();
}
for (const a of document.querySelectorAll('nav a')) a.addEventListener('click', () => showTab(a.dataset.tab));
api.onTab(showTab);

// ---------------------------------------------------------------- 渲染
function render() {
  if (!view) return;
  const s = view.settings;
  const m = view.meta;

  // 桌宠
  setValue($('pet-name'), s.pet.name);
  $('pet-name').placeholder = view.defaultName;
  const size = $('size');
  size.min = m.sizeMin;
  size.max = m.sizeMax;
  if (document.activeElement !== size) size.value = s.pet.size;
  fillRange(size);
  $('size-value').textContent = s.pet.size;
  for (const b of $('size-presets').children) b.classList.toggle('on', Number(b.dataset.size) === s.pet.size);
  $('corner').value = s.pet.corner;
  $('roam').checked = s.pet.roam;
  setSeg($('liveliness'), s.pet.liveliness);
  const th = $('throw');
  if (document.activeElement !== th) th.value = s.pet.throwPower;
  fillRange(th);
  $('confine').checked = s.pet.confineToScreen;

  const keyless = !view.hasKey;
  $('whisper').checked = s.talk.whisperEnabled;
  $('whisper').disabled = keyless;
  $('whisper-interval').value = String(s.talk.whisperIntervalSec);
  $('whisper-interval').disabled = keyless || !s.talk.whisperEnabled;
  $('whisper-image').checked = s.talk.whisperImage;
  $('whisper-image').disabled = keyless || !s.talk.whisperEnabled;
  $('balance').checked = s.talk.balanceEnabled;
  $('balance').disabled = keyless;
  $('row-balance').hidden = !view.provider.balance;
  $('whisper-hint').textContent = tr(keyless ? 'set.whisperNeedKey' : 'set.whisperHint');
  $('btn-say').disabled = keyless;

  // AI
  renderAi();
  $('mem-value').textContent = tr('set.memoryValue', { n: s.ai.memoryRounds });
  $('chat-image').checked = s.talk.chatImage;
  const persona = $('persona');
  setValue(persona, s.ai.persona || m.defaultPersona);

  // 通用
  const login = $('login');
  login.checked = s.app.openAtLogin;
  login.disabled = !m.packaged;
  $('login-hint').textContent = !m.packaged
    ? tr('set.loginDev')
    : m.loginStatus === 'requires-approval'
      ? tr('set.loginApprove')
      : tr('set.loginHint');
  $('language').value = s.app.language;
  $('dock').checked = s.app.showInDock;
  $('visible').checked = s.app.visible;
  $('fullscreen').checked = s.app.overFullscreen;
  const sc = $('shortcut');
  if (!sc.classList.contains('recording')) sc.textContent = prettyAccel(s.app.shortcut);
  $('shortcut-on').checked = s.app.shortcutEnabled;
  sc.disabled = !s.app.shortcutEnabled;
  $('shortcut-hint').textContent =
    s.app.shortcutEnabled && m.shortcutOk === false
      ? tr('set.shortcutBusy')
      : tr('set.shortcutHint');

  // 关于
  $('about-version').textContent = tr('set.about.version', { v: m.version, e: m.electron });
  $('update-auto').checked = s.app.autoUpdate;
}

// ---------------------------------------------------------------- 一键更新
let upd = null;

function clock(ts) {
  return new Intl.DateTimeFormat(LANG === 'en' ? 'en-US' : 'zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(ts || Date.now()));
}

function renderUpdate() {
  if (!upd) return;
  const st = upd;
  const rel = st.latest;
  const hint = $('update-hint');
  hint.classList.remove('warn');
  let label;
  let sub = '';
  switch (st.phase) {
    case 'checking':
      label = tr('set.update.checking');
      sub = tr('set.update.idle', { v: st.current });
      break;
    case 'latest':
      label = tr('set.update.latest');
      sub = tr('set.update.latestHint', { v: st.current, time: clock(st.checkedAt) });
      break;
    case 'available': {
      label = tr('set.update.available', { v: rel.version });
      const mb = Math.round(((rel.asset && rel.asset.size) || 0) / 1e6);
      sub = st.blocker ? tr('update.block.' + st.blocker, { path: st.appPath || '' }) : tr('set.update.availableHint', { cur: st.current, mb: mb || '?' });
      if (st.blocker) hint.classList.add('warn');
      break;
    }
    case 'downloading':
      label = tr('set.update.downloading', { p: Math.round((st.progress || 0) * 100) });
      sub = tr('set.update.downloadingHint');
      break;
    case 'installing':
      label = tr('set.update.installing');
      break;
    case 'restarting':
      label = tr('set.update.restarting');
      break;
    case 'error':
      label = tr('set.update.error');
      sub = st.error;
      hint.classList.add('warn');
      break;
    default:
      label = tr('set.update.idle', { v: st.current });
      sub = tr('set.update.idleHint');
  }
  $('update-status').textContent = label;
  hint.textContent = sub;

  const working = ['downloading', 'installing', 'restarting'].includes(st.phase);
  const canInstall = !!rel && (st.phase === 'available' || st.phase === 'error');
  const install = $('btn-update-install');
  install.hidden = !canInstall;
  install.disabled = !!st.blocker;
  const check = $('btn-update-check');
  check.hidden = canInstall || working;
  check.disabled = st.phase === 'checking';
  check.textContent = tr(st.phase === 'checking' ? 'set.update.checking' : 'set.update.check');
  $('btn-update-cancel').hidden = st.phase !== 'downloading';
  $('update-bar').hidden = !working;
  $('update-bar-fill').style.width = Math.round((st.phase === 'downloading' ? st.progress || 0 : 1) * 100) + '%';

  const lines = (rel && rel.highlights) || [];
  $('update-notes').hidden = !rel;
  const list = $('update-notes-list');
  list.innerHTML = '';
  for (const text of lines) {
    const li = document.createElement('li');
    li.textContent = text;
    list.appendChild(li);
  }
  list.hidden = !lines.length;
}

async function setUpdate(promise) {
  const st = await promise;
  if (st) {
    upd = st;
    renderUpdate();
  }
}

function currentEfforts() {
  const cur = models.find((x) => x.id === view.provider.model);
  return cur && cur.efforts && cur.efforts.length ? cur.efforts : null;
}

/** 改当前服务商自己的配置（Key / 地址 / 模型 / 接口格式） */
function providerPatch(fields) {
  return { ai: { providers: { [view.provider.id]: fields } } };
}

function renderAi() {
  const s = view.settings;
  const pv = view.provider;
  const sel = $('provider');
  if (document.activeElement !== sel) sel.value = s.ai.provider;
  $('row-format').hidden = !pv.custom;
  setSeg($('api-format'), pv.type);

  // API Key：本地模型不需要；自定义接口可选
  $('api-key').hidden = pv.noKey;
  $('btn-save-key').hidden = pv.noKey;
  const pill = $('key-pill');
  pill.hidden = pv.noKey;
  pill.textContent = tr(pv.hasKey ? 'set.keySet' : 'set.keyUnset');
  pill.classList.toggle('ok', pv.hasKey);
  $('key-status').textContent = pv.noKey
    ? tr('set.noKeyNeeded') + ' · ' + tr('set.ollamaHint')
    : pv.hasKey
      ? pv.keyFromEnv
        ? tr('set.keyEnv')
        : tr('set.keyCurrent', { hint: pv.keyHint })
      : pv.custom
        ? tr('set.keyOptional')
        : tr('set.keyNone', { name: pv.name });
  const link = $('link-keys');
  link.hidden = !pv.keyUrl;
  link.textContent = pv.noKey ? tr('set.getOllama') : tr('set.getKey', { name: pv.name });

  // 接口地址：留空 = 用默认
  const bu = $('base-url');
  setValue(bu, pv.baseUrl);
  bu.placeholder = pv.defaultBaseUrl || 'https://api.example.com/v1';
  $('base-url-hint').textContent = tr(pv.custom ? 'set.baseUrlCustomHint' : 'set.baseUrlHint');

  // 模型 + 思考深度（只有支持的服务商才显示）
  const mi = $('model-input');
  setValue(mi, pv.model);
  mi.placeholder = pv.defaultModel || tr('set.modelInput');
  $('row-effort').hidden = !pv.effort;
  setSeg($('effort'), s.ai.effort, currentEfforts());
  renderModels();
}

/** 已填进 <datalist> 的模型清单签名：改一个别的设置也走 renderModels，没必要重建几百个 option */
let modelsListSig = '';

function renderModels() {
  const box = $('models');
  const pv = view.provider;
  box.innerHTML = '';
  // 模型多的服务商（OpenRouter 几百个）以前每改一个设置都要重建整串 option；
  // 清单没变就复用（datalist 的选项只由 models 决定）。
  const sig = modelsState + '|' + models.map((m) => m.id + ':' + (m.name || '')).join(',');
  if (sig !== modelsListSig) {
    modelsListSig = sig;
    const dl = $('model-list');
    dl.innerHTML = '';
    for (const md of models) {
      const o = document.createElement('option');
      o.value = md.id;
      if (md.name && md.name !== md.id) o.label = md.name;
      dl.appendChild(o);
    }
  }
  const hint = $('model-hint');
  hint.classList.remove('warn');
  hint.textContent = tr('set.modelInputHint');
  if (modelsState === 'loading') {
    box.hidden = false;
    box.appendChild(hintEl(tr('set.modelsLoading')));
    return;
  }
  if (modelsState === 'error') {
    box.hidden = false;
    box.appendChild(hintEl(tr('set.modelsFail', { msg: modelsError })));
    return;
  }
  if (!models.length) {
    box.hidden = !(!pv.hasKey && !pv.noKey && !pv.custom);
    if (!box.hidden) box.appendChild(hintEl(tr('set.modelsNeedKey')));
    return;
  }
  if (pv.model && !models.some((m) => m.id === pv.model)) {
    hint.textContent = tr('set.modelNotListed');
    hint.classList.add('warn');
  }
  // 模型很多（OpenRouter 几百个）时不铺卡片，用上面的输入框（带下拉提示）选
  box.hidden = models.length > 6;
  if (box.hidden) return;
  for (const md of models) {
    const b = document.createElement('button');
    b.className = 'model' + (md.id === pv.model ? ' on' : '');
    b.innerHTML =
      '<span class="radio"></span><span class="m-body"><div class="m-name"></div><div class="m-id"></div></span><span class="badges"></span>';
    b.querySelector('.m-name').textContent = md.name || md.id;
    b.querySelector('.m-id').textContent = md.id;
    const badges = b.querySelector('.badges');
    const add = (text, cls) => {
      const x = document.createElement('span');
      x.className = 'badge' + (cls ? ' ' + cls : '');
      x.textContent = text;
      badges.appendChild(x);
    };
    if (md.vision) add(tr('set.vision'), 'eye');
    if (md.context) {
      add(tr('set.ctx', { n: md.context >= 1000000 ? Math.round(md.context / 1048576) + 'M' : Math.round(md.context / 1024) + 'K' }));
    }
    b.addEventListener('click', () => {
      const patch = providerPatch({ model: md.id });
      if (md.efforts && md.efforts.length && !md.efforts.includes(view.settings.ai.effort)) patch.ai.effort = md.efforts[0];
      void set(patch, tr('set.modelSwitched', { name: md.name || md.id }));
    });
    box.appendChild(b);
  }
}

function configSig() {
  const pv = view.provider;
  return [pv.id, pv.type, pv.baseUrl, pv.hasKey, pv.keyHint].join('|');
}

async function loadModels(force) {
  if (!view) return;
  const sig = configSig();
  if (!force && sig === modelsFor) return renderModels();
  modelsFor = sig;
  const pv = view.provider;
  if (!pv.hasKey && !pv.noKey && !pv.custom) {
    models = [];
    modelsState = '';
    return renderModels();
  }
  models = [];
  modelsState = 'loading';
  renderModels();
  const r = await api.models();
  if (sig !== modelsFor) return; // 期间切换了服务商
  models = r.ok ? r.models : [];
  modelsState = r.ok ? '' : 'error';
  modelsError = r.ok ? '' : r.message;
  renderModels();
  setSeg($('effort'), view.settings.ai.effort, currentEfforts());
}

/** 新填的 Key 没选模型 / 选的模型不存在时，挑一个合适的：默认模型 → 名字里带 flash/mini/haiku… 的快模型 → 第一个 */
function pickModel(ids) {
  const pv = view.provider;
  if (!ids.length || ids.includes(pv.model)) return null;
  if (pv.defaultModel && ids.includes(pv.defaultModel)) return pv.defaultModel;
  for (const re of [/flash/i, /mini/i, /haiku/i, /turbo/i, /chat/i, /plus/i]) {
    const hit = ids.find((id) => re.test(id));
    if (hit) return hit;
  }
  return ids[0];
}

// ---------------------------------------------------------------- 绑定：桌宠
$('pet-name').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  void set({ pet: { name: v } }, tr('set.toast.name', { name: v || view.defaultName }));
});
$('pet-name').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.target.blur();
});
$('size').addEventListener('input', (e) => {
  fillRange(e.target);
  $('size-value').textContent = e.target.value;
});
$('size').addEventListener('change', (e) => void set({ pet: { size: Number(e.target.value) } }));
$('corner').addEventListener('change', (e) => void set({ pet: { corner: e.target.value } }));
$('roam').addEventListener('change', (e) => void set({ pet: { roam: e.target.checked } }));
$('throw').addEventListener('input', (e) => fillRange(e.target));
$('throw').addEventListener('change', (e) => void set({ pet: { throwPower: Number(e.target.value) } }));
$('confine').addEventListener('change', (e) => void set({ pet: { confineToScreen: e.target.checked } }));
for (const b of $('liveliness').querySelectorAll('button')) {
  b.addEventListener('click', () => void set({ pet: { liveliness: b.dataset.v } }));
}
$('whisper').addEventListener('change', (e) => void set({ talk: { whisperEnabled: e.target.checked } }));
$('whisper-interval').addEventListener('change', (e) => void set({ talk: { whisperIntervalSec: Number(e.target.value) } }));
$('whisper-image').addEventListener('change', (e) => void set({ talk: { whisperImage: e.target.checked } }));
$('balance').addEventListener('change', (e) => void set({ talk: { balanceEnabled: e.target.checked } }));
$('btn-say').addEventListener('click', () => api.say());
$('btn-home').addEventListener('click', () => {
  api.home();
  toast(tr('set.toast.home'));
});

// 预览：点一下她会挥手
const preview = $('preview');
let previewIdle = '';
preview.addEventListener('click', () => {
  preview.loop = false;
  preview.src = view.api + '/thumb/main/' + encodeURIComponent('点击回应-元气挥手') + '.webm';
});
preview.addEventListener('ended', () => {
  preview.loop = true;
  preview.src = previewIdle;
});

// ---------------------------------------------------------------- 绑定：AI
$('link-keys').addEventListener('click', (e) => {
  e.preventDefault();
  api.openLink('providerKey');
});
function keyResult(text, cls) {
  const r = $('key-result');
  r.textContent = text;
  r.className = 'result' + (cls ? ' ' + cls : '');
}
/** 用输入框里（可能还没保存）的 Key / 地址 / 模型测一次 */
function testConfig() {
  const pv = view.provider;
  return api.testKey({
    id: pv.id,
    apiKey: $('api-key').value.trim(),
    baseUrl: $('base-url').value.trim(),
    model: $('model-input').value.trim(),
    type: pv.type,
  });
}
function connMessage(r) {
  const bal = r.balance
    ? tr('set.keyBal', { v: (r.balance.currency === 'CNY' ? '¥' : r.balance.currency + ' ') + r.balance.total })
    : '';
  return r.models.length ? tr('set.connOkModels', { bal, n: r.models.length }) : tr('set.connOk', { bal });
}
$('provider').addEventListener('change', (e) => {
  const id = e.target.value;
  const name = (view.providers.find((x) => x.id === id) || {}).name || id;
  $('api-key').value = '';
  keyResult('');
  models = [];
  modelsFor = '';
  void set({ ai: { provider: id } }, tr('set.providerSwitched', { name })).then(() => loadModels(true));
});
for (const b of $('api-format').querySelectorAll('button')) {
  b.addEventListener('click', () => void set(providerPatch({ type: b.dataset.v })).then(() => loadModels(true)));
}
$('btn-test').addEventListener('click', async () => {
  const btn = $('btn-test');
  btn.disabled = true;
  keyResult(tr('set.testing'));
  const r = await testConfig();
  btn.disabled = false;
  if (r.ok) keyResult(connMessage(r), 'ok');
  else keyResult('✗ ' + r.message, 'err');
});
$('btn-save-key').addEventListener('click', async () => {
  const key = $('api-key').value.trim();
  if (!key) {
    keyResult(tr('set.keyPaste'), 'err');
    return;
  }
  const btn = $('btn-save-key');
  btn.disabled = true;
  keyResult(tr('set.verifying'));
  const r = await testConfig();
  btn.disabled = false;
  if (!r.ok) {
    keyResult('✗ ' + r.message, 'err');
    return;
  }
  $('api-key').value = '';
  const fields = { apiKey: key };
  const auto = pickModel(r.models);
  if (auto) fields.model = auto;
  await set(providerPatch(fields), auto ? tr('set.modelAuto', { name: auto }) : tr('set.keySavedToast'));
  keyResult(tr('set.keySaved'), 'ok');
  void loadModels(true);
});
$('api-key').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-save-key').click();
});
$('base-url').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  if (v && !/^https?:\/\/\S+$/i.test(v)) {
    keyResult('✗ ' + tr('err.noBaseUrl'), 'err');
    return;
  }
  void set(providerPatch({ baseUrl: v }), tr('set.baseUrlSaved')).then(() => loadModels(true));
});
$('model-input').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  void set(providerPatch({ model: v }), v ? tr('set.modelSwitched', { name: v }) : '');
});
$('model-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') e.target.blur();
});
$('btn-refresh-models').addEventListener('click', () => void loadModels(true));
for (const b of $('effort').querySelectorAll('button')) {
  b.addEventListener('click', () => void set({ ai: { effort: b.dataset.v } }));
}
$('effort').addEventListener('mouseover', (e) => {
  const v = e.target && e.target.dataset ? e.target.dataset.v : '';
  if (['low', 'high', 'max'].includes(v)) $('effort-hint').textContent = tr('set.effortHint.' + v);
});
$('mem-minus').addEventListener('click', () => void set({ ai: { memoryRounds: view.settings.ai.memoryRounds - 1 } }));
$('mem-plus').addEventListener('click', () => void set({ ai: { memoryRounds: view.settings.ai.memoryRounds + 1 } }));
$('chat-image').addEventListener('change', (e) => void set({ talk: { chatImage: e.target.checked } }));
$('btn-clear').addEventListener('click', async () => {
  if (!window.confirm(tr('set.confirmClear'))) return;
  await api.clearHistory();
  toast(tr('set.cleared'));
});
$('persona').addEventListener('change', (e) => {
  const v = e.target.value.trim();
  const isDefault = v === String(view.meta.defaultPersona || '').trim();
  void set({ ai: { persona: isDefault ? '' : v } }, tr('set.personaSaved'));
});
$('btn-persona-reset').addEventListener('click', () => {
  $('persona').value = view.meta.defaultPersona;
  void set({ ai: { persona: '' } }, tr('set.personaRestored'));
});

// ---------------------------------------------------------------- 绑定：通用
$('login').addEventListener('change', (e) => void set({ app: { openAtLogin: e.target.checked } }));
$('dock').addEventListener('change', (e) => void set({ app: { showInDock: e.target.checked } }));
$('visible').addEventListener('change', (e) => void set({ app: { visible: e.target.checked } }));
$('fullscreen').addEventListener('change', (e) => void set({ app: { overFullscreen: e.target.checked } }));
$('shortcut-on').addEventListener('change', (e) => void set({ app: { shortcutEnabled: e.target.checked } }));

// 快捷键录制：点一下 → 按下新组合键（至少一个 ⌘/⌃/⌥）→ 生效；Esc 取消
const sc = $('shortcut');
sc.addEventListener('click', () => {
  sc.classList.add('recording');
  sc.textContent = tr('set.shortcutRecord');
  sc.focus();
});
sc.addEventListener('blur', () => {
  if (sc.classList.contains('recording')) {
    sc.classList.remove('recording');
    render();
  }
});
sc.addEventListener('keydown', (e) => {
  if (!sc.classList.contains('recording')) return;
  e.preventDefault();
  if (e.key === 'Escape') {
    sc.blur();
    return;
  }
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key)) return;
  const mods = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Command');
  if (!e.ctrlKey && !e.altKey && !e.metaKey) {
    sc.textContent = tr('set.shortcutNeedMod');
    return;
  }
  let key = '';
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) key = e.code.slice(5);
  else if (/^F\d{1,2}$/.test(e.code)) key = e.code;
  else if (e.code === 'Space') key = 'Space';
  else if (e.code.startsWith('Arrow')) key = e.code.slice(5);
  if (!key) return;
  sc.classList.remove('recording');
  sc.blur();
  void set({ app: { shortcut: mods.concat(key).join('+') } }, tr('set.shortcutChanged', { key: prettyAccel(mods.concat(key).join('+')) }));
});

// ---------------------------------------------------------------- 绑定：关于
$('btn-data').addEventListener('click', () => api.openData());
$('btn-repo').addEventListener('click', () => api.openLink('repo'));
$('link-upstream').addEventListener('click', (e) => {
  e.preventDefault();
  api.openLink('upstream');
});
$('language').addEventListener('change', (e) => void set({ app: { language: e.target.value } }));
$('update-auto').addEventListener('change', (e) => void set({ app: { autoUpdate: e.target.checked } }));
$('btn-update-check').addEventListener('click', () => void setUpdate(api.checkUpdate()));
$('btn-update-install').addEventListener('click', () => void setUpdate(api.installUpdate()));
$('btn-update-cancel').addEventListener('click', () => api.cancelUpdate());
$('link-release').addEventListener('click', (e) => {
  e.preventDefault();
  api.openLink('release');
});
api.onUpdate((st) => {
  upd = st;
  renderUpdate();
});

// ---------------------------------------------------------------- 启动
api.onChanged((v) => {
  // 同一次变更的两条路径只渲染一次（见 applyView）
  if (!applyView(v)) return;
  // 别处（菜单栏 / 另一个窗口）改了 AI 配置：在 AI 页上就顺手刷新模型列表
  const page = document.querySelector('.page.on');
  if (page && page.dataset.page === 'ai') void loadModels();
});

api.get().then((v) => {
  view = v;
  const m = v.meta;
  for (const pr of v.providers) {
    const o = document.createElement('option');
    o.value = pr.id;
    o.textContent = pr.name;
    $('provider').appendChild(o);
  }
  for (const p of m.sizePresets) {
    const b = document.createElement('button');
    b.className = 'preset';
    b.dataset.size = p.size;
    b.textContent = p.label;
    b.title = String(p.size);
    b.addEventListener('click', () => void set({ pet: { size: p.size } }));
    $('size-presets').appendChild(b);
  }
  for (const it of m.intervals) {
    const o = document.createElement('option');
    o.value = String(it.sec);
    o.textContent = it.label;
    $('whisper-interval').appendChild(o);
  }
  if (!m.intervals.some((it) => it.sec === v.settings.talk.whisperIntervalSec)) {
    const o = document.createElement('option');
    o.value = String(v.settings.talk.whisperIntervalSec);
    o.textContent = tr('interval.custom', { n: Math.round(v.settings.talk.whisperIntervalSec / 60) });
    $('whisper-interval').appendChild(o);
  }
  previewIdle = v.api + '/thumb/main/' + encodeURIComponent('待机呼吸休闲') + '.webm';
  preview.src = previewIdle;
  render();
  renderedSig = JSON.stringify(v); // 首屏已经画过这份视图，别让随后的推送再画一遍
  showTab(location.hash ? location.hash.slice(1) : v.hasKey ? 'pet' : 'ai');
  void setUpdate(api.updateState());
});
