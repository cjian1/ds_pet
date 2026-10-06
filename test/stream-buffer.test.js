'use strict';
// 流式正文合帧：攒包、收尾补发、不丢字不重复（省掉逐 token 的 IPC 与渲染端强制回滚）
const test = require('node:test');
const assert = require('node:assert/strict');
const { createStreamBuffer } = require('../desktop/main/stream-buffer');

/** 手动时钟：能看见排了几个定时器、各自的间隔，并手动触发 */
function fakeTimers() {
  let next = 1;
  const jobs = new Map();
  return {
    setTimer(fn, ms) {
      const id = next++;
      jobs.set(id, { fn, ms });
      return id;
    },
    clearTimer(id) {
      jobs.delete(id);
    },
    get size() {
      return jobs.size;
    },
    delays() {
      return [...jobs.values()].map((j) => j.ms);
    },
    runAll() {
      for (const [id, job] of [...jobs]) {
        jobs.delete(id);
        job.fn();
      }
    },
  };
}

function make(t, out, clock = { now: 0 }) {
  return createStreamBuffer({
    flushMs: 40,
    onFlush: (s) => out.push(s),
    setTimer: t.setTimer,
    clearTimer: t.clearTimer,
    now: () => clock.now,
  });
}

test('首字不等：第一个 delta 立刻吐出（她开口的那一下不白等一个窗口）', () => {
  const t = fakeTimers();
  const out = [];
  const buf = make(t, out);
  buf.push('你');
  assert.deepEqual(out, ['你'], '第一个字立刻发');
  assert.equal(t.size, 0, '没必要排计时器');
});

test('合帧：窗口内后续的 delta 攒成一包，只排一个计时器，等到窗口结束', () => {
  const t = fakeTimers();
  const out = [];
  const clock = { now: 1000 };
  const buf = make(t, out, clock);
  buf.push('你');
  clock.now += 10;
  buf.push('好');
  clock.now += 5;
  buf.push('呀');
  assert.deepEqual(out, ['你'], '窗口内的字先攒着');
  assert.equal(t.size, 1, '多次 push 只排一个计时器');
  assert.deepEqual(t.delays(), [30], '只等到窗口结束（40 - 10），不是再等满 40');
  clock.now += 25;
  t.runAll();
  assert.deepEqual(out, ['你', '好呀']);
});

test('合帧：隔了一个窗口以上再来的字又是立刻吐', () => {
  const t = fakeTimers();
  const out = [];
  const clock = { now: 0 };
  const buf = make(t, out, clock);
  buf.push('A');
  clock.now += 100;
  buf.push('B');
  assert.deepEqual(out, ['A', 'B']);
  assert.equal(t.size, 0);
});

test('收尾：flushNow 立刻吐出残余并取消未触发的计时器（不丢字、不重复）', () => {
  const t = fakeTimers();
  const out = [];
  const buf = make(t, out);
  buf.push('头');
  buf.push('尾'); // 同一时刻：在窗口内，攒着
  assert.equal(buf.pendingLength(), 1);
  assert.equal(t.size, 1);
  buf.flushNow();
  assert.deepEqual(out, ['头', '尾']);
  assert.equal(t.size, 0, '计时器被取消');
  assert.equal(buf.pendingLength(), 0);
  t.runAll(); // 就算旧计时器漏网也不能再吐一次
  assert.deepEqual(out, ['头', '尾']);
});

test('收尾：没有残余时不吐空包', () => {
  const t = fakeTimers();
  const out = [];
  const buf = make(t, out);
  buf.flushNow();
  buf.push('');
  t.runAll();
  assert.deepEqual(out, []);
});

test('默认走真实计时器与时钟：首字立刻吐，窗口内的字到点自动吐出', async () => {
  const out = [];
  const buf = createStreamBuffer({ flushMs: 20, onFlush: (s) => out.push(s) });
  buf.push('h');
  buf.push('i');
  assert.deepEqual(out, ['h']);
  await new Promise((r) => setTimeout(r, 60));
  assert.deepEqual(out, ['h', 'i']);
});
