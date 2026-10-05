'use strict';
/**
 * DeepSeek 直连：碎碎念 / 对话（流式）/ 看图 / 余额 / 模型清单。
 *
 * 人设、指令、配图约定与 dsh-pet 上游一致：
 *   · system = 人设（whisperPrompt）+ 名字声明；
 *   · 碎碎念：「随便说一句日常碎碎念，一句就好，20 字以内。」（带表情包时追加画面说明）；
 *   · 对话：带最近 N 轮记忆，回复结尾可写 [图:名称] 挑一张表情包。
 *
 * 这一代 DeepSeek 模型会先输出 reasoning_content（思考）再输出 content（正文），两者共享 max_tokens：
 * 额度给小了就会「思考吃光额度 → 正文为空」，表现为她突然不说话。所以正文为空且被截断时自动放大额度重试一次。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { nativeImage } = require('electron');
const { store, ASSETS, memoryFile, uploadsDir, readJson, writeJsonAtomic } = require('./store');

const API_BASE = (process.env.DEEPSEEK_API_BASE || 'https://api.deepseek.com').replace(/\/+$/, '');
const UA = 'ds_pet/1.0 (macOS desktop pet)';
const t = (key, vars) => store.t(key, vars);
const IMG_TAG = /\[图[:：]\s*([^\]\n]+?)\s*\]\s*$/;
/** 存多少条聊天记录用于显示（送给模型的只取最近 memoryRounds 轮） */
const HISTORY_KEEP = 200;

class LlmError extends Error {
  constructor(reason, message) {
    super(message);
    this.reason = reason;
  }
}

// ---------------------------------------------------------------- HTTP
function authHeaders(key) {
  return {
    Authorization: 'Bearer ' + key,
    Accept: 'application/json',
    'User-Agent': UA,
  };
}

function httpHint(status) {
  const key = 'err.' + status;
  return [400, 401, 402, 429, 500, 503].includes(status) ? t(key) : t('err.http', { code: status });
}

/** 把失败的 HTTP 应答变成一句人话（Key 错 / 没钱时不附原始报文） */
async function errorFrom(res) {
  let detail = '';
  try {
    const j = await res.json();
    detail = String((j && j.error && j.error.message) || '');
  } catch {
    /* 应答不是 JSON */
  }
  const hint = httpHint(res.status);
  if (res.status === 401) return new LlmError('auth', hint);
  if (res.status === 402) return new LlmError('http', hint);
  return new LlmError('http', hint + (detail ? '：' + detail.slice(0, 120) : ''));
}

async function requestJson(url, { key, method = 'GET', body, timeoutMs = 20000 } = {}) {
  const k = key ?? store.apiKey();
  if (!k) throw new LlmError('provider-missing', t('err.noKey'));
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: Object.assign(authHeaders(k), body ? { 'Content-Type': 'application/json' } : {}),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new LlmError('network', timeout ? t('err.timeout') : t('err.network', { msg: e && e.message }));
  }
  if (!res.ok) throw await errorFrom(res);
  return res.json();
}

// ---------------------------------------------------------------- 模型清单
let modelsCache = { at: 0, key: '', data: [] };

async function listModels({ force = false, key } = {}) {
  const k = key ?? store.apiKey();
  if (!k) return [];
  if (!force && modelsCache.key === k && modelsCache.data.length && Date.now() - modelsCache.at < 10 * 60 * 1000) {
    return modelsCache.data;
  }
  const body = await requestJson(API_BASE + '/models', { key: k, timeoutMs: 15000 });
  const data = (Array.isArray(body && body.data) ? body.data : []).filter((m) => m && typeof m === 'object' && m.id);
  modelsCache = { at: Date.now(), key: k, data };
  return data;
}

function cachedModel(id) {
  return modelsCache.data.find((m) => m.id === id) || null;
}

function modelSupportsImages(id) {
  const m = cachedModel(id);
  return !!(m && Array.isArray(m.input_modalities) && m.input_modalities.includes('image'));
}

/** 找一个能看图的模型（当前模型不支持时临时借用） */
function visionModel(preferred) {
  if (modelSupportsImages(preferred)) return preferred;
  const m = modelsCache.data.find((x) => Array.isArray(x.input_modalities) && x.input_modalities.includes('image'));
  return m ? m.id : null;
}

// ---------------------------------------------------------------- 余额
let balanceCache = { at: 0, payload: null };

/** 返回 dsh-pet 渲染端约定的形状（见上游 fetchBalanceState） */
async function balance({ force = false } = {}) {
  const ttl = balanceCache.payload && balanceCache.payload.ok ? 120000 : 30000;
  if (!force && balanceCache.payload && Date.now() - balanceCache.at < ttl) return balanceCache.payload;
  let payload;
  try {
    const raw = await requestJson(API_BASE + '/user/balance', { timeoutMs: 12000 });
    const infos = (Array.isArray(raw && raw.balance_infos) ? raw.balance_infos : []).filter((i) => i && typeof i === 'object');
    // 接口会同时返回 CNY / USD，顺序不保证：明确优先人民币，避免把 USD 的 0 当成余额
    const info =
      infos.find((i) => String(i.currency || '').toUpperCase() === 'CNY') ||
      infos.find((i) => Number(i.total_balance) > 0) ||
      infos[0] ||
      {};
    payload = {
      ok: true,
      provider: 'deepseek-official',
      kind: 'deepseek',
      data: {
        currency: String(info.currency || 'CNY'),
        total: String(info.total_balance ?? '0'),
        granted: String(info.granted_balance ?? '0'),
        toppedUp: String(info.topped_up_balance ?? '0'),
      },
    };
  } catch (e) {
    payload = {
      ok: false,
      provider: 'deepseek-official',
      reason: e.reason === 'provider-missing' ? 'credential-missing' : 'fetch-error',
      message: e.message,
    };
  }
  balanceCache = { at: Date.now(), payload };
  return payload;
}

// ---------------------------------------------------------------- 补全
function imageContent(text, images) {
  const parts = images.map((url) => ({ type: 'image_url', image_url: { url } }));
  parts.push({ type: 'text', text: text || '' });
  return parts;
}

function buildPayload({ system, messages, images, model, effort, maxTokens, temperature, stream }) {
  const msgs = messages.map((m) => ({ role: m.role, content: m.content }));
  if (images && images.length && msgs.length) {
    const last = msgs[msgs.length - 1];
    msgs[msgs.length - 1] = { role: last.role, content: imageContent(String(last.content || ''), images) };
  }
  const payload = {
    model,
    messages: (system ? [{ role: 'system', content: system }] : []).concat(msgs),
    temperature,
    max_tokens: maxTokens,
    stream: !!stream,
  };
  if (effort) payload.reasoning_effort = effort;
  return payload;
}

async function postCompletion(payload, timeoutMs, signal) {
  const key = store.apiKey();
  if (!key) throw new LlmError('provider-missing', t('err.noKey'));
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let res;
  try {
    res = await fetch(API_BASE + '/chat/completions', {
      method: 'POST',
      headers: Object.assign(authHeaders(key), { 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload),
      signal: AbortSignal.any(signals),
    });
  } catch (e) {
    if (signal && signal.aborted) throw new LlmError('aborted', t('err.aborted'));
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new LlmError('network', timeout ? t('err.thinkTimeout') : t('err.network', { msg: e && e.message }));
  }
  if (!res.ok) throw await errorFrom(res);
  return res;
}

/** 非流式补全：返回正文 */
async function complete(opts) {
  const s = store.get();
  const o = Object.assign({ temperature: 1.0, maxTokens: 1200, timeoutMs: 60000 }, opts);
  o.model = o.model || s.ai.model;
  o.effort = o.effort === undefined ? s.ai.effort : o.effort;
  const payload = buildPayload(o);
  let body = await (await postCompletion(payload, o.timeoutMs)).json();
  let choice = (body.choices || [])[0] || {};
  let text = String((choice.message && choice.message.content) || '').trim();
  if (!text && choice.finish_reason === 'length' && o.maxTokens < 4000) {
    payload.max_tokens = Math.min(4000, Math.max(800, o.maxTokens * 4));
    body = await (await postCompletion(payload, o.timeoutMs)).json();
    choice = (body.choices || [])[0] || {};
    text = String((choice.message && choice.message.content) || '').trim();
  }
  if (!text) throw new LlmError('generate-error', t('err.noText'));
  return text;
}

/** 流式补全：onDelta(正文片段)；返回完整正文。思考阶段只回调 onThinking() 一次。 */
async function completeStream(opts, { onDelta, onThinking, signal } = {}) {
  const s = store.get();
  const o = Object.assign({ temperature: 1.0, maxTokens: 1500, timeoutMs: 120000 }, opts);
  o.model = o.model || s.ai.model;
  o.effort = o.effort === undefined ? s.ai.effort : o.effort;
  const payload = buildPayload(Object.assign({}, o, { stream: true }));
  const res = await postCompletion(payload, o.timeoutMs, signal);
  const decoder = new TextDecoder();
  let buf = '';
  let out = '';
  let finish = null;
  let thinkingSeen = false;
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      for (const ch of json.choices || []) {
        const d = ch.delta || {};
        if (d.reasoning_content && !thinkingSeen) {
          thinkingSeen = true;
          if (onThinking) onThinking();
        }
        if (d.content) {
          out += d.content;
          if (onDelta) onDelta(d.content);
        }
        if (ch.finish_reason) finish = ch.finish_reason;
      }
    }
  }
  out = out.trim();
  if (!out && finish === 'length') {
    // 思考把额度吃光了：放大额度、非流式再来一次
    return complete(Object.assign({}, o, { maxTokens: Math.min(4000, o.maxTokens * 3) }));
  }
  if (!out) throw new LlmError('generate-error', t('err.empty'));
  return out;
}

// ---------------------------------------------------------------- 人设与表情包
function petSystemPrompt(cfg, pet) {
  const lines = [
    String(cfg.whisperPrompt || '').trim(),
    t('prompt.nameLine', { name: String(pet.name || store.petName()) }),
    t('prompt.langLine'),
  ];
  return lines.filter(Boolean).join('\n');
}

function memePool(cfg) {
  const table = cfg && cfg.memes;
  if (!table || typeof table !== 'object') return [];
  const dir = path.join(ASSETS, 'memes');
  return Object.entries(table)
    .map(([name, desc]) => ({ name, desc: String(desc || '').trim() }))
    .filter((m) => m.name && m.desc && fs.existsSync(path.join(dir, m.name + '.png')))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function imageInstruction(pool) {
  return t('prompt.memes', { list: pool.map((m) => '- ' + m.name + '：' + m.desc).join('\n') });
}

function splitImageTag(text, pool) {
  const m = IMG_TAG.exec(text);
  if (!m) return { body: text, image: null };
  const hit = pool.find((x) => x.name === m[1].trim());
  const body = text.slice(0, m.index).trim();
  if (!hit || !body) return { body: text, image: null };
  return { body, image: hit.name };
}

// ---------------------------------------------------------------- 碎碎念
let whisperCache = null;

async function whisper(cfg, pet, { force = false } = {}) {
  const ttl = Math.max(30, Number((cfg.eventsRefreshSec || {}).whisper) || 300) * 1000 * 0.8;
  if (!force && whisperCache && Date.now() - whisperCache.at < ttl) return whisperCache.state;
  const pool = cfg.whisperImageEnabled ? memePool(cfg) : [];
  const meme = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  let userText = t('prompt.whisper');
  if (meme) userText += t('prompt.whisperMeme', { name: meme.name, desc: meme.desc });
  // 碎碎念是一句话：固定走低推理强度，又快又省
  const text = await complete({
    system: petSystemPrompt(cfg, pet),
    messages: [{ role: 'user', content: userText }],
    effort: 'low',
    maxTokens: 1200,
  });
  const state = { ok: true, text: text.replace(IMG_TAG, '').trim(), ts: Date.now() };
  if (meme) state.image = meme.name;
  whisperCache = { at: Date.now(), state };
  return state;
}

// ---------------------------------------------------------------- 聊天记录
function readMemory() {
  const data = readJson(memoryFile());
  return data && typeof data === 'object' ? data : {};
}

function history(petId = 'main') {
  const bucket = ((readMemory().main || {})[petId] || {}).messages;
  return Array.isArray(bucket) ? bucket.filter((m) => m && (m.role === 'user' || m.role === 'assistant')) : [];
}

function appendHistory(petId, turns) {
  const data = readMemory();
  data.main = data.main || {};
  const bucket = (data.main[petId] = data.main[petId] || {});
  const msgs = Array.isArray(bucket.messages) ? bucket.messages : [];
  bucket.messages = msgs.concat(turns).slice(-HISTORY_KEEP);
  bucket.updatedAt = Date.now();
  writeJsonAtomic(memoryFile(), data, 0o600);
}

function clearHistory(petId = 'main') {
  const data = readMemory();
  if (data.main && data.main[petId]) data.main[petId] = { messages: [], updatedAt: Date.now() };
  writeJsonAtomic(memoryFile(), data, 0o600);
}

// ---------------------------------------------------------------- 图片
/**
 * 主人递来的图：缩到长边 ≤ 1600 再转 JPEG（太大的截图会让请求又慢又贵），
 * 存一份到 uploads/（内容哈希命名）供聊天记录回显。返回 {dataUrl, name}。
 */
function prepareImage(dataUrl) {
  let img = nativeImage.createFromDataURL(String(dataUrl || ''));
  if (img.isEmpty()) throw new LlmError('bad-request', t('err.badImage'));
  const { width, height } = img.getSize();
  const longSide = Math.max(width, height);
  if (longSide > 1600) {
    const k = 1600 / longSide;
    img = img.resize({ width: Math.round(width * k), height: Math.round(height * k), quality: 'best' });
  }
  const jpeg = img.toJPEG(86);
  const name = 'upload-' + crypto.createHash('sha1').update(jpeg).digest('hex').slice(0, 16) + '.jpg';
  const dir = uploadsDir();
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, jpeg);
  return { dataUrl: 'data:image/jpeg;base64,' + jpeg.toString('base64'), name };
}

// ---------------------------------------------------------------- 对话
/**
 * 发一句话（可带图），流式回调正文。
 * 返回 {reply, image}；image = 她配的表情包名（或主人递来的图不再重复回显）。
 */
async function chat(cfg, pet, { text, image }, { onDelta, onThinking, signal } = {}) {
  const s = store.get();
  let userText = String(text || '').trim();
  let uploaded = null;
  if (image) uploaded = prepareImage(image);
  if (!userText && uploaded) userText = t('prompt.imageAsk');
  if (!userText) throw new LlmError('bad-request', t('err.emptyMsg'));
  if (userText.length > 4000) throw new LlmError('bad-request', t('err.tooLong'));

  let model = s.ai.model;
  if (uploaded) {
    try {
      await listModels();
    } catch {
      /* 拿不到清单就按当前模型试 */
    }
    const vm = visionModel(model);
    if (!vm) throw new LlmError('no-vision', t('err.noVision'));
    model = vm;
  }

  const rounds = s.ai.memoryRounds;
  const past = history(pet.id)
    .slice(-rounds * 2)
    .map((m) => ({ role: m.role, content: String(m.content || '') }));
  const pool = cfg.chatImageEnabled ? memePool(cfg) : [];
  const messages = past.concat([{ role: 'user', content: userText + (pool.length ? imageInstruction(pool) : '') }]);

  // 流式输出时把结尾的 [图:...] 标记（含还没写完的半截）藏起来，只把确定是正文的部分吐给界面
  const TAIL_TAG = /\[(?:图(?:[:：][^\]\n]*\]?\s*)?)?$/;
  let shown = '';
  let raw = '';
  const flush = () => {
    const visible = raw.replace(TAIL_TAG, '');
    if (visible.length > shown.length && visible.startsWith(shown)) {
      const piece = visible.slice(shown.length);
      shown = visible;
      if (onDelta) onDelta(piece);
    }
  };
  const full = await completeStream(
    {
      system: petSystemPrompt(cfg, pet),
      messages,
      images: uploaded ? [uploaded.dataUrl] : null,
      model,
    },
    {
      onThinking,
      signal,
      onDelta: (piece) => {
        raw += piece;
        flush();
      },
    },
  );
  const { body, image: meme } = splitImageTag(full, pool);
  const now = Date.now();
  const turns = [
    Object.assign({ role: 'user', content: String(text || '').trim() || t('chat.sharedImage'), ts: now }, uploaded ? { image: uploaded.name } : {}),
    Object.assign({ role: 'assistant', content: body, ts: Date.now() }, meme ? { image: meme } : {}),
  ];
  try {
    appendHistory(pet.id, turns);
  } catch {
    /* 记录写失败不影响本次回复 */
  }
  return { reply: body, image: meme || null, userImage: uploaded ? uploaded.name : null };
}

/** 验证一个 API Key（设置页「测试」按钮）：拉一次模型清单 + 余额 */
async function testKey(key) {
  const models = await listModels({ force: true, key });
  let bal = null;
  try {
    const raw = await requestJson(API_BASE + '/user/balance', { key, timeoutMs: 12000 });
    const infos = Array.isArray(raw && raw.balance_infos) ? raw.balance_infos : [];
    const info = infos.find((i) => String(i.currency || '').toUpperCase() === 'CNY') || infos[0];
    if (info) bal = { currency: info.currency, total: info.total_balance };
  } catch {
    /* 余额拿不到不影响 Key 有效性 */
  }
  return { models, balance: bal };
}

function resetCaches() {
  modelsCache = { at: 0, key: '', data: [] };
  balanceCache = { at: 0, payload: null };
  whisperCache = null;
}

module.exports = {
  LlmError,
  listModels,
  modelSupportsImages,
  balance,
  whisper,
  chat,
  history,
  clearHistory,
  testKey,
  resetCaches,
  petSystemPrompt,
};
