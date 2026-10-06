'use strict';
/** 在 node 里加载渲染端的 hit-rect.js（浏览器脚本，顶层是 function petHitRect） */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const file = path.join(__dirname, '..', '..', 'desktop', 'pet', 'hit-rect.js');

function loadHitRect() {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return context.petHitRect;
}

module.exports = { loadHitRect };
