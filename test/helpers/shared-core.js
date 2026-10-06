'use strict';
/** 在 node 里加载渲染端的 shared-core.js（浏览器脚本，顶层是 var PetShared = (...)({})） */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const file = path.join(__dirname, '..', '..', 'desktop', 'pet', 'shared-core.js');

function loadSharedCore() {
  const context = vm.createContext({ console });
  vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
  return context.PetShared;
}

module.exports = { loadSharedCore };
