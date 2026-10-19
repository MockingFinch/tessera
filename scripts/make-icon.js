// Renders the Tessera app icon.
//
//   npm run icon        (= electron scripts/make-icon.js)
//
// Draws the icon as SVG in an offscreen, transparent 1024x1024 BrowserWindow
// (devicePixelRatio 1), captures it to build/icon.png, downsamples it into
// build/icon.iconset with `sips`, packs build/icon.icns with `iconutil`, and
// writes build/mark.svg (the bare mosaic, for the in-app logomark).
//
// Geometry follows the macOS icon grid: 1024 canvas, 824x824 body centred
// (100 px margins), continuous-corner ("squircle") radius 185. The mosaic is
// the seven-tile layout from docs/SPEC.md "Visual identity".
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const BUILD = path.join(ROOT, 'build');

// ---------------------------------------------------------------------------
// Design constants
// ---------------------------------------------------------------------------

const CANVAS = 1024;
const BODY = { x: 100, y: 100, size: 824, radius: 185 };
const PAD = 88; // body edge -> outer tile edge
const GAP = 18; // between tiles
const TILE_RADIUS = 34;
// Small-size variant (see iconSvg): same body, mosaic with wider gaps.
const SMALL = { pad: 80, gap: 44, radius: 30 };

// From docs/SPEC.md. [x, y, w, h] in the unit square; each tile is inset by
// half the gap on every side.
const TILES = [
  { name: 'blue', color: '#2a78d6', r: [0.0, 0.0, 0.58, 0.62] },
  { name: 'violet', color: '#6250d6', r: [0.0, 0.62, 0.58, 0.38] },
  { name: 'orange', color: '#eb6834', r: [0.58, 0.0, 0.42, 0.36] },
  { name: 'aqua', color: '#1baf7a', r: [0.58, 0.36, 0.42, 0.26] },
  { name: 'magenta', color: '#e87ba4', r: [0.58, 0.62, 0.24, 0.38] },
  { name: 'yellow', color: '#eda100', r: [0.82, 0.62, 0.18, 0.22] },
  { name: 'green', color: '#2f9e44', r: [0.82, 0.84, 0.18, 0.16] },
];

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const f = (n) => +n.toFixed(3);

// Continuous-curvature rounded rectangle (the Apple-style "squircle" corner,
// as reverse-engineered from UIBezierPath by PaintCode). Each corner starts
// 1.5287 * r before the corner and blends curvature in gradually instead of
// jumping straight into a circular arc. Corner points are given as
// (s, t): s = distance back along the incoming edge, t = distance along the
// outgoing edge, both in units of r.
const K = 1.52866483;
const CORNER = [
  ['C', [1.08849323, 0], [0.86840689, 0], [0.66993427, 0.065496]],
  ['L', [0.63149399, 0.074911]],
  ['C', [0.37282392, 0.16905899], [0.16906013, 0.37282401], [0.074911, 0.63149399]],
  ['C', [0, 0.86840701], [0, 1.08849299], [0, K]],
];

function squircle(x, y, w, h, radius) {
  const r = Math.min(radius, Math.min(w, h) / 2 / K);
  const x1 = x + w;
  const y1 = y + h;
  // corner point, incoming direction, outgoing direction (clockwise)
  const corners = [
    [[x1, y], [1, 0], [0, 1]], // top-right
    [[x1, y1], [0, 1], [-1, 0]], // bottom-right
    [[x, y1], [-1, 0], [0, -1]], // bottom-left
    [[x, y], [0, -1], [1, 0]], // top-left
  ];
  let d = '';
  corners.forEach(([c, din, dout], i) => {
    const P = ([s, t]) => {
      const px = c[0] - s * r * din[0] + t * r * dout[0];
      const py = c[1] - s * r * din[1] + t * r * dout[1];
      return `${f(px)} ${f(py)}`;
    };
    d += (i === 0 ? 'M' : 'L') + P([K, 0]);
    for (const [cmd, ...pts] of CORNER) d += cmd + pts.map(P).join(' ');
  });
  return d + 'Z';
}

// Tile rects for a mosaic whose outer tile edges span [ox, ox + size].
function layoutTiles(ox, oy, size, gap, snap) {
  const S = size + gap; // unit square spans the gap-extended area
  const x0 = ox - gap / 2;
  const y0 = oy - gap / 2;
  const q = snap ? Math.round : (n) => n;
  return TILES.map((t) => {
    const [rx, ry, rw, rh] = t.r;
    const L = q(x0 + rx * S + gap / 2);
    const T = q(y0 + ry * S + gap / 2);
    const R = q(x0 + (rx + rw) * S - gap / 2);
    const B = q(y0 + (ry + rh) * S - gap / 2);
    return { ...t, x: L, y: T, w: R - L, h: B - T };
  });
}

// Radius per tile: the nominal radius, eased down for the tiny tiles so
// their continuous corners keep a visible straight edge.
function tileRadius(t, nominal) {
  return Math.min(nominal, 0.29 * Math.min(t.w, t.h));
}

// ---------------------------------------------------------------------------
// Colour helpers
// ---------------------------------------------------------------------------

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function rgbToHex(rgb) {
  return '#' + rgb.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('');
}
// Lighten/darken in HSL lightness, keeping hue and saturation so colours stay
// clean instead of washing out (white mix) or going muddy (black mix).
function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0, s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h /= 6;
  }
  return [h, s, l];
}
function hslToRgb([h, s, l]) {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p, q, t) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue(p, q, h + 1 / 3) * 255, hue(p, q, h) * 255, hue(p, q, h - 1 / 3) * 255];
}
function shade(hex, amount) {
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  const nl = amount >= 0 ? l + (1 - l) * amount : l * (1 + amount);
  return rgbToHex(hslToRgb([h, s, Math.max(0, Math.min(1, nl))]));
}

// ---------------------------------------------------------------------------
// SVG: app icon
// ---------------------------------------------------------------------------

// `small` is a variant for the 16 and 32 px renditions: wider gaps so the
// tiles stay separated once downsampled, and no inner shadow to muddy them.
function iconSvg({ small = false } = {}) {
  const { x: bx, y: by, size: bs, radius: br } = BODY;
  const pad = small ? SMALL.pad : PAD;
  const gap = small ? SMALL.gap : GAP;
  const body = squircle(bx, by, bs, bs, br);
  const inner = bs - 2 * pad;
  const tiles = layoutTiles(bx + pad, by + pad, inner, gap, true);

  const defs = [];
  const tileMarkup = [];

  tiles.forEach((t, i) => {
    const d = squircle(t.x, t.y, t.w, t.h, tileRadius(t, small ? SMALL.radius : TILE_RADIUS));
    const top = shade(t.color, 0.08);
    const bottom = shade(t.color, -0.06);
    defs.push(
      `<linearGradient id="fill${i}" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0" stop-color="${top}"/>` +
        `<stop offset="1" stop-color="${bottom}"/>` +
      `</linearGradient>`,
      // top rim highlight: bright along the top edge, gone ~22 px down
      `<linearGradient id="rim${i}" gradientUnits="userSpaceOnUse" x1="0" y1="${t.y}" x2="0" y2="${t.y + 22}">` +
        `<stop offset="0" stop-color="#fff" stop-opacity=".55"/>` +
        `<stop offset="1" stop-color="#fff" stop-opacity="0"/>` +
      `</linearGradient>`,
      `<clipPath id="clip${i}"><path d="${d}"/></clipPath>`
    );
    tileMarkup.push(
      `<g clip-path="url(#clip${i})">` +
        `<path d="${d}" fill="url(#fill${i})"${small ? '' : ' filter="url(#tileInner)"'}/>` +
        `<path d="${d}" fill="url(#gloss)"/>` +
        `<path d="${d}" fill="none" stroke="url(#rim${i})" stroke-width="3"/>` +
      `</g>`
    );
  });

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS}" height="${CANVAS}" viewBox="0 0 ${CANVAS} ${CANVAS}">
<defs>
  <linearGradient id="bodyFill" x1="0" y1="${by}" x2="0" y2="${by + bs}" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="#2b2e3b"/>
    <stop offset="1" stop-color="#121319"/>
  </linearGradient>
  <radialGradient id="bodyGlow" gradientUnits="userSpaceOnUse" cx="512" cy="${by}" r="560"
      gradientTransform="translate(0 ${by}) scale(1 .62) translate(0 ${-by})">
    <stop offset="0" stop-color="#fff" stop-opacity=".085"/>
    <stop offset=".55" stop-color="#fff" stop-opacity=".025"/>
    <stop offset="1" stop-color="#fff" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="bodyRim" gradientUnits="userSpaceOnUse" x1="0" y1="${by}" x2="0" y2="${by + bs}">
    <stop offset="0" stop-color="#fff" stop-opacity=".14"/>
    <stop offset=".22" stop-color="#fff" stop-opacity=".05"/>
    <stop offset=".6" stop-color="#fff" stop-opacity="0"/>
    <stop offset=".92" stop-color="#fff" stop-opacity=".015"/>
    <stop offset="1" stop-color="#fff" stop-opacity=".04"/>
  </linearGradient>
  <clipPath id="bodyClip"><path d="${body}"/></clipPath>
  <filter id="bodyShadow" filterUnits="userSpaceOnUse" x="0" y="0" width="${CANVAS}" height="${CANVAS}" color-interpolation-filters="sRGB">
    <feDropShadow dx="0" dy="12" stdDeviation="12" flood-color="#000" flood-opacity=".28"/>
  </filter>
  <filter id="tileShadow" filterUnits="userSpaceOnUse" x="0" y="0" width="${CANVAS}" height="${CANVAS}" color-interpolation-filters="sRGB">
    <feGaussianBlur in="SourceAlpha" stdDeviation="7" result="b1"/>
    <feOffset in="b1" dy="6" result="o1"/>
    <feFlood flood-color="#05060a" flood-opacity=".45"/>
    <feComposite in2="o1" operator="in" result="s1"/>
    <feGaussianBlur in="SourceAlpha" stdDeviation="1.2" result="b2"/>
    <feOffset in="b2" dy="1.5" result="o2"/>
    <feFlood flood-color="#000" flood-opacity=".35"/>
    <feComposite in2="o2" operator="in" result="s2"/>
    <feMerge><feMergeNode in="s1"/><feMergeNode in="s2"/><feMergeNode in="SourceGraphic"/></feMerge>
  </filter>
  <!-- very soft inner shadow, weighted to the bottom edge -->
  <filter id="tileInner" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB">
    <feGaussianBlur in="SourceAlpha" stdDeviation="9" result="blur"/>
    <feOffset in="blur" dy="-5" result="off"/>
    <feComposite in="SourceAlpha" in2="off" operator="out" result="edge"/>
    <feFlood flood-color="#000" flood-opacity=".17"/>
    <feComposite in2="edge" operator="in" result="shadow"/>
    <feMerge><feMergeNode in="SourceGraphic"/><feMergeNode in="shadow"/></feMerge>
  </filter>
  <linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#fff" stop-opacity=".10"/>
    <stop offset=".5" stop-color="#fff" stop-opacity=".02"/>
    <stop offset="1" stop-color="#fff" stop-opacity="0"/>
  </linearGradient>
  ${defs.join('\n  ')}
</defs>
<path d="${body}" fill="url(#bodyFill)" filter="url(#bodyShadow)"/>
<g clip-path="url(#bodyClip)">
  <rect x="${bx}" y="${by}" width="${bs}" height="${bs}" fill="url(#bodyGlow)"/>
  <g filter="url(#tileShadow)">
    ${tileMarkup.join('\n    ')}
  </g>
  <path d="${body}" fill="none" stroke="url(#bodyRim)" stroke-width="4"/>
</g>
</svg>`;
}

// ---------------------------------------------------------------------------
// SVG: bare logomark (0 0 100 100, transparent)
// ---------------------------------------------------------------------------

function markSvg() {
  const inner = BODY.size - 2 * PAD; // the icon's mosaic span, in px
  const k = 100 / inner;
  const gap = GAP * k;
  const radius = TILE_RADIUS * k;
  const tiles = layoutTiles(0, 0, 100, gap, false);
  const grads = [];
  const paths = [];
  tiles.forEach((t, i) => {
    grads.push(
      `<linearGradient id="t${i}" x1="0" y1="0" x2="0" y2="1">` +
        `<stop offset="0" stop-color="${shade(t.color, 0.08)}"/>` +
        `<stop offset="1" stop-color="${shade(t.color, -0.06)}"/>` +
      `</linearGradient>`
    );
    paths.push(`<path fill="url(#t${i})" d="${squircle(t.x, t.y, t.w, t.h, tileRadius(t, radius))}"/>`);
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <title>Tessera</title>
  <defs>
    ${grads.join('\n    ')}
  </defs>
  ${paths.join('\n  ')}
</svg>
`;
}

// ---------------------------------------------------------------------------
// Rendering + export
// ---------------------------------------------------------------------------

// [file, pixel size, use the small-size master]
const ICONSET = [
  ['icon_16x16.png', 16, true],
  ['icon_16x16@2x.png', 32, true],
  ['icon_32x32.png', 32, true],
  ['icon_32x32@2x.png', 64, false],
  ['icon_128x128.png', 128, false],
  ['icon_128x128@2x.png', 256, false],
  ['icon_256x256.png', 256, false],
  ['icon_256x256@2x.png', 512, false],
  ['icon_512x512.png', 512, false],
  ['icon_512x512@2x.png', 1024, false],
];

function writeIconset(png, smallPng) {
  const dir = path.join(BUILD, 'icon.iconset');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, size, small] of ICONSET) {
    const src = small ? smallPng : png;
    const out = path.join(dir, name);
    if (size === CANVAS) fs.copyFileSync(src, out);
    else execFileSync('sips', ['-z', String(size), String(size), src, '--out', out], { stdio: 'ignore' });
  }
  const icns = path.join(BUILD, 'icon.icns');
  execFileSync('iconutil', ['-c', 'icns', dir, '-o', icns]);
  return icns;
}

// Inline SVGs share one id namespace per document, so prefix each one's ids.
function scopeIds(svg, i) {
  return svg
    .replace(/\bid="([^"]+)"/g, `id="s${i}-$1"`)
    .replace(/url\(#([^)]+)\)/g, `url(#s${i}-$1)`);
}

// Renders several 1024x1024 SVGs side by side in one offscreen page (one
// renderer process, one capture) and returns one PNG buffer per SVG.
async function render(BrowserWindow, svgs) {
  const W = CANVAS * svgs.length;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    body{display:flex;width:${W}px;height:${CANVAS}px}
    svg{display:block;flex:none}
  </style></head><body>${svgs.map(scopeIds).join('')}</body></html>`;

  const win = new BrowserWindow({
    width: W,
    height: CANVAS,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    enableLargerThanScreen: true,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true },
  });

  // Keep the newest offscreen frame as a fallback for capturePage().
  let lastFrame = null;
  win.webContents.on('paint', (_e, _dirty, image) => { lastFrame = image; });

  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'));
  const dpr = await win.webContents.executeJavaScript(
    'new Promise(r => requestAnimationFrame(() => requestAnimationFrame(() => r(window.devicePixelRatio))))'
  );
  win.webContents.invalidate();
  await new Promise((r) => setTimeout(r, 300));

  let image = await win.webContents.capturePage();
  if (image.isEmpty() && lastFrame) image = lastFrame;
  win.destroy();
  if (image.isEmpty()) throw new Error('offscreen capture returned an empty image');
  const { width, height } = image.getSize();
  if (width !== W || height !== CANVAS) {
    console.warn(`capture was ${width}x${height} (dpr ${dpr}); resampling to ${W}x${CANVAS}`);
    image = image.resize({ width: W, height: CANVAS, quality: 'best' });
  }
  const pngs = svgs.map((_, i) => image.crop({ x: i * CANVAS, y: 0, width: CANVAS, height: CANVAS }).toPNG());
  return { pngs, dpr };
}

async function main() {
  const { app, BrowserWindow } = require('electron');
  app.disableHardwareAcceleration();
  if (app.dock) app.dock.hide();
  await app.whenReady();

  fs.mkdirSync(BUILD, { recursive: true });
  fs.writeFileSync(path.join(BUILD, 'mark.svg'), markSvg());

  const { pngs, dpr } = await render(BrowserWindow, [iconSvg(), iconSvg({ small: true })]);

  const pngPath = path.join(BUILD, 'icon.png');
  fs.writeFileSync(pngPath, pngs[0]);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tessera-icon-'));
  const smallPath = path.join(tmp, 'icon-small.png');
  fs.writeFileSync(smallPath, pngs[1]);
  try {
    const icns = writeIconset(pngPath, smallPath);
    console.log(`devicePixelRatio ${dpr}`);
    console.log(`wrote build/icon.png (${CANVAS}x${CANVAS})`);
    console.log(`wrote build/icon.iconset/ (${ICONSET.length} sizes; 16 and 32 px from the small-size master)`);
    console.log(`wrote ${path.relative(ROOT, icns)}`);
    console.log('wrote build/mark.svg');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  app.quit();
}

if (process.versions.electron) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
} else {
  module.exports = { iconSvg, markSvg, squircle, layoutTiles, TILES };
}
