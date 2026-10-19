'use strict';
// utilityProcess entry for the Tessera scanner. Wires core.js to process.parentPort following
// docs/SPEC.md "Scanner process protocol". One scan per process lifetime: main kills this process
// to cancel or to start another scan.
//
// Main forks it with env UV_THREADPOOL_SIZE=32. The default below only applies if main forgot,
// and only takes effect if libuv's threadpool hasn't started yet.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = '32';

const port = process.parentPort;
if (!port || typeof port.on !== 'function' || typeof port.postMessage !== 'function') {
  console.error(
    '[tessera-scanner] worker.js must be started with Electron utilityProcess.fork(); ' +
    'process.parentPort is not available in this runtime. ' +
    'To scan from plain Node use: node scripts/scan-bench.js <path>',
  );
  process.exitCode = 1;
  return; // CommonJS module scope: stop here without touching anything else
}

const { createScanner } = require('./core');

const PROGRESS_MS = 100;
let scanner = null;
let lastProgress = 0;

function post(msg) {
  try { port.postMessage(msg); } catch (err) { console.error('[tessera-scanner] postMessage failed:', err); }
}

function counters(s, type) {
  return { type, files: s.files, dirs: s.dirs, bytes: s.bytes, errors: s.errors, elapsed: s.elapsed };
}

function startScan(msg) {
  if (scanner) {
    console.error('[tessera-scanner] ignoring second scan request (one scan per process)');
    return;
  }
  if (!msg || typeof msg.root !== 'string' || !msg.root) {
    console.error('[tessera-scanner] scan request without a root');
    return;
  }
  scanner = createScanner({
    root: msg.root,
    name: msg.name,
    exclude: Array.isArray(msg.exclude) ? msg.exclude : [],
    progressInterval: PROGRESS_MS,
    onProgress(s) {
      const t = Date.now();
      if (t - lastProgress < PROGRESS_MS * 0.8) return; // throttle: ~10 messages/s at most
      lastProgress = t;
      post(counters(s, 'progress'));
    },
    onDone(s) {
      post(counters(s, 'done'));
    },
  });
  scanner.start();
}

function answer(msg) {
  const id = msg.id;
  try {
    if (!scanner) throw new Error('no scan in progress');
    let result;
    switch (msg.type) {
      case 'view':
        result = scanner.view({
          key: msg.key, depth: msg.depth, minFrac: msg.minFrac, maxChildren: msg.maxChildren,
        });
        break;
      case 'path':
        result = scanner.pathOf(msg.key);
        break;
      case 'remove':
        result = scanner.remove(msg.key);
        break;
      default:
        throw new Error(`unknown request type: ${msg.type}`);
    }
    post({ type: 'reply', id, result });
  } catch (err) {
    post({ type: 'reply', id, error: String((err && err.message) || err) });
  }
}

port.on('message', (e) => {
  const msg = e && e.data !== undefined ? e.data : e;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'scan') {
    try { startScan(msg); } catch (err) { console.error('[tessera-scanner] scan failed to start:', err); }
    return;
  }
  if (msg.id !== undefined) answer(msg);
});

// The scan must never take the process down: log and keep serving queries.
process.on('uncaughtException', (err) => console.error('[tessera-scanner] uncaught:', err));
process.on('unhandledRejection', (err) => console.error('[tessera-scanner] unhandled rejection:', err));
