'use strict';

// Tessera main process: app lifecycle, the window, IPC, and the scanner process manager.

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  shell,
  Menu,
  nativeTheme,
  systemPreferences,
  utilityProcess,
  clipboard,
  screen,
  session,
} = require('electron');

const { buildAppMenu, buildContextMenu } = require('./menu');
const locations = require('./locations');
const i18n = require('./i18n');

const { t } = i18n;

app.setName('Tessera');

// ---------------------------------------------------------------------------------------
// Paths & dev config

const APP_ROOT = path.join(__dirname, '..', '..');
const PRELOAD = path.join(__dirname, '..', 'preload', 'preload.js');
const RENDERER_HTML = path.join(APP_ROOT, 'src', 'renderer', 'index.html');
const RENDERER_URL = require('node:url').pathToFileURL(RENDERER_HTML).href;
const WORKER = process.env.TESSERA_WORKER
  ? path.resolve(process.env.TESSERA_WORKER)
  : path.join(__dirname, '..', 'scanner', 'worker.js');
const DEV_ICON = path.join(APP_ROOT, 'build', 'icon.png');

const envPath = (name) => (process.env[name] ? path.resolve(process.env[name]) : null);
const DEV = {
  autoScan: envPath('TESSERA_AUTOSCAN'),
  shotDir: envPath('TESSERA_SHOT_DIR'),
  selftest: envPath('TESSERA_SELFTEST'),
  demo: process.env.TESSERA_DEMO === '1',
  recordDir: envPath('TESSERA_RECORD_DIR'),
};

const KIND_IDS = ['apps', 'video', 'photos', 'audio', 'documents', 'archives', 'developer', 'system', 'other'];
const ITEM_KEY = /^(d\d+|f\d+:\d+)$/; // keys that map to a path
const ANY_KEY = /^(d\d+|f\d+:\d+|a\d+)$/;

// Logs go to stderr: stdout is reserved for the selftest JSON.
const log = (...args) => console.error('[tessera]', ...args);

// Decimal units like Finder (1 GB = 10^9), the same units in both languages. Mirrors
// src/renderer/js/format.js so the trash sheet matches the size shown in the UI.
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return t('zeroBytes');
  if (bytes < 1000) return `${Math.round(bytes)} ${t('bytes')}`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let unit = -1;
  let value = bytes;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  const text = value.toFixed(value >= 100 ? 0 : 1).replace(/\.0$/, '');
  return `${text} ${units[unit]}`;
}

// ---------------------------------------------------------------------------------------
// Settings (userData/settings.json) & language

const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');

function readSettings() {
  try {
    const v = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

// Merges `patch` into whatever else is stored there.
function writeSettings(patch) {
  try {
    const file = settingsFile();
    const next = { ...readSettings(), ...patch };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (err) {
    log('could not save settings:', err.message);
  }
}

i18n.setLanguage(readSettings().language); // missing/invalid → 'en'

function applyAboutPanel() {
  app.setAboutPanelOptions({
    applicationName: 'Tessera',
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    credits: t('credits'),
  });
}

let menuReady = false;
function refreshAppMenu() {
  if (!menuReady) return;
  Menu.setApplicationMenu(
    buildAppMenu({
      command,
      setLanguage: changeLanguage,
      isPackaged: app.isPackaged,
      fullscreen: !!(win && !win.isDestroyed() && win.isFullScreen()),
    }),
  );
}

// Persists, rebuilds the menu, notifies every window. Returns the active language.
function changeLanguage(lang) {
  if (!i18n.LANGUAGES.includes(lang)) return i18n.getLanguage(); // ignore unknown values
  if (lang === i18n.getLanguage()) return lang;
  i18n.setLanguage(lang);
  writeSettings({ language: lang });
  applyAboutPanel();
  refreshAppMenu();
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.isDestroyed()) w.webContents.send('app:language-changed', lang);
  }
  return lang;
}

// ---------------------------------------------------------------------------------------
// Window

let win = null;
let winLoaded = false;
const pendingCommands = []; // app:command payloads waiting for the renderer to load

function send(channel, payload) {
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function command(payload) {
  if (win && !win.isDestroyed() && winLoaded) {
    send('app:command', payload);
    return;
  }
  pendingCommands.push(payload);
  if (app.isReady() && (!win || win.isDestroyed())) createWindow();
}

function flushCommands() {
  while (pendingCommands.length && winLoaded) send('app:command', pendingCommands.shift());
}

function pushWindowState(overrides) {
  if (!win || win.isDestroyed()) return;
  send('window:state', { fullscreen: win.isFullScreen(), focused: win.isFocused(), ...overrides });
}

const MIN_W = 760;
const MIN_H = 520;
const boundsFile = () => path.join(app.getPath('userData'), 'window-state.json');
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), Math.max(lo, hi));

// Saved bounds, clamped so the window lands fully on a connected display.
function restoreBounds() {
  let b;
  try {
    b = JSON.parse(fs.readFileSync(boundsFile(), 'utf8'));
  } catch {
    return null;
  }
  if (!b || ![b.x, b.y, b.width, b.height].every(Number.isFinite)) return null;
  const rect = {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.round(Math.max(b.width, MIN_W)),
    height: Math.round(Math.max(b.height, MIN_H)),
  };
  const wa = screen.getDisplayMatching(rect).workArea; // nearest display if off-screen
  const width = Math.min(rect.width, wa.width);
  const height = Math.min(rect.height, wa.height);
  return {
    x: Math.round(clamp(rect.x, wa.x, wa.x + wa.width - width)),
    y: Math.round(clamp(rect.y, wa.y, wa.y + wa.height - height)),
    width,
    height,
  };
}

function saveBounds(w) {
  if (!w || w.isDestroyed()) return;
  try {
    const b = w.getNormalBounds();
    const file = boundsFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ x: b.x, y: b.y, width: b.width, height: b.height }));
    fs.renameSync(tmp, file);
  } catch (err) {
    log('could not save window bounds:', err.message);
  }
}

function devArgument() {
  const cfg = { autoScan: DEV.autoScan, shotDir: DEV.shotDir, demo: DEV.demo, record: !!DEV.recordDir };
  return `--tessera-dev=${encodeURIComponent(JSON.stringify(cfg))}`;
}

function createWindow() {
  const bounds = restoreBounds();
  const w = new BrowserWindow({
    width: 1240,
    height: 820,
    ...(bounds || {}),
    minWidth: MIN_W,
    minHeight: MIN_H,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 20, y: 20 },
    vibrancy: 'under-window',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    show: false,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
      // The screenshot tour must keep animating while the window sits behind others.
      backgroundThrottling: !(DEV.shotDir || DEV.recordDir),
      additionalArguments: [devArgument()],
    },
  });
  win = w;
  winLoaded = false;
  const wc = w.webContents;
  if (DEV.shotDir || DEV.recordDir) {
    wc.on('console-message', (e) => {
      if (e.level === 'warning' || e.level === 'error' || /^\[tour\]/.test(e.message)) console.log(`[renderer:${e.level}] ${e.message}`);
    });
  }

  w.once('ready-to-show', () => w.show());

  w.on('enter-full-screen', () => {
    pushWindowState({ fullscreen: true });
    refreshAppMenu(); // Enter/Exit Full Screen label
  });
  w.on('leave-full-screen', () => {
    pushWindowState({ fullscreen: false });
    refreshAppMenu();
  });
  w.on('focus', () => pushWindowState({ focused: true }));
  w.on('blur', () => pushWindowState({ focused: false }));

  let saveTimer = null;
  const scheduleSave = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => saveBounds(w), 400);
  };
  w.on('resize', scheduleSave);
  w.on('move', scheduleSave);
  w.on('close', () => {
    clearTimeout(saveTimer);
    saveBounds(w);
  });
  w.on('closed', () => {
    if (win === w) {
      win = null;
      winLoaded = false;
      killScanner();
    }
  });

  wc.on('did-start-loading', () => {
    winLoaded = false;
  });
  wc.on('did-finish-load', () => {
    winLoaded = true;
    pushWindowState();
    flushCommands();
  });

  // Stay on the app page: links open in the browser, everything else is dropped.
  wc.on('will-navigate', (e, url) => {
    if (url === RENDERER_URL) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });
  wc.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('render-process-gone', (_e, details) => log('renderer gone:', details.reason, details.exitCode));
  wc.on('preload-error', (_e, file, err) => log('preload error in', file, err));

  w.loadFile(RENDERER_HTML);
  if (!app.isPackaged && process.argv.includes('--dev')) wc.openDevTools({ mode: 'detach' });
  return w;
}

// ---------------------------------------------------------------------------------------
// Scanner process manager. One utilityProcess per scan; a new scan or cancel kills it.

let scanSeq = 0; // last scanId handed out
let reqSeq = 0; // request ids (global, unique across processes)
let startSeq = 0; // bumps on every start/cancel so a superseded scan:start doesn't fork
let current = null; // the live scanner record, or null

const ZERO_STATS = { files: 0, dirs: 0, bytes: 0, errors: 0, elapsed: 0 };
const num = (v) => (Number.isFinite(v) ? v : 0);
const pickStats = (m) => ({
  files: num(m.files),
  dirs: num(m.dirs),
  bytes: num(m.bytes),
  errors: num(m.errors),
  elapsed: num(m.elapsed),
});

function resolvePending(s) {
  for (const { resolve } of s.pending.values()) resolve(null);
  s.pending.clear();
}

function post(s, msg) {
  if (!s.alive) return false;
  if (!s.spawned) {
    s.queue.push(msg);
    return true;
  }
  try {
    s.child.postMessage(msg);
    return true;
  } catch (err) {
    log(`scanner ${s.id}: postMessage failed:`, err.message);
    return false;
  }
}

function killScanner() {
  const s = current;
  current = null;
  if (!s) return;
  if (s.alive) {
    s.alive = false;
    try {
      s.child.kill();
    } catch {
      // already gone
    }
  }
  resolvePending(s);
}

function onScannerMessage(s, msg) {
  if (!s.alive || !msg || typeof msg !== 'object') return; // killed processes are ignored
  switch (msg.type) {
    case 'progress': {
      s.stats = pickStats(msg);
      s.events.emit('progress', s.stats);
      send('scan:progress', { scanId: s.id, ...s.stats });
      break;
    }
    case 'done': {
      s.done = true;
      s.stats = pickStats(msg);
      s.events.emit('done', s.stats);
      send('scan:done', { scanId: s.id, ...s.stats });
      break;
    }
    case 'reply': {
      const req = s.pending.get(msg.id);
      if (!req) return;
      s.pending.delete(msg.id);
      if (msg.error != null) {
        log(`scanner ${s.id}: ${req.type} ${req.key || ''} failed: ${msg.error}`);
        req.resolve(null);
      } else {
        req.resolve(msg.result === undefined ? null : msg.result);
      }
      break;
    }
    default:
      break;
  }
}

function onScannerExit(s, code) {
  if (!s.alive) return; // we killed it
  s.alive = false;
  log(`scanner ${s.id} exited unexpectedly (code ${code})${s.done ? ' after the scan finished' : ''}`);
  resolvePending(s);
  if (current === s) current = null;
  if (!s.done) {
    // Give the renderer a terminal event so it doesn't wait forever.
    send('scan:done', { scanId: s.id, ...(s.stats || ZERO_STATS), error: 'scanner-exited' });
  }
  s.events.emit('exit', code);
}

function startScanner({ root, name, exclude }) {
  killScanner();
  const id = ++scanSeq;
  const child = utilityProcess.fork(WORKER, [], {
    serviceName: 'Tessera Scanner',
    env: { ...process.env, UV_THREADPOOL_SIZE: '32' },
    stdio: 'inherit',
  });
  const s = {
    id,
    child,
    root,
    name,
    alive: true,
    spawned: false,
    queue: [],
    pending: new Map(),
    done: false,
    stats: null,
    events: new EventEmitter(),
  };
  current = s;

  child.on('spawn', () => {
    if (!s.alive) return;
    s.spawned = true;
    const queued = s.queue.splice(0);
    for (const m of queued) post(s, m);
  });
  child.on('message', (msg) => onScannerMessage(s, msg));
  child.on('exit', (code) => onScannerExit(s, code));
  child.on('error', (type, location) => log(`scanner ${s.id} fatal error: ${type} at ${location}`));

  post(s, { type: 'scan', root, name, exclude });
  return s;
}

// reqId → promise. Resolves null when there's no scanner, it's killed, or it exits.
function request(type, fields, s = current) {
  if (!s || !s.alive) return Promise.resolve(null);
  const id = ++reqSeq;
  return new Promise((resolve) => {
    s.pending.set(id, { resolve, type, key: fields.key });
    if (!post(s, { type, id, ...fields })) {
      s.pending.delete(id);
      resolve(null);
    }
  });
}

class ScanError extends Error {}

function resolveScanRoot(input) {
  if (typeof input !== 'string' || !input.trim()) throw new ScanError('not-a-folder');
  let p = input.trim().replace(/^~(?=\/|$)/, os.homedir());
  p = path.resolve(p);
  try {
    p = fs.realpathSync(p); // "/Volumes/Macintosh HD" → "/", "/tmp" → "/private/tmp"
    if (!fs.statSync(p).isDirectory()) throw new Error('file');
  } catch {
    throw new ScanError('not-a-folder');
  }
  return p;
}

// Validates, builds the exclusion list, forks. Returns the scanner record.
async function beginScan(rawPath, rawName) {
  const root = resolveScanRoot(rawPath); // an invalid path leaves the current scan alone
  const name = (typeof rawName === 'string' && rawName.trim()) || locations.displayName(root);
  if (!fs.existsSync(WORKER)) {
    log('scanner worker not found at', WORKER);
    throw new ScanError('scanner-missing');
  }
  const token = ++startSeq;
  killScanner(); // stop the old scan right away; the new one forks once exclusions are ready
  const exclude = await locations.buildExclusions(root);
  if (token !== startSeq) throw new ScanError('cancelled'); // another start/cancel came in
  return startScanner({ root, name, exclude });
}

// ---------------------------------------------------------------------------------------
// Items (keys → paths via the scanner)

async function itemPath(key, s = current) {
  if (typeof key !== 'string' || !ITEM_KEY.test(key)) return null;
  const p = await request('path', { key }, s);
  return typeof p === 'string' && p ? p : null;
}

function itemName(p, s) {
  if (s && p === s.root) return s.name;
  return path.basename(p) || p;
}

async function revealItem(key) {
  const p = await itemPath(key);
  if (p) shell.showItemInFolder(p);
}

async function openItem(key) {
  const p = await itemPath(key);
  if (!p) return;
  const err = await shell.openPath(p);
  if (err) log('open failed:', p, err);
}

async function quickLookItem(key) {
  const s = current;
  const p = await itemPath(key, s);
  if (p && win && !win.isDestroyed()) win.previewFile(p, itemName(p, s));
}

async function copyItemPath(key) {
  const p = await itemPath(key);
  if (p) clipboard.writeText(p);
}

// Size for the confirmation text when the caller didn't supply one.
async function sizeOfItem(key, p, s) {
  if (key.startsWith('f')) {
    try {
      return fs.lstatSync(p).blocks * 512;
    } catch {
      return 0;
    }
  }
  const v = await request('view', { key, depth: 1, minFrac: 1, maxChildren: 1 }, s);
  return v && Number.isFinite(v.s) ? v.s : 0;
}

let trashBusy = false;

// meta (optional, from the context menu) = { name, size }
async function trashItem(key, meta) {
  const s = current;
  if (trashBusy || !s || typeof key !== 'string' || !ITEM_KEY.test(key) || key === 'd0') {
    return { trashed: false };
  }
  trashBusy = true;
  try {
    const p = await itemPath(key, s);
    if (!p || p === '/' || p === s.root) return { trashed: false };
    const name = (meta && typeof meta.name === 'string' && meta.name) || itemName(p, s);
    const size = meta && Number.isFinite(meta.size) && meta.size >= 0 ? meta.size : await sizeOfItem(key, p, s);

    const box = {
      type: 'warning',
      message: t('trashMessage', { name }),
      detail: t('trashDetail', { size: formatBytes(size) }),
      buttons: [t('moveToTrash'), t('cancel')],
      defaultId: 0,
      cancelId: 1,
    };
    const parent = win && !win.isDestroyed() ? win : null;
    const { response } = parent ? await dialog.showMessageBox(parent, box) : await dialog.showMessageBox(box);
    if (response !== 0) return { trashed: false };

    try {
      await shell.trashItem(p);
    } catch (err) {
      log('trash failed:', p, err.message);
      const fail = {
        type: 'warning',
        message: t('trashFailed', { name }),
        detail: err.message,
        buttons: [t('ok')],
      };
      if (parent && !parent.isDestroyed()) dialog.showMessageBox(parent, fail);
      else dialog.showMessageBox(fail);
      return { trashed: false };
    }

    const removed = await request('remove', { key }, s);
    const freed = removed && Number.isFinite(removed.freed) ? removed.freed : size;
    // Keys are only meaningful within their scan; don't apply a stale key to a newer scan.
    if (current === s) send('item:removed', { key, freed, scanId: s.id });
    return { trashed: true, freed };
  } finally {
    trashBusy = false;
  }
}

function showContextMenu(event, raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.key !== 'string' || !ANY_KEY.test(raw.key)) return;
  const item = {
    key: raw.key,
    name: typeof raw.name === 'string' ? raw.name : '',
    isDir: !!raw.isDir,
    isPkg: !!raw.isPkg,
    size: Number(raw.size),
  };
  const meta = { name: item.name, size: item.size };
  const menu = buildContextMenu(item, {
    zoomInto: (key) => command({ cmd: 'zoom-into', key }),
    open: (key) => openItem(key),
    quickLook: (key) => quickLookItem(key),
    reveal: (key) => revealItem(key),
    copyPath: (key) => copyItemPath(key),
    trash: (key) => trashItem(key, meta).catch((err) => log('trash error:', err)),
  });
  const w = BrowserWindow.fromWebContents(event.sender) || win;
  menu.popup(w ? { window: w } : {});
}

// ---------------------------------------------------------------------------------------
// Accent color

function accentColor() {
  try {
    const c = systemPreferences.getAccentColor(); // "RRGGBBAA"
    if (/^[0-9a-f]{6}/i.test(c)) return `#${c.slice(0, 6).toLowerCase()}`;
  } catch {
    // fall through
  }
  return '#007aff';
}

const pushAccent = () => send('app:accent-changed', accentColor());

// ---------------------------------------------------------------------------------------
// IPC

const finite = (v, fallback) => (Number.isFinite(v) ? v : fallback);

ipcMain.handle('locations:get', () => locations.getLocations({ homeName: t('homeName') }));

ipcMain.handle('dialog:choose-folder', async (e) => {
  const parent = BrowserWindow.fromWebContents(e.sender);
  const opts = {
    title: t('openPanelTitle'),
    message: t('openPanelTitle'), // macOS shows `message` in the panel; `title` alone isn't visible
    buttonLabel: t('openPanelButton'),
    defaultPath: os.homedir(),
    properties: ['openDirectory'],
  };
  const r = parent ? await dialog.showOpenDialog(parent, opts) : await dialog.showOpenDialog(opts);
  if (r.canceled || !r.filePaths || !r.filePaths.length) return null;
  const p = r.filePaths[0];
  return { path: p, name: locations.displayName(p) };
});

// Errors come back as { error } and the preload turns them into a rejection with
// exactly that message (ipcMain.handle would otherwise wrap the message).
ipcMain.handle('scan:start', async (_e, opts) => {
  const o = typeof opts === 'string' ? { path: opts } : opts || {};
  try {
    const s = await beginScan(o.path, o.name);
    return { scanId: s.id, path: s.root, name: s.name };
  } catch (err) {
    if (!(err instanceof ScanError)) log('scan:start failed:', err);
    return { error: err instanceof ScanError ? err.message : 'scan-failed' };
  }
});

ipcMain.handle('scan:cancel', () => {
  startSeq++;
  killScanner();
});

ipcMain.handle('scan:view', async (_e, opts) => {
  const s = current;
  if (!s) return null;
  const o = opts || {};
  const key = o.key === undefined || o.key === null ? 'd0' : o.key;
  if (typeof key !== 'string' || !ANY_KEY.test(key)) return null;
  const view = await request(
    'view',
    {
      key,
      depth: finite(o.depth, 3),
      minFrac: finite(o.minFrac, 0.00008),
      maxChildren: finite(o.maxChildren, 300),
    },
    s,
  );
  if (view && typeof view === 'object') view.scanId = s.id;
  return view;
});

ipcMain.handle('item:reveal', (_e, key) => revealItem(key));
ipcMain.handle('item:open', (_e, key) => openItem(key));
ipcMain.handle('item:quicklook', (_e, key) => quickLookItem(key));
ipcMain.handle('item:copy-path', (_e, key) => copyItemPath(key));
ipcMain.handle('item:trash', (_e, key) => trashItem(key));
ipcMain.on('item:context-menu', (e, item) => showContextMenu(e, item));

ipcMain.handle('app:full-disk-access', () =>
  shell.openExternal('x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles'),
);
ipcMain.handle('app:accent-color', () => accentColor());
ipcMain.handle('app:get-language', () => i18n.getLanguage());
ipcMain.handle('app:set-language', (_e, lang) => changeLanguage(lang));

ipcMain.handle('dev:capture', async (e, rawName) => {
  if (!DEV.shotDir) return null;
  const base =
    String(rawName || 'shot')
      .replace(/\.png$/i, '')
      .replace(/[^\w.-]+/g, '_')
      .replace(/^\.+/, '')
      .slice(0, 120) || 'shot';
  const image = await e.sender.capturePage();
  await fs.promises.mkdir(DEV.shotDir, { recursive: true });
  const file = path.join(DEV.shotDir, `${base}.png`);
  await fs.promises.writeFile(file, image.toPNG());
  return file;
});

// Dev: record every painted frame as a JPEG (TESSERA_RECORD_DIR), for README/demo videos.
// 'start' begins a take; 'stop' ends it and writes frames.json with each frame's timestamp.
let recording = null;
ipcMain.handle('dev:record', async (e, cmd) => {
  if (!DEV.recordDir) return null;
  const wc = e.sender;
  if (cmd === 'start' && !recording) {
    await fs.promises.mkdir(DEV.recordDir, { recursive: true });
    const take = { frames: [], writes: [], t0: performance.now() };
    recording = take;
    wc.beginFrameSubscription(false, (image) => {
      const t = (performance.now() - take.t0) / 1000;
      const file = path.join(DEV.recordDir, `f${String(take.frames.length).padStart(5, '0')}.jpg`);
      take.frames.push({ file: path.basename(file), t });
      // 1600 px wide keeps the encode short enough to follow a 60 fps compositor.
      const frame = image.getSize().width > 1600 ? image.resize({ width: 1600, quality: 'better' }) : image;
      take.writes.push(fs.promises.writeFile(file, frame.toJPEG(90)));
    });
    return true;
  }
  if (cmd === 'stop' && recording) {
    const take = recording;
    recording = null;
    wc.endFrameSubscription();
    await Promise.all(take.writes);
    const end = (performance.now() - take.t0) / 1000;
    await fs.promises.writeFile(path.join(DEV.recordDir, 'frames.json'), JSON.stringify({ end, frames: take.frames }));
    return take.frames.length;
  }
  return null;
});

// ---------------------------------------------------------------------------------------
// Selftest: scan, print JSON, quit. No window.

async function runSelftest(target) {
  const started = Date.now();
  const finish = (code, text) => {
    killScanner();
    const stream = code === 0 ? process.stdout : process.stderr;
    stream.write(`${text}\n`, () => app.exit(code));
  };
  const timer = setTimeout(() => finish(2, '[tessera] selftest timed out'), 15 * 60 * 1000);

  let s;
  try {
    s = await beginScan(target);
  } catch (err) {
    clearTimeout(timer);
    finish(1, `[tessera] selftest failed: ${err.message}`);
    return;
  }
  const outcome = await new Promise((resolve) => {
    s.events.once('done', (stats) => resolve({ stats }));
    s.events.once('exit', (code) => resolve({ exitCode: code }));
  });
  if (!outcome.stats) {
    clearTimeout(timer);
    finish(1, `[tessera] selftest failed: scanner exited (code ${outcome.exitCode}) before finishing`);
    return;
  }
  const view = await request('view', { key: 'd0', depth: 1, minFrac: 0, maxChildren: 10 }, s);
  clearTimeout(timer);
  if (!view) {
    finish(1, '[tessera] selftest failed: view request returned null');
    return;
  }
  const { stats } = outcome;
  const out = {
    path: s.root,
    name: s.name,
    files: stats.files,
    dirs: stats.dirs,
    bytes: stats.bytes,
    errors: stats.errors,
    elapsed: stats.elapsed,
    wallMs: Date.now() - started,
    size: formatBytes(stats.bytes),
    root: { k: view.k, n: view.n, s: view.s, t: view.t, c: view.c, scanning: view.scanning },
    kinds: Object.fromEntries(KIND_IDS.map((id, i) => [id, Array.isArray(view.kinds) ? view.kinds[i] : null])),
    top: (Array.isArray(view.ch) ? view.ch : [])
      .filter((c) => !c.a)
      .slice(0, 10)
      .map((c) => ({
        k: c.k,
        n: c.n,
        s: c.s,
        size: formatBytes(c.s),
        kind: KIND_IDS[c.t] ?? c.t,
        ...(c.d ? { d: 1 } : {}),
        ...(c.p ? { p: 1 } : {}),
        ...(c.c !== undefined ? { c: c.c } : {}),
      })),
  };
  finish(0, JSON.stringify(out, null, 2));
}

// ---------------------------------------------------------------------------------------
// App lifecycle

// Folder dropped on the Dock icon (may arrive before `ready`).
app.on('open-file', (e, filePath) => {
  e.preventDefault();
  if (DEV.selftest) return;
  command({ cmd: 'scan-path', path: filePath });
});

app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
});

applyAboutPanel();

app.whenReady().then(() => {
  // Tessera has one appearance: dark. Forcing it also darkens the vibrancy material,
  // menus, context menus and sheets, whatever the system setting.
  nativeTheme.themeSource = 'dark';
  if (DEV.selftest) {
    if (app.dock) app.dock.hide();
    runSelftest(DEV.selftest).catch((err) => {
      process.stderr.write(`[tessera] selftest crashed: ${err && err.stack}\n`, () => app.exit(1));
    });
    return;
  }

  if (!app.isPackaged && app.dock && fs.existsSync(DEV_ICON)) {
    try {
      app.dock.setIcon(DEV_ICON);
    } catch (err) {
      log('dock icon:', err.message);
    }
  }

  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) =>
    cb(permission === 'clipboard-sanitized-write'),
  );

  menuReady = true;
  refreshAppMenu();

  nativeTheme.on('updated', pushAccent);
  try {
    systemPreferences.subscribeNotification('AppleColorPreferencesChangedNotification', () =>
      setTimeout(pushAccent, 50),
    );
  } catch {
    // not fatal
  }

  createWindow();

  app.on('activate', () => {
    if (!win || win.isDestroyed()) createWindow();
  });
});

// Single-window utility: closing the window quits.
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => killScanner());
