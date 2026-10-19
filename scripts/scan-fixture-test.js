#!/usr/bin/env node
'use strict';
// Builds a small fixture tree under <os.tmpdir()>/tessera-fixture and checks the scanner
// against it: kinds, package-as-leaf, forced kinds, hard-link de-dupe, symlinks, exclusions,
// errors, aggregates (and their dominant kind), depth, remove() bookkeeping (including a removal mid-scan).
//   node scripts/scan-fixture-test.js [--keep]
// Exit code 0 when every check passes. Only ever writes inside the fixture directory.

process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '32';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { createScanner } = require('../src/scanner/core');
const { KIND_IDS, KIND_COUNT, classifyFile, packageKind, forcedDirKind } = require('../src/scanner/kinds');

const TMP = fs.realpathSync(os.tmpdir());
const FIXTURE = path.join(TMP, 'tessera-fixture');
const ROOT = path.join(FIXTURE, 'root');
const K = Object.fromEntries(KIND_IDS.map((id, i) => [id, i]));

let failures = 0, passes = 0;
function check(cond, label, extra) {
  if (cond) { passes++; console.log(`  ok    ${label}`); }
  else { failures++; console.log(`  FAIL  ${label}${extra !== undefined ? '  → ' + JSON.stringify(extra) : ''}`); }
}

// ---- fixture ------------------------------------------------------------------------------------
function resetFixture() {
  if (path.dirname(FIXTURE) !== TMP || path.basename(FIXTURE) !== 'tessera-fixture') throw new Error('refusing to touch ' + FIXTURE);
  if (fs.existsSync(FIXTURE)) {
    // Restore permissions on the deliberately unreadable dir before removing the old fixture.
    for (const p of [path.join(ROOT, 'locked'), path.join(FIXTURE, 'locked-root')]) {
      try { fs.chmodSync(p, 0o755); } catch {}
    }
    fs.rmSync(FIXTURE, { recursive: true, force: true });
  }
  fs.mkdirSync(ROOT, { recursive: true });
}

function file(rel, bytes) {
  const p = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, Buffer.alloc(bytes, 0x5a));
  return p;
}

function buildFixture() {
  resetFixture();
  file('a/b/c/deep.txt', 10_000);
  file('a/b/c/clip.MOV', 300_000);
  file('a/b/song.mp3', 200_000);
  file('a/photo.jpg', 150_000);
  file('a/code.ts', 5_000);
  file('big.bin', 1_000_000);
  fs.linkSync(path.join(ROOT, 'big.bin'), path.join(ROOT, 'big-hardlink.bin'));
  fs.symlinkSync('a', path.join(ROOT, 'link-to-a'));
  fs.symlinkSync('big.bin', path.join(ROOT, 'link-to-big'));
  file('Foo.app/Contents/Info.plist', 2_000);
  file('Foo.app/Contents/MacOS/Foo', 400_000);
  file('Foo.app/Contents/Resources/icon.png', 100_000);
  file('Foo.app/Contents/Resources/en.lproj/Localizable.strings', 3_000);
  file('Foo.app/Contents/Frameworks/Bar.framework/Bar', 120_000);
  file('node_modules/pkg/index.js', 8_000);
  file('node_modules/pkg/readme.md', 50_000);
  file('node_modules/pkg/logo.png', 60_000);
  file('node_modules/electron/dist/Electron.app/Contents/MacOS/Electron', 80_000);
  file('Library/Caches/com.foo/cache.db', 70_000);
  file('Library/Caches/video.mp4', 90_000);
  file('Library/Docs/report.pdf', 40_000);
  file('many/big.zip', 500_000);
  for (let i = 0; i < 200; i++) file(`many/tiny-${String(i).padStart(3, '0')}.dat`, 1_000);
  // Aggregate kinds. pngs/: the big video decides the dir's kind, the folded tiny photos decide the
  // aggregate's. mixed/: tiny dirs where the byte majority (documents) is neither the count majority
  // (audio) nor what extensions alone would say (the .app's .mp3 counts as apps, not audio).
  file('pngs/big.mov', 1_000_000);
  for (let i = 0; i < 150; i++) file(`pngs/icon-${String(i).padStart(3, '0')}.png`, 1_000);
  file('mixed/anchor.bin', 1_500_000);
  for (let i = 0; i < 6; i++) file(`mixed/aud-${i}/track.mp3`, 3_000);
  for (let i = 0; i < 2; i++) file(`mixed/doc-${i}/paper.pdf`, 16_000);
  file('mixed/Widget.app/Contents/Resources/song.mp3', 12_000);
  // blend/: two tiny dirs that are mostly audio, one that is all documents. Per-kind bytes say
  // documents; summing each dir under its own dominant kind would say audio.
  file('blend/anchor.bin', 1_500_000);
  for (const d of ['p', 'q']) { file(`blend/${d}/a.mp3`, 8_000); file(`blend/${d}/b.pdf`, 4_000); }
  file('blend/r/c.pdf', 12_000);
  // tie/: equal folded bytes of audio (3) and documents (4) → the lower index wins.
  file('tie/anchor.bin', 1_500_000);
  file('tie/a-doc/x.pdf', 3_000);
  file('tie/b-aud/x.mp3', 3_000);
  file('.git/objects/ab/cdef', 20_000);
  file('excluded/junk.bin', 300_000);
  file('zero.txt', 0);
  fs.mkdirSync(path.join(ROOT, 'empty-dir'));
  file('locked/secret.txt', 7_000);
  fs.chmodSync(path.join(ROOT, 'locked'), 0o000);
  // Bulk subtree for the mid-scan removal test: 12 × 6 dirs × 8 files.
  for (let i = 0; i < 12; i++) {
    for (let j = 0; j < 6; j++) {
      for (let f = 0; f < 8; f++) file(`bulk/g${i}/h${j}/f${f}.log`, 2_000 + 500 * f);
    }
  }
  fs.mkdirSync(path.join(FIXTURE, 'locked-root'));
  fs.chmodSync(path.join(FIXTURE, 'locked-root'), 0o000);
}

// Independent reference walk (sync): allocated bytes, de-duped hard links, no symlink follow.
function referenceTotals(dir, exclude) {
  const seen = new Set();
  let bytes = 0, files = 0, errors = 0;
  const walk = (d) => {
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { errors++; return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!exclude.includes(p)) walk(p); continue; }
      const st = fs.lstatSync(p);
      files++;
      if (st.nlink > 1) { const k = st.dev + ':' + st.ino; if (seen.has(k)) continue; seen.add(k); }
      bytes += st.blocks * 512;
    }
  };
  walk(dir);
  return { bytes, files, errors };
}

function scan(root, opts = {}) {
  return new Promise((resolve) => {
    const sc = createScanner({ root, name: opts.name || 'Fixture', exclude: opts.exclude || [], onDone: (s) => resolve({ sc, s }) });
    if (opts.beforeStart) opts.beforeStart(sc);
    sc.start();
    if (opts.afterStart) opts.afterStart(sc);
  });
}

const childByName = (v, n) => (v.ch || []).find((c) => c.n === n);
const allocated = (rel) => fs.lstatSync(path.join(ROOT, rel)).blocks * 512;

// Every visible dir must add up exactly (minFrac 0 ⇒ nothing folded ⇒ no aggregates).
function checkInvariants(v, label) {
  let bad = null;
  const visit = (n) => {
    if (!n.ch) return;
    let sum = 0;
    for (const c of n.ch) {
      if (c.a) bad = bad || { at: n.k, why: 'aggregate with minFrac 0', c };
      if (!(c.s > 0)) bad = bad || { at: n.k, why: 'zero-size child', c };
      sum += c.s;
      visit(c);
    }
    if (sum !== n.s) bad = bad || { at: n.k, why: 'children do not sum', s: n.s, sum };
    for (let i = 1; i < n.ch.length; i++) {
      const a = n.ch[i - 1], b = n.ch[i];
      if (a.s < b.s || (a.s === b.s && a.n > b.n)) bad = bad || { at: n.k, why: 'unsorted', a: a.k, b: b.k };
    }
  };
  visit(v);
  const kindSum = v.kinds.reduce((x, y) => x + y, 0);
  check(!bad, `${label}: every dir's ch sums to s, sorted, no aggregates`, bad);
  check(kindSum === v.s, `${label}: Σ kinds === s`, { kindSum, s: v.s });
}

const FULL = { depth: 1e9, minFrac: 0, maxChildren: 1e9 };

// Ties → lower index; nothing → other.
function argmax(vec) {
  let best = K.other, bv = 0;
  for (let i = 0; i < KIND_COUNT; i++) if (vec[i] > bv) { bv = vec[i]; best = i; }
  return best;
}

// Independent recomputation for every aggregate in a view: what it folds is its dir's kinds minus
// the kinds of the siblings that made it into ch (dirs via their own depth-0 view, files via t/s).
function checkAggregateKinds(sc, view, label) {
  let n = 0, bad = null;
  const visit = (node) => {
    if (!node.ch) return;
    const agg = node.ch.find((c) => c.a === 1);
    if (agg) {
      const rest = sc.view({ key: node.k, depth: 0 }).kinds.slice();
      for (const c of node.ch) {
        if (c.a) continue;
        if (c.d) {
          const kv = sc.view({ key: c.k, depth: 0 }).kinds;
          for (let i = 0; i < KIND_COUNT; i++) rest[i] -= kv[i];
        } else rest[c.t] -= c.s;
      }
      n++;
      const want = argmax(rest);
      if (agg.t !== want) bad = bad || { at: node.k, got: agg.t, want, rest };
    }
    for (const c of node.ch) visit(c);
  };
  visit(view);
  check(n >= 2 && !bad, `${label}: every aggregate's t = byte-majority kind of what it folds`, bad || { aggregates: n });
}

async function main() {
  console.log('kinds.js');
  check(classifyFile('index.ts', -1) === K.developer, '.ts is developer');
  check(classifyFile('CLIP.MOV', -1) === K.video, 'uppercase .MOV is video');
  check(classifyFile('stream.mts', -1) === K.video, '.mts is video');
  check(classifyFile('a.tar.gz', -1) === K.archives, '.tar.gz is archives');
  check(classifyFile('.DS_Store', -1) === K.system, '.DS_Store is system');
  check(classifyFile('Makefile', -1) === K.developer, 'Makefile is developer');
  check(classifyFile('README', -1) === K.other, 'no extension → other');
  check(classifyFile('photo.jpg', K.developer) === K.developer, 'forced kind wins over extension');
  check(packageKind('Foo.APP') === K.apps && packageKind('X.dSYM') === K.developer &&
    packageKind('Photos Library.photoslibrary') === K.photos && packageKind('plain') === -1 &&
    packageKind('Thing.prefPane') === K.apps, 'packageKind table (case-insensitive)');
  check(forcedDirKind('node_modules', 'x') === K.developer && forcedDirKind('Caches', 'Library') === K.system &&
    forcedDirKind('Caches', 'Other') === -1 && forcedDirKind('src', 'x') === -1, 'forcedDirKind');
  check(KIND_COUNT === 9 && KIND_IDS[6] === 'developer', 'KIND_COUNT / KIND_IDS');

  buildFixture();
  const exclude = [path.join(ROOT, 'excluded')];
  const ref = referenceTotals(ROOT, exclude);

  console.log('\nfull scan');
  let viewBefore = null, viewDuring = null;
  const { sc, s } = await scan(ROOT, {
    exclude,
    beforeStart: (x) => { viewBefore = x.view({ key: 'd0' }); },
    afterStart: (x) => { viewDuring = x.view({ key: 'd0' }); },
  });
  check(viewBefore && viewBefore.k === 'd0' && viewBefore.s === 0 && viewBefore.scanning === false &&
    Array.isArray(viewBefore.ch) && viewBefore.ch.length === 0, 'view before start: empty root');
  check(viewDuring && viewDuring.scanning === true, 'view right after start answers with scanning: true');
  check(s.bytes === ref.bytes, 'total bytes match reference walk', { scan: s.bytes, ref: ref.bytes });
  check(s.files === ref.files, 'file count matches reference walk', { scan: s.files, ref: ref.files });
  check(s.errors === 1, 'unreadable dir counts as exactly 1 error', s.errors);
  // du exits 1 here because of the unreadable dir, but still prints the total.
  const du = Number(String(spawnSync('du', ['-sk', ROOT], { encoding: 'utf8' }).stdout).split(/\s/)[0]) * 1024;
  const excludedBytes = allocated('excluded/junk.bin');
  check(s.bytes === du - excludedBytes, 'total = du -sk minus the excluded dir', { scan: s.bytes, du, excludedBytes });

  const v = sc.view({ key: 'd0', depth: 3, minFrac: 0, maxChildren: 300 });
  check(v.n === 'Fixture' && v.path === ROOT && v.crumbs.length === 1 && v.crumbs[0].k === 'd0', 'root view header (name, path, crumbs)');
  check(v.scanning === false && v.d === 1 && v.c === s.files, 'root: d:1, c = files, scanning false', { c: v.c });

  const app = childByName(v, 'Foo.app');
  const appBytes = ['Info.plist', 'MacOS/Foo', 'Resources/icon.png', 'Resources/en.lproj/Localizable.strings',
    'Frameworks/Bar.framework/Bar'].reduce((a, r) => a + allocated('Foo.app/Contents/' + r), 0);
  check(app && app.p === 1 && app.d === 1 && app.t === K.apps && !('ch' in app), 'Foo.app is a leaf package of kind apps', app);
  check(app && app.s === appBytes && app.c === 5, 'Foo.app size/count summed from its (unstored) contents', { s: app && app.s, appBytes, c: app && app.c });
  check(sc.view({ key: app.k }).ch === undefined && sc.view({ key: app.k }).p === 1, 'package focus has no ch');

  const nm = childByName(v, 'node_modules');
  check(nm && nm.t === K.developer && !nm.p, 'node_modules: developer, expandable');
  const pkg = nm && childByName(nm, 'pkg');
  check(pkg && pkg.ch.every((c) => c.t === K.developer), 'files inside node_modules are developer (readme.md, logo.png)', pkg && pkg.ch.map((c) => [c.n, c.t]));
  const nmView = sc.view({ key: nm.k, depth: 5, minFrac: 0 });
  const eapp = childByName(childByName(childByName(nmView, 'electron'), 'dist'), 'Electron.app');
  check(eapp && eapp.p === 1 && eapp.t === K.apps, 'Electron.app inside node_modules: package wins (apps)', eapp);

  const lib = childByName(v, 'Library');
  const caches = lib && childByName(lib, 'Caches');
  check(caches && caches.t === K.system && childByName(caches, 'video.mp4').t === K.system,
    'Library/Caches forces system (video.mp4 → system)');
  check(childByName(childByName(lib, 'Docs'), 'report.pdf').t === K.documents, 'Library/Docs/report.pdf stays documents');
  const git = childByName(v, '.git');
  check(git && git.t === K.developer, '.git is developer');

  const a = childByName(v, 'a');
  check(childByName(a, 'code.ts').t === K.developer && childByName(a, 'photo.jpg').t === K.photos, 'a/: code.ts developer, photo.jpg photos');
  const aDeep = sc.view({ key: a.k, depth: 3, minFrac: 0 });
  check(childByName(childByName(childByName(aDeep, 'b'), 'c'), 'clip.MOV').t === K.video, 'a/b/c/clip.MOV is video');
  check(aDeep.crumbs.map((c) => c.n).join('/') === 'Fixture/a' && aDeep.path === path.join(ROOT, 'a'), 'crumbs/path of a sub-focus');

  const bigs = (v.ch || []).filter((c) => c.n === 'big.bin' || c.n === 'big-hardlink.bin');
  check(bigs.length === 1 && bigs[0].s === allocated('big.bin'), 'hard link counted once (one of the pair is visible)', bigs.map((x) => [x.n, x.s]));
  check(!childByName(v, 'excluded'), 'excluded dir never scanned');
  const linkA = childByName(v, 'link-to-a');
  check(!linkA || (!linkA.d && linkA.s === fs.lstatSync(path.join(ROOT, 'link-to-a')).blocks * 512), 'symlink to dir is not followed', linkA);
  check(!childByName(v, 'zero.txt') && !childByName(v, 'empty-dir'), 'zero-size entries are not emitted');
  const locked = sc.view({ key: 'd0', depth: 1, minFrac: 0 });
  check(!childByName(locked, 'locked'), 'unreadable dir has no bytes → not emitted');

  checkInvariants(sc.view({ key: 'd0', ...FULL }), 'full view');

  console.log('\ndepth / aggregate');
  const d1 = sc.view({ key: 'd0', depth: 1, minFrac: 0 });
  check(d1.ch.length > 0 && d1.ch.every((c) => !('ch' in c)), 'depth 1: children carry no ch');
  const d2 = sc.view({ key: 'd0', depth: 2, minFrac: 0 });
  const a2 = childByName(d2, 'a');
  check(Array.isArray(a2.ch) && a2.ch.every((c) => !('ch' in c)), 'depth 2: level-1 dirs have ch, level-2 dirs do not');
  const d0 = sc.view({ key: 'd0', depth: 0 });
  check(!('ch' in d0), 'depth 0: focus without ch');

  const manyKey = childByName(v, 'many').k;
  const many = sc.view({ key: manyKey, depth: 1, minFrac: 0, maxChildren: 5 });
  const agg = many.ch.find((c) => c.a === 1);
  const incl = many.ch.filter((c) => !c.a);
  check(incl.length === 5 && agg && agg.k === 'a' + manyKey.slice(1) && agg.n === '' && agg.t === K.system,
    'maxChildren 5 → 5 children + aggregate a<id> (196 folded .dat files → t system)', many.ch.map((c) => [c.k, c.t]));
  check(agg && agg.s === many.s - incl.reduce((x, c) => x + c.s, 0) && agg.c === 196,
    'aggregate s = dir.s − Σ included, c = folded entries (196)', agg);
  const many2 = sc.view({ key: manyKey, depth: 1, minFrac: 0.01 });
  const agg2 = many2.ch.find((c) => c.a);
  check(many2.ch.length === 2 && childByName(many2, 'big.zip') && agg2 && agg2.c === 200 && many2.ch[0] === agg2,
    'minFrac 0.01 folds the 200 tiny files into one aggregate (sorted by s, so it comes first here)',
    many2.ch.map((c) => [c.n, c.s, c.c]));
  check(sc.pathOf(agg.k) === path.join(ROOT, 'many') && sc.pathOf(manyKey) === path.join(ROOT, 'many'), 'pathOf(aggregate) → its folder');

  console.log('\naggregate kind');
  const pngs = sc.view({ key: childByName(v, 'pngs').k, depth: 1, minFrac: 0.01 });
  const pngAgg = pngs.ch.find((c) => c.a);
  check(pngs.t === K.video && childByName(pngs, 'big.mov') && pngs.ch.length === 2 && pngAgg &&
    pngAgg.c === 150 && pngAgg.t === K.photos,
    'pngs/: 150 tiny .png fold to an aggregate with t photos (dir itself is video)',
    { dirT: pngs.t, ch: pngs.ch.map((c) => [c.n, c.s, c.t, c.c]) });

  const mixed = sc.view({ key: childByName(v, 'mixed').k, depth: 1, minFrac: 0.05 });
  const mixAgg = mixed.ch.find((c) => c.a);
  const sumAlloc = (rels) => rels.reduce((x, r) => x + allocated(r), 0);
  const audB = sumAlloc([0, 1, 2, 3, 4, 5].map((i) => `mixed/aud-${i}/track.mp3`));
  const docB = sumAlloc(['mixed/doc-0/paper.pdf', 'mixed/doc-1/paper.pdf']);
  const appB = allocated('mixed/Widget.app/Contents/Resources/song.mp3');
  check(docB > audB && docB > appB && audB + appB > docB, 'mixed/ fixture: documents lead by bytes only if the .app counts as apps',
    { audB, docB, appB });
  check(mixed.ch.length === 2 && childByName(mixed, 'anchor.bin') && mixAgg && mixAgg.c === 9 && mixAgg.t === K.documents,
    'mixed/: fold of 9 tiny dirs (6 audio, 2 documents, 1 .app) → t documents (byte majority, package as apps)',
    mixed.ch.map((c) => [c.n, c.s, c.t, c.c]));

  const mixedTrunc = sc.view({ key: mixed.k, depth: 1, minFrac: 0, maxChildren: 1 });
  const mixTruncAgg = mixedTrunc.ch.find((c) => c.a);
  check(mixedTrunc.ch.length === 2 && mixTruncAgg && mixTruncAgg.c === 9 && mixTruncAgg.t === K.documents,
    'mixed/ with maxChildren 1: dirs folded by truncation (not minFrac) → t documents', mixedTrunc.ch.map((c) => [c.n, c.s, c.t, c.c]));

  const blendKey = childByName(v, 'blend').k;
  const blendAud = allocated('blend/p/a.mp3') + allocated('blend/q/a.mp3');
  const blendDoc = allocated('blend/p/b.pdf') + allocated('blend/q/b.pdf') + allocated('blend/r/c.pdf');
  const blendDirs = sc.view({ key: blendKey, depth: 2, minFrac: 0 }).ch.filter((c) => c.d);
  check(blendDoc > blendAud && blendDirs.filter((c) => c.t === K.audio).length === 2,
    'blend/ fixture: documents lead by bytes, but 2 of 3 dirs are audio-dominant', { blendAud, blendDoc });
  const blendA = sc.view({ key: blendKey, depth: 1, minFrac: 0.05 }).ch.find((c) => c.a);
  const blendB = sc.view({ key: blendKey, depth: 1, minFrac: 0, maxChildren: 1 }).ch.find((c) => c.a);
  check(blendA && blendA.c === 3 && blendA.t === K.documents && blendB && blendB.c === 3 && blendB.t === K.documents,
    'blend/: mixed-kind dirs fold by per-kind bytes → documents (via minFrac and via maxChildren)', [blendA, blendB]);

  const tie = sc.view({ key: childByName(v, 'tie').k, depth: 1, minFrac: 0.05 });
  const tieAgg = tie.ch.find((c) => c.a);
  check(allocated('tie/a-doc/x.pdf') === allocated('tie/b-aud/x.mp3') && tieAgg && tieAgg.c === 2 && tieAgg.t === K.audio,
    'tie/: equal folded bytes of audio and documents → lower index (audio)', tie.ch.map((c) => [c.n, c.s, c.t, c.c]));

  checkAggregateKinds(sc, sc.view({ key: 'd0', depth: 3, minFrac: 0.01, maxChildren: 300 }), 'root view, minFrac 0.01');
  checkAggregateKinds(sc, sc.view({ key: 'd0', depth: 3, minFrac: 0, maxChildren: 3 }), 'root view, maxChildren 3 (dirs truncated)');

  console.log('\nremove()');
  const photo = childByName(a, 'photo.jpg');
  check(sc.pathOf(photo.k) === path.join(ROOT, 'a/photo.jpg'), 'pathOf(file key)');
  const before = sc.view({ key: 'd0', depth: 1, minFrac: 0 });
  const aBefore = childByName(before, 'a');
  const r1 = sc.remove(photo.k);
  const after1 = sc.view({ key: 'd0', depth: 2, minFrac: 0 });
  check(r1.freed === allocated('a/photo.jpg'), 'remove(file) returns freed = its allocated size', r1);
  check(after1.s === before.s - r1.freed && after1.c === before.c - 1, 'root s and c drop by the file');
  check(after1.kinds[K.photos] === before.kinds[K.photos] - r1.freed, 'root kinds[photos] drops by the file');
  check(childByName(after1, 'a').s === aBefore.s - r1.freed && !childByName(childByName(after1, 'a'), 'photo.jpg'),
    'parent dir updated, file gone from view');
  check(sc.remove(photo.k).freed === 0, 'removing the same file twice frees 0');

  const r2 = sc.remove(app.k);
  const after2 = sc.view({ key: 'd0', depth: 1, minFrac: 0 });
  check(r2.freed === appBytes && after2.s === after1.s - appBytes && after2.kinds[K.apps] === after1.kinds[K.apps] - appBytes &&
    after2.c === after1.c - 5, 'remove(package dir) subtracts bytes, count and kinds');
  check(!childByName(after2, 'Foo.app'), 'removed package no longer in view');
  const fallback = sc.view({ key: app.k });
  check(fallback.k === 'd0', 'view of a removed dir falls back to its nearest live ancestor', fallback.k);
  const cKey = childByName(childByName(a, 'b'), 'c').k;
  const bKey = childByName(a, 'b').k;
  sc.remove(bKey);
  check(sc.remove(cKey).freed === 0, 'removing inside an already-removed subtree frees 0');
  let threw = 0;
  for (const k of ['d0', agg.k, 'd99999', 'f0:9999', 'zz']) { try { sc.remove(k); } catch { threw++; } }
  check(threw === 5, 'remove rejects root, aggregates and unknown keys');
  checkInvariants(sc.view({ key: 'd0', ...FULL }), 'after removals');
  checkAggregateKinds(sc, sc.view({ key: 'd0', depth: 3, minFrac: 0.01, maxChildren: 4 }), 'after removals');

  console.log('\nremove() mid-scan');
  const bulkPath = path.join(ROOT, 'bulk', 'g3');
  const bulkRef = referenceTotals(bulkPath, []);
  let removedMid = null;
  const { sc: sc2, s: s2 } = await scan(ROOT, {
    exclude,
    afterStart: (x) => {
      // Poll the partial tree until bulk/g3 is discovered, then trash it while the scan is running.
      const tick = () => {
        if (removedMid || !x.stats().scanning) return;
        for (let id = 1; id < 400; id++) {
          let p; try { p = x.pathOf('d' + id); } catch { break; }
          if (p === bulkPath) { removedMid = { at: x.stats(), freed: x.remove('d' + id).freed, key: 'd' + id }; return; }
        }
        setImmediate(tick);
      };
      setImmediate(tick);
    },
  });
  check(removedMid && removedMid.at.scanning, 'bulk/g3 removed while scanning', removedMid);
  check(s2.bytes === ref.bytes - bulkRef.bytes, 'final total = reference − whole removed subtree (late propagation skipped)',
    { got: s2.bytes, want: ref.bytes - bulkRef.bytes, freedAtRemoval: removedMid && removedMid.freed });
  checkInvariants(sc2.view({ key: 'd0', ...FULL }), 'mid-scan removal');

  console.log('\nerror roots');
  const { s: s3 } = await scan(path.join(FIXTURE, 'locked-root'));
  check(s3.errors === 1 && s3.bytes === 0 && s3.scanning === false, 'unreadable root still finishes with done', s3);
  const { s: s4, sc: sc4 } = await scan(path.join(FIXTURE, 'does-not-exist'));
  check(s4.errors === 1 && sc4.view({ key: 'd0' }).ch.length === 0, 'missing root finishes with done, empty view', s4);
  const { s: s5 } = await scan(path.join(ROOT, 'big.bin'));
  check(s5.errors === 1 && s5.bytes === 0, 'file as root: ENOTDIR counted, done', s5);

  console.log(`\n${passes} passed, ${failures} failed`);
  if (!process.argv.includes('--keep')) {
    try { fs.chmodSync(path.join(ROOT, 'locked'), 0o755); fs.chmodSync(path.join(FIXTURE, 'locked-root'), 0o755); } catch {}
  }
  process.exit(failures ? 1 : 0);
}

main().catch((err) => { console.error(err); process.exit(1); });
