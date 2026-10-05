'use strict';
/* 设置窗口：改了立即生效（像系统设置一样，没有「保存」按钮；只有 API Key 需要点保存） */

const $ = (id) => document.getElementById(id);
const api = window.settingsApi;
const LANG = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh';
const tr = (key, vars) => window.I18n.t(LANG, key, vars);
window.I18n.apply(document, LANG);

let view = null;
let models = [];

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
  view = await api.set(patch);
  render();
  if (message) toast(message);
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
  $('whisper-hint').textContent = tr(keyless ? 'set.whisperNeedKey' : 'set.whisperHint');
  $('btn-say').disabled = keyless;

  // AI
  const pill = $('key-pill');
  pill.textContent = tr(view.hasKey ? 'set.keySet' : 'set.keyUnset');
  pill.classList.toggle('ok', view.hasKey);
  $('key-status').textContent = view.hasKey
    ? view.keyFromEnv
      ? tr('set.keyEnv')
      : tr('set.keyCurrent', { hint: view.keyHint })
    : tr('set.keyNone');
  setSeg($('effort'), s.ai.effort, currentEfforts());
  $('mem-value').textContent = tr('set.memoryValue', { n: s.ai.memoryRounds });
  $('chat-image').checked = s.talk.chatImage;
  const persona = $('persona');
  setValue(persona, s.ai.persona || m.defaultPersona);
  renderModels();

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
}

function currentEfforts() {
  const cur = models.find((x) => x.id === view.settings.ai.model);
  return cur && cur.efforts && cur.efforts.length ? cur.efforts : null;
}

function renderModels() {
  const box = $('models');
  if (!view.hasKey) {
    box.innerHTML = '';
    box.appendChild(hintEl(tr('set.modelsNeedKey')));
    return;
  }
  if (!models.length) {
    box.innerHTML = '';
    box.appendChild(hintEl(tr('set.modelsLoading')));
    return;
  }
  box.innerHTML = '';
  for (const md of models) {
    const b = document.createElement('button');
    b.className = 'model' + (md.id === view.settings.ai.model ? ' on' : '');
    b.innerHTML =
      '<span class="radio"></span><span class="m-body"><div class="m-name"></div><div class="m-id"></div></span><span class="badges"></span>';
    b.querySelector('.m-name').textContent = md.name;
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
      const patch = { ai: { model: md.id } };
      if (md.efforts && md.efforts.length && !md.efforts.includes(view.settings.ai.effort)) patch.ai.effort = md.efforts[0];
      void set(patch, tr('set.modelSwitched', { name: md.name }));
    });
    box.appendChild(b);
  }
}

async function loadModels() {
  if (!view || !view.hasKey) return;
  const r = await api.models();
  if (r.ok) {
    models = r.models;
    renderModels();
    setSeg($('effort'), view.settings.ai.effort, currentEfforts());
  } else {
    $('models').innerHTML = '';
    const d = document.createElement('div');
    d.className = 'hint';
    d.textContent = tr('set.modelsFail', { msg: r.message });
    $('models').appendChild(d);
  }
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
  api.openLink('apiKeys');
});
function keyResult(text, cls) {
  const r = $('key-result');
  r.textContent = text;
  r.className = 'result' + (cls ? ' ' + cls : '');
}
$('btn-test').addEventListener('click', async () => {
  const btn = $('btn-test');
  btn.disabled = true;
  keyResult(tr('set.testing'));
  const r = await api.testKey($('api-key').value.trim());
  btn.disabled = false;
  if (r.ok) {
    const bal = r.balance
      ? tr('set.keyBal', { v: (r.balance.currency === 'CNY' ? '¥' : r.balance.currency + ' ') + r.balance.total })
      : '';
    keyResult(tr('set.keyOk', { bal, n: r.models.length }), 'ok');
  } else {
    keyResult('✗ ' + r.message, 'err');
  }
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
  const r = await api.testKey(key);
  btn.disabled = false;
  if (!r.ok) {
    keyResult('✗ ' + r.message, 'err');
    return;
  }
  $('api-key').value = '';
  models = [];
  await set({ ai: { apiKey: key } }, tr('set.keySavedToast'));
  keyResult(tr('set.keySaved'), 'ok');
  void loadModels();
});
$('api-key').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') $('btn-save-key').click();
});
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

// ---------------------------------------------------------------- 启动
api.onChanged((v) => {
  view = v;
  render();
});

api.get().then((v) => {
  view = v;
  const m = v.meta;
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
  showTab(location.hash ? location.hash.slice(1) : v.hasKey ? 'pet' : 'ai');
});
