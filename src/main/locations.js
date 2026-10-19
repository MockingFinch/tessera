'use strict';

// Volume / home discovery and the scan exclusion list.
// Plain Node (no Electron imports) so it can be exercised from a CLI too.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const VOLUMES = '/Volumes';
const MOUNT_BIN = '/sbin/mount';
const DISKUTIL_BIN = '/usr/sbin/diskutil';
const STATFS_TIMEOUT_MS = 1500;
const DISKUTIL_TIMEOUT_MS = 1500;

// Always excluded (when strictly inside the scan root), on top of every mount point.
const STATIC_EXCLUDES = [
  '/System/Volumes',
  '/Volumes',
  '/dev',
  '/net',
  '/home',
  '/private/var/vm',
  '/cores',
];

// `/sbin/mount` lines look like:
//   /dev/disk3s5 on /System/Volumes/Data (apfs, local, journaled, nobrowse, protect)
//   //user@nas/share on /Volumes/share (smbfs, nodev, nosuid, mounted by me)
// Mount points can contain spaces and parentheses; the option list never does,
// so anchor on the first " on /" and the last parenthesised group.
function parseMountOutput(text) {
  const mounts = [];
  for (const line of String(text || '').split('\n')) {
    const m = /^(.*?) on (\/.*) \(([^()]*)\)\s*$/.exec(line);
    if (!m) continue;
    mounts.push({
      device: m[1],
      path: m[2],
      options: m[3].split(',').map((o) => o.trim()).filter(Boolean),
    });
  }
  return mounts;
}

function readMounts() {
  return new Promise((resolve) => {
    execFile(MOUNT_BIN, [], { encoding: 'utf8', timeout: 5000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) {
        console.error('[tessera] /sbin/mount failed:', err.message);
        resolve([]);
        return;
      }
      resolve(parseMountOutput(stdout));
    });
  });
}

// The /Volumes entry that resolves to "/" (normally the "Macintosh HD" symlink).
// Only symlinks are resolved, so a dead network mount in /Volumes is never touched.
function rootVolumeName() {
  let names = [];
  try {
    names = fs.readdirSync(VOLUMES);
  } catch {
    names = [];
  }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const p = path.join(VOLUMES, name);
    try {
      if (!fs.lstatSync(p).isSymbolicLink()) continue;
      if (fs.realpathSync(p) === '/') return name;
    } catch {
      // ignore unreadable entries
    }
  }
  return 'Macintosh HD';
}

// Display name for a scan root: the volume name for "/", the basename otherwise.
function displayName(p) {
  if (p === '/') return rootVolumeName();
  return path.basename(p) || p;
}

function capacitySync(p) {
  try {
    const s = fs.statfsSync(p);
    return { total: s.blocks * s.bsize, free: s.bavail * s.bsize };
  } catch {
    return {};
  }
}

// Async statfs with a timeout, so an unresponsive network volume can't stall main.
function capacity(p) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => finish({}), STATFS_TIMEOUT_MS);
    fs.promises.statfs(p).then(
      (s) => finish({ total: s.blocks * s.bsize, free: s.bavail * s.bsize }),
      () => finish({}),
    );
  });
}

// ---- disk images ------------------------------------------------------------------------------
// Mounted .dmg installers ("Epic Games Launcher", …) live in /Volumes like real drives; Finder
// shows them, but they aren't places worth scanning. `diskutil info -plist <mount point>` tells
// them apart. Anything unclear (diskutil error, timeout, network share) keeps the volume.

const XML_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

// The handful of top-level scalars we read from `diskutil info -plist` output.
function parseDiskutilInfo(xml) {
  const text = String(xml || '');
  const read = (key) => {
    const m = new RegExp(`<key>${key}</key>\\s*<(string|integer|true|false)\\s*/?>(?:([^<]*)</\\1>)?`).exec(text);
    if (!m) return undefined;
    if (m[1] === 'true') return true;
    if (m[1] === 'false') return false;
    if (m[1] === 'integer') return Number(m[2]);
    return (m[2] || '').replace(/&(amp|lt|gt|quot|apos);/g, (_, e) => XML_ENTITIES[e]);
  };
  return {
    error: read('Error') === true,
    busProtocol: read('BusProtocol'),
    virtualOrPhysical: read('VirtualOrPhysical'),
    writableVolume: read('WritableVolume'),
  };
}

// `readOnly`: the mount table says "read-only". diskutil's WritableVolume backs it up when the
// mount table had no entry for the volume.
function isDiskImageInfo(info, readOnly) {
  if (!info || info.error) return false;
  if (info.busProtocol === 'Disk Image') return true;
  return info.virtualOrPhysical === 'Virtual' && (readOnly === true || info.writableVolume === false);
}

// Resolves { info } on success, { error } when diskutil exits non-zero or can't be spawned,
// { timedOut: true } after DISKUTIL_TIMEOUT_MS. Never rejects. Our own timer settles the promise
// even if the child can't be reaped (e.g. stuck on a dead network mount).
function diskutilInfo(p) {
  return new Promise((resolve) => {
    let settled = false;
    let child = null;
    const finish = (v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(v);
    };
    const timer = setTimeout(() => {
      finish({ timedOut: true });
      try { if (child) child.kill('SIGKILL'); } catch { /* already gone */ }
    }, DISKUTIL_TIMEOUT_MS);
    try {
      child = execFile(
        DISKUTIL_BIN, ['info', '-plist', p],
        { encoding: 'utf8', timeout: DISKUTIL_TIMEOUT_MS, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 },
        (err, stdout) => {
          if (err && (err.killed || err.signal)) finish({ timedOut: true });
          else if (err) finish({ error: err });
          else finish({ info: parseDiskutilInfo(stdout) });
        },
      );
    } catch (err) {
      finish({ error: err });
    }
  });
}

// mount point + "\0" + device → Promise<info | null>, for the process lifetime. A timeout is
// not cached (the next getLocations() asks again); a definite answer or a diskutil error is.
const diskutilCache = new Map();

function volumeInfo(p, device) {
  const key = `${p}\0${device}`;
  let pending = diskutilCache.get(key);
  if (!pending) {
    pending = diskutilInfo(p).then((r) => {
      if (r.timedOut) {
        diskutilCache.delete(key);
        return null;
      }
      return r.info || null;
    });
    diskutilCache.set(key, pending);
  }
  return pending;
}

async function isDiskImage(vol) {
  return isDiskImageInfo(await volumeInfo(vol.path, vol.device), vol.readOnly);
}

function shortUserName() {
  try {
    return os.userInfo().username;
  } catch {
    return path.basename(os.homedir());
  }
}

async function externalVolumes(mounts) {
  let names = [];
  try {
    names = fs.readdirSync(VOLUMES);
  } catch {
    return [];
  }
  const byPath = new Map(mounts.map((m) => [m.path, m]));
  let volumesDev = null;
  try {
    volumesDev = fs.statSync(VOLUMES).dev;
  } catch {
    volumesDev = null;
  }

  const found = [];
  for (const name of names) {
    if (name.startsWith('.')) continue; // hidden
    if (name.startsWith('com.apple.TimeMachine.')) continue;
    const p = path.join(VOLUMES, name);
    const mount = byPath.get(p);
    if (mount) {
      if (mount.options.includes('nobrowse')) continue; // hidden from Finder too
      found.push({ path: p, device: mount.device, readOnly: mount.options.includes('read-only') });
      continue;
    }
    // Not in the mount table: the root alias (a symlink to "/"), a stale folder, or
    // (if `mount` failed) a real volume. Only local metadata is touched here.
    try {
      const lst = fs.lstatSync(p);
      if (lst.isSymbolicLink()) continue; // root alias or some other link: not a volume
      if (mounts.length > 0) continue; // stale mount-point folder
      if (!lst.isDirectory()) continue;
      if (volumesDev !== null && fs.statSync(p).dev === volumesDev) continue;
      found.push({ path: p, device: `dev:${lst.dev}`, readOnly: false });
    } catch {
      // unreadable: skip
    }
  }

  found.sort((a, b) => path.basename(a.path).localeCompare(path.basename(b.path), undefined, { sensitivity: 'base' }));
  // diskutil and statfs for every volume at once; each is capped at 1.5 s.
  const checked = await Promise.all(found.map((v) => Promise.all([isDiskImage(v), capacity(v.path)])));
  const list = [];
  found.forEach((v, i) => {
    const [image, cap] = checked[i];
    if (image) return; // mounted disk image (installer .dmg etc.): not a drive
    list.push({ id: `volume:${path.basename(v.path)}`, kind: 'external', name: path.basename(v.path), path: v.path, ...cap });
  });
  return list;
}

// Location = { id, kind: 'disk'|'home'|'external', name, path, total?, free?, user? }
// `homeName` is the (translated) display name of the home folder.
async function getLocations({ homeName = 'Home' } = {}) {
  const mounts = await readMounts();
  const home = os.homedir();
  const list = [
    { id: 'disk', kind: 'disk', name: rootVolumeName(), path: '/', ...capacitySync('/') },
    { id: 'home', kind: 'home', name: homeName, path: home, user: shortUserName() },
  ];
  list.push(...(await externalVolumes(mounts)));
  return list;
}

// Every mount point (+ the firmlinked "/X" for each /System/Volumes/Data/X mount) plus the
// static list, filtered to entries strictly inside `root` (root "/" keeps them all).
// The root itself is never excluded.
async function buildExclusions(root, mounts) {
  const list = mounts || (await readMounts());
  const all = new Set(STATIC_EXCLUDES);
  for (const m of list) {
    all.add(m.path);
    const fl = /^\/System\/Volumes\/Data(\/.+)$/.exec(m.path);
    if (fl) all.add(fl[1]);
  }
  const prefix = root === '/' ? '/' : `${root}/`;
  return [...all]
    .filter((p) => p !== root && p !== '/' && p.startsWith(prefix))
    .sort();
}

module.exports = {
  STATIC_EXCLUDES,
  parseMountOutput,
  parseDiskutilInfo,
  isDiskImageInfo,
  readMounts,
  rootVolumeName,
  displayName,
  getLocations,
  buildExclusions,
};
