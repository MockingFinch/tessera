// The treemap engine: layout, motion and drawing on a single <canvas>.
//
// Every drawn tile is an Item whose geometry, opacity and color are critically damped
// springs, solved analytically each frame (stable at any frame rate, no overshoot).
// A new view never "cuts": each tile's start and end are derived so the whole scene
// moves like one camera.
//   • tiles that persist morph from where they are to where they belong;
//   • new tiles are born inside their nearest surviving ancestor (so children grow out
//     of the folder you opened), or — when zooming out — outside the viewport, exactly
//     where the camera says they were;
//   • departing tiles ride the same camera move outward and fade.

import { squarify } from './squarify.js';
import { tileColor, kindHex, hexToRgb, KIND_OTHER } from './kinds.js';
import { formatBytes, formatCount } from './format.js';
import { t } from './i18n.js';

const X = 0, Y = 1, W = 2, H = 3, O = 4, R = 5, G = 6, B = 7, A = 8;
const CHANNELS = 9;
const EPS = [0.01, 0.01, 0.01, 0.01, 0.001, 0.2, 0.2, 0.2, 0.001];

// Spring "response" in seconds per kind of change (Apple-style: time to settle, no bounce).
const RESPONSE = {
  initial: 0.9,
  update: 0.62,
  zoom: 0.56,
  resize: 0.22,
  remove: 0.5,
};

const MAX_DEPTH = 4;
// The canvas overhangs the layout area by this much on every side, so the selection
// ring and halo of a tile touching the edge are drawn in full rather than clipped.
const BLEED = 8;
const GAP = [0, 3, 2, 1.5, 1.25, 1];
const RADIUS = [0, 7, 5, 3.5, 2.5, 2];
const HEADER = [0, 24, 19, 17, 16, 15];
const PAD = [0, 3, 2.5, 2, 1.5, 1.5];

const FONT_STACK = 'system-ui, -apple-system, "SF Pro Text", sans-serif';

// Drawing tokens for the dark window material (Tessera is dark only).
const PAL = {
  container: [255, 255, 255, 0.055],
  aggregateAlpha: 0.15,
  mosaicAlpha: 0.42,
  badge: 'rgba(30, 30, 32, 0.82)',
  text: 'rgba(255, 255, 255, 0.88)',
  textSecondary: 'rgba(255, 255, 255, 0.46)',
  rim: 'rgba(255, 255, 255, 0.1)',
  hoverLeaf: [255, 255, 255, 0.16],
  hoverContainer: [255, 255, 255, 0.05],
  ringHalo: 'rgba(28, 28, 30, 0.9)',
};

class Item {
  constructor(key) {
    this.key = key;
    this.cur = new Float64Array(CHANNELS);
    this.vel = new Float64Array(CHANNELS);
    this.tgt = new Float64Array(CHANNELS);
    this.omega = 10;
    this.delay = 0;
    this.fadeHold = 0; // seconds opacity waits before moving (hand-off timing)
    this.settled = false;
    this.exiting = false;
    this.hover = 0;
    this.hoverT = 0;
    this.dim = 0;
    this.dimT = 0;
    this.node = null;
    this.parentKey = null;
    this.depth = 0;
    this.rank = 0;
    this.mode = 'leaf'; // 'root' | 'container' | 'leaf' | 'aggregate'
    this.header = 0;
    this.kind = KIND_OTHER;
  }
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const ramp = (v, from, to) => clamp01((v - from) / (to - from));

function mapRect(r, from, to) {
  // Affine map taking rect `from` onto rect `to`, applied to `r`.
  if (from[2] < 1e-6 || from[3] < 1e-6) return null;
  const sx = to[2] / from[2];
  const sy = to[3] / from[3];
  return [to[0] + (r[0] - from[0]) * sx, to[1] + (r[1] - from[1]) * sy, r[2] * sx, r[3] * sy];
}

function scaleAround(r, s) {
  const cx = r[0] + r[2] / 2;
  const cy = r[1] + r[3] / 2;
  return [cx - (r[2] * s) / 2, cy - (r[3] * s) / 2, r[2] * s, r[3] * s];
}

function iou(a, b) {
  const ix = Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]);
  const iy = Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]);
  if (ix <= 0 || iy <= 0) return 0;
  const inter = ix * iy;
  return inter / (a[2] * a[3] + b[2] * b[3] - inter);
}

// On a zoom, a tile whose new place no longer overlaps where the camera would carry it
// by at least this much doesn't slide there across its neighbours; it hands off instead.
const HANDOFF_IOU = 0.5;

function sameRect(a, b) {
  return Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) + Math.abs(a[3] - b[3]) < 2;
}

export class Treemap {
  constructor(canvas, callbacks = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.cb = callbacks;
    this.items = new Map();
    this.order = [];
    this.view = null;
    this.rootKey = null;
    this.width = 0;
    this.height = 0;
    this.dpr = window.devicePixelRatio || 1;
    this.accent = '#0a84ff';
    this.reducedMotion = false;
    this.hovered = null;
    this.selectedKey = null;
    this.ring = { alpha: 0, target: 0 };
    this.highlight = null;
    this.pointer = null;
    this.raf = 0;
    this.lastTime = 0;
    this.textWidths = new Map();
    this.patterns = new Map();
    this.kids = new Map();
    this.topLevel = [];
    this.treeDirty = true;
    this.pinch = { acc: 0, until: 0 };

    this.frame = this.frame.bind(this);
    this.bindEvents();
  }

  // ───────────────────────────── public API ─────────────────────────────

  setAccent(hex) {
    this.accent = hex;
    this.kick();
  }

  setReducedMotion(on) {
    this.reducedMotion = on;
  }

  // Labels are drawn on the canvas, so a language change only needs a repaint.
  relabel() {
    this.textWidths.clear();
    this.kick();
  }

  resize(width, height, dpr) {
    const changed = width !== this.width || height !== this.height || dpr !== this.dpr;
    if (!changed) return;
    this.width = width;
    this.height = height;
    this.dpr = dpr;
    this.canvas.width = Math.round((width + BLEED * 2) * dpr);
    this.canvas.height = Math.round((height + BLEED * 2) * dpr);
    this.canvas.style.width = `${width + BLEED * 2}px`;
    this.canvas.style.height = `${height + BLEED * 2}px`;
    this.canvas.style.left = `${-BLEED}px`;
    this.canvas.style.top = `${-BLEED}px`;
    if (this.view) this.setData(this.view, { transition: this.items.size ? 'resize' : 'initial' });
    else this.draw();
  }

  get minFrac() {
    const area = Math.max(1, this.width * this.height);
    return 56 / area;
  }

  // transition: 'initial' | 'update' | 'zoom' | 'resize' | 'remove'
  setData(view, { transition = 'update' } = {}) {
    this.view = view;
    const targets = this.layout(view);
    this.apply(targets, view.k, transition);
    this.rootKey = view.k;
    if (this.selectedKey && !this.items.has(this.selectedKey)) this.select(null);
    this.refreshHover();
    this.kick();
  }

  clear() {
    this.view = null;
    this.rootKey = null;
    this.items.clear();
    this.order = [];
    this.treeDirty = true;
    this.hovered = null;
    this.selectedKey = null;
    this.draw();
  }

  highlightKind(kind) {
    this.highlight = kind;
    for (const it of this.items.values()) this.updateDim(it);
    this.kick();
  }

  select(key) {
    if (key === this.selectedKey) return;
    this.selectedKey = key;
    this.ring.target = key ? 1 : 0;
    if (key) this.ring.alpha = Math.min(this.ring.alpha, 0.2);
    this.cb.onSelect?.(key ? this.items.get(key) : null);
    this.kick();
  }

  get selected() {
    return this.selectedKey ? this.items.get(this.selectedKey) || null : null;
  }

  item(key) {
    return this.items.get(key) || null;
  }

  // ───────────────────────────── layout ─────────────────────────────

  layout(view) {
    const targets = new Map();
    const pal = PAL;
    const root = {
      key: view.k,
      parentKey: null,
      depth: 0,
      rank: 0,
      node: view,
      mode: 'root',
      header: 0,
      kind: view.t ?? KIND_OTHER,
      rect: [0, 0, this.width, this.height],
      color: [pal.container[0], pal.container[1], pal.container[2], 0],
      opacity: 0,
    };
    targets.set(view.k, root);
    if (view.ch && this.width > 0 && this.height > 0) {
      this.layoutChildren(view, [0, 0, this.width, this.height], 1, view.k, targets, -1);
    }
    return targets;
  }

  layoutChildren(node, rect, depth, parentKey, targets, rank) {
    const kids = [];
    for (const c of node.ch) if (c.s > 0) kids.push(c);
    if (!kids.length) return;
    const g = GAP[Math.min(depth, GAP.length - 1)];
    const rects = squarify(
      kids.map((c) => c.s),
      rect[0] - g / 2,
      rect[1] - g / 2,
      rect[2] + g,
      rect[3] + g,
    );
    for (let i = 0; i < kids.length; i++) {
      const r = rects[i];
      const w = r[2] - g;
      const h = r[3] - g;
      if (w < 0.75 || h < 0.75) continue;
      this.place(kids[i], [r[0] + g / 2, r[1] + g / 2, w, h], depth, parentKey, targets, rank < 0 ? i : rank);
    }
  }

  place(c, rect, depth, parentKey, targets, rank) {
    const pal = PAL;
    const expandable = c.d && !c.p && c.ch && c.ch.length > 0 && depth < MAX_DEPTH;
    const [, , w, h] = rect;
    let mode = c.a ? 'aggregate' : 'leaf';
    let header = 0;
    if (expandable) {
      const hh = HEADER[depth];
      if (w >= 72 && h >= hh + 30) {
        mode = 'container';
        header = hh;
      } else if (w >= 30 && h >= 30) {
        mode = 'container';
      }
    }
    const kind = c.t ?? KIND_OTHER;
    let color;
    if (mode === 'container') color = pal.container;
    else if (mode === 'aggregate') {
      const rgb = hexToRgb(kindHex(kind));
      color = [rgb[0], rgb[1], rgb[2], pal.aggregateAlpha];
    } else {
      const rgb = tileColor(kind, c.k);
      color = [rgb[0], rgb[1], rgb[2], 1];
    }
    targets.set(c.k, { key: c.k, parentKey, depth, rank, node: c, mode, header, kind, rect, color, opacity: 1 });

    if (mode === 'container') {
      const pad = PAD[depth];
      const inner = header
        ? [rect[0] + pad, rect[1] + header, w - pad * 2, h - header - pad]
        : [rect[0] + pad, rect[1] + pad, w - pad * 2, h - pad * 2];
      if (inner[2] > 2 && inner[3] > 2) this.layoutChildren(c, inner, depth + 1, c.k, targets, rank);
    }
  }

  // ───────────────────────────── transitions ─────────────────────────────

  apply(targets, newRoot, transition) {
    const items = this.items;
    const response = RESPONSE[transition] * (this.reducedMotion ? 0.45 : 1);
    const omega = (2 * Math.PI) / response;
    const curRect = (it) => [it.cur[X], it.cur[Y], it.cur[W], it.cur[H]];

    // The camera anchor: a tile present before and after a zoom, whose motion defines
    // the move for everything that has no surviving ancestor.
    let anchorFrom = null;
    let anchorTo = null;
    let zoomingOut = false;
    if (transition === 'zoom') {
      const oldRoot = this.rootKey;
      const incoming = items.get(newRoot);
      if (incoming && !incoming.exiting && targets.has(newRoot)) {
        anchorFrom = curRect(incoming);
        anchorTo = targets.get(newRoot).rect;
      } else if (oldRoot && items.has(oldRoot) && targets.has(oldRoot)) {
        anchorFrom = curRect(items.get(oldRoot));
        anchorTo = targets.get(oldRoot).rect;
        zoomingOut = true;
      }
    }

    // 0 · hand-offs. A zoom re-lays the folder out for a new shape, so some tiles land
    // far from where the camera alone would take them; sliding them there drags them
    // through their neighbours. Those tiles hand off instead: the old one rides the
    // camera as a ghost and fades, a fresh one fades in already in place. The swap
    // happens while the tiles are small: at once when zooming in, late when zooming out.
    const handedOff = transition === 'zoom' && anchorFrom ? this.handOff(targets, anchorFrom, anchorTo) : null;
    const hold = zoomingOut ? response * 0.3 : 0;

    // 1 · departing tiles (decided against the scene as it was).
    for (const it of items.values()) {
      if (targets.has(it.key)) continue;
      if (it.exiting) continue;
      it.exiting = true;
      const cur = curRect(it);
      let to = null;
      let pk = it.parentKey;
      while (pk && !to) {
        const anc = items.get(pk);
        if (!anc) break;
        if (targets.has(pk) && !anc.exiting) to = mapRect(cur, curRect(anc), targets.get(pk).rect);
        pk = anc.parentKey;
      }
      if (!to && anchorFrom) to = mapRect(cur, anchorFrom, anchorTo);
      if (!to || sameRect(to, cur)) to = scaleAround(cur, transition === 'zoom' ? 0.9 : 0.4);
      it.tgt[X] = to[0];
      it.tgt[Y] = to[1];
      it.tgt[W] = to[2];
      it.tgt[H] = to[3];
      it.tgt[O] = 0;
      it.omega = omega;
      it.delay = 0;
      it.fadeHold = it.ghost ? hold : 0;
      it.settled = false;
      it.hoverT = 0;
    }

    // 2 · persisting and arriving tiles, parents before children.
    let index = 0;
    for (const spec of targets.values()) {
      let it = items.get(spec.key);
      const isNew = !it;
      if (isNew) {
        it = new Item(spec.key);
        let from = null;
        let pk = spec.parentKey;
        while (pk && !from) {
          const anc = items.get(pk);
          const ancSpec = targets.get(pk);
          if (!ancSpec) break;
          if (anc && !anc.exiting) from = mapRect(spec.rect, ancSpec.rect, curRect(anc));
          pk = ancSpec.parentKey;
        }
        if (!from && anchorFrom) from = mapRect(spec.rect, anchorTo, anchorFrom);
        if (!from) from = scaleAround(spec.rect, transition === 'initial' ? 0.86 : 0.92);
        it.cur[X] = from[0];
        it.cur[Y] = from[1];
        it.cur[W] = from[2];
        it.cur[H] = from[3];
        it.cur[O] = 0;
        it.cur[R] = spec.color[0];
        it.cur[G] = spec.color[1];
        it.cur[B] = spec.color[2];
        it.cur[A] = spec.color[3];
        if (transition === 'initial' && !this.reducedMotion && spec.depth > 0) {
          it.delay = Math.min(0.5, spec.rank * 0.028 + (spec.depth - 1) * 0.07);
        }
        // A hand-off's fresh tile (and anything new inside it) fades in with its ghost.
        if (handedOff && (handedOff.has(spec.key) || items.get(spec.parentKey)?.fadeHold > 0)) it.fadeHold = hold;
        items.set(spec.key, it);
      } else if (transition !== 'resize') {
        it.delay = 0;
        it.fadeHold = 0;
      }
      it.exiting = false;
      it.node = spec.node;
      it.parentKey = spec.parentKey;
      it.depth = spec.depth;
      it.rank = spec.rank;
      it.mode = spec.mode;
      it.header = spec.header;
      it.kind = spec.kind;
      it.index = index++;
      it.tgt[X] = spec.rect[0];
      it.tgt[Y] = spec.rect[1];
      it.tgt[W] = spec.rect[2];
      it.tgt[H] = spec.rect[3];
      it.tgt[O] = spec.opacity;
      it.tgt[R] = spec.color[0];
      it.tgt[G] = spec.color[1];
      it.tgt[B] = spec.color[2];
      it.tgt[A] = spec.color[3];
      it.omega = omega;
      it.settled = false;
      this.updateDim(it);
      if (isNew) it.dim = it.dimT;
    }

    this.sortOrder();
  }

  // Decide which persisting tiles hand off (see apply) and turn their current selves
  // into ghosts under new keys, so the real keys are free for the fresh tiles.
  handOff(targets, anchorFrom, anchorTo) {
    const items = this.items;
    const curRect = (it) => [it.cur[X], it.cur[Y], it.cur[W], it.cur[H]];
    const persisting = [];
    for (const it of items.values()) {
      const spec = targets.get(it.key);
      if (!it.exiting && spec && spec.mode !== 'root') persisting.push(it);
    }
    persisting.sort((a, b) => a.depth - b.depth);

    const handed = new Set();
    for (const it of persisting) {
      // Where the camera, or the nearest ancestor that stays put, would carry this tile.
      let carried = null;
      let inherited = false;
      let pk = it.parentKey;
      while (pk) {
        if (handed.has(pk)) {
          inherited = true; // inside a tile that hands off: hand off with it
          break;
        }
        const anc = items.get(pk);
        if (!anc) break;
        const ancSpec = targets.get(pk);
        if (ancSpec && !anc.exiting) {
          carried = mapRect(curRect(it), curRect(anc), ancSpec.rect);
          break;
        }
        pk = anc.parentKey;
      }
      if (!inherited && !carried) carried = mapRect(curRect(it), anchorFrom, anchorTo);
      if (inherited || (carried && iou(carried, targets.get(it.key).rect) < HANDOFF_IOU)) handed.add(it.key);
    }
    if (!handed.size) return handed;

    this.ghostSeq = (this.ghostSeq || 0) + 1;
    const renamed = new Map();
    for (const key of handed) {
      const it = items.get(key);
      items.delete(key);
      it.key = `${key}~${this.ghostSeq}`;
      it.ghost = true;
      items.set(it.key, it);
      renamed.set(key, it.key);
    }
    for (const it of items.values()) {
      const pk = renamed.get(it.parentKey);
      if (pk) it.parentKey = pk;
    }
    return handed;
  }

  sortOrder() {
    this.order = [...this.items.values()].sort((a, b) => a.depth - b.depth || (a.exiting - b.exiting) || (a.index ?? 0) - (b.index ?? 0));
    this.treeDirty = true;
  }

  updateDim(it) {
    const h = this.highlight;
    it.dimT = h !== null && h !== undefined && it.mode !== 'root' && it.mode !== 'container' && it.kind !== h ? 1 : 0;
  }

  // ───────────────────────────── animation loop ─────────────────────────────

  kick() {
    if (this.raf) return;
    this.lastTime = performance.now();
    this.raf = requestAnimationFrame(this.frame);
  }

  frame(now) {
    this.raf = 0;
    const dt = Math.min(0.05, Math.max(0.001, (now - this.lastTime) / 1000));
    this.lastTime = now;
    const active = this.step(dt);
    this.draw();
    if (active) this.raf = requestAnimationFrame(this.frame);
    else this.refreshHover(); // the scene settled under a resting pointer
  }

  step(dt) {
    let active = false;
    let removed = false;
    const hoverK = 1 - Math.exp(-dt * 22);
    const dimK = 1 - Math.exp(-dt * 14);

    for (const it of this.items.values()) {
      if (it.delay > 0) {
        it.delay -= dt;
        active = true;
      } else if (!it.settled) {
        // Opacity runs on a quicker spring than geometry: tiles commit to being there
        // (or gone) early, and the eye follows shape, not a cross-fade.
        const wGeo = it.omega;
        const wFade = it.omega * 2.4;
        const eGeo = Math.exp(-wGeo * dt);
        const eFade = Math.exp(-wFade * dt);
        let moving = false;
        const holdFade = it.fadeHold > 0;
        if (holdFade) {
          it.fadeHold -= dt;
          moving = true;
        }
        const cur = it.cur, vel = it.vel, tgt = it.tgt;
        for (let c = 0; c < CHANNELS; c++) {
          if (c === O && holdFade) continue;
          const d = cur[c] - tgt[c];
          const v = vel[c];
          if (d < EPS[c] && d > -EPS[c] && v < EPS[c] * 4 && v > -EPS[c] * 4) {
            cur[c] = tgt[c];
            vel[c] = 0;
            continue;
          }
          const w = c === O ? wFade : wGeo;
          const e = c === O ? eFade : eGeo;
          const c2 = v + w * d;
          const decay = (d + c2 * dt) * e;
          cur[c] = tgt[c] + decay;
          vel[c] = (c2 - w * (d + c2 * dt)) * e;
          moving = true;
        }
        it.settled = !moving;
        if (moving) active = true;
      }

      const dh = it.hoverT - it.hover;
      if (dh > 0.002 || dh < -0.002) {
        it.hover += dh * hoverK;
        active = true;
      } else it.hover = it.hoverT;

      const dd = it.dimT - it.dim;
      if (dd > 0.002 || dd < -0.002) {
        it.dim += dd * dimK;
        active = true;
      } else it.dim = it.dimT;

      if (it.exiting && (it.cur[O] < 0.004 || it.settled)) {
        this.items.delete(it.key);
        removed = true;
      }
    }

    const ring = this.ring;
    const dr = ring.target - ring.alpha;
    if (dr > 0.002 || dr < -0.002) {
      ring.alpha += dr * (1 - Math.exp(-dt * 16));
      active = true;
    } else ring.alpha = ring.target;

    if (removed) {
      this.order = this.order.filter((it) => this.items.has(it.key));
      this.treeDirty = true;
      if (this.hovered && !this.items.has(this.hovered.key)) this.setHovered(this.pointer ? this.hitTest(this.pointer[0], this.pointer[1]) : null);
    }
    return active;
  }

  // ───────────────────────────── drawing ─────────────────────────────

  draw() {
    const ctx = this.ctx;
    const dpr = this.dpr;
    ctx.setTransform(dpr, 0, 0, dpr, BLEED * dpr, BLEED * dpr);
    ctx.clearRect(-BLEED, -BLEED, this.width + BLEED * 2, this.height + BLEED * 2);
    if (!this.order.length) return;
    if (this.treeDirty) this.buildTree();

    const pal = PAL;
    this.font = '';
    // Tree order, each subtree clipped to its parent: siblings' contents never
    // interleave, and children can't stray outside their folder mid-flight.
    for (const it of this.topLevel) this.drawItem(ctx, it, pal);
    ctx.globalAlpha = 1;
    this.drawSelection(ctx, pal);
  }

  buildTree() {
    this.kids = new Map();
    this.topLevel = [];
    for (const it of this.order) {
      const parent = it.parentKey ? this.items.get(it.parentKey) : null;
      if (parent) {
        let list = this.kids.get(parent.key);
        if (!list) this.kids.set(parent.key, (list = []));
        list.push(it);
      } else this.topLevel.push(it);
    }
    this.treeDirty = false;
  }

  // Labels step aside while a tile is in flight and settle back in when it lands.
  motionFade(it) {
    if (it.settled) return 1;
    const v = it.vel;
    const speed = Math.abs(v[X]) + Math.abs(v[Y]) + Math.abs(v[W]) + Math.abs(v[H]);
    return 1 - ramp(speed, 120, 700);
  }

  drawItem(ctx, it, pal) {
    const dpr = this.dpr;
    const kids = this.kids.get(it.key);
    const x = Math.round(it.cur[X] * dpr) / dpr;
    const y = Math.round(it.cur[Y] * dpr) / dpr;
    const w = Math.round((it.cur[X] + it.cur[W]) * dpr) / dpr - x;
    const h = Math.round((it.cur[Y] + it.cur[H]) * dpr) / dpr - y;
    const isRoot = it.mode === 'root';
    if (!isRoot && (w < 0.5 || h < 0.5 || x > this.width || y > this.height || x + w < 0 || y + h < 0)) return;

    const depth = Math.max(1, Math.min(it.depth, RADIUS.length - 1));
    const radius = Math.min(RADIUS[depth], w / 3, h / 3);
    const alpha = it.cur[O] * (1 - 0.82 * it.dim);
    const r = it.cur[R], g = it.cur[G], b = it.cur[B], a = it.cur[A];

    if (alpha >= 0.004 && w >= 0.5 && h >= 0.5) {
      ctx.globalAlpha = alpha;
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, radius);
      if (it.mode === 'leaf') {
        this.fillLeaf(ctx, x, y, w, h, r, g, b, a);
        if (w > 9 && h > 9) {
          ctx.strokeStyle = pal.rim;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, Math.max(0, radius - 0.5));
          ctx.stroke();
        }
        if (it.hover > 0.003) {
          const hc = pal.hoverLeaf;
          ctx.fillStyle = `rgba(${hc[0]},${hc[1]},${hc[2]},${hc[3] * it.hover})`;
          ctx.beginPath();
          ctx.roundRect(x, y, w, h, radius);
          ctx.fill();
        }
        this.drawLeafLabel(ctx, it, x, y, w, h, alpha * this.motionFade(it), r, g, b);
      } else if (it.mode === 'aggregate') {
        ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${a})`;
        ctx.fill();
        if (w > 5 && h > 5) {
          const pattern = this.mosaicPattern(it.kind);
          pattern.setTransform(new DOMMatrix([1 / dpr, 0, 0, 1 / dpr, x, y]));
          ctx.fillStyle = pattern;
          ctx.fill();
        }
        if (it.hover > 0.003) {
          const hc = pal.hoverLeaf;
          ctx.fillStyle = `rgba(${hc[0]},${hc[1]},${hc[2]},${hc[3] * it.hover * 0.7})`;
          ctx.fill();
        }
        this.drawAggregateLabel(ctx, it, x, y, w, h, alpha * this.motionFade(it), pal);
      } else {
        // containers, and a root that is still fading out after a zoom
        ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${a})`;
        ctx.fill();
        if (it.hover > 0.003 && !isRoot) {
          const hc = pal.hoverContainer;
          ctx.fillStyle = `rgba(${hc[0]},${hc[1]},${hc[2]},${hc[3] * it.hover})`;
          ctx.fill();
        }
        if (it.header && !isRoot) this.drawHeader(ctx, it, x, y, w, h, alpha * this.motionFade(it), pal);
      }
    }

    if (!kids || !kids.length) return;
    if (isRoot) {
      for (const k of kids) this.drawItem(ctx, k, pal);
      return;
    }
    ctx.save();
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, radius);
    ctx.clip();
    for (const k of kids) this.drawItem(ctx, k, pal);
    ctx.restore();
    this.font = ''; // restore() rewinds ctx.font too
  }

  fillLeaf(ctx, x, y, w, h, r, g, b, a) {
    if (w < 14 || h < 14) {
      ctx.fillStyle = `rgba(${r | 0},${g | 0},${b | 0},${a})`;
      ctx.fill();
      return;
    }
    // A whisper of light from above, so tiles read as objects rather than paint.
    const lift = 0.07, sink = 0.05;
    const grad = ctx.createLinearGradient(0, y, 0, y + Math.min(h, 420));
    grad.addColorStop(0, `rgba(${(r + (255 - r) * lift) | 0},${(g + (255 - g) * lift) | 0},${(b + (255 - b) * lift) | 0},${a})`);
    grad.addColorStop(1, `rgba(${(r * (1 - sink)) | 0},${(g * (1 - sink)) | 0},${(b * (1 - sink)) | 0},${a})`);
    ctx.fillStyle = grad;
    ctx.fill();
  }

  setFont(ctx, font) {
    if (this.font !== font) {
      ctx.font = font;
      this.font = font;
    }
  }

  measure(ctx, font, text) {
    let table = this.textWidths.get(font);
    if (!table) {
      table = new Map();
      this.textWidths.set(font, table);
    }
    let w = table.get(text);
    if (w === undefined) {
      this.setFont(ctx, font);
      w = ctx.measureText(text).width;
      if (table.size > 6000) table.clear();
      table.set(text, w);
    }
    return w;
  }

  fit(ctx, font, text, maxWidth) {
    if (maxWidth <= 0) return '';
    if (this.measure(ctx, font, text) <= maxWidth) return text;
    const ell = '…';
    let lo = 0, hi = text.length;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.measure(ctx, font, text.slice(0, mid) + ell) <= maxWidth) lo = mid;
      else hi = mid - 1;
    }
    return lo < 2 ? '' : text.slice(0, lo).trimEnd() + ell;
  }

  drawLeafLabel(ctx, it, x, y, w, h, alpha, r, g, b) {
    const top = it.depth <= 1;
    const pad = top ? 8 : 6;
    const minW = top ? 40 : 34;
    const minH = top ? 22 : 18;
    if (w < minW || h < minH) return;
    const fade = alpha * ramp(w, minW, minW + 18) * ramp(h, minH, minH + 8);
    if (fade < 0.02) return;

    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    const light = lum > 0.6;
    const nameFont = `600 ${top ? 12 : 11}px ${FONT_STACK}`;
    const name = this.fit(ctx, nameFont, it.node.n || '', w - pad * 2);
    if (!name) return;

    ctx.globalAlpha = fade;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    this.setFont(ctx, nameFont);
    ctx.fillStyle = light ? 'rgba(0,0,0,0.8)' : 'rgba(255,255,255,0.97)';
    ctx.fillText(name, x + pad, y + pad - 1);

    const lineH = top ? 16 : 14;
    if (h >= pad * 2 + lineH + 12 && w >= 46) {
      const sizeFont = `500 ${top ? 11 : 10}px ${FONT_STACK}`;
      const size = this.fit(ctx, sizeFont, formatBytes(it.node.s), w - pad * 2);
      this.setFont(ctx, sizeFont);
      ctx.globalAlpha = fade * ramp(h, pad * 2 + lineH + 12, pad * 2 + lineH + 20);
      ctx.fillStyle = light ? 'rgba(0,0,0,0.56)' : 'rgba(255,255,255,0.74)';
      ctx.fillText(size, x + pad, y + pad - 1 + lineH);
    }
    ctx.globalAlpha = 1;
  }

  drawAggregateLabel(ctx, it, x, y, w, h, alpha, pal) {
    if (w < 48 || h < 24) return;
    const fade = alpha * ramp(w, 48, 64) * ramp(h, 24, 32);
    if (fade < 0.02) return;
    const font = `500 ${it.depth <= 1 ? 11 : 10}px ${FONT_STACK}`;
    const count = it.node.c || 0;
    const label = count ? t('aggCount', { n: formatCount(count) }) : t('smallerItems');
    const tw = this.measure(ctx, font, label);
    if (tw + 16 > w - 6) return; // never truncate a count
    const bh = it.depth <= 1 ? 18 : 16;
    ctx.globalAlpha = fade;
    ctx.fillStyle = pal.badge;
    ctx.beginPath();
    ctx.roundRect(x + 5, y + 5, tw + 12, bh, bh / 2);
    ctx.fill();
    this.setFont(ctx, font);
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    ctx.fillStyle = pal.textSecondary;
    ctx.fillText(label, x + 11, y + 5 + bh / 2 + 0.5);
    ctx.globalAlpha = 1;
  }

  drawHeader(ctx, it, x, y, w, h, alpha, pal) {
    if (w < 44) return;
    const hh = it.header;
    const fade = alpha * ramp(w, 44, 64) * ramp(h, hh + 14, hh + 30);
    if (fade < 0.02) return;
    const top = it.depth <= 1;
    const pad = top ? 8 : 6;
    const nameFont = `600 ${top ? 12 : 11}px ${FONT_STACK}`;
    const sizeFont = `500 ${top ? 11 : 10}px ${FONT_STACK}`;
    const sizeText = formatBytes(it.node.s);
    const sizeW = this.measure(ctx, sizeFont, sizeText);
    const roomForSize = w - pad * 2 - sizeW - 10;
    const nameFull = it.node.n || '';
    const nameW = this.measure(ctx, nameFont, nameFull);
    const showSize = roomForSize >= Math.min(nameW, 48);
    const name = this.fit(ctx, nameFont, nameFull, showSize ? roomForSize : w - pad * 2);
    const cy = y + hh / 2 + 0.5;

    ctx.globalAlpha = fade;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'left';
    if (name) {
      this.setFont(ctx, nameFont);
      ctx.fillStyle = pal.text;
      ctx.fillText(name, x + pad, cy);
    }
    if (showSize) {
      this.setFont(ctx, sizeFont);
      ctx.fillStyle = pal.textSecondary;
      ctx.textAlign = 'right';
      ctx.fillText(sizeText, x + w - pad, cy);
      ctx.textAlign = 'left';
    }
    ctx.globalAlpha = 1;
  }

  // "Too small to show" is drawn as a fine mosaic in the colour of what it holds —
  // many tiny tesserae — so a folder of 2,000 thumbnails still reads as photos.
  mosaicPattern(kind) {
    const key = `${kind}|${this.dpr}`;
    let pattern = this.patterns.get(key);
    if (pattern) return pattern;
    const dpr = this.dpr;
    const size = Math.round(6 * dpr);
    const tile = document.createElement('canvas');
    tile.width = size;
    tile.height = size;
    const c = tile.getContext('2d');
    const [r, g, b] = hexToRgb(kindHex(kind));
    c.fillStyle = `rgba(${r},${g},${b},${PAL.mosaicAlpha})`;
    c.beginPath();
    c.roundRect(0.8 * dpr, 0.8 * dpr, size - 1.6 * dpr, size - 1.6 * dpr, 1.3 * dpr);
    c.fill();
    pattern = this.ctx.createPattern(tile, 'repeat');
    this.patterns.set(key, pattern);
    return pattern;
  }

  drawSelection(ctx, pal) {
    const dpr = this.dpr;
    const snap = (v) => Math.round(v * dpr) / dpr;
    const it = this.selectedKey ? this.items.get(this.selectedKey) : null;
    if (!it || this.ring.alpha < 0.01 || it.mode === 'root') return;
    const x = snap(it.cur[X]), y = snap(it.cur[Y]);
    const w = snap(it.cur[X] + it.cur[W]) - x, h = snap(it.cur[Y] + it.cur[H]) - y;
    if (w < 1 || h < 1) return;
    const depth = Math.max(1, Math.min(it.depth, RADIUS.length - 1));
    const radius = Math.min(RADIUS[depth], w / 3, h / 3);
    ctx.globalAlpha = this.ring.alpha * it.cur[O];
    ctx.lineWidth = 4;
    ctx.strokeStyle = pal.ringHalo;
    ctx.beginPath();
    ctx.roundRect(x - 1, y - 1, w + 2, h + 2, radius + 1);
    ctx.stroke();
    ctx.lineWidth = 2;
    ctx.strokeStyle = this.accent;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }

  // ───────────────────────────── interaction ─────────────────────────────

  hitTest(px, py) {
    for (let i = this.order.length - 1; i >= 0; i--) {
      const it = this.order[i];
      if (it.exiting || it.mode === 'root' || it.cur[O] < 0.5) continue;
      if (px >= it.cur[X] && py >= it.cur[Y] && px < it.cur[X] + it.cur[W] && py < it.cur[Y] + it.cur[H]) return it;
    }
    return null;
  }

  setHovered(it) {
    if (it === this.hovered) return;
    if (this.hovered) this.markChain(this.hovered, 0);
    this.hovered = it;
    if (it) this.markChain(it, 1);
    this.cb.onHover?.(it);
    this.kick();
  }

  markChain(it, on) {
    it.hoverT = on;
    let pk = it.parentKey;
    let level = 0;
    while (pk) {
      const anc = this.items.get(pk);
      if (!anc) break;
      if (anc.mode === 'container') anc.hoverT = on ? (level === 0 ? 0.55 : 0.25) : 0;
      pk = anc.parentKey;
      level++;
    }
  }

  refreshHover() {
    if (!this.pointer) return;
    const hit = this.hitTest(this.pointer[0], this.pointer[1]);
    if (hit !== this.hovered) this.setHovered(hit);
    else if (hit) this.markChain(hit, 1);
  }

  localPoint(e) {
    const rect = this.canvas.getBoundingClientRect();
    return [e.clientX - rect.left - BLEED, e.clientY - rect.top - BLEED];
  }

  bindEvents() {
    const c = this.canvas;
    c.addEventListener('pointermove', (e) => {
      this.pointer = this.localPoint(e);
      this.setHovered(this.hitTest(this.pointer[0], this.pointer[1]));
    });
    c.addEventListener('pointerleave', () => {
      this.pointer = null;
      this.setHovered(null);
    });
    c.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const [px, py] = this.localPoint(e);
      const hit = this.hitTest(px, py);
      this.select(hit ? hit.key : null);
    });
    c.addEventListener('dblclick', (e) => {
      const [px, py] = this.localPoint(e);
      const hit = this.hitTest(px, py);
      if (hit) this.cb.onOpen?.(hit);
    });
    c.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const [px, py] = this.localPoint(e);
      const hit = this.hitTest(px, py);
      if (!hit) return;
      this.select(hit.key);
      this.cb.onContextMenu?.(hit, e);
    });
    c.addEventListener(
      'wheel',
      (e) => {
        if (!e.ctrlKey) return; // trackpad pinch arrives as ctrl+wheel
        e.preventDefault();
        const now = performance.now();
        if (now < this.pinch.until) return;
        this.pinch.acc += e.deltaY;
        if (this.pinch.acc < -28 || this.pinch.acc > 28) {
          const dir = this.pinch.acc < 0 ? 'in' : 'out';
          this.pinch.acc = 0;
          this.pinch.until = now + 520;
          this.cb.onPinch?.(dir, this.hovered);
        }
      },
      { passive: false },
    );
  }
}
