'use strict';
/**
 * 「这次设置变化要不要重建桌宠窗口」的纯判定。
 *
 * 重建窗口 = 新开一个 BrowserWindow + 重新加载页面（i18n / shared-core / sprite / 所有视频重来），
 * 是设置生效里最贵的一步；而渲染端只读配置里很小一部分字段（见 shared-core 的 flattenConfigPets）：
 * 宠物条目的 name / size / position / whisperEnabled / balanceEnabled，主条目的
 * animations / animationWeights / eventsRefreshSec / physics / confineToScreen。
 *
 * 判定写成**黑名单**：只有列在 INERT 里的字段改了才不重建，其余一律重建。这样将来往上加的字段
 * 默认走「重建」（正确但慢），不会出现「设置改了不生效」这种更难查的问题。
 *
 * 不进黑名单的两类字段各有轻量通道：
 *   · 名字 —— petWindow.setName() 只推一次 title；
 *   · 行为类（走动 / 活跃度 / 甩力 / 初始角落 / 碎碎念开关与周期 / 报余额）—— 渲染端都是用到的
 *     那一刻才读，主进程推一份 live-config，渲染端就地套用（见 sprite.js 的 applyLiveConfig）。
 * 真正必须重建的只剩：她的大小、界面语言、以及「能不能聊天/报余额」翻转（aiFlip）。
 */

/** 渲染端不读，或有轻量通道的字段：改了不必重建桌宠窗口 */
const INERT = {
  pet: [
    'name', // 只用于视频 / 命中区的 title，走 setName
    'corner', // 初始角落：position() / goHome() 用时才读，走 live-config
    'roam', // animationWeights.move
    'liveliness', // animationWeights.idle / turn
    'throwPower', // physics
    'confineToScreen',
  ],
  talk: [
    'whisperImage', // 只在主进程拼提示词时用
    'chatImage',
    'whisperEnabled', // pet.whisperEnabled
    'whisperIntervalSec', // pet.eventsRefreshSec.whisper
    'balanceEnabled', // pet.balanceEnabled
  ],
};

function sameValue(a, b) {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/**
 * @param {object} next 新设置（store.get()）
 * @param {object} prev 旧设置
 * @param {{langChanged?: boolean, aiFlip?: boolean}} flags 语言换了 / 能不能聊天或报余额翻了（都影响渲染端）
 */
function needsPetWindowReload(next, prev, { langChanged = false, aiFlip = false } = {}) {
  if (langChanged || aiFlip) return true;
  for (const group of ['pet', 'talk']) {
    const before = prev[group] || {};
    for (const [key, value] of Object.entries(next[group] || {})) {
      if (INERT[group].includes(key)) continue;
      if (!sameValue(value, before[key])) return true;
    }
  }
  return false;
}

module.exports = { needsPetWindowReload, INERT };
