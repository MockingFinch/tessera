// The welcome screen: logomark, location cards, entrance choreography.

import { formatBytes } from './format.js';
import { t } from './i18n.js';

// Mosaic from docs/SPEC.md → Visual identity, in a 0–100 square.
const MARK_TILES = [
  ['#2a78d6', 0.0, 0.0, 0.58, 0.62],
  ['#6250d6', 0.0, 0.62, 0.58, 0.38],
  ['#eb6834', 0.58, 0.0, 0.42, 0.36],
  ['#1baf7a', 0.58, 0.36, 0.42, 0.26],
  ['#e87ba4', 0.58, 0.62, 0.24, 0.38],
  ['#eda100', 0.82, 0.62, 0.18, 0.22],
  ['#2f9e44', 0.82, 0.84, 0.18, 0.16],
];

export function renderMark(el) {
  const gap = 3.6;
  const rects = MARK_TILES.map(([color, x, y, w, h], i) => {
    const rx = Math.min(6, (w * 100 - gap) / 3, (h * 100 - gap) / 3).toFixed(2);
    return `<rect style="--i:${i}" x="${(x * 100 + gap / 2).toFixed(2)}" y="${(y * 100 + gap / 2).toFixed(2)}" width="${(w * 100 - gap).toFixed(2)}" height="${(h * 100 - gap).toFixed(2)}" rx="${rx}" fill="url(#g${i})"/>`;
  });
  const grads = MARK_TILES.map(
    ([color], i) =>
      `<linearGradient id="g${i}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${color}" stop-opacity="0.88"/><stop offset="1" stop-color="${color}"/></linearGradient>`,
  );
  el.innerHTML = `<svg viewBox="0 0 100 100"><defs>${grads.join('')}</defs>${rects.join('')}</svg>`;
}

const ICONS = {
  disk: `<svg viewBox="0 0 34 34" aria-hidden="true">
    <rect x="3.5" y="9.5" width="27" height="15" rx="4.5" fill="currentColor" fill-opacity=".14"/>
    <rect x="3.5" y="9.5" width="27" height="15" rx="4.5" fill="none" stroke="currentColor" stroke-width="1.7"/>
    <path d="M8.75 17h8.5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    <circle cx="24.6" cy="17" r="1.65" fill="currentColor"/></svg>`,
  home: `<svg viewBox="0 0 34 34" aria-hidden="true">
    <path d="M8.5 14.6V26a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5V14.6" fill="currentColor" fill-opacity=".14"/>
    <path d="M5.5 16.2 17 6.5l11.5 9.7" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M8.5 14.6V26a1.5 1.5 0 0 0 1.5 1.5h14a1.5 1.5 0 0 0 1.5-1.5V14.6" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
    <path d="M14.25 27.5v-6.25a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1v6.25" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>`,
  external: `<svg viewBox="0 0 34 34" aria-hidden="true">
    <rect x="5.5" y="7.5" width="23" height="19" rx="4.5" fill="currentColor" fill-opacity=".14"/>
    <rect x="5.5" y="7.5" width="23" height="19" rx="4.5" fill="none" stroke="currentColor" stroke-width="1.7"/>
    <path d="M10.5 21.5h7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
    <circle cx="23" cy="21.5" r="1.5" fill="currentColor"/>
    <path d="M14 26.5v2.5h6v-2.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`,
  choose: `<svg viewBox="0 0 34 34" aria-hidden="true">
    <path d="M4.5 10.5a2.5 2.5 0 0 1 2.5-2.5h6l2.6 2.8H27a2.5 2.5 0 0 1 2.5 2.5V24a2.5 2.5 0 0 1-2.5 2.5H7A2.5 2.5 0 0 1 4.5 24Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
    <path d="M17 14.5v8M13 18.5h8" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg>`,
};

export const CRUMB_ICONS = {
  disk: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="1.75" y="4.25" width="12.5" height="7.5" rx="2.2"/><path d="M4.5 8h3.5"/><circle cx="11.25" cy="8" r=".4"/></svg>`,
  external: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="2.75" y="3.25" width="10.5" height="9.5" rx="2.2"/><path d="M5.25 10h3"/><circle cx="10.75" cy="10" r=".4"/></svg>`,
  home: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.25 7.6 8 2.75l5.75 4.85"/><path d="M3.75 6.6v6.15c0 .3.25.5.5.5h7.5c.3 0 .5-.2.5-.5V6.6"/><path d="M6.6 13.25v-3.1h2.8v3.1"/></svg>`,
  folder: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M1.75 4.75c0-.7.55-1.25 1.25-1.25h3l1.3 1.4H13c.7 0 1.25.55 1.25 1.25v5.6c0 .7-.55 1.25-1.25 1.25H3c-.7 0-1.25-.55-1.25-1.25Z"/></svg>`,
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function card(loc, index, onPick) {
  const button = el('button', `location reveal${loc.kind === 'choose' ? ' choose' : ''}`);
  button.style.setProperty('--i', String(4 + index));
  button.dataset.kind = loc.kind;

  const icon = el('span', 'location-icon');
  icon.innerHTML = ICONS[loc.kind] || ICONS.disk;
  button.append(icon);
  const name = loc.kind === 'choose' ? t('chooseName') : loc.kind === 'home' ? t('homeName') : loc.name;
  const nameRow = el('span', 'location-name-row');
  nameRow.append(el('span', 'location-name', name));
  if (loc.total && loc.kind !== 'home') nameRow.append(el('span', 'location-total', formatBytes(loc.total)));
  button.append(nameRow);

  if (loc.kind === 'choose') {
    button.append(el('span', 'location-detail', t('chooseDetail')));
  } else if (loc.kind === 'home') {
    button.append(el('span', 'location-detail', loc.path));
  } else if (loc.total) {
    const used = Math.max(0, loc.total - (loc.free || 0));
    button.append(el('span', 'location-detail', t('available', { free: formatBytes(loc.free || 0) })));
    const bar = el('span', 'capacity');
    const fill = el('span', 'capacity-fill');
    fill.style.setProperty('--used', String(Math.min(1, used / loc.total)));
    bar.append(fill);
    button.append(bar);
  } else {
    button.append(el('span', 'location-detail', loc.path));
  }

  button.addEventListener('click', () => {
    button.classList.add('chosen');
    setTimeout(() => button.classList.remove('chosen'), 700);
    onPick(loc);
  });
  return button;
}


export function renderLocations(listEl, locations, onPick) {
  const order = { disk: 0, home: 1, external: 2 };
  const sorted = [...locations].sort((a, b) => (order[a.kind] ?? 3) - (order[b.kind] ?? 3));
  const all = [...sorted, { kind: 'choose' }];
  listEl.replaceChildren(...all.map((loc, i) => card(loc, i, onPick)));
}

export function playWelcome(welcomeEl) {
  welcomeEl.classList.remove('enter');
  void welcomeEl.offsetWidth; // restart the CSS choreography
  welcomeEl.classList.add('enter');
}
