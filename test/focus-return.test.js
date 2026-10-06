'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createFocusReturn, LINK_MS, CAPTURE_EVERY_MS } = require('../desktop/main/focus-return.js');

const OWN = 4242;
const USER_APP = 1135;
const flush = () => new Promise((r) => setImmediate(r));

/** 假系统：时钟手动拨，最前面的应用可改，记下激活了谁 */
function setup(front = USER_APP) {
  const sys = {
    clock: 10_000,
    front,
    lookups: 0,
    activated: [],
    ownPid: OWN,
    now: () => sys.clock,
    frontPid: async () => {
      sys.lookups++;
      return sys.front;
    },
    activate: (pid) => sys.activated.push(pid),
  };
  return { sys, fr: createFocusReturn(sys) };
}

test('点她：交互期间本应用被激活 → 松手后把焦点还给原来的应用', async () => {
  const { sys, fr } = setup();
  fr.pointerNear();
  await flush();
  fr.becameActive(); // 按下的一瞬间系统激活了本应用
  fr.interaction(true);
  sys.clock += 120;
  fr.interaction(false);
  assert.deepEqual(sys.activated, [USER_APP]);
});

test('激活通知比渲染端的「按下」晚到：照样还', async () => {
  const { sys, fr } = setup();
  fr.pointerNear();
  await flush();
  fr.interaction(true);
  fr.becameActive();
  fr.interaction(false);
  assert.deepEqual(sys.activated, [USER_APP]);
});

test('点得很快：松手的消息比激活通知还早 → 激活时立刻还', async () => {
  const { sys, fr } = setup();
  fr.pointerNear();
  await flush();
  fr.interaction(true);
  fr.interaction(false);
  assert.deepEqual(sys.activated, []);
  sys.clock += 200;
  fr.becameActive();
  assert.deepEqual(sys.activated, [USER_APP]);
});

test('右键菜单：按下时激活、菜单开着时不还，关掉后再还', async () => {
  const { sys, fr } = setup();
  fr.pointerNear();
  await flush();
  fr.becameActive(); // 右键按下
  sys.clock += 50;
  fr.interaction(true); // 菜单弹出（渲染端 menuOpen）
  sys.clock += 3000; // 主人看了一会儿菜单
  assert.deepEqual(sys.activated, []);
  fr.interaction(false); // 选了「说句话」或按了 Esc
  assert.deepEqual(sys.activated, [USER_APP]);
});

test('打开聊天 / 设置 / 选图（cancel）：这次不还', async () => {
  const { sys, fr } = setup();
  fr.pointerNear();
  await flush();
  fr.becameActive();
  fr.interaction(true);
  fr.cancel(); // 菜单里选了「和她聊天…」
  fr.interaction(false);
  sys.clock += 100;
  fr.becameActive();
  assert.deepEqual(sys.activated, []);
});

test('本来就在前台（比如正开着设置窗口）：点她不做任何事', async () => {
  const { sys, fr } = setup();
  fr.becameActive();
  sys.clock += 5000;
  fr.pointerNear();
  await flush();
  assert.equal(sys.lookups, 0, '在前台时不去查最前面的应用');
  fr.interaction(true);
  fr.interaction(false);
  assert.deepEqual(sys.activated, []);
});

test('不是她引起的激活（菜单栏图标 / ⌘Tab），之后再点她也不乱还', async () => {
  const { sys, fr } = setup();
  fr.pointerNear();
  await flush();
  sys.clock += 5000;
  fr.becameActive(); // 主人自己切过来的
  sys.clock += 5000;
  fr.interaction(true);
  fr.interaction(false);
  assert.deepEqual(sys.activated, []);
});

test('交互中主人自己切走了（本应用失去前台）：不再抢回来', async () => {
  const { sys, fr } = setup();
  fr.pointerNear();
  await flush();
  fr.becameActive();
  fr.interaction(true);
  fr.resignedActive();
  fr.interaction(false);
  assert.deepEqual(sys.activated, []);
});

test('记到的是自己或者没查到：不算', async () => {
  for (const front of [OWN, null, 0]) {
    const { sys, fr } = setup(front);
    fr.pointerNear();
    await flush();
    fr.becameActive();
    fr.interaction(true);
    fr.interaction(false);
    assert.deepEqual(sys.activated, [], String(front));
  }
});

test('光标停在窗口里：每秒最多查一次，查到的是最新的应用', async () => {
  const { sys, fr } = setup();
  for (let i = 0; i < 10; i++) {
    fr.pointerNear();
    sys.clock += 60;
  }
  await flush();
  assert.equal(sys.lookups, 1);
  sys.front = 777; // 期间 ⌘Tab 换了应用
  sys.clock += CAPTURE_EVERY_MS;
  fr.pointerNear();
  await flush();
  assert.equal(sys.lookups, 2);
  fr.becameActive();
  fr.interaction(true);
  fr.interaction(false);
  assert.deepEqual(sys.activated, [777]);
});

test('还过一次就清掉：下一次没重新记就不会再还', async () => {
  const { sys, fr } = setup();
  fr.pointerNear();
  await flush();
  fr.becameActive();
  fr.interaction(true);
  fr.interaction(false);
  fr.resignedActive();
  sys.clock += LINK_MS / 2;
  fr.becameActive();
  fr.interaction(true);
  fr.interaction(false);
  assert.deepEqual(sys.activated, [USER_APP]);
});
