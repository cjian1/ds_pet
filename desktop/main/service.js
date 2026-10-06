'use strict';
/**
 * deskpet:// —— 应用内的「本地服务」。
 *
 * 旧方案里这是一个跑在 127.0.0.1 上的 Python HTTP 服务；现在换成 Electron 自定义协议：
 * 不占端口、不会被别的网页/进程访问到（聊天接口用的是你的 API Key），也不需要单独的进程去守护。
 *
 *   deskpet://app/pet/…        桌宠窗口页面（renderer）
 *   deskpet://app/chat/…       聊天面板
 *   deskpet://app/settings/…   设置窗口
 *   deskpet://app/api/…        配置 / 动画素材 / 表情包 / 字体 / 余额 / 碎碎念（契约与 dsh-pet 上游 /dsh-pet-7340 一致）
 */
const { protocol, powerMonitor } = require('electron');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { Readable } = require('node:stream');
const { store, ASSETS, APP_ROOT, petConfig, dataDir, uploadsDir } = require('./store');
const llm = require('./llm');

const SCHEME = 'deskpet';
const ORIGIN = SCHEME + '://app';
const API = ORIGIN + '/api';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp4': 'video/mp4',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff2': 'font/woff2',
};

/** 必须在 app ready 之前调用 */
function registerScheme() {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true, codeCache: true },
    },
  ]);
}

/** root 下的安全路径（防 ../ 越界）；不存在返回 null */
function safeFile(root, rel) {
  if (!rel) return null;
  const target = path.resolve(root, rel);
  const r = path.resolve(root);
  if (target !== r && !target.startsWith(r + path.sep)) return null;
  try {
    return fs.statSync(target).isFile() ? target : null;
  } catch {
    return null;
  }
}

function firstFile(roots, names) {
  for (const root of roots) {
    for (const n of names) {
      const f = safeFile(root, n);
      if (f) return f;
    }
  }
  return null;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

/** 文件应答（支持 Range：视频循环播放/拖进度需要） */
async function fileResponse(request, file, cache = 'max-age=3600') {
  const ctype = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  const { size } = await fsp.stat(file);
  const headers = { 'content-type': ctype, 'accept-ranges': 'bytes', 'cache-control': cache };
  const range = request.headers.get('range');
  const m = range && /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (m && (m[1] !== '' || m[2] !== '')) {
    let start;
    let end;
    if (m[1] === '') {
      start = Math.max(0, size - Number(m[2]));
      end = size - 1;
    } else {
      start = Number(m[1]);
      end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
    }
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'content-range': 'bytes */' + size } });
    }
    return new Response(Readable.toWeb(fs.createReadStream(file, { start, end })), {
      status: 206,
      headers: Object.assign(headers, {
        'content-range': 'bytes ' + start + '-' + end + '/' + size,
        'content-length': String(end - start + 1),
      }),
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(file)), {
    status: 200,
    headers: Object.assign(headers, { 'content-length': String(size) }),
  });
}

function mainPet(cfg) {
  return ((cfg.main && cfg.main.pets) || [])[0] || { id: 'main', name: store.petName() };
}

async function handleApi(request, rest, url) {
  // ---- 配置 ----
  if (rest === 'config') return json(petConfig());

  // ---- 动画素材：用户覆盖目录（~/Library/Application Support/ds_pet/animations）→ 包内 ----
  if (rest.startsWith('thumb/')) {
    const parts = rest.slice('thumb/'.length).split('/');
    const name = parts.length > 1 ? parts.slice(1).join('/') : parts[0];
    const file = firstFile([path.join(dataDir(), 'animations'), path.join(ASSETS, 'webm')], [name]);
    return file ? fileResponse(request, file, 'max-age=86400') : json({ error: 'asset not found: ' + name }, 404);
  }

  // ---- 静态素材：/pic/<x>、/pic/memes/<x>（上游 memeImageUrl）、/font/<x>、/uploads/<x> ----
  const kinds = {
    pic: [path.join(ASSETS, 'pic'), ASSETS, path.join(ASSETS, 'memes'), uploadsDir()],
    font: [path.join(ASSETS, 'fonts')],
    memes: [path.join(ASSETS, 'memes')],
    uploads: [uploadsDir()],
  };
  for (const [kind, roots] of Object.entries(kinds)) {
    if (!rest.startsWith(kind + '/')) continue;
    const name = rest.slice(kind.length + 1);
    const bare = name.startsWith('memes/') ? name.slice('memes/'.length) : name;
    const file = firstFile(roots, bare !== name ? [name, bare] : [name]);
    return file ? fileResponse(request, file, 'max-age=86400') : json({ error: kind + ' not found: ' + name }, 404);
  }

  // ---- 余额 ----
  if (rest === 'balance') return json(await llm.balance());
  if (rest === 'balance/trigger') return json({ count: 0 });

  // ---- 碎碎念：auto=1 是周期触发——主人不在电脑前（空闲 10 分钟以上）就不浪费额度 ----
  if (rest === 'whisper' || rest === 'whisper/trigger') {
    const auto = url.searchParams.get('auto') === '1';
    if (auto && powerMonitor.getSystemIdleTime() > 600) return json({ ok: false, reason: 'idle', message: 'away' });
    const cfg = petConfig();
    try {
      const state = await llm.whisper(cfg.main, mainPet(cfg), { force: rest.endsWith('trigger') || auto });
      return json(state);
    } catch (e) {
      return json({ ok: false, reason: e.reason === 'provider-missing' ? 'provider-missing' : 'generate-error', message: e.message });
    }
  }

  return json({ error: 'not found: ' + rest }, 404);
}

const PAGE_ROOTS = {
  pet: path.join(APP_ROOT, 'pet'),
  chat: path.join(APP_ROOT, 'chat'),
  settings: path.join(APP_ROOT, 'settings'),
  ui: path.join(APP_ROOT, 'ui'),
  resources: path.join(APP_ROOT, 'resources'),
  i18n: path.join(APP_ROOT, 'i18n'),
};

function installHandler() {
  protocol.handle(SCHEME, async (request) => {
    let url;
    try {
      url = new URL(request.url);
    } catch {
      return json({ error: 'bad url' }, 400);
    }
    const p = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    try {
      if (p.startsWith('api/')) return await handleApi(request, p.slice(4), url);
      const [section, ...restParts] = p.split('/');
      const root = PAGE_ROOTS[section];
      const file = root && safeFile(root, restParts.join('/') || 'index.html');
      if (!file) return json({ error: 'not found: ' + p }, 404);
      return await fileResponse(request, file, 'no-cache');
    } catch (e) {
      console.error('[deskpet] handler error', p, e);
      return json({ error: String((e && e.message) || e) }, 500);
    }
  });
}

module.exports = {
  registerScheme,
  installHandler,
  SCHEME,
  ORIGIN,
  API,
  mainPet,
  /** 只给单测用（test/service.test.js） */
  _internal: { safeFile, fileResponse, handleApi },
};
