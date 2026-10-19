// Squarified treemap layout (Bruls, Huizing & van Wijk, 2000).
// `values` must already be sorted largest first. Returns one [x, y, w, h] per value,
// in the same order, filling the rect exactly. Largest tiles land top-left.

export function squarify(values, x, y, w, h) {
  const n = values.length;
  const out = new Array(n);
  let total = 0;
  for (let i = 0; i < n; i++) total += values[i];
  if (n === 0 || total <= 0 || w <= 0 || h <= 0) {
    for (let i = 0; i < n; i++) out[i] = [x, y, 0, 0];
    return out;
  }

  const scale = (w * h) / total;
  const areas = new Float64Array(n);
  for (let i = 0; i < n; i++) areas[i] = values[i] * scale;

  let i = 0;
  while (i < n) {
    const side = Math.min(w, h);
    if (side <= 0) {
      for (; i < n; i++) out[i] = [x, y, 0, 0];
      break;
    }
    const side2 = side * side;

    // Grow the row while it keeps the worst aspect ratio from getting worse.
    let sum = 0;
    let min = Infinity;
    let max = 0;
    let worst = Infinity;
    let j = i;
    while (j < n) {
      const a = areas[j];
      const s = sum + a;
      const mn = a < min ? a : min;
      const mx = a > max ? a : max;
      const s2 = s * s;
      const ratio = Math.max((side2 * mx) / s2, s2 / (side2 * mn));
      if (j > i && ratio > worst) break;
      worst = ratio;
      sum = s;
      min = mn;
      max = mx;
      j++;
    }

    if (j >= n) sum = Math.min(sum, w * h); // guard float drift on the last row

    if (w >= h) {
      // Vertical strip along the left edge.
      const stripW = h > 0 ? sum / h : 0;
      let yy = y;
      for (let k = i; k < j; k++) {
        const hh = stripW > 0 ? areas[k] / stripW : 0;
        out[k] = [x, yy, stripW, k === j - 1 ? y + h - yy : hh];
        yy += hh;
      }
      x += stripW;
      w -= stripW;
    } else {
      // Horizontal strip along the top edge.
      const stripH = w > 0 ? sum / w : 0;
      let xx = x;
      for (let k = i; k < j; k++) {
        const ww = stripH > 0 ? areas[k] / stripH : 0;
        out[k] = [xx, y, k === j - 1 ? x + w - xx : ww, stripH];
        xx += ww;
      }
      y += stripH;
      h -= stripH;
    }
    i = j;
  }
  return out;
}
