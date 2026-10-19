// File kinds and their colors. Indices match src/scanner/kinds.js — never reorder.
//
// Hues come from the validated categorical palette (docs/DESIGN.md → Color). The two
// neutrals mirror how macOS Storage paints "System Data": stuff that isn't really yours
// stays gray so your own files carry the color.

import { t } from './i18n.js';

export const KINDS = [
  { id: 'apps', key: 'kindApps' },
  { id: 'video', key: 'kindVideo' },
  { id: 'photos', key: 'kindPhotos' },
  { id: 'audio', key: 'kindAudio' },
  { id: 'documents', key: 'kindDocuments' },
  { id: 'archives', key: 'kindArchives' },
  { id: 'developer', key: 'kindDeveloper' },
  { id: 'system', key: 'kindSystem' },
  { id: 'other', key: 'kindOther' },
];

export function kindLabel(kind) {
  return t((KINDS[kind] || KINDS[8]).key);
}

export const KIND_OTHER = 8;

// Tessera is dark only; these steps are tuned for the dark window material (#232326).
// In a treemap any two kinds can touch, so the seven hues are separated across ALL pairs
// (OKLab ΔE×100, checked with the dataviz validator): normal vision ≥ 16.7, colour-blind
// ≥ 7.7. The CVD floor is backed by secondary encoding: labels, gaps, texture, legend
// isolation. See docs/DESIGN.md before touching these.
const PALETTE = ['#2184be', '#7f4fd9', '#d73910', '#c9489e', '#0aad87', '#bf8910', '#158000', '#6b6b73', '#4e4e55'];

export function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function kindHex(kind) {
  return PALETTE[kind] ?? PALETTE[KIND_OTHER];
}

// A few close shades per kind so neighbouring tiles of the same kind still read as
// separate objects. Shades shift lightness only; the hue never changes.
const SHADES = [0, 0.055, -0.045, 0.1, -0.08, 0.03];

function shade([r, g, b], amount) {
  if (amount >= 0) {
    return [r + (255 - r) * amount, g + (255 - g) * amount, b + (255 - b) * amount];
  }
  const f = 1 + amount;
  return [r * f, g * f, b * f];
}

const SHADE_TABLE = PALETTE.map((hex) => {
  const base = hexToRgb(hex);
  return SHADES.map((amount) => shade(base, amount));
});

export function hashKey(key) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function tileColor(kind, key) {
  const shades = SHADE_TABLE[kind] ?? SHADE_TABLE[KIND_OTHER];
  return shades[hashKey(key) % shades.length];
}
