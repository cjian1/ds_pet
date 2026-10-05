'use strict';
/**
 * 三个菜单：她身上的右键菜单、菜单栏图标菜单、应用菜单（设置/聊天窗口在前台时的 ⌘C ⌘V ⌘W ⌘Q）。
 * 全部用系统原生菜单：跟 macOS 其它软件一个手感（键盘可选、深色模式自动适配、不会被窗口边缘裁掉）。
 * 文案走 i18n（ctx.t），动画名在英文界面下显示翻译。
 */
const { Menu, app } = require('electron');
const I18n = require('../i18n/i18n.js');
const { SIZE_PRESETS } = require('./store');

/** 动作树（与上游 buildMenuTree 同一分组）：待机/转向/拖拽/点击回应/移动 + 分类 + 事件动画 */
function animationGroups(animations, t) {
  if (!animations) return [];
  const groups = [];
  const pools = [
    ['group.idle', animations.idle],
    ['group.turn', animations.turn],
    ['group.drag', animations.drag],
    ['group.clicks', animations.clicks],
    ['group.moves', ((animations.moves && animations.moves.actions) || []).map((m) => m.name)],
  ];
  for (const [key, pool] of pools) if (pool && pool.length) groups.push({ label: t(key), items: pool });
  for (const c of animations.categories || []) {
    if (c.actions && c.actions.length) groups.push({ label: I18n.has('group.' + c.id) ? t('group.' + c.id) : c.id, items: c.actions });
  }
  for (const [key, pool] of Object.entries(animations.events || {})) {
    const names = [];
    for (const slot of pool || []) names.push(...(Array.isArray(slot) ? slot : [slot]));
    if (names.length) groups.push({ label: I18n.has('group.' + key) ? t('group.' + key) : key, items: names });
  }
  return groups;
}

function sizeSubmenu(ctx) {
  const { t } = ctx;
  const cur = ctx.settings.pet.size;
  const items = SIZE_PRESETS.map((p) => ({
    label: t(p.key) + '  ' + p.size,
    type: 'radio',
    checked: cur === p.size,
    click: () => ctx.setSize(p.size),
  }));
  if (!SIZE_PRESETS.some((p) => p.size === cur)) {
    items.push({ type: 'separator' }, { label: t('menu.sizeCustom', { n: cur }), type: 'radio', checked: true, enabled: false });
  }
  items.push({ type: 'separator' }, { label: t('menu.sizeMore'), click: () => ctx.openSettings('pet') });
  return items;
}

function shortcutLabel(settings) {
  return settings.app.shortcutEnabled ? settings.app.shortcut : undefined;
}

/** 她身上的右键菜单 */
function petMenu(ctx) {
  const { t, settings: s, name, hasKey } = ctx;
  const anims = animationGroups(ctx.animations, t).map((g) => ({
    label: g.label,
    submenu: g.items.map((anim) => ({ label: I18n.anim(ctx.lang, anim), click: () => ctx.play(anim) })),
  }));
  const template = [
    { label: t('menu.chatWith', { name }), click: () => ctx.openChat() },
    { label: t('menu.say'), enabled: hasKey, click: () => ctx.whisper() },
    { label: t('menu.showImage'), enabled: hasKey, click: () => ctx.pickImage() },
    { label: t('menu.balance'), enabled: hasKey, click: () => ctx.balance() },
  ];
  if (!hasKey) template.push({ label: t('menu.needKey'), click: () => ctx.openSettings('ai') });
  template.push(
    { type: 'separator' },
    { label: t('menu.actions'), submenu: anims.length ? anims : [{ label: t('menu.noActions'), enabled: false }] },
    { label: t('menu.size'), submenu: sizeSubmenu(ctx) },
    { label: t('menu.roam'), type: 'checkbox', checked: s.pet.roam, click: () => ctx.toggleRoam() },
    { label: t('menu.home'), click: () => ctx.home() },
    { type: 'separator' },
    {
      label: t('menu.hide', { name }),
      accelerator: shortcutLabel(s),
      registerAccelerator: false,
      click: () => ctx.setVisible(false),
    },
    { label: t('menu.settings'), accelerator: 'Command+,', registerAccelerator: false, click: () => ctx.openSettings() },
    { label: t('menu.quitApp'), accelerator: 'Command+Q', registerAccelerator: false, click: () => ctx.quit() },
  );
  return Menu.buildFromTemplate(template);
}

/** 菜单栏图标菜单 */
function trayMenu(ctx) {
  const { t, settings: s, name, visible } = ctx;
  const template = [
    { label: name, enabled: false },
    {
      label: visible ? t('menu.hide', { name }) : t('menu.show', { name }),
      accelerator: shortcutLabel(s),
      registerAccelerator: false,
      click: () => ctx.setVisible(!visible),
    },
    { type: 'separator' },
    { label: t('tray.chat'), click: () => ctx.openChat() },
    { label: t('tray.say'), enabled: ctx.hasKey && visible, click: () => ctx.whisper() },
    { label: t('menu.home'), enabled: visible, click: () => ctx.home() },
    { type: 'separator' },
    { label: t('menu.size'), submenu: sizeSubmenu(ctx) },
    { label: t('menu.roam'), type: 'checkbox', checked: s.pet.roam, click: () => ctx.toggleRoam() },
    {
      label: t('tray.whisper'),
      type: 'checkbox',
      checked: s.talk.whisperEnabled,
      enabled: ctx.hasKey,
      click: () => ctx.toggleWhisper(),
    },
    { type: 'separator' },
  ];
  if (!ctx.hasKey) template.push({ label: t('tray.noKey'), click: () => ctx.openSettings('ai') });
  template.push(
    { label: t('menu.settings'), accelerator: 'Command+,', registerAccelerator: false, click: () => ctx.openSettings() },
    {
      label: t('tray.login'),
      type: 'checkbox',
      checked: s.app.openAtLogin,
      enabled: app.isPackaged,
      click: () => ctx.toggleLogin(),
    },
    { type: 'separator' },
    { label: t('menu.about'), click: () => ctx.about() },
    { label: t('menu.quit'), accelerator: 'Command+Q', registerAccelerator: false, click: () => ctx.quit() },
  );
  return Menu.buildFromTemplate(template);
}

/** 应用菜单：设置/聊天窗口在前台时生效（输入框里的复制粘贴、⌘W 关窗口、⌘Q 退出都靠它） */
function appMenu(ctx) {
  const { t } = ctx;
  return Menu.buildFromTemplate([
    {
      label: app.name,
      submenu: [
        { label: t('menu.about'), click: () => ctx.about() },
        { type: 'separator' },
        { label: t('menu.settings'), accelerator: 'Command+,', click: () => ctx.openSettings() },
        { type: 'separator' },
        { label: t('appmenu.hideApp'), role: 'hide' },
        { label: t('appmenu.hideOthers'), role: 'hideOthers' },
        { label: t('appmenu.showAll'), role: 'unhide' },
        { type: 'separator' },
        { label: t('menu.quitApp'), accelerator: 'Command+Q', click: () => ctx.quit() },
      ],
    },
    {
      label: t('appmenu.edit'),
      submenu: [
        { label: t('appmenu.undo'), role: 'undo' },
        { label: t('appmenu.redo'), role: 'redo' },
        { type: 'separator' },
        { label: t('appmenu.cut'), role: 'cut' },
        { label: t('appmenu.copy'), role: 'copy' },
        { label: t('appmenu.paste'), role: 'paste' },
        { label: t('appmenu.selectAll'), role: 'selectAll' },
      ],
    },
    {
      label: t('appmenu.pet'),
      submenu: [
        { label: t('appmenu.chat'), accelerator: 'Command+Shift+C', click: () => ctx.openChat() },
        { label: t('appmenu.toggle'), click: () => ctx.setVisible(!ctx.visible) },
        { label: t('menu.home'), click: () => ctx.home() },
      ],
    },
    {
      label: t('appmenu.window'),
      submenu: [
        { label: t('appmenu.minimize'), role: 'minimize' },
        { label: t('appmenu.close'), role: 'close' },
      ],
    },
  ]);
}

module.exports = { petMenu, trayMenu, appMenu, animationGroups };
