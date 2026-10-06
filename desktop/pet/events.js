/**
 * 事件联动：定时碎碎念 / 定时报余额。
 *
 * 展示与 tick 回调经 PetSprite.prototype 挂载；startLoops 是全部定时任务的组装入口（boot 后调用）。
 * DSH 专属的工作状态联动 / 斜杠命令广播在独立版里没有数据源，已去掉（不再每秒轮询）。
 */
'use strict';

// ---- 余额事件（每只宠物按 balanceEnabled 门控；档位与气泡内容来自 shared） ----
PetSprite.prototype.onBalanceTick = function onBalanceTick(state, tick) {
  if (!this.pet.balanceEnabled) return; // 未启用余额功能 -> 该宠物对余额事件完全免疫（与浏览器一致）
  if (tick === 0 || tick === this.prevTick) return;
  this.prevTick = tick;
  this.showBalanceNow(state);
};

// 余额不可用（服务商未登记 / 缺凭证 / 抓取失败）：只弹**文字说明**气泡，不播档位动画
// （非 ok 没有百分比语义，档位动画无从映射）。显隐/定时与成功路径同一套（10s 自动消失）；
// 不 stopMove——本次没有动画要抢前台，宠物没必要停下漫游。
PetSprite.prototype.showBalanceNotice = function showBalanceNotice(state, force) {
  if (!this.pet.balanceEnabled && !force) return; // 菜单里点「查看余额」是显式请求，不受开关限制
  if (!state || state.ok) return;
  this.bubbleOn = true;
  this.balanceWrap = true; // 文字说明可能多行：renderBubble 据此套用换行变体（默认 nowrap 会顶出宠物宽度）
  this.balanceView = balanceView(state);
  this.renderBubble();
  if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
  this.bubbleTimer = window.setTimeout(() => {
    this.bubbleOn = false;
    this.renderBubble();
  }, BUBBLE_DURATION_MS);
};

// ---- 碎碎念：按设置的间隔（±20% 随机，别像闹钟一样准点）说一句 ----
// 正在被拖 / 菜单开着 / 气泡还没收：这一轮跳过；主人离开电脑（空闲 10 分钟）时主进程直接不生成，省额度。
PetSprite.prototype.startWhisperLoop = function startWhisperLoop() {
  if (!this.pet.whisperEnabled || this.whisperLoopTimer !== null) return;
  const baseMs = Math.max(60, this.pet.eventsRefreshSec?.whisper ?? 900) * 1000;
  const schedule = () => {
    this.whisperLoopTimer = window.setTimeout(() => void tick(), baseMs * (0.8 + Math.random() * 0.4));
  };
  const tick = async () => {
    try {
      // suspended = 窗口已隐藏（见 sprite.js）：不生成、也不弹（恢复时 resume() 会重排循环）；
      // away = 主人离开电脑：没人听，别花额度，也别把歇着的她叫起来
      if (!this.suspended && !this.away && !this.dragState.active && !this.menuOpen && !this.whisperOn && !document.hidden) {
        const state = await S.fetchWhisperState(WHISPER_URL + '?auto=1&pet=' + encodeURIComponent(this.pet.id));
        if (state.ok && !this.suspended) this.showWhisper(state.text, state.image);
      }
    } catch (e) {
      console.warn('[pet] 碎碎念失败', e);
    }
    schedule();
  };
  schedule();
};

// 碎碎念展示（本宠物）：随机抽 events.whisper 动画 + 弹文本气泡（10s 消失，与余额同一语义）
// image：host 随机抽定的配图名称（未开配图/池为空则空串，与浏览器端同一契约）
PetSprite.prototype.showWhisper = function showWhisper(text, image) {
  const pool = this.animations.events?.whisper;
  if (!pool || pool.length === 0) {
    console.error('[dsh-pet] 配置缺少 animations.events.whisper，无法播放碎碎念动画');
    return;
  }
  // 整池随机抽 1 槽（避开当前正播动画，避免连续重复）；槽位若为数组候选再档内随机（与浏览器一致）
  const name = S.pickSlot(S.pick(pool, this.anim), this.anim);
  console.log(
    '[dsh-pet] ' +
      new Date().toTimeString().slice(0, 8) +
      ' whisper pet=' +
      this.pet.id +
      ' -> [' +
      name +
      '] 「' +
      text +
      '」' +
      (image ? ' [' + image + ']' : ''),
  );
  this.stopMove();
  this.whisperOn = true;
  this.whisperView = S.whisperBubbleView({ ok: true, text, ts: 0 });
  this.whisperImage = typeof image === 'string' ? image : '';
  this.renderBubble();
  // 气泡 10s 定时消失（与动画解耦，与余额同一语义；重复触发先清旧定时器）
  if (this.whisperTimer !== null) window.clearTimeout(this.whisperTimer);
  this.whisperTimer = window.setTimeout(() => {
    this.whisperOn = false;
    this.renderBubble();
  }, BUBBLE_DURATION_MS);
  this.playOnce(name);
};

// 余额展示（档位动画 + 气泡）：周期轮询与菜单点播共用同一展示路径，视觉/行为严格一致
PetSprite.prototype.showBalanceNow = function showBalanceNow(state) {
  if (!state || !state.ok) return;
  const p = S.balancePercent(state);
  if (p === undefined) return; // 当前数据源没有百分比语义：不触发档位动画
  const pool = this.animations.events?.balance;
  if (!pool || pool.length === 0) {
    console.error('[dsh-pet] 配置缺少 animations.events.balance，无法播放余额事件动画');
    return;
  }
  const idx = S.balanceEventIndex(p);
  const slot = pool[idx];
  if (!slot) {
    console.error('[dsh-pet] balance 档位索引越界：p=' + p + ' idx=' + idx);
    return;
  }
  const name = S.pickSlot(slot, this.anim); // 数组槽位档内随机抽 1，且避开当前正播动画（避免连续重复，与浏览器一致）
  this.stopMove();
  this.bubbleOn = true;
  this.balanceWrap = false; // 正常余额气泡是单行（nowrap），别继承上一次文字说明的换行变体
  this.balanceView = balanceView(state);
  this.renderBubble();
  // 气泡 10s 定时消失（与动画解耦：即使动画被点击/拖拽打断，气泡也按时收起；重复触发先清旧定时器）
  if (this.bubbleTimer !== null) window.clearTimeout(this.bubbleTimer);
  this.bubbleTimer = window.setTimeout(() => {
    this.bubbleOn = false;
    this.renderBubble();
  }, BUBBLE_DURATION_MS);
  this.playOnce(name);
};

// ---------- 定时任务组装（boot 成功后调用一次） ----------

// 余额不可用 → 文字说明气泡：自动轮询只在原因变化时弹一次（判定在 shared）
function applyBalanceNotice(state, explicit) {
  const notice = S.decideBalanceNotice(state, balanceNoticeKey, explicit);
  balanceNoticeKey = notice.key;
  if (notice.show) for (const s of sprites) s.showBalanceNotice(state);
}

function startLoops() {
  if (loopsStarted) return;
  loopsStarted = true;

  // 定时报余额：第一次也等满一个周期（启动时她先打招呼，不急着报账）。
  // 不在这里判断开关、而是每拍再判：这样设置里打开/关掉「定时报余额」当场生效，不必重建窗口。
  const intervalMs = Math.max(60, config.refreshSec?.balance ?? 1800) * 1000;
  const balanceLoop = async () => {
    try {
      // 隐藏期间 / 主人不在时不查；开关关着也不查
      if (!sprites.every((s) => s.suspended || s.away) && sprites.some((s) => s.pet.balanceEnabled)) {
        const state = await S.fetchBalanceState(BALANCE_URL);
        balance = state;
        window.__dshPetDebug.lastBalanceOk = state && state.ok === true;
        if (state.ok) {
          balanceTick++;
          for (const s of sprites) s.onBalanceTick(state, balanceTick);
        } else {
          applyBalanceNotice(state, false);
        }
      }
    } catch (e) {
      console.warn('[pet] 余额拉取失败', e);
    }
    setTimeout(() => void balanceLoop(), intervalMs);
  };
  setTimeout(() => void balanceLoop(), intervalMs);

  for (const s of sprites) s.startWhisperLoop();
}
