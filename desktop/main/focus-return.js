'use strict';
/**
 * 点她 / 拖她 / 右键她之后，把焦点还给你原来在用的应用。
 *
 * 为什么要这样绕：macOS 上点一个窗口就会激活它所属的应用，只有真正的 NSPanel 加上「非激活」样式才例外。
 * Electron 的 type:'panel' 其实是 NSWindow 子类，focusable:false 也挡不住（scripts/debug/real-input.mjs
 * 实测过）。不处理的话，你正在打字的窗口一点她就丢了光标。
 *
 * 做法：
 *  1. 光标进入桌宠窗口、而本应用不在前台时，记下当前最前面的应用（lsappinfo，每秒最多一次）；
 *  2. 一次交互（渲染端「正在用输入」从 true 到 false：点击、拖拽、右键菜单）期间本应用被激活了，
 *     交互结束就把记下的应用重新激活（osascript 里用 NSRunningApplication，不发 Apple 事件，
 *     不需要「自动化」授权，也不会像 open -b 那样让没开窗口的应用新开一个窗口）；
 *  3. 本来就要本应用在前台的操作（打开聊天 / 设置 / 选图 / 关于）调用 cancel()，这次就不还了。
 *
 * 状态机是纯逻辑（createFocusReturn），系统调用由 macSystem() 提供，单测见 test/focus-return.test.js。
 */
const { execFile } = require('node:child_process');

/** 交互开始前后多久内的激活算「她引起的」（AppKit 的激活通知和渲染端的输入事件谁先到不一定） */
const LINK_MS = 1000;
/** 光标停在窗口里时多久重新记一次最前面的应用（期间你可能 ⌘Tab 换了应用） */
const CAPTURE_EVERY_MS = 1000;

/**
 * @param {object} sys
 * @param {number} sys.ownPid           本应用的 pid（记到自己就不算）
 * @param {() => Promise<number|null>} sys.frontPid   当前最前面应用的 pid
 * @param {(pid: number) => void} sys.activate        激活某个应用
 * @param {() => number} [sys.now]
 */
function createFocusReturn(sys) {
  const now = sys.now || Date.now;
  let active = false;
  let saved = null; // 记下的应用 pid
  let lastCapture = -Infinity;
  let activatedAt = -Infinity;
  let interacting = false;
  let lastEnd = -Infinity;
  let stolen = false; // 这次交互把本应用激活了
  let captures = 0; // 采样次数（每次要起两个 lsappinfo 进程，排障/能耗定位用）

  function giveBack() {
    const pid = saved;
    stolen = false;
    saved = null;
    if (pid) sys.activate(pid);
  }

  return {
    /** 光标在桌宠窗口里（主进程 60ms 轮询调用；内部限频） */
    pointerNear() {
      if (active || now() - lastCapture < CAPTURE_EVERY_MS) return;
      lastCapture = now();
      captures++;
      Promise.resolve(sys.frontPid())
        .then((pid) => {
          if (Number.isInteger(pid) && pid > 0 && pid !== sys.ownPid) saved = pid;
        })
        .catch(() => {});
    },

    becameActive() {
      active = true;
      activatedAt = now();
      if (!saved) return;
      if (interacting) stolen = true;
      else if (now() - lastEnd < LINK_MS) giveBack(); // 点得快：交互结束的消息比激活通知先到
    },

    resignedActive() {
      active = false;
      stolen = false;
    },

    /** 渲染端「正在用输入」变化：拖拽 / 点击（按下到松开）/ 右键菜单开着 */
    interaction(busy) {
      if (busy) {
        if (interacting) return;
        interacting = true;
        if (active && saved && now() - activatedAt < LINK_MS) stolen = true;
        return;
      }
      if (!interacting) return;
      interacting = false;
      lastEnd = now();
      if (stolen && active) giveBack();
    },

    /** 这次是要用本应用的窗口（聊天 / 设置 / 选图 / 关于）：别还 */
    cancel() {
      stolen = false;
      saved = null;
      lastEnd = -Infinity;
    },

    /** 排障用 */
    stats() {
      return { captures, saved, active };
    },
  };
}

/** macOS 上的系统调用：lsappinfo 查最前面的应用；osascript（JXA）激活某个应用 */
function macSystem() {
  const run = (cmd, args) =>
    new Promise((resolve) => execFile(cmd, args, { timeout: 3000 }, (err, out) => resolve(err ? '' : String(out))));
  return {
    ownPid: process.pid,
    async frontPid() {
      const asn = (await run('lsappinfo', ['front'])).trim();
      if (!asn) return null;
      const m = /pid\s*=\s*(\d+)/.exec(await run('lsappinfo', ['info', '-only', 'pid', asn]));
      return m ? Number(m[1]) : null;
    },
    activate(pid) {
      if (!Number.isInteger(pid) || pid <= 0) return;
      const js =
        "ObjC.import('AppKit');" +
        'var a = $.NSRunningApplication.runningApplicationWithProcessIdentifier(' + pid + ');' +
        'a.isNil() ? "gone" : String(a.activateWithOptions(0));';
      run('osascript', ['-l', 'JavaScript', '-e', js]);
    },
  };
}

module.exports = { createFocusReturn, macSystem, LINK_MS, CAPTURE_EVERY_MS };
