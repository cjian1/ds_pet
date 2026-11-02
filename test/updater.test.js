'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const I18n = require('../desktop/i18n/i18n.js');
const U = require('../desktop/main/updater.js');

delete process.env.DS_PET_UPDATE_API;
const ROOT = path.join(__dirname, '..');
const t = (key, vars) => I18n.t('zh', key, vars);
const NOTES = fs.readFileSync(path.join(ROOT, '.github', 'release-notes.md'), 'utf8');
/** 要用到 bash / hdiutil / ditto 的测试只在 macOS 上跑 */
const MAC_ONLY = process.platform !== 'darwin' && '需要 macOS（bash / hdiutil）';

/** 一份像 GitHub 那样的发布 JSON */
function release(version, extra = {}) {
  const dmg = (arch) => ({
    name: `ds_pet-${version}-${arch}.dmg`,
    size: 4,
    digest: 'sha256:' + crypto.createHash('sha256').update('dmg!').digest('hex'),
    browser_download_url: `https://github.com/cjian1/ds_pet/releases/download/v${version}/ds_pet-${version}-${arch}.dmg`,
  });
  return Object.assign(
    { tag_name: 'v' + version, html_url: 'https://github.com/cjian1/ds_pet/releases/tag/v' + version, body: NOTES, draft: false, prerelease: false, assets: [dmg('arm64'), dmg('x64')] },
    extra,
  );
}

const tmpDirs = [];
process.on('exit', () => {
  for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true });
});

/** 临时目录里摆一个「装好的」ds_pet.app，返回更新器和记录请求的数组 */
function setup({ replies = [], packaged = true, current = '1.1.1', fetch } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds_pet-updater-'));
  tmpDirs.push(tmp);
  // 一律用 / 分隔：这是一份 macOS 的安装，在 Windows 上跑测试时也得长得像 macOS 路径（Node 在 Windows 上照样认 /）
  const exe = path.join(tmp, 'Applications', 'ds_pet.app', 'Contents', 'MacOS', 'ds_pet').split(path.sep).join('/');
  fs.mkdirSync(path.dirname(exe), { recursive: true });
  fs.writeFileSync(exe, '');
  const calls = [];
  const states = [];
  const quits = [];
  const u = U.createUpdater({
    current,
    packaged,
    exePath: exe,
    dataDir: path.join(tmp, 'data'),
    t,
    lang: () => 'zh',
    arch: 'arm64',
    platform: 'darwin',
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), headers: init.headers || {} });
      if (fetch) return fetch(url, init, calls.length);
      const r = replies.shift();
      if (!r) throw new Error('没预料到的请求 ' + url);
      return r();
    },
    onState: (st) => states.push(st.phase),
    quit: () => quits.push(1),
  });
  return { u, calls, states, quits, tmp, data: path.join(tmp, 'data') };
}
const json = (obj, status = 200) => () => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

// ---------------------------------------------------------------- 纯函数
test('版本号比较', () => {
  assert.equal(U.compareVersions('1.1.1', '1.1.0'), 1);
  assert.equal(U.compareVersions('v1.10.0', '1.9.9'), 1);
  assert.equal(U.compareVersions('1.2', '1.2.0'), 0);
  assert.equal(U.compareVersions('1.1.0', 'v1.1.1'), -1);
  assert.equal(U.compareVersions('2.0.0-beta', '1.9.0'), 1);
  assert.equal(U.compareVersions('nightly', '1.0.0'), 0, '看不懂的版本号当作没有更新');
  assert.deepEqual(U.parseVersion('v3'), [3, 0, 0]);
});

test('解析发布：按芯片挑安装包，没有就是 null', () => {
  const r = U.parseRelease(release('1.2.0'), 'x64');
  assert.equal(r.version, '1.2.0');
  assert.equal(r.asset.name, 'ds_pet-1.2.0-x64.dmg');
  assert.match(r.asset.digest, /^sha256:/);
  const renamed = release('1.2.0', { assets: [{ name: 'ds_pet-Setup-arm64.dmg', size: 1, browser_download_url: 'https://github.com/x' }] });
  assert.equal(U.parseRelease(renamed, 'arm64').asset.name, 'ds_pet-Setup-arm64.dmg', '名字不标准时按 -<芯片>.dmg 结尾找');
  assert.equal(U.parseRelease(release('1.2.0', { assets: [] }), 'arm64').asset, null);
  assert.throws(() => U.parseRelease(release('1.2.0', { draft: true }), 'arm64'));
  assert.throws(() => U.parseRelease(release('1.2.0', { prerelease: true }), 'arm64'));
  assert.throws(() => U.parseRelease({ tag_name: 'latest' }, 'arm64'));
});

test('下载地址白名单：只认 https 的 GitHub 域名', () => {
  assert.equal(U.allowedDownload('https://github.com/cjian1/ds_pet/releases/download/v1/a.dmg'), true);
  assert.equal(U.allowedDownload('https://release-assets.githubusercontent.com/x?sig=1'), true);
  assert.equal(U.allowedDownload('https://objects.githubusercontent.com/x'), true);
  assert.equal(U.allowedDownload('http://github.com/a.dmg'), false);
  assert.equal(U.allowedDownload('https://github.com.evil.example/a.dmg'), false);
  assert.equal(U.allowedDownload('https://evil.example/github.com/a.dmg'), false);
  assert.equal(U.allowedDownload('not a url'), false);
  assert.equal(U.allowedDownload('http://127.0.0.1:9/a.dmg', 'http://127.0.0.1:9'), true, '测试用的发布接口来源');
});

test('能不能就地更新', () => {
  assert.equal(U.bundleOf('/Applications/ds_pet.app/Contents/MacOS/ds_pet'), '/Applications/ds_pet.app');
  assert.equal(U.bundleOf('/usr/local/bin/electron'), null);
  const ok = { packaged: true, appPath: '/Applications/ds_pet.app', writable: true };
  assert.equal(U.installBlocker(ok), null);
  assert.equal(U.installBlocker({ ...ok, packaged: false }), 'dev');
  assert.equal(U.installBlocker({ ...ok, appPath: '/private/var/folders/x/AppTranslocation/ABC/d/ds_pet.app' }), 'translocated');
  assert.equal(U.installBlocker({ ...ok, appPath: '/Volumes/ds_pet/ds_pet.app' }), 'translocated');
  assert.equal(U.installBlocker({ ...ok, appPath: null }), 'translocated');
  assert.equal(U.installBlocker({ ...ok, writable: false }), 'permission');
});

test('更新内容：从发布说明里按语言摘出来', () => {
  const zh = U.releaseHighlights(NOTES, 'zh');
  const en = U.releaseHighlights(NOTES, 'en');
  assert.ok(zh.length >= 2 && zh.every((l) => /[一-鿿]/.test(l)), JSON.stringify(zh));
  assert.ok(en.length === zh.length && en.every((l) => !/[一-鿿]/.test(l)), JSON.stringify(en));
  assert.ok(!zh.some((l) => /下载哪个/.test(l)), '不能把下一段也带进来');
  assert.deepEqual(U.releaseHighlights('## 下载\n- 别的', 'zh'), []);
});

test('hdiutil 输出里找挂载点', () => {
  const xml = '<dict><key>dev-entry</key><string>/dev/disk9s1</string><key>mount-point</key><string>/tmp/x/dmg.AbC</string></dict>';
  assert.equal(U.mountPointOf(xml), '/tmp/x/dmg.AbC');
  assert.equal(U.mountPointOf('<dict></dict>'), null);
});

test('替换脚本：bash 语法正确，变量都加了花括号，没有中文', { skip: MAC_ONLY }, () => {
  const file = path.join(os.tmpdir(), 'ds_pet-update-test.sh');
  fs.writeFileSync(file, U.UPDATE_SCRIPT);
  const r = spawnSync('/bin/bash', ['-n', file], { encoding: 'utf8' });
  fs.rmSync(file, { force: true });
  assert.equal(r.status, 0, r.stderr);
  assert.ok(!/[一-鿿]/.test(U.UPDATE_SCRIPT));
  assert.ok(!/\$(pid|target|staged|log|dir|next|old)\b/.test(U.UPDATE_SCRIPT), '变量要写成 ${x}');
  for (const step of ['kill -0', 'ditto', 'mv "${target}" "${old}"', 'mv "${next}" "${target}"', 'mv "${old}" "${target}"', 'open -n']) {
    assert.ok(U.UPDATE_SCRIPT.includes(step), step);
  }
});

test('Bundle ID 和安装包命名与打包脚本一致', () => {
  const build = fs.readFileSync(path.join(ROOT, 'scripts', 'build-mac.sh'), 'utf8');
  assert.match(build, new RegExp('BUNDLE_ID="' + U.BUNDLE_ID.replace(/\./g, '\\.') + '"'));
  assert.ok(build.includes('${NAME}-${VERSION}-${ARCH}.dmg'));
  assert.match(build, /NAME="ds_pet"/);
});

// ---------------------------------------------------------------- 检查更新
test('检查更新：有新版本 → available，带上本机芯片的安装包和更新内容', async () => {
  const { u, calls } = setup({ replies: [json(release('1.2.0'))] });
  const st = await u.check({ manual: true });
  assert.equal(st.phase, 'available');
  assert.equal(st.latest.version, '1.2.0');
  assert.equal(st.latest.asset.name, 'ds_pet-1.2.0-arm64.dmg');
  assert.ok(st.latest.highlights.length > 0);
  assert.equal(st.blocker, null);
  assert.equal(calls[0].url, 'https://api.github.com/repos/cjian1/ds_pet/releases/latest');
  assert.match(calls[0].headers['User-Agent'], /^ds_pet\/1\.1\.1/);
});

test('检查更新：一样新 / 还没有发布 → latest', async () => {
  for (const reply of [json(release('1.1.1')), json(release('1.0.0')), json({ message: 'Not Found' }, 404)]) {
    const { u } = setup({ replies: [reply] });
    const st = await u.check({ manual: true });
    assert.equal(st.phase, 'latest');
    assert.equal(st.latest, null);
  }
});

test('检查更新失败：手动检查报错，自动检查不打扰', async () => {
  const manual = setup({ replies: [json({}, 403)] });
  const st = await manual.u.check({ manual: true });
  assert.equal(st.phase, 'error');
  assert.equal(st.error, t('update.err.rate'));

  const auto = setup({ replies: [() => Promise.reject(new Error('offline'))] });
  const st2 = await auto.u.check();
  assert.equal(st2.phase, 'idle');
  assert.equal(st2.error, '');
});

// ---------------------------------------------------------------- 下载与安装
test('开发版不能一键更新', async () => {
  const { u, calls } = setup({ packaged: false, replies: [json(release('1.2.0'))] });
  await u.check({ manual: true });
  const st = await u.install();
  assert.equal(st.phase, 'error');
  assert.equal(st.error, t('update.block.dev'));
  assert.equal(calls.length, 1, '没有去下载');
});

test('下载校验不通过：报错、删掉下载的文件、不退出', async () => {
  const { u, data, quits } = setup({ replies: [json(release('1.2.0')), () => new Response('evil')] });
  await u.check({ manual: true });
  const st = await u.install();
  assert.equal(st.phase, 'error');
  assert.equal(st.error, t('update.err.checksum'));
  assert.deepEqual(fs.readdirSync(path.join(data, 'updates')), []);
  assert.equal(quits.length, 0);
});

test('下载不完整：报错', async () => {
  const { u } = setup({ replies: [json(release('1.2.0')), () => new Response('dm')] });
  await u.check({ manual: true });
  assert.equal((await u.install()).error, t('update.err.size'));
});

test('下载地址不是 GitHub 的：不去下载', async () => {
  const rel = release('1.2.0');
  rel.assets[0].browser_download_url = 'https://evil.example/ds_pet-1.2.0-arm64.dmg';
  const { u, calls } = setup({ replies: [json(rel)] });
  await u.check({ manual: true });
  const st = await u.install();
  assert.equal(st.error, t('update.err.badAsset'));
  assert.equal(calls.length, 1);
});

test('下载完、校验通过，但不是能挂载的安装包：报「打不开安装包」', { skip: MAC_ONLY }, async () => {
  const { u, states } = setup({ replies: [json(release('1.2.0')), () => new Response('dmg!')] });
  await u.check({ manual: true });
  const st = await u.install();
  assert.equal(st.phase, 'error');
  assert.ok(st.error.startsWith(t('update.err.mount', { msg: '' })), st.error);
  assert.ok(states.includes('downloading') && states.includes('installing'));
});

test('这个版本没有本机芯片的安装包：提示去 GitHub 下载', async () => {
  const { u } = setup({ replies: [json(release('1.2.0', { assets: [] }))] });
  await u.check({ manual: true });
  assert.equal((await u.install()).error, t('update.err.noAsset', { arch: 'arm64' }));
});

test('下载中取消：回到「有新版本」', async () => {
  let started;
  const begun = new Promise((r) => (started = r));
  const slow = (init) =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('dm'));
          started();
          init.signal.addEventListener('abort', () => c.error(Object.assign(new Error('aborted'), { name: 'AbortError' })));
        },
      }),
    );
  const { u } = setup({ fetch: (_url, init, n) => (n === 1 ? json(release('1.2.0'))() : slow(init)) });
  await u.check({ manual: true });
  const done = u.install();
  await begun;
  u.cancel();
  const st = await done;
  assert.equal(st.phase, 'available');
  assert.equal(st.progress, 0);
});

// ---------------------------------------------------------------- 更新标记
test('新版本启动时读更新标记：装上了 / 没装上 / 太旧的不算，读完就删', () => {
  const write = (data, m) => {
    fs.mkdirSync(path.join(data, 'updates'), { recursive: true });
    fs.writeFileSync(path.join(data, 'updates', 'just-updated.json'), JSON.stringify(m));
  };
  const a = setup({ current: '1.2.0' });
  write(a.data, { from: '1.1.1', to: '1.2.0', at: Date.now() });
  assert.deepEqual(a.u.takeMarker(), { from: '1.1.1', to: '1.2.0', ok: true });
  assert.equal(a.u.takeMarker(), null, '读完就删');

  const b = setup({ current: '1.1.1' });
  write(b.data, { from: '1.1.1', to: '1.2.0', at: Date.now() });
  assert.equal(b.u.takeMarker().ok, false);

  const c = setup({ current: '1.2.0' });
  write(c.data, { from: '1.1.1', to: '1.2.0', at: Date.now() - 2 * 24 * 3600 * 1000 });
  assert.equal(c.u.takeMarker(), null);
});

// ---------------------------------------------------------------- 替换脚本（假的 open，只记参数）
function runScript({ staged = true, dataDir } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds_pet-updater-'));
  tmpDirs.push(tmp);
  const apps = path.join(tmp, 'Applications');
  const target = path.join(apps, 'ds_pet.app');
  const stagedApp = path.join(tmp, 'updates', 'ds_pet.app');
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'VERSION'), 'old');
  if (staged) {
    fs.mkdirSync(stagedApp, { recursive: true });
    fs.writeFileSync(path.join(stagedApp, 'VERSION'), 'new');
  }
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin);
  const openLog = path.join(tmp, 'open.log');
  fs.writeFileSync(path.join(bin, 'open'), '#!/bin/sh\necho "$@" >> "$OPEN_LOG"\n', { mode: 0o755 });
  const script = path.join(tmp, 'update.sh');
  fs.writeFileSync(script, U.UPDATE_SCRIPT, { mode: 0o755 });
  const dead = spawnSync('/usr/bin/true').pid; // 一个已经退出的进程
  const log = path.join(tmp, 'update.log');
  const env = { PATH: bin + ':/usr/bin:/bin:/usr/sbin:/sbin', OPEN_LOG: openLog };
  if (dataDir) env.DS_PET_DATA_DIR = dataDir;
  const r = spawnSync('/bin/bash', [script, String(dead), target, stagedApp, log], { env, encoding: 'utf8' });
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  return {
    status: r.status,
    version: read(path.join(target, 'VERSION')),
    stagedLeft: fs.existsSync(stagedApp),
    others: fs.readdirSync(apps).filter((n) => n !== 'ds_pet.app'),
    opened: read(openLog).trim(),
    log: read(log),
    target,
  };
}

test('替换脚本：等旧进程退出 → 换成新版本 → 按路径重新打开', { skip: MAC_ONLY }, () => {
  const r = runScript();
  assert.equal(r.status, 0, r.log);
  assert.equal(r.version, 'new');
  assert.equal(r.stagedLeft, false);
  assert.deepEqual(r.others, [], '不留临时的 .app');
  assert.equal(r.opened, '-n ' + r.target);
  assert.match(r.log, /update done/);
});

test('替换脚本：新版本拷不过去 → 旧版本原样留着，并重新打开旧版本', { skip: MAC_ONLY }, () => {
  const r = runScript({ staged: false });
  assert.equal(r.status, 1);
  assert.equal(r.version, 'old');
  assert.deepEqual(r.others, []);
  assert.equal(r.opened, '-n ' + r.target);
  assert.match(r.log, /copy failed/);
});

test('替换脚本：带着自定义数据目录重新打开（开发和测试用）', { skip: MAC_ONLY }, () => {
  const r = runScript({ dataDir: '/tmp/ds_pet data' });
  assert.equal(r.opened, '-n --env DS_PET_DATA_DIR=/tmp/ds_pet data ' + r.target);
});

// ---------------------------------------------------------------- Windows
/** 一份带 Windows 安装包的发布（content = 安装程序的内容，用来算 sha256 和大小） */
function winRelease(version, content = 'MZsetup') {
  const url = (name) => `https://github.com/cjian1/ds_pet/releases/download/v${version}/${name}`;
  const setup = (arch) => ({
    name: `ds_pet-${version}-win-${arch}-setup.exe`,
    size: Buffer.byteLength(content),
    digest: 'sha256:' + crypto.createHash('sha256').update(content).digest('hex'),
    browser_download_url: url(`ds_pet-${version}-win-${arch}-setup.exe`),
  });
  const zip = (arch) => ({ name: `ds_pet-${version}-win-${arch}.zip`, size: 3, browser_download_url: url(`ds_pet-${version}-win-${arch}.zip`) });
  const rel = release(version);
  rel.assets.push(setup('x64'), setup('arm64'), zip('x64'), zip('arm64'));
  return rel;
}

/** 假的 child_process.spawn：记下命令和参数，下一拍报告「起来了」并正常退出（Windows 的中转就是这样）；或者起不来 */
function fakeSpawn(spawns, fail) {
  return (cmd, args, opts) => {
    const child = new EventEmitter();
    child.unref = () => (child.unrefed = true);
    spawns.push({ cmd, args, opts, child });
    setImmediate(() => {
      if (fail) return child.emit('error', new Error('spawn ' + cmd + ' ENOENT'));
      child.emit('spawn');
      child.emit('exit', 0);
    });
    return child;
  };
}

/** 临时目录里摆一个「装好的」Windows 版（installed = 旁边有卸载程序） */
function setupWin({ replies = [], installed = true, packaged = true, spawnFail = false } = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds_pet-updater-'));
  tmpDirs.push(tmp);
  const installDir = path.join(tmp, 'Programs', 'ds_pet');
  fs.mkdirSync(installDir, { recursive: true });
  const exe = path.join(installDir, 'ds_pet.exe');
  fs.writeFileSync(exe, '');
  if (installed) fs.writeFileSync(path.join(installDir, U.WIN_UNINSTALLER), '');
  const calls = [];
  const spawns = [];
  const quits = [];
  const u = U.createUpdater({
    current: '1.2.1',
    packaged,
    exePath: exe,
    dataDir: path.join(tmp, 'data'),
    t,
    lang: () => 'zh',
    arch: 'x64',
    platform: 'win32',
    spawn: fakeSpawn(spawns, spawnFail),
    fetch: async (url, init = {}) => {
      calls.push({ url: String(url), headers: init.headers || {} });
      const r = replies.shift();
      if (!r) throw new Error('没预料到的请求 ' + url);
      return r();
    },
    quit: () => quits.push(1),
  });
  return { u, calls, spawns, quits, installDir, exe, data: path.join(tmp, 'data') };
}

test('Windows：安装包命名，按系统和芯片挑（便携版 zip 不算）', () => {
  assert.equal(U.assetName('1.3.0', 'x64', 'win32'), 'ds_pet-1.3.0-win-x64-setup.exe');
  assert.equal(U.assetName('1.3.0', 'arm64'), 'ds_pet-1.3.0-arm64.dmg', '不写系统 = macOS（老规矩不变）');
  const rel = winRelease('1.3.0');
  assert.equal(U.parseRelease(rel, 'arm64', 'win32').asset.name, 'ds_pet-1.3.0-win-arm64-setup.exe');
  assert.equal(U.parseRelease(rel, 'x64', 'win32').asset.name, 'ds_pet-1.3.0-win-x64-setup.exe');
  assert.equal(U.parseRelease(rel, 'x64').asset.name, 'ds_pet-1.3.0-x64.dmg', '有了 Windows 安装包，macOS 照样挑 DMG');
  assert.equal(U.parseRelease(release('1.3.0'), 'x64', 'win32').asset, null, '只有 DMG 的旧版本：Windows 上没有能装的');
  const renamed = release('1.3.0', { assets: [{ name: 'ds_pet-Setup-win-x64-setup.exe', size: 1, browser_download_url: 'https://github.com/x' }] });
  assert.equal(U.parseRelease(renamed, 'x64', 'win32').asset.name, 'ds_pet-Setup-win-x64-setup.exe');
});

test('Windows：能不能就地更新（安装版可以；便携版、开发版、没权限不行）', () => {
  assert.equal(U.installDirOf(path.join('Programs', 'ds_pet', 'ds_pet.exe'), 'win32'), path.join('Programs', 'ds_pet'));
  const ok = { packaged: true, appPath: 'C:\\Users\\a\\AppData\\Local\\Programs\\ds_pet', writable: true, platform: 'win32', installed: true };
  assert.equal(U.installBlocker(ok), null);
  assert.equal(U.installBlocker({ ...ok, packaged: false }), 'dev');
  assert.equal(U.installBlocker({ ...ok, installed: false }), 'portable');
  assert.equal(U.installBlocker({ ...ok, appPath: null }), 'portable');
  assert.equal(U.installBlocker({ ...ok, writable: false }), 'permission');
  assert.equal(U.installBlocker({ ...ok, appPath: '/Volumes/ds_pet' }), null, 'macOS 的规则不套到 Windows 上');
});

test('Windows 更新脚本：只有 ASCII，步骤齐全（等旧进程 → /S /D= 静默装回原文件夹 → 删安装程序 → 重新打开）', () => {
  const s = U.UPDATE_SCRIPT_WIN;
  assert.ok(!/[^\x00-\x7f]/.test(s), 'Windows PowerShell 5.1 按系统代码页读脚本，别放非 ASCII');
  assert.ok(!s.includes('${'), '模板字符串里不能有 ${');
  for (const step of [
    "Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -ArgumentList $relay",
    "' -Detached'",
    'Get-Process -Id $OldPid',
    "@('/S', ('/D=' + $InstallDir))",
    '$p.WaitForExit()',
    'Remove-Item -LiteralPath $Installer',
    'Start-Process -FilePath $Exe',
  ]) {
    assert.ok(s.includes(step), step);
  }
  assert.ok(s.indexOf('/D=') < s.indexOf('Start-Process -FilePath $Exe'), '先装再打开');
  assert.ok(s.indexOf('exit 0') < s.indexOf('Get-Process -Id $OldPid'), '中转那份起好干活的那份就退出，不等旧进程');
});

test('Windows：检查更新 → 挑本机芯片的安装程序；装好的版本可以一键更新', async () => {
  const { u, calls } = setupWin({ replies: [json(winRelease('1.3.0'))] });
  const st = await u.check({ manual: true });
  assert.equal(st.phase, 'available');
  assert.equal(st.latest.asset.name, 'ds_pet-1.3.0-win-x64-setup.exe');
  assert.equal(st.blocker, null);
  assert.match(calls[0].headers['User-Agent'], /Windows/);
});

test('Windows：便携版（旁边没有卸载程序）→ 不去下载，提示去 GitHub', async () => {
  const { u, calls } = setupWin({ installed: false, replies: [json(winRelease('1.3.0'))] });
  const st0 = await u.check({ manual: true });
  assert.equal(st0.blocker, 'portable');
  const st = await u.install();
  assert.equal(st.phase, 'error');
  assert.equal(st.error, t('update.block.portable'));
  assert.equal(calls.length, 1, '没有去下载');
});

test('Windows：下载校验通过 → 起 PowerShell 脚本（装回原文件夹、再打开原来的 exe）→ 退出', async () => {
  const { u, spawns, quits, installDir, exe, data } = setupWin({ replies: [json(winRelease('1.3.0')), () => new Response('MZsetup')] });
  await u.check({ manual: true });
  const st = await u.install();
  assert.equal(st.phase, 'restarting', st.error);
  assert.equal(spawns.length, 1);
  const { cmd, args, opts, child } = spawns[0];
  assert.match(cmd, /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/);
  const arg = (name) => args[args.indexOf(name) + 1];
  assert.equal(arg('-ExecutionPolicy'), 'Bypass');
  assert.equal(arg('-OldPid'), String(process.pid));
  assert.equal(arg('-InstallDir'), installDir);
  assert.equal(arg('-Exe'), exe);
  assert.equal(path.basename(arg('-Installer')), 'ds_pet-1.3.0-win-x64-setup.exe');
  assert.equal(fs.readFileSync(arg('-Installer'), 'utf8'), 'MZsetup');
  const script = fs.readFileSync(arg('-File'), 'utf8');
  assert.equal(script, '\ufeff' + U.UPDATE_SCRIPT_WIN, '脚本带 BOM 写出去');
  assert.equal(opts.detached, false, 'Windows 上 detached 的 PowerShell 没有控制台，会直接退出（见 launch()）');
  assert.equal(opts.windowsHide, true);
  assert.equal(child.unrefed, true);
  assert.ok(fs.existsSync(path.join(data, 'updates', 'just-updated.json')));
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(quits.length, 1);
});

test('Windows：下载的不是 Windows 程序 → 报错、不退出', async () => {
  const { u, spawns, quits } = setupWin({ replies: [json(winRelease('1.3.0', 'evil!!')), () => new Response('evil!!')] });
  await u.check({ manual: true });
  const st = await u.install();
  assert.equal(st.phase, 'error');
  assert.equal(st.error, t('update.err.bundle', { why: 'not a Windows program' }));
  assert.equal(spawns.length, 0);
  assert.equal(quits.length, 0);
});

test('Windows：PowerShell 起不来 → 报「没能开始安装」，不退出、不留更新标记', async () => {
  const { u, quits, data } = setupWin({ spawnFail: true, replies: [json(winRelease('1.3.0')), () => new Response('MZsetup')] });
  await u.check({ manual: true });
  const st = await u.install();
  assert.equal(st.phase, 'error');
  assert.ok(st.error.startsWith(t('update.err.launch', { msg: '' })), st.error);
  assert.equal(fs.existsSync(path.join(data, 'updates', 'just-updated.json')), false);
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(quits.length, 0);
});

test('Windows 更新脚本：真跑一遍 PowerShell（安装程序收到 /S /D=<带空格的原文件夹>，装完删掉、再打开）', { skip: process.platform !== 'win32' && '只在 Windows 上跑' }, async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ds_pet-updater-'));
  tmpDirs.push(tmp);
  const installDir = path.join(tmp, 'Program Files X', 'ds_pet');
  fs.mkdirSync(installDir, { recursive: true });
  const relaunched = path.join(tmp, 'relaunched.txt');
  const exe = path.join(installDir, 'relaunch.cmd');
  fs.writeFileSync(exe, `@echo relaunched> "${relaunched}"\r\n`);
  const argsLog = path.join(tmp, 'installer-args.txt');
  const installer = path.join(tmp, 'setup.cmd');
  fs.writeFileSync(installer, `@echo %*> "${argsLog}"\r\n@exit /b 0\r\n`);
  const script = path.join(tmp, 'update.ps1');
  fs.writeFileSync(script, '\ufeff' + U.UPDATE_SCRIPT_WIN);
  const dead = spawnSync(process.execPath, ['-e', '0']).pid; // 一个已经退出的进程
  const log = path.join(tmp, 'update.log');
  // 和应用里一样不带 -Detached 起：中转那份马上退出，真正干活的那份在后台接着跑
  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-OldPid', String(dead), '-Installer', installer, '-InstallDir', installDir, '-Exe', exe, '-Log', log],
    { encoding: 'utf8', timeout: 60000 },
  );
  const read = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '');
  assert.equal(r.status, 0, r.stderr);
  for (let i = 0; i < 300 && !(fs.existsSync(relaunched) && /update done/.test(read(log))); i++) await new Promise((res) => setTimeout(res, 100));
  assert.ok(fs.existsSync(relaunched), '重新打开了；日志：' + read(log));
  assert.equal(read(argsLog).trim(), '/S /D=' + installDir);
  assert.equal(fs.existsSync(installer), false, '装完删掉安装程序');
  assert.match(read(log), /update done/);
});
