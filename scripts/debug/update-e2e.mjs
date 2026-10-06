// 一键更新的端到端测试（npm run test:update）：在临时目录里真的走一遍「旧版本 → 一键更新 → 新版本重启」。
//
//   1. 打包当前代码（scripts/build-mac.sh --dmg），得到新版本的 DMG；
//   2. 拿同一个 .app 改成 0.0.1 版，放进临时的「应用程序」目录，当作旧版本；
//   3. 本机起一个假的 GitHub 发布接口（DS_PET_UPDATE_API），提供这个 DMG 和它的 sha256；
//   4. 启动旧版本，经调试端口点设置页的「检查更新」→「一键更新」；
//   5. 等它自己退出、替换、重新打开，核对新版本号、签名、日志和清理情况。
//
// 不碰你装在 /Applications 的 ds_pet，也不用你的数据目录。加 --no-build 复用 dist/ 里现有的包。
import { spawn, execFileSync } from 'node:child_process';
import { createReadStream } from 'node:fs';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PAGE_PORT = 9933;
const OLD = '0.0.1';

const results = [];
function check(name, ok, detail = '') {
  results.push(!!ok);
  console.log((ok ? '  ✓ ' : '  ✗ ') + name + (detail ? '  — ' + detail : ''));
}
async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    try {
      const v = await fn();
      if (v) return v;
    } catch {
      /* 还没好 */
    }
    if (Date.now() - t0 > ms) throw new Error('等太久了：' + label);
    await sleep(250);
  }
}
const sh = (cmd, args) => execFileSync(cmd, args, { encoding: 'utf8' }).trim();

// ---------------------------------------------------------------- 新版本的包
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8')).version;
const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
const dmg = path.join(ROOT, 'dist', `ds_pet-${version}-${arch}.dmg`);
const builtApp = path.join(ROOT, 'dist', `mac-${arch}`, 'ds_pet.app');
if (!process.argv.includes('--no-build') || !fs.existsSync(dmg)) {
  console.log('打包 ' + version + '…');
  execFileSync('bash', [path.join(ROOT, 'scripts', 'build-mac.sh'), '--dmg'], { stdio: ['ignore', 'ignore', 'inherit'] });
}
const digest = crypto.createHash('sha256').update(fs.readFileSync(dmg)).digest('hex');
const size = fs.statSync(dmg).size;

// ---------------------------------------------------------------- 旧版本
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ds_pet-update-e2e-')));
const appsDir = path.join(work, 'Applications');
const target = path.join(appsDir, 'ds_pet.app');
const exe = path.join(target, 'Contents', 'MacOS', 'ds_pet');
const dataDir = path.join(work, 'data');
fs.mkdirSync(appsDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
sh('ditto', [builtApp, target]);
const plist = path.join(target, 'Contents', 'Info.plist');
sh('plutil', ['-replace', 'CFBundleShortVersionString', '-string', OLD, plist]);
sh('plutil', ['-replace', 'CFBundleVersion', '-string', OLD, plist]);
const pkgFile = path.join(target, 'Contents', 'Resources', 'app', 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
pkg.version = OLD;
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2));
sh('codesign', ['--force', '--deep', '--sign', '-', target]);
fs.writeFileSync(
  path.join(dataDir, 'settings.json'),
  JSON.stringify({
    onboarded: true,
    pet: { size: 240, roam: false },
    talk: { whisperEnabled: false, balanceEnabled: false },
    app: { autoUpdate: false, shortcutEnabled: false, showInDock: false, language: 'zh' },
    position: { rx: 0.88, ry: 0.2 },
  }),
);

// ---------------------------------------------------------------- 假的发布接口
const server = http.createServer((req, res) => {
  const base = `http://127.0.0.1:${server.address().port}`;
  if (req.url === '/releases/latest') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        tag_name: 'v' + version,
        html_url: 'https://github.com/cjian1/ds_pet/releases/tag/v' + version,
        draft: false,
        prerelease: false,
        body: fs.readFileSync(path.join(ROOT, '.github', 'release-notes.md'), 'utf8'),
        assets: [{ name: path.basename(dmg), size, digest: 'sha256:' + digest, browser_download_url: `${base}/dl/${path.basename(dmg)}` }],
      }),
    );
    return;
  }
  if (req.url === '/dl/' + path.basename(dmg)) {
    res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size });
    createReadStream(dmg).pipe(res);
    return;
  }
  res.writeHead(404).end();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const env = Object.assign({}, process.env, {
  DS_PET_DATA_DIR: dataDir,
  DS_PET_UPDATE_API: `http://127.0.0.1:${server.address().port}/releases/latest`,
});

// ---------------------------------------------------------------- CDP
async function page(part) {
  const list = await (await fetch(`http://127.0.0.1:${PAGE_PORT}/json/list`)).json();
  const t = list.find((x) => x.type === 'page' && x.url.includes(part));
  if (!t) return null;
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    pending.get(m.id)?.(m);
    pending.delete(m.id);
  };
  await new Promise((r, j) => ((ws.onopen = r), (ws.onerror = j)));
  return {
    close: () => ws.close(),
    eval: (expression) =>
      new Promise((resolve, reject) => {
        const i = ++id;
        pending.set(i, (m) => (m.result.exceptionDetails ? reject(new Error(m.result.exceptionDetails.exception?.description)) : resolve(m.result.result.value)));
        ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
      }),
  };
}

const running = () => {
  try {
    return sh('pgrep', ['-f', exe]).split('\n').filter(Boolean);
  } catch {
    return [];
  }
};

console.log(`旧版本 ${OLD} → 新版本 ${version}（${arch}），临时目录 ${work}\n`);
let old;
try {
  old = spawn(exe, [`--remote-debugging-port=${PAGE_PORT}`], { env, stdio: 'ignore' });
  const oldExit = new Promise((r) => old.once('exit', r));
  await waitFor(() => page('/pet/').then((p) => p && (p.close(), true)), 30000, '旧版本启动');
  // 再开一次 = 第二个实例 → 旧版本把设置窗口打开
  spawn(exe, [], { env, stdio: 'ignore' });
  const settings = await waitFor(() => page('/settings/'), 15000, '设置窗口');
  await waitFor(() => settings.eval('!!(typeof upd !== "undefined" && upd && document.getElementById("update-status").textContent)'), 10000, '更新卡片');
  check('旧版本启动，设置页显示当前版本', (await settings.eval('upd.current')) === OLD);

  await settings.eval("showTab('about'); document.getElementById('btn-update-check').click(); true");
  await waitFor(() => settings.eval("upd.phase === 'available' || upd.phase === 'error'"), 15000, '检查更新');
  const st = await settings.eval('upd');
  check('检查更新：发现新版本', st.phase === 'available' && st.latest.version === version, st.error || st.latest?.version);
  check('检查更新：页面显示更新内容', (await settings.eval("document.querySelectorAll('#update-notes-list li').length")) > 0);
  check('检查更新：「一键更新」按钮可用', await settings.eval("!document.getElementById('btn-update-install').hidden && !document.getElementById('btn-update-install').disabled"));

  const phases = [];
  await settings.eval("document.getElementById('btn-update-install').click(); true");
  const t0 = Date.now();
  while (Date.now() - t0 < 120000) {
    let ph;
    try {
      ph = await Promise.race([settings.eval('upd.phase + "|" + Math.round((upd.progress || 0) * 100) + "|" + upd.error'), sleep(2000).then(() => 'gone')]);
    } catch {
      ph = 'gone';
    }
    if (ph === 'gone') break;
    const [phase, , error] = ph.split('|');
    if (phases[phases.length - 1] !== phase) phases.push(phase);
    if (phase === 'error') {
      check('一键更新', false, error);
      break;
    }
    await sleep(200);
  }
  settings.close();
  check('一键更新：下载 → 安装 → 重启', ['downloading', 'installing', 'restarting'].every((p) => phases.includes(p)), phases.join(' → '));

  await Promise.race([oldExit, sleep(20000)]);
  check('旧版本自己退出了', old.exitCode !== null || old.signalCode !== null);

  const pids = await waitFor(() => (running().length ? running() : null), 40000, '新版本启动').catch(() => []);
  check('新版本被重新打开', pids.length > 0, pids.join(','));
  const now = sh('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist]);
  const nowPkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')).version;
  check('「应用程序」里换成了新版本', now === version && nowPkg === version, `Info.plist ${now}，package.json ${nowPkg}`);
  let signed = true;
  try {
    sh('codesign', ['--verify', '--deep', '--strict', target]);
  } catch {
    signed = false;
  }
  check('新版本签名完整', signed);
  const leftovers = fs.readdirSync(appsDir).filter((n) => n !== 'ds_pet.app');
  check('没有留下临时的 .app', leftovers.length === 0, leftovers.join(', '));

  const updates = path.join(dataDir, 'updates');
  await sleep(4000); // 新版本启动后读更新标记、清理下载
  const left = fs.readdirSync(updates);
  check('新版本读过更新标记、清掉了下载的安装包', !left.some((n) => /\.dmg|ds_pet\.app|just-updated/.test(n)), left.join(', '));
  const log = fs.readFileSync(path.join(updates, 'update.log'), 'utf8');
  check('替换脚本日志：完成', /update done/.test(log), log.trim().split('\n').pop());
} catch (e) {
  check('测试过程', false, e.message);
} finally {
  for (const pid of running()) {
    try {
      process.kill(Number(pid));
    } catch {
      /* 已经退了 */
    }
  }
  if (old && old.exitCode === null) old.kill();
  server.close();
  await sleep(800);
  fs.rmSync(work, { recursive: true, force: true });
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} 通过`);
process.exit(failed ? 1 : 0);
