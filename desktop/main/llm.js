'use strict';
/**
 * AI 调用：碎碎念 / 对话（流式）/ 看图 / 余额 / 模型清单。支持多家服务商（见 providers.js）：
 *   · OpenAI 兼容接口：DeepSeek、OpenAI、Gemini、Kimi、智谱、通义、硅基流动、豆包、OpenRouter、Ollama、自定义…
 *   · Anthropic Messages 接口：Claude，以及 Anthropic 兼容的自定义接口
 *
 * 人设、指令、配图约定与 dsh-pet 上游一致：
 *   · system = 人设（whisperPrompt）+ 名字声明；
 *   · 碎碎念：「随便说一句日常碎碎念，一句就好，20 字以内。」（带表情包时追加画面说明）；
 *   · 对话：带最近 N 轮记忆，回复结尾可写 [图:名称] 挑一张表情包。
 *
 * 推理模型（DeepSeek 等）会先输出思考再输出正文，两者共享 max_tokens：额度给小了就会「思考吃光额度 →
 * 正文为空」，表现为她突然不说话。所以正文为空且被截断时自动放大额度重试一次。
 * 各家对参数的接受程度不一样，几种常见的不兼容会自动降级重试：
 *   · 模型不认 reasoning_effort（思考深度）→ 去掉这个参数，并记住这个模型以后都不发；
 *   · 模型要求 max_completion_tokens 而不是 max_tokens（OpenAI 新模型）→ 换参数名。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { nativeImage } = require('electron');
const { store, ASSETS, memoryFile, uploadsDir, readJson, writeJsonAtomic } = require('./store');
const Providers = require('./providers');

const UA = 'ds_pet/1.1 (macOS desktop pet)';
const ANTHROPIC_VERSION = '2023-06-01';
const t = (key, vars) => store.t(key, vars);
const IMG_TAG = /\[图[:：]\s*([^\]\n]+?)\s*\]\s*$/;
/** 存多少条聊天记录用于显示（送给模型的只取最近 memoryRounds 轮） */
const HISTORY_KEEP = 200;
/** 模型列表里明显不是聊天模型的（向量、语音、画图…），不列出来 */
const NON_CHAT = /embed|tts|whisper|dall-e|audio|realtime|moderation|transcri|speech|rerank|image-gen|^gpt-image|davinci|babbage/i;

class LlmError extends Error {
  constructor(reason, message, status) {
    super(message);
    this.reason = reason;
    this.status = status || 0;
  }
}

/** 本次运行里已知不认 reasoning_effort / max_tokens 的模型（按 服务商+模型 记） */
const noEffort = new Set();
const useCompletionTokens = new Set();

// ---------------------------------------------------------------- 服务商与 HTTP
/** 当前服务商配置；override 用于「还没保存就先测试」 */
function resolve(override) {
  const base = store.provider(override && override.id);
  if (!override) return base;
  const p = Object.assign({}, base);
  if (override.apiKey) p.apiKey = String(override.apiKey).trim();
  if (override.baseUrl) p.baseUrl = Providers.cleanBaseUrl(override.baseUrl) || p.baseUrl;
  if (override.model) p.model = String(override.model).trim();
  if (override.type && p.custom) p.type = override.type;
  return p;
}

function ensureReady(p, { needModel = true } = {}) {
  if (!p.baseUrl) throw new LlmError('provider-missing', t('err.noBaseUrl'));
  if (!p.apiKey && !p.noKey && !p.custom) throw new LlmError('provider-missing', t('err.noKey'));
  if (needModel && !p.model) throw new LlmError('provider-missing', t('err.noModel'));
}

function headers(p, json) {
  const h = { Accept: 'application/json', 'User-Agent': UA };
  if (json) h['Content-Type'] = 'application/json';
  if (p.type === 'anthropic') {
    if (p.apiKey) h['x-api-key'] = p.apiKey;
    h['anthropic-version'] = ANTHROPIC_VERSION;
  } else if (p.apiKey) {
    h.Authorization = 'Bearer ' + p.apiKey;
  }
  if (p.id === 'openrouter') {
    h['HTTP-Referer'] = 'https://github.com/cjian1/ds_pet';
    h['X-Title'] = 'ds_pet';
  }
  return h;
}

/** Anthropic 的地址可能写成 https://api.anthropic.com 或 …/v1，两种都认 */
function url(p, kind) {
  if (p.type === 'anthropic') {
    const root = /\/v1$/.test(p.baseUrl) ? p.baseUrl : p.baseUrl + '/v1';
    return root + (kind === 'models' ? '/models' : '/messages');
  }
  return p.baseUrl + (kind === 'models' ? '/models' : '/chat/completions');
}

function httpHint(status) {
  return [400, 401, 402, 403, 404, 429, 500, 503].includes(status) ? t('err.' + status) : t('err.http', { code: status });
}

/** 从各家五花八门的错误报文里抠出一句话 */
function errorDetail(j) {
  if (!j) return '';
  if (typeof j.error === 'string') return j.error;
  if (j.error && j.error.message) return String(j.error.message);
  if (j.message) return String(j.message);
  if (j.msg) return String(j.msg);
  return '';
}

async function errorFrom(res) {
  let detail = '';
  try {
    const text = await res.text();
    try {
      detail = errorDetail(JSON.parse(text));
    } catch {
      detail = text.slice(0, 160);
    }
  } catch {
    /* 读不出报文 */
  }
  // 有的服务商（如 Gemini）Key 错时回 400 而不是 401
  const status = res.status === 400 && /api[ _-]?key/i.test(detail) ? 401 : res.status;
  const hint = httpHint(status);
  // Key 错 / 没钱：一句话说清楚，不附原始报文
  if (status === 401 || status === 402) return new LlmError(status === 401 ? 'auth' : 'http', hint, status);
  const e = new LlmError('http', hint + (detail ? '：' + detail.slice(0, 160) : ''), res.status);
  e.detail = detail;
  return e;
}

async function send(p, target, { method = 'GET', body, timeoutMs = 20000, signal } = {}) {
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (signal) signals.push(signal);
  let res;
  try {
    res = await fetch(target, {
      method,
      headers: headers(p, !!body),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.any(signals),
    });
  } catch (e) {
    if (signal && signal.aborted) throw new LlmError('aborted', t('err.aborted'));
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    const cause = e && e.cause && (e.cause.code || e.cause.message);
    throw new LlmError(
      'network',
      timeout ? t('err.timeout') : t('err.network', { name: p.name, msg: cause || (e && e.message) }),
    );
  }
  if (!res.ok) throw await errorFrom(res);
  return res;
}

// ---------------------------------------------------------------- 模型清单
let modelsCache = { at: 0, sig: '', data: [] };

/**
 * 拉模型清单：[{id, name, vision, efforts, context}]。
 * vision 只有带 input_modalities 的服务商（DeepSeek）才知道；其它为 undefined（不确定）。
 */
async function listModels({ force = false, override } = {}) {
  const p = resolve(override);
  ensureReady(p, { needModel: false });
  const sig = [p.id, p.type, p.baseUrl, p.apiKey].join('|');
  if (!force && modelsCache.sig === sig && modelsCache.data.length && Date.now() - modelsCache.at < 10 * 60 * 1000) {
    return modelsCache.data;
  }
  const body = await (await send(p, url(p, 'models'), { timeoutMs: 15000 })).json();
  const raw = Array.isArray(body && body.data) ? body.data : Array.isArray(body && body.models) ? body.models : [];
  const data = raw
    .filter((m) => m && typeof m === 'object' && (m.id || m.name))
    .map((m) => {
      const id = String(m.id || m.name).replace(/^models\//, '');
      const modalities = (m.input_modalities || (m.architecture && m.architecture.input_modalities)) || null;
      return {
        id,
        name: String(m.display_name || (m.name && m.name !== m.id ? m.name : '') || id).replace(/^models\//, ''),
        vision: Array.isArray(modalities) ? modalities.includes('image') : undefined,
        efforts: (m.effort && m.effort.supported_levels) || [],
        context: Number(m.context_window || m.context_length || 0) || 0,
      };
    })
    .filter((m) => !NON_CHAT.test(m.id))
    .sort((a, b) => a.id.localeCompare(b.id));
  modelsCache = { at: Date.now(), sig, data };
  return data;
}

/** 看图用哪个模型：清单里知道能力的（DeepSeek），当前模型不能看图就借一个能看的；不知道能力的照原模型试 */
async function visionModel(p) {
  if (!p.modalities) return p.model;
  try {
    const list = await listModels();
    const cur = list.find((m) => m.id === p.model);
    if (!cur || cur.vision !== false) return p.model;
    const alt = list.find((m) => m.vision === true);
    if (!alt) throw new LlmError('no-vision', t('err.noVision'));
    return alt.id;
  } catch (e) {
    if (e.reason === 'no-vision') throw e;
    return p.model;
  }
}

// ---------------------------------------------------------------- 余额（目前只有 DeepSeek 有公开接口）
let balanceCache = { at: 0, payload: null, sig: '' };

async function deepseekBalance(p) {
  const raw = await (await send(p, p.baseUrl + '/user/balance', { timeoutMs: 12000 })).json();
  const infos = (Array.isArray(raw && raw.balance_infos) ? raw.balance_infos : []).filter((i) => i && typeof i === 'object');
  // 接口会同时返回 CNY / USD，顺序不保证：明确优先人民币，避免把 USD 的 0 当成余额
  return (
    infos.find((i) => String(i.currency || '').toUpperCase() === 'CNY') ||
    infos.find((i) => Number(i.total_balance) > 0) ||
    infos[0] ||
    {}
  );
}

/** 返回 dsh-pet 渲染端约定的形状（见上游 fetchBalanceState） */
async function balance({ force = false } = {}) {
  const p = resolve();
  if (!p.balance) return { ok: false, provider: p.id, reason: 'unsupported', message: '' };
  const sig = p.apiKey + '|' + p.baseUrl;
  const ttl = balanceCache.payload && balanceCache.payload.ok ? 120000 : 30000;
  if (!force && balanceCache.payload && balanceCache.sig === sig && Date.now() - balanceCache.at < ttl) return balanceCache.payload;
  let payload;
  try {
    ensureReady(p, { needModel: false });
    const info = await deepseekBalance(p);
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
  balanceCache = { at: Date.now(), payload, sig };
  return payload;
}

// ---------------------------------------------------------------- 请求体
function effortValue(p, effort) {
  if (!p.effort || !effort || noEffort.has(p.id + '|' + p.model)) return null;
  return p.effort[effort] || null;
}

function dataUrlParts(u) {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(String(u || ''));
  return m ? { mediaType: m[1], data: m[2] } : null;
}

function openaiPayload(p, o) {
  const msgs = o.messages.map((m) => ({ role: m.role, content: m.content }));
  if (o.images && o.images.length && msgs.length) {
    const last = msgs[msgs.length - 1];
    const parts = o.images.map((u) => ({ type: 'image_url', image_url: { url: u } }));
    parts.push({ type: 'text', text: String(last.content || '') });
    msgs[msgs.length - 1] = { role: last.role, content: parts };
  }
  const payload = {
    model: p.model,
    messages: (o.system ? [{ role: 'system', content: o.system }] : []).concat(msgs),
    temperature: o.temperature,
    stream: !!o.stream,
  };
  if (useCompletionTokens.has(p.id + '|' + p.model)) payload.max_completion_tokens = o.maxTokens;
  else payload.max_tokens = o.maxTokens;
  const effort = effortValue(p, o.effort);
  if (effort) payload.reasoning_effort = effort;
  return payload;
}

/** Anthropic：system 单独放；消息必须 user 开头、两种角色交替（相邻同角色合并） */
function anthropicPayload(p, o) {
  const msgs = [];
  for (const m of o.messages) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const text = String(m.content || '');
    if (!msgs.length && role === 'assistant') continue;
    const prev = msgs[msgs.length - 1];
    if (prev && prev.role === role) prev.content[0].text += '\n\n' + text;
    else msgs.push({ role, content: [{ type: 'text', text }] });
  }
  if (o.images && o.images.length && msgs.length) {
    const last = msgs[msgs.length - 1];
    const imgs = o.images
      .map(dataUrlParts)
      .filter(Boolean)
      .map((d) => ({ type: 'image', source: { type: 'base64', media_type: d.mediaType, data: d.data } }));
    last.content = imgs.concat(last.content);
  }
  const payload = {
    model: p.model,
    max_tokens: o.maxTokens,
    temperature: Math.min(1, o.temperature),
    messages: msgs,
    stream: !!o.stream,
  };
  if (o.system) payload.system = o.system;
  return payload;
}

/** 发补全请求；遇到常见的参数不兼容自动改了重发一次 */
async function postCompletion(p, o, signal) {
  const build = () => (p.type === 'anthropic' ? anthropicPayload(p, o) : openaiPayload(p, o));
  const key = p.id + '|' + p.model;
  for (let attempt = 0; attempt < 3; attempt++) {
    const payload = build();
    try {
      return await send(p, url(p, 'chat'), { method: 'POST', body: payload, timeoutMs: o.timeoutMs, signal });
    } catch (e) {
      const d = String(e.detail || e.message || '');
      if (e.status === 400 && payload.reasoning_effort && /reasoning/i.test(d)) {
        noEffort.add(key);
        continue;
      }
      if (e.status === 400 && payload.max_tokens && /max_completion_tokens/i.test(d)) {
        useCompletionTokens.add(key);
        continue;
      }
      if (e.status >= 400 && e.status < 500 && o.images && o.images.length && /image|vision|multimodal|modalit/i.test(d)) {
        throw new LlmError('no-vision', t('err.imageUnsupported'), e.status);
      }
      throw e;
    }
  }
  throw new LlmError('http', t('err.400'));
}

function readNonStream(p, body) {
  if (p.type === 'anthropic') {
    const text = (Array.isArray(body.content) ? body.content : [])
      .filter((b) => b && b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    return { text, truncated: body.stop_reason === 'max_tokens' };
  }
  const choice = (body.choices || [])[0] || {};
  return { text: String((choice.message && choice.message.content) || '').trim(), truncated: choice.finish_reason === 'length' };
}

/** 非流式补全：返回正文 */
async function complete(opts) {
  const s = store.get();
  const p = resolve();
  ensureReady(p);
  if (opts.model) p.model = opts.model;
  const o = Object.assign({ temperature: 1.0, maxTokens: 1200, timeoutMs: 60000 }, opts);
  o.effort = o.effort === undefined ? s.ai.effort : o.effort;
  let r = readNonStream(p, await (await postCompletion(p, o)).json());
  if (!r.text && r.truncated && o.maxTokens < 4000) {
    o.maxTokens = Math.min(4000, Math.max(800, o.maxTokens * 4));
    r = readNonStream(p, await (await postCompletion(p, o)).json());
  }
  if (!r.text) throw new LlmError('generate-error', t('err.noText'));
  return r.text;
}

/** 读 SSE：逐行回调 data 的 JSON */
async function readSse(res, onJson) {
  const decoder = new TextDecoder();
  let buf = '';
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk, { stream: true });
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let json;
      try {
        json = JSON.parse(data);
      } catch {
        continue;
      }
      onJson(json);
    }
  }
}

/** 流式补全：onDelta(正文片段)；返回完整正文。思考阶段只回调 onThinking() 一次。 */
async function completeStream(opts, { onDelta, onThinking, signal } = {}) {
  const s = store.get();
  const p = resolve();
  ensureReady(p);
  if (opts.model) p.model = opts.model;
  const o = Object.assign({ temperature: 1.0, maxTokens: 1500, timeoutMs: 120000 }, opts, { stream: true });
  o.effort = o.effort === undefined ? s.ai.effort : o.effort;
  const res = await postCompletion(p, o, signal);
  let out = '';
  let truncated = false;
  let thinkingSeen = false;
  const thinking = () => {
    if (thinkingSeen) return;
    thinkingSeen = true;
    if (onThinking) onThinking();
  };
  const text = (piece) => {
    if (!piece) return;
    out += piece;
    if (onDelta) onDelta(piece);
  };
  await readSse(res, (json) => {
    if (p.type === 'anthropic') {
      if (json.type === 'error') throw new LlmError('http', errorDetail(json) || t('err.500'));
      if (json.type === 'content_block_delta' && json.delta) {
        if (json.delta.type === 'text_delta') text(json.delta.text);
        else if (json.delta.type === 'thinking_delta') thinking();
      }
      if (json.type === 'message_delta' && json.delta && json.delta.stop_reason === 'max_tokens') truncated = true;
      return;
    }
    if (json.error) throw new LlmError('http', errorDetail(json) || t('err.500'));
    for (const ch of json.choices || []) {
      const d = ch.delta || {};
      if (d.reasoning_content || d.reasoning) thinking();
      text(d.content);
      if (ch.finish_reason === 'length') truncated = true;
    }
  });
  out = out.trim();
  if (!out && truncated) {
    // 思考把额度吃光了：放大额度、非流式再来一次
    return complete(Object.assign({}, opts, { maxTokens: Math.min(4000, o.maxTokens * 3) }));
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
  // 碎碎念是一句话：固定走低思考深度，又快又省
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
  const p = resolve();
  ensureReady(p);
  let userText = String(text || '').trim();
  let uploaded = null;
  if (image) uploaded = prepareImage(image);
  if (!userText && uploaded) userText = t('prompt.imageAsk');
  if (!userText) throw new LlmError('bad-request', t('err.emptyMsg'));
  if (userText.length > 4000) throw new LlmError('bad-request', t('err.tooLong'));

  const model = uploaded ? await visionModel(p) : p.model;

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

/**
 * 验证配置（设置页「测试」/「保存」）：先拉模型清单；服务商不提供清单接口（404/405）时，
 * 改发一句最短的对话确认能通。DeepSeek 顺便查一下余额。
 */
async function testKey(override) {
  const p = resolve(override);
  ensureReady(p, { needModel: false });
  if (p.keyCheck) await send(p, p.baseUrl + p.keyCheck, { timeoutMs: 15000 });
  let models = [];
  try {
    models = await listModels({ force: true, override });
  } catch (e) {
    if (![404, 405, 501].includes(e.status)) throw e;
    if (!p.model) throw new LlmError('provider-missing', t('err.noModel'));
    const probe = Object.assign({}, p);
    const o = { messages: [{ role: 'user', content: 'hi' }], temperature: 0.2, maxTokens: 16, timeoutMs: 30000, stream: false };
    await postCompletion(probe, o);
  }
  let bal = null;
  if (p.balance) {
    try {
      const info = await deepseekBalance(p);
      if (info && info.currency) bal = { currency: info.currency, total: info.total_balance };
    } catch {
      /* 余额拿不到不影响 Key 有效性 */
    }
  }
  return { models, balance: bal };
}

function resetCaches() {
  modelsCache = { at: 0, sig: '', data: [] };
  balanceCache = { at: 0, payload: null, sig: '' };
  whisperCache = null;
}

module.exports = {
  LlmError,
  listModels,
  balance,
  whisper,
  chat,
  history,
  clearHistory,
  testKey,
  resetCaches,
  petSystemPrompt,
};
