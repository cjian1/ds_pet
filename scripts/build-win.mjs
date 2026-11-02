#!/usr/bin/env node
// 把 desktop/ 打包成 Windows 版 ds_pet（在 macOS、Linux、Windows 上都能打）。
//
//   node scripts/build-win.mjs                 打 x64 版 → dist/win-x64/ds_pet/、便携版 zip、安装程序
//   node scripts/build-win.mjs --arch arm64    打 ARM 版（arm64 = 骁龙等 ARM 电脑，x64 = 其余绝大多数电脑）
//   node scripts/build-win.mjs --arch all      两个都打
//   node scripts/build-win.mjs --no-setup      不生成安装程序（没装 NSIS 时也会自动跳过并提示）
//   node scripts/build-win.mjs --no-zip        不生成便携版 zip
//   node scripts/build-win.mjs --version 1.2.9 改用别的版本号打包（测一键更新时做「旧版本」用，不改 desktop/package.json）
//
// 产物：
//   dist/ds_pet-<版本>-win-<arch>-setup.exe   安装程序（NSIS；只装给当前用户，一键更新下载的就是它）
//   dist/ds_pet-<版本>-win-<arch>.zip         便携版（解压就能用，不能一键更新）
//
// Electron 运行时从 GitHub 下载（按官方 SHASUMS256.txt 校验）缓存到 .cache/；exe 的图标和版本信息用 resedit 改
// （纯 JS，不需要 Wine）；安装程序要 NSIS 的 makensis（macOS：brew install makensis；Windows：choco install nsis）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as ResEdit from 'resedit';
import * as PE from 'pe-library';

const require = createRequire(import.meta.url);
// 拿 Electron 当 Node 跑（ELECTRON_RUN_AS_NODE，比如没装 Node 的 Windows 电脑）时，它的 fs 会把 .asar 当成文件夹，
// 删 default_app.asar 就报 EISDIR；关掉这层「asar 当目录」的处理（普通 Node 里这一行什么也不做）
process.noAsar = true;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// 安装程序 / 卸载程序 / 应用 ID 的名字和一键更新共用一份（desktop/main/updater.js）
const U = require(path.join(ROOT, 'desktop', 'main', 'updater.js'));

const NAME = 'ds_pet';
const EXE = NAME + '.exe';
const PKG_VERSION = JSON.parse(fs.readFileSync(path.join(ROOT, 'desktop', 'package.json'), 'utf8')).version;
const ELECTRON_VERSION = String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).devDependencies.electron).replace(/^[\^~]/, '');
const IS_WIN_HOST = process.platform === 'win32';

// ---------------------------------------------------------------- 参数
const argv = process.argv.slice(2);
let arches = ['x64'];
let wantZip = true;
let wantSetup = true;
let VERSION = PKG_VERSION;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--version' || a.startsWith('--version=')) {
    VERSION = a.includes('=') ? a.split('=')[1] : argv[++i];
    if (!U.parseVersion(VERSION)) {
      console.error('--version 要像 1.2.9 这样');
      process.exit(2);
    }
    continue;
  }
  if (a === '--arch' || a.startsWith('--arch=')) {
    const v = a.includes('=') ? a.split('=')[1] : argv[++i];
    arches = v === 'all' ? ['x64', 'arm64'] : [v];
  } else if (a === '--no-zip') wantZip = false;
  else if (a === '--no-setup') wantSetup = false;
  else if (a === '-h' || a === '--help') {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 18).map((l) => l.replace(/^\/\/ ?/, '')).join('\n'));
    process.exit(0);
  } else {
    console.error('未知参数：' + a + '（--help 看用法）');
    process.exit(2);
  }
}
for (const a of arches) {
  if (!['x64', 'arm64'].includes(a)) {
    console.error('--arch 只能是 x64、arm64 或 all');
    process.exit(2);
  }
}

const step = (msg) => console.log('\x1b[1;34m==>\x1b[0m ' + msg);
const mb = (file) => (fs.statSync(file).size / 1e6).toFixed(1) + ' MB';

// ---------------------------------------------------------------- Electron 运行时
async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error('下载失败 ' + res.status + '：' + url);
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** 下载（或复用缓存的）electron-v<版本>-win32-<arch>.zip，并对照官方 SHASUMS256.txt 校验 */
async function electronZip(arch) {
  const base = `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/`;
  const name = `electron-v${ELECTRON_VERSION}-win32-${arch}.zip`;
  const dir = path.join(ROOT, '.cache', 'electron');
  fs.mkdirSync(dir, { recursive: true });
  const zip = path.join(dir, name);
  const sums = path.join(dir, `SHASUMS256-v${ELECTRON_VERSION}.txt`);
  if (!fs.existsSync(sums)) await download(base + 'SHASUMS256.txt', sums);
  const line = fs.readFileSync(sums, 'utf8').split(/\r?\n/).find((l) => l.endsWith('*' + name) || l.endsWith(' ' + name));
  if (!line) throw new Error('SHASUMS256.txt 里没有 ' + name);
  const want = line.split(/\s+/)[0].toLowerCase();
  if (!fs.existsSync(zip) || sha256(zip) !== want) {
    step(`下载 Electron ${ELECTRON_VERSION}（Windows ${arch}）`);
    await download(base + name, zip + '.part');
    if (sha256(zip + '.part') !== want) {
      fs.rmSync(zip + '.part', { force: true });
      throw new Error(name + ' 校验不通过');
    }
    fs.renameSync(zip + '.part', zip);
  }
  return zip;
}

function unzip(zip, dest) {
  fs.mkdirSync(dest, { recursive: true });
  if (IS_WIN_HOST) execFileSync('tar', ['-xf', zip, '-C', dest], { stdio: 'inherit' });
  else execFileSync('unzip', ['-q', '-o', zip, '-d', dest], { stdio: 'inherit' });
}

// ---------------------------------------------------------------- 组装
/** desktop/ 里只有 macOS 用得上的东西，不放进 Windows 版 */
const MAC_ONLY = new Set(['resources/icon.icns', 'resources/trayTemplate.png', 'resources/trayTemplate@2x.png']);

function copyApp(dest) {
  const src = path.join(ROOT, 'desktop');
  fs.cpSync(src, dest, {
    recursive: true,
    filter: (f) => {
      const rel = path.relative(src, f).split(path.sep).join('/');
      return path.basename(f) !== '.DS_Store' && !MAC_ONLY.has(rel);
    },
  });
}

/** 换掉 exe 的图标和版本信息（Electron 自带的签名随之失效，一并去掉） */
function brandExe(exe) {
  const pe = PE.NtExecutable.from(fs.readFileSync(exe), { ignoreCert: true });
  const res = PE.NtExecutableResource.from(pe);
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(res.entries);
  if (groups.length !== 1) throw new Error('electron.exe 里应该正好有一组图标，实际 ' + groups.length);
  const ico = ResEdit.Data.IconFile.from(fs.readFileSync(path.join(ROOT, 'desktop', 'resources', 'icon.ico')));
  ResEdit.Resource.IconGroupEntry.replaceIconsForResource(res.entries, groups[0].id, groups[0].lang, ico.icons.map((i) => i.data));

  const infos = ResEdit.Resource.VersionInfo.fromEntries(res.entries);
  if (infos.length !== 1) throw new Error('electron.exe 里应该正好有一份版本信息，实际 ' + infos.length);
  const vi = infos[0];
  const [major, minor, patch] = U.parseVersion(VERSION);
  const lang = vi.getAllLanguagesForStringValues()[0] || { lang: 1033, codepage: 1200 };
  vi.setFileVersion(major, minor, patch, 0, lang.lang);
  vi.setProductVersion(major, minor, patch, 0, lang.lang);
  vi.setStringValues(lang, {
    ProductName: NAME,
    FileDescription: NAME,
    CompanyName: 'ds_pet contributors',
    LegalCopyright: 'MIT License. A remix of PC2005-cloud/dsh-pet (MIT)',
    OriginalFilename: EXE,
    InternalName: NAME,
    FileVersion: VERSION,
    ProductVersion: VERSION,
  });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(pe);
  fs.writeFileSync(exe, Buffer.from(pe.generate()));
}

/** 文本文件给 Windows 用：CRLF 换行 + UTF-8 BOM（老版本记事本也能正确显示中文） */
function writeWinText(file, text) {
  fs.writeFileSync(file, '﻿' + text.replace(/\r?\n/g, '\r\n'));
}

async function assemble(arch) {
  const out = path.join(ROOT, 'dist', 'win-' + arch);
  const app = path.join(out, NAME);
  step(`组装 ${NAME}（版本 ${VERSION}，Windows ${arch}，Electron ${ELECTRON_VERSION}）`);
  fs.rmSync(out, { recursive: true, force: true });
  unzip(await electronZip(arch), app);
  fs.renameSync(path.join(app, 'electron.exe'), path.join(app, EXE));
  fs.rmSync(path.join(app, 'resources', 'default_app.asar'), { force: true });
  copyApp(path.join(app, 'resources', 'app'));
  if (VERSION !== PKG_VERSION) {
    const pkg = path.join(app, 'resources', 'app', 'package.json');
    fs.writeFileSync(pkg, JSON.stringify(Object.assign(JSON.parse(fs.readFileSync(pkg, 'utf8')), { version: VERSION }), null, 2) + '\n');
  }
  writeWinText(path.join(app, 'README.txt'), fs.readFileSync(path.join(ROOT, 'scripts', 'win-readme.txt'), 'utf8'));
  brandExe(path.join(app, EXE));
  return { out, app };
}

// ---------------------------------------------------------------- 便携版 zip
/**
 * 自己写 zip，不用系统的 zip / tar：macOS 自带的 zip 不给中文文件名打 UTF-8 标记，Windows 解压出来是乱码，
 * 动画（文件名是中文）就全找不到了。这里文件名一律 UTF-8 并打上标记（通用位 11）。
 * 不需要 zip64：单个文件和总大小都远小于 4 GB。
 */
function writeZip(zipFile, baseDir, rootName) {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const entries = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const f = path.join(dir, e.name);
      entries.push({ file: f, dir: e.isDirectory() });
      if (e.isDirectory()) walk(f);
    }
  };
  entries.push({ file: path.join(baseDir, rootName), dir: true });
  walk(path.join(baseDir, rootName));

  const fd = fs.openSync(zipFile, 'w');
  const central = [];
  let offset = 0;
  const put = (buf) => {
    fs.writeSync(fd, buf);
    offset += buf.length;
  };
  for (const { file, dir } of entries) {
    const name = Buffer.from(path.relative(baseDir, file).split(path.sep).join('/') + (dir ? '/' : ''), 'utf8');
    const data = dir ? Buffer.alloc(0) : fs.readFileSync(file);
    const crc = zlib.crc32(data);
    const packed = dir ? data : zlib.deflateRawSync(data);
    const deflate = !dir && packed.length < data.length;
    const body = deflate ? packed : data;
    const at = offset;
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 文件名
    local.writeUInt16LE(deflate ? 8 : 0, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    put(local);
    put(name);
    put(body);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0);
    c.writeUInt16LE(20, 4); // 生成方：MS-DOS（属性按 Windows 的来）
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x0800, 8);
    c.writeUInt16LE(deflate ? 8 : 0, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(body.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(dir ? 0x10 : 0x20, 38); // 文件夹 / 普通文件
    c.writeUInt32LE(at, 42);
    central.push(c, name);
  }
  const cdStart = offset;
  for (const b of central) put(b);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(offset - cdStart, 12);
  end.writeUInt32LE(cdStart, 16);
  put(end);
  fs.closeSync(fd);
}

function makeZip(out, arch) {
  const zip = path.join(ROOT, 'dist', `${NAME}-${VERSION}-win-${arch}.zip`);
  step('生成便携版 ' + path.basename(zip));
  fs.rmSync(zip, { force: true });
  writeZip(zip, out, NAME);
  console.log('    大小 ' + mb(zip));
  return zip;
}

// ---------------------------------------------------------------- 安装程序
function findMakensis() {
  const candidates = [process.env.MAKENSIS, 'makensis'];
  if (IS_WIN_HOST) {
    for (const base of [process.env['ProgramFiles(x86)'], process.env.ProgramFiles]) if (base) candidates.push(path.join(base, 'NSIS', 'makensis.exe'));
  }
  for (const c of candidates.filter(Boolean)) {
    if (spawnSync(c, [(IS_WIN_HOST ? '/' : '-') + 'VERSION'], { encoding: 'utf8' }).status === 0) return c; // Windows 上的 makensis 用 / 开头的开关
  }
  return null;
}

/** 卸载清单：只删安装进去的文件，再从最深处往上删空文件夹（用户自己放进来的东西不碰） */
function uninstallList(app, file) {
  const files = [];
  const dirs = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) {
        walk(f);
        dirs.push(f);
      } else files.push(f);
    }
  };
  walk(app);
  const win = (f) => '$INSTDIR\\' + path.relative(app, f).split(path.sep).join('\\');
  const lines = [...files.map((f) => `Delete "${win(f)}"`), ...dirs.map((d) => `RMDir "${win(d)}"`)];
  fs.writeFileSync(file, '﻿' + lines.join('\r\n') + '\r\n');
}

function makeSetup(makensis, out, app, arch) {
  const setup = path.join(ROOT, 'dist', U.assetName(VERSION, arch, 'win32'));
  step('生成安装程序 ' + path.basename(setup));
  const list = path.join(out, 'uninstall-files.nsh');
  uninstallList(app, list);
  const defs = {
    VERSION,
    ARCH: arch,
    SRC_DIR: app,
    OUT_FILE: setup,
    ICON: path.join(ROOT, 'desktop', 'resources', 'icon.ico'),
    WELCOME_BMP: path.join(ROOT, 'scripts', 'win-installer-welcome.bmp'),
    APP_ID: U.BUNDLE_ID,
    UNINSTALLER: U.WIN_UNINSTALLER,
    UNINSTALL_LIST: list,
  };
  const sw = IS_WIN_HOST ? '/' : '-';
  const args = [sw + 'V2', sw + 'INPUTCHARSET', 'UTF8'];
  for (const [k, v] of Object.entries(defs)) args.push(sw + 'D' + k + '=' + v);
  args.push(path.join(ROOT, 'scripts', 'win-installer.nsi'));
  fs.rmSync(setup, { force: true });
  // macOS / Linux 上的 makensis 按当前 locale 转码：没设成 UTF-8 时一碰中文就报「Bad text encoding」
  const env = Object.assign({}, process.env);
  if (!IS_WIN_HOST && !/utf-?8/i.test(env.LC_ALL || env.LC_CTYPE || env.LANG || '')) {
    env.LC_ALL = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
  }
  execFileSync(makensis, args, { stdio: 'inherit', env });
  console.log('    大小 ' + mb(setup));
  return setup;
}

// ---------------------------------------------------------------- 开始
const makensis = wantSetup ? findMakensis() : null;
if (wantSetup && !makensis) {
  console.warn('\x1b[33m!\x1b[0m 没找到 NSIS 的 makensis，跳过安装程序（macOS：brew install makensis；Windows：choco install nsis；或设 MAKENSIS=路径）');
}
const made = [];
for (const arch of arches) {
  const { out, app } = await assemble(arch);
  if (wantZip) made.push(makeZip(out, arch));
  if (makensis) made.push(makeSetup(makensis, out, app, arch));
}
step('完成' + (made.length ? '：\n    ' + made.map((f) => path.relative(ROOT, f)).join('\n    ') : ''));
if (os.platform() !== 'win32') console.log('    （在 Windows 上第一次打开会被 SmartScreen 拦一下：「更多信息」→「仍要运行」）');
