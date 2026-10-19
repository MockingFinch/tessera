// Formatting helpers. Sizes use decimal units, like Finder (1 GB = 10^9 bytes).

import { t, locale } from './i18n.js';

const UNITS = ['KB', 'MB', 'GB', 'TB', 'PB'];
const formats = new Map();

function numberFormat(options) {
  const id = locale() + JSON.stringify(options);
  let f = formats.get(id);
  if (!f) {
    f = new Intl.NumberFormat(locale(), options);
    formats.set(id, f);
  }
  return f;
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return t('zeroBytes');
  if (bytes < 1000) return `${Math.round(bytes)} ${t('bytes')}`;
  let unit = -1;
  let value = bytes;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  const digits = value >= 100 ? 0 : 1;
  const text = numberFormat({ minimumFractionDigits: 0, maximumFractionDigits: digits }).format(
    Number(value.toFixed(digits)),
  );
  return `${text} ${UNITS[unit]}`;
}

export function formatCount(n) {
  return numberFormat({}).format(Math.round(n || 0));
}

export function formatItems(n) {
  const count = Math.round(n || 0);
  return t(count === 1 ? 'itemsOne' : 'itemsMany', { n: formatCount(count) });
}

export function formatPercent(part, whole) {
  if (!whole) return '';
  const pct = (part / whole) * 100;
  if (pct < 0.1) return '<0.1%';
  return `${numberFormat({ maximumFractionDigits: pct < 10 ? 1 : 0 }).format(pct)}%`;
}
