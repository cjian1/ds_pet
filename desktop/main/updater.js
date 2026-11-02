'use strict';
/**
 * 一键更新：从 GitHub Releases 查新版本 → 下载对应系统和芯片的安装包 → 校验 → 换成新版本 → 重启。
 *
 * 为什么不用 Electron 自带的 autoUpdater：它（Squirrel.Mac）要求应用有 Apple 开发者签名，ds_pet 只有本地签名；
 * Windows 上它要的是 Squirrel.Windows 那一套安装方式，而 ds_pet 用的是自己的 NSIS 安装程序。
 *
 *   check()    GET {API}/releases/latest，比较版本号
 *   install()  macOS：下载 ds_pet-<版本>-<arm64|x64>.dmg（只认 GitHub 的下载地址；接口给了 sha256 就校验）
 *                → hdiutil 挂载 → 核对里面的 ds_pet.app（Bundle ID、版本号、签名完整性）→ 拷到暂存目录
 *                → 起一个独立的小脚本（UPDATE_SCRIPT）：等本进程退出 → 替换 → 重新打开；本进程退出
 *              Windows：下载 ds_pet-<版本>-win-<x64|arm64>-setup.exe（同样的地址白名单和 sha256 校验）
 *                → 起一个独立的 PowerShell 小脚本（UPDATE_SCRIPT_WIN）：等本进程退出 → 静默安装到原来的文件夹
 *                → 重新打开；本进程退出。只有安装版能这样更新（便携版旁边没有卸载程序，提示去 GitHub 下载）
 *   新版本启动时 takeMarker() 读到 updates/just-updated.json，她会说一句「更新好啦」。
 *
 * 状态（推给设置页 / 菜单栏）：
 *   {phase, current, latest: {version, notes, highlights, url, asset} | null, progress, error, checkedAt, blocker, appPath}
 *   highlights = 发布说明里「更新内容」那几行（按界面语言挑好）
 *   phase = idle | checking | latest | available | downloading | installing | restarting | error
 *   appPath = 要替换的东西：macOS 是 ds_pet.app，Windows 是安装文件夹
 *
 * 纯函数（版本比较、解析发布、地址白名单、能不能就地更新、更新内容摘取）单独导出，单测见 test/updater.test.js。
 * DS_PET_UPDATE_API 可以把发布接口指到别处（只给本地端到端测试用，此时也放行同一来源的下载地址）。
 */
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const { execFile, execFileSync } = childProcess;

const REPO = 'cjian1/ds_pet';
const BUNDLE_ID = 'io.github.cjian1.ds-pet';
/** Windows 安装版的卸载程序（名字和 scripts/win-installer.nsi 一致）：ds_pet.exe 旁边有它 = 安装版 */
const WIN_UNINSTALLER = 'Uninstall ds_pet.exe';
const DEFAULT_API = 'https://api.github.com/repos/' + REPO + '/releases/latest';
const RELEASES_PAGE = 'https://github.com/' + REPO + '/releases/latest';
/** 发布下载会从 github.com 跳到这些域名 */
const DOWNLOAD_HOSTS = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];

// ---------------------------------------------------------------- 纯函数
/** "v1.2.3" / "1.2" → [1, 2, 3]；不是版本号返回 null（预发布后缀如 -beta 忽略） */
function parseVersion(v) {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:[-+].*)?$/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
}

/** a > b → 1，相等 → 0，a < b → -1；有一边不是版本号 → 0（当作没有更新） */
function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}

/**
 * 发布里的安装包叫什么（和打包脚本一致，单测钉住）：
 *   macOS    ds_pet-1.3.0-arm64.dmg            （scripts/build-mac.sh）
 *   Windows  ds_pet-1.3.0-win-x64-setup.exe    （scripts/build-win.mjs；同目录的 -win-x64.zip 是便携版）
 */
function assetName(version, arch, platform = 'darwin') {
  return platform === 'win32' ? 'ds_pet-' + version + '-win-' + arch + '-setup.exe' : 'ds_pet-' + version + '-' + arch + '.dmg';
}

/** GitHub 的发布 JSON → {version, notes, url, asset}；asset 是本机系统和芯片的安装包（没有就是 null） */
function parseRelease(json, arch, platform = 'darwin') {
  if (!json || typeof json !== 'object' || json.draft || json.prerelease) throw new Error('not a release');
  const version = parseVersion(json.tag_name) ? String(json.tag_name).replace(/^v/, '') : null;
  if (!version) throw new Error('bad tag: ' + json.tag_name);
  const assets = Array.isArray(json.assets) ? json.assets : [];
  const want = assetName(version, arch, platform);
  // 名字不标准时（比如手动传的）按结尾找
  const tail = platform === 'win32' ? '-win-' + arch + '-setup.exe' : '-' + arch + '.dmg';
  const hit =
    assets.find((a) => a && a.name === want) ||
    assets.find((a) => a && typeof a.name === 'string' && a.name.endsWith(tail));
  return {
    version,
    notes: String(json.body || ''),
    url: String(json.html_url || RELEASES_PAGE),
    asset: hit
      ? { name: String(hit.name), size: Number(hit.size) || 0, url: String(hit.browser_download_url || ''), digest: String(hit.digest || '') }
      : null,
  };
}

/** 下载地址必须是 https 的 GitHub 域名（extraOrigin = 测试用的发布接口来源） */
function allowedDownload(url, extraOrigin) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (extraOrigin && u.origin === extraOrigin) return true;
  return u.protocol === 'https:' && DOWNLOAD_HOSTS.includes(u.hostname);
}

/** 可执行文件路径 → 所在的 .app（…/ds_pet.app/Contents/MacOS/ds_pet → …/ds_pet.app） */
function bundleOf(exePath) {
  const m = /^(.*?\.app)\/Contents\/MacOS\/[^/]+$/.exec(String(exePath || ''));
  return m ? m[1] : null;
}

/** 更新要替换的东西：macOS 是 ds_pet.app；Windows 是 ds_pet.exe 所在的文件夹 */
function installDirOf(exePath, platform = 'darwin') {
  if (platform !== 'win32') return bundleOf(exePath);
  return exePath ? path.dirname(String(exePath)) : null;
}

/**
 * 能不能就地更新；不能就返回原因（对应文案 update.block.<原因>）：
 *   dev           没打包（npm start）
 *   translocated  （macOS）从下载目录直接打开、被系统「隔离运行」的副本，或者还在 DMG 里
 *   portable      （Windows）便携版：旁边没有卸载程序，不是用安装程序装的
 *   permission    没有权限替换（比如装在别的用户的「应用程序」里）
 */
function installBlocker({ packaged, appPath, writable, platform = 'darwin', installed = true }) {
  if (!packaged) return 'dev';
  if (platform === 'win32') {
    if (!appPath || !installed) return 'portable';
  } else if (!appPath || /\/AppTranslocation\//.test(appPath) || /^\/Volumes\/ds_pet/.test(appPath)) {
    return 'translocated';
  }
  if (!writable) return 'permission';
  return null;
}

/**
 * 发布说明里摘出「更新内容」那一段，按界面语言挑行（说明是中英各一行）：
 * 找标题里带「更新」或 What's new 的 ## 段，到下一个 ## 为止；中文挑含汉字的行，英文挑不含汉字的行。
 */
function releaseHighlights(body, lang) {
  const lines = String(body || '').split(/\r?\n/);
  const start = lines.findIndex((l) => /^##\s/.test(l) && /更新|what'?s new/i.test(l));
  if (start < 0) return [];
  const out = [];
  for (const raw of lines.slice(start + 1)) {
    if (/^##\s/.test(raw)) break;
    const text = raw.replace(/^\s*[-*]\s+/, '').trim();
    if (!text) continue;
    const cjk = /[㐀-鿿]/.test(text);
    if ((lang === 'en') !== cjk) out.push(text);
  }
  return out;
}

/** hdiutil attach -plist 的输出里找挂载点 */
function mountPointOf(plistXml) {
  const m = /<key>mount-point<\/key>\s*<string>([^<]+)<\/string>/.exec(String(plistXml || ''));
  return m ? m[1] : null;
}

/**
 * 替换脚本：参数 = 旧进程 pid、要替换的 .app、暂存的新 .app、日志文件。
 * 先把新版本拷到同目录的临时名，再「挪走旧的 → 挪进新的」两次改名，任何一步失败都恢复旧版本并重新打开它。
 * 用 open -n 打开：按路径开这一份（同 Bundle ID 的别的副本在运行也不影响）。
 * （变量一律写成 ${x}：macOS 自带 bash 3.2 在 UTF-8 下会把紧跟变量名的中文当成变量名的一部分）
 */
const UPDATE_SCRIPT = `#!/bin/bash
pid="$1"; target="$2"; staged="$3"; log="$4"
exec >>"\${log}" 2>&1
echo "[$(date '+%F %T')] update start pid=\${pid} target=\${target}"
relaunch() {
  if [ -n "\${DS_PET_DATA_DIR}" ]; then
    open -n --env "DS_PET_DATA_DIR=\${DS_PET_DATA_DIR}" "$1" || open -n "$1"
  else
    open -n "$1"
  fi
}
for _ in $(seq 1 150); do kill -0 "\${pid}" 2>/dev/null || break; sleep 0.2; done
if kill -0 "\${pid}" 2>/dev/null; then echo "old process still running, giving up"; exit 1; fi
dir="$(dirname "\${target}")"
next="\${dir}/.ds_pet-update-$$.app"
old="\${dir}/.ds_pet-old-$$.app"
rm -rf "\${next}"
if ! ditto "\${staged}" "\${next}"; then echo "copy failed"; rm -rf "\${next}"; relaunch "\${target}"; exit 1; fi
xattr -dr com.apple.quarantine "\${next}" 2>/dev/null
if ! mv "\${target}" "\${old}"; then echo "move old failed"; rm -rf "\${next}"; relaunch "\${target}"; exit 1; fi
if ! mv "\${next}" "\${target}"; then echo "move new failed, restoring"; mv "\${old}" "\${target}"; relaunch "\${target}"; exit 1; fi
rm -rf "\${old}" "\${staged}"
echo "[$(date '+%F %T')] update done"
relaunch "\${target}"
`;

/**
 * Windows 的更新脚本（PowerShell 5.1，系统自带）：参数 = 旧进程 pid、下载好的安装程序、安装文件夹、要重新打开的 exe、日志。
 * 等旧进程退出 → 安装程序静默安装（/S，/D= 指定装回原来的文件夹，必须放最后、不能加引号，路径带空格也照样）
 * → 删掉安装程序 → 重新打开。安装失败也会把（旧的）ds_pet 打开，不会让她就此消失。
 * 只用 ASCII（Windows PowerShell 5.1 按系统代码页读没有 BOM 的脚本），写文件时另加 BOM。
 *
 * 开头那段是「中转」：本进程直接起的 PowerShell 不能 detached（那样没有控制台，PowerShell 一声不吭直接退出，实测），
 * 可不 detached 的子进程又在 Node 的作业对象里，ds_pet 一退出就被系统连带结束。所以它只用 Start-Process
 * 另起一份带 -Detached 的自己（孙进程不在作业里），然后马上退出；真正干活的是那一份（见 launch()）。
 */
const UPDATE_SCRIPT_WIN = `param(
  [int]$OldPid,
  [string]$Installer,
  [string]$InstallDir,
  [string]$Exe,
  [string]$Log,
  [switch]$Detached
)
if (-not $Detached) {
  $q = { param([string]$s) '"' + $s + '"' }
  $relay = '-NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File ' + (& $q $PSCommandPath)
  $relay += ' -OldPid ' + $OldPid + ' -Installer ' + (& $q $Installer) + ' -InstallDir ' + (& $q $InstallDir)
  $relay += ' -Exe ' + (& $q $Exe) + ' -Log ' + (& $q $Log) + ' -Detached'
  Start-Process -FilePath (Join-Path $PSHOME 'powershell.exe') -WindowStyle Hidden -ArgumentList $relay
  exit 0
}
function Write-Log([string]$Message) {
  $line = '[' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '] ' + $Message
  Add-Content -LiteralPath $Log -Value $line -Encoding UTF8
}
Write-Log ('update start pid=' + $OldPid + ' dir=' + $InstallDir)
for ($i = 0; $i -lt 150; $i++) {
  if (-not (Get-Process -Id $OldPid -ErrorAction SilentlyContinue)) { break }
  Start-Sleep -Milliseconds 200
}
if (Get-Process -Id $OldPid -ErrorAction SilentlyContinue) {
  Write-Log 'old process still running, giving up'
  exit 1
}
$code = -1
try {
  $p = Start-Process -FilePath $Installer -ArgumentList @('/S', ('/D=' + $InstallDir)) -PassThru
  $null = $p.Handle
  $p.WaitForExit()
  $code = $p.ExitCode
} catch {
  Write-Log ('installer failed to start: ' + $_)
}
Write-Log ('installer exit ' + $code)
Remove-Item -LiteralPath $Installer -Force -ErrorAction SilentlyContinue
if (-not (Test-Path -LiteralPath $Exe)) {
  Write-Log 'app missing after install'
  exit 1
}
Start-Process -FilePath $Exe
if ($code -ne 0) { exit 1 }
Write-Log 'update done'
`;

// ---------------------------------------------------------------- 更新器
class UpdateError extends Error {
  constructor(key, vars) {
    super(key);
    this.key = key;
    this.vars = vars || {};
  }
}

/**
 * 该装哪个芯片的版本：Apple 芯片上跑着 Intel 版（Rosetta）、或者 ARM 版 Windows 上跑着 x64 版（模拟运行）时，
 * 顺便换成原生的 arm64 版。Windows 看注册表里的系统架构（x64 进程在模拟下看到的环境变量是 AMD64，不准）。
 */
function nativeArch(platform = process.platform) {
  if (process.arch !== 'x64') return process.arch;
  try {
    if (platform === 'win32') {
      const out = execFileSync(
        'reg',
        ['query', 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', '/v', 'PROCESSOR_ARCHITECTURE'],
        { encoding: 'utf8', windowsHide: true },
      );
      return /\bARM64\b/i.test(out) ? 'arm64' : 'x64';
    }
    return execFileSync('sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8' }).trim() === '1' ? 'arm64' : 'x64';
  } catch {
    return 'x64';
  }
}

function run(cmd, args, timeout = 120000) {
  return new Promise((resolve, reject) =>
    execFile(cmd, args, { timeout, maxBuffer: 4 * 1024 * 1024 }, (err, out, errOut) =>
      err ? reject(new Error(String(errOut || err.message).trim().slice(0, 200))) : resolve(String(out)),
    ),
  );
}

/**
 * @param {object} o
 * @param {string} o.current                当前版本（app.getVersion()）
 * @param {boolean} o.packaged
 * @param {string} o.exePath                app.getPath('exe')
 * @param {string} o.dataDir                数据目录（~/Library/Application Support/ds_pet、%APPDATA%\ds_pet）
 * @param {(key, vars) => string} o.t       翻译
 * @param {() => string} [o.lang]           界面语言（zh / en），摘更新内容用
 * @param {Function} [o.fetch]              默认 electron net.fetch（走系统代理）
 * @param {string} [o.arch]
 * @param {string} [o.platform]             默认 process.platform（单测可以指定）
 * @param {Function} [o.spawn]              默认 child_process.spawn（单测替换成假的）
 * @param {(state) => void} [o.onState]
 * @param {() => void} [o.quit]             安装脚本起好之后退出本进程
 */
function createUpdater(o) {
  const api = process.env.DS_PET_UPDATE_API || DEFAULT_API;
  const apiOrigin = process.env.DS_PET_UPDATE_API ? new URL(api).origin : '';
  const doFetch = o.fetch || ((...a) => require('electron').net.fetch(...a));
  const platform = o.platform || process.platform;
  const isWin = platform === 'win32';
  const doSpawn = o.spawn || childProcess.spawn;
  const arch = o.arch || nativeArch(platform);
  const dir = path.join(o.dataDir, 'updates');
  const appPath = installDirOf(o.exePath, platform);
  const ua = 'ds_pet/' + o.current + ' (' + (isWin ? 'Windows' : 'macOS') + ' desktop pet; updater)';

  let state = { phase: 'idle', current: o.current, latest: null, progress: 0, error: '', checkedAt: 0, blocker: null, appPath };
  let abort = null;
  let lastPush = 0;

  // Windows 上 fs.access 不看权限表（ACL），只能真写一个小文件试试；结果记住（每次推状态都要算 blocker）
  let winWritable = null;
  const writable = () => {
    try {
      if (isWin) {
        if (winWritable === null) {
          const probe = path.join(appPath, '.ds_pet-write-test-' + process.pid);
          try {
            fs.writeFileSync(probe, '');
            fs.rmSync(probe, { force: true });
            winWritable = true;
          } catch {
            winWritable = false;
          }
        }
        return winWritable;
      }
      fs.accessSync(path.dirname(appPath), fs.constants.W_OK);
      fs.accessSync(appPath, fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };
  const installed = () => !isWin || (!!appPath && fs.existsSync(path.join(appPath, WIN_UNINSTALLER)));
  const blocker = () =>
    installBlocker({ packaged: o.packaged, appPath, platform, installed: installed(), writable: !!appPath && writable() });

  function set(patch, force) {
    state = Object.assign({}, state, patch, { blocker: blocker() });
    // 下载进度别刷屏：最多 5 次/秒
    const now = Date.now();
    if (!force && state.phase === 'downloading' && now - lastPush < 200) return;
    lastPush = now;
    if (o.onState) o.onState(get());
  }
  function get() {
    const out = JSON.parse(JSON.stringify(state));
    if (out.latest) out.latest.highlights = releaseHighlights(out.latest.notes, o.lang ? o.lang() : 'zh');
    return out;
  }
  function fail(e) {
    const msg = e instanceof UpdateError ? o.t('update.err.' + e.key, e.vars) : o.t('update.err.network', { msg: e.message });
    set({ phase: 'error', error: msg, progress: 0 }, true);
  }

  async function check({ manual = false } = {}) {
    if (['checking', 'downloading', 'installing', 'restarting'].includes(state.phase)) return get();
    const before = state.phase;
    set({ phase: 'checking', error: '' }, true);
    try {
      const res = await doFetch(api, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': ua }, signal: AbortSignal.timeout(20000) });
      if (res.status === 404) {
        set({ phase: 'latest', latest: null, checkedAt: Date.now() }, true);
        return get();
      }
      if (res.status === 403 || res.status === 429) throw new UpdateError('rate');
      if (!res.ok) throw new UpdateError('http', { code: res.status });
      const rel = parseRelease(await res.json(), arch, platform);
      const newer = compareVersions(rel.version, o.current) > 0;
      set({ phase: newer ? 'available' : 'latest', latest: newer ? rel : null, checkedAt: Date.now() }, true);
    } catch (e) {
      // 自动检查失败不打扰：回到之前的状态
      if (manual) fail(e);
      else set({ phase: before === 'checking' ? 'idle' : before }, true);
    }
    return get();
  }

  /** 下载到 dest，边下边算 sha256；不完整 / 校验不过就删掉 */
  async function download(asset, dest, signal) {
    if (!allowedDownload(asset.url, apiOrigin)) throw new UpdateError('badAsset');
    const res = await doFetch(asset.url, { headers: { 'User-Agent': ua, Accept: 'application/octet-stream' }, signal });
    if (!res.ok || !res.body) throw new UpdateError('http', { code: res.status });
    if (res.url && !allowedDownload(res.url, apiOrigin)) throw new UpdateError('badAsset');
    const total = asset.size || Number(res.headers.get('content-length')) || 0;
    const part = dest + '.part';
    const hash = crypto.createHash('sha256');
    const out = fs.createWriteStream(part);
    // 文件句柄真正关掉之后才能删 / 改名：Windows 上句柄还开着时删掉的文件只是「待删除」，目录里还在，同名也建不了
    const closed = new Promise((r) => out.once('close', r));
    let writeErr = null;
    out.on('error', (e) => (writeErr = writeErr || e)); // 打不开 / 写不进（比如磁盘满了）：下面统一当失败处理，别让进程崩掉
    // 等写缓冲腾出来；写出错时 drain 永远不会来，所以 close 也算（不然就一直卡在这儿）
    const drained = () =>
      new Promise((r) => {
        const done = () => {
          out.off('drain', done);
          out.off('close', done);
          r();
        };
        out.on('drain', done);
        out.on('close', done);
      });
    let got = 0;
    try {
      for await (const chunk of res.body) {
        if (writeErr) throw writeErr;
        hash.update(chunk);
        got += chunk.length;
        if (!out.write(chunk)) await drained();
        if (total) set({ phase: 'downloading', progress: Math.min(1, got / total) });
      }
      await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
      if (writeErr) throw writeErr;
      await closed;
    } catch (e) {
      out.destroy();
      await closed;
      await fsp.rm(part, { force: true });
      throw e;
    }
    if (asset.size && got !== asset.size) {
      await fsp.rm(part, { force: true });
      throw new UpdateError('size');
    }
    const want = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '');
    if (want && hash.digest('hex') !== want[1].toLowerCase()) {
      await fsp.rm(part, { force: true });
      throw new UpdateError('checksum');
    }
    await fsp.rename(part, dest);
  }

  /** 挂载 DMG，核对里面的应用，拷到暂存目录；返回暂存的 .app */
  async function stage(dmg, version) {
    let mount;
    try {
      mount = mountPointOf(await run('hdiutil', ['attach', '-nobrowse', '-readonly', '-noautoopen', '-mountrandom', dir, '-plist', dmg]));
    } catch (e) {
      throw new UpdateError('mount', { msg: e.message });
    }
    if (!mount) throw new UpdateError('mount', { msg: 'no mount point' });
    const staged = path.join(dir, 'ds_pet.app');
    try {
      const src = path.join(mount, 'ds_pet.app');
      const plist = path.join(src, 'Contents', 'Info.plist');
      if (!fs.existsSync(plist)) throw new UpdateError('bundle', { why: 'ds_pet.app not found' });
      const id = (await run('plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', plist])).trim();
      const ver = (await run('plutil', ['-extract', 'CFBundleShortVersionString', 'raw', '-o', '-', plist])).trim();
      if (id !== BUNDLE_ID) throw new UpdateError('bundle', { why: id });
      if (ver !== version) throw new UpdateError('bundle', { why: ver + ' ≠ ' + version });
      await fsp.rm(staged, { recursive: true, force: true });
      await run('ditto', [src, staged]);
    } finally {
      await run('hdiutil', ['detach', mount, '-force']).catch(() => {});
    }
    try {
      await run('codesign', ['--verify', '--deep', '--strict', staged]);
    } catch (e) {
      throw new UpdateError('bundle', { why: 'codesign: ' + e.message });
    }
    return staged;
  }

  /** macOS：挂载 DMG 核对、暂存好新的 .app，返回要起的替换脚本 [命令, 参数] */
  async function handOffMac(dmg, version) {
    const staged = await stage(dmg, version);
    await fsp.rm(dmg, { force: true });
    const script = path.join(dir, 'update.sh');
    await fsp.writeFile(script, UPDATE_SCRIPT, { mode: 0o755 });
    return ['/bin/bash', [script, String(process.pid), appPath, staged, path.join(dir, 'update.log')]];
  }

  /**
   * Windows：核对下载的确实是个 Windows 程序（MZ 开头；sha256 和大小前面已经对过），
   * 返回要起的 PowerShell 脚本 [命令, 参数]（用系统目录里那份，不靠 PATH）。
   */
  async function handOffWin(setup) {
    const head = Buffer.alloc(2);
    const fh = await fsp.open(setup, 'r');
    try {
      await fh.read(head, 0, 2, 0);
    } finally {
      await fh.close();
    }
    if (head.toString('latin1') !== 'MZ') throw new UpdateError('bundle', { why: 'not a Windows program' });
    const script = path.join(dir, 'update.ps1');
    await fsp.writeFile(script, '\ufeff' + UPDATE_SCRIPT_WIN, 'utf8');
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script];
    args.push('-OldPid', String(process.pid), '-Installer', setup, '-InstallDir', appPath, '-Exe', o.exePath);
    args.push('-Log', path.join(dir, 'update.log'));
    return [ps, args];
  }

  /**
   * 起替换脚本，确认它真的跑起来了才退出（起不来——比如找不到 PowerShell——就报错，别让她就这么退出消失）。
   *   macOS    脱离本进程（detached）的 bash，起来了就行。
   *   Windows  不 detached（原因见 UPDATE_SCRIPT_WIN 开头的「中转」）：等中转那份 PowerShell 正常退出，
   *            说明真正干活的那份已经起来了；最多等 30 秒。
   */
  async function launch(cmd, args) {
    const child = doSpawn(cmd, args, { detached: !isWin, stdio: 'ignore', windowsHide: true, env: process.env });
    let timer = null;
    try {
      await new Promise((resolve, reject) => {
        child.once('error', reject);
        if (!isWin) {
          child.once('spawn', resolve);
          return;
        }
        child.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('PowerShell exit code ' + code))));
        timer = setTimeout(() => reject(new Error('PowerShell timed out')), 30000);
      });
    } catch (e) {
      throw new UpdateError('launch', { msg: e.message });
    } finally {
      clearTimeout(timer);
    }
    child.unref();
  }

  async function install() {
    if (['downloading', 'installing', 'restarting'].includes(state.phase)) return get();
    const why = blocker();
    if (why) {
      set({ phase: 'error', error: o.t('update.block.' + why, { path: appPath || '' }) }, true);
      return get();
    }
    const rel = state.latest;
    if (!rel) return check({ manual: true });
    if (!rel.asset) {
      fail(new UpdateError('noAsset', { arch }));
      return get();
    }
    abort = new AbortController();
    set({ phase: 'downloading', progress: 0, error: '' }, true);
    try {
      await fsp.mkdir(dir, { recursive: true });
      await cleanup();
      const file = path.join(dir, path.basename(rel.asset.name));
      await download(rel.asset, file, abort.signal);
      abort = null;
      set({ phase: 'installing', progress: 1 }, true);
      const [cmd, args] = isWin ? await handOffWin(file) : await handOffMac(file, rel.version);
      await launch(cmd, args);
      await fsp.writeFile(path.join(dir, 'just-updated.json'), JSON.stringify({ from: o.current, to: rel.version, at: Date.now() }));
      set({ phase: 'restarting' }, true);
      if (o.quit) setTimeout(o.quit, 300);
    } catch (e) {
      abort = null;
      if (e && e.name === 'AbortError') set({ phase: 'available', progress: 0 }, true);
      else fail(e);
    }
    return get();
  }

  /** 取消下载 */
  function cancel() {
    if (abort) abort.abort();
  }

  /** 清掉上次留下的安装包 / 暂存应用（日志和更新标记留着） */
  async function cleanup() {
    let names = [];
    try {
      names = await fsp.readdir(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (/\.(dmg|exe)(\.part)?$/.test(n) || ['ds_pet.app', 'update.sh', 'update.ps1'].includes(n)) {
        await fsp.rm(path.join(dir, n), { recursive: true, force: true });
      }
    }
  }

  /** 新版本启动时读一次更新标记：{from, to, ok}；没有 / 太旧（一天前）就是 null */
  function takeMarker() {
    const file = path.join(dir, 'just-updated.json');
    let m = null;
    try {
      m = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return null;
    }
    fs.rmSync(file, { force: true });
    if (!m || Date.now() - Number(m.at || 0) > 24 * 3600 * 1000) return null;
    return { from: String(m.from || ''), to: String(m.to || ''), ok: compareVersions(o.current, m.to) >= 0 };
  }

  return { check, install, cancel, cleanup, takeMarker, get, arch, appPath };
}

module.exports = {
  REPO,
  BUNDLE_ID,
  WIN_UNINSTALLER,
  RELEASES_PAGE,
  DOWNLOAD_HOSTS,
  UPDATE_SCRIPT,
  UPDATE_SCRIPT_WIN,
  parseVersion,
  compareVersions,
  assetName,
  parseRelease,
  allowedDownload,
  bundleOf,
  installDirOf,
  installBlocker,
  releaseHighlights,
  mountPointOf,
  createUpdater,
};
