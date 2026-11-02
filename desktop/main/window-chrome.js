'use strict';
/**
 * 聊天面板 / 设置窗口的「窗框」按系统分开：
 *   macOS    原生毛玻璃（vibrancy），页面背景透明，窗口本身透出桌面的颜色。
 *   Windows  没有同款毛玻璃：窗口用不透明底色（跟着系统深浅色），页面照样是透明的，底色从窗口透上来，
 *            所以页面 CSS 不用为 Windows 另写一套背景。系统切换深浅色时把底色（和标题栏按钮）一起换掉。
 */
const { nativeTheme } = require('electron');

/** Windows 上的窗口底色：聊天面板 / 设置窗口侧栏 / 设置窗口内容区（= 标题栏按钮的底色） */
const COLORS = {
  chat: { light: '#eef1f7', dark: '#24262c' },
  sidebar: { light: '#e9e9ee', dark: '#2b2b2f' },
  content: { light: '#f5f5f7', dark: '#1e1e20' },
  text: { light: '#1d1d1f', dark: '#f2f2f4' },
};

function color(kind, dark = nativeTheme.shouldUseDarkColors) {
  return COLORS[kind][dark ? 'dark' : 'light'];
}

/** 设置窗口右上角的系统按钮（最小化 / 最大化 / 关闭）：和内容区同色，看不出接缝 */
function titleBarOverlay(dark = nativeTheme.shouldUseDarkColors) {
  return { color: color('content', dark), symbolColor: color('text', dark), height: 34 };
}

/** 窗口活着期间跟着系统深浅色走；apply 里改底色等（窗口关掉自动取消监听） */
function followTheme(win, apply) {
  const run = () => {
    if (!win.isDestroyed()) apply(nativeTheme.shouldUseDarkColors);
  };
  nativeTheme.on('updated', run);
  win.on('closed', () => nativeTheme.removeListener('updated', run));
}

module.exports = { COLORS, color, titleBarOverlay, followTheme };
