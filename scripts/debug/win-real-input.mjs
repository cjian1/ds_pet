// Windows：用真实的系统鼠标事件把桌宠窗口的交互完整走一遍（npm run test:real-input:win）。
//
// 和 real-input.mjs（macOS）一个思路：mouse.ps1 发系统输入事件，先由 Windows 按窗口的「忽略鼠标」状态决定
// 落到哪个窗口，再进页面。另外盯住 Windows 上要紧的一点：点她、拖她、右键她，前台窗口都不变
// （桌宠窗口是 WS_EX_NOACTIVATE，不抢你正在用的窗口的焦点）。为此先开一个「焦点探针」小窗口当作你正在用的应用。
//
// 默认启动开发版（npm start 那一份）；--exe <ds_pet.exe> 测打包好的版本。没装 Node 的电脑上可以拿 ds_pet.exe 当 Node 跑：
//   set ELECTRON_RUN_AS_NODE=1
//   ds_pet.exe scripts\debug\win-real-input.mjs --exe ds_pet.exe
// 用临时数据目录启动（不碰你的设置和聊天记录，也不连 AI 服务）。会接管鼠标大约半分钟，跑完把光标放回原处。
//
// 和 macOS 的不同：
//   · 右键菜单按 Esc 关不掉——她的窗口从不拿键盘焦点（这正是「不抢焦点」的代价），键盘还在你原来的应用里；点别处就关。
//   · 拖图的来源是焦点探针（另一个进程，跟从资源管理器拖一样）：Windows 上 startDrag 会卡住本应用主线程直到松手。
// --out <file> 把结果另存成 JSON；--setup-only 只启动、摆好窗口、打印几何，不动鼠标。
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const require = createRequire(import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MAIN_PORT = 9434;
const PAGE_PORT = 9433;
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : '';
};
const EXE = arg('--exe') ? path.resolve(arg('--exe')) : '';
const OUT = arg('--out');
const SETUP_ONLY = process.argv.includes('--setup-only');
const APP_ROOT = EXE ? path.join(path.dirname(EXE), 'resources', 'app') : path.join(ROOT, 'desktop');
const IMAGE = path.join(APP_ROOT, 'assets', 'memes', '可爱.png');
const PROBE = 'ds_pet focus probe';

if (process.platform !== 'win32') {
  console.error('这个脚本只在 Windows 上跑（macOS 用 npm run test:real-input）');
  process.exit(2);
}

// ---------------------------------------------------------------- 鼠标助手（PowerShell）
function startHelper() {
  const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(HERE, 'mouse.ps1')], {
    stdio: ['pipe', 'pipe', 'inherit'],
    windowsHide: true,
  });
  const lines = readline.createInterface({ input: proc.stdout });
  const waiting = [];
  lines.on('line', (l) => waiting.shift()?.(l.trim()));
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
  let last = '';
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
      last = '';
    } catch (e) {
      last = e.message; // 还没好；超时的时候把最后一次的原因带上
    }
    if (Date.now() - t0 > timeoutMs) throw new Error('等太久了：' + label + (last ? '（' + last + '）' : ''));
    await sleep(200);
  }
}

const targets = async (port) => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json());
const pageTarget = async (part) => (await targets(PAGE_PORT)).find((t) => t.type === 'page' && t.url.includes(part));
/** 主进程里的模块（和应用用的是同一份实例） */
const M = (mod) => `process.mainModule.require('./${mod}')`;

// ---------------------------------------------------------------- 结果
const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? '  — ' + detail : ''));
}

// ---------------------------------------------------------------- 启动
const mouse = startHelper();
const home = (await mouse.cmd('pos')).split(' ').map(Number);
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds_pet-real-input-'));
fs.writeFileSync(
  path.join(dataDir, 'settings.json'),
  JSON.stringify({
    onboarded: true,
    pet: { size: 320, roam: false, liveliness: 'calm' },
    talk: { whisperEnabled: false, balanceEnabled: false },
    app: { language: 'zh', shortcutEnabled: true, shortcut: 'Control+Alt+P', autoUpdate: false },
    position: { rx: 0.62, ry: 0.45 },
  }),
);

const env = Object.assign({}, process.env, { DS_PET_DATA_DIR: dataDir });
delete env.ELECTRON_RUN_AS_NODE;
const [cmd, baseArgs] = EXE ? [EXE, []] : [require('electron'), ['desktop']];
const app = spawn(cmd, [...baseArgs, `--inspect=${MAIN_PORT}`, `--remote-debugging-port=${PAGE_PORT}`], {
  cwd: ROOT,
  env,
  stdio: ['ignore', 'ignore', 'pipe'],
});
let stderr = '';
app.stderr.on('data', (d) => (stderr += d));
let exited = false;
app.on('exit', () => (exited = true));

// 「你正在用的应用」：一个带输入框的小窗口（另一个进程），放在屏幕左上角，不和她重叠
const probe = spawn(
  'powershell.exe',
  [
    '-NoProfile',
    '-Command',
    "Add-Type -AssemblyName System.Windows.Forms; $f = New-Object System.Windows.Forms.Form; $f.Text = '" +
      PROBE +
      "'; $f.StartPosition = 'Manual'; $f.Location = New-Object System.Drawing.Point(30, 30); $f.Size = New-Object System.Drawing.Size(380, 220);" +
      " $l = New-Object System.Windows.Forms.Label; $l.Dock = 'Fill'; $l.TextAlign = 'MiddleCenter'; $l.BackColor = 'LightSkyBlue'; $l.Text = 'drag me';" +
      " $l.Add_MouseDown({ $d = New-Object System.Windows.Forms.DataObject([System.Windows.Forms.DataFormats]::FileDrop, [string[]]@('" +
      IMAGE.replace(/'/g, "''") +
      "')); [void]$l.DoDragDrop($d, 'Copy') }); $f.Controls.Add($l);" +
      " $t = New-Object System.Windows.Forms.TextBox; $t.Multiline = $true; $t.Dock = 'Top'; $t.Height = 70; $f.Controls.Add($t);" +
      " [System.Windows.Forms.Application]::Run($f)",
  ],
  { stdio: 'ignore' },
);

let main;
let pet;
const cleanup = async () => {
  try {
    await mouse.cmd(`move ${home[0]} ${home[1]}`);
  } catch {
    /* 忽略 */
  }
  mouse.close();
  probe.kill();
  main?.close();
  pet?.close();
  if (!exited) app.kill();
  await sleep(800);
  fs.rmSync(dataDir, { recursive: true, force: true });
};

try {
  console.log('启动 ds_pet（临时数据目录）…');
  const mainUrl = await waitFor(async () => (await targets(MAIN_PORT))[0]?.webSocketDebuggerUrl, 30000, '主进程调试端口');
  main = await Cdp.connect(mainUrl);
  await waitFor(() => main.eval(`!!${M('pet-window')}.window()`), 60000, '桌宠窗口'); // x64 版在 ARM 电脑上第一次启动要先转译，慢
  pet = await Cdp.connect((await waitFor(() => pageTarget('/pet/'), 60000, '桌宠页面')).webSocketDebuggerUrl);
  await waitFor(() => pet.eval('window.__dshPetDebug.configOk && sprites.length === 1'), 60000, '桌宠就绪');
  await waitFor(() => main.eval(`${M('pet-window')}.window().isVisible()`), 10000, '桌宠显示');
  await sleep(800);
  const ownPid = await main.eval('process.pid');

  /**
   * DIP（Electron 坐标）→ 物理像素（鼠标助手用的坐标）。先用两个点问一次主进程得出比例，之后本地算：
   * 拖放进行中主进程可能被系统的拖放循环占着，那时候再去问就卡死了（只考虑一块屏幕 / 同一缩放）。
   */
  const [q0, q1] = await main.eval(
    "(() => { const { screen } = process.mainModule.require('electron'); return [screen.dipToScreenPoint({ x: 0, y: 0 }), screen.dipToScreenPoint({ x: 1000, y: 1000 })]; })()",
  );
  const sx = (q1.x - q0.x) / 1000;
  const sy = (q1.y - q0.y) / 1000;
  const phys = async (p) => Math.round(q0.x + p.x * sx) + ' ' + Math.round(q0.y + p.y * sy);
  const geo = async () => {
    const win = await main.eval(`${M('pet-window')}.window().getContentBounds()`);
    const r = await pet.eval(`(() => {
      const s = sprites[0], h = s.hit.getBoundingClientRect(), st = s.stage.getBoundingClientRect();
      return { hit: [h.x, h.y, h.width, h.height], stage: [st.x, st.y, st.width, st.height] };
    })()`);
    const abs = ([x, y, w, h]) => ({ x: win.x + x, y: win.y + y, width: w, height: h });
    const hit = abs(r.hit);
    return { win, hit, stage: abs(r.stage), center: { x: hit.x + hit.width / 2, y: hit.y + hit.height / 2 } };
  };
  const inside = (p, r) => p.x >= r.x && p.x <= r.x + r.width && p.y >= r.y && p.y <= r.y + r.height;

  // ---- 垫在她下面的「接点击」窗口：同一应用的不抢焦点窗口，层级在她之下（不置顶）
  const catcherHtml = `<body style="margin:0;background:#eaf2ff;font:12px 'Segoe UI';color:#36c;user-select:none">
    <div style="position:absolute;left:8px;bottom:6px">ds_pet 真实输入测试</div>
    <script>
      window.__clicks = [];
      addEventListener('mousedown', (e) => __clicks.push({ x: e.screenX, y: e.screenY, button: e.button }));
      addEventListener('dragover', (e) => e.preventDefault());
      addEventListener('drop', (e) => { e.preventDefault(); window.__dropped = (window.__dropped || 0) + 1; });
    </script></body>`;
  const placeCatcher = async (g) => {
    const rect = { x: Math.round(g.win.x), y: Math.round(g.win.y), width: Math.round(g.win.width), height: Math.round(g.win.height) };
    await main.eval(`(() => {
      const { BrowserWindow } = process.mainModule.require('electron');
      const rect = ${JSON.stringify(rect)};
      if (global.__catcher && !global.__catcher.isDestroyed()) { global.__catcher.setBounds(rect); return true; }
      const w = new BrowserWindow(Object.assign({}, rect, {
        show: false, frame: false, focusable: false, skipTaskbar: true, hasShadow: false, resizable: false, thickFrame: false,
        backgroundColor: '#eaf2ff',
        webPreferences: { sandbox: true },
      }));
      global.__catcher = w;
      return w.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(${JSON.stringify(catcherHtml)}))
        .then(() => { w.showInactive(); return true; });
    })()`);
    await sleep(400);
    return rect;
  };
  const catcherClicks = () => main.eval('global.__catcher.webContents.executeJavaScript("window.__clicks.length")');
  let safeArea = null;
  const guard = (p) => {
    if (!inside(p, safeArea)) throw new Error(`坐标 ${Math.round(p.x)},${Math.round(p.y)} 不在测试窗口里，停止`);
  };
  const moveTo = async (p, wait = 200) => {
    guard(p);
    await mouse.cmd('move ' + (await phys(p)));
    await sleep(wait);
  };
  const clickAt = async (p, button = '') => {
    await moveTo(p);
    await mouse.cmd(`click ${await phys(p)} ${button}`.trim());
    await sleep(350);
  };
  const dragPath = async (from, to, steps, stepMs) => {
    for (let i = 1; i <= steps; i++) {
      const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
      await mouse.cmd('drag ' + (await phys(p)));
      await sleep(stepMs);
    }
  };
  const anim = () => pet.eval('sprites[0].anim');
  const clicksPool = await pet.eval('sprites[0].animations.clicks');

  // ---- 焦点探针：点一下它的输入框，让它成为前台窗口
  let probeRect = null;
  const front = async () => JSON.parse(await mouse.cmd('front'));
  const focusProbe = async () => {
    const r = await waitFor(async () => {
      const s = await mouse.cmd('rect ' + PROBE);
      return s.startsWith('error') ? null : s.split(' ').map(Number);
    }, 15000, '焦点探针窗口');
    const [x, y, w, h] = r;
    probeRect = { x, y, w, h };
    await mouse.cmd(`click ${Math.round(x + w / 2)} ${Math.round(y + h * 0.27)}`); // 上面的输入框（下面是拖图用的标签）
    await sleep(400);
    return (await front()).title === PROBE;
  };
  const stillProbe = async (name) => {
    const f = await front();
    check(name, f.title === PROBE, f.title === PROBE ? '前台还是焦点探针' : `前台变成了 ${f.process}「${f.title}」`);
  };

  let g = await geo();
  safeArea = await placeCatcher(g);
  if (!(await focusProbe())) throw new Error('焦点探针没能成为前台窗口：' + JSON.stringify(await front()));
  console.log(`桌宠窗口 ${g.win.x},${g.win.y} ${g.win.width}×${g.win.height}（DIP）；缩放 ${await main.eval("process.mainModule.require('electron').screen.getPrimaryDisplay().scaleFactor")}\n`);
  if (SETUP_ONLY) {
    console.log(JSON.stringify({ hit: g.hit, stage: g.stage, catcher: safeArea, clicks: await catcherClicks() }));
    await sleep(1500);
    throw Object.assign(new Error('setup-only'), { setupOnly: true });
  }

  // 1. 悬停在她身上：渲染端收到转发的 mousemove，翻成可交互
  await moveTo(g.center, 500);
  check('光标移到她身上：变成可交互', await pet.eval('window.__dshPetDebug.interactive === true'));

  // 2. 点她：播点击回应，点击不穿透，前台窗口不变
  let before = await catcherClicks();
  await clickAt(g.center);
  await sleep(300);
  const a = await anim();
  check('点她：播放点击回应动画', clicksPool.includes(a), a);
  check('点她：点击没有穿透到下面', (await catcherClicks()) === before);
  await stillProbe('点她：不抢焦点');

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
  await moveTo(g.center, 300);
  const win0 = g.win;
  const to = { x: g.center.x + 140, y: g.center.y - 50 };
  await mouse.cmd('down ' + (await phys(g.center)));
  await sleep(80);
  await dragPath(g.center, to, 20, 30);
  check('拖拽中：主进程收到「正在用输入」', await pet.eval('window.__dshPetDebug.inputBusy === true'));
  await sleep(400);
  await mouse.cmd('up ' + (await phys(to)));
  await sleep(600);
  g = await geo();
  const dx = g.win.x - win0.x;
  const dy = g.win.y - win0.y;
  check('慢慢拖：她跟着走了同样的距离', Math.abs(dx - 140) <= 12 && Math.abs(dy + 50) <= 12, `位移 ${dx},${dy}`);
  check('慢慢拖：松手后没有被甩出去', (await pet.eval('sprites[0].throwRef')) === null);
  check('慢慢拖：松手后交还常规判定', await pet.eval('window.__dshPetDebug.inputBusy === false'));
  await stillProbe('慢慢拖：不抢焦点');
  safeArea = await placeCatcher(g);

  // 6. 右键：菜单弹出；点别处关掉（Esc 关不掉，见文件开头）；之后透明区照样穿透
  await clickAt(g.center, 'right');
  await sleep(400);
  check('右键她：弹出菜单', await pet.eval('window.__dshPetDebug.menuOpen === true'));
  await stillProbe('右键菜单开着：不抢焦点');
  await mouse.cmd('click ' + (await phys({ x: g.win.x + 20, y: g.win.y + 20 })));
  await sleep(600);
  check('点别处：菜单关掉', await pet.eval('window.__dshPetDebug.menuOpen === false'));
  before = await catcherClicks();
  await clickAt({ x: g.win.x + 20, y: g.win.y + 20 });
  check('菜单关掉后：透明区照样穿透', (await catcherClicks()) === before + 1);

  // 7. 把图片拖到她身边（不是她身上）：她不接，也不亮；拖到她身上：亮一圈，打开聊天面板并带上这张图
  /** 从焦点探针下半部的标签（另一个进程的拖放源）把图拖到 target（物理坐标起步，DIP 终点） */
  const dragImageTo = async (target) => {
    guard(target);
    const from = { x: Math.round(probeRect.x + probeRect.w / 2), y: Math.round(probeRect.y + probeRect.h * 0.75) };
    await mouse.cmd(`move ${from.x} ${from.y}`);
    await sleep(200);
    await mouse.cmd(`down ${from.x} ${from.y}`);
    await sleep(300); // 探针在按下时进入系统拖放循环
    const [tx, ty] = (await phys(target)).split(' ').map(Number);
    for (let i = 1; i <= 30; i++) {
      await mouse.cmd(`drag ${Math.round(from.x + ((tx - from.x) * i) / 30)} ${Math.round(from.y + ((ty - from.y) * i) / 30)}`);
      await sleep(30);
    }
    for (let i = 0; i < 8; i++) {
      await mouse.cmd(`drag ${tx + (i % 2) * 3} ${ty}`); // 在目标上轻轻晃，让系统持续派发 dragover
      await sleep(100);
    }
    const glow = await pet.eval("sprites[0].el.classList.contains('is-drop-target')");
    await mouse.cmd(`up ${tx} ${ty}`);
    await sleep(1500);
    return glow;
  };
  const chatOpen = () => main.eval(`${M('chat-window')}.isVisible()`);
  const besideNow = { x: g.stage.x + g.stage.width * 0.12, y: g.center.y };
  const glowBeside = await dragImageTo(besideNow);
  check('拖图到她身边：她不亮', glowBeside === false);
  check('拖图到她身边：不打开聊天', (await chatOpen()) === false);
  const glowBody = await dragImageTo(g.center);
  check('拖图到她身上：身上亮一圈', glowBody === true);
  check('拖图到她身上：打开聊天面板', (await chatOpen()) === true);
  if (await chatOpen()) {
    const chat = await Cdp.connect((await waitFor(() => pageTarget('/chat/'), 5000, '聊天页面')).webSocketDebuggerUrl);
    const attached = await waitFor(
      () => chat.eval("!document.getElementById('attach-preview').hidden && document.getElementById('attach-img').src.startsWith('data:image/')"),
      5000,
      '附图',
    ).catch(() => false);
    check('拖图到她身上：图片已经放进输入框', attached);
    const f = await front();
    check('拖图到她身上：聊天面板到了前台（这次是要用它）', f.pid === ownPid, `${f.process}「${f.title}」`);
    chat.close();
    await main.eval(`${M('chat-window')}.hide(), true`);
    await sleep(300);
  }

  // 8. 甩出去：飞行、落地，停在屏幕里（先把焦点还给探针）
  await focusProbe();
  g = await geo();
  safeArea = { x: g.win.x - 400, y: g.win.y - 200, width: g.win.width + 800, height: g.win.height + 400 };
  await moveTo(g.center, 300);
  await mouse.cmd('down ' + (await phys(g.center)));
  await sleep(60);
  await dragPath(g.center, { x: g.center.x - 260, y: g.center.y - 40 }, 6, 12);
  await mouse.cmd('up ' + (await phys({ x: g.center.x - 260, y: g.center.y - 40 })));
  await sleep(120);
  check('快速甩：她被甩出去了', (await pet.eval('sprites[0].throwRef')) !== null);
  await waitFor(() => pet.eval('sprites[0].throwRef === null'), 10000, '落地');
  g = await geo();
  const work = await main.eval(
    "process.mainModule.require('electron').screen.getDisplayNearestPoint(" + JSON.stringify({ x: Math.round(g.center.x), y: Math.round(g.center.y) }) + ').workArea',
  );
  const feet = g.stage.y + (g.stage.height * 330) / 360;
  const floor = work.y + work.height;
  const landed = Math.abs(feet - floor) <= 3 && g.hit.x >= work.x - 1 && g.hit.x + g.hit.width <= work.x + work.width + 1;
  check('快速甩：落地后脚踩在工作区下沿（任务栏上面）、身体没出屏幕', landed, `脚底 ${Math.round(feet)}，工作区 ${work.x},${work.y} ${work.width}×${work.height}`);
  await stillProbe('快速甩：不抢焦点');

  // 9. 全局快捷键 Ctrl+Alt+P：藏起来 / 叫出来
  await mouse.cmd('key ctrl+alt+p');
  await sleep(800);
  check('Ctrl+Alt+P：她藏起来了', (await main.eval(`${M('pet-window')}.isVisible()`)) === false);
  await mouse.cmd('key ctrl+alt+p');
  await sleep(1500);
  check('再按 Ctrl+Alt+P：她回来了', (await main.eval(`${M('pet-window')}.isVisible()`)) === true);

  // 10. 安装程序用的 --quit：再启动一份带 --quit 的，正在运行的这一份正常退出
  if (EXE) {
    main.close();
    main = null;
    pet.close();
    pet = null;
    spawn(EXE, ['--quit'], { env, stdio: 'ignore' });
    const t0 = Date.now();
    while (!exited && Date.now() - t0 < 15000) await sleep(200);
    check('ds_pet.exe --quit：正在运行的她正常退出', exited, `${Date.now() - t0}ms`);
  }
} catch (e) {
  if (!e.setupOnly) {
    check('测试过程', false, e.message);
    if (stderr.trim()) console.error('\n应用输出：\n' + stderr.trim().slice(-2000));
  }
} finally {
  await cleanup();
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (OUT) fs.writeFileSync(OUT, JSON.stringify({ passed: results.length - failed, total: results.length, results }, null, 2));
process.exit(failed ? 1 : 0);
