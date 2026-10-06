/**
 * 桌宠窗口 —— 启动入口。
 *
 * 依赖链（index.html 顺序加载）：shared-core.js → constants.js → sprite.js → events.js → renderer.js（本文件）。
 * 本文件只做：配置加载 / 错误提示 / 启动装配 / 素材注入 / 订阅主进程消息。
 * 配置来自应用内服务 deskpet://app/api/config（= 包内默认 + 用户设置），加载失败每 5s 自动重试。
 */
'use strict';

function showError(message) {
  console.error('[pet] ' + message);
  window.__dshPetDebug.configOk = false;
  errorEl.textContent = message;
  errorEl.classList.add('visible');
}
function hideError() {
  errorEl.classList.remove('visible');
  errorEl.textContent = '';
}
function scheduleReboot() {
  if (bootTimer) return;
  bootTimer = setTimeout(() => {
    bootTimer = null;
    void boot();
  }, 5000);
}

async function loadConfig() {
  const res = await fetch(BASE + '/config', { cache: 'no-store' });
  if (!res.ok) throw new Error('config http ' + res.status);
  const merged = await res.json();
  return {
    pets: S.flattenConfigPets(merged),
    refreshSec: (merged && merged.main && merged.main.eventsRefreshSec) || {},
    physics: (merged && merged.main && merged.main.physics) || S.DEFAULT_PHYSICS,
    confineToScreen: (merged && merged.main && merged.main.confineToScreen) === true,
  };
}

async function boot() {
  try {
    const cfg = await loadConfig();
    config = cfg;
    hideError();
    const pets = cfg.pets.filter((p) => S.isDesktopVisible(p.display));
    const pet = pets[CONFIG.petIndex];
    if (!pet) {
      showError(tr('pet.noPet'));
      scheduleReboot();
      return;
    }
    for (const s of sprites) s.dispose();
    sprites = [new PetSprite(pet)];
    window.__dshPetDebug.configOk = true;
    window.__dshPetDebug.spriteCount = sprites.length;
    for (const s of sprites) s.playIdle();
    startLoops();
    // 页面还在加载时主进程就可能推来「挂起 / 主人不在」（锁着屏或藏着时重建了窗口）：
    // 那时还没有精灵可通知，这里补上，不然她会在没人看得见的地方一直解码视频
    for (const s of sprites) {
      s.setAway(petAway);
      if (petSuspended) s.suspend();
    }
    if (window.petBridge && window.petBridge.ready) window.petBridge.ready();
  } catch (e) {
    showError(tr('pet.notReady', { msg: e && e.message ? String(e.message) : String(e) }));
    scheduleReboot();
  }
}

// 气泡字体 + 抓取光标（与上游同一套素材）
function injectAssets() {
  const style = document.createElement('style');
  style.textContent =
    '@font-face{font-family:"ShangshouSoftCandy";src:url("' +
    BASE +
    '/font/' +
    encodeURIComponent('上首软糖体') +
    '.ttf") format("truetype");font-display:swap;font-weight:400}' +
    '.pet-hit{cursor:url("' +
    BASE +
    '/pic/cursor-grab.png") 16 16, grab}' +
    '.pet-hit.dragging{cursor:url("' +
    BASE +
    '/pic/cursor-grabbing.png") 16 16, grabbing}';
  document.head.appendChild(style);
}

if (window.petBridge) {
  // 窗口实际落位 → 校正精灵内部坐标（被菜单栏 / 屏幕边缘顶住时不再发散）
  window.petBridge.onActualBounds((b) => {
    window.__dshPetDebug.lastActualBounds = b;
    for (const s of sprites) s.onActualBounds(b);
  });
  // 显示器变化（改分辨率、插拔屏）：就地重挂视口与边界
  window.petBridge.onDisplays((geo) => {
    if (!applyDeskGeometry(geo)) return;
    for (const s of sprites) s.relayout();
  });
  window.petBridge.onMenuClosed(() => {
    for (const s of sprites) s.onMenuClosed();
  });
  window.petBridge.onAction((a) => {
    for (const s of sprites) s.onAction(a);
  });
  // 窗口被隐藏（⌃⌥P / 菜单里「隐藏」）或锁屏 → 挂起视频解码与定时任务；再叫回来时接上。
  //
  // 试过改走 Page Visibility（放开 backgroundThrottling + 监听 visibilitychange），想顺带覆盖
  // 「被全屏应用挡住 / 息屏」：实测（Electron 43 / macOS）窗口 hide() 之后 document.visibilityState
  // 仍是 visible，2s 轨迹全是 v；放开节流后也只在一次运行里翻转过、随后两次都不翻 —— 不可靠。
  // 于是回到显式通道：锁屏由主进程 powerMonitor 通知，隐藏由窗口 hide/show 通知，都是确定信号。
  window.petBridge.onSuspend((suspended) => {
    petSuspended = suspended;
    for (const s of sprites) (suspended ? s.suspend() : s.resume());
  });
  // 主人离开电脑 / 回来（系统空闲时间，主进程判定）：离开时她播完这段就歇着，回来接着播
  window.petBridge.onAway((away) => {
    petAway = away;
    for (const s of sprites) s.setAway(away);
  });
  // 改名字：不重建窗口，就地换掉视频/命中区的 title
  window.petBridge.onName((name) => {
    for (const s of sprites) s.setName(name);
  });
}

// 窗口内容区尺寸异常时按当前位置重新规整（拖拽 / 飞行 / 漫游中不动，位置由输入或物理驱动）。
// 位置多半没变，但窗口被系统改过：清掉去重键，强制重发一次让主进程复位
window.addEventListener('resize', () => {
  for (const s of sprites) {
    if (s.dragState.active || s.throwRef !== null || s.moveRef !== null) continue;
    s._boundsKey = null;
    s.position();
  }
});

injectAssets();
void boot();
