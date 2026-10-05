// 开发调试：连到 --remote-debugging-port 的某个页面，执行表达式 / 截图。
//   node scripts/debug/cdp.mjs <port> <url 片段> eval '<js 表达式>'
//   node scripts/debug/cdp.mjs <port> <url 片段> shot <输出.png>
import fs from 'node:fs';

const [port, match, cmd, arg] = process.argv.slice(2);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const t = match === 'node' ? targets.find((x) => x.type === 'node') : targets.find((x) => x.type === 'page' && x.url.includes(match));
if (!t) {
  console.error('no target matching', match, targets.map((x) => x.url));
  process.exit(1);
}
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  }
};
await new Promise((r) => (ws.onopen = r));
const call = (method, params = {}) =>
  new Promise((resolve) => {
    const i = ++id;
    pending.set(i, resolve);
    ws.send(JSON.stringify({ id: i, method, params }));
  });

if (cmd === 'reload') {
  await call('Page.reload', { ignoreCache: true });
  await new Promise((r) => setTimeout(r, 1500));
  console.log('reloaded');
} else if (cmd === 'eval') {
  const r = await call('Runtime.evaluate', { expression: arg, awaitPromise: true, returnByValue: true });
  console.log(JSON.stringify(r.result.result ? r.result.result.value : r.result, null, 2));
} else if (cmd === 'shot') {
  // 可选：第 5 个参数 = 配色（light/dark），截图时用对应的不透明底色模拟毛玻璃
  const scheme = process.argv[6];
  if (scheme === 'transparent') {
    // 透明背景（桌宠窗口本来就是透明的）
    await call('Emulation.setDefaultBackgroundColorOverride', { color: { r: 0, g: 0, b: 0, a: 0 } });
    await new Promise((r) => setTimeout(r, 200));
  } else if (scheme) {
    await call('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] });
    const c = scheme === 'dark' ? { r: 40, g: 40, b: 44, a: 1 } : { r: 236, g: 236, b: 238, a: 1 };
    await call('Emulation.setDefaultBackgroundColorOverride', { color: c });
    await new Promise((r) => setTimeout(r, 300));
  }
  const r = await call('Page.captureScreenshot', { format: 'png' });
  if (scheme) {
    await call('Emulation.setDefaultBackgroundColorOverride', {});
    await call('Emulation.setEmulatedMedia', { features: [] });
  }
  fs.writeFileSync(arg, Buffer.from(r.result.data, 'base64'));
  console.log('saved', arg);
}
ws.close();
