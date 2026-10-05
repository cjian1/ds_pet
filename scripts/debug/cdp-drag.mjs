// 开发调试：在桌宠页面上用 CDP 输入管线做一次「按住 → 慢慢拖 → 停一下 → 松手」
const [port, x0, y0, x1, y1] = process.argv.slice(2).map(Number);
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
const t = targets.find((x) => x.type === 'page' && x.url.includes('/pet/'));
const ws = new WebSocket(t.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.onmessage = (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
};
await new Promise((r) => (ws.onopen = r));
const call = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mouse = (type, x, y, extra = {}) => call('Input.dispatchMouseEvent', Object.assign({ type, x, y, button: 'left', buttons: type === 'mouseReleased' ? 0 : 1, clickCount: 1 }, extra));
await mouse('mouseMoved', x0, y0, { buttons: 0, button: 'none' });
await mouse('mousePressed', x0, y0);
const steps = 20;
for (let i = 1; i <= steps; i++) {
  await mouse('mouseMoved', x0 + ((x1 - x0) * i) / steps, y0 + ((y1 - y0) * i) / steps);
  await sleep(25);
}
await sleep(500);
await mouse('mouseReleased', x1, y1);
await sleep(300);
const r = await call('Runtime.evaluate', { expression: 'JSON.stringify({release: window.__dshPetDebug.lastDragRelease, pos: window.__dshPetDebug.dragPos, interactive: window.__dshPetDebug.interactive, busy: window.__dshPetDebug.inputBusy})', returnByValue: true });
console.log(r.result.result.value);
ws.close();
