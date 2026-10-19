// Development only: a scripted walk through the app that saves screenshots.
// Runs when main is started with TESSERA_SHOT_DIR (and TESSERA_AUTOSCAN for the folder).

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(test, timeout = 120000) {
  const start = performance.now();
  while (!test()) {
    if (performance.now() - start > timeout) return false;
    await sleep(100);
  }
  return true;
}

export async function runTour(api, T) {
  if (api.dev.recording) return runFilm(api, T);
  const shot = (name) => api.dev.capture(name);
  const tm = T.treemap;
  const visible = () => [...tm.items.values()].filter((i) => !i.exiting && i.mode !== 'root');
  const largest = (pred) => visible().filter(pred).sort((a, b) => b.cur[2] * b.cur[3] - a.cur[2] * a.cur[3])[0];

  // capturePage can't see the window's vibrancy material; paint the stand-in.
  document.documentElement.classList.add('no-vibrancy');
  await sleep(1400);
  await shot('01-welcome');

  // TESSERA_DEMO scans the built-in demo home folder (js/mock.js) instead of a real path.
  const scanTarget = api.dev.demo ? { path: '/Users/you', name: 'Home', kind: 'home' } : api.dev.autoScan ? { path: api.dev.autoScan } : null;
  if (!scanTarget) return;
  T.startScan(scanTarget);
  await sleep(450);
  await shot('02-scan-assembling');
  await sleep(900);
  await shot('03-scan-live');

  await waitFor(() => T.state.scan && !T.state.scan.scanning);
  await sleep(1400);
  await shot('04-done');

  const leaf = largest((i) => i.mode === 'leaf' && i.depth >= 2);
  if (leaf) {
    tm.setHovered(leaf);
    await sleep(400);
    await shot('05-hover');
    tm.setHovered(null);
  }

  const kinds = T.state.view?.kinds || [];
  const second = kinds.map((b, k) => [b, k]).sort((a, b) => b[0] - a[0])[1];
  if (second) {
    tm.highlightKind(second[1]);
    await sleep(500);
    await shot('06-legend-highlight');
    tm.highlightKind(null);
  }

  const target = largest((i) => i.mode === 'container' && i.depth === 1);
  if (target) {
    tm.select(target.key);
    await sleep(350);
    await shot('07-selected');
    // A tile touching the right and bottom edges: its ring must not be clipped.
    const corner = visible()
      .filter((i) => i.mode !== 'root' && i.depth === 1)
      .sort((a, b) => b.cur[0] + b.cur[2] + b.cur[1] + b.cur[3] - (a.cur[0] + a.cur[2] + a.cur[1] + a.cur[3]))[0];
    if (corner) {
      tm.select(corner.key);
      await sleep(350);
      await shot('07b-selected-corner');
      tm.select(target.key);
      await sleep(200);
    }
    T.zoomTo(target.key);
    await sleep(110);
    await shot('08-zoom-early');
    await sleep(140);
    await shot('09-zoom-mid');
    await sleep(1100);
    await shot('10-zoomed');

    const inner = largest((i) => i.mode === 'container' && i.depth === 1);
    if (inner) {
      T.zoomTo(inner.key);
      await sleep(1200);
      await shot('11-zoomed-deeper');
    }
    T.goUp();
    await sleep(160);
    await shot('12-up-mid');
    await sleep(1100);
    await shot('13-up');
    T.goUp();
    await sleep(1200);
  }

  await api.setLanguage('zh');
  await sleep(700);
  await shot('14-zh-explorer');

  T.showWelcome();
  await sleep(1600);
  await shot('15-zh-welcome');
  await api.setLanguage('en');
  await sleep(500);
  await shot('16-en-welcome');
  console.log('[tour] done');
}

// ───────────────────────────── film (TESSERA_RECORD_DIR) ─────────────────────────────
// A short, paced take for the README and social video: welcome → live scan → explore →
// zoom in twice → back out → legend. A drawn pointer stands in for the real one, which
// frame capture can't see.

const ARROW = `<svg width="22" height="30" viewBox="0 0 22 30" xmlns="http://www.w3.org/2000/svg">
  <path d="M2 2 L2 23.5 L7.4 18.4 L11.2 27 L14.6 25.5 L10.9 17.1 L18 17.1 Z" fill="#000" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>`;

function makeCursor() {
  const c = document.createElement('div');
  c.innerHTML = ARROW;
  Object.assign(c.style, {
    position: 'fixed', left: '0', top: '0', zIndex: '9999', pointerEvents: 'none',
    filter: 'drop-shadow(0 2px 3px rgba(0,0,0,0.45))', transformOrigin: '2px 2px',
    transition: 'transform 760ms cubic-bezier(0.3, 0.75, 0.25, 1)',
  });
  document.body.append(c);
  let x = 0, y = 0, s = 1;
  const apply = () => (c.style.transform = `translate(${x - 2}px, ${y - 2}px) scale(${s})`);
  return {
    jump(nx, ny) { c.style.transition = 'none'; x = nx; y = ny; apply(); void c.offsetWidth; c.style.transition = 'transform 760ms cubic-bezier(0.3, 0.75, 0.25, 1)'; },
    async move(nx, ny, ms = 760) { c.style.transitionDuration = `${ms}ms`; x = nx; y = ny; apply(); await sleep(ms); },
    async click() { c.style.transitionDuration = '110ms'; s = 0.82; apply(); await sleep(120); s = 1; apply(); await sleep(130); },
    remove() { c.remove(); },
  };
}

export async function runFilm(api, T) {
  const tm = T.treemap;
  const stage = document.getElementById('stage');
  const cursor = makeCursor();
  document.documentElement.classList.add('no-vibrancy');

  const visible = () => [...tm.items.values()].filter((i) => !i.exiting && i.mode !== 'root');
  const largest = (pred) => visible().filter(pred).sort((a, b) => b.cur[2] * b.cur[3] - a.cur[2] * a.cur[3])[0];
  const pageOf = (it, fx = 0.5, fy = 0.5) => {
    const r = stage.getBoundingClientRect();
    return [r.left + it.cur[0] + it.cur[2] * fx, r.top + it.cur[1] + it.cur[3] * fy];
  };
  const hoverAt = (px, py) => {
    const r = stage.getBoundingClientRect();
    tm.pointer = [px - r.left, py - r.top];
    tm.setHovered(tm.hitTest(tm.pointer[0], tm.pointer[1]));
  };
  const glide = async (it, fx, fy, ms) => {
    const [px, py] = pageOf(it, fx, fy);
    await cursor.move(px, py, ms);
    hoverAt(px, py);
  };

  await sleep(900);
  cursor.jump(innerWidth * 0.7, innerHeight * 0.86);
  await api.dev.record('start');
  T.showWelcome();
  await sleep(1500);

  // Pick Home.
  const home = [...document.querySelectorAll('#location-list button')].find((b) => b.querySelector('.location-detail')?.textContent.startsWith('/'));
  const hr = home.getBoundingClientRect();
  await cursor.move(hr.left + hr.width * 0.45, hr.top + hr.height * 0.55, 900);
  await sleep(250);
  await cursor.click();
  home.click();
  await cursor.move(innerWidth * 0.93, innerHeight * 0.8, 1100);

  // The map assembles while the (demo) scan runs.
  await waitFor(() => T.state.scan && !T.state.scan.scanning, 30000);
  await sleep(1500);

  // Look around.
  const leaves = visible().filter((i) => i.mode === 'leaf' && i.depth >= 2).sort((a, b) => b.cur[2] * b.cur[3] - a.cur[2] * a.cur[3]);
  for (const it of leaves.slice(0, 3)) {
    await glide(it, 0.4, 0.45, 700);
    await sleep(650);
  }

  // Dive into the biggest folder, then one level deeper.
  for (let level = 0; level < 2; level++) {
    const folder = largest((i) => i.mode === 'container' && i.depth === 1);
    if (!folder) break;
    await glide(folder, 0.5, 0.5, 750);
    await sleep(200);
    await cursor.click();
    tm.select(folder.key);
    await sleep(380);
    await cursor.click();
    T.zoomTo(folder.key);
    await sleep(1500);
    const peek = largest((i) => i.mode === 'leaf');
    if (peek) {
      await glide(peek, 0.45, 0.5, 650);
      await sleep(600);
    }
  }

  // Back out with the chevron.
  const back = document.getElementById('back');
  const br = back.getBoundingClientRect();
  tm.setHovered(null);
  tm.pointer = null;
  await cursor.move(br.left + br.width / 2, br.top + br.height / 2, 800);
  for (let i = 0; i < 2; i++) {
    await sleep(200);
    await cursor.click();
    T.goUp();
    await sleep(1400);
  }

  // Isolate a kind from the legend.
  const chip = document.querySelector('#legend .chip');
  if (chip) {
    const cr = chip.getBoundingClientRect();
    await cursor.move(cr.left + cr.width / 2, cr.top + cr.height / 2, 900);
    chip.dispatchEvent(new MouseEvent('mouseenter'));
    await sleep(1900);
    chip.dispatchEvent(new MouseEvent('mouseleave'));
    await sleep(900);
  }

  const frames = await api.dev.record('stop');
  cursor.remove();
  console.log(`[tour] film done: ${frames} frames`);
}
