'use strict';
/**
 * 生成图标（用 Electron 离屏画布渲染）：
 *   desktop/resources/icon.png          1024×1024 应用图标（macOS 圆角方块 + 抠好白底的她）
 *   desktop/resources/icon.icns         由上面那张经 iconutil 生成
 *   desktop/resources/trayTemplate.png  菜单栏模板图标（单色小鲸鱼，18pt，@1x/@2x）
 *   desktop/resources/icon.ico          Windows 应用图标（exe / 安装程序 / 窗口；边距比 macOS 的小，16–256px 各档）
 *   desktop/resources/tray.ico          Windows 通知区域图标（彩色小鲸鱼，深浅色任务栏上都看得清，16–64px 各档）
 *   scripts/win-installer-welcome.bmp   Windows 安装程序欢迎页 / 完成页左边的竖图（164×314）
 *
 * 用法：npm run icons（全部重新生成）；只要 Windows 那几个：npx electron scripts/make-icons.js --win
 * （macOS 的 icns 要用 sips / iconutil，只能在 macOS 上生成）
 */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const RES = path.join(ROOT, 'desktop', 'resources');
const ART = path.join(ROOT, 'desktop', 'assets', 'memes', '可爱.png');

const PAGE = String.raw`<!doctype html><html><body><script>
function superellipse(ctx, cx, cy, r, n) {
  ctx.beginPath();
  for (let i = 0; i <= 360; i++) {
    const t = (i / 360) * Math.PI * 2;
    const c = Math.cos(t), s = Math.sin(t);
    const x = cx + r * Math.sign(c) * Math.pow(Math.abs(c), 2 / n);
    const y = cy + r * Math.sign(s) * Math.pow(Math.abs(s), 2 / n);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.closePath();
}

/** 抠白底：从四周边缘往里漫水填充「接近白色」的像素 → 透明；边缘按亮度羽化 */
function cutout(img) {
  const w = img.width, h = img.height;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0);
  const d = x.getImageData(0, 0, w, h);
  const p = d.data;
  const bright = (i) => Math.min(p[i], p[i + 1], p[i + 2]);
  const bg = new Uint8Array(w * h);
  const stack = [];
  const push = (px, py) => {
    if (px < 0 || py < 0 || px >= w || py >= h) return;
    const k = py * w + px;
    if (bg[k] || bright(k * 4) < 228) return;
    bg[k] = 1;
    stack.push(k);
  };
  for (let i = 0; i < w; i++) { push(i, 0); push(i, h - 1); }
  for (let j = 0; j < h; j++) { push(0, j); push(w - 1, j); }
  while (stack.length) {
    const k = stack.pop();
    const px = k % w, py = (k / w) | 0;
    push(px + 1, py); push(px - 1, py); push(px, py + 1); push(px, py - 1);
  }
  for (let k = 0; k < w * h; k++) {
    if (bg[k]) { p[k * 4 + 3] = 0; continue; }
    // 紧贴背景的一圈：越白越透明（去掉白边光晕）
    const px = k % w, py = (k / w) | 0;
    let edge = false;
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const qx = px + dx, qy = py + dy;
      if (qx >= 0 && qy >= 0 && qx < w && qy < h && bg[qy * w + qx]) { edge = true; break; }
    }
    if (edge) {
      const b = bright(k * 4);
      p[k * 4 + 3] = Math.max(0, Math.min(255, Math.round((255 - b) * 3.2)));
    }
  }
  x.putImageData(d, 0, 0);
  return c;
}

/** R = 底板半径（1024 画布里；macOS 412 留出系统要求的边距和投影，Windows 488 几乎铺满）；shadow = 底板投影 */
async function appIconCanvas(src, { R = 412, shadow = true } = {}) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const art = cutout(img);
  const S = 1024;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  const cx = S / 2, cy = S / 2;
  const k = R / 412; // 底板上的装饰按同样比例放大

  // 底板投影
  if (shadow) {
    ctx.save();
    superellipse(ctx, cx, cy + 6, R, 5);
    ctx.shadowColor = 'rgba(20, 40, 100, 0.35)';
    ctx.shadowBlur = 36;
    ctx.shadowOffsetY = 14;
    ctx.fillStyle = '#5d8cf0';
    ctx.fill();
    ctx.restore();
  }

  // 底板：天空蓝 → 海洋蓝
  ctx.save();
  superellipse(ctx, cx, cy, R, 5);
  ctx.clip();
  const g = ctx.createLinearGradient(0, cy - R, 0, cy + R);
  g.addColorStop(0, '#d9ecff');
  g.addColorStop(0.55, '#9cc3ff');
  g.addColorStop(1, '#5b86ee');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  // 柔光
  const glow = ctx.createRadialGradient(cx, cy - 120 * k, 40 * k, cx, cy - 120 * k, 520 * k);
  glow.addColorStop(0, 'rgba(255,255,255,0.75)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, S, S);
  // 底部海浪
  for (const [y, a] of [[cy + 250 * k, 0.22], [cy + 300 * k, 0.3]]) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let xx = 0; xx <= S; xx += 8) ctx.lineTo(xx, y + Math.sin(xx / (70 * k)) * 14 * k);
    ctx.lineTo(S, S); ctx.lineTo(0, S); ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,' + a + ')';
    ctx.fill();
  }
  // 小泡泡
  for (const [bx, by, br] of [[-300, -230, 22], [-255, -300, 13], [290, -150, 17], [318, -220, 10]]) {
    ctx.beginPath();
    ctx.arc(cx + bx * k, cy + by * k, br * k, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fill();
  }
  // 她（带一点投影，让人物从底板上浮起来）
  const ah = 760 * k, aw = (art.width / art.height) * ah;
  ctx.shadowColor = 'rgba(20, 40, 110, 0.35)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 10;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(art, cx - aw / 2, cy - ah / 2 + 34 * k, aw, ah);
  ctx.restore();

  // 高光描边
  ctx.save();
  superellipse(ctx, cx, cy, R - 1.5, 5);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.stroke();
  ctx.restore();
  return c;
}

async function appIcon(src) {
  return (await appIconCanvas(src)).toDataURL('image/png');
}

/**
 * 小鲸鱼（36×36 的网格里画，按 px 缩放）。默认是 macOS 菜单栏模板图：黑色 + 透明、眼睛挖空（系统按明暗模式自动反色）；
 * Windows 通知区域用彩色版：body 可以是 (ctx) => 渐变，eye 给颜色就画实心眼睛，dy 把图往下挪（整体居中）。
 */
function drawWhale(px, { body = '#000', spout = '#000', eye = null, dy = 0 } = {}) {
  const c = document.createElement('canvas');
  c.width = px; c.height = px;
  const ctx = c.getContext('2d');
  const k = px / 36;
  ctx.scale(k, k);
  ctx.translate(0, dy);
  ctx.fillStyle = typeof body === 'function' ? body(ctx) : body;
  // 身体（圆润的大头鲸）+ 上翘的双叉尾巴
  ctx.beginPath();
  ctx.moveTo(3.5, 21);
  ctx.bezierCurveTo(3.5, 13.5, 10, 10.5, 16.5, 11);
  ctx.bezierCurveTo(22, 11.5, 25, 14.5, 26.5, 18);
  ctx.bezierCurveTo(27.6, 16.4, 28.4, 14.6, 28.4, 12.6);
  ctx.bezierCurveTo(26.8, 11.8, 25.2, 10.2, 24.8, 7.8);
  ctx.bezierCurveTo(27.4, 8.2, 29.2, 9.6, 30.2, 11.2);
  ctx.bezierCurveTo(31.2, 9.4, 32.8, 8, 35.4, 7.6);
  ctx.bezierCurveTo(35, 10.4, 33.2, 12.4, 31.2, 13.2);
  ctx.bezierCurveTo(31.4, 17.2, 30.2, 21, 28, 23.8);
  ctx.bezierCurveTo(25, 27.6, 20.5, 29.2, 14.5, 29.2);
  ctx.bezierCurveTo(7.5, 29.2, 3.5, 26.2, 3.5, 21);
  ctx.closePath();
  ctx.fill();
  // 水柱
  ctx.lineCap = 'round';
  ctx.lineWidth = 2.3;
  ctx.strokeStyle = spout;
  ctx.beginPath();
  ctx.moveTo(11.6, 8.8); ctx.quadraticCurveTo(11.2, 5.8, 8.4, 4.4);
  ctx.moveTo(13.4, 8.4); ctx.lineTo(13.4, 3.2);
  ctx.moveTo(15.2, 8.8); ctx.quadraticCurveTo(15.6, 5.8, 18.4, 4.4);
  ctx.stroke();
  // 眼睛（模板图挖空；彩色版画实心）
  if (eye) ctx.fillStyle = eye;
  else ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(9.8, 18.6, 1.9, 0, Math.PI * 2);
  ctx.fill();
  return c;
}

function trayIcon(px) {
  return drawWhale(px).toDataURL('image/png');
}

// ---------------------------------------------------------------- Windows
/** 逐级对半缩小再缩到目标尺寸（一步从 1024 缩到 16 会糊、有锯齿） */
function downscale(src, size) {
  let cur = src;
  const step = (w) => {
    const n = document.createElement('canvas');
    n.width = w; n.height = w;
    const x = n.getContext('2d');
    x.imageSmoothingQuality = 'high';
    x.drawImage(cur, 0, 0, w, w);
    cur = n;
  };
  while (cur.width / 2 >= size) step(cur.width / 2);
  if (cur.width !== size) step(size);
  return cur;
}

const rgba = (c) => Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data);

/** 通知区域的彩色小鲸鱼：蓝色在深色和浅色任务栏上都看得清，白眼睛 */
const WIN_TRAY = {
  body: (ctx) => {
    const g = ctx.createLinearGradient(0, 7, 0, 30);
    g.addColorStop(0, '#74a0ff');
    g.addColorStop(1, '#3a63e6');
    return g;
  },
  spout: '#5f8dff',
  eye: '#ffffff',
  dy: 1.6,
};

/** 安装程序欢迎页左边的竖图（164×314）：和应用图标一样的海天底色 + 她 */
async function installerArt(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const art = cutout(img);
  const W = 164, H = 314;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, H);
  g.addColorStop(0, '#d9ecff');
  g.addColorStop(0.55, '#9cc3ff');
  g.addColorStop(1, '#5b86ee');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, 110, 10, W / 2, 110, 170);
  glow.addColorStop(0, 'rgba(255,255,255,0.7)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  for (const [y, a] of [[H - 64, 0.22], [H - 44, 0.3]]) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let xx = 0; xx <= W; xx += 4) ctx.lineTo(xx, y + Math.sin(xx / 18) * 4);
    ctx.lineTo(W, H); ctx.lineTo(0, H); ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,' + a + ')';
    ctx.fill();
  }
  for (const [bx, by, br] of [[26, 46, 7], [40, 26, 4], [136, 70, 6], [146, 48, 3.5]]) {
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fill();
  }
  const ah = 214, aw = (art.width / art.height) * ah;
  ctx.shadowColor = 'rgba(20, 40, 110, 0.35)';
  ctx.shadowBlur = 10;
  ctx.shadowOffsetY = 4;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(art, (W - aw) / 2, H - ah - 18, aw, ah);
  return c;
}

window.__makeWin = async (src) => {
  const big = await appIconCanvas(src, { R: 488, shadow: false });
  // 小尺寸用 32 位位图（最稳），64 以上用 PNG（文件小）
  const icon = [16, 20, 24, 32, 40, 48, 64, 96, 128, 256].map((s) => {
    const c = downscale(big, s);
    return s >= 64 ? { size: s, png: c.toDataURL('image/png') } : { size: s, rgba: rgba(c) };
  });
  const tray = [16, 20, 24, 32, 40, 48, 64].map((s) => ({ size: s, rgba: rgba(drawWhale(s, WIN_TRAY)) }));
  const welcome = await installerArt(src);
  return {
    icon,
    tray,
    welcome: { width: welcome.width, height: welcome.height, rgba: rgba(welcome) },
    previews: { icon: big.toDataURL('image/png'), tray: drawWhale(256, WIN_TRAY).toDataURL('image/png'), welcome: welcome.toDataURL('image/png') },
  };
};

window.__make = async (src) => ({
  icon: await appIcon(src),
  tray1: trayIcon(18),
  tray2: trayIcon(36),
  trayPreview: trayIcon(256),
});
</script></body></html>`;

function writeDataUrl(file, dataUrl) {
  fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));
}

/** RGBA（自上而下）→ .ico 里的一档 32 位位图：BITMAPINFOHEADER + 自下而上的 BGRA + 1 位透明掩码 */
function dibEntry(size, px) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);
  header.writeInt32LE(size, 4);
  header.writeInt32LE(size * 2, 8); // 高度算上掩码，所以是两倍
  header.writeUInt16LE(1, 12);
  header.writeUInt16LE(32, 14);
  header.writeUInt32LE(size * size * 4, 20);
  const color = Buffer.alloc(size * size * 4);
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size);
  for (let y = 0; y < size; y++) {
    const row = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const s = (y * size + x) * 4;
      const d = (row * size + x) * 4;
      color[d] = px[s + 2];
      color[d + 1] = px[s + 1];
      color[d + 2] = px[s];
      color[d + 3] = px[s + 3];
      if (px[s + 3] === 0) mask[row * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([header, color, mask]);
}

/** 多档图标打成 .ico：entries = [{size, rgba} | {size, png}] */
function writeIco(file, entries) {
  const images = entries.map((e) => (e.png ? Buffer.from(e.png.split(',')[1], 'base64') : dibEntry(e.size, e.rgba)));
  const head = Buffer.alloc(6 + 16 * entries.length);
  head.writeUInt16LE(0, 0);
  head.writeUInt16LE(1, 2);
  head.writeUInt16LE(entries.length, 4);
  let offset = head.length;
  entries.forEach((e, i) => {
    const o = 6 + i * 16;
    head.writeUInt8(e.size >= 256 ? 0 : e.size, o);
    head.writeUInt8(e.size >= 256 ? 0 : e.size, o + 1);
    head.writeUInt16LE(1, o + 4);
    head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(images[i].length, o + 8);
    head.writeUInt32LE(offset, o + 12);
    offset += images[i].length;
  });
  fs.writeFileSync(file, Buffer.concat([head, ...images]));
}

/** RGBA → 24 位 BMP（NSIS 安装界面只认 BMP） */
function writeBmp(file, { width, height, rgba: px }) {
  const rowBytes = Math.ceil((width * 3) / 4) * 4;
  const data = Buffer.alloc(rowBytes * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4;
      const d = (height - 1 - y) * rowBytes + x * 3;
      data[d] = px[s + 2];
      data[d + 1] = px[s + 1];
      data[d + 2] = px[s];
    }
  }
  const head = Buffer.alloc(54);
  head.write('BM', 0, 'latin1');
  head.writeUInt32LE(54 + data.length, 2);
  head.writeUInt32LE(54, 10);
  head.writeUInt32LE(40, 14);
  head.writeInt32LE(width, 18);
  head.writeInt32LE(height, 22);
  head.writeUInt16LE(1, 26);
  head.writeUInt16LE(24, 28);
  head.writeUInt32LE(data.length, 34);
  head.writeInt32LE(2835, 38);
  head.writeInt32LE(2835, 42);
  fs.writeFileSync(file, Buffer.concat([head, data]));
}

/** --win：只重新生成 Windows 用的那几个（不动已经提交的 macOS 图标） */
const ONLY_WIN = process.argv.includes('--win');

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(RES, { recursive: true });
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
    const src = 'data:image/png;base64,' + fs.readFileSync(ART).toString('base64');

    const w = await win.webContents.executeJavaScript('window.__makeWin(' + JSON.stringify(src) + ')');
    writeIco(path.join(RES, 'icon.ico'), w.icon);
    writeIco(path.join(RES, 'tray.ico'), w.tray);
    writeBmp(path.join(ROOT, 'scripts', 'win-installer-welcome.bmp'), w.welcome);
    for (const [name, url] of Object.entries(w.previews)) writeDataUrl(path.join(os.tmpdir(), 'whale-win-' + name + '.png'), url);
    console.log('windows icons written; previews: ' + path.join(os.tmpdir(), 'whale-win-*.png'));
    if (!ONLY_WIN) {
      const out = await win.webContents.executeJavaScript('window.__make(' + JSON.stringify(src) + ')');
      writeDataUrl(path.join(RES, 'icon.png'), out.icon);
      writeDataUrl(path.join(RES, 'trayTemplate.png'), out.tray1);
      writeDataUrl(path.join(RES, 'trayTemplate@2x.png'), out.tray2);
      writeDataUrl(path.join(os.tmpdir(), 'whale-tray-preview.png'), out.trayPreview);

      // .icns：各尺寸用 sips 从 1024 缩出来，再交给 iconutil
      const set = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-')) + '/icon.iconset';
      fs.mkdirSync(set);
      for (const s of [16, 32, 128, 256, 512]) {
        execFileSync('sips', ['-z', String(s), String(s), path.join(RES, 'icon.png'), '--out', path.join(set, `icon_${s}x${s}.png`)], { stdio: 'ignore' });
        execFileSync('sips', ['-z', String(s * 2), String(s * 2), path.join(RES, 'icon.png'), '--out', path.join(set, `icon_${s}x${s}@2x.png`)], { stdio: 'ignore' });
      }
      execFileSync('iconutil', ['-c', 'icns', set, '-o', path.join(RES, 'icon.icns')]);
      console.log('icons written to', RES);
      console.log('tray preview:', path.join(os.tmpdir(), 'whale-tray-preview.png'));
    }
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
  app.quit();
});
