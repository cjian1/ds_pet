'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const P = require('../desktop/main/providers.js');

test('每家服务商的目录项都完整', () => {
  for (const id of P.PROVIDER_IDS) {
    const p = P.PROVIDERS[id];
    assert.ok(P.API_TYPES.includes(p.type), id + ' type');
    assert.equal(p.name.length, 2, id + ' 需要中英两个名字');
    assert.ok(p.name.every((n) => typeof n === 'string' && n), id + ' name');
    if (p.custom) {
      assert.equal(p.baseUrl, '', 'custom 的地址由用户填');
      continue;
    }
    assert.equal(P.cleanBaseUrl(p.baseUrl), p.baseUrl, id + ' 默认地址要是规整过的 http(s) 地址');
    assert.match(p.keyUrl, /^https:\/\//, id + ' keyUrl');
    if (p.effort) assert.deepEqual(Object.keys(p.effort).sort(), ['high', 'low', 'max'], id + ' effort 三档都要映射');
  }
});

test('只有 DeepSeek 能查余额', () => {
  assert.deepEqual(P.PROVIDER_IDS.filter((id) => P.PROVIDERS[id].balance), ['deepseek']);
});

test('info：未知 id 回落到 DeepSeek', () => {
  assert.equal(P.info('nope'), P.PROVIDERS.deepseek);
  assert.equal(P.info('ollama'), P.PROVIDERS.ollama);
});

test('displayName 按语言取名字', () => {
  assert.equal(P.displayName('anthropic', 'zh'), 'Claude（Anthropic）');
  assert.equal(P.displayName('anthropic', 'en'), 'Claude (Anthropic)');
});

test('cleanBaseUrl：去掉末尾斜杠，非 http(s) 当没填', () => {
  assert.equal(P.cleanBaseUrl(' https://api.example.com/v1/// '), 'https://api.example.com/v1');
  assert.equal(P.cleanBaseUrl('http://localhost:11434/v1'), 'http://localhost:11434/v1');
  assert.equal(P.cleanBaseUrl('ftp://x.y'), '');
  assert.equal(P.cleanBaseUrl('javascript:alert(1)'), '');
  assert.equal(P.cleanBaseUrl('https://a b'), '');
  assert.equal(P.cleanBaseUrl(undefined), '');
});
