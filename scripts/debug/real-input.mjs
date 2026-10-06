// 用真实的系统鼠标事件把桌宠窗口的交互完整走一遍（npm run test:real-input）。
//
// 和 cdp-drag.mjs 不同：那个是在页面里模拟输入，绕过了 macOS 窗口服务器，测不到点击穿透。
// 这里用 mouse.swift 发 CGEvent，事件和手动操作走同一条路：先由系统按窗口的「忽略鼠标」状态决定
// 落到哪个窗口，再进页面。
//
// 会接管鼠标大约半分钟，跑完把光标放回原处。需要给运行它的应用（比如终端）开「辅助功能」权限。
// 开发版在临时数据目录里启动（不碰你的设置和聊天记录，也不连 AI 服务），桌宠下面垫一块半透明的
// 「接点击」面板：穿透下去的点击都落在它上面，不会点到你别的应用。
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAIN_PORT = 9434;
const PAGE_PORT = 9433;
const IMAGE = path.join(ROOT, 'desktop', 'assets', 'memes', '可爱.png');

// ---------------------------------------------------------------- 鼠标助手
function buildHelper() {
  const src = path.join(ROOT, 'scripts', 'debug', 'mouse.swift');
  const bin = path.join(ROOT, '.cache', 'ds_pet-mouse');
  if (!fs.existsSync(bin) || fs.statSync(bin).mtimeMs < fs.statSync(src).mtimeMs) {
    fs.mkdirSync(path.dirname(bin), { recursive: true });
    execFileSync('swiftc', ['-O', '-o', bin, src], { stdio: 'inherit' });
  }
  const proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = readline.createInterface({ input: proc.stdout });
  const waiting = [];
  lines.on('line', (l) => waiting.shift()?.(l));
  const cmd = (line) =>
    new Promise((resolve) => {
      waiting.push(resolve);
      proc.stdin.write(line + '\n');
    });
  return { cmd, close: () => proc.kill() };
}

// ---------------------------------------------------------------- CDP
class Cdp {
  static async connect(url) {
    const c = new Cdp();
    c.ws = new WebSocket(url);
    c.id = 0;
    c.pending = new Map();
    c.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && c.pending.has(m.id)) {
        c.pending.get(m.id)(m);
        c.pending.delete(m.id);
      }
    };
    await new Promise((r, j) => {
      c.ws.onopen = r;
      c.ws.onerror = j;
    });
    return c;
  }
  async eval(expression, timeoutMs = 8000) {
    const i = ++this.id;
    const reply = new Promise((resolve) => this.pending.set(i, resolve));
    this.ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    const m = await Promise.race([reply, sleep(timeoutMs).then(() => ({ timeout: true }))]);
    if (m.timeout) throw new Error('CDP 超时：' + expression.slice(0, 80));
    const r = m.result;
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result.value;
  }
  close() {
    this.ws.close();
  }
}

async function waitFor(fn, timeoutMs = 15000, label = '') {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* 还没好 */
    }
    if (Date.now() - t0 > timeoutMs) throw new Error('等太久了：' + label);
    await sleep(200);
  }
}

const targets = async (port, kind) => (await (await fetch(`http://127.0.0.1:${port}/json/${kind}`)).json());
const pageTarget = async (part) => (await targets(PAGE_PORT, 'list')).find((t) => t.type === 'page' && t.url.includes(part));

// ---------------------------------------------------------------- 结果
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? '  — ' + detail : ''));
}

// ---------------------------------------------------------------- 主流程
const SETUP_ONLY = process.argv.includes('--setup-only'); // 只启动、摆好窗口、打印几何，不动鼠标
/**
 * macOS 把权限记在哪个应用头上（「负责的应用」）：沿父进程往上找 .app。
 * 一般是最外层那个（终端、VS Code…）；中间隔着 disclaimer 助手时（有些应用用它启动内置的命令行工具），
 * 负责的是 disclaimer 下面那一层。
 */
function responsibleApp() {
  let pid = process.pid;
  let found = '';
  for (let i = 0; i < 20 && pid > 1; i++) {
    const [ppid, ...cmd] = execFileSync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/);
    const exe = cmd.join(' ');
    if (path.basename(exe) === 'disclaimer') break;
    const m = /^(.*?\.app)\/Contents\//.exec(exe);
    if (m) found = m[1];
    pid = Number(ppid);
  }
  return found;
}

const mouse = buildHelper();
if (!SETUP_ONLY && (await mouse.cmd('check')) !== 'ok') {
  const who = responsibleApp();
  console.error(
    '没有发送鼠标事件的权限。\n' +
      '到「系统设置 › 隐私与安全性 › 辅助功能」里打开' +
      (who ? '「' + path.basename(who, '.app') + '」（列表里没有就点 +，按 ⇧⌘G 粘贴下面的路径添加）：\n  ' + who : '运行这个脚本的应用（终端 / iTerm…）') +
      '\n打开后重跑。',
  );
  await mouse.cmd('request');
  mouse.close();
  process.exit(2);
}

const home = (await mouse.cmd('pos')).split(' ').map(Number);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds_pet-real-input-'));
fs.writeFileSync(
  path.join(dataDir, 'settings.json'),
  JSON.stringify({
    onboarded: true,
    pet: { size: 320, roam: false, liveliness: 'calm' },
    talk: { whisperEnabled: false, balanceEnabled: false },
    app: { language: 'zh', shortcutEnabled: false, showInDock: false, autoUpdate: false },
    position: { rx: 0.62, ry: 0.45 },
  }),
);

const electron = require('electron');
const app = spawn(electron, ['desktop', `--inspect=${MAIN_PORT}`, `--remote-debugging-port=${PAGE_PORT}`], {
  cwd: ROOT,
  env: Object.assign({}, process.env, { DS_PET_DATA_DIR: dataDir }),
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
app.stderr.on('data', (d) => (stderr += d));

let main;
let pet;
const cleanup = async () => {
  try {
    await mouse.cmd(`move ${home[0]} ${home[1]}`);
  } catch {
    /* 忽略 */
  }
  mouse.close();
  main?.close();
  pet?.close();
  app.kill();
  await sleep(500);
  fs.rmSync(dataDir, { recursive: true, force: true });
};

try {
  console.log('启动开发版（临时数据目录）…');
  const mainUrl = await waitFor(async () => (await targets(MAIN_PORT, 'list'))[0]?.webSocketDebuggerUrl, 20000, '主进程调试端口');
  main = await Cdp.connect(mainUrl);
  await waitFor(() => main.eval('!!(global.__whale && __whale.petWindow.window())'), 15000, '桌宠窗口');
  pet = await Cdp.connect((await waitFor(() => pageTarget('/pet/'), 15000, '桌宠页面')).webSocketDebuggerUrl);
  await waitFor(() => pet.eval('window.__dshPetDebug.configOk && sprites.length === 1'), 15000, '桌宠就绪');
  await waitFor(() => main.eval('__whale.petWindow.window().isVisible()'), 10000, '桌宠显示');
  await sleep(800);

  /** 她现在的屏幕几何：窗口、身体命中区、整张画面 */
  const geo = async () => {
    const win = await main.eval('__whale.petWindow.window().getContentBounds()');
    const r = await pet.eval(`(() => {
      const s = sprites[0], h = s.hit.getBoundingClientRect(), st = s.stage.getBoundingClientRect();
      return { hit: [h.x, h.y, h.width, h.height], stage: [st.x, st.y, st.width, st.height] };
    })()`);
    const abs = ([x, y, w, h]) => ({ x: win.x + x, y: win.y + y, width: w, height: h });
    const hit = abs(r.hit);
    return { win, hit, stage: abs(r.stage), center: { x: hit.x + hit.width / 2, y: hit.y + hit.height / 2 } };
  };
  const inside = (p, r) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

  // ---- 垫在她下面的「接点击」面板：同一应用的非激活浮动面板，层级在她之下、普通窗口之上
  const SRC = 150; // 左边留一条放「拖这张图」的源
  const catcherHtml = `<body style="margin:0;background:rgba(60,140,255,.10);font:12px -apple-system;color:#36c;user-select:none">
    <div id="src" draggable="true" style="position:absolute;left:20px;top:40px;width:${SRC - 40}px;height:110px;
      background:#fff url('file://${encodeURI(IMAGE)}') center/70px no-repeat;border:2px dashed #39f;border-radius:10px"></div>
    <div style="position:absolute;left:8px;bottom:6px">ds_pet 真实输入测试</div>
    <script>
      window.__clicks = [];
      addEventListener('mousedown', (e) => __clicks.push({ x: e.screenX, y: e.screenY, button: e.button }));
      addEventListener('dragover', (e) => e.preventDefault());
      addEventListener('drop', (e) => { e.preventDefault(); window.__dropped = (window.__dropped || 0) + 1; });
      document.getElementById('src').addEventListener('dragstart', (e) => {
        e.preventDefault();
        require('electron').ipcRenderer.send('test:start-drag');
      });
    </script></body>`;
  const placeCatcher = async (g) => {
    const rect = { x: Math.round(g.win.x - SRC), y: Math.round(g.win.y), width: Math.round(g.win.width + SRC), height: Math.round(g.win.height) };
    await main.eval(`(() => {
      const { BrowserWindow, ipcMain, nativeImage } = process.mainModule.require('electron');
      const rect = ${JSON.stringify(rect)};
      if (global.__catcher && !global.__catcher.isDestroyed()) { global.__catcher.setBounds(rect); return true; }
      const w = new BrowserWindow(Object.assign({}, rect, {
        show: false, frame: false, type: 'panel', acceptFirstMouse: true, hasShadow: false, resizable: false,
        transparent: true, backgroundColor: '#00000000',
        webPreferences: { nodeIntegration: true, contextIsolation: false, sandbox: false, webSecurity: false },
      }));
      w.setAlwaysOnTop(true, 'floating');
      ipcMain.removeAllListeners('test:start-drag');
      ipcMain.on('test:start-drag', (e) => e.sender.startDrag({
        file: ${JSON.stringify(IMAGE)},
        icon: nativeImage.createFromPath(${JSON.stringify(IMAGE)}).resize({ width: 64 }),
      }));
      global.__catcher = w;
      return w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(${JSON.stringify(catcherHtml)}))
        .then(() => { w.showInactive(); return true; });
    })()`);
    await sleep(300);
    return rect;
  };
  const catcherClicks = () => main.eval('global.__catcher.webContents.executeJavaScript("window.__clicks.length")');
  /** 只往自己的窗口里点：目标不在桌宠窗口或接点击面板里就直接报错，绝不点到别的应用 */
  let safeArea = null;
  const guard = (p) => {
    if (!inside(p, safeArea)) throw new Error(`坐标 ${Math.round(p.x)},${Math.round(p.y)} 不在测试面板里，停止`);
  };
  const moveTo = async (p, wait = 200) => {
    guard(p);
    await mouse.cmd(`move ${p.x} ${p.y}`);
    await sleep(wait);
  };
  const clickAt = async (p, button = '') => {
    await moveTo(p);
    await mouse.cmd(`click ${p.x} ${p.y} ${button}`.trim());
    await sleep(350);
  };
  const dragPath = async (from, to, steps, stepMs) => {
    for (let i = 1; i <= steps; i++) {
      const x = from.x + ((to.x - from.x) * i) / steps;
      const y = from.y + ((to.y - from.y) * i) / steps;
      await mouse.cmd(`drag ${x} ${y}`);
      await sleep(stepMs);
    }
  };
  const anim = () => pet.eval('sprites[0].anim');
  const clicksPool = await pet.eval('sprites[0].animations.clicks');

  let g = await geo();
  safeArea = await placeCatcher(g);
  // 你自己装的 ds_pet 如果正好挡在测试区域上面，点击会落到它身上：先让它让开
  const overlap = JSON.parse(await mouse.cmd('windows')).filter(
    (w) => w.owner === 'ds_pet' && w.x < safeArea.x + safeArea.width && w.x + w.width > safeArea.x && w.y < safeArea.y + safeArea.height && w.y + w.height > safeArea.y,
  );
  if (overlap.length) throw new Error('已安装的 ds_pet 挡在测试区域上，先把她隐藏（⌃⌥P）或挪开再跑');
  const front0 = await mouse.cmd('front');
  console.log(`桌宠窗口 ${g.win.x},${g.win.y} ${g.win.width}×${g.win.height}；最前面的应用：${front0}\n`);
  if (SETUP_ONLY) {
    console.log(JSON.stringify({ hit: g.hit, stage: g.stage, catcher: safeArea, clicks: await catcherClicks() }));
    await sleep(1500);
    throw Object.assign(new Error('setup-only'), { setupOnly: true });
  }

  // 1. 悬停在她身上：渲染端收到转发的 mousemove，翻成可交互
  await moveTo(g.center, 400);
  check('光标移到她身上：变成可交互', await pet.eval('window.__dshPetDebug.interactive === true'));

  // 记下开发版每次被激活的时间（macOS 的 did-become-active）：焦点变了时据此判断是不是被她抢走的
  await main.eval(`(() => {
    const { app } = process.mainModule.require('electron');
    global.__activations = [];
    app.on('did-become-active', () => global.__activations.push(Date.now()));
    return true;
  })()`);
  const activations = () => main.eval('global.__activations.length');
  /** 把焦点还给原来的应用（就是你运行测试的终端）。「接点击」面板也是开发版的窗口，点到它会激活开发版，
   *  所以每个要看焦点的步骤开始前都先还一次 */
  let actBase = 0;
  const restoreFront = async () => {
    if (front0 && (await mouse.cmd('front')) !== front0) {
      execFileSync('open', ['-b', front0]);
      await sleep(800);
    }
    actBase = await activations();
  };
  /** 交互结束后等焦点回到原来的应用（focus-return.js 用 osascript 激活，要几百毫秒） */
  const focusBack = async (name) => {
    const t0 = Date.now();
    let front = '';
    while (Date.now() - t0 < 2500) {
      front = await mouse.cmd('front');
      if (front === front0) break;
      await sleep(100);
    }
    const n = (await activations()) - actBase;
    const how = n > 0 ? `开发版被激活了 ${n} 次` : '开发版没被激活';
    check(name, front === front0, front === front0 ? `${how}，${Date.now() - t0}ms 内焦点在原来的应用` : `${how}，最前面是 ${front}`);
  };

  // 2. 点她：播点击回应，点击不穿透；系统会激活本应用，松手后焦点要还回去
  await restoreFront();
  let before = await catcherClicks();
  await clickAt(g.center);
  await sleep(300);
  const a = await anim();
  check('点她：播放点击回应动画', clicksPool.includes(a), a);
  check('点她：点击没有穿透到下面', (await catcherClicks()) === before);
  await focusBack('点她：松手后焦点还给原来的应用（不抢焦点）');

  // 3. 她身边的透明画面：点击穿透到下面
  const beside = { x: g.stage.x + g.stage.width * 0.12, y: g.center.y };
  if (inside(beside, g.hit)) throw new Error('测试点落在身体上了');
  before = await catcherClicks();
  await clickAt(beside);
  check('点她身边的透明画面：穿透到下面的窗口', (await catcherClicks()) === before + 1);

  // 4. 窗口余量（她头顶左上方的透明区）：穿透
  const margin = { x: g.win.x + 20, y: g.win.y + 20 };
  before = await catcherClicks();
  await clickAt(margin);
  check('点窗口余量：穿透到下面的窗口', (await catcherClicks()) === before + 1);

  // 5. 慢慢拖：她跟着光标走，停一下再松手不会被甩出去
  await restoreFront();
  await moveTo(g.center, 300);
  const win0 = g.win;
  const to = { x: g.center.x + 140, y: g.center.y - 50 };
  await mouse.cmd(`down ${g.center.x} ${g.center.y}`);
  await sleep(80);
  await dragPath(g.center, to, 20, 30);
  check('拖拽中：主进程收到「正在用输入」', await pet.eval('window.__dshPetDebug.inputBusy === true'));
  await sleep(400);
  await mouse.cmd(`up ${to.x} ${to.y}`);
  await sleep(600);
  g = await geo();
  const dx = g.win.x - win0.x;
  const dy = g.win.y - win0.y;
  check('慢慢拖：她跟着走了同样的距离', Math.abs(dx - 140) <= 12 && Math.abs(dy + 50) <= 12, `位移 ${dx},${dy}`);
  check('慢慢拖：松手后没有被甩出去', (await pet.eval('sprites[0].throwRef')) === null);
  check('慢慢拖：松手后交还常规判定', await pet.eval('window.__dshPetDebug.inputBusy === false'));
  await focusBack('慢慢拖：松手后焦点还给原来的应用');
  safeArea = await placeCatcher(g);

  // 6. 右键：系统原生菜单弹出；Esc 关掉；之后透明区照样穿透
  await restoreFront();
  await clickAt(g.center, 'right');
  await sleep(300);
  check('右键她：弹出原生菜单', await pet.eval('window.__dshPetDebug.menuOpen === true'));
  await mouse.cmd('key escape');
  await sleep(500);
  if (await pet.eval('window.__dshPetDebug.menuOpen')) {
    await mouse.cmd('key escape');
    await sleep(500);
  }
  const closedByEsc = await pet.eval('window.__dshPetDebug.menuOpen === false');
  check('按 Esc：菜单关掉', closedByEsc);
  if (!closedByEsc) {
    await mouse.cmd(`click ${g.win.x + 20} ${g.win.y + 20}`); // 点别处把菜单收掉，接着测
    await sleep(500);
  } else {
    await focusBack('关掉菜单：焦点还给原来的应用');
  }
  before = await catcherClicks();
  await clickAt({ x: g.win.x + 20, y: g.win.y + 20 });
  check('菜单关掉后：透明区照样穿透', (await catcherClicks()) === before + 1);

  // 7. 把图片拖到她身边（不是她身上）：她不接，也不亮
  const src = { x: safeArea.x + SRC / 2, y: safeArea.y + 95 };
  const dragImageTo = async (target) => {
    await moveTo(src, 200);
    await mouse.cmd(`down ${src.x} ${src.y}`);
    await sleep(120);
    await dragPath(src, { x: src.x + 24, y: src.y + 6 }, 4, 30); // 触发 dragstart → startDrag
    await sleep(400);
    guard(target);
    await dragPath({ x: src.x + 24, y: src.y + 6 }, target, 25, 30);
    for (let i = 0; i < 6; i++) {
      await mouse.cmd(`drag ${target.x + (i % 2)} ${target.y}`); // 在目标上轻轻晃，让系统持续派发 dragover
      await sleep(80);
    }
    const glow = await pet.eval("sprites[0].el.classList.contains('is-drop-target')");
    await mouse.cmd(`up ${target.x} ${target.y}`);
    await sleep(1500);
    return glow;
  };
  const chatOpen = () => main.eval('__whale.chatWindow.isVisible()');
  const besideNow = { x: g.stage.x + g.stage.width * 0.12, y: g.center.y };
  const glowBeside = await dragImageTo(besideNow);
  check('拖图到她身边：她不亮', glowBeside === false);
  check('拖图到她身边：不打开聊天', (await chatOpen()) === false);

  // 8. 把图片拖到她身上：身上亮一圈，松手打开聊天面板并带上这张图
  const glowBody = await dragImageTo(g.center);
  check('拖图到她身上：身上亮一圈', glowBody === true);
  check('拖图到她身上：打开聊天面板', (await chatOpen()) === true);
  const chat = await Cdp.connect((await waitFor(() => pageTarget('/chat/'), 5000, '聊天页面')).webSocketDebuggerUrl);
  const attached = await waitFor(
    () => chat.eval("!document.getElementById('attach-preview').hidden && document.getElementById('attach-img').src.startsWith('data:image/')"),
    5000,
    '附图',
  ).catch(() => false);
  check('拖图到她身上：图片已经放进输入框', attached);
  check('拖图到她身上：聊天面板拿到焦点（这次不还）', await main.eval('__whale.chatWindow.window().isFocused()'));
  chat.close();
  await main.eval('__whale.chatWindow.hide(), true');
  await sleep(300);

  // 9. 甩出去：飞行、落地，停在屏幕里
  await restoreFront();
  g = await geo();
  await moveTo(g.center, 300);
  await mouse.cmd(`down ${g.center.x} ${g.center.y}`);
  await sleep(60);
  await dragPath(g.center, { x: g.center.x - 260, y: g.center.y - 40 }, 6, 12);
  await mouse.cmd(`up ${g.center.x - 260} ${g.center.y - 40}`);
  await sleep(120);
  check('快速甩：她被甩出去了', (await pet.eval('sprites[0].throwRef')) !== null);
  await waitFor(() => pet.eval('sprites[0].throwRef === null'), 10000, '落地');
  g = await geo();
  const work = await main.eval("process.mainModule.require('electron').screen.getDisplayNearestPoint(" + JSON.stringify({ x: Math.round(g.center.x), y: Math.round(g.center.y) }) + ').workArea');
  // 落地 = 脚底（画布 y=330）踩在工作区下沿。身体判定区下沿（y=335）本来就比脚底低一点，不能拿它比
  const feet = g.stage.y + (g.stage.height * 330) / 360;
  const floor = work.y + work.height;
  const landed = Math.abs(feet - floor) <= 3 && g.hit.x >= work.x - 1 && g.hit.x + g.hit.width <= work.x + work.width + 1;
  check('快速甩：落地后脚踩在工作区下沿、身体没出屏幕', landed, `脚底 ${Math.round(feet)}，工作区 ${work.x},${work.y} ${work.width}×${work.height}`);
  await focusBack('快速甩：焦点还给原来的应用');
} catch (e) {
  if (!e.setupOnly) {
    check('测试过程', false, e.message);
    if (stderr.trim()) console.error('\n开发版输出：\n' + stderr.trim().slice(-2000));
  }
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
