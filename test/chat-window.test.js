'use strict';
// 聊天面板：没打开时不该被一条 push 顺手创建出隐藏的渲染进程（白占内存与电）
require('./helpers/electron-stub');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const chatWindow = require('../desktop/main/chat-window');

test('面板没打开时 send 什么都不做，也不会创建窗口', () => {
  assert.equal(chatWindow.window(), null);
  chatWindow.send('chat:refresh', { n: 1 });
  chatWindow.send('chat:attach', { image: 'x' });
  assert.equal(chatWindow.window(), null, '不该为了发消息建出隐藏的聊天渲染进程');
});

test('show() 之后 send 才落地：未加载完先排队，加载完按序送达', () => {
  chatWindow.show();
  const w = chatWindow.window();
  assert.ok(w, 'show() 会创建窗口');
  assert.equal(w.isVisible(), true);
  chatWindow.send('chat:refresh', { n: 2 });
  assert.deepEqual(w.webContents.sent, [], '还没加载完，先排队');
  w.webContents.emit('did-finish-load');
  assert.deepEqual(w.webContents.sent, [
    ['chat:focus', undefined],
    ['chat:refresh', { n: 2 }],
  ]);
});
