'use strict';
// Tessera scanning engine: breadth-first async traversal, memory-lean tree, mid-scan queries.
// Plain Node — no Electron imports — so it runs both inside utilityProcess (worker.js) and under
// `node` (scripts/scan-bench.js). See docs/SPEC.md: "Scanner process protocol", "View response",
// "Size semantics".

const fsp = require('fs/promises');
const nodePath = require('path');
const { KIND_COUNT, classifyFile, packageKind, forcedDirKind } = require('./kinds');

const { setTimeout: sleep } = require('timers/promises');

const OTHER = 8;
// Transient conditions worth a short retry instead of silently losing a directory.
const RETRY_CODES = new Set(['EMFILE', 'ENFILE', 'EAGAIN', 'EINTR']);
const EMPTY = Object.freeze([]); // shared by every dir with no files / no subdirs (never mutated)

// One object per directory. Files live in the parallel arrays (fNames/fSizes/fKinds) and get no
// per-file objects. Package contents never get nodes; their bytes are summed into the package.
class DirNode {
  constructor(id, name, parent, pkg, forced) {
    this.id = id;
    this.name = name;
    this.parent = parent;         // parent id, -1 for the root
    this.dirIds = EMPTY;          // child directory ids (discovery order)
    this.fNames = EMPTY;          // file names        } assigned once, when the dir's entries
    this.fSizes = EMPTY;          // allocated bytes   } have all been lstat'ed. Removed file → 0.
    this.fKinds = EMPTY;          // kind index        }
    this.size = 0;                // allocated bytes of everything below (propagated)
    this.count = 0;               // descendant files
    this.kinds = new Float64Array(KIND_COUNT);
    this.pkg = pkg;               // 1 = opaque package (leaf in views)
    this.forced = forced;         // forced kind for descendants, -1 = none
    this.removed = 0;             // 1 = tombstoned (trashed)
    this.err = 0;                 // 1 = could not be read
  }
}

function cmpNodes(a, b) {
  const d = b.s - a.s;
  if (d !== 0) return d;
  return a.n < b.n ? -1 : a.n > b.n ? 1 : 0;
}

function parseKey(key) {
  if (typeof key !== 'string' || key.length < 2) throw new Error(`bad key: ${key}`);
  const t = key.charCodeAt(0);
  if (t === 100 /* d */ || t === 97 /* a */) {
    const id = Number(key.slice(1));
    if (!Number.isInteger(id) || id < 0) throw new Error(`bad key: ${key}`);
    return { t: t === 100 ? 'd' : 'a', id, idx: -1 };
  }
  if (t === 102 /* f */) {
    const colon = key.indexOf(':');
    const id = Number(key.slice(1, colon));
    const idx = Number(key.slice(colon + 1));
    if (colon < 0 || !Number.isInteger(id) || id < 0 || !Number.isInteger(idx) || idx < 0) {
      throw new Error(`bad key: ${key}`);
    }
    return { t: 'f', id, idx };
  }
  throw new Error(`bad key: ${key}`);
}

/**
 * @param {object} o
 * @param {string} o.root            absolute path of the folder to scan
 * @param {string} [o.name]          display name of the root (defaults to its basename)
 * @param {string[]} [o.exclude]     absolute paths never descended into (exact match)
 * @param {(s:object)=>void} [o.onProgress]  called every `progressInterval` ms while scanning
 * @param {(s:object)=>void} [o.onDone]      called once when the traversal is complete
 * @param {number} [o.concurrency=64]       directories in flight
 * @param {number} [o.statConcurrency=32]   lstat lanes per directory
 * @param {number} [o.progressInterval=100]
 */
function createScanner(o) {
  const opts = o || {};
  let root = nodePath.resolve(String(opts.root || '/'));
  if (root.length > 1 && root.endsWith('/')) root = root.replace(/\/+$/, '') || '/';
  const rootBase = root === '/' ? '' : nodePath.basename(root);
  const rootParentBase = nodePath.basename(nodePath.dirname(root));
  const displayName = opts.name || rootBase || root;
  const exclude = new Set((opts.exclude || []).filter((p) => typeof p === 'string' && p !== root));
  const hasExclude = exclude.size > 0;
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null;
  const onDone = typeof opts.onDone === 'function' ? opts.onDone : null;
  const concurrency = Math.max(1, opts.concurrency | 0 || 64);
  const statLanes = Math.max(1, opts.statConcurrency | 0 || 32);
  const progressInterval = Math.max(10, opts.progressInterval | 0 || 100);

  // ---- tree ----------------------------------------------------------------------------------
  const nodes = [];
  {
    const pk = packageKind(rootBase);
    const fk = forcedDirKind(rootBase, rootParentBase);
    // The root is never a leaf (you scanned it to look inside), but it keeps its forced kind.
    nodes.push(new DirNode(0, displayName, -1, 0, pk >= 0 ? pk : fk));
  }
  const rootNode = nodes[0];

  // ---- counters ------------------------------------------------------------------------------
  let files = 0, dirs = 0, errors = 0;
  let started = false, scanning = false, t0 = 0, t1 = 0;
  const errorCodes = Object.create(null);
  const errorSamples = [];
  const seenInodes = new Set();   // dev:ino of files with nlink > 1
  let progressTimer = null;
  let peakQueue = 0;

  function noteError(err, p) {
    errors++;
    const code = (err && err.code) || 'UNKNOWN';
    errorCodes[code] = (errorCodes[code] || 0) + 1;
    if (errorSamples.length < 40) errorSamples.push(`${code} ${p}`);
  }

  // ---- queue (breadth-first, head index; parallel arrays, no per-entry objects) -----------------
  // qId: node id for stored dirs, -1 inside a package. qSum: package node id to sum into, or -1.
  let qPath = [], qId = [], qSum = [];
  let qHead = 0;
  let inflight = 0;

  function enqueue(p, id, sum) {
    qPath.push(p); qId.push(id); qSum.push(sum);
  }

  function isDead(id) {
    for (let n = id; n >= 0; n = nodes[n].parent) if (nodes[n].removed) return true;
    return false;
  }

  function addUp(id, bytes, count, vec) {
    for (let n = id; n >= 0;) {
      const nd = nodes[n];
      nd.size += bytes;
      nd.count += count;
      const k = nd.kinds;
      for (let i = 0; i < KIND_COUNT; i++) k[i] += vec[i];
      n = nd.parent;
    }
  }

  const scratch = new Float64Array(KIND_COUNT);
  function propagate(id, bytes, count, vec) {
    if (bytes === 0 && count === 0) return;
    if (isDead(id)) return;      // landed inside a trashed subtree: ancestors already subtracted it
    addUp(id, bytes, count, vec);
  }

  function now() { return performance.now(); }

  function pump() {
    while (inflight < concurrency && qHead < qPath.length) {
      const p = qPath[qHead], id = qId[qHead], sum = qSum[qHead];
      qPath[qHead] = undefined;
      qHead++;
      if (isDead(sum >= 0 ? sum : id)) continue; // trashed before we got to it
      inflight++;
      processDir(p, id, sum).then(settle, (err) => { noteError(err, p); settle(); });
    }
    const len = qPath.length - qHead;
    if (len > peakQueue) peakQueue = len;
    if (qHead > 65536 && qHead * 2 > qPath.length) {
      qPath = qPath.slice(qHead); qId = qId.slice(qHead); qSum = qSum.slice(qHead);
      qHead = 0;
    }
    if (inflight === 0 && qHead >= qPath.length && scanning) finish();
  }

  function settle() {
    inflight--;
    pump();
  }

  function addChildDir(parent, name, p) {
    const pk = packageKind(name);
    let forced;
    if (pk >= 0) forced = pk;
    else {
      const fk = forcedDirKind(name, parent.id === 0 ? rootBase : parent.name);
      forced = fk >= 0 ? fk : parent.forced;
    }
    const cid = nodes.length;
    nodes.push(new DirNode(cid, name, parent.id, pk >= 0 ? 1 : 0, forced));
    if (parent.dirIds === EMPTY) parent.dirIds = [];
    parent.dirIds.push(cid);
    enqueue(p, cid, pk >= 0 ? cid : -1);
  }

  async function processDir(dirPath, id, sum) {
    let ents;
    for (let attempt = 0; ; attempt++) {
      try {
        ents = await fsp.readdir(dirPath, { withFileTypes: true });
        break;
      } catch (err) {
        if (attempt < 4 && RETRY_CODES.has(err && err.code)) { await sleep(25 * (attempt + 1)); continue; }
        noteError(err, dirPath); // EACCES/EPERM/ENOENT/ENOTDIR/ELOOP/…: count it, skip it
        if (id >= 0) nodes[id].err = 1;
        return;
      }
    }
    dirs++;
    const sumMode = sum >= 0;
    if (isDead(sumMode ? sum : id)) return;
    const node = sumMode ? null : nodes[id];
    const base = dirPath === '/' ? '/' : dirPath + '/';

    // Directories (dirent type is authoritative) are queued right away so BFS keeps flowing;
    // everything else gets lstat'ed.
    const names = [];
    for (let i = 0; i < ents.length; i++) {
      const de = ents[i];
      if (de.isDirectory()) {
        const p = base + de.name;
        if (hasExclude && exclude.has(p)) continue;
        if (sumMode) enqueue(p, -1, sum);
        else addChildDir(node, de.name, p);
      } else {
        names.push(de.name);
      }
    }
    ents = null;
    if (qHead < qPath.length && inflight < concurrency) pump();

    const m = names.length;
    if (m === 0) return;
    const sizes = new Array(m);
    let next = 0;
    const lane = async () => {
      while (next < m) {
        const j = next++;
        const p = base + names[j];
        let st;
        try {
          st = await fsp.lstat(p);
        } catch (err) {
          noteError(err, p);
          sizes[j] = -1;
          continue;
        }
        if (st.isDirectory()) { sizes[j] = -2; continue; } // DT_UNKNOWN filesystems
        let sz = st.blocks;
        sz = sz === undefined ? st.size : sz * 512;
        if (st.nlink > 1) {
          const ik = st.dev + ':' + st.ino;
          if (seenInodes.has(ik)) sz = 0; else seenInodes.add(ik);
        }
        sizes[j] = sz;
      }
    };
    const L = m < statLanes ? m : statLanes;
    if (L === 1) await lane();
    else {
      const lanes = new Array(L);
      for (let i = 0; i < L; i++) lanes[i] = lane();
      await Promise.all(lanes);
    }

    // ---- finalize: one propagation per directory --------------------------------------------
    if (isDead(sumMode ? sum : id)) return;
    let total = 0, cnt = 0;
    if (sumMode) {
      for (let j = 0; j < m; j++) {
        const s = sizes[j];
        if (s >= 0) { total += s; cnt++; }
        else if (s === -2) {
          const p = base + names[j];
          if (!(hasExclude && exclude.has(p))) enqueue(p, -1, sum);
        }
      }
      files += cnt;
      scratch.fill(0);
      scratch[nodes[sum].forced] = total;
      propagate(sum, total, cnt, scratch);
    } else {
      let valid = 0;
      for (let j = 0; j < m; j++) if (sizes[j] >= 0) valid++;
      const fNames = valid ? new Array(valid) : EMPTY;
      const fSizes = valid ? new Array(valid) : EMPTY;
      const fKinds = valid ? new Array(valid) : EMPTY;
      scratch.fill(0);
      const forced = node.forced;
      for (let j = 0, w = 0; j < m; j++) {
        const s = sizes[j];
        if (s >= 0) {
          const nm = names[j];
          const k = classifyFile(nm, forced);
          fNames[w] = nm; fSizes[w] = s; fKinds[w] = k; w++;
          scratch[k] += s;
          total += s;
        } else if (s === -2) {
          const p = base + names[j];
          if (!(hasExclude && exclude.has(p))) addChildDir(node, names[j], p);
        }
      }
      cnt = valid;
      node.fNames = fNames; node.fSizes = fSizes; node.fKinds = fKinds;
      files += cnt;
      propagate(id, total, cnt, scratch);
    }
  }

  function finish() {
    scanning = false;
    t1 = now();
    if (progressTimer) { clearInterval(progressTimer); progressTimer = null; }
    if (onDone) safeCall(onDone, stats());
  }

  function safeCall(fn, arg) {
    try { fn(arg); } catch (err) { console.error('[tessera-scanner] callback failed:', err); }
  }

  // ---- public API ----------------------------------------------------------------------------
  function start() {
    if (started) return;
    started = true;
    scanning = true;
    t0 = now();
    if (onProgress) {
      progressTimer = setInterval(() => { if (scanning) safeCall(onProgress, stats()); }, progressInterval);
      if (progressTimer.unref) progressTimer.unref();
    }
    enqueue(root, 0, -1);
    pump();
  }

  function stats() {
    const end = scanning ? now() : (t1 || t0);
    return {
      files, dirs, bytes: rootNode.size, errors,
      elapsed: started ? Math.round(end - t0) : 0,
      scanning,
    };
  }

  function diagnostics() {
    return {
      nodes: nodes.length,
      queued: qPath.length - qHead,
      peakQueue,
      inflight,
      hardLinks: seenInodes.size,
      errorCodes: { ...errorCodes },
      errorSamples: errorSamples.slice(),
    };
  }

  function dirPath(id) {
    if (id === 0) return root;
    const segs = [];
    for (let n = id; n > 0; n = nodes[n].parent) segs.push(nodes[n].name);
    segs.reverse();
    return (root === '/' ? '/' : root + '/') + segs.join('/');
  }

  function getNode(id) {
    const nd = nodes[id];
    if (!nd) throw new Error(`unknown key: d${id}`);
    return nd;
  }

  function pathOf(key) {
    const r = parseKey(key);
    const nd = getNode(r.id);
    if (r.t === 'f') {
      if (r.idx >= nd.fNames.length) throw new Error(`unknown key: ${key}`);
      return dirPath(r.id) + '/' + nd.fNames[r.idx];
    }
    return dirPath(r.id); // d<id>, or a<id> → the folder holding the aggregate
  }

  function domKind(nd) {
    if (nd.pkg) return nd.forced;
    const k = nd.kinds;
    let best = -1, bv = 0;
    for (let i = 0; i < KIND_COUNT; i++) if (k[i] > bv) { bv = k[i]; best = i; }
    if (best < 0) return nd.forced >= 0 ? nd.forced : OTHER;
    return best;
  }

  function dirOut(nd) {
    if (nd.pkg) return { k: 'd' + nd.id, n: nd.name, s: nd.size, t: nd.forced, d: 1, p: 1, c: nd.count };
    return { k: 'd' + nd.id, n: nd.name, s: nd.size, t: domKind(nd), d: 1, c: nd.count };
  }

  // Adds a folded subdirectory's per-kind bytes into `acc`. Packages count fully under their
  // forced kind (the same kind their tile shows).
  function foldDir(nd, acc) {
    if (nd.pkg) { acc[nd.forced] += nd.size; return; }
    const k = nd.kinds;
    for (let i = 0; i < KIND_COUNT; i++) acc[i] += k[i];
  }

  // Kind holding the most bytes; ties go to the lower index; nothing → other.
  function argmaxKind(acc) {
    let best = OTHER, bv = 0;
    for (let i = 0; i < KIND_COUNT; i++) if (acc[i] > bv) { bv = acc[i]; best = i; }
    return best;
  }

  // Per-kind bytes of the entries folded into the aggregate being built. One buffer per scanner:
  // childrenOf() is done with it before it recurses.
  const foldKinds = new Float64Array(KIND_COUNT);

  function view(q) {
    q = q || {};
    const depth = q.depth == null ? 3 : Math.max(0, Math.floor(+q.depth) || 0);
    const minFrac = q.minFrac == null ? 0.00008 : Math.max(0, +q.minFrac || 0);
    const maxChildren = q.maxChildren == null ? 300 : Math.max(0, Math.floor(+q.maxChildren) || 0);
    const r = parseKey(q.key == null ? 'd0' : q.key);
    let nd = getNode(r.id);

    // A trashed focus falls back to its nearest live ancestor (the response's `k` says which).
    let fileIdx = r.t === 'f' ? r.idx : -1;
    if (fileIdx >= 0 && fileIdx >= nd.fNames.length) throw new Error(`unknown key: ${q.key}`);
    for (let n = nd.id; n >= 0; n = nodes[n].parent) {
      if (nodes[n].removed) { nd = nodes[nodes[n].parent]; fileIdx = -1; }
    }
    if (fileIdx >= 0 && !(nd.fSizes[fileIdx] > 0)) fileIdx = -1; // trashed (or zero-size) file

    const crumbs = [];
    for (let n = nd.id; n >= 0; n = nodes[n].parent) crumbs.push({ k: 'd' + n, n: nodes[n].name });
    crumbs.reverse();

    let out;
    if (fileIdx >= 0) {
      const s = nd.fSizes[fileIdx], t = nd.fKinds[fileIdx];
      out = { k: `f${nd.id}:${fileIdx}`, n: nd.fNames[fileIdx], s, t };
      const kinds = new Array(KIND_COUNT).fill(0);
      kinds[t] = s;
      out.kinds = kinds;
      crumbs.push({ k: out.k, n: out.n });
      out.crumbs = crumbs;
      out.path = dirPath(nd.id) + '/' + out.n;
      out.scanning = scanning;
      return out;
    }

    out = dirOut(nd);
    const minSize = nd.size * minFrac;

    const childrenOf = (dn, level) => {
      const ch = [];
      const fold = foldKinds;
      fold.fill(0);
      let positive = 0;
      const ids = dn.dirIds;
      for (let i = 0; i < ids.length; i++) {
        const c = nodes[ids[i]];
        const s = c.size;
        if (s <= 0 || c.removed) continue;
        positive++;
        if (s >= minSize) ch.push(dirOut(c));
        else foldDir(c, fold);
      }
      const sz = dn.fSizes;
      if (sz.length) {
        const nm = dn.fNames, fk = dn.fKinds, pre = 'f' + dn.id + ':';
        for (let i = 0; i < sz.length; i++) {
          const s = sz[i];
          if (s <= 0) continue;
          positive++;
          if (s >= minSize) ch.push({ k: pre + i, n: nm[i], s, t: fk[i] });
          else fold[fk[i]] += s;
        }
      }
      if (ch.length > 1) ch.sort(cmpNodes);
      if (ch.length > maxChildren) {
        for (let i = maxChildren; i < ch.length; i++) {
          const c = ch[i];
          if (c.d === 1) foldDir(nodes[+c.k.slice(1)], fold);
          else fold[c.t] += c.s;
        }
        ch.length = maxChildren;
      }
      const aggKind = argmaxKind(fold); // before recursing: the buffer is shared
      let included = 0;
      for (let i = 0; i < ch.length; i++) {
        const c = ch[i];
        included += c.s;
        if (c.d === 1 && c.p !== 1 && level < depth) {
          c.ch = childrenOf(nodes[+c.k.slice(1)], level + 1);
        }
      }
      const rest = dn.size - included;
      if (rest > 0) {
        const agg = { k: 'a' + dn.id, n: '', s: rest, t: aggKind, a: 1, c: positive - ch.length };
        let at = ch.length;
        while (at > 0 && ch[at - 1].s < rest) at--; // keep ch sorted by s desc ('' sorts first on ties)
        while (at > 0 && ch[at - 1].s === rest && ch[at - 1].n > '') at--;
        ch.splice(at, 0, agg);
      }
      return ch;
    };

    if (!nd.pkg && depth >= 1) out.ch = childrenOf(nd, 1);
    out.kinds = Array.from(nd.kinds);
    out.crumbs = crumbs;
    out.path = dirPath(nd.id);
    out.scanning = scanning;
    return out;
  }

  function subtract(fromId, bytes, count, vec) {
    for (let n = fromId; n >= 0;) {
      const a = nodes[n];
      a.size -= bytes;
      a.count -= count;
      const k = a.kinds;
      for (let i = 0; i < KIND_COUNT; i++) k[i] -= vec[i];
      n = a.parent;
    }
  }

  function remove(key) {
    const r = parseKey(key);
    if (r.t === 'a') throw new Error('cannot remove an aggregate');
    const nd = getNode(r.id);
    if (r.t === 'd') {
      if (r.id === 0) throw new Error('cannot remove the scan root');
      if (isDead(r.id)) return { freed: 0 };
      const freed = nd.size;
      nd.removed = 1;
      subtract(nd.parent, nd.size, nd.count, nd.kinds);
      return { freed };
    }
    if (r.idx >= nd.fSizes.length) throw new Error(`unknown key: ${key}`);
    if (isDead(r.id)) return { freed: 0 };
    const freed = nd.fSizes[r.idx];
    if (!(freed > 0)) return { freed: 0 };
    nd.fSizes[r.idx] = 0;
    const vec = new Float64Array(KIND_COUNT);
    vec[nd.fKinds[r.idx]] = freed;
    subtract(r.id, freed, 1, vec);
    return { freed };
  }

  return { start, view, pathOf, remove, stats, diagnostics, root, name: displayName };
}

module.exports = { createScanner };
