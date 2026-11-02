// Windows 安装程序和一键更新的端到端测试（npm run test:update:win）：真的走一遍
//   静默安装旧版本 → 打开 → 设置页「检查更新」→「一键更新」到新版本（由本机假的 GitHub 发布接口提供）
//   → 旧版本退出、安装程序静默装好 → 新版本自己重新打开并读到更新标记 → 登录项 → 静默卸载。
//
// ⚠ 用的是真实的安装位置（%LOCALAPPDATA%\Programs\ds_pet）和当前用户的注册表，只在一次性的 Windows 上跑
// （GitHub Actions 的 Windows 机器、虚拟机）。这台电脑已经装了 ds_pet 的话默认拒绝运行，加 --replace-existing 才会先把它卸掉。
//
//   1. 打包两个安装程序（scripts/build-win.mjs，本机芯片）：当前代码冒充的旧版本 0.0.1，和真正的新版本；
//      加 --no-build 复用 dist/ 里现有的；
//   2. 起一个假的 GitHub 发布接口（DS_PET_UPDATE_API），提供新版本的安装程序和它的 sha256；
//   3. 用临时数据目录启动旧版本，经调试端口点设置页的按钮，核对每一步的结果。
// 拿 ds_pet.exe 当 Node 跑时（ELECTRON_RUN_AS_NODE）要先复制一份改个名：安装程序会结束所有叫 ds_pet.exe 的进程。
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : '';
};
if (process.platform !== 'win32') {
  console.error('这个脚本只在 Windows 上跑（macOS 用 npm run test:update）');
  process.exit(2);
}
const ARCH = arg('--arch') || process.arch;
const OLD = '0.0.1';
const NEW = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8')).version;
const setupOf = (v) => path.join(ROOT, 'dist', `ds_pet-${v}-win-${ARCH}-setup.exe`);
const INSTALL = path.join(process.env.LOCALAPPDATA, 'Programs', 'ds_pet');
const EXE = path.join(INSTALL, 'ds_pet.exe');
const UNINST = path.join(INSTALL, 'Uninstall ds_pet.exe');
const KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\io.github.cjian1.ds-pet';
const RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const LOGIN = 'io.github.cjian1.ds-pet';
const LNK = path.join(process.env.APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'ds_pet.lnk');
const PAGE_PORT = 9933;
const API_PORT = 8977;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok: !!ok, detail });
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? '  — ' + detail : ''));
}

if (fs.existsSync(EXE) && !process.argv.includes('--replace-existing')) {
  console.error('这台电脑已经装了 ds_pet（' + INSTALL + '），测试会把它卸掉。确定的话加 --replace-existing 再跑。');
  process.exit(2);
}

// ---------------------------------------------------------------- 打包
if (!process.argv.includes('--no-build')) {
  for (const extra of [['--version', OLD], []]) {
    console.log(`打包 ${extra[1] || NEW}（${ARCH}）…`);
    // 打包脚本要用 Node 跑：拿 ds_pet.exe 当 Node 时 ELECTRON_RUN_AS_NODE 得留着
    execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'build-win.mjs'), '--arch', ARCH, '--no-zip', ...extra], { cwd: ROOT, stdio: 'inherit' });
  }
}
for (const v of [OLD, NEW]) {
  if (!fs.existsSync(setupOf(v))) {
    console.error('没有 ' + setupOf(v) + '（装好 NSIS 再打包，或者去掉 --no-build）');
    process.exit(2);
  }
}

// ---------------------------------------------------------------- 小工具
/** 启动应用 / 安装程序用的环境：不带 ELECTRON_RUN_AS_NODE，带上测试用的数据目录和发布接口 */
const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'ds_pet-installer-e2e-'));
fs.writeFileSync(path.join(data, 'settings.json'), JSON.stringify({ onboarded: true, app: { language: 'zh', autoUpdate: false }, talk: { whisperEnabled: false } }));
env.DS_PET_DATA_DIR = data;
env.DS_PET_UPDATE_API = `http://127.0.0.1:${API_PORT}/latest`;

const reg = (key, value) => {
  const r = spawnSync('reg', ['query', key, '/v', value], { encoding: 'utf8', env });
  if (r.status !== 0) return null;
  const m = new RegExp(value.replace(/\./g, '\\.') + '\\s+REG_\\w+\\s+(.*)').exec(r.stdout);
  return m ? m[1].trim() : '';
};
const fileVersion = (f) =>
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${f.replace(/'/g, "''")}').VersionInfo.ProductVersion`], { encoding: 'utf8', env }).trim();
const running = () => spawnSync('tasklist', ['/FI', 'IMAGENAME eq ds_pet.exe', '/NH'], { encoding: 'utf8', env }).stdout.includes('ds_pet.exe');
async function until(fn, ms, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try {
      if (await fn()) return Date.now() - t0;
    } catch {
      /* 还没好 */
    }
    await sleep(300);
  }
  throw new Error('等太久了：' + label);
}
/** 连到调试端口上 URL 含 part 的页面，返回 {eval, close}；还没有这个页面就是 null */
async function page(part) {
  const list = await (await fetch(`http://127.0.0.1:${PAGE_PORT}/json/list`)).json();
  const t = list.find((x) => x.type === 'page' && x.url.includes(part));
  if (!t) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (pending.has(m.id)) pending.get(m.id)(m), pending.delete(m.id);
  };
  return {
    eval: (expression) =>
      new Promise((resolve, reject) => {
        const i = ++id;
        pending.set(i, (m) => (m.result.exceptionDetails ? reject(new Error(m.result.exceptionDetails.text)) : resolve(m.result.result.value)));
        ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      }),
    close: () => ws.close(),
  };
}
const launch = (args = []) => spawn(EXE, args, { env, detached: true, stdio: 'ignore' }).unref();
/** 再打开一次应用（second-instance）：正在运行的那份会打开设置窗口 */
async function openSettings() {
  launch();
  let p = null;
  await until(async () => (p = await page('/settings/')), 30000, '设置页');
  await until(() => p.eval('!!window.settingsApi'), 10000, '设置页接口');
  return p;
}

// ---------------------------------------------------------------- 假的 GitHub 发布接口
const name = path.basename(setupOf(NEW));
const buf = fs.readFileSync(setupOf(NEW));
const server = http
  .createServer((req, res) => {
    if (req.url === '/latest') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          tag_name: 'v' + NEW,
          html_url: `http://127.0.0.1:${API_PORT}/`,
          body: fs.readFileSync(path.join(ROOT, '.github', 'release-notes.md'), 'utf8'),
          draft: false,
          prerelease: false,
          assets: [
            {
              name,
              size: buf.length,
              digest: 'sha256:' + crypto.createHash('sha256').update(buf).digest('hex'),
              browser_download_url: `http://127.0.0.1:${API_PORT}/dl/${name}`,
            },
          ],
        }),
      );
    } else if (req.url === '/dl/' + name) {
      res.setHeader('content-length', buf.length);
      res.end(buf);
    } else {
      res.statusCode = 404;
      res.end();
    }
  })
  .listen(API_PORT, '127.0.0.1');

// ---------------------------------------------------------------- 开始
try {
  if (fs.existsSync(UNINST)) {
    spawnSync(UNINST, ['/S'], { env });
    await until(() => !fs.existsSync(EXE), 90000, '卸掉原来装的');
  }

  // 1. 静默安装旧版本
  const r = spawnSync(setupOf(OLD), ['/S'], { env, timeout: 300000 });
  check(`静默安装 ${OLD}：退出码 0`, r.status === 0, String(r.status));
  check('装在 %LOCALAPPDATA%\\Programs\\ds_pet，旁边有卸载程序', fs.existsSync(EXE) && fs.existsSync(UNINST));
  check('注册表卸载项的版本号', reg(KEY, 'DisplayVersion') === OLD, String(reg(KEY, 'DisplayVersion')));
  check('开始菜单有快捷方式', fs.existsSync(LNK));
  check('exe 带着版本信息', fileVersion(EXE) === OLD, fileVersion(EXE));

  // 2. 打开旧版本，设置页：检查更新 → 一键更新
  launch([`--remote-debugging-port=${PAGE_PORT}`]);
  await until(async () => !!(await page('/pet/')), 90000, '桌宠页面');
  let set = await openSettings();
  const st = await set.eval('settingsApi.checkUpdate()');
  check(
    `检查更新：发现 ${NEW}，挑的是本机芯片的安装程序，可以一键更新`,
    st.phase === 'available' && st.latest && st.latest.version === NEW && st.latest.asset.name === name && st.blocker === null,
    JSON.stringify({ phase: st.phase, blocker: st.blocker, asset: st.latest && st.latest.asset && st.latest.asset.name, error: st.error }),
  );
  const t0 = Date.now();
  const st2 = await set.eval('settingsApi.installUpdate()');
  check('一键更新：下载、校验通过，进入「马上重启」', st2.phase === 'restarting', st2.error || st2.phase);
  set.close();

  // 3. 旧版本退出 → 安装程序静默装好 → 新版本自己重新打开、读到更新标记
  const marker = path.join(data, 'updates', 'just-updated.json');
  await until(() => reg(KEY, 'DisplayVersion') === NEW, 240000, '注册表里的版本号变成新版本');
  check(`安装程序静默装好：注册表版本变成 ${NEW}`, true, `${Math.round((Date.now() - t0) / 1000)}s`);
  check(`exe 换成 ${NEW}`, fileVersion(EXE) === NEW, fileVersion(EXE));
  await until(() => running() && !fs.existsSync(marker), 90000, '新版本重新打开并读到更新标记');
  check('新版本自己重新打开，并读到了更新标记（她会说「更新好啦」）', true, `${Math.round((Date.now() - t0) / 1000)}s`);
  const log = fs.readFileSync(path.join(data, 'updates', 'update.log'), 'utf8');
  check('更新日志：update done', /update done/.test(log), log.trim().split(/\r?\n/).slice(-3).join(' | '));
  check('下载的安装程序已删掉', !fs.readdirSync(path.join(data, 'updates')).some((n) => n.endsWith('.exe')));

  // 4. 登录项（带调试端口重开新版本）
  spawnSync('taskkill', ['/F', '/IM', 'ds_pet.exe'], { env });
  await until(() => !running(), 15000, '结束新版本');
  launch([`--remote-debugging-port=${PAGE_PORT}`]);
  await until(async () => !!(await page('/pet/')), 90000, '新版本的桌宠页面');
  set = await openSettings();
  await set.eval('settingsApi.set({ app: { openAtLogin: true } })');
  const runVal = reg(RUN, LOGIN);
  check('登录时自动打开：写进注册表 Run，指向安装的 exe', !!runVal && runVal.toLowerCase().includes(EXE.toLowerCase()), String(runVal));
  const view = await set.eval('settingsApi.get()');
  check('设置页看到的登录项状态正常', view.meta.loginStatus !== 'requires-approval' && view.settings.app.openAtLogin === true, view.meta.loginStatus);
  await set.eval('settingsApi.set({ app: { openAtLogin: false } })');
  check('关掉：Run 里的值删掉', reg(RUN, LOGIN) === null);
  await set.eval('settingsApi.set({ app: { openAtLogin: true } })'); // 留着，看卸载能不能清掉
  set.close();

  // 5. 静默卸载：叫正在运行的她退出，删文件 / 快捷方式 / 注册表 / 登录项，静默模式下不删用户数据
  spawnSync(UNINST, ['/S'], { env });
  await until(() => !fs.existsSync(EXE), 90000, '卸载');
  await sleep(1500);
  check('静默卸载：程序文件删掉了', !fs.existsSync(EXE) && !fs.existsSync(path.join(INSTALL, 'resources')));
  check('卸载：安装文件夹也删掉了', !fs.existsSync(INSTALL), fs.existsSync(INSTALL) ? fs.readdirSync(INSTALL).join(',') : '');
  check('卸载：注册表卸载项删掉了', reg(KEY, 'DisplayVersion') === null);
  check('卸载：开始菜单快捷方式删掉了', !fs.existsSync(LNK));
  check('卸载：登录项删掉了', reg(RUN, LOGIN) === null);
  check('卸载：正在运行的她退出了', !running());
  check('静默卸载不删用户数据', fs.existsSync(path.join(data, 'settings.json')));
} catch (e) {
  check('测试过程', false, e.message);
  const upd = path.join(data, 'updates');
  const log = path.join(upd, 'update.log');
  console.log('updates/：' + (fs.existsSync(upd) ? fs.readdirSync(upd).join(', ') : '（没有）'));
  if (fs.existsSync(log)) console.log('update.log：\n' + fs.readFileSync(log, 'utf8'));
} finally {
  server.close();
  spawnSync('taskkill', ['/F', '/IM', 'ds_pet.exe'], { env });
  if (fs.existsSync(UNINST)) spawnSync(UNINST, ['/S'], { env });
  await sleep(1500);
  try {
    fs.rmSync(data, { recursive: true, force: true });
  } catch {
    /* 还被占着就留给系统清理 */
  }
}

const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
if (arg('--out')) fs.writeFileSync(arg('--out'), JSON.stringify({ results }, null, 2));
process.exit(failed ? 1 : 0);
