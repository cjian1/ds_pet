'use strict';
/**
 * 生成图标（用 Electron 离屏画布渲染）：
 *   desktop/resources/icon.png          1024×1024 应用图标（macOS 圆角方块 + 抠好白底的她）
 *   desktop/resources/icon.icns         由上面那张经 iconutil 生成
 *   desktop/resources/trayTemplate.png  菜单栏模板图标（单色小鲸鱼，18pt，@1x/@2x）
 *
 * 用法：runtime/electron/Electron.app/Contents/MacOS/Electron scripts/make-icons.js
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

async function appIcon(src) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const art = cutout(img);
  const S = 1024;
  const c = document.createElement('canvas');
  c.width = S; c.height = S;
  const ctx = c.getContext('2d');
  const cx = S / 2, cy = S / 2, R = 412;

  // 底板投影
  ctx.save();
  superellipse(ctx, cx, cy + 6, R, 5);
  ctx.shadowColor = 'rgba(20, 40, 100, 0.35)';
  ctx.shadowBlur = 36;
  ctx.shadowOffsetY = 14;
  ctx.fillStyle = '#5d8cf0';
  ctx.fill();
  ctx.restore();

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
  const glow = ctx.createRadialGradient(cx, cy - 120, 40, cx, cy - 120, 520);
  glow.addColorStop(0, 'rgba(255,255,255,0.75)');
  glow.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, S, S);
  // 底部海浪
  for (const [y, a] of [[cy + 250, 0.22], [cy + 300, 0.3]]) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    for (let xx = 0; xx <= S; xx += 8) ctx.lineTo(xx, y + Math.sin(xx / 70) * 14);
    ctx.lineTo(S, S); ctx.lineTo(0, S); ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,' + a + ')';
    ctx.fill();
  }
  // 小泡泡
  for (const [bx, by, br] of [[cx - 300, cy - 230, 22], [cx - 255, cy - 300, 13], [cx + 290, cy - 150, 17], [cx + 318, cy - 220, 10]]) {
    ctx.beginPath();
    ctx.arc(bx, by, br, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fill();
  }
  // 她（带一点投影，让人物从底板上浮起来）
  const ah = 760, aw = (art.width / art.height) * ah;
  ctx.shadowColor = 'rgba(20, 40, 110, 0.35)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 10;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(art, cx - aw / 2, cy - ah / 2 + 34, aw, ah);
  ctx.restore();

  // 高光描边
  ctx.save();
  superellipse(ctx, cx, cy, R - 1.5, 5);
  ctx.lineWidth = 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.45)';
  ctx.stroke();
  ctx.restore();
  return c.toDataURL('image/png');
}

/** 菜单栏小鲸鱼：黑色 + 透明（模板图，系统按明暗模式自动反色） */
function trayIcon(px) {
  const c = document.createElement('canvas');
  c.width = px; c.height = px;
  const ctx = c.getContext('2d');
  const k = px / 36;
  ctx.scale(k, k);
  ctx.fillStyle = '#000';
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
  ctx.strokeStyle = '#000';
  ctx.beginPath();
  ctx.moveTo(11.6, 8.8); ctx.quadraticCurveTo(11.2, 5.8, 8.4, 4.4);
  ctx.moveTo(13.4, 8.4); ctx.lineTo(13.4, 3.2);
  ctx.moveTo(15.2, 8.8); ctx.quadraticCurveTo(15.6, 5.8, 18.4, 4.4);
  ctx.stroke();
  // 眼睛（挖空）
  ctx.globalCompositeOperation = 'destination-out';
  ctx.beginPath();
  ctx.arc(9.8, 18.6, 1.9, 0, Math.PI * 2);
  ctx.fill();
  return c.toDataURL('image/png');
}
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

app.whenReady().then(async () => {
  try {
    fs.mkdirSync(RES, { recursive: true });
    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(PAGE));
    const src = 'data:image/png;base64,' + fs.readFileSync(ART).toString('base64');
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
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  }
  app.quit();
});
