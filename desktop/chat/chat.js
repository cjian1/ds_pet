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

/**
 * 跟不跟随最新消息：默认跟；用户自己往上滚了就停跟，滚回底部再恢复。
 *
 * 不能用「够近才贴」（拿 nearBottom 当闸门）那套：开面板时图片还没撑开，第一次贴底算的是**旧高度**，
 * 等图片陆续加载把内容撑高，后面的贴底全被闸门挡掉 —— 面板就停在最新消息上方（实测长记录差 ~700px）。
 * 换成这个状态后，内容每长高一次就重新贴到底，直到收敛。
 */
let pinnedToBottom = true;

function toBottom(force) {
  if (force) pinnedToBottom = true;
  if (!pinnedToBottom) return;
  // 必须用 instant：CSS 里的 scroll-behavior:smooth 会让赋值产生一串中间位置，
  // 期间的 scroll 事件会被当成「用户滚上去了」，贴底反而把自己取消掉。
  els.scroll.scrollTo({ top: els.scroll.scrollHeight, behavior: 'instant' });
}

// 只有「用户自己在滚」才停跟。用两个不会误判的信号：
//   · 明确的滚动手势：滚轮 / 触摸；
//   · scrollTop 明显往回退 —— 自己的贴底只会把它往下推，图片把内容撑高也不会让它变小，
//     所以「先变大、又变小」只能是用户在往回翻（也覆盖拖滚动条、键盘翻页）。
// 不能直接拿「scroll 事件 + 够不够近」判断：程序化贴底同样触发 scroll，而图片可能在那之前就把
// 内容撑高，那一刻算出「不够近」就把贴底自己取消了 —— 面板停在历史中间那个 bug 的成因。
let lastScrollTop = 0;
els.scroll.addEventListener('wheel', () => { pinnedToBottom = false; }, { passive: true });
els.scroll.addEventListener('touchstart', () => { pinnedToBottom = false; }, { passive: true });
els.scroll.addEventListener('scroll', () => {
  const top = els.scroll.scrollTop;
  if (top < lastScrollTop - 4) pinnedToBottom = false; // 往回翻了 → 停跟
  else if (nearBottom()) pinnedToBottom = true; // 滚回底部 → 恢复跟
  lastScrollTop = top;
});

/**
 * 同一帧内的多次「贴底」只做一次。
 *
 * 每张图加载完都会让列表重新布局，而 nearBottom() 要读 scrollHeight（强制同步布局）。
 * 长记录开面板时几十张图接踵加载，逐张调用就是几十次强制布局 —— 实测这比图片解码本身贵得多。
 * 合并到帧上：视觉一样（最多晚一帧贴底），布局只算一次。
 */
let bottomRaf = null;
function scheduleBottom() {
  if (bottomRaf !== null) return;
  bottomRaf = requestAnimationFrame(() => {
    bottomRaf = null;
    toBottom();
  });
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
    // 长记录开面板时，历史里的表情包原本会一次性全部解码（实测 40 张 → 约 0.9 CPU 秒）。
    // 只有滚到眼前的才解码；解码本身也挪到主线程外，别卡住输入。
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('load', () => scheduleBottom());
    bubble.appendChild(img);
  }
  const span = document.createElement('span');
  span.className = 'text';
  span.textContent = text || '';
  bubble.appendChild(span);
  row.appendChild(bubble);
  els.list.appendChild(row);
  updateEmpty();
  // deferBottom：批量灌历史时不要每条都贴底 —— toBottom 要读 scrollHeight（强制同步布局），
  // 80 条就是 80 次越来越大的强制布局。renderHistory 最后统一贴一次底。
  if (!opts.deferBottom) toBottom(opts.force);
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
    addMessage(m.role, m.content, image, { ts: m.ts, deferBottom: true });
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
  cancelStreamPaint();
  setBusy(false);
  if (!cur || cur.id !== id) return;
  // 请求结束就先收掉「正在输入」：三种结局（回复 / 中止 / 失败）都要收，
  // 尤其「正文已到但这帧还没画」时 span 还不在 DOM 里，光设 textContent 三个点会一直闪下去
  settleTyping(cur);
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

/**
 * 把「正在输入」的三个点收掉、换成正文。
 *
 * 那三个点是 `animation: blink … infinite` —— 无限动画，留在页面上就一直转。
 * 收口要覆盖所有结局（回复 / 中止 / 失败）；而且「正文已到、但那一帧还没画出来」时
 * span 还不在 DOM 里，光给它设 textContent 是看不见的，三个点就永远留在那儿闪。
 */
function settleTyping(cur) {
  const m = cur && cur.msg;
  if (!m || !m.dots) return;
  m.dots.remove();
  m.dots = null;
  if (!m.span.isConnected) m.bubble.appendChild(m.span);
  m.span.textContent = cur.text || '';
}

function finishReply(cur, reply, image) {
  const m = cur.msg;
  if (m.dots) settleTyping(cur);
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

// 流式正文按帧合并再写 DOM：每来一个 delta 都改文本 + toBottom()（读 scrollHeight）会触发强制回滚，
// 快模型下一个 token 一次，肉眼看着是「抖」；攒到下一帧只写一次，既省 CPU 也更顺。
let streamRaf = null;
function cancelStreamPaint() {
  if (streamRaf !== null) {
    cancelAnimationFrame(streamRaf);
    streamRaf = null;
  }
}
function paintStream() {
  streamRaf = null;
  const cur = current;
  if (!cur) return;
  const m = cur.msg;
  if (m.dots) {
    m.dots.remove();
    m.dots = null;
    m.bubble.appendChild(m.span);
    setStatus(tr('chat.typing'));
  }
  m.span.textContent = cur.text;
  toBottom();
}

api.onStream((ev) => {
  if (!current || ev.id !== current.id) return;
  if (ev.type === 'thinking') setStatus(tr('chat.thinking'));
  if (ev.type === 'delta') {
    current.text += ev.text;
    if (streamRaf === null) streamRaf = requestAnimationFrame(paintStream);
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
