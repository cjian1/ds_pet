/**
 * 身体命中区（窗口内坐标，CSS 像素）。
 *
 * 这条公式主进程和渲染端**必须一致**：主进程按它决定窗口收不收鼠标（只有压在身体上才可交互），
 * 渲染端按它放 `.pet-hit`（也决定了命中判定的转发）。两边算的不是同一块，较大的那条就会赢——
 * 她会挡住下面应用的点击，或者点她没反应。
 *
 * 所以它单独放一个文件，渲染端（sprite.js）和单测（vm 读同一份源码与主进程对拍）共用，
 * 而不是在测试里手抄一遍公式（抄的那份不会跟着真代码漂移而失败）。
 *
 * 浏览器脚本（非模块）：顶层函数进全局，index.html 里先于 sprite.js 加载。
 */
'use strict';

/**
 * @param {{x0:number,y0:number,x1:number,y1:number}} hitBox 640×360 舞台坐标里的命中框
 * @param {number} size    宠物尺寸（舞台宽，CSS 像素）
 * @param {number} bottomPad 舞台被 translateY 下移的余量（脚底留白），命中区 y 要补回来
 */
function petHitRect(hitBox, size, bottomPad) {
  const height = (size * 9) / 16; // 舞台高
  return {
    x: (hitBox.x0 / 640) * size,
    y: bottomPad + (hitBox.y0 / 360) * height,
    w: ((hitBox.x1 - hitBox.x0) / 640) * size,
    h: ((hitBox.y1 - hitBox.y0) / 360) * height,
  };
}
