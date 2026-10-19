#!/usr/bin/env node
'use strict';
// Scanner benchmark / smoke harness (plain Node, no Electron):
//   node scripts/scan-bench.js <path> [--json] [--no-du] [--du-timeout=<sec>] [--exclude=<abs path>]…
//                                     [--concurrency=<n>] [--lanes=<n>]
// Progress lines go to stderr; the report (or JSON with --json) goes to stdout.

// Must happen before the first fs call so libuv sizes its threadpool accordingly.
process.env.UV_THREADPOOL_SIZE = process.env.UV_THREADPOOL_SIZE || '32';

const path = require('path');
const { spawn } = require('child_process');
const { createScanner } = require('../src/scanner/core');
const { KIND_IDS } = require('../src/scanner/kinds');

const VIEW_OPTS = { key: 'd0', depth: 3, minFrac: 0.00008, maxChildren: 300 };

function parseArgs(argv) {
  const a = { target: null, json: false, du: true, duTimeout: 600, exclude: [], concurrency: 0, lanes: 0 };
  for (const arg of argv) {
    if (arg === '--json') a.json = true;
    else if (arg === '--no-du') a.du = false;
    else if (arg.startsWith('--du-timeout=')) a.duTimeout = Number(arg.split('=')[1]) || a.duTimeout;
    else if (arg.startsWith('--exclude=')) a.exclude.push(path.resolve(arg.slice(10)));
    else if (arg.startsWith('--concurrency=')) a.concurrency = Number(arg.split('=')[1]) | 0;
    else if (arg.startsWith('--lanes=')) a.lanes = Number(arg.split('=')[1]) | 0;
    else if (arg === '-h' || arg === '--help') a.help = true;
    else if (!a.target) a.target = arg;
    else throw new Error(`unexpected argument: ${arg}`);
  }
  return a;
}

function human(bytes) {
  const units = ['B', 'kB', 'MB', 'GB', 'TB', 'PB'];
  let v = Math.abs(bytes), u = 0;
  while (v >= 1000 && u < units.length - 1) { v /= 1000; u++; }
  const s = u === 0 ? String(v) : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return (bytes < 0 ? '-' : '') + s + ' ' + units[u];
}

function countNodes(n) {
  let c = 1;
  if (n.ch) for (const x of n.ch) c += countNodes(x);
  return c;
}

function findNode(n, pred) {
  if (pred(n)) return n;
  if (n.ch) for (const x of n.ch) { const r = findNode(x, pred); if (r) return r; }
  return null;
}

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function timeView(scanner, opts, runs) {
  const times = [];
  let res = null;
  for (let i = 0; i < runs; i++) {
    const t = performance.now();
    res = scanner.view(opts);
    times.push(performance.now() - t);
  }
  return { res, ms: median(times), min: Math.min(...times), max: Math.max(...times) };
}

function runDu(target, timeoutSec) {
  return new Promise((resolve) => {
    const t = performance.now();
    let out = '', err = '', timedOut = false;
    const child = spawn('du', ['-sk', target], { stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutSec * 1000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { if (err.length < 1e6) err += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      const ms = performance.now() - t;
      if (timedOut) return resolve({ ok: false, reason: `timed out after ${timeoutSec}s`, ms });
      const m = /^(\d+)\s/m.exec(out.trim().split('\n').pop() || '');
      if (!m) return resolve({ ok: false, reason: `no output (exit ${code})`, ms });
      const errLines = err ? err.trim().split('\n').length : 0;
      resolve({ ok: true, kb: Number(m[1]), bytes: Number(m[1]) * 1024, exit: code, errLines, ms });
    });
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, reason: e.message, ms: 0 }); });
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.target) {
    console.error('usage: node scripts/scan-bench.js <path> [--json] [--no-du] [--du-timeout=<sec>] ' +
      '[--exclude=<abs path>]… [--concurrency=<n>] [--lanes=<n>]');
    process.exit(args.help ? 0 : 2);
  }
  const target = path.resolve(args.target);
  const log = (...xs) => { if (!args.json) console.log(...xs); };
  const report = { path: target, threadpool: Number(process.env.UV_THREADPOOL_SIZE) };

  let midScan = null;
  let lastLine = 0;
  let scanner;
  const done = new Promise((resolve) => {
    scanner = createScanner({
      root: target,
      name: path.basename(target) || target,
      exclude: args.exclude,
      concurrency: args.concurrency || undefined,
      statConcurrency: args.lanes || undefined,
      onProgress(s) {
        // One mid-scan query, to prove the partial tree answers while the walk is running.
        if (!midScan && s.elapsed >= 300) {
          const t = performance.now();
          const v = scanner.view(VIEW_OPTS);
          midScan = { atMs: s.elapsed, ms: performance.now() - t, nodes: countNodes(v), files: s.files, scanning: v.scanning };
        }
        if (s.elapsed - lastLine >= 500) {
          lastLine = s.elapsed;
          process.stderr.write(`  … ${(s.elapsed / 1000).toFixed(1)}s  ${s.files.toLocaleString()} files  ` +
            `${s.dirs.toLocaleString()} dirs  ${human(s.bytes)}  ${s.errors} errors\n`);
        }
      },
      onDone: resolve,
    });
  });

  const mem0 = process.memoryUsage();
  const elu0 = performance.eventLoopUtilization();
  const cpu0 = process.cpuUsage();
  scanner.start();
  const s = await done;
  const elu = performance.eventLoopUtilization(elu0);
  const cpu = process.cpuUsage(cpu0);
  report.eventLoopUtilization = +elu.utilization.toFixed(3);
  report.cpuSeconds = { user: +(cpu.user / 1e6).toFixed(2), system: +(cpu.system / 1e6).toFixed(2) };
  const diag = scanner.diagnostics();
  const mem = process.memoryUsage();
  Object.assign(report, {
    files: s.files, dirs: s.dirs, bytes: s.bytes, errors: s.errors, elapsedMs: s.elapsed,
    filesPerSec: Math.round(s.files / Math.max(s.elapsed, 1) * 1000),
    nodes: diag.nodes, peakQueue: diag.peakQueue, hardLinkInodes: diag.hardLinks,
    errorCodes: diag.errorCodes, errorSamples: diag.errorSamples.slice(0, 12),
    memory: { rssMB: +(mem.rss / 1e6).toFixed(1), heapUsedMB: +(mem.heapUsed / 1e6).toFixed(1),
      heapDeltaMB: +((mem.heapUsed - mem0.heapUsed) / 1e6).toFixed(1) },
    midScanView: midScan,
  });

  log(`\nScanned ${target}`);
  log(`  files    ${s.files.toLocaleString()}`);
  log(`  dirs     ${s.dirs.toLocaleString()}   (nodes stored: ${diag.nodes.toLocaleString()}, peak queue ${diag.peakQueue.toLocaleString()})`);
  log(`  bytes    ${human(s.bytes)}  (${s.bytes.toLocaleString()} B)`);
  log(`  errors   ${s.errors}${s.errors ? '  ' + JSON.stringify(diag.errorCodes) : ''}`);
  log(`  elapsed  ${(s.elapsed / 1000).toFixed(2)} s   (${report.filesPerSec.toLocaleString()} files/s, threadpool ${report.threadpool})`);
  log(`  memory   rss ${report.memory.rssMB} MB, heap ${report.memory.heapUsedMB} MB`);
  log(`  cpu      user ${report.cpuSeconds.user} s, sys ${report.cpuSeconds.system} s, main-thread busy ${(report.eventLoopUtilization * 100).toFixed(0)} %`);
  if (diag.errorSamples.length) {
    log('  first errors:');
    for (const e of diag.errorSamples.slice(0, 8)) log('    ' + e);
  }
  if (midScan) {
    log(`  mid-scan view at ${(midScan.atMs / 1000).toFixed(1)}s: ${midScan.ms.toFixed(2)} ms, ${midScan.nodes} nodes (scanning=${midScan.scanning})`);
  }

  // ---- view latency ------------------------------------------------------------------------
  scanner.view(VIEW_OPTS); // warm-up
  const tv = timeView(scanner, VIEW_OPTS, 20);
  const rootView = tv.res;
  const jsonBytes = Buffer.byteLength(JSON.stringify(rootView));
  report.view = { opts: VIEW_OPTS, medianMs: +tv.ms.toFixed(3), minMs: +tv.min.toFixed(3),
    maxMs: +tv.max.toFixed(3), nodes: countNodes(rootView), jsonBytes };
  log(`\nview(d0, depth 3, minFrac 0.00008, maxChildren 300): median ${tv.ms.toFixed(2)} ms ` +
    `(min ${tv.min.toFixed(2)}, max ${tv.max.toFixed(2)}) over 20 runs, ${report.view.nodes} nodes, ` +
    `${(jsonBytes / 1024).toFixed(0)} KiB JSON`);

  const kids = rootView.ch || [];
  report.top10 = kids.slice(0, 10).map((c) => ({ k: c.k, name: c.a ? '(smaller items)' : c.n, size: c.s,
    kind: KIND_IDS[c.t], pkg: !!c.p, dir: !!c.d, count: c.c }));
  log('\nTop 10 root children:');
  for (const c of report.top10) {
    log(`  ${human(c.size).padStart(10)}  ${c.kind.padEnd(10)} ${c.name}${c.dir && !c.pkg ? '/' : ''}` +
      `${c.pkg ? '  [package]' : ''}${c.count != null ? `  (${c.count.toLocaleString()} ${c.k[0] === 'a' ? 'items' : 'files'})` : ''}`);
  }
  log('  kinds: ' + rootView.kinds.map((b, i) => `${KIND_IDS[i]} ${human(b)}`).join(', '));

  // ---- largest child dir view ----------------------------------------------------------------
  const big = kids.find((c) => c.d && !c.p);
  if (big) {
    const opts = { ...VIEW_OPTS, key: big.k };
    const tb = timeView(scanner, opts, 20);
    report.largestChild = { key: big.k, name: big.n, size: big.s, medianMs: +tb.ms.toFixed(3),
      nodes: countNodes(tb.res), crumbs: tb.res.crumbs.map((c) => c.n), path: tb.res.path };
    log(`\nview(${big.k} "${big.n}"): median ${tb.ms.toFixed(2)} ms, ${report.largestChild.nodes} nodes, ` +
      `path ${tb.res.path}, crumbs ${tb.res.crumbs.map((c) => c.n).join(' › ')}`);
  }

  // ---- pathOf ----------------------------------------------------------------------------------
  const fileNode = findNode(rootView, (n) => n.k[0] === 'f');
  const aggNode = findNode(rootView, (n) => n.a === 1);
  report.pathOf = {};
  if (fileNode) {
    report.pathOf.file = { key: fileNode.k, path: scanner.pathOf(fileNode.k) };
    log(`pathOf(${fileNode.k}) → ${report.pathOf.file.path}`);
  }
  if (aggNode) {
    const parentKey = 'd' + aggNode.k.slice(1);
    report.pathOf.aggregateParent = { key: parentKey, path: scanner.pathOf(parentKey),
      viaAggregateKey: scanner.pathOf(aggNode.k), aggregate: { size: aggNode.s, count: aggNode.c } };
    log(`pathOf(${parentKey}) [parent of ${aggNode.k}: ${human(aggNode.s)} in ${aggNode.c} items] → ${report.pathOf.aggregateParent.path}`);
  }

  // ---- du comparison ----------------------------------------------------------------------------
  if (args.du) {
    process.stderr.write(`  running du -sk (timeout ${args.duTimeout}s)…\n`);
    const du = await runDu(target, args.duTimeout);
    if (du.ok) {
      const diffPct = du.bytes ? ((s.bytes - du.bytes) / du.bytes) * 100 : 0;
      report.du = { bytes: du.bytes, diffBytes: s.bytes - du.bytes, diffPct: +diffPct.toFixed(4),
        seconds: +(du.ms / 1000).toFixed(1), exit: du.exit, stderrLines: du.errLines };
      log(`\ndu -sk: ${human(du.bytes)} (${du.kb.toLocaleString()} KB) in ${(du.ms / 1000).toFixed(1)} s` +
        `${du.errLines ? `, ${du.errLines} du error lines` : ''}`);
      log(`scan vs du: ${diffPct >= 0 ? '+' : ''}${diffPct.toFixed(4)} %  (${human(s.bytes - du.bytes)})`);
    } else {
      report.du = { skipped: du.reason };
      log(`\ndu comparison skipped: ${du.reason}`);
    }
  }

  if (args.json) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
