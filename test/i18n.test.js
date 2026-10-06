'use strict';
require('./helpers/electron-stub');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const I18n = require('../desktop/i18n/i18n.js');
const { WHISPER_INTERVALS, EFFORTS, SIZE_PRESETS } = require('../desktop/main/store');

const DESKTOP = path.join(__dirname, '..', 'desktop');

function files(dir, ext, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) files(f, ext, out);
    else if (f.endsWith(ext)) out.push(f);
  }
  return out;
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
/** 中文故意留空的：中文人设来自 config.jsonc 的 whisperPrompt；中文界面不需要「用英文回复」 */
const ZH_EMPTY = new Set(['prompt.persona', 'prompt.langLine']);

test('每条文案都有非空的中文和英文，占位符两边一致', () => {
  for (const key of I18n.keys()) {
    const zh = I18n.t('zh', key);
    const en = I18n.t('en', key);
    if (ZH_EMPTY.has(key)) assert.equal(zh, '', key);
    else assert.ok(typeof zh === 'string' && zh.trim(), key + ' 缺中文');
    assert.ok(typeof en === 'string' && en.trim(), key + ' 缺英文');
    assert.deepEqual(placeholders(zh), placeholders(en), key + ' 占位符不一致');
  }
});

test('代码里写死的文案键都存在', () => {
  const namespaces = new Set(I18n.keys().map((k) => k.split('.')[0]));
  const missing = [];
  const scripts = files(DESKTOP, '.js').filter((f) => !/i18n\.js$|shared-core\.js$/.test(f));
  for (const f of scripts) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/'([a-zA-Z]+\.[\w.]*\w)'/g)) {
      const key = m[1];
      if (!namespaces.has(key.split('.')[0]) || /\.(js|png|html|jsonc?|css|webm|ttf)$/.test(key)) continue;
      if (!I18n.has(key)) missing.push(path.relative(DESKTOP, f) + ': ' + key);
    }
  }
  assert.deepEqual(missing, []);
});

test('页面里 data-i18n* 引用的文案键都存在', () => {
  const missing = [];
  for (const f of files(DESKTOP, '.html')) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/data-i18n(?:-title|-placeholder)?="([^"]+)"/g)) {
      if (!I18n.has(m[1])) missing.push(path.relative(DESKTOP, f) + ': ' + m[1]);
    }
  }
  assert.deepEqual(missing, []);
});

test('拼出来的文案键（错误码 / 间隔 / 思考深度 / 大小档位）都存在', () => {
  const keys = [
    ...[400, 401, 402, 403, 404, 429, 500, 503].map((c) => 'err.' + c),
    ...WHISPER_INTERVALS.map((s) => 'interval.' + s),
    ...EFFORTS.map((e) => 'set.effortHint.' + e),
    ...SIZE_PRESETS.map((p) => p.key),
  ];
  assert.deepEqual(keys.filter((k) => !I18n.has(k)), []);
});

test('t：填占位符、未知键原样返回、语言不认识按中文', () => {
  assert.equal(I18n.t('en', 'menu.chatWith', { name: 'Mio' }), 'Chat with Mio…');
  assert.equal(I18n.t('zh-CN', 'menu.chatWith', { name: 'Mio' }), '和Mio聊天…');
  assert.equal(I18n.t('en', 'no.such.key'), 'no.such.key');
  assert.equal(I18n.normalize('en-GB'), 'en');
  assert.equal(I18n.normalize('fr'), 'zh');
});
