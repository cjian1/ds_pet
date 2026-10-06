'use strict';
/**
 * 流式正文合帧器（带前沿的节流）。
 *
 * 模型按 token 吐字（一个字一个 delta 很常见），逐条转发到渲染端的话，每条都要
 * 改一次 DOM 文本 + 读一次 scrollHeight（强制回滚），快模型下每帧能来好几次。
 * 这里每 flushMs 最多吐一次（~25 帧/秒），IPC 与布局都降一个数量级。
 *
 * 前沿：距上次吐字已经过了一个窗口（包括第一个字）就**立刻**吐，不白等 flushMs ——
 * 主人等的就是她开口的那一下；窗口内再来的字才攒着，等窗口到点一起吐。
 *
 * 收尾必须调 flushNow()：尾部不足一帧的字不能丢（正文完整结果另有返回值兜底，
 * 但流式过程里也不能缺字）。计时器与时钟可注入，便于单测（test/stream-buffer.test.js）。
 */

/**
 * @param {object} o
 * @param {number} o.flushMs      合帧窗口（ms）
 * @param {(text: string) => void} o.onFlush  一次吐出攒下的正文（非空）
 * @param {typeof setTimeout} [o.setTimer]    注入用
 * @param {typeof clearTimeout} [o.clearTimer] 注入用
 * @param {() => number} [o.now]              注入用
 */
function createStreamBuffer({ flushMs, onFlush, setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now } = {}) {
  let pending = '';
  let timer = null;
  let lastFlush = -Infinity;
  const flush = () => {
    timer = null;
    if (!pending) return;
    const text = pending;
    pending = '';
    lastFlush = now();
    onFlush(text);
  };
  return {
    /** 收到一个 delta：离上次吐字够久就立刻吐，否则攒到窗口结束 */
    push(piece) {
      if (!piece) return;
      pending += piece;
      if (timer !== null) return;
      const wait = lastFlush + flushMs - now();
      if (wait <= 0) flush();
      else timer = setTimer(flush, wait);
    },
    /** 收尾（成功 / 失败 / 中止都要）：立刻把残余吐出去，取消未触发的计时器 */
    flushNow() {
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      flush();
    },
    /** 还没吐出去的正文长度（单测用） */
    pendingLength() {
      return pending.length;
    },
  };
}

module.exports = { createStreamBuffer };
