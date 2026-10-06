'use strict';
require('./helpers/electron-stub');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { store, petConfig, settingsFile, memoryFile } = require('../desktop/main/store');
const llm = require('../desktop/main/llm');

const { openaiPayload, anthropicPayload, splitImageTag, url, errorFrom, postCompletion, memePool, imageInstruction } =
  llm._internal;

// ---------------------------------------------------------------- 假网络
let calls = [];
let replies = [];
global.fetch = async (target, init = {}) => {
  const call = {
    url: String(target),
    method: init.method || 'GET',
    headers: init.headers || {},
    body: init.body ? JSON.parse(init.body) : null,
  };
  calls.push(call);
  const reply = replies.shift();
  if (!reply) throw new Error('没预料到的请求：' + call.url);
  return reply(call, init);
};
const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
/** SSE 应答；故意把每个事件从中间劈成两块送出，检验跨块拼行 */
const sse = (events) =>
  new Response(
    new ReadableStream({
      start(c) {
        const enc = new TextEncoder();
        for (const e of events) {
          const line = 'data: ' + (typeof e === 'string' ? e : JSON.stringify(e)) + '\n\n';
          const mid = Math.floor(line.length / 2);
          c.enqueue(enc.encode(line.slice(0, mid)));
          c.enqueue(enc.encode(line.slice(mid)));
        }
        c.close();
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
const oaDelta = (content, extra = {}) => ({ choices: [{ delta: { content }, ...extra }] });

beforeEach(() => {
  calls = [];
  replies = [];
  fs.rmSync(settingsFile(), { force: true });
  fs.rmSync(memoryFile(), { force: true });
  store.load();
  llm.resetCaches();
});

const provider = (id, fields = {}) => {
  store.update({ ai: { provider: id, providers: { [id]: Object.assign({ apiKey: 'sk-test' }, fields) } } });
  return store.provider(id);
};

// ---------------------------------------------------------------- 请求体
test('接口地址：OpenAI 兼容走 /chat/completions；Anthropic 地址带不带 /v1 都认', () => {
  assert.equal(url({ type: 'openai', baseUrl: 'https://api.deepseek.com' }, 'chat'), 'https://api.deepseek.com/chat/completions');
  assert.equal(url({ type: 'openai', baseUrl: 'https://x/v1' }, 'models'), 'https://x/v1/models');
  assert.equal(url({ type: 'anthropic', baseUrl: 'https://api.anthropic.com' }, 'chat'), 'https://api.anthropic.com/v1/messages');
  assert.equal(url({ type: 'anthropic', baseUrl: 'https://proxy/v1' }, 'models'), 'https://proxy/v1/models');
});

test('OpenAI 兼容请求体：system 在最前、图片放进最后一条、思考深度按服务商映射', () => {
  const p = provider('openai', { model: 'o-test-1' });
  const body = openaiPayload(p, {
    system: '人设',
    messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '在呢' },
      { role: 'user', content: '看图' },
    ],
    images: ['data:image/jpeg;base64,AAAA'],
    temperature: 1,
    maxTokens: 100,
    effort: 'max',
    stream: true,
  });
  assert.deepEqual(body.messages[0], { role: 'system', content: '人设' });
  assert.deepEqual(body.messages[3].content, [
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,AAAA' } },
    { type: 'text', text: '看图' },
  ]);
  assert.equal(body.reasoning_effort, 'high', 'OpenAI 的「深思」= high');
  assert.equal(body.max_tokens, 100);
  assert.equal(body.stream, true);

  const noEffort = openaiPayload(provider('anthropic'), { messages: [], temperature: 1, maxTokens: 1, effort: 'max' });
  assert.equal('reasoning_effort' in noEffort, false, '不支持思考深度的服务商不发这个参数');
});

test('Anthropic 请求体：system 单独放、user 开头、同角色合并、图片转 base64 块、温度不超过 1', () => {
  const p = provider('anthropic');
  const body = anthropicPayload(p, {
    system: '人设',
    messages: [
      { role: 'assistant', content: '（她先开的口）' },
      { role: 'user', content: '一' },
      { role: 'user', content: '二' },
      { role: 'assistant', content: '好' },
      { role: 'user', content: '看' },
    ],
    images: ['data:image/png;base64,QUJD', 'not-a-data-url'],
    temperature: 1.3,
    maxTokens: 50,
  });
  assert.equal(body.system, '人设');
  assert.equal(body.temperature, 1);
  assert.deepEqual(
    body.messages.map((m) => m.role),
    ['user', 'assistant', 'user'],
  );
  assert.equal(body.messages[0].content[0].text, '一\n\n二');
  assert.deepEqual(body.messages[2].content, [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'QUJD' } },
    { type: 'text', text: '看' },
  ]);
});

test('[图:名称] 标记：认识的表情包才拆出来', () => {
  const pool = [{ name: '可爱', desc: '卖萌' }];
  assert.deepEqual(splitImageTag('早上好呀 [图：可爱]', pool), { body: '早上好呀', image: '可爱' });
  assert.deepEqual(splitImageTag('早上好呀 [图:不存在]', pool), { body: '早上好呀 [图:不存在]', image: null });
  assert.deepEqual(splitImageTag('[图:可爱]', pool), { body: '[图:可爱]', image: null }, '只有标记没有正文：原样留着');
});

// ---------------------------------------------------------------- 错误与降级重试
test('错误报文：Key 错（含 Gemini 那种 400）只给一句话；其它错误附上服务商原话', async () => {
  const e1 = await errorFrom(json({ error: { message: 'API key not valid. Please pass a valid API key.' } }, 400));
  assert.equal(e1.reason, 'auth');
  assert.equal(e1.status, 401);
  assert.equal(e1.message, store.t('err.401'));
  const e2 = await errorFrom(json({ error: { message: 'model overloaded' } }, 503));
  assert.equal(e2.reason, 'http');
  assert.match(e2.message, /model overloaded$/);
  const e3 = await errorFrom(new Response('<html>bad gateway</html>', { status: 502 }));
  assert.match(e3.message, /502/);
});

test('模型不认 reasoning_effort：去掉重发，并记住以后不再发', async () => {
  const p = provider('deepseek', { model: 'm-no-effort' });
  const o = { messages: [{ role: 'user', content: 'hi' }], temperature: 1, maxTokens: 10, timeoutMs: 5000, effort: 'high' };
  replies.push(
    () => json({ error: { message: 'Unrecognized request argument supplied: reasoning_effort' } }, 400),
    () => json({ choices: [{ message: { content: 'ok' } }] }),
    () => json({ choices: [{ message: { content: 'ok' } }] }),
  );
  await postCompletion(p, o);
  assert.equal(calls[0].body.reasoning_effort, 'high');
  assert.equal('reasoning_effort' in calls[1].body, false);
  await postCompletion(p, o);
  assert.equal(calls.length, 3, '第二次直接不带参数，一次就成');
  assert.equal('reasoning_effort' in calls[2].body, false);
});

test('模型要 max_completion_tokens：换参数名重发', async () => {
  const p = provider('openai', { model: 'm-new-tokens' });
  const o = { messages: [{ role: 'user', content: 'hi' }], temperature: 1, maxTokens: 10, timeoutMs: 5000 };
  replies.push(
    () => json({ error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead." } }, 400),
    () => json({ choices: [{ message: { content: 'ok' } }] }),
  );
  await postCompletion(p, o);
  assert.equal(calls[1].body.max_completion_tokens, 10);
  assert.equal('max_tokens' in calls[1].body, false);
});

test('带图请求被拒（模型不能看图）：给出明确的 no-vision 错误', async () => {
  const p = provider('openai', { model: 'm-text-only' });
  replies.push(() => json({ error: { message: 'This model does not support image input' } }, 400));
  await assert.rejects(
    postCompletion(p, { messages: [{ role: 'user', content: 'x' }], images: ['data:image/png;base64,AA'], temperature: 1, maxTokens: 5 }),
    (e) => e.reason === 'no-vision',
  );
});

// ---------------------------------------------------------------- 对话（流式）
test('对话（OpenAI 兼容流式）：逐段吐字，结尾的 [图:…] 不会闪出来，回复和记录都对', async () => {
  provider('deepseek');
  const cfg = petConfig().main;
  replies.push(() => sse([oaDelta('你好呀'), oaDelta('主人～'), oaDelta(' [图'), oaDelta(':可'), oaDelta('爱]'), '[DONE]']));
  const pieces = [];
  const res = await llm.chat(cfg, cfg.pets[0], { text: '在吗' }, { onDelta: (p) => pieces.push(p) });

  assert.equal(res.reply, '你好呀主人～');
  assert.equal(res.image, '可爱');
  assert.ok(!pieces.join('').includes('['), '界面上不该出现半截标记：' + pieces.join('|'));
  assert.equal(pieces.join('').trim(), '你好呀主人～');

  const sent = calls[0];
  assert.equal(sent.url, 'https://api.deepseek.com/chat/completions');
  assert.equal(sent.headers.Authorization, 'Bearer sk-test');
  assert.equal(sent.body.stream, true);
  assert.match(sent.body.messages.at(-1).content, /^在吗/);
  assert.match(sent.body.messages.at(-1).content, /可爱/, '把表情包清单交给模型');

  const hist = llm.history('main');
  assert.deepEqual(
    hist.map((m) => [m.role, m.content, m.image || null]),
    [
      ['user', '在吗', null],
      ['assistant', '你好呀主人～', '可爱'],
    ],
  );
});

/**
 * 流到一半还没结束的 SSE：先吐一段，然后挂着不收尾。
 * fetch 的 signal 一中止，就像 undici 那样让正文读取报错（之前读到的字已经交出去了）。
 */
const hangingSse = (first, { signal, failWith } = {}) =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('data: ' + JSON.stringify(first) + '\n\n'));
        if (signal) signal.addEventListener('abort', () => c.error(signal.reason), { once: true });
        if (failWith) setTimeout(() => c.error(failWith), 5);
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );

test('对话：流到一半主人点了停止 → aborted（不是「回复失败」），已吐出的字保留，不写进记录', async () => {
  // 曾经的 bug：中途停止时 fetch 抛的是原始 AbortError，没有 reason，
  // 面板就当成失败、显示英文报错和「重试」按钮。
  provider('deepseek');
  const cfg = petConfig().main;
  const ac = new AbortController();
  replies.push((_call, init) => hangingSse(oaDelta('说到一半'), { signal: init.signal }));
  const pieces = [];
  const err = await llm
    .chat(cfg, cfg.pets[0], { text: '讲个长故事' }, {
      signal: ac.signal,
      onDelta: (p) => {
        pieces.push(p);
        ac.abort();
      },
    })
    .catch((e) => e);
  assert.ok(err instanceof llm.LlmError, '应归一成 LlmError：' + err);
  assert.equal(err.reason, 'aborted');
  assert.equal(pieces.join(''), '说到一半');
  assert.deepEqual(llm.history('main'), [], '没说完的话不进记录');
});

test('对话：流到一半超时 → 给一句「请求超时」，不把英文原始报错甩给用户', async () => {
  provider('deepseek');
  const cfg = petConfig().main;
  const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  replies.push(() => hangingSse(oaDelta('说到'), { failWith: timeout }));
  const err = await llm.chat(cfg, cfg.pets[0], { text: '在吗' }).catch((e) => e);
  assert.equal(err.reason, 'network');
  assert.equal(err.message, store.t('err.timeout'));
});

test('碎碎念：应答不是 JSON（网关报错页之类）→ 归成网络错误，不是 SyntaxError', async () => {
  provider('deepseek');
  const cfg = petConfig().main;
  replies.push(() => new Response('<html>502 Bad Gateway</html>', { status: 200 }));
  const err = await llm.whisper(cfg, cfg.pets[0], { force: true }).catch((e) => e);
  assert.ok(err instanceof llm.LlmError, '应归一成 LlmError：' + err);
  assert.equal(err.reason, 'network');
});

test('对话：带上最近 N 轮记忆', async () => {
  provider('deepseek');
  store.update({ ai: { memoryRounds: 1 } });
  const cfg = petConfig().main;
  for (const text of ['第一句', '第二句', '第三句']) {
    replies.push(() => sse([oaDelta('回' + text)]));
    await llm.chat(cfg, cfg.pets[0], { text });
  }
  const msgs = calls[2].body.messages.filter((m) => m.role !== 'system');
  assert.deepEqual(
    msgs.map((m) => m.content.split('\n')[0]),
    ['第二句', '回第二句', '第三句'],
  );
});

test('对话（Anthropic 流式）：x-api-key 鉴权，读 text_delta，忽略思考片段', async () => {
  provider('anthropic');
  const cfg = petConfig().main;
  let thinking = 0;
  replies.push(() =>
    sse([
      { type: 'message_start' },
      { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: '嗯…' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Hello' } },
      { type: 'content_block_delta', delta: { type: 'text_delta', text: ' there' } },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
      { type: 'message_stop' },
    ]),
  );
  const res = await llm.chat(cfg, cfg.pets[0], { text: 'hi' }, { onThinking: () => thinking++ });
  assert.equal(res.reply, 'Hello there');
  assert.equal(thinking, 1);
  const sent = calls[0];
  assert.equal(sent.url, 'https://api.anthropic.com/v1/messages');
  assert.equal(sent.headers['x-api-key'], 'sk-test');
  assert.equal(sent.headers['anthropic-version'], '2023-06-01');
  assert.equal('Authorization' in sent.headers, false);
  assert.equal(typeof sent.body.system, 'string');
});

test('思考把额度吃光（正文为空且被截断）：放大额度、非流式再来一次', async () => {
  provider('deepseek', { model: 'm-thinker' });
  const cfg = petConfig().main;
  replies.push(
    () => sse([{ choices: [{ delta: { reasoning_content: '想啊想' } }] }, { choices: [{ delta: {}, finish_reason: 'length' }] }]),
    () => json({ choices: [{ message: { content: '想好啦' }, finish_reason: 'stop' }] }),
  );
  const res = await llm.chat(cfg, cfg.pets[0], { text: '难题' });
  assert.equal(res.reply, '想好啦');
  assert.equal(calls[1].body.stream, false);
  assert.ok(calls[1].body.max_tokens > calls[0].body.max_tokens);
});

test('没配好服务商：直接报 provider-missing，不发请求', async () => {
  const cfg = petConfig().main;
  await assert.rejects(llm.chat(cfg, cfg.pets[0], { text: 'hi' }), (e) => e.reason === 'provider-missing');
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- 碎碎念 / 模型 / 测试 Key / 余额
test('碎碎念：非流式、固定低思考深度、去掉标记、配图随文本一起回来', async () => {
  provider('deepseek');
  const cfg = petConfig().main;
  replies.push(() => json({ choices: [{ message: { content: '今天也要元气满满 [图:Ciallo]' } }] }));
  const st = await llm.whisper(cfg, cfg.pets[0], { force: true });
  assert.equal(st.ok, true);
  assert.equal(st.text, '今天也要元气满满');
  assert.ok(typeof st.image === 'string' && st.image);
  assert.equal(calls[0].body.stream, false);
  assert.equal(calls[0].body.reasoning_effort, 'low');
});

test('模型清单：过滤掉向量 / 语音这类非聊天模型，认出能不能看图', async () => {
  provider('deepseek');
  replies.push(() =>
    json({
      data: [
        { id: 'deepseek-flash', input_modalities: ['text', 'image'], context_window: 131072 },
        { id: 'deepseek-text', input_modalities: ['text'] },
        { id: 'text-embedding-3' },
        { id: 'whisper-1' },
      ],
    }),
  );
  const list = await llm.listModels();
  assert.deepEqual(
    list.map((m) => [m.id, m.vision]),
    [
      ['deepseek-flash', true],
      ['deepseek-text', false],
    ],
  );
  assert.equal(list[0].context, 131072);
});

test('测试 Key：没有模型清单接口（404）时改发一句最短的对话', async () => {
  provider('doubao', { model: 'ep-123' });
  replies.push(
    () => json({ error: 'not found' }, 404),
    () => json({ choices: [{ message: { content: 'hi' } }] }),
  );
  const r = await llm.testKey({ id: 'doubao' });
  assert.deepEqual(r.models, []);
  assert.equal(calls[1].body.model, 'ep-123');
  assert.equal(calls[1].body.max_tokens, 16);
});

test('测试 Key：OpenRouter 的模型清单是公开的，先调 /key 校验', async () => {
  provider('openrouter');
  replies.push(
    () => json({ error: { message: 'No auth credentials found' } }, 401),
  );
  await assert.rejects(llm.testKey({ id: 'openrouter', apiKey: 'sk-bad' }), (e) => e.reason === 'auth');
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/key');
  assert.equal(calls[0].headers.Authorization, 'Bearer sk-bad', '用页面上还没保存的 Key 测');
});

test('余额：DeepSeek 优先报人民币；不支持的服务商直接说不支持', async () => {
  provider('deepseek');
  replies.push(() =>
    json({
      balance_infos: [
        { currency: 'USD', total_balance: '0.00' },
        { currency: 'CNY', total_balance: '12.34', granted_balance: '2', topped_up_balance: '10.34' },
      ],
    }),
  );
  const b = await llm.balance({ force: true });
  assert.equal(b.ok, true);
  assert.equal(b.data.currency, 'CNY');
  assert.equal(b.data.total, '12.34');

  provider('openai');
  const none = await llm.balance({ force: true });
  assert.equal(none.ok, false);
  assert.equal(none.reason, 'unsupported');
});

// ---------------------------------------------------------------- 表情包池缓存
test('表情包池：只留存在图片文件的条目，且进程内复用同一份（不再每条消息 fs.existsSync × N）', () => {
  const cfg = petConfig().main;
  const a = memePool(cfg);
  const b = memePool(cfg);
  assert.equal(a, b, '同一份缓存');
  assert.ok(a.length > 0, '包内应至少有一张可用表情包');
  for (const m of a) {
    assert.ok(m.desc, '每条都要有描述：' + m.name);
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'desktop', 'assets', 'memes', m.name + '.png')), m.name);
  }
  assert.equal(imageInstruction(a), imageInstruction(a), '配图说明也缓存');
  assert.ok(imageInstruction(a).includes(a[0].name), '说明里带上全部表情包名');
});
