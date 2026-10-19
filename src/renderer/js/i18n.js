// Renderer strings. English is the default; Simplified Chinese follows macOS's own
// vocabulary (访达, 废纸篓, 快速查看, 个人文件夹…). Menus and sheets are translated in
// src/main/i18n.js.

const STRINGS = {
  en: {
    tagline: 'See what’s taking up space.',
    dropHint: 'You can also drop any folder onto this window.',
    dropCard: 'Drop a folder to see inside it',
    tipBack: 'Enclosing Folder',
    tipRescan: 'Rescan',
    tipLocations: 'Locations',
    chooseName: 'Choose Folder…',
    chooseDetail: 'Any folder, on any disk',
    homeName: 'Home',
    homeDetail: 'Your files, {user}',
    homeDetailAnon: 'Your files',
    available: '{free} available',
    itemsOne: '{n} item',
    itemsMany: '{n} items',
    limited: 'Limited access',
    limitedTip: 'Some folders couldn’t be read. Give Tessera Full Disk Access to see everything.',
    looking: 'Looking around…',
    empty: 'This folder is empty',
    hintOpen: 'Double-click to open · ',
    hintSpace: 'Space',
    hintRest: ' to Quick Look · Right-click for more',
    folder: 'Folder',
    package: 'Package',
    tooSmall: '{items} too small to show',
    shareOf: '{pct} of {name}',
    smallerItems: 'Smaller items',
    smallerCount: '{n} smaller items',
    aggCount: '{n} items',
    onlyFolders: 'Only folders can be scanned.',
    cantOpen: 'Tessera couldn’t open that location.',
    scanStopped: 'The scan stopped unexpectedly. Press ⌘R to scan again.',
    stopped: 'Scan stopped',
    trashedNamed: 'Moved “{name}” to the Trash',
    trashed: 'Moved to the Trash',
    freed: '{size} freed',
    pathCopied: 'Path copied',
    zeroBytes: 'Zero KB',
    bytes: 'bytes',
    kindApps: 'Apps',
    kindVideo: 'Video',
    kindPhotos: 'Photos',
    kindAudio: 'Audio',
    kindDocuments: 'Documents',
    kindArchives: 'Archives',
    kindDeveloper: 'Developer',
    kindSystem: 'System',
    kindOther: 'Other',
    mapLabel: 'Treemap of folder sizes',
  },
  zh: {
    tagline: '看清是什么占用了空间。',
    dropHint: '也可以将任意文件夹拖到此窗口。',
    dropCard: '松开即可查看此文件夹',
    tipBack: '上层文件夹',
    tipRescan: '重新扫描',
    tipLocations: '位置',
    chooseName: '选择文件夹…',
    chooseDetail: '任意磁盘上的任意文件夹',
    homeName: '个人文件夹',
    homeDetail: '{user} 的文件',
    homeDetailAnon: '你的文件',
    available: '可用 {free}',
    itemsOne: '{n} 个项目',
    itemsMany: '{n} 个项目',
    limited: '访问受限',
    limitedTip: '部分文件夹无法读取。授予 Tessera“完全磁盘访问权限”即可看到全部内容。',
    looking: '正在查看…',
    empty: '此文件夹为空',
    hintOpen: '连按以打开 · 按',
    hintSpace: '空格键',
    hintRest: '快速查看 · 右键点按查看更多',
    folder: '文件夹',
    package: '包',
    tooSmall: '{items}过小未单独显示',
    shareOf: '占“{name}”的 {pct}',
    smallerItems: '较小的项目',
    smallerCount: '{n} 个较小的项目',
    aggCount: '{n} 项',
    onlyFolders: '只能扫描文件夹。',
    cantOpen: 'Tessera 无法打开该位置。',
    scanStopped: '扫描意外停止。按 ⌘R 重新扫描。',
    stopped: '扫描已停止',
    trashedNamed: '已将“{name}”移到废纸篓',
    trashed: '已移到废纸篓',
    freed: '已释放 {size}',
    pathCopied: '已拷贝路径',
    zeroBytes: '零 KB',
    bytes: '字节',
    kindApps: '应用',
    kindVideo: '视频',
    kindPhotos: '照片',
    kindAudio: '音频',
    kindDocuments: '文稿',
    kindArchives: '压缩包',
    kindDeveloper: '开发',
    kindSystem: '系统',
    kindOther: '其他',
    mapLabel: '文件夹大小的矩形树图',
  },
};

let lang = 'en';
const listeners = new Set();

export function getLang() {
  return lang;
}

export function locale() {
  return lang === 'zh' ? 'zh-CN' : 'en-US';
}

export function setLang(next) {
  const value = next === 'zh' ? 'zh' : 'en';
  if (value === lang) return;
  lang = value;
  document.documentElement.lang = value === 'zh' ? 'zh-Hans' : 'en';
  for (const fn of listeners) fn(lang);
}

export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function t(key, vars) {
  const table = STRINGS[lang] || STRINGS.en;
  let text = table[key] ?? STRINGS.en[key] ?? key;
  if (vars) text = text.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  return text;
}

// Fill every [data-i18n] / [data-i18n-tip] / [data-i18n-label] element in the static page.
export function translateDocument(root = document) {
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const el of root.querySelectorAll('[data-i18n-tip]')) {
    el.title = t(el.dataset.i18nTip);
    el.setAttribute('aria-label', t(el.dataset.i18nTip));
  }
  for (const el of root.querySelectorAll('[data-i18n-label]')) el.setAttribute('aria-label', t(el.dataset.i18nLabel));
}
