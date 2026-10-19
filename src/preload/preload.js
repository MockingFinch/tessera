'use strict';

// Sandboxed preload: exposes window.tessera. Only contextBridge, ipcRenderer and webUtils.

const { contextBridge, ipcRenderer, webUtils } = require('electron');

// Main passes dev config as `--tessera-dev=<uri-encoded JSON>` (webPreferences.additionalArguments),
// since a sandboxed preload can't rely on process.env.
function readDevConfig() {
  const prefix = '--tessera-dev=';
  const argv = (typeof process !== 'undefined' && Array.isArray(process.argv)) ? process.argv : [];
  const arg = argv.find((a) => typeof a === 'string' && a.startsWith(prefix));
  if (!arg) return {};
  try {
    return JSON.parse(decodeURIComponent(arg.slice(prefix.length))) || {};
  } catch {
    return {};
  }
}
const devConfig = readDevConfig();

// on*(cb) → unsubscribe()
function subscribe(channel) {
  return (cb) => {
    if (typeof cb !== 'function') throw new TypeError(`${channel}: callback must be a function`);
    const listener = (_event, payload) => cb(payload);
    ipcRenderer.on(channel, listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      ipcRenderer.removeListener(channel, listener);
    };
  };
}

const str = (v) => (typeof v === 'string' ? v : undefined);
const numOr = (v) => (typeof v === 'number' ? v : undefined);

contextBridge.exposeInMainWorld('tessera', {
  getLocations: () => ipcRenderer.invoke('locations:get'),
  chooseFolder: () => ipcRenderer.invoke('dialog:choose-folder'),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || '';
    } catch {
      return '';
    }
  },

  startScan: async (opts) => {
    const o = typeof opts === 'string' ? { path: opts } : opts || {};
    const r = await ipcRenderer.invoke('scan:start', { path: str(o.path), name: str(o.name) });
    if (!r || typeof r.error === 'string') throw new Error((r && r.error) || 'scan-failed');
    return r;
  },
  cancelScan: () => ipcRenderer.invoke('scan:cancel'),
  getView: (opts) => {
    const o = opts || {};
    return ipcRenderer.invoke('scan:view', {
      key: str(o.key),
      depth: numOr(o.depth),
      minFrac: numOr(o.minFrac),
      maxChildren: numOr(o.maxChildren),
    });
  },

  reveal: (key) => ipcRenderer.invoke('item:reveal', str(key)),
  open: (key) => ipcRenderer.invoke('item:open', str(key)),
  quickLook: (key) => ipcRenderer.invoke('item:quicklook', str(key)),
  copyPath: (key) => ipcRenderer.invoke('item:copy-path', str(key)),
  trash: (key) => ipcRenderer.invoke('item:trash', str(key)),
  showContextMenu: (item) => {
    const o = item || {};
    ipcRenderer.send('item:context-menu', {
      key: str(o.key),
      name: str(o.name),
      isDir: !!o.isDir,
      isPkg: !!o.isPkg,
      size: numOr(o.size),
    });
  },

  openFullDiskAccess: () => ipcRenderer.invoke('app:full-disk-access'),
  getAccentColor: () => ipcRenderer.invoke('app:accent-color'),
  getLanguage: () => ipcRenderer.invoke('app:get-language'), // → Promise<'en'|'zh'>
  setLanguage: (lang) => ipcRenderer.invoke('app:set-language', str(lang)), // → Promise<active lang>
  onLanguage: subscribe('app:language-changed'), // cb('en'|'zh')

  onProgress: subscribe('scan:progress'),
  onScanDone: subscribe('scan:done'),
  onCommand: subscribe('app:command'),
  onWindowState: subscribe('window:state'),
  onAccentColor: subscribe('app:accent-changed'),
  onItemRemoved: subscribe('item:removed'),

  dev: {
    autoScan: typeof devConfig.autoScan === 'string' ? devConfig.autoScan : null,
    shotDir: typeof devConfig.shotDir === 'string' ? devConfig.shotDir : null,
    demo: devConfig.demo === true, // TESSERA_DEMO=1: the renderer uses the built-in demo data
    recording: devConfig.record === true,
    // Resolves to the PNG path, or null when TESSERA_SHOT_DIR isn't set.
    capture: (name) => ipcRenderer.invoke('dev:capture', String(name)),
    // 'start' | 'stop'; a no-op unless TESSERA_RECORD_DIR is set.
    record: (cmd) => ipcRenderer.invoke('dev:record', cmd === 'stop' ? 'stop' : 'start'),
  },
});
