'use strict';

// Application menu + tile context menu. Every item (role items included) gets an explicit,
// translated label, so the whole menu follows the in-app language, not the system one.

const { Menu } = require('electron');
const { t, getLanguage, LANGUAGES, LANGUAGE_NAMES } = require('./i18n');

const sep = { type: 'separator' };

// opts:
//   command(payload)    delivers an app:command (main.js queues it until the window has loaded)
//   setLanguage(lang)   View → Language
//   isPackaged          hides the Developer submenu in release builds
//   fullscreen          current window state, for the Enter/Exit Full Screen label
function buildAppMenu({ command, setLanguage, isPackaged, fullscreen = false }) {
  const cmd = (name) => () => command({ cmd: name });
  const lang = getLanguage();

  const viewMenu = [
    { label: t('locations'), accelerator: 'Shift+CmdOrCtrl+L', click: cmd('show-locations') },
    sep,
    { label: t('enclosingFolder'), accelerator: 'CmdOrCtrl+Up', click: cmd('go-up') },
    { label: t('openSelection'), accelerator: 'CmdOrCtrl+Down', click: cmd('open-selection') },
    { label: t('quickLook'), accelerator: 'CmdOrCtrl+Y', click: cmd('quick-look') },
    sep,
    { role: 'togglefullscreen', label: fullscreen ? t('exitFullScreen') : t('fullScreen') },
    {
      label: t('language'),
      submenu: LANGUAGES.map((code) => ({
        label: LANGUAGE_NAMES[code],
        type: 'radio',
        checked: code === lang,
        click: () => setLanguage(code),
      })),
    },
  ];
  if (!isPackaged) {
    viewMenu.push({
      label: t('developer'),
      submenu: [
        { role: 'toggleDevTools', label: t('toggleDevTools'), accelerator: 'Alt+CmdOrCtrl+I' },
        // Not ⌘R: that's Rescan.
        { role: 'forceReload', label: t('reloadWindow'), accelerator: 'Shift+CmdOrCtrl+R' },
      ],
    });
  }

  const template = [
    {
      label: 'Tessera',
      submenu: [
        { role: 'about', label: t('about') },
        sep,
        { role: 'services', label: t('services') },
        sep,
        { role: 'hide', label: t('hide') },
        { role: 'hideOthers', label: t('hideOthers') },
        { role: 'unhide', label: t('showAll') },
        sep,
        { role: 'quit', label: t('quit') },
      ],
    },
    {
      label: t('file'),
      submenu: [
        { label: t('scanFolder'), accelerator: 'CmdOrCtrl+O', click: cmd('open-folder') },
        { label: t('scanHome'), accelerator: 'Shift+CmdOrCtrl+H', click: cmd('scan-home') },
        { label: t('rescan'), accelerator: 'CmdOrCtrl+R', click: cmd('rescan') },
        sep,
        { role: 'close', label: t('closeWindow'), accelerator: 'CmdOrCtrl+W' },
      ],
    },
    {
      label: t('edit'),
      submenu: [
        { role: 'undo', label: t('undo') },
        { role: 'redo', label: t('redo') },
        sep,
        { role: 'cut', label: t('cut') },
        { role: 'copy', label: t('copy') },
        { role: 'paste', label: t('paste') },
        { role: 'selectAll', label: t('selectAll') },
        sep,
        { label: t('copyPath'), accelerator: 'Alt+CmdOrCtrl+C', click: cmd('copy-path') },
        { label: t('moveToTrash'), accelerator: 'CmdOrCtrl+Backspace', click: cmd('trash-selection') },
      ],
    },
    { label: t('view'), submenu: viewMenu },
    {
      // role 'window' makes this the macOS Window menu (the window list is appended by AppKit).
      role: 'window',
      label: t('window'),
      submenu: [
        { role: 'minimize', label: t('minimize') },
        { role: 'zoom', label: t('zoom') },
        sep,
        { role: 'front', label: t('front') },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

// item = { key, name, isDir, isPkg, size }
// actions = { zoomInto, open, quickLook, reveal, copyPath, trash } — each takes the key.
function buildContextMenu(item, actions) {
  const { key } = item;
  const isAggregate = key.startsWith('a'); // "smaller items": no path behind it
  const isRoot = key === 'd0';
  const hasPath = !isAggregate;
  const isPlainDir = item.isDir && !item.isPkg;

  return Menu.buildFromTemplate([
    { label: t('openInTessera'), enabled: hasPath && isPlainDir, click: () => actions.zoomInto(key) },
    { label: t('open'), enabled: hasPath && !isPlainDir, click: () => actions.open(key) },
    { label: t('quickLook'), enabled: hasPath, click: () => actions.quickLook(key) },
    sep,
    { label: t('revealInFinder'), enabled: hasPath, click: () => actions.reveal(key) },
    { label: t('copyPath'), enabled: hasPath, click: () => actions.copyPath(key) },
    sep,
    { label: t('moveToTrashEllipsis'), enabled: hasPath && !isRoot, click: () => actions.trash(key) },
  ]);
}

module.exports = { buildAppMenu, buildContextMenu };
