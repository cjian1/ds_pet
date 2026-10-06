'use strict';
const { userData, env } = require('./helpers/electron-stub');
const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { store, sanitize, DEFAULTS, petConfig, settingsFile, defaultPersona } = require('../desktop/main/store');

/** 每个用例从一份干净的设置开始 */
function reset(raw) {
  fs.rmSync(settingsFile(), { force: true });
  if (raw) fs.writeFileSync(settingsFile(), JSON.stringify(raw));
  store.load();
}

beforeEach(() => {
  delete process.env.DEEPSEEK_API_KEY;
  env.langs = ['zh-CN'];
  reset();
});

// ---------------------------------------------------------------- sanitize
test('空输入 = 默认设置', () => {
  assert.deepEqual(sanitize({}), DEFAULTS);
  assert.deepEqual(sanitize('garbage'), DEFAULTS);
});

test('越界值夹回范围，类型不对回默认', () => {
  const s = sanitize({
    pet: { size: 5000, throwPower: 9, liveliness: 'wild', corner: 'middle' },
    talk: { whisperIntervalSec: 5 },
    ai: { memoryRounds: 99, effort: 'ultra' },
  });
  assert.equal(s.pet.size, 900);
  assert.equal(s.pet.throwPower, 2);
  assert.equal(s.pet.liveliness, 'normal');
  assert.equal(s.pet.corner, 'bottom-right');
  assert.equal(s.talk.whisperIntervalSec, 60);
  assert.equal(s.ai.memoryRounds, 30);
  assert.equal(s.ai.effort, 'low');
  assert.equal(sanitize({ pet: { size: 'big' } }).pet.size, 420);
});

test('分组被写坏（null / 数字 / 数组）：整组回默认，不抛错', () => {
  const s = sanitize({ pet: null, talk: 5, ai: [], app: 'x' });
  assert.deepEqual(s, DEFAULTS);
  reset({ pet: null });
  assert.equal(store.get().pet.size, 420);
});

test('未知字段丢弃（顶层和分组里都是）', () => {
  const s = sanitize({ hacker: 1, pet: { evil: true, size: 300 }, app: { extra: 'x' } });
  assert.equal('hacker' in s, false);
  assert.equal('evil' in s.pet, false);
  assert.equal('extra' in s.app, false);
  assert.equal(s.pet.size, 300);
});

test('名字和某种语言的默认名一样 = 没改过名字（存成空）', () => {
  assert.equal(sanitize({ pet: { name: '蓝毛小女仆' } }).pet.name, '');
  assert.equal(sanitize({ pet: { name: 'Blue Maid' } }).pet.name, '');
  assert.equal(sanitize({ pet: { name: '  小鲸  ' } }).pet.name, '小鲸');
  assert.equal(sanitize({ pet: { name: 'x'.repeat(40) } }).pet.name.length, 24);
});

test('旧版 ai.apiKey / ai.model 搬进 providers.deepseek', () => {
  const s = sanitize({ ai: { apiKey: ' sk-old ', model: 'deepseek-chat' } });
  assert.equal('apiKey' in s.ai, false);
  assert.equal('model' in s.ai, false);
  assert.deepEqual(s.ai.providers.deepseek, { apiKey: 'sk-old', baseUrl: '', model: 'deepseek-chat' });
  // 已经有新格式的 Key 时不覆盖
  const s2 = sanitize({ ai: { apiKey: 'sk-old', providers: { deepseek: { apiKey: 'sk-new' } } } });
  assert.equal(s2.ai.providers.deepseek.apiKey, 'sk-new');
});

test('sanitize 不改动 DEFAULTS（旧版 Key 迁移曾把 Key 写进默认值，之后每次规整都会带上它）', () => {
  const before = JSON.stringify(DEFAULTS);
  sanitize({ ai: { apiKey: 'sk-leak' } });
  sanitize({ pet: { name: '  x  ', size: 9999 } });
  assert.equal(JSON.stringify(DEFAULTS), before);
  assert.deepEqual(sanitize({}).ai.providers, {});
});

test('服务商配置：未知服务商丢弃、地址规整、自定义接口带接口格式', () => {
  const s = sanitize({
    ai: {
      provider: 'nope',
      providers: {
        nope: { apiKey: 'x' },
        openai: { apiKey: 'k', baseUrl: 'https://proxy.example.com/v1/', model: ' gpt-4o ' },
        custom: { baseUrl: 'not a url', type: 'weird' },
      },
    },
  });
  assert.equal(s.ai.provider, 'deepseek');
  assert.deepEqual(Object.keys(s.ai.providers).sort(), ['custom', 'openai']);
  assert.deepEqual(s.ai.providers.openai, { apiKey: 'k', baseUrl: 'https://proxy.example.com/v1', model: 'gpt-4o' });
  assert.deepEqual(s.ai.providers.custom, { apiKey: '', baseUrl: '', model: '', type: 'openai' });
});

test('位置坐标不是数字就当没有', () => {
  assert.equal(sanitize({ position: { rx: 'a', ry: 1 } }).position, null);
  assert.deepEqual(sanitize({ position: { rx: 0.5, ry: 0.25 } }).position, { rx: 0.5, ry: 0.25 });
});

// ---------------------------------------------------------------- Store
test('首次启动：没有 settings.json', () => {
  assert.equal(store.firstRun, true);
  reset({ pet: { size: 300 } });
  assert.equal(store.firstRun, false);
  assert.equal(store.get().pet.size, 300);
});

test('update：合并、落盘（权限 600），值没变不发 change', () => {
  const events = [];
  const on = (next, prev) => events.push([prev.pet.size, next.pet.size]);
  store.on('change', on);
  try {
    store.update({ pet: { size: 333 } });
    store.update({ pet: { size: 333 } });
    store.update({ talk: { whisperEnabled: false } });
  } finally {
    store.off('change', on);
  }
  assert.deepEqual(events, [
    [420, 333],
    [333, 333],
  ]);
  const saved = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  assert.equal(saved.pet.size, 333);
  assert.equal(saved.talk.whisperEnabled, false);
  assert.equal(fs.statSync(settingsFile()).mode & 0o777, 0o600);
  assert.equal(path.dirname(settingsFile()), userData);
});

test('provider：用户填的优先，没填用默认；DEEPSEEK_API_KEY 只覆盖 DeepSeek', () => {
  let p = store.provider('openai');
  assert.equal(p.baseUrl, 'https://api.openai.com/v1');
  assert.equal(p.model, 'gpt-4o-mini');
  store.update({ ai: { providers: { openai: { apiKey: 'sk-o', model: 'gpt-4.1' } } } });
  p = store.provider('openai');
  assert.equal(p.apiKey, 'sk-o');
  assert.equal(p.model, 'gpt-4.1');

  process.env.DEEPSEEK_API_KEY = 'sk-env';
  assert.equal(store.provider('deepseek').apiKey, 'sk-env');
  assert.equal(store.provider('deepseek').keyFromEnv, true);
  assert.equal(store.provider('openai').apiKey, 'sk-o');
});

test('hasApiKey：要有地址和模型；本地模型不要 Key；自定义接口 Key 可选', () => {
  assert.equal(store.hasApiKey(), false); // DeepSeek 没 Key
  store.update({ ai: { providers: { deepseek: { apiKey: 'sk' } } } });
  assert.equal(store.hasApiKey(), true);

  store.update({ ai: { provider: 'ollama' } });
  assert.equal(store.hasApiKey(), false, 'Ollama 默认没有模型');
  store.update({ ai: { providers: { ollama: { model: 'qwen3' } } } });
  assert.equal(store.hasApiKey(), true);

  store.update({ ai: { provider: 'custom', providers: { custom: { model: 'm' } } } });
  assert.equal(store.hasApiKey(), false, '自定义接口没有地址');
  store.update({ ai: { providers: { custom: { baseUrl: 'http://127.0.0.1:8000/v1' } } } });
  assert.equal(store.hasApiKey(), true);
});

test('lang：auto 看系统首选语言，中文系统用中文，其余英文', () => {
  assert.equal(store.lang(), 'zh');
  env.langs = ['en-US'];
  assert.equal(store.lang(), 'en');
  env.langs = ['ja-JP'];
  assert.equal(store.lang(), 'en');
  store.update({ app: { language: 'zh' } });
  assert.equal(store.lang(), 'zh');
  assert.equal(store.petName(), '蓝毛小女仆');
});

// ---------------------------------------------------------------- petConfig
test('petConfig：一只宠物，没 Key 不碎碎念也不报余额', () => {
  const cfg = petConfig().main;
  assert.equal(cfg.pets.length, 1);
  const pet = cfg.pets[0];
  assert.equal(pet.id, 'main');
  assert.equal(pet.whisperEnabled, false);
  assert.equal(pet.balanceEnabled, false);
  assert.equal('workStatusEnabled' in pet, false);
  assert.equal(cfg.whisperPrompt, defaultPersona());
});

test('petConfig：有 Key 时按设置开；只有能查余额的服务商才报余额', () => {
  store.update({ ai: { providers: { deepseek: { apiKey: 'sk' }, openai: { apiKey: 'sk' } } } });
  assert.equal(petConfig().main.pets[0].balanceEnabled, true);
  assert.equal(petConfig().main.pets[0].whisperEnabled, true);
  store.update({ ai: { provider: 'openai' } });
  assert.equal(petConfig().main.pets[0].balanceEnabled, false);
});

test('petConfig：不让走动 → move 权重 0；活跃度改待机权重；用户人设覆盖默认', () => {
  store.update({ pet: { roam: false, liveliness: 'calm', throwPower: 1.5 }, ai: { persona: '  你是一只猫  ' } });
  const cfg = petConfig().main;
  assert.deepEqual(cfg.animationWeights, { idle: 45, turn: 5, move: 0 });
  assert.equal(cfg.physics.throwPower, 1.5);
  assert.equal(cfg.whisperPrompt, '你是一只猫');
});
