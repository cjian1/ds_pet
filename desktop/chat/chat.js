'use strict';
/* 聊天面板：流式显示她的回复、可递图（按钮 / 粘贴 / 拖进来）、中文输入法下回车不误发。 */

const $ = (id) => document.getElementById(id);
const api = window.chatApi;
const LANG = new URLSearchParams(location.search).get('lang') === 'en' ? 'en' : 'zh';
const tr = (key, vars) => window.I18n.t(LANG, key, vars);
window.I18n.apply(document, LANG);

const els = {
  scroll: $('scroll'),
  list: $('list'),
  input: $('input'),
  send: $('btn-send'),
  status: $('status'),
  name: $('name'),
  avatar: $('avatar'),
  empty: $('empty'),
  emptyImg: $('empty-img'),
  emptyTitle: $('empty-title'),
  chips: $('chips'),
  nokey: $('nokey'),
  file: $('file'),
  attachPreview: $('attach-preview'),
  attachImg: $('attach-img'),
};

const SUGGESTIONS = ['chat.s1', 'chat.s2', 'chat.s3', 'chat.s4'].map((k) => tr(k));

let state = { name: '', hasKey: false, api: 'deskpet://app/api', history: [] };
let busy = false;
let attached = null; // 待发送的图片（data URL）
let current = null; // 正在生成的回复 {id, row, bubble, text}
let lastTs = 0;
let seq = 0;

// ---------------------------------------------------------------- 工具
function assetUrl(kind, name) {
  return state.api + '/' + kind + '/' + encodeURIComponent(name);
}
function memeUrl(name) {
  return assetUrl('memes', name + '.png');
}
function nearBottom() {
  const s = els.scroll;
  return s.scrollHeight - s.scrollTop - s.clientHeight < 80;
}
function toBottom(force) {
  if (force || nearBottom()) els.scroll.scrollTop = els.scroll.scrollHeight;
}
function fmtTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const hm = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  if (d.toDateString() === now.toDateString()) return hm;
  const y = new Date(now);
  y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return tr('chat.yesterday', { time: hm });
  const day = new Intl.DateTimeFormat(LANG === 'en' ? 'en-US' : 'zh-CN', { month: 'short', day: 'numeric' }).format(d);
  return day + ' ' + hm;
}
function setStatus(text) {
  els.status.textContent = text;
}
function setBusy(b) {
  busy = b;
  document.body.classList.toggle('busy', b);
  els.send.title = tr(b ? 'chat.stop' : 'chat.send');
  if (!b) setStatus(tr(state.hasKey ? 'chat.online' : 'chat.offline'));
  updateSendEnabled();
}
function updateSendEnabled() {
  els.send.disabled = !busy && (!state.hasKey || (!els.input.value.trim() && !attached));
}
function autosize() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(120, els.input.scrollHeight + 2) + 'px';
}

// ---------------------------------------------------------------- 渲染
function maybeTime(ts) {
  if (!ts) return;
  if (ts - lastTs > 10 * 60 * 1000) {
    const t = document.createElement('div');
    t.className = 'time';
    t.textContent = fmtTime(ts);
    els.list.appendChild(t);
  }
  lastTs = ts;
}

function addMessage(role, text, image, opts = {}) {
  maybeTime(opts.ts || Date.now());
  const row = document.createElement('div');
  row.className = 'msg ' + (role === 'user' ? 'me' : 'her');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (image) {
    const img = document.createElement('img');
    img.src = image;
    img.alt = '';
    img.draggable = false;
    img.addEventListener('load', () => toBottom());
    bubble.appendChild(img);
  }
  const span = document.createElement('span');
  span.className = 'text';
  span.textContent = text || '';
  bubble.appendChild(span);
  row.appendChild(bubble);
  els.list.appendChild(row);
  updateEmpty();
  toBottom(opts.force);
  return { row, bubble, span };
}

function addTyping() {
  const m = addMessage('assistant', '', null, { force: true });
  m.span.remove();
  const dots = document.createElement('span');
  dots.className = 'typing';
  dots.innerHTML = '<i></i><i></i><i></i>';
  m.bubble.appendChild(dots);
  m.dots = dots;
  return m;
}

function addNotice(text, retry) {
  const n = document.createElement('div');
  n.className = 'notice';
  const t = document.createElement('span');
  t.textContent = text;
  n.appendChild(t);
  if (retry) {
    const b = document.createElement('button');
    b.textContent = tr('chat.retry');
    b.addEventListener('click', () => {
      n.remove();
      retry();
    });
    n.appendChild(b);
  }
  els.list.appendChild(n);
  toBottom(true);
}

function updateEmpty() {
  const has = els.list.children.length > 0;
  els.nokey.hidden = state.hasKey;
  els.empty.hidden = has || !state.hasKey;
}

function renderHistory() {
  els.list.innerHTML = '';
  lastTs = 0;
  for (const m of state.history) {
    // 早期版本把「递图」时的内部指令也存进了记录，显示时换成人话
    if (m.role === 'user' && (/^（主人递来一张图）/.test(m.content) || m.content === '（递来一张图）')) m.content = tr('chat.sharedImage');
    let image = null;
    if (m.image) image = m.role === 'user' ? assetUrl('uploads', m.image) : memeUrl(m.image);
    addMessage(m.role, m.content, image, { ts: m.ts });
  }
  updateEmpty();
  requestAnimationFrame(() => toBottom(true));
}

function applyState(s) {
  const rerender = !busy || !s.history;
  state = Object.assign(state, s);
  els.name.textContent = state.name;
  els.emptyTitle.textContent = tr('chat.emptyTitle', { name: state.name });
  document.title = tr('chat.title', { name: state.name });
  document.body.classList.toggle('offline', !state.hasKey);
  els.input.disabled = !state.hasKey;
  els.input.placeholder = state.hasKey ? tr('chat.placeholder', { name: state.name }) : tr('chat.placeholderNoKey');
  const avatar = memeUrl('可爱');
  els.avatar.src = avatar;
  els.emptyImg.src = avatar;
  if (!busy) setBusy(false);
  if (rerender) renderHistory();
  else updateEmpty();
}

// ---------------------------------------------------------------- 发送
function attach(dataUrl) {
  if (!dataUrl || !String(dataUrl).startsWith('data:image/')) return;
  attached = dataUrl;
  els.attachImg.src = dataUrl;
  els.attachPreview.hidden = false;
  updateSendEnabled();
  els.input.focus();
}
function clearAttach() {
  attached = null;
  els.attachPreview.hidden = true;
  els.attachImg.removeAttribute('src');
  els.file.value = '';
  updateSendEnabled();
}

async function send(text, image) {
  if (busy || !state.hasKey) return;
  text = String(text || '').trim();
  if (!text && !image) return;
  addMessage('user', text, image, { force: true });
  const id = ++seq;
  current = { id, msg: addTyping(), text: '' };
  setBusy(true);
  setStatus(tr('chat.thinking'));
  let res;
  try {
    res = await api.send({ id, text, image });
  } catch (e) {
    res = { ok: false, message: String((e && e.message) || e) };
  }
  const cur = current;
  current = null;
  setBusy(false);
  if (!cur || cur.id !== id) return;
  if (res && res.ok) {
    finishReply(cur, res.reply, res.image);
  } else {
    if (!cur.text) cur.msg.row.remove();
    if (res && res.reason === 'aborted') {
      if (cur.text) cur.msg.span.textContent = cur.text + ' …';
      return;
    }
    const msg = (res && res.message) || tr('chat.error');
    if (res && res.reason === 'provider-missing') {
      addNotice(tr('chat.offline'));
    } else {
      addNotice(tr('chat.failed', { msg }), () => send(text, image));
    }
  }
}

function finishReply(cur, reply, image) {
  const m = cur.msg;
  if (m.dots) {
    m.dots.remove();
    m.dots = null;
  }
  if (!m.span.isConnected) m.bubble.appendChild(m.span);
  m.span.textContent = reply || cur.text;
  if (image) {
    const img = document.createElement('img');
    img.src = memeUrl(image);
    img.alt = image;
    img.draggable = false;
    img.addEventListener('load', () => toBottom());
    m.bubble.insertBefore(img, m.span);
  }
  toBottom();
}

api.onStream((ev) => {
  if (!current || ev.id !== current.id) return;
  if (ev.type === 'thinking') setStatus(tr('chat.thinking'));
  if (ev.type === 'delta') {
    const m = current.msg;
    if (m.dots) {
      m.dots.remove();
      m.dots = null;
      m.bubble.appendChild(m.span);
      setStatus(tr('chat.typing'));
    }
    current.text += ev.text;
    m.span.textContent = current.text;
    toBottom();
  }
});

function submit() {
  if (busy) {
    api.stop();
    return;
  }
  const text = els.input.value;
  const image = attached;
  if (!text.trim() && !image) return;
  els.input.value = '';
  autosize();
  clearAttach();
  void send(text, image);
}

// ---------------------------------------------------------------- 事件
els.send.addEventListener('click', submit);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && e.keyCode !== 229) {
    e.preventDefault();
    submit();
  }
});
els.input.addEventListener('input', () => {
  autosize();
  updateSendEnabled();
});
els.input.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData ? e.clipboardData.items : [])].find((i) => i.type.startsWith('image/'));
  if (!item) return;
  e.preventDefault();
  const reader = new FileReader();
  reader.onload = () => attach(String(reader.result));
  reader.readAsDataURL(item.getAsFile());
});
$('btn-attach').addEventListener('click', () => els.file.click());
els.file.addEventListener('change', () => {
  const f = els.file.files && els.file.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => attach(String(reader.result));
  reader.readAsDataURL(f);
});
$('attach-remove').addEventListener('click', clearAttach);
$('btn-close').addEventListener('click', () => api.close());
$('btn-settings').addEventListener('click', () => api.openSettings('ai'));
$('btn-clear').addEventListener('click', async () => {
  if (busy) return;
  if (!els.list.children.length) return;
  if (!window.confirm(tr('chat.confirmClear', { name: state.name }))) return;
  applyState(await api.clear());
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !e.isComposing) api.close();
});

// 拖图进面板
let dragDepth = 0;
const hasFiles = (e) => [...((e.dataTransfer && e.dataTransfer.types) || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  dragDepth++;
  document.body.classList.add('dragging');
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) document.body.classList.remove('dragging');
});
window.addEventListener('dragover', (e) => {
  if (hasFiles(e)) e.preventDefault();
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dragging');
  const f = [...((e.dataTransfer && e.dataTransfer.files) || [])].find((x) => x.type.startsWith('image/'));
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => attach(String(reader.result));
  reader.readAsDataURL(f);
});

for (const s of SUGGESTIONS) {
  const b = document.createElement('button');
  b.className = 'chip';
  b.textContent = s;
  b.addEventListener('click', () => void send(s));
  els.chips.appendChild(b);
}

let ready = false;
let pendingAttach = null;
function handleAttach({ image, autoSend }) {
  if (!ready) {
    pendingAttach = { image, autoSend };
    return;
  }
  if (autoSend && state.hasKey && !busy) void send('', image);
  else attach(image);
}
api.onAttach(handleAttach);
api.onRefresh((s) => applyState(s));
api.onFocus(() => {
  if (!els.input.disabled) els.input.focus();
});

api.init().then((s) => {
  applyState(s);
  ready = true;
  els.input.focus();
  if (pendingAttach) {
    const p = pendingAttach;
    pendingAttach = null;
    handleAttach(p);
  }
});
