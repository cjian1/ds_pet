'use strict';
// 桌宠窗口的省电关键路径：隐藏时停掉兜底轮询并挂起渲染端；恢复时重新启动。
require('./helpers/electron-stub');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const petWindow = require('../desktop/main/pet-window');

// 记录被测模块排的定时器：既能看到「有没有在轮询」，也不会让自调度的轮询把测试进程挂住
// （unref 后不阻止进程退出）。
const realSetTimeout = global.setTimeout;
const realClearTimeout = global.clearTimeout;
let pending = new Set();
function spyTimers() {
  pending = new Set();
  global.setTimeout = (fn, ms) => {
    const id = realSetTimeout(() => {
      pending.delete(id);
      fn();
    }, ms);
    if (typeof id.unref === 'function') id.unref();
    pending.add(id);
    return id;
  };
  global.clearTimeout = (id) => {
    pending.delete(id);
    return realClearTimeout(id);
  };
}
function restoreTimers() {
  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;
}

test('显示 → 开始兜底轮询；隐藏 → 停表并挂起渲染端；再显示 → 重启', () => {
  spyTimers();
  try {
    petWindow.init({});
    const w = petWindow.create(); // = recreate：窗口初始是隐藏的
    // 还没显示：不启动轮询，但排一次重试（showInactive 的 'show' 可能早于「可见」标志，不能就此熄火）
    assert.equal(pending.size, 1, '还没显示时排一次重试，而不是直接放弃');

    w.emit('ready-to-show'); // 系统就绪 → showInactive()
    assert.equal(w.isVisible(), true);
    assert.equal(pending.size, 1, '显示后（重试链路）继续跑兜底轮询');

    petWindow.hide();
    assert.deepEqual(w.webContents.sent.at(-1), ['pet:suspend', true]);
    assert.equal(pending.size, 0, '隐藏后彻底停表，不再空转唤醒 CPU');

    petWindow.show();
    assert.deepEqual(w.webContents.sent.at(-1), ['pet:suspend', false]);
    assert.equal(pending.size, 1, '恢复后重新开始轮询');
  } finally {
    petWindow.hide();
    restoreTimers();
  }
});

test('改名字：推给渲染端 + 更新窗口标题，不重建窗口', () => {
  petWindow.init({});
  if (!petWindow.window()) petWindow.create();
  const w = petWindow.window();
  assert.ok(w);
  petWindow.setName('新名字');
  assert.equal(w.title, '新名字');
  assert.deepEqual(w.webContents.sent.at(-1), ['pet:name', '新名字']);
});

test('窗口还没显示时兜底轮询会重试，不会永久熄火', () => {
  // 曾经的回归：showInactive() 的 'show' 事件有时比「可见」标志早到，startPointerPoll 判到不可见就
  // 直接返回，此后再无事件唤醒 —— 兜底轮询累计 0 次（实测），穿透判定的退路就永久没了。
  spyTimers();
  try {
    petWindow.init({});
    const w = petWindow.create(); // 新建、尚未显示
    assert.equal(w.isVisible(), false);
    assert.equal(pending.size, 1, '「该显示却没显示」时应排一次重试，而不是放弃');
  } finally {
    petWindow.hide();
    restoreTimers();
  }
});

test('锁屏：停轮询 + 挂起渲染端；解锁：按可见性恢复', () => {
  spyTimers();
  try {
    petWindow.init({});
    if (!petWindow.window()) petWindow.create();
    petWindow.show();
    const w = petWindow.window();
    assert.equal(w.isVisible(), true);
    assert.equal(pending.size, 1, '可见时轮询在跑');

    petWindow.setScreenLocked(true);
    assert.deepEqual(w.webContents.sent.at(-1), ['pet:suspend', true]);
    assert.equal(pending.size, 0, '锁屏后连轮询都停');

    petWindow.setScreenLocked(false);
    assert.deepEqual(w.webContents.sent.at(-1), ['pet:suspend', false]);
    assert.equal(pending.size, 1, '解锁后恢复轮询');
  } finally {
    petWindow.setScreenLocked(false);
    petWindow.hide();
    restoreTimers();
  }
});

test('主人离开 5 分钟：推一次「不在」；回来：推一次「在」；新窗口从「在」开始重新判定', async () => {
  const { env } = require('./helpers/electron-stub');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const awayMsgs = (w) => w.webContents.sent.filter(([ch]) => ch === 'pet:away').map(([, v]) => v);
  spyTimers();
  try {
    petWindow.init({});
    if (!petWindow.window()) petWindow.create();
    petWindow.show();
    const w = petWindow.window();
    env.idleSeconds = petWindow.AWAY_AFTER_SEC - 1;
    await sleep(150);
    assert.deepEqual(awayMsgs(w), [], '没到 5 分钟：不推');

    // 系统空闲时间每秒最多查一次：等过这一秒
    env.idleSeconds = petWindow.AWAY_AFTER_SEC + 5;
    await sleep(1150);
    assert.deepEqual(awayMsgs(w), [true], '离开：推一次 true');
    await sleep(200);
    assert.deepEqual(awayMsgs(w), [true], '状态没变不重复推');

    env.idleSeconds = 0;
    await sleep(1150);
    assert.deepEqual(awayMsgs(w), [true, false], '回来：推一次 false');

    // 重建窗口（新渲染端从「在」开始）：主人仍不在时，下一拍就要把「不在」重新推给新窗口
    env.idleSeconds = petWindow.AWAY_AFTER_SEC + 5;
    const next = petWindow.recreate();
    next.emit('ready-to-show');
    await sleep(200);
    assert.deepEqual(awayMsgs(next), [true]);
  } finally {
    env.idleSeconds = 0;
    petWindow.hide();
    restoreTimers();
  }
});

test('页面 boot 完之前的动作先排队，pet:ready 后按顺序补发（藏着启动后点「说句话」不再丢）', () => {
  const { electron } = require('./helpers/electron-stub');
  spyTimers();
  try {
    petWindow.init({});
    const w = petWindow.recreate(); // 新页面，还没 boot 完
    const actions = () => w.webContents.sent.filter(([ch]) => ch === 'pet:action').map(([, a]) => a.type);
    petWindow.send('pet:action', { type: 'whisper' });
    petWindow.send('pet:action', { type: 'balance' });
    petWindow.send('pet:name', '不排队'); // 状态类消息照常直发
    assert.deepEqual(actions(), [], '还没就绪：先排着');
    assert.deepEqual(w.webContents.sent.at(-1), ['pet:name', '不排队']);

    electron.ipcMain.listeners['pet:ready']({ sender: w.webContents });
    assert.deepEqual(actions(), ['whisper', 'balance'], '就绪后按顺序补发');
    petWindow.send('pet:action', { type: 'home' });
    assert.deepEqual(actions(), ['whisper', 'balance', 'home'], '之后直接发');
  } finally {
    petWindow.hide();
    restoreTimers();
  }
});
