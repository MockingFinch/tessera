'use strict';

// Main-process strings (menus, context menu, trash sheet, open panel, About credits).
// English is the default; the app does not follow the system language.
// The renderer keeps its own strings in src/renderer/js/i18n.js.

const LANGUAGES = ['en', 'zh'];

// Shown in View → Language, each in its own language.
const LANGUAGE_NAMES = { en: 'English', zh: '简体中文' };

const STRINGS = {
  en: {
    about: 'About Tessera',
    services: 'Services',
    hide: 'Hide Tessera',
    hideOthers: 'Hide Others',
    showAll: 'Show All',
    quit: 'Quit Tessera',
    file: 'File',
    scanFolder: 'Scan Folder…',
    scanHome: 'Scan Home Folder',
    rescan: 'Rescan',
    closeWindow: 'Close Window',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    selectAll: 'Select All',
    copyPath: 'Copy Path',
    moveToTrash: 'Move to Trash',
    view: 'View',
    locations: 'Locations',
    enclosingFolder: 'Enclosing Folder',
    openSelection: 'Open Selection',
    quickLook: 'Quick Look',
    fullScreen: 'Enter Full Screen',
    exitFullScreen: 'Exit Full Screen',
    language: 'Language',
    developer: 'Developer',
    toggleDevTools: 'Toggle Developer Tools',
    reloadWindow: 'Reload Window',
    window: 'Window',
    minimize: 'Minimize',
    zoom: 'Zoom',
    front: 'Bring All to Front',
    openInTessera: 'Open in Tessera',
    open: 'Open',
    revealInFinder: 'Reveal in Finder',
    moveToTrashEllipsis: 'Move to Trash…',
    trashMessage: 'Move “{name}” to the Trash?',
    trashDetail: 'This frees up about {size}. You can put it back from the Trash in Finder.',
    trashFailed: '“{name}” couldn’t be moved to the Trash.',
    ok: 'OK',
    cancel: 'Cancel',
    openPanelTitle: 'Choose a Folder to Scan',
    openPanelButton: 'Scan',
    credits: "See what's taking up space.",
    homeName: 'Home',
    zeroBytes: 'Zero KB',
    bytes: 'bytes',
  },
  zh: {
    about: '关于 Tessera',
    services: '服务',
    hide: '隐藏 Tessera',
    hideOthers: '隐藏其他',
    showAll: '全部显示',
    quit: '退出 Tessera',
    file: '文件',
    scanFolder: '扫描文件夹…',
    scanHome: '扫描个人文件夹',
    rescan: '重新扫描',
    closeWindow: '关闭窗口',
    edit: '编辑',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '拷贝',
    paste: '粘贴',
    selectAll: '全选',
    copyPath: '拷贝路径',
    moveToTrash: '移到废纸篓',
    view: '显示',
    locations: '位置',
    enclosingFolder: '上层文件夹',
    openSelection: '打开所选项',
    quickLook: '快速查看',
    fullScreen: '进入全屏幕',
    exitFullScreen: '退出全屏幕',
    language: '语言',
    developer: '开发者',
    toggleDevTools: '切换开发者工具',
    reloadWindow: '重新载入窗口',
    window: '窗口',
    minimize: '最小化',
    zoom: '缩放',
    front: '前置全部窗口',
    openInTessera: '在 Tessera 中打开',
    open: '打开',
    revealInFinder: '在访达中显示',
    moveToTrashEllipsis: '移到废纸篓…',
    trashMessage: '要将“{name}”移到废纸篓吗？',
    trashDetail: '这将释放约 {size} 空间。你可以在访达的废纸篓中将它放回原处。',
    trashFailed: '无法将“{name}”移到废纸篓。',
    ok: '好',
    cancel: '取消',
    openPanelTitle: '选择要扫描的文件夹',
    openPanelButton: '扫描',
    credits: '看清是什么占用了空间。',
    homeName: '个人文件夹',
    zeroBytes: '零 KB',
    bytes: '字节',
  },
};

let current = 'en';

function normalizeLanguage(lang) {
  return LANGUAGES.includes(lang) ? lang : 'en';
}

function setLanguage(lang) {
  current = normalizeLanguage(lang);
  return current;
}

function getLanguage() {
  return current;
}

// t('trashMessage', { name: 'Foo' }) → 'Move “Foo” to the Trash?'
function t(key, vars) {
  const s = STRINGS[current][key] ?? STRINGS.en[key] ?? key;
  if (!vars) return s;
  return s.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

module.exports = { LANGUAGES, LANGUAGE_NAMES, STRINGS, t, setLanguage, getLanguage, normalizeLanguage };
