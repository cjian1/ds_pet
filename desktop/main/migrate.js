'use strict';
/**
 * 首次启动：如果这台电脑装过 DSH 的 dsh-pet 插件（~/.dsh），把那边的 DeepSeek API Key、
 * 模型、桌宠设置和聊天记录导进来，省得重新填。只在 settings.json 还不存在时跑一次；
 * 没装过 DSH 就什么都不做。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { store, loadJsonc, readJson, memoryFile, uploadsDir, writeJsonAtomic } = require('./store');

const DSH_HOME = process.env.DSH_HOME || path.join(os.homedir(), '.dsh');

function readApiKey(dir) {
  try {
    for (const line of fs.readFileSync(path.join(dir, '.credentials.yaml'), 'utf8').split('\n')) {
      const t = line.trim();
      if (t.startsWith('DEEPSEEK_API_KEY:')) return t.slice('DEEPSEEK_API_KEY:'.length).trim().replace(/^['"]|['"]$/g, '');
    }
  } catch {
    /* 没有就算了 */
  }
  return '';
}

/**
 * DSH 的桌面 helper 在 Retina 屏上强制按 1x 渲染再整体放大，她看起来是配置值的 2 倍大。
 * 换算成本应用的「点」，观感保持一致。
 */
function dshScale() {
  const f = path.join(os.homedir(), 'Library', 'Application Support', 'dsh-pet-electron-helper', 'primary-scale.json');
  const v = Number((readJson(f) || {}).scaleFactor);
  return Number.isFinite(v) && v > 0 ? v : 1;
}

function migrate() {
  if (!fs.existsSync(DSH_HOME)) return [];
  const notes = [];
  const patch = { ai: {}, pet: {}, talk: {} };

  const key = readApiKey(DSH_HOME);
  if (key) {
    patch.ai.apiKey = key;
    notes.push('API Key');
  }

  const petDir = path.join(DSH_HOME, 'dsh-pet');
  const cfg = loadJsonc(path.join(petDir, 'main-config.jsonc')) || loadJsonc(path.join(petDir, 'main-config.json'));
  if (cfg) {
    const p = (Array.isArray(cfg.pets) && cfg.pets[0]) || {};
    if (p.name) patch.pet.name = String(p.name);
    if (Number(p.size) > 0) patch.pet.size = Math.round(Number(p.size) * dshScale());
    if (p.position && p.position.corner) patch.pet.corner = p.position.corner;
    if (typeof p.whisperEnabled === 'boolean') patch.talk.whisperEnabled = p.whisperEnabled;
    if (typeof p.balanceEnabled === 'boolean') patch.talk.balanceEnabled = p.balanceEnabled;
    if (typeof cfg.whisperImageEnabled === 'boolean') patch.talk.whisperImage = cfg.whisperImageEnabled;
    if (typeof cfg.chatImageEnabled === 'boolean') patch.talk.chatImage = cfg.chatImageEnabled;
    if (typeof cfg.confineToScreen === 'boolean') patch.pet.confineToScreen = cfg.confineToScreen;
    if (cfg.physics && Number(cfg.physics.throwPower) > 0) patch.pet.throwPower = Number(cfg.physics.throwPower);
    if (cfg.animationWeights && typeof cfg.animationWeights.move === 'number') patch.pet.roam = cfg.animationWeights.move > 0;
    notes.push('桌宠设置');
  }

  const mem = path.join(petDir, 'memory.json');
  if (fs.existsSync(mem) && !fs.existsSync(memoryFile())) {
    const data = readJson(mem);
    if (data && typeof data === 'object') {
      writeJsonAtomic(memoryFile(), data, 0o600);
      notes.push('聊天记录');
    }
  }
  const up = path.join(petDir, 'uploads');
  if (fs.existsSync(up)) {
    fs.mkdirSync(uploadsDir(), { recursive: true });
    for (const f of fs.readdirSync(up)) {
      const src = path.join(up, f);
      const dst = path.join(uploadsDir(), f);
      try {
        if (fs.statSync(src).isFile() && !fs.existsSync(dst)) fs.copyFileSync(src, dst);
      } catch {
        /* 单个文件失败不影响整体 */
      }
    }
  }

  store.update(patch);
  if (notes.length) console.log('[migrate] 从 DSH 导入：' + notes.join('、'));
  return notes;
}

module.exports = { migrate };
