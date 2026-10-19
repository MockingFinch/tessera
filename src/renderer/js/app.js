// Tessera renderer: wires the treemap, the chrome and the main-process API together.

import { Treemap } from './treemap.js';
import { kindHex, kindLabel } from './kinds.js';
import { t, setLang, onLangChange, translateDocument } from './i18n.js';
import { formatBytes, formatCount, formatItems, formatPercent } from './format.js';
import { renderMark, renderLocations, playWelcome, CRUMB_ICONS } from './welcome.js';

// Data comes from the mock (js/mock.js) in a plain browser, and in Electron when main runs
// with TESSERA_DEMO=1; the demo keeps the real window, language and dev hooks.
const realApi = window.tessera;
const demo = !!realApi?.dev?.demo;
const isMock = !realApi || demo;
let api = realApi;
if (isMock) {
  const { createMockApi } = await import('./mock.js');
  const mock = createMockApi({ errors: demo ? 0 : 3 });
  if (realApi) {
    const keep = ['dev', 'getLanguage', 'setLanguage', 'onLanguage', 'onWindowState', 'getAccentColor', 'onAccentColor', 'onCommand'];
    api = { ...mock, ...Object.fromEntries(keep.map((k) => [k, realApi[k]])) };
  } else {
    document.documentElement.classList.add('no-vibrancy');
    window.tessera = api = mock;
  }
}

const $ = (id) => document.getElementById(id);
const app = $('app');
const welcome = $('welcome');
const stage = $('stage');
const crumbsEl = $('crumbs');
const statusEl = $('status');
const readoutEl = $('readout');
const legendEl = $('legend');
const toastEl = $('toast');
const messageEl = $('stage-message');
const backBtn = $('back');

const VIEW_DEPTH = 4;
const MAX_CHILDREN = 260;
// Live updates arrive in calm breaths: each one settles before the next lands.
const POLL_MS = 950;

const state = {
  screen: 'welcome',
  locations: [],
  scan: null, // { scanId, path, name, kind, scanning, files, bytes, errors }
  focus: null,
  view: null,
  pendingTransition: null,
  seq: 0,
  appliedSeq: 0,
  inFlight: 0,
  pollTimer: 0,
  lockedKind: null,
  hasTiles: false,
  returnSelect: null,
};

function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

// ───────────────────────────── theme & system ─────────────────────────────

const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');

const treemap = new Treemap($('map'), {
  onHover: (item) => renderReadout(item),
  onSelect: () => renderReadout(treemap.hovered),
  onOpen: (item) => openItem(item),
  onContextMenu: (item) => showContextMenu(item),
  onPinch: (dir, item) => (dir === 'in' ? pinchInto(item) : goUp()),
});
treemap.setReducedMotion(motionQuery.matches);
motionQuery.addEventListener('change', () => treemap.setReducedMotion(motionQuery.matches));

function setAccent(hex) {
  if (!hex) return;
  document.documentElement.style.setProperty('--accent', hex);
  treemap.setAccent(hex);
}
api.getAccentColor?.().then(setAccent).catch(() => {});
api.onAccentColor?.(setAccent);

api.onWindowState?.(({ fullscreen, focused }) => {
  app.classList.toggle('fullscreen', !!fullscreen);
  document.body.classList.toggle('inactive', focused === false);
});

// Views are pruned for the canvas they were fetched for (minFrac). Once a resize settles
// and the folder would show noticeably more or less detail, fetch it again. While a scan
// runs, polling already does this.
let resizeTimer = 0;
new ResizeObserver(([entry]) => {
  const { width, height } = entry.contentRect;
  treemap.resize(Math.floor(width), Math.floor(height), window.devicePixelRatio || 1);
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!state.scan || state.scan.scanning || !state.view || !state.viewMinFrac) return;
    const ratio = treemap.minFrac / state.viewMinFrac;
    if (ratio < 0.8 || ratio > 1.25) fetchView(state.focus, 'update');
  }, 220);
}).observe(stage);

function watchPixelRatio() {
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
    'change',
    () => {
      treemap.resize(treemap.width, treemap.height, window.devicePixelRatio || 1);
      watchPixelRatio();
    },
    { once: true },
  );
}
watchPixelRatio();

// ───────────────────────────── screens ─────────────────────────────

function setScreen(screen) {
  state.screen = screen;
  app.dataset.screen = screen;
}

async function loadLocations() {
  try {
    state.locations = await api.getLocations();
  } catch {
    state.locations = [];
  }
  renderLocations($('location-list'), state.locations, pickLocation);
}

async function showWelcome() {
  stopPolling();
  if (state.scan) api.cancelScan?.();
  state.scan = null;
  state.view = null;
  state.focus = null;
  setScreen('welcome');
  await loadLocations();
  playWelcome(welcome);
  setTimeout(() => state.screen === 'welcome' && treemap.clear(), 500);
}

async function pickLocation(loc) {
  if (loc.kind === 'choose') return chooseFolder();
  startScan(loc);
}

async function chooseFolder() {
  const picked = await api.chooseFolder();
  if (picked) startScan({ ...picked, kind: 'folder' });
}

// ───────────────────────────── scanning ─────────────────────────────

const counter = { files: 0, bytes: 0, targetFiles: 0, targetBytes: 0, raf: 0 };

async function startScan(loc) {
  let res;
  try {
    res = await api.startScan({ path: loc.path, name: loc.name });
  } catch (err) {
    const msg = String(err?.message || err);
    if (msg.includes('cancelled')) return; // superseded by a newer start, or by Locations
    toast(msg.includes('not-a-folder') ? t('onlyFolders') : t('cantOpen'));
    return;
  }
  const kind = loc.kind && loc.kind !== 'choose' ? loc.kind : inferKind(res.path);
  state.scan = { ...res, kind, scanning: true, files: 0, bytes: 0, errors: 0 };
  state.focus = 'd0';
  state.view = null;
  state.hasTiles = false;
  state.pendingTransition = null;
  state.lockedKind = null;
  state.appliedSeq = state.seq;
  counter.files = counter.bytes = counter.targetFiles = counter.targetBytes = 0;
  treemap.clear();
  treemap.highlightKind(null);
  renderCrumbs([{ k: 'd0', n: res.name }]);
  renderStatus();
  renderLegend();
  renderReadout(null);
  setMessage('');
  setScreen('explorer');
  startPolling();
}

function inferKind(path) {
  if (path === '/') return 'disk';
  const home = state.locations.find((l) => l.kind === 'home');
  if (home && path === home.path) return 'home';
  if (/^\/Volumes\/[^/]+$/.test(path)) return 'external';
  return 'folder';
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (state.inFlight === 0) fetchView();
  }, POLL_MS);
  fetchView();
}

function stopPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer = 0;
}

api.onProgress?.((p) => {
  if (!state.scan || p.scanId !== state.scan.scanId) return;
  Object.assign(state.scan, { files: p.files, bytes: p.bytes, errors: p.errors });
  counter.targetFiles = p.files;
  counter.targetBytes = p.bytes;
  tickCounter();
});

api.onScanDone?.((p) => {
  if (!state.scan || p.scanId !== state.scan.scanId) return;
  Object.assign(state.scan, { files: p.files, bytes: p.bytes, errors: p.errors, scanning: false, elapsed: p.elapsed });
  counter.targetFiles = counter.files = p.files;
  counter.targetBytes = counter.bytes = p.bytes;
  stopPolling();
  fetchView(state.focus, 'update');
  renderStatus();
  if (p.error) {
    state.scan.failed = true;
    toast(t('scanStopped'));
    if (!state.hasTiles) setMessage(t('stopped'));
  }
});

function tickCounter() {
  if (counter.raf) return;
  const step = () => {
    counter.raf = 0;
    const k = 0.18;
    counter.files += (counter.targetFiles - counter.files) * k;
    counter.bytes += (counter.targetBytes - counter.bytes) * k;
    if (Math.abs(counter.targetFiles - counter.files) < 1) counter.files = counter.targetFiles;
    if (Math.abs(counter.targetBytes - counter.bytes) < 1e5) counter.bytes = counter.targetBytes;
    renderStatus();
    if (counter.files !== counter.targetFiles || counter.bytes !== counter.targetBytes) counter.raf = requestAnimationFrame(step);
  };
  counter.raf = requestAnimationFrame(step);
}

// The stage can be measured before ResizeObserver has reported (e.g. a window that
// loads hidden); never ask the scanner for a view sized for a 0×0 canvas.
function ensureSize() {
  if (treemap.width > 0 && treemap.height > 0) return;
  const w = Math.floor(stage.clientWidth);
  const hgt = Math.floor(stage.clientHeight);
  if (w > 0 && hgt > 0) treemap.resize(w, hgt, window.devicePixelRatio || 1);
}

async function fetchView(key = state.focus, transition) {
  if (!state.scan || !key) return;
  ensureSize();
  const seq = ++state.seq;
  const scanId = state.scan.scanId;
  let minFrac = 0;
  state.inFlight++;
  let view = null;
  try {
    minFrac = treemap.minFrac;
    view = await api.getView({ key, depth: VIEW_DEPTH, minFrac, maxChildren: MAX_CHILDREN });
  } catch {
    view = null;
  } finally {
    state.inFlight--;
  }
  if (!view || !state.scan || state.scan.scanId !== scanId) return;
  if (key !== state.focus || seq < state.appliedSeq) return;
  // A trashed focus comes back as its nearest surviving ancestor.
  if (view.k !== key) state.focus = view.k;
  state.appliedSeq = seq;

  const hasTiles = !!view.ch?.some((c) => c.s > 0);
  let motion = state.pendingTransition || transition || (state.hasTiles ? 'update' : 'initial');
  if (motion === 'update' && !state.hasTiles) motion = 'initial';
  state.pendingTransition = null;
  state.hasTiles = hasTiles;
  state.view = view;
  state.viewMinFrac = minFrac;
  treemap.setData(view, { transition: motion });

  if (state.returnSelect) {
    if (treemap.item(state.returnSelect)) treemap.select(state.returnSelect);
    state.returnSelect = null;
  }
  renderCrumbs(view.crumbs || [{ k: view.k, n: view.n }]);
  renderStatus();
  renderLegend();
  renderReadout(treemap.hovered);
  if (!hasTiles) setMessage(state.scan.failed ? t('stopped') : state.scan.scanning ? t('looking') : t('empty'));
  else setMessage('');
}

// ───────────────────────────── navigation ─────────────────────────────

function zoomTo(key, { returnSelect = null } = {}) {
  if (!state.scan || !key || key === state.focus) return;
  state.focus = key;
  state.pendingTransition = 'zoom';
  state.returnSelect = returnSelect;
  treemap.select(null);
  fetchView(key, 'zoom');
}

function goUp() {
  const crumbs = state.view?.crumbs;
  if (!crumbs || crumbs.length < 2) return;
  zoomTo(crumbs[crumbs.length - 2].k, { returnSelect: state.focus });
}

function isOpenable(node) {
  return node && node.d && !node.p && !node.a;
}

function openItem(item) {
  if (!item || item.mode === 'root') return;
  const n = item.node;
  if (isOpenable(n)) zoomTo(item.key);
  else if (n.a) {
    if (item.parentKey && item.parentKey !== state.focus) zoomTo(item.parentKey);
  } else api.quickLook?.(item.key);
}

function pinchInto(item) {
  if (!item) return;
  // Dive one level: the child of the focus that contains the pointer.
  let it = item;
  while (it && it.parentKey && it.parentKey !== state.focus) it = treemap.item(it.parentKey);
  if (it && isOpenable(it.node)) zoomTo(it.key);
}

function quickLook() {
  const it = treemap.selected || treemap.hovered;
  if (it && it.mode !== 'root' && !it.node.a) api.quickLook?.(it.key);
}

function showContextMenu(item) {
  if (!item || item.mode === 'root' || item.node.a) return;
  const n = item.node;
  api.showContextMenu?.({ key: item.key, name: n.n, isDir: !!n.d, isPkg: !!n.p, size: n.s });
}

function moveSelection(dx, dy) {
  const current = treemap.selected;
  const candidates = treemap.order.filter(
    (it) => !it.exiting && it.mode !== 'root' && it.cur[4] > 0.5 && (current ? it.parentKey === current.parentKey : it.depth === 1),
  );
  if (!candidates.length) return;
  if (!current) {
    treemap.select(candidates[0].key);
    return;
  }
  const cx = current.cur[0] + current.cur[2] / 2;
  const cy = current.cur[1] + current.cur[3] / 2;
  let best = null;
  let bestScore = Infinity;
  for (const it of candidates) {
    if (it === current) continue;
    const ox = it.cur[0] + it.cur[2] / 2 - cx;
    const oy = it.cur[1] + it.cur[3] / 2 - cy;
    const along = ox * dx + oy * dy;
    if (along <= 1) continue;
    const across = Math.abs(ox * dy - oy * dx);
    const score = along + across * 2.2;
    if (score < bestScore) {
      bestScore = score;
      best = it;
    }
  }
  if (best) treemap.select(best.key);
}

// ───────────────────────────── chrome ─────────────────────────────

const chevron = `<svg class="crumb-sep" viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.75 7.75 6 4.5 9.25"/></svg>`;
let crumbKeys = [];

function renderCrumbs(crumbs) {
  const keys = crumbs.map((c) => c.k);
  const same = keys.length === crumbKeys.length && keys.every((k, i) => k === crumbKeys[i]);
  backBtn.disabled = crumbs.length < 2;
  if (same) return;

  let prefix = 0;
  while (prefix < keys.length && prefix < crumbKeys.length && keys[prefix] === crumbKeys[prefix]) prefix++;
  const nodes = [...crumbsEl.children];
  // Each crumb past the first owns [separator, button]; the first owns [button].
  const keep = prefix === 0 ? 0 : prefix * 2 - 1;
  nodes.slice(keep).forEach((n) => n.remove());

  const entering = [];
  crumbs.forEach((c, i) => {
    if (i < prefix) return;
    if (i > 0) {
      const sepWrap = document.createElement('span');
      sepWrap.innerHTML = chevron;
      const sep = sepWrap.firstElementChild;
      crumbsEl.append(sep);
      entering.push(sep);
    }
    const b = h('button', 'crumb');
    b.dataset.key = c.k;
    if (i === 0) {
      const icon = document.createElement('span');
      icon.innerHTML = CRUMB_ICONS[state.scan?.kind] || CRUMB_ICONS.folder;
      b.append(icon.firstElementChild);
    }
    b.append(h('span', null, c.n));
    b.title = c.n;
    b.addEventListener('click', () => {
      const idx = crumbKeys.indexOf(c.k);
      if (idx === -1 || idx === crumbKeys.length - 1) return;
      zoomTo(c.k, { returnSelect: crumbKeys[idx + 1] });
    });
    crumbsEl.append(b);
    if (crumbKeys.length) entering.push(b);
  });
  [...crumbsEl.querySelectorAll('.crumb')].forEach((b, i, all) => b.classList.toggle('current', i === all.length - 1));
  crumbKeys = keys;

  entering.forEach((n, i) => {
    n.classList.add('entering');
    n.style.transitionDelay = `${i * 28}ms`;
  });
  requestAnimationFrame(() =>
    requestAnimationFrame(() =>
      entering.forEach((n) => {
        n.classList.remove('entering');
        setTimeout(() => (n.style.transitionDelay = ''), 600);
      }),
    ),
  );
}

const statusParts = (() => {
  const spinner = h('span', 'spinner');
  const count = h('span', 'status-count');
  const dot = h('span', 'status-dot');
  const total = h('span', 'status-total');
  const warn = h('button', 'warn');
  warn.innerHTML = `<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.6 11 10.4H1Z"/><path d="M6 5v2.2"/><path d="M6 8.9v.01"/></svg>`;
  const warnLabel = h('span', null, t('limited'));
  warn.append(warnLabel);
  warn.title = t('limitedTip');
  warn.addEventListener('click', () => api.openFullDiskAccess?.());
  return { spinner, count, dot, total, warn, warnLabel, mode: '' };
})();

function renderStatus() {
  const s = state.scan;
  const p = statusParts;
  if (!s) {
    statusEl.replaceChildren();
    p.mode = '';
    return;
  }
  const mode = s.scanning ? 'scanning' : 'done';
  if (mode !== p.mode) {
    p.mode = mode;
    const parts = s.scanning ? [p.spinner, p.count, p.dot, p.total] : [p.count, p.dot, p.total];
    const limited = !s.scanning && s.errors > 0 && (s.kind === 'disk' || s.kind === 'home');
    if (limited) parts.unshift(p.warn);
    statusEl.replaceChildren(...parts);
  }
  if (s.scanning) {
    p.count.textContent = formatItems(counter.files);
    p.total.textContent = formatBytes(counter.bytes);
  } else {
    const v = state.view;
    p.count.textContent = formatItems(v?.c ?? s.files);
    p.total.textContent = formatBytes(v?.s ?? s.bytes);
  }
}

function setMessage(text) {
  if (text) messageEl.textContent = text;
  messageEl.classList.toggle('visible', !!text);
}

function readoutHint() {
  const hint = h('span', 'hint');
  hint.append(t('hintOpen'));
  hint.append(h('kbd', null, t('hintSpace')));
  hint.append(t('hintRest'));
  return hint;
}

let lastReadoutKey = null;
function renderReadout(item) {
  const it = item || treemap.selected;
  const key = it ? it.key : null;
  if (!it || it.mode === 'root') {
    if (lastReadoutKey !== '__hint') readoutEl.replaceChildren(readoutHint());
    lastReadoutKey = '__hint';
    return;
  }
  const n = it.node;
  const root = state.view;
  const swatch = h('span', 'swatch');
  let meta;
  if (n.a) {
    swatch.classList.add('aggregate');
    meta = t('tooSmall', { items: formatItems(n.c) });
  } else if (n.d && !n.p) {
    swatch.style.setProperty('--c', kindHex(n.t ?? 8));
    meta = `${t('folder')} · ${formatItems(n.c)}`;
  } else {
    swatch.style.setProperty('--c', kindHex(n.t ?? 8));
    meta = kindLabel(n.t ?? 8) + (n.p ? ` · ${t('package')}` : '');
  }
  if (root && root.s) meta += ` · ${t('shareOf', { pct: formatPercent(n.s, root.s), name: root.n })}`;
  const nodes = [swatch, h('span', 'name', n.a ? t('smallerItems') : n.n), h('span', 'size', formatBytes(n.s)), h('span', 'meta', meta)];
  readoutEl.replaceChildren(...nodes);
  if (key !== lastReadoutKey) {
    readoutEl.classList.remove('swap');
    void readoutEl.offsetWidth;
    readoutEl.classList.add('swap');
  }
  lastReadoutKey = key;
}

function renderKindReadout(kind) {
  const v = state.view;
  if (!v?.kinds) return;
  const bytes = v.kinds[kind] || 0;
  const total = v.kinds.reduce((a, b) => a + b, 0);
  const swatch = h('span', 'swatch');
  swatch.style.setProperty('--c', kindHex(kind));
  readoutEl.replaceChildren(
    swatch,
    h('span', 'name', kindLabel(kind)),
    h('span', 'size', formatBytes(bytes)),
    h('span', 'meta', t('shareOf', { pct: formatPercent(bytes, total), name: v.n })),
  );
  lastReadoutKey = `kind:${kind}`;
}

const chips = new Map();
function renderLegend() {
  const kinds = state.view?.kinds;
  if (!kinds) {
    legendEl.replaceChildren();
    chips.clear();
    return;
  }
  const total = kinds.reduce((a, b) => a + b, 0);
  const entries = kinds
    .map((bytes, kind) => ({ kind, bytes }))
    .filter((e) => total > 0 && e.bytes / total >= 0.004)
    .sort((a, b) => b.bytes - a.bytes);
  const ordered = entries.map(({ kind, bytes }) => {
    let chip = chips.get(kind);
    if (!chip) {
      chip = h('button', 'chip entering');
      chip.dataset.kind = String(kind);
      chip.append(h('span', 'swatch'), h('span', 'label'));
      chip.addEventListener('mouseenter', () => {
        legendEl.classList.add('dimming');
        treemap.highlightKind(kind);
        renderKindReadout(kind);
      });
      chip.addEventListener('mouseleave', () => {
        legendEl.classList.toggle('dimming', state.lockedKind !== null);
        treemap.highlightKind(state.lockedKind);
        lastReadoutKey = null;
        renderReadout(treemap.hovered);
      });
      chip.addEventListener('click', () => {
        state.lockedKind = state.lockedKind === kind ? null : kind;
        for (const [k, c] of chips) c.classList.toggle('active', k === state.lockedKind);
        treemap.highlightKind(state.lockedKind ?? kind);
      });
      chips.set(kind, chip);
      requestAnimationFrame(() => requestAnimationFrame(() => chip.classList.remove('entering')));
    }
    chip.querySelector('.swatch').style.setProperty('--c', kindHex(kind));
    chip.querySelector('.label').textContent = kindLabel(kind);
    chip.setAttribute('aria-label', `${kindLabel(kind)}, ${formatBytes(bytes)}`);
    return chip;
  });
  for (const [kind, chip] of chips) {
    if (!entries.some((e) => e.kind === kind)) {
      chip.remove();
      chips.delete(kind);
      if (state.lockedKind === kind) {
        state.lockedKind = null;
        treemap.highlightKind(null);
      }
    }
  }
  ordered.forEach((chip, i) => {
    if (legendEl.children[i] !== chip) legendEl.insertBefore(chip, legendEl.children[i] || null);
  });
}

let toastTimer = 0;
const TRASH_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.75 4.25h10.5"/><path d="M6.25 4.25V3a.75.75 0 0 1 .75-.75h2a.75.75 0 0 1 .75.75v1.25"/><path d="M4 4.25l.6 8.6a1 1 0 0 0 1 .9h4.8a1 1 0 0 0 1-.9l.6-8.6"/></svg>`;
function toast(text, { icon = '', muted = '' } = {}) {
  toastEl.innerHTML = icon;
  toastEl.append(h('span', null, text));
  if (muted) toastEl.append(h('span', 'muted', muted));
  toastEl.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('visible'), 3200);
}

// ───────────────────────────── events ─────────────────────────────

backBtn.addEventListener('click', goUp);
$('rescan').addEventListener('click', (e) => {
  const btn = e.currentTarget;
  btn.classList.remove('spinning');
  void btn.offsetWidth;
  btn.classList.add('spinning');
  rescan();
});
$('locations').addEventListener('click', showWelcome);

function rescan() {
  if (!state.scan) return;
  startScan({ path: state.scan.path, name: state.scan.name, kind: state.scan.kind });
}

api.onItemRemoved?.(({ key, freed }) => {
  const it = treemap.item(key);
  const name = it?.node?.n;
  toast(name ? t('trashedNamed', { name }) : t('trashed'), { icon: TRASH_ICON, muted: freed ? t('freed', { size: formatBytes(freed) }) : '' });
  if (treemap.selectedKey === key) treemap.select(null);
  fetchView(state.focus, 'remove');
});

api.onCommand?.(({ cmd, key, path }) => {
  switch (cmd) {
    case 'open-folder':
      return chooseFolder();
    case 'scan-home': {
      const home = state.locations.find((l) => l.kind === 'home');
      return home ? startScan(home) : loadLocations().then(() => {
        const h2 = state.locations.find((l) => l.kind === 'home');
        if (h2) startScan(h2);
      });
    }
    case 'rescan':
      return rescan();
    case 'show-locations':
      return showWelcome();
    case 'go-up':
      return goUp();
    case 'open-selection':
      return openItem(treemap.selected);
    case 'quick-look':
      return quickLook();
    case 'copy-path':
      if (treemap.selected && !treemap.selected.node.a) api.copyPath?.(treemap.selected.key).then(() => toast(t('pathCopied')));
      return;
    case 'trash-selection': {
      const it = treemap.selected;
      if (it && it.mode !== 'root' && !it.node.a) api.trash?.(it.key);
      return;
    }
    case 'zoom-into':
      return zoomTo(key);
    case 'scan-path':
      return startScan({ path });
  }
});

window.addEventListener('keydown', (e) => {
  if (state.screen !== 'explorer' || e.metaKey || e.ctrlKey || e.altKey) return;
  switch (e.key) {
    case ' ':
      e.preventDefault();
      quickLook();
      break;
    case 'Escape':
      if (treemap.selected) treemap.select(null);
      else goUp();
      break;
    case 'Enter':
      openItem(treemap.selected);
      break;
    case 'Backspace':
      goUp();
      break;
    case 'ArrowLeft':
      e.preventDefault();
      moveSelection(-1, 0);
      break;
    case 'ArrowRight':
      e.preventDefault();
      moveSelection(1, 0);
      break;
    case 'ArrowUp':
      e.preventDefault();
      moveSelection(0, -1);
      break;
    case 'ArrowDown':
      e.preventDefault();
      moveSelection(0, 1);
      break;
  }
});

// Drag & drop a folder anywhere.
let dragDepth = 0;
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
window.addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  dragDepth++;
  app.classList.add('dragging');
});
window.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'copy';
});
window.addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) app.classList.remove('dragging');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  app.classList.remove('dragging');
  const file = e.dataTransfer?.files?.[0];
  if (!file) return;
  const path = api.pathForFile?.(file);
  if (path) startScan({ path });
});

// ───────────────────────────── language ─────────────────────────────

onLangChange(() => {
  translateDocument();
  statusParts.warnLabel.textContent = t('limited');
  statusParts.warn.title = t('limitedTip');
  // Re-fetch rather than re-render: Home's display name comes from main, in main's language.
  loadLocations().then(() => {
    if (state.screen !== 'welcome') return;
    for (const el of welcome.querySelectorAll('.reveal')) el.style.animation = 'none';
    requestAnimationFrame(() => welcome.querySelectorAll('.reveal').forEach((el) => (el.style.animation = '')));
  });
  renderStatus();
  renderLegend();
  lastReadoutKey = null;
  renderReadout(treemap.hovered);
  if (state.scan?.failed && !state.hasTiles) setMessage(t('stopped'));
  else if (state.view && !state.hasTiles) setMessage(state.scan?.scanning ? t('looking') : t('empty'));
  treemap.relabel();
});
api.onLanguage?.((lang) => setLang(lang));
try {
  setLang((await api.getLanguage?.()) || 'en');
} catch {
  setLang('en');
}
translateDocument();

// ───────────────────────────── boot ─────────────────────────────

renderMark($('mark'));
await loadLocations();
playWelcome(welcome);

window.__tessera = { state, treemap, zoomTo, goUp, startScan, fetchView, showWelcome, setLang };

if ((api.dev?.shotDir || api.dev?.recording) && (!isMock || demo)) {
  const { runTour } = await import('./devtour.js');
  runTour(api, window.__tessera);
} else if (api.dev?.autoScan) {
  startScan({ path: api.dev.autoScan });
}
