// 能耗探针：量「她开着 / 藏起来」时整个应用进程树的 CPU 占用（能耗的代理指标）。
//
//   node scripts/debug/energy-probe.mjs [每段秒数，默认 10]
//
// 做法：用临时数据目录启动开发版（不碰你的设置，也不连 AI），
//   1) 等她起来，确认桌宠页面正常、配置加载成功；
//   2) 采样 10s —— 可见状态；
//   3) 通过主进程调试口把窗口藏起来，确认渲染端视频真的暂停了；
//   4) 再采样 10s —— 隐藏状态；
//   5) 叫回来，确认视频恢复播放；
//   6) 运行时自检：锁屏挂起是否也停视频、主人离开时她是否歇着、改名是否走轻量通道（不重载页面）；
//   7) 退出、清理临时目录。
//
// CPU 用 `ps -o time` 的累计 CPU 时间做差算平均利用率（比 %CPU 的衰减平均更可靠）。
// 会短暂在桌面上出现一次桌宠（不抢焦点），跑完自动关掉。
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const require = createRequire(import.meta.url);
const ELECTRON = require('electron');
const PAGE_PORT = 9333;
const NODE_PORT = 9334;
const SECONDS = Math.max(3, Number(process.argv[2]) || 10);
/** 预置多少轮聊天记录（每条回复都带表情包）；传 0 可以对照「开面板本身」的开销 */
const SEED_PAIRS = Math.max(0, Number(process.argv[3] ?? 40));
/** 桌宠尺寸覆盖（不传用默认 420）：对比窗口大小对能耗的影响 —— 窗口 = 尺寸 + 四周各半只 */
const PET_SIZE = Number(process.argv[4] || 0);
/** --fast：跳过 90s 长跑段（调别的东西时用，快 1.5 分钟） */
const SKIP_SOAK = process.argv.includes('--fast');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- CDP
async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let id = 0;
  const pending = new Map();
  const fail = (err) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.rej(err);
    }
    pending.clear();
  };
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    const p = m.id && pending.get(m.id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(m.id);
      p.res(m);
    }
  });
  ws.addEventListener('close', () => fail(new Error('CDP 连接已断开（窗口多半被重建了）')));
  ws.addEventListener('error', () => fail(new Error('CDP 连接出错')));
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  return {
    // 一定要有超时：窗口重建后旧连接不再回消息，没有超时就会永远挂住
    call(method, params = {}, timeoutMs = 15000) {
      return new Promise((res, rej) => {
        const i = ++id;
        const timer = setTimeout(() => {
          pending.delete(i);
          rej(new Error('CDP 超时：' + method));
        }, timeoutMs);
        pending.set(i, { res, rej, timer });
        ws.send(JSON.stringify({ id: i, method, params }));
      });
    },
    close() {
      ws.close();
    },
  };
}

async function evaluate(cdp, expression) {
  const r = await cdp.call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  const res = r.result || {};
  if (res.exceptionDetails) throw new Error('页面里报错：' + JSON.stringify(res.exceptionDetails));
  return res.result ? res.result.value : undefined;
}

async function findTarget(port, pick) {
  for (let i = 0; i < 60; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const hit = list.find(pick);
      if (hit && hit.webSocketDebuggerUrl) return hit.webSocketDebuggerUrl;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error(`等不到调试目标（:${port}）`);
}

// ---------------------------------------------------------------- CPU 采样
function parseCpuTime(s) {
  const parts = String(s).trim().split(':').map(Number);
  return parts.reduce((acc, p) => acc * 60 + p, 0); // [[hh:]mm:]ss.ss → 秒
}

function psRows() {
  return execFileSync('ps', ['-Ao', 'pid=,ppid=,time=,rss=,comm='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => {
      const m = /^\s*(\d+)\s+(\d+)\s+([\d:.]+)\s+(\d+)\s+(.*)$/.exec(line);
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), cpu: parseCpuTime(m[3]), rss: Number(m[4]), comm: m[5] } : null;
    })
    .filter(Boolean);
}

/** 主进程 + 它的全部后代（主进程 / GPU / 各渲染进程） */
function appTree(rootPid) {
  const rows = psRows();
  const byPid = new Map(rows.map((r) => [r.pid, r]));
  const kids = new Map();
  for (const r of rows) {
    if (!kids.has(r.ppid)) kids.set(r.ppid, []);
    kids.get(r.ppid).push(r.pid);
  }
  const out = [];
  const stack = [rootPid];
  while (stack.length) {
    const pid = stack.pop();
    const row = byPid.get(pid);
    if (row) out.push(row);
    for (const c of kids.get(pid) || []) stack.push(c);
  }
  return out;
}

const sum = (rows, key) => rows.reduce((n, r) => n + r[key], 0);

async function measure(rootPid, label) {
  const t0 = Date.now();
  const before = new Map(appTree(rootPid).map((r) => [r.pid, r.cpu]));
  await sleep(SECONDS * 1000);
  const tree = appTree(rootPid);
  const dt = (Date.now() - t0) / 1000;
  // 每个进程的累计 CPU 时间做差 → 这一段里的平均利用率（比 %CPU 的衰减平均可靠）
  const rows = tree
    .map((r) => ({
      pid: r.pid,
      rss: r.rss,
      comm: r.comm.replace(ROOT + '/', ''),
      cpu: ((r.cpu - (before.has(r.pid) ? before.get(r.pid) : r.cpu)) / dt) * 100,
    }))
    .sort((a, b) => b.cpu - a.cpu);
  const cpu = rows.reduce((n, r) => n + r.cpu, 0);
  const rss = sum(tree, 'rss') / 1024;
  console.log(`  ${label.padEnd(6)} 合计 CPU ${cpu.toFixed(1).padStart(5)}%   常驻内存 ${rss.toFixed(0)} MB   进程 ${tree.length} 个（${dt.toFixed(1)}s）`);
  for (const r of rows.slice(0, 4)) {
    console.log(`         ${r.cpu.toFixed(1).padStart(5)}%  ${(r.rss / 1024).toFixed(0).padStart(4)} MB  ${r.comm}`);
  }
  return cpu;
}

// ---------------------------------------------------------------- 主流程
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ds_pet-energy-'));
let app = null;
const SPAWN_AT = Date.now();

// 预置一段长聊天记录（每条回复都带表情包）：用来量「开面板时要解码多少张图」
const MEMES = fs
  .readdirSync(path.join(ROOT, 'desktop', 'assets', 'memes'))
  .filter((f) => f.endsWith('.png'))
  .map((f) => f.slice(0, -4));
{
  const messages = [];
  const base = Date.now() - SEED_PAIRS * 2 * 60000;
  for (let i = 0; i < SEED_PAIRS; i++) {
    messages.push({ role: 'user', content: '第 ' + (i + 1) + ' 句话', ts: base + i * 2 * 60000 });
    messages.push({ role: 'assistant', content: '回复 ' + (i + 1), image: MEMES[i % MEMES.length], ts: base + i * 2 * 60000 + 1000 });
  }
  fs.writeFileSync(path.join(dataDir, 'memory.json'), JSON.stringify({ main: { main: { messages, updatedAt: Date.now() } } }));
  // 放一个假 Key：这样「碎碎念 / 报余额」循环是真正武装着的（更贴近真实使用），
  // 但默认周期 900s / 1800s，探针跑完也不会真去联网。
  fs.writeFileSync(
    path.join(dataDir, 'settings.json'),
    JSON.stringify({ ai: { provider: 'deepseek', providers: { deepseek: { apiKey: 'sk-probe-not-real' } } } }, null, 2),
  );
}


function killApp(signal) {
  if (!app || app.exitCode !== null) return;
  try {
    process.kill(-app.pid, signal); // 整个进程组（主进程 / GPU / 各渲染进程）
  } catch {
    try {
      app.kill(signal);
    } catch {
      /* 已经没了 */
    }
  }
}

/** 等应用真的退出，再删临时数据目录（它退出前还会往里写东西） */
async function cleanup() {
  killApp('SIGTERM');
  await Promise.race([once(app, 'exit'), sleep(5000)]);
  killApp('SIGKILL');
  try {
    fs.rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch {
    /* 删不掉就留个临时目录，不影响结论 */
  }
}
process.on('exit', () => killApp('SIGTERM'));
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143)); // 上面两句保证中途被杀也能带走应用，不留孤儿

app = spawn(ELECTRON, ['desktop', `--inspect=${NODE_PORT}`, `--remote-debugging-port=${PAGE_PORT}`], {
  cwd: ROOT,
  env: { ...process.env, DS_PET_DATA_DIR: dataDir },
  stdio: ['ignore', 'pipe', 'pipe'],
  detached: true,
});
const logs = [];
app.stdout.on('data', (d) => logs.push(String(d)));
app.stderr.on('data', (d) => logs.push(String(d)));
let exited = false;
app.on('exit', () => {
  exited = true;
});

try {
  console.log('启动开发版（临时数据目录，不碰你的设置）…');
  const pageWs = await findTarget(PAGE_PORT, (t) => t.type === 'page' && t.url.includes('pet/index.html'));
  const nodeWs = await findTarget(NODE_PORT, (t) => t.type === 'node');
  let page = await connect(pageWs);
  const main = await connect(nodeWs);

  // 等她加载好
  for (let i = 0; i < 40; i++) {
    const ok = await evaluate(page, 'window.__dshPetDebug && window.__dshPetDebug.configOk === true');
    if (ok) break;
    await sleep(500);
  }
  await sleep(3000); // 让视频缓冲、物理稳定
  const started = await evaluate(page, 'window.__dshPetDebug.configOk === true && window.__dshPetDebug.spriteCount');
  if (!started) throw new Error('桌宠页面没起来：' + logs.join('').slice(-800));
  console.log('桌宠已就绪。\n');

  // 启动耗时分布（都用页面自己的时间戳，不含探针轮询的误差）
  const nav = await evaluate(
    page,
    '({ origin: Math.round(performance.timeOrigin), dcl: Math.round(performance.getEntriesByType("navigation")[0].domContentLoadedEventEnd), bootAt: window.__dshPetDebug.bootAt || 0 })',
  );
  console.log(
    `启动：spawn → 页面开始加载 ${nav.origin - SPAWN_AT} ms，页面 DCL ${nav.dcl} ms，脚本就绪 ${nav.bootAt - SPAWN_AT} ms\n`,
  );

  // 排除一次性干扰：启动 15s 后那次自动检查更新会落在第一段采样里，先关掉（只剩 6h 一次的周期）
  await evaluate(main, 'global.__whale.store.update({ app: { autoUpdate: false } }); "ok"');
  if (PET_SIZE) {
    await evaluate(main, `global.__whale.store.update({ pet: { size: ${PET_SIZE} } }); "sized"`);
    // 改尺寸会重建窗口：旧页面的调试连接随旧渲染进程一起没了，必须重连新的
    await sleep(1500);
    try {
      page.close();
    } catch {
      /* 已经断了 */
    }
    page = await connect(await findTarget(PAGE_PORT, (t) => t.type === 'page' && t.url.includes('pet/index.html')));
    for (let i = 0; i < 40; i++) {
      const ok = await evaluate(page, 'window.__dshPetDebug && window.__dshPetDebug.configOk === true').catch(() => false);
      if (ok) break;
      await sleep(500);
    }
    await sleep(2000);
    console.log(`（已把尺寸设为 ${PET_SIZE}）`);
  }

  // 基线采样先关掉「自己走动」：她漫游时每帧都要移动窗口，那份成本会混进基础数字、让多次运行不可比
  // （跟随链路另有专项检查，那里会显式让她走一次）。采样完再恢复。
  await evaluate(main, 'global.__whale.store.update({ pet: { roam: false } }); "no-roam"');
  // 再固定成同一段待机动画：不同动画的运动量/码率差别很大，随机播哪段会让基础数字在 15%–25% 之间乱跳
  await evaluate(page, 'sprites[0].stopMove(); sprites[0].switchTo("待机呼吸休闲", false); "fixed-anim"');
  await sleep(600);

  // 顺便看 Chromium 认不认「这个页面不可见」：认的话就能靠 visibilitychange 自动覆盖
  // 「被全屏应用挡住 / 息屏」这些我们自己收不到信号的场景
  const playing =
    '(() => ({ paused: Array.from(document.querySelectorAll("video.pet-video")).map(v => v.paused).join(","), vis: document.visibilityState }))()';
  const showPlayState = async (note) => {
    const st = await evaluate(page, playing);
    console.log(`    视频 paused: ${st.paused}   visibilityState=${st.vis}  ${note}`);
  };

  console.log(`采样（每段 ${SECONDS}s）：`);
  const sent0 = await evaluate(page, 'window.__dshPetDebug.boundsSent || 0');
  const poll0 = await evaluate(main, 'global.__whale.petWindow.stats().ticks');
  const cap0 = await evaluate(main, 'global.__whale.focusReturn.stats().captures');
  // 采样期间顺带看她有没有走动（窗口位置变过几个），用来确认「跟随」链路没被去重挡掉
  await evaluate(
    main,
    '(() => { const w = global.__whale.petWindow.window(); global.__probeSeen = new Set(); global.__probeTimer = setInterval(() => { const b = w.getBounds(); global.__probeSeen.add(b.x + "," + b.y); }, 150); return "started"; })()',
  );
  const visibleCpu = await measure(app.pid, '可见');
  const sent1 = await evaluate(page, 'window.__dshPetDebug.boundsSent || 0');
  const poll1 = await evaluate(main, 'global.__whale.petWindow.stats()');
  const cap1 = await evaluate(main, 'global.__whale.focusReturn.stats().captures');
  const seen = await evaluate(
    main,
    '(() => { clearInterval(global.__probeTimer); const n = global.__probeSeen.size; delete global.__probeTimer; delete global.__probeSeen; return n; })()',
  );
  console.log(`    窗口跟随 IPC ${sent1 - sent0} 条 / ${SECONDS}s = ${((sent1 - sent0) / SECONDS).toFixed(1)} 条/秒`);
  console.log(
    `    兜底轮询 ${poll1.ticks - poll0} 次 / ${SECONDS}s（快 ${poll1.fast} 慢 ${poll1.slow} 累计）`,
  );
  console.log(
    `    焦点采样 ${cap1 - cap0} 次 / ${SECONDS}s（每次 2 个 lsappinfo 进程）  光标在她身上=${poll1.onBody}`,
  );
  console.log(`    她走动到过 ${seen} 个不同位置（>1 说明窗口跟随仍在工作）`);
  await showPlayState('（false = 在放）');
  // 环境变量：气泡层是否在场、以及实际刷新率（合成成本随刷新率线性变化）
  const env = await evaluate(
    page,
    '(async () => {' +
      ' const v = document.querySelector("video.pet-video.is-front") || document.querySelector("video.pet-video");' +
      ' const vt0 = v ? v.currentTime : 0;' +
      ' let n = 0; const t0 = performance.now();' +
      ' await new Promise((res) => { const step = () => { n++; if (performance.now() - t0 > 1000) res(); else requestAnimationFrame(step); }; requestAnimationFrame(step); });' +
      ' const hz = Math.round((n * 1000) / (performance.now() - t0));' +
      ' const adv = v ? v.currentTime - vt0 : -1;' +
      ' return { hz, adv, bubble: sprites[0].bubble.classList.contains("is-on"), anim: sprites[0].anim, win: innerWidth + "x" + innerHeight };' +
      '})()',
  );
  console.log(
    `    画布 ${env.win}  实际 rAF ${env.hz} Hz  1s 内视频推进 ${env.adv.toFixed(2)}s（≈1.00 = 没被节流）  气泡在场=${env.bubble}`,
  );
  await evaluate(main, 'global.__whale.store.update({ pet: { roam: true } }); "roam-back"'); // 基线采完，恢复漫游
  await evaluate(page, 'sprites[0].playIdle(); "anim-back"'); // 交回正常的随机动画链

  // 可见但视频停下：把「透明窗口本身的合成」与「视频解码 + 视频合成」分开。
  // 注意不能自己 forEach(v => v.pause())——动画链随后会切下一条视频、又自己播起来（实测暂停没保持住），
  // 必须走应用真正的挂起通道（锁屏那条），它同时停视频与定时任务。
  await evaluate(main, 'global.__whale.petWindow.setScreenLocked(true); "locked"');
  await sleep(1500);
  await showPlayState('（暂停中，应为 true,true）');
  const stillCpu = await measure(app.pid, '视频暂停');
  await evaluate(main, 'global.__whale.petWindow.setScreenLocked(false); "unlocked"');
  await sleep(500);

  // 藏起来（走的就是「隐藏」那条链路：停轮询 + 挂起视频与定时任务）
  const pollBeforeHide = await evaluate(main, 'global.__whale.petWindow.stats().ticks');
  await evaluate(main, 'global.__whale.ctx().setVisible(false); "hidden"'); // 走真实链路（app.visible 也要翻转）
  await sleep(2000);
  const hiddenCpu = await measure(app.pid, '隐藏');
  await showPlayState('（true = 已停解码）');
  const hiddenPoll = await evaluate(main, 'global.__whale.petWindow.stats()');
  console.log(
    `    隐藏期间兜底轮询新增 ${hiddenPoll.ticks - pollBeforeHide} 次（应为 0）  appVisible=${hiddenPoll.appVisible}`,
  );

  // 叫回来
  await evaluate(main, 'global.__whale.ctx().setVisible(true); "shown"');
  await sleep(2000);
  await showPlayState('（恢复播放）');

  // ---- 运行时自检（不改变可见行为，只看状态） ----
  console.log('\n运行时自检：');
  // 右键 / 托盘菜单的真实构建耗时（含 Electron 原生那部分；JS 模板本身只要 0.03ms）
  const menuMs = await evaluate(
    main,
    '(() => { const t0 = performance.now(); for (let i = 0; i < 3; i++) { global.__whale.menus.petMenu(global.__whale.ctx()); global.__whale.menus.trayMenu(global.__whale.ctx()); } return Math.round(((performance.now() - t0) / 3) * 10) / 10; })()',
  );
  console.log(`  菜单构建（右键 + 托盘，各一次，含原生）: ${menuMs} ms`);
  // 动画切换的加载耗时：每段播完都要换下一段，加载慢的话她会在切换瞬间定格一下
  const animLoadMs = await evaluate(
    page,
    '(async () => {' +
      ' const s = sprites[0];' +
      ' const back = s.front === 0 ? s.videoB : s.videoA;' +
      ' const t0 = performance.now();' +
      ' await new Promise((res) => {' +
      '   const done = () => { clearTimeout(t); back.removeEventListener("loadeddata", done); res(); };' +
      '   const t = setTimeout(done, 5000);' +
      '   back.addEventListener("loadeddata", done);' +
      '   back.src = s.assetBase + encodeURIComponent("原地跳跃抓碎头顶物品") + ".webm";' +
      '   back.loop = false; back.load();' +
      ' });' +
      ' const dt = Math.round(performance.now() - t0);' +
      ' back.pause();' +
      ' return dt;' +
      '})()',
  );
  console.log(`  动画素材加载到可播首帧: ${animLoadMs} ms（切换时的定格时长上限）`);

  // 命中判定（渲染端那一半）：用 DevTools 的输入管线合成 mousemove —— 它绕过 macOS 窗口服务器
  // （所以测不到真正的「点穿到下层应用」，那需要真实鼠标事件），但会**真实走到**页面的命中判定：
  // 命中区公式（hit-rect.js）+ 精灵在窗口内的余量偏移，都是我这几轮改过的地方。
  // 读 __dshPetDebug.interactive 而不是主进程的 ignoring：后者会被「按真实光标位置」的兜底轮询
  // 覆盖掉（合成光标与真实光标不一致时两者天然打架），而 interactive 只由渲染端自己的判定决定。
  const geo = await evaluate(
    page,
    '(() => { const s = sprites[0]; return { m: s.margin.l, hit: s.hitRect, win: innerWidth + "x" + innerHeight }; })()',
  );
  const moveTo = async (x, y) => {
    await page.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', clickCount: 0 });
    await sleep(150);
    return evaluate(page, 'window.__dshPetDebug.interactive');
  };
  const onBody = await moveTo(geo.m + geo.hit.x + geo.hit.w / 2, geo.m + geo.hit.y + geo.hit.h / 2);
  const onMargin = await moveTo(4, 4); // 窗口左上角 = 透明余量
  const onBelow = await moveTo(geo.m + geo.hit.x + geo.hit.w / 2, geo.m + geo.hit.y + geo.hit.h + 30); // 脚下（命中区外）
  console.log(
    `  命中判定：画布 ${geo.win}  压在她身上→可交互=${onBody}（应 true）  移到透明余量→${onMargin}（应 false）  脚下偏出命中区→${onBelow}（应 false）`,
  );

  // 焦点归还的**真实系统调用**：单测里 sys.frontPid 是假的，这里确认 lsappinfo 真能取到最前面的应用
  const focusPid = await (async () => {
    for (let i = 0; i < 4; i++) {
      await evaluate(main, 'global.__whale.focusReturn.pointerNear(); "cap"');
      await sleep(1200);
      const st = await evaluate(main, 'global.__whale.focusReturn.stats()');
      if (st.saved) return st.saved;
    }
    return null;
  })();
  console.log(`  焦点采样：lsappinfo 真取到的最前面应用 pid=${focusPid}（应为正数；空=本应用在前台或取不到）`);
  const bootAt = await evaluate(page, 'window.__dshPetDebug.bootAt');

  // 跟随链路：强制让她走一次，看去重之后窗口还在正常移动、IPC 降了多少
  const sentBeforeMove = await evaluate(page, 'window.__dshPetDebug.boundsSent || 0');
  const moveMs = 6000;
  await evaluate(
    main,
    '(() => { const w = global.__whale.petWindow.window(); global.__probeSeen = new Set(); global.__probeTimer = setInterval(() => { const b = w.getBounds(); global.__probeSeen.add(b.x + "," + b.y); }, 100); return "started"; })()',
  );
  const walk = await evaluate(
    page,
    '(() => { const a = sprites[0].animations.moves.actions; return a.length ? String(sprites[0].tryMove(a[0].name)) : "no-move-anim"; })()',
  );
  await sleep(moveMs);
  const sentAfterMove = await evaluate(page, 'window.__dshPetDebug.boundsSent || 0');
  const movedTo = await evaluate(
    main,
    '(() => { clearInterval(global.__probeTimer); const n = global.__probeSeen.size; delete global.__probeTimer; delete global.__probeSeen; return n; })()',
  );
  const perSec = (sentAfterMove - sentBeforeMove) / (moveMs / 1000);
  console.log(
    `  跟随链路：走动中到过 ${movedTo} 个位置，发 ${sentAfterMove - sentBeforeMove} 条 IPC（${perSec.toFixed(
      1,
    )} 条/秒，未去重约 60）  triggered=${walk}`,
  );

  // 锁屏：走的是同一条挂起链路（主进程 powerMonitor 事件无法在这里伪造，直接调它的处理函数）
  await evaluate(main, 'global.__whale.petWindow.setScreenLocked(true); "locked"');
  await sleep(500);
  const lockedPaused = (await evaluate(page, playing)).paused;
  await evaluate(main, 'global.__whale.petWindow.setScreenLocked(false); "unlocked"');
  await sleep(500);
  const unlockedPaused = (await evaluate(page, playing)).paused;
  console.log(`  锁屏挂起：锁屏后 paused=${lockedPaused}（应为 true,true）→ 解锁后 ${unlockedPaused}（应有一个 false）`);

  // 藏着时她被叫去「说话」（聊天面板回话）：藏着期间不该解码，叫回来要接着播（曾经定格不动）
  await evaluate(main, 'global.__whale.ctx().setVisible(false); "hidden"');
  await evaluate(main, 'global.__whale.petWindow.send("pet:action", { type: "talk" }); "talk"');
  await sleep(800);
  const talkHidden = (await evaluate(page, playing)).paused;
  await evaluate(main, 'global.__whale.ctx().setVisible(true); "shown"');
  await sleep(1200);
  const talkShown = (await evaluate(page, playing)).paused;
  console.log(`  藏着时说话：藏着 paused=${talkHidden}（应为 true,true）→ 叫回来 ${talkShown}（应有一个 false）`);

  // 主人离开：播完手上这段 → 打个盹 → 停在最后一帧歇着（不解码）；回来接着播。
  // 主进程按系统空闲时间推 pet:away（5 分钟），这里直接推，并把正在播的段落快进到结尾。
  const front = 'const v = sprites[0].front === 0 ? sprites[0].videoA : sprites[0].videoB;';
  const skipToEnd = '(() => {' + front + ' v.currentTime = Math.max(0, v.duration - 0.2); return "ff"; })()';
  await evaluate(main, 'global.__whale.petWindow.send("pet:away", true); "away"');
  // 当前这段播完 → 打盹那段播完 → 歇着；已经歇着就别再拖进度（会把「播完」状态拖没）
  for (let i = 0; i < 4 && !(await evaluate(page, 'sprites[0].resting')); i++) {
    await evaluate(page, skipToEnd);
    await sleep(900);
  }
  const rest = await evaluate(page, '(() => {' + front + ' return { resting: sprites[0].resting, ended: v.ended, anim: sprites[0].anim }; })()');
  await evaluate(main, 'global.__whale.petWindow.send("pet:away", false); "back"');
  await sleep(1200);
  const woke = await evaluate(page, '(() => {' + front + ' return { resting: sprites[0].resting, paused: v.paused }; })()');
  console.log(
    `  主人离开：歇着=${rest.resting} 视频播完=${rest.ended}（都应 true，最后一段=${rest.anim}）→ 回来 歇着=${woke.resting} paused=${woke.paused}（都应 false）`,
  );

  // 改名：应只换 title，不重载页面（bootAt 不变）
  await evaluate(main, 'global.__whale.store.update({ pet: { name: "探针改名" } }); "renamed"');
  await sleep(600);
  const after = await evaluate(
    page,
    '({ title: document.querySelector("video.pet-video").title, bootAt: window.__dshPetDebug.bootAt })',
  );
  const reloaded = after.bootAt !== bootAt;
  console.log(`  改名通道：title=${JSON.stringify(after.title)}  页面重载=${reloaded}（应为 false）`);
  await evaluate(main, 'global.__whale.store.update({ pet: { name: "" } }); "restored"');

  // 行为类设置就地生效：改「自己走动」「自动碎碎念」都不该重载页面（重载 = 她从头开始播动画）
  const cfg0 = await evaluate(
    page,
    '({ move: sprites[0].weights.move, whisper: sprites[0].pet.whisperEnabled, timer: sprites[0].whisperLoopTimer !== null, bootAt: window.__dshPetDebug.bootAt })',
  );
  await evaluate(
    main,
    'global.__whale.store.update({ pet: { roam: false }, talk: { whisperEnabled: false } }); "off"',
  );
  // 另外四个行为字段走同一条通道，一并验（它们各自在「挑动画 / 拖拽抛掷 / 回初始位置」时才读）
  await evaluate(
    main,
    'global.__whale.store.update({ pet: { liveliness: "calm", throwPower: 1.4, confineToScreen: true, corner: "top-left" } }); "off2"',
  );
  await sleep(400);
  const cfg1 = await evaluate(
    page,
    '({ move: sprites[0].weights.move, idle: sprites[0].weights.idle, power: sprites[0].physics.throwPower, confine: sprites[0].confineToScreen, corner: sprites[0].pet.position.corner, whisper: sprites[0].pet.whisperEnabled, timer: sprites[0].whisperLoopTimer !== null, bootAt: window.__dshPetDebug.bootAt })',
  );
  console.log(
    `  行为设置就地生效：走动权重 ${cfg0.move}→${cfg1.move}  待机权重→${cfg1.idle}  甩力→${cfg1.power}  ` +
      `锁定屏内→${cfg1.confine}  角落→${cfg1.corner}  碎碎念 ${cfg0.whisper}/${cfg0.timer}→${cfg1.whisper}/${cfg1.timer}  ` +
      `页面重载=${cfg1.bootAt !== cfg0.bootAt}（应为 false）`,
  );
  await evaluate(
    main,
    'global.__whale.store.update({ pet: { roam: true, liveliness: "normal", throwPower: 1, confineToScreen: false, corner: "bottom-right" }, talk: { whisperEnabled: true } }); "restored"',
  );

  // 可见性通道：不经过主进程的挂起 IPC，直接把窗口藏起来（等价于被全屏应用挡住 / 息屏）。
  // Chromium 不会因为页面不可见就停 <video>，所以省电必须靠渲染端自己响应 visibilitychange。
  await evaluate(main, 'global.__whale.petWindow.window().hide(); "hid-direct"');
  // 时间序列：可见性到底会不会翻转、多久翻（信号不稳定的话这里看得出来）
  const visTrail = await evaluate(
    page,
    '(async () => { const out = []; for (let i = 0; i < 10; i++) { out.push(document.visibilityState === "hidden" ? "H" : "v"); await new Promise((r) => setTimeout(r, 200)); } return out.join(""); })()',
  );
  const appActive = await evaluate(main, 'global.__whale.focusReturn.stats().active');
  const visRes = await evaluate(
    page,
    '({ vis: document.visibilityState, paused: Array.from(document.querySelectorAll("video.pet-video")).map((v) => v.paused).join(",") })',
  );
  await evaluate(main, 'global.__whale.petWindow.window().showInactive(); "shown-direct"');
  await sleep(1000);
  const visBack = await evaluate(
    page,
    '({ vis: document.visibilityState, paused: Array.from(document.querySelectorAll("video.pet-video")).map((v) => v.paused).join(",") })',
  );
  // 这是**诊断项不是断言**：实测这里 Page Visibility 不可靠（窗口 hide() 后 2s 都是 visible），
  // 所以省电走的是主进程显式挂起。把它钉在回归输出里，哪天系统/Electron 变了就能第一时间发现。
  console.log(
    `  页面可见性（诊断，非断言）：直接隐藏后 2s 轨迹=${visTrail}（H=hidden）  当前 ${visRes.vis}/${visRes.paused}  本应用在前台=${appActive}  再显示 ${visBack.vis}/${visBack.paused}`,
  );

  // 聊天面板：长记录（每条回复都带表情包）开面板时会解码多少张图
  // 只量「开面板新出现的进程」——整树会把她在同一时间随机漫游的开销算进来，噪声极大
  const pidsBefore = new Set(appTree(app.pid).map((r) => r.pid));
  await evaluate(main, 'global.__whale.openChat(); "chat"');
  const chatWs = await findTarget(PAGE_PORT, (t) => t.type === 'page' && t.url.includes('chat/index.html'));
  const chat = await connect(chatWs);
  const fresh = new Map(
    appTree(app.pid)
      .filter((r) => !pidsBefore.has(r.pid))
      .map((r) => [r.pid, r.cpu]),
  );
  const chatT0 = Date.now();
  // 刚连上就采样：这是「自然开面板」的过程（scrollTop / 可滚动高度）
  const traj = await evaluate(
    chat,
    '(async () => {' +
      ' const t0 = performance.now();' +
      ' let s = null;' +
      ' for (let i = 0; i < 200 && !s; i++) { s = document.getElementById("scroll"); if (!s) await new Promise((r) => setTimeout(r, 25)); }' +
      ' if (!s) return ["找不到 #scroll"];' +
      ' const out = [];' +
      ' for (let i = 0; i < 20; i++) { out.push(Math.round(performance.now() - t0) + "ms " + Math.round(s.scrollTop) + "/" + Math.round(Math.max(0, s.scrollHeight - s.clientHeight))); await new Promise((r) => setTimeout(r, 150)); }' +
      ' return out;' +
      '})()',
  );
  console.log(`            开面板滚动轨迹: ${traj.filter((_, i) => i % 6 === 0).join("  ")}`);
  await sleep(2500);
  const imgStat = await evaluate(
    chat,
    '(() => {' +
      ' const scroll = document.getElementById("scroll");' +
      ' const vp = scroll.getBoundingClientRect();' +
      ' const ok = (i) => i.complete && i.naturalWidth > 0;' +
      ' const a = Array.from(document.querySelectorAll("#list img"));' +
      ' const vis = a.filter((i) => { const r = i.getBoundingClientRect(); return r.bottom > vp.top && r.top < vp.bottom; });' +
      ' return { total: a.length, loaded: a.filter(ok).length, visible: vis.length, loadedVisible: vis.filter(ok).length };' +
      '})()',
  );
  const chatProcAfter = appTree(app.pid).filter((r) => fresh.has(r.pid));
  const chatCpu =
    ((sum(chatProcAfter, 'cpu') - chatProcAfter.reduce((n, r) => n + fresh.get(r.pid), 0)) /
      ((Date.now() - chatT0) / 1000)) *
    100;
  // 先看自然状态：开面板 2.5s 后列表是否停在底部（我改过贴底逻辑，要确认没把它弄坏）
  const scroll = await evaluate(
    chat,
    '(() => { const s = document.getElementById("scroll"); return { atBottom: s.scrollHeight - s.scrollTop - s.clientHeight < 5, h: s.scrollHeight }; })()',
  );
  // 再测历史渲染（建 DOM）的同步耗时，不受她漫游影响
  const renderMs = await evaluate(
    chat,
    '(() => { const t0 = performance.now(); renderHistory(); return Math.round((performance.now() - t0) * 10) / 10; })()',
  );
  console.log(
    `  聊天面板：记录里 ${imgStat.total} 张表情包，已加载 ${imgStat.loaded} 张（眼前 ${imgStat.visible} 张里加载了 ${
      imgStat.loadedVisible
    } 张）`,
  );
  console.log(
    `            聊天渲染进程 ${chatCpu.toFixed(1)}% CPU（新进程 ${fresh.size} 个）  renderHistory() 同步 ${renderMs} ms  贴在底部=${scroll.atBottom}（内容高 ${scroll.h}px）`,
  );
  // 贴底逻辑的另一半：用户自己往上滚之后必须**停跟**（新消息别再把她拽回底部），滚回底部再恢复跟。
  // 用合成的滚轮事件（DevTools 输入管线）触发——这条路径正是上一轮出过竞态 bug 的地方。
  const wheel = (dy) =>
    chat.call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 180, y: 260, deltaX: 0, deltaY: dy });
  await wheel(-800);
  await sleep(500); // 等滚轮动画停下来再断言（合成滚轮也会平滑滚动）
  const pin = await evaluate(
    chat,
    '(() => {' +
      ' const s = document.getElementById("scroll");' +
      ' const up = s.scrollTop;' +
      ' addMessage("assistant", "↑ 停跟之后追加的一条");' + // 不带 force：模拟收到回复
      ' return { movedUp: up > 0, stayed: s.scrollTop === up };' + // 停跟了就应留在原处（不拽到底部）
      '})()',
  );
  // 滚回底部：滚轮滚不到底（合成滚轮的位移和真实不一致），这里直接赋值到最底，
  // 然后逐步读 pinnedToBottom 这个状态，定位到底是哪一步没成立
  const back = await evaluate(
    chat,
    '(() => { const s = document.getElementById("scroll"); const pinnedBefore = pinnedToBottom; s.scrollTop = s.scrollHeight; return { pinnedBefore }; })()',
  );
  await sleep(500); // 等滚动事件跑完（它会按 nearBottom 恢复「跟随」）
  const afterBack = await evaluate(
    chat,
    '(() => { const s = document.getElementById("scroll"); return { pinned: pinnedToBottom, atBottom: s.scrollHeight - s.scrollTop - s.clientHeight < 5 }; })()',
  );
  const rePin = await evaluate(
    chat,
    '(() => {' +
      ' const s = document.getElementById("scroll");' +
      ' const before = s.scrollTop;' +
      ' addMessage("assistant", "↓ 恢复跟之后追加的一条");' +
      ' return { followed: s.scrollTop > before, atBottom: s.scrollHeight - s.scrollTop - s.clientHeight < 5 };' +
      '})()',
  );
  console.log(
    `            贴底两个方向：上滚成功=${pin.movedUp}  上滚后追加消息留在原处=${pin.stayed}（应 true）  ` +
      `回到底部(pinned ${back.pinnedBefore}→${afterBack.pinned}, atBottom=${afterBack.atBottom})  恢复跟后追加=${rePin.followed}（应 true）`,
  );
  // 「正在输入」那三个点是无限 CSS 动画：模拟「正文已到但还没画出来」的收口，确认能被收掉
  const typing = await evaluate(
    chat,
    '(() => {' +
      ' const m = addTyping();' +
      ' const before = document.querySelectorAll(".typing").length;' +
      ' settleTyping({ msg: m, text: "半截回复" });' +
      ' return { before, after: document.querySelectorAll(".typing").length, text: m.span.textContent, connected: m.span.isConnected };' +
      '})()',
  );
  console.log(
    `            正在输入收口：收口前 ${typing.before} 个闪烁点 → 收口后 ${typing.after} 个，正文="${typing.text}"，已挂回 DOM=${typing.connected}`,
  );
  chat.close();

  // 设置窗口：能打开、能渲染，并且能收到「别处改了设置」的推送（applyView 去重的那条路径）
  await evaluate(main, 'global.__whale.settingsWindow.open("pet"); "settings"');
  const setWs = await findTarget(PAGE_PORT, (t) => t.type === 'page' && t.url.includes('settings/index.html'));
  const setPage = await connect(setWs);
  await sleep(1500);
  const before2 = await evaluate(
    setPage,
    '({ name: document.getElementById("pet-name").value, providers: document.getElementById("provider").options.length, models: document.getElementById("model-list").options.length })',
  );
  await evaluate(main, 'global.__whale.store.update({ pet: { name: "设置探针" } }); "ok"');
  await sleep(600);
  const after2 = await evaluate(setPage, 'document.getElementById("pet-name").value');
  console.log(
    `  设置窗口：服务商 ${before2.providers} 项、模型 ${before2.models} 项；别处改名 → 窗口显示 ${JSON.stringify(
      after2,
    )}（应为 "设置探针"）`,
  );
  await evaluate(main, 'global.__whale.store.update({ pet: { name: "" } }); "restored"');

  // 设置窗口首屏要等两个主进程往返（settings:get / settings:set），量一下它们各自多贵
  const rt = await evaluate(
    setPage,
    '(async () => {' +
      ' const t = async (fn) => { const t0 = performance.now(); await fn(); return Math.round((performance.now() - t0) * 10) / 10; };' +
      ' const nav = performance.getEntriesByType("navigation")[0];' +
      ' return { get: await t(() => api.get()), set: await t(() => api.set({ pet: { roam: false } })), dcl: Math.round(nav.domContentLoadedEventEnd) };' +
      '})()',
  );
  console.log(
    `            设置页导航耗时 ${rt.dcl} ms  settings:get ${rt.get} ms  settings:set ${rt.set} ms`,
  );
  setPage.close();

  // 长时间运行：动画每 5~10s 换一段，看常驻内存是否稳定。
  // 桌面宠物一开就是几天，慢慢涨的内存才是真会出事的东西（90s ≈ 十来次切换）。
  if (!SKIP_SOAK) {
    console.log('\n长时间运行（动画持续切换，看常驻内存是否稳定）：');
    const soak = [];
    for (let i = 0; i < 6; i++) {
      await sleep(15000);
      soak.push(Math.round(sum(appTree(app.pid), 'rss') / 1024));
    }
    console.log(`  常驻内存曲线：${soak.join(' → ')} MB（首尾差 ${soak[soak.length - 1] - soak[0]} MB）`);
  }

  // 空闲降频：长跑段之后（若这段时间主人确实没碰键鼠）兜底轮询应明显放慢。
  // 注意这条**取决于主人是否在动**，所以只报告事实、不做断言。
  const idleA = await evaluate(main, 'global.__whale.petWindow.stats()');
  await sleep(8000);
  const idleB = await evaluate(main, 'global.__whale.petWindow.stats()');
  console.log(
    `  空闲降频（诊断）：主人离开键盘=${idleB.userIdle}  8s 内兜底轮询 ${idleB.ticks - idleA.ticks} 次（离开时应约 8 次；在电脑前约 32~130 次）`,
  );

  page.close();
  main.close();
  console.log(`\n合计：可见 ${visibleCpu.toFixed(1)}% → 隐藏 ${hiddenCpu.toFixed(1)}%`);
} catch (e) {
  console.error('\n探针失败：' + (e && e.message));
  if (exited) console.error('提示：应用一启动就退出了 —— 多半是已经有一个 ds_pet 在运行（单实例锁），先关掉它再跑。');
  if (logs.length) console.error('应用输出：\n' + logs.join('').slice(-1500));
  process.exitCode = 1;
} finally {
  await cleanup();
  if (exited) console.log('（应用已退出）');
}
