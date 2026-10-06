'use strict';
const { env } = require('./helpers/electron-stub');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { store, ASSETS, APP_ROOT } = require('../desktop/main/store');
const { _internal } = require('../desktop/main/service');

const { safeFile, fileResponse, handleApi } = _internal;
const req = (range) => ({ headers: new Headers(range ? { range } : {}) });
const api = (rest) => handleApi(req(), rest.split('?')[0], new URL('deskpet://app/api/' + rest));

store.load();

test('safeFile：只给 root 里面的文件，../ 越界一律不认', () => {
  const pet = path.join(APP_ROOT, 'pet');
  assert.equal(safeFile(pet, 'index.html'), path.join(pet, 'index.html'));
  assert.equal(safeFile(pet, '../main/index.js'), null);
  assert.equal(safeFile(pet, '/etc/passwd'), null);
  assert.equal(safeFile(pet, ''), null);
  assert.equal(safeFile(APP_ROOT, 'pet'), null, '目录不算文件');
  assert.equal(safeFile(pet, 'nope.js'), null);
});

test('文件应答：整份 200；Range 206（视频循环播放要用）；越界 416', async () => {
  const file = path.join(ASSETS, 'memes', '可爱.png');
  const size = fs.statSync(file).size;
  const bytes = fs.readFileSync(file);

  const full = await fileResponse(req(), file);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'image/png');
  assert.equal(Number(full.headers.get('content-length')), size);

  const head = await fileResponse(req('bytes=0-9'), file);
  assert.equal(head.status, 206);
  assert.equal(head.headers.get('content-range'), 'bytes 0-9/' + size);
  assert.deepEqual(Buffer.from(await head.arrayBuffer()), bytes.subarray(0, 10));

  const tail = await fileResponse(req('bytes=-5'), file);
  assert.deepEqual(Buffer.from(await tail.arrayBuffer()), bytes.subarray(size - 5));

  const open = await fileResponse(req('bytes=' + (size - 3) + '-'), file);
  assert.equal(open.headers.get('content-range'), 'bytes ' + (size - 3) + '-' + (size - 1) + '/' + size);

  const bad = await fileResponse(req('bytes=' + size + '-'), file);
  assert.equal(bad.status, 416);
});

test('/api/config：合成好的桌宠配置', async () => {
  const res = await api('config');
  assert.equal(res.status, 200);
  const cfg = await res.json();
  assert.equal(cfg.main.pets[0].id, 'main');
  assert.ok(cfg.main.animations.idle.length > 0);
});

test('/api/thumb：动画素材能取到，越界路径取不到', async () => {
  // handleApi 拿到的是 protocol handler 已经 decode 过的路径
  const ok = await handleApi(req(), 'thumb/main/待机呼吸休闲.webm', new URL('deskpet://app/api/x'));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get('content-type'), 'video/webm');
  const evil = await handleApi(req(), 'thumb/main/../../main/index.js', new URL('deskpet://app/api/x'));
  assert.equal(evil.status, 404);
});

test('/api/pic、/api/memes、/api/font：静态素材', async () => {
  for (const rest of ['pic/cursor-grab.png', 'pic/memes/可爱.png', 'memes/可爱.png', 'font/上首软糖体.ttf']) {
    const res = await handleApi(req(), rest, new URL('deskpet://app/api/x'));
    assert.equal(res.status, 200, rest);
  }
});

test('/api/whisper?auto=1：主人离开电脑（空闲 > 10 分钟）就不生成', async () => {
  env.idleSeconds = 700;
  try {
    const res = await api('whisper?auto=1');
    assert.deepEqual(await res.json(), { ok: false, reason: 'idle', message: 'away' });
  } finally {
    env.idleSeconds = 0;
  }
});

test('/api/whisper：没配好服务商时回 provider-missing', async () => {
  const res = await api('whisper/trigger');
  const st = await res.json();
  assert.equal(st.ok, false);
  assert.equal(st.reason, 'provider-missing');
});

test('上游 DSH 专属接口已经去掉', async () => {
  for (const rest of ['work-status', 'broadcast']) assert.equal((await api(rest)).status, 404, rest);
});
