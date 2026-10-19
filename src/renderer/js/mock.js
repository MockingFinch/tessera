// A stand-in for window.tessera when the renderer is opened in a plain browser.
// It fabricates a believable home folder and "scans" it progressively, speaking the
// same view protocol as src/scanner (docs/SPEC.md), so UI work can happen without Electron.

const GB = 1e9, MB = 1e6, KB = 1e3;
const K = { apps: 0, video: 1, photos: 2, audio: 3, docs: 4, archives: 5, dev: 6, system: 7, other: 8 };

function rng(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function buildTree() {
  const rand = rng(7);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  const between = (a, b) => a + (b - a) * rand();
  const logn = (median, spread) => median * Math.exp((rand() * 2 - 1) * spread);

  const dirs = [];
  const mk = (name, parent, opts = {}) => {
    const d = { id: dirs.length, name, parent, dirs: [], files: [], pkg: !!opts.pkg, kind: opts.kind, pkgSize: opts.size || 0 };
    dirs.push(d);
    if (parent) parent.dirs.push(d);
    return d;
  };
  const file = (d, name, size, kind) => d.files.push({ n: name, s: Math.round(size), t: kind });
  const many = (d, count, namer, median, spread, kind) => {
    for (let i = 0; i < count; i++) file(d, namer(i), logn(median, spread), kind);
  };

  const root = mk('you', null);

  const lib = mk('Library', root);
  const caches = mk('Caches', lib);
  for (const [n, size, kind] of [
    ['com.apple.Safari', 1.3 * GB, K.system],
    ['Google', 2.6 * GB, K.system],
    ['com.spotify.client', 3.4 * GB, K.audio],
    ['Homebrew', 4.9 * GB, K.archives],
    ['pip', 1.1 * GB, K.dev],
    ['Yarn', 3.1 * GB, K.dev],
    ['com.apple.dt.Xcode', 1.8 * GB, K.dev],
    ['CloudKit', 0.6 * GB, K.system],
  ]) {
    const d = mk(n, caches);
    many(d, 40 + Math.floor(rand() * 120), (i) => `${n.toLowerCase().replace(/\W/g, '')}-${i}.cache`, size / 90, 1.4, kind);
  }
  const support = mk('Application Support', lib);
  const steam = mk('Steam', support);
  const steamapps = mk('steamapps', steam);
  for (const game of ['Hades II', 'Disco Elysium', 'Baldur’s Gate 3', 'Celeste']) {
    const g = mk(game, steamapps);
    many(g, 30, (i) => `data${i}.pak`, between(0.2, 2.6) * GB / 12, 1.0, K.other);
  }
  for (const [n, size, kind] of [
    ['Google', 6.2 * GB, K.system],
    ['Slack', 2.1 * GB, K.system],
    ['Code', 1.6 * GB, K.dev],
    ['MobileSync', 27 * GB, K.other],
    ['Arc', 1.9 * GB, K.system],
  ]) {
    const d = mk(n, support);
    many(d, 60, (i) => `${n} data ${i}`, size / 60, 1.2, kind);
  }
  const containers = mk('Containers', lib);
  const docker = mk('com.docker.docker', containers);
  const dockerData = mk('Data', docker);
  file(dockerData, 'Docker.raw', 58.7 * GB, K.other);
  const mail = mk('com.apple.mail', containers);
  many(mail, 400, (i) => `${10000 + i}.emlx`, 6 * MB, 1.3, K.docs);
  const dev = mk('Developer', lib);
  const derived = mk('DerivedData', mk('Xcode', dev));
  for (const proj of ['Tessera-abcxyz', 'Weather-qwerty', 'Notes-plmokn', 'Atlas-zxcvbn']) {
    const p = mk(proj, derived);
    many(p, 160, (i) => `obj${i}.o`, between(8, 40) * MB, 1.1, K.dev);
  }
  const sim = mk('CoreSimulator', dev);
  const devices = mk('Devices', sim);
  for (let i = 0; i < 6; i++) {
    const d = mk(`${(Math.floor(rand() * 0xffffffff) >>> 0).toString(16).toUpperCase()}-${i}`, devices);
    many(d, 80, (j) => `data-${j}.img`, between(1.5, 6) * GB / 80, 0.9, K.system);
  }
  const messages = mk('Attachments', mk('Messages', lib));
  many(messages, 900, (i) => `IMG_${4000 + i}.${pick(['heic', 'jpeg', 'mov', 'png'])}`, 3.2 * MB, 1.5, K.photos);

  const movies = mk('Movies', root);
  mk('Iceland Trip.fcpbundle', movies, { pkg: true, kind: K.video, size: 64.2 * GB });
  const recordings = mk('Screen Recordings', movies);
  many(recordings, 26, (i) => `Screen Recording ${i + 1}.mov`, 0.6 * GB, 1.0, K.video);
  file(movies, 'Family Reunion.mp4', 4.4 * GB, K.video);
  file(movies, 'Interview Raw.mov', 11.8 * GB, K.video);

  const pictures = mk('Pictures', root);
  mk('Photos Library.photoslibrary', pictures, { pkg: true, kind: K.photos, size: 82.4 * GB });
  const raw = mk('Lightroom Imports', pictures);
  for (const shoot of ['2025 Kyoto', '2026 Patagonia', 'Studio Portraits']) {
    const d = mk(shoot, raw);
    many(d, 140, (i) => `DSC0${1000 + i}.CR3`, 26 * MB, 0.25, K.photos);
  }
  const shots = mk('Screenshots', pictures);
  many(shots, 420, (i) => `Screenshot 2026-0${1 + (i % 9)}-${10 + (i % 18)} at ${i}.png`, 2.1 * MB, 0.7, K.photos);

  const music = mk('Music', root);
  const media = mk('Music', mk('Media.localized', mk('Music', music)));
  const artists = ['Bon Iver', 'Radiohead', 'Björk', 'Khruangbin', 'Nils Frahm', 'Fleetwood Mac', 'Kendrick Lamar', 'Ryuichi Sakamoto', 'Phoebe Bridgers', 'Daft Punk', 'Joni Mitchell', 'Four Tet'];
  for (const artist of artists) {
    const a = mk(artist, media);
    for (let al = 0; al < 3; al++) {
      const album = mk(`Album ${al + 1}`, a);
      many(album, 11, (i) => `${String(i + 1).padStart(2, '0')} Track.m4a`, 9 * MB, 0.3, K.audio);
    }
  }
  mk('Demo Song.logicx', music, { pkg: true, kind: K.audio, size: 3.2 * GB });

  const docs = mk('Documents', root);
  many(docs, 260, (i) => `${pick(['Invoice', 'Contract', 'Report', 'Notes', 'Lease', 'Manual'])} ${i}.pdf`, 1.6 * MB, 1.4, K.docs);
  const keynotes = mk('Presentations', docs);
  many(keynotes, 24, (i) => `Pitch v${i}.key`, 140 * MB, 0.9, K.docs);
  const taxes = mk('Taxes', docs);
  many(taxes, 60, (i) => `Receipt ${i}.pdf`, 0.9 * MB, 0.9, K.docs);
  file(docs, 'Book Draft.pages', 420 * MB, K.docs);

  const downloads = mk('Downloads', root);
  for (const [n, size, kind] of [
    ['Xcode_26.xip', 7.4 * GB, K.archives],
    ['Docker.dmg', 0.62 * GB, K.archives],
    ['Blender-4.5.dmg', 0.41 * GB, K.archives],
    ['dataset-2026.zip', 3.9 * GB, K.archives],
    ['ubuntu-26.04-desktop-arm64.iso', 3.1 * GB, K.archives],
    ['Figma.dmg', 0.31 * GB, K.archives],
    ['lecture-recording.mp4', 1.7 * GB, K.video],
  ]) file(downloads, n, size, kind);
  many(downloads, 140, (i) => `${pick(['scan', 'photo', 'report', 'export', 'IMG'])}_${i}.${pick(['pdf', 'jpg', 'zip', 'png', 'csv'])}`, 3 * MB, 1.6, K.other);

  const desktop = mk('Desktop', root);
  many(desktop, 60, (i) => `Screenshot ${i}.png`, 2 * MB, 0.6, K.photos);

  const apps = mk('Applications', root);
  for (const [n, size] of [['Blender.app', 1.4 * GB], ['Figma.app', 0.5 * GB], ['Logic Pro.app', 2.1 * GB], ['Final Cut Pro.app', 6.3 * GB]]) {
    mk(n, apps, { pkg: true, kind: K.apps, size });
  }

  const projects = mk('projects', root);
  for (const repo of ['tessera', 'atlas-web', 'weather-ios', 'ml-notebooks', 'blog', 'design-system', 'game-jam-2026']) {
    const r = mk(repo, projects);
    const nm = mk('node_modules', r, { kind: K.dev });
    for (let i = 0; i < 24; i++) {
      const pkg = mk(pick(['react', 'typescript', 'esbuild', '@babel', 'webpack', 'lodash', 'electron', 'vite', 'next', 'sharp']) + (i ? `-${i}` : ''), nm, { kind: K.dev });
      many(pkg, 30, (j) => `index${j}.js`, between(40, 600) * KB, 1.2, K.dev);
    }
    const git = mk('.git', r, { kind: K.dev });
    many(git, 40, (i) => `pack-${i}.pack`, between(2, 30) * MB, 1, K.dev);
    const src = mk('src', r);
    many(src, 90, (i) => `module${i}.${pick(['ts', 'tsx', 'swift', 'py', 'css'])}`, 14 * KB, 1, K.dev);
    if (repo === 'ml-notebooks') file(r, 'weights.safetensors', 13.5 * GB, K.other);
  }

  const trash = mk('.Trash', root);
  file(trash, 'Old Backup.zip', 5.2 * GB, K.archives);
  many(trash, 30, (i) => `untitled ${i}.png`, 3 * MB, 1, K.photos);

  // Kinds forced by ancestors (node_modules, .git…) flow down.
  const inherit = (d, forced) => {
    const f = d.kind !== undefined && !d.pkg ? d.kind : forced;
    if (f !== undefined) for (const fl of d.files) fl.t = f;
    for (const c of d.dirs) inherit(c, f);
  };
  inherit(root, undefined);

  // Breadth-first discovery order → reveal times.
  const queue = [root];
  let order = 0;
  for (let i = 0; i < queue.length; i++) {
    queue[i].order = order++;
    queue.push(...queue[i].dirs);
  }
  for (const d of dirs) d.reveal = d.order / order;
  return dirs;
}

// `errors`: how many unreadable entries each scan reports (3 shows off the Limited access pill).
export function createMockApi({ errors = 3 } = {}) {
  const listeners = { progress: new Set(), done: new Set(), command: new Set(), removed: new Set(), lang: new Set(), state: new Set() };
  const emit = (name, payload) => listeners[name].forEach((fn) => fn(payload));
  const on = (name) => (fn) => {
    listeners[name].add(fn);
    return () => listeners[name].delete(fn);
  };

  let dirs = null;
  let scanId = 0;
  let startedAt = 0;
  let timer = 0;
  const duration = 7000;
  const removedFiles = new Set();
  const removedDirs = new Set();
  let lang = 'en';
  try {
    lang = localStorage.getItem('tessera-lang') || 'en';
  } catch {}

  const progress = () => Math.min(1, (performance.now() - startedAt) / duration);

  function totals(p) {
    // Recompute sizes for everything discovered by progress p.
    const sizes = new Float64Array(dirs.length);
    const counts = new Float64Array(dirs.length);
    const kinds = dirs.map(() => new Float64Array(9));
    for (let i = dirs.length - 1; i >= 0; i--) {
      const d = dirs[i];
      if (d.reveal > p || removedDirs.has(d.id)) continue;
      if (d.pkg) {
        sizes[i] = d.pkgSize;
        counts[i] = Math.round(d.pkgSize / 2e6);
        kinds[i][d.kind] = d.pkgSize;
      }
      d.files.forEach((f, j) => {
        if (removedFiles.has(`${d.id}:${j}`)) return;
        sizes[i] += f.s;
        counts[i] += 1;
        kinds[i][f.t] += f.s;
      });
      if (d.parent) {
        const pi = d.parent.id;
        sizes[pi] += sizes[i];
        counts[pi] += counts[i];
        for (let k = 0; k < 9; k++) kinds[pi][k] += kinds[i][k];
      }
    }
    return { sizes, counts, kinds };
  }

  const argmax = (arr) => {
    let best = 8, max = 0;
    arr.forEach((v, i) => {
      if (v > max) {
        max = v;
        best = i;
      }
    });
    return best;
  };

  function viewDir(d, depth, minSize, maxChildren, T, level) {
    const node = { k: `d${d.id}`, n: d.parent ? d.name : scanName, s: T.sizes[d.id], t: d.pkg ? d.kind : argmax(T.kinds[d.id]), d: 1, c: T.counts[d.id] };
    if (d.pkg) node.p = 1;
    if (d.pkg || level >= depth) return node;
    const items = [];
    for (const c of d.dirs) if (T.sizes[c.id] > 0 && T.sizes[c.id] >= minSize) items.push({ dir: c, s: T.sizes[c.id], n: c.name });
    if (d.reveal <= progress()) {
      d.files.forEach((f, j) => {
        if (!removedFiles.has(`${d.id}:${j}`) && f.s >= minSize && f.s > 0) items.push({ file: f, j, s: f.s, n: f.n });
      });
    }
    items.sort((a, b) => b.s - a.s || a.n.localeCompare(b.n));
    const shown = items.slice(0, maxChildren);
    let sum = 0;
    node.ch = shown.map((it) => {
      sum += it.s;
      return it.dir ? viewDir(it.dir, depth, minSize, maxChildren, T, level + 1) : { k: `f${d.id}:${it.j}`, n: it.n, s: it.s, t: it.file.t };
    });
    const rest = node.s - sum;
    if (rest > 1) {
      const total = d.dirs.length + d.files.length;
      node.ch.push({ k: `a${d.id}`, n: '', s: rest, t: 8, a: 1, c: Math.max(1, total - shown.length) });
    }
    return node;
  }

  let scanName = 'you';
  const pathOf = (key) => {
    const m = /^([dfa])(\d+)(?::(\d+))?$/.exec(key);
    if (!m) return null;
    let d = dirs[Number(m[2])];
    const parts = [];
    for (let x = d; x; x = x.parent) parts.unshift(x.parent ? x.name : '/Users/you');
    let p = parts.join('/');
    if (m[1] === 'f') p += '/' + d.files[Number(m[3])].n;
    return p;
  };

  return {
    isMock: true,
    getLocations: async () => [
      { id: 'disk', kind: 'disk', name: 'Macintosh HD', path: '/', total: 994.7 * GB, free: 312.4 * GB },
      { id: 'home', kind: 'home', name: 'Home', path: '/Users/you', user: 'you' },
      { id: 'ext', kind: 'external', name: 'Archive SSD', path: '/Volumes/Archive SSD', total: 2000 * GB, free: 860 * GB },
    ],
    chooseFolder: async () => ({ path: '/Users/you/projects', name: 'projects' }),
    pathForFile: () => '/Users/you',
    startScan: async ({ path, name }) => {
      dirs = buildTree();
      removedFiles.clear();
      removedDirs.clear();
      scanId++;
      scanName = name || (path === '/' ? 'Macintosh HD' : path.split('/').filter(Boolean).pop() || 'you');
      startedAt = performance.now();
      clearInterval(timer);
      const id = scanId;
      timer = setInterval(() => {
        const p = progress();
        const T = totals(p);
        const payload = { scanId: id, files: T.counts[0], dirs: Math.round(dirs.length * p), bytes: T.sizes[0], errors, elapsed: performance.now() - startedAt };
        emit('progress', payload);
        if (p >= 1) {
          clearInterval(timer);
          emit('done', payload);
        }
      }, 100);
      return { scanId: id, path, name: scanName };
    },
    cancelScan: async () => clearInterval(timer),
    getView: async ({ key, depth, minFrac, maxChildren }) => {
      if (!dirs) return null;
      await new Promise((r) => setTimeout(r, 8));
      const m = /^d(\d+)$/.exec(key);
      if (!m) return null;
      const d = dirs[Number(m[1])];
      const T = totals(progress());
      const minSize = T.sizes[d.id] * minFrac;
      const view = viewDir(d, depth, minSize, maxChildren, T, 0);
      const crumbs = [];
      for (let x = d; x; x = x.parent) crumbs.unshift({ k: `d${x.id}`, n: x.parent ? x.name : scanName });
      return { ...view, kinds: [...T.kinds[d.id]], crumbs, path: pathOf(key), scanning: progress() < 1 };
    },
    reveal: async (key) => console.log('[mock] reveal', pathOf(key)),
    open: async (key) => console.log('[mock] open', pathOf(key)),
    quickLook: async (key) => console.log('[mock] quick look', pathOf(key)),
    copyPath: async (key) => console.log('[mock] copy', pathOf(key)),
    trash: async (key) => {
      if (!confirm(`Move “${pathOf(key)}” to the Trash?`)) return { trashed: false };
      const T = totals(progress());
      let freed = 0;
      if (key[0] === 'f') {
        const [, did, j] = /^f(\d+):(\d+)$/.exec(key);
        freed = dirs[did].files[j].s;
        removedFiles.add(`${did}:${j}`);
      } else if (key[0] === 'd') {
        const id = Number(key.slice(1));
        freed = T.sizes[id];
        const mark = (d) => {
          removedDirs.add(d.id);
          d.dirs.forEach(mark);
        };
        mark(dirs[id]);
      }
      emit('removed', { key, freed });
      return { trashed: true, freed };
    },
    showContextMenu: ({ key, isDir, isPkg }) => {
      const choice = prompt('[mock] context menu: zoom | look | trash', isDir && !isPkg ? 'zoom' : 'look');
      if (choice === 'zoom') emit('command', { cmd: 'zoom-into', key });
      else if (choice === 'trash') createMockApiTrash(key);
    },
    openFullDiskAccess: () => console.log('[mock] open Full Disk Access'),
    getAccentColor: async () => '#0a84ff',
    getLanguage: async () => lang,
    setLanguage: async (next) => {
      lang = next === 'zh' ? 'zh' : 'en';
      try {
        localStorage.setItem('tessera-lang', lang);
      } catch {}
      emit('lang', lang);
    },
    onProgress: on('progress'),
    onScanDone: on('done'),
    onCommand: on('command'),
    onWindowState: on('state'),
    onAccentColor: () => () => {},
    onItemRemoved: on('removed'),
    onLanguage: on('lang'),
    dev: { autoScan: new URLSearchParams(location.search).get('scan'), capture: async () => '' },
    emitCommand: (cmd) => emit('command', cmd),
  };

  function createMockApiTrash(key) {
    window.tessera.trash(key);
  }
}
