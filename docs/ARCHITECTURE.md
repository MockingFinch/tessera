# Tessera — architecture

How the code fits together, and why it's built this way. [`SPEC.md`](SPEC.md) is the contract
(message shapes, keys, the view format, the preload API). [`DESIGN.md`](DESIGN.md) records the
product and visual decisions. This document sits between the two. It describes structure and
responsibilities by module and function, not by line number, because the code moves.

## Contents

1. [Three processes](#three-processes)
2. [Main process](#main-process)
3. [The scanner](#the-scanner)
4. [The view query](#the-view-query)
5. [The renderer](#the-renderer)
6. [The treemap engine](#the-treemap-engine)
7. [Languages](#languages)
8. [Settings and appearance](#settings-and-appearance)
9. [Security posture](#security-posture)
10. [Packaging](#packaging)
11. [Known limitations](#known-limitations)

## Three processes

| Process | Code | Responsibilities |
|---|---|---|
| **Main** | `src/main/*.js` | App lifecycle, the window, menus, every IPC handler, Finder, Quick Look and Trash actions, location discovery and scan exclusions, settings, and the scanner process manager. |
| **Scanner** | `src/scanner/worker.js` and `core.js` | One Electron `utilityProcess` per scan. It walks the disk, holds the tree in memory, and answers `view`, `path` and `remove` queries. |
| **Renderer** | `src/renderer/**`, with `src/preload/preload.js` | The whole UI, in a sandboxed `BrowserWindow`. It sees only the `window.tessera` API that the preload exposes. |

**Why the scanner runs in its own process.** The walk is millions of `readdir` and `lstat` calls
plus the bookkeeping for each one. Running it in main would compete with menus, sheets and IPC.
Giving it a process of its own, with exactly one scan per process lifetime, also buys three
things:

- **Cancellation is `kill()`.** The walker has no cancel checks, no abort signals and no half-torn-down state. Main kills the process to start another scan, to go back to Locations, or when the window closes.
- **Memory is returned in one piece.** A whole-disk tree goes away with its process. There's nothing to garbage-collect or leak between scans.
- **Crashes are contained.** If the scanner dies, main resolves the outstanding requests with `null`. If the scan hadn't finished yet, main also sends the renderer a final `scan:done`.

Queries run on the scanner's single JavaScript thread, in between filesystem callbacks. That's
why they can be answered from the partial tree at any moment without locks. Each view is
computed synchronously, so it's internally consistent.

The trade-off: once a scan finishes, its process stays alive, because views, paths and Trash all
need the tree. That memory stays in use until the next scan, Locations, or the window closing.

**Why the renderer is sandboxed.** It's the only process that runs web content, and it never needs
Node. Every privileged action goes through a narrow, validated API (see
[Security posture](#security-posture)).

### Message flow

```
Renderer (sandboxed)            Main                               Scanner (utilityProcess)
────────────────────            ────                               ────────────────────────
startScan ──── invoke ────────▶ scan:start
                                realpath, /sbin/mount → exclude
                                kill old scanner, fork worker.js ─▶ {scan, root, name, exclude}
                                                                    breadth-first walk starts
onProgress ◀── scan:progress ── + scanId ◀──────────────────────── {progress}  every ~100 ms
getView ────── invoke ────────▶ scan:view, new request id ───────▶ {view, id, key, depth, …}
setData ◀───── ViewRoot ──────── pending[id] + scanId ◀─────────── {reply, id, result}
onScanDone ◀── scan:done ─────── + scanId ◀──────────────────────── {done}
trash ──────── invoke ────────▶ item:trash: {path} → sheet
                                → shell.trashItem → {remove} ─────▶ tombstone, subtract
onItemRemoved ◀ item:removed ─── ◀──────────────────────────────── {reply, id, {freed}}
```

The renderer **pulls** views (`getView`, invoke), and main **pushes** events (`scan:progress`,
`scan:done`, `item:removed`, `app:command`, `window:state`, `app:accent-changed`,
`app:language-changed`). Every renderer → main call is an `ipcRenderer.invoke` except
`item:context-menu`, which is a one-way `send`. The menu answers it with an `app:command`, for
example `zoom-into`. The full channel list is in SPEC.md.

## Main process

`main.js` is organized by concern:

- **Window.** One `BrowserWindow`: `hiddenInset` title bar, `under-window` vibrancy, transparent background, shown on `ready-to-show`. Its bounds are restored from disk and clamped to a connected display. Commands that arrive before the page has loaded (a Dock drop at launch, a menu item) are queued in `pendingCommands` and flushed on `did-finish-load`.
- **Scanner manager** (`startScanner`, `request`, `killScanner`, `onScannerMessage`, `onScannerExit`). Each scan gets a record holding its id, child process, `alive` flag, an outgoing queue and a `pending` map of request id → resolver. The rules:
  - Messages are queued until the child emits `spawn`.
  - Request ids come from one global counter, so they're unique across processes.
  - Messages from a process that has been killed are ignored.
  - Killing a process, or its exiting, resolves every pending request with `null`. Callers never hang.
  - An unexpected exit before `done` produces a synthetic `scan:done` with `error: 'scanner-exited'`.
- **Starting a scan** (`beginScan`). Resolve the input with `realpath`, so `/Volumes/Macintosh HD` becomes `/` and `/tmp` becomes `/private/tmp`, and require a directory (otherwise the error is `not-a-folder`). Kill the old scanner right away. Build the exclusion list, which needs `/sbin/mount`, so it's async. Then fork. A `startSeq` token makes a start superseded by a later start or cancel give up instead of forking.
- **Locations and exclusions** (`locations.js`, plain Node).
  - **Disk** is `/`, named after the `/Volumes` symlink that resolves to `/`, with `statfs` totals.
  - **Home** is `os.homedir()`.
  - **External volumes** are the other `/Volumes` entries. Hidden, `nobrowse` and Time Machine entries are skipped, and so are mounted disk images, which `diskutil info -plist` identifies. `statfs` and `diskutil` are each capped at 1.5 s, so a dead network mount can't stall the list.
  - **Exclusions** are every mount point, plus the firmlinked `/X` for each `/System/Volumes/Data/X` mount, plus a static list (`/System/Volumes`, `/Volumes`, `/dev`, `/net`, `/home`, `/private/var/vm`, `/cores`). The list is filtered to paths strictly inside the scan root.
- **Item actions.** The renderer only ever sends keys. Main turns a key into a path by asking the scanner (`path`), then calls `shell.showItemInFolder`, `shell.openPath`, `win.previewFile` (Quick Look) or `clipboard.writeText`.
- **Trash flow** (`trashItem`). Resolve the path. Show a warning sheet with the name and size; the size is formatted in decimal units by a copy of the renderer's `formatBytes`. Call `shell.trashItem`. Tell the scanner to `remove` the key. Send `item:removed` with the bytes freed, but only if that scan is still the current one. The flow refuses the scan root, `/` and aggregate keys, and only one sheet can be open at a time.
- **Selftest** (`runSelftest`, `TESSERA_SELFTEST`). The same `beginScan` with no window, then one depth-1 view, printed as JSON. Logs always go to stderr, so stdout stays clean for the JSON.

## The scanner

`core.js` has no Electron imports, so the same engine runs inside the utility process
(`worker.js`) and under plain Node (the bench and fixture scripts). `worker.js` is a thin adapter.
It checks that it's running under `utilityProcess`, starts one scan, answers `view`, `path` and
`remove` by request id (errors come back as `{ error }`), and logs uncaught exceptions without
exiting, so queries keep being served.

### Data model

There is **one object per directory and none per file.** Every directory is a `DirNode` held in a
flat `nodes` array, and its id is its index (the scan root is `d0`):

| Field | Meaning |
|---|---|
| `id`, `name`, `parent` | Index in `nodes`, the basename, and the parent's id (−1 for the root). |
| `dirIds` | Ids of the child directories, in discovery order. |
| `fNames`, `fSizes`, `fKinds` | Parallel arrays for the files directly inside. They're assigned once, after all of the directory's entries have been `lstat`'ed. |
| `size`, `count`, `kinds` | Propagated totals: allocated bytes, descendant files, and a `Float64Array(9)` of bytes per kind. |
| `pkg`, `forced` | Opaque-package flag, and the forced kind for descendants (−1 for none). |
| `removed`, `err` | Tombstone (trashed), and "readdir failed". |

Directories with no files or no subdirectories share one frozen empty array. A file's key is
`f<dirId>:<index>`. Indices stay stable because files are never spliced out: a trashed file is set
to size 0. `a<dirId>` names a directory's "smaller items" remainder. That key only exists in
views.

**Packages** (`.app`, `.photoslibrary`, `.framework`, … — the full table is in SPEC.md) get a node
but no contents. Their subdirectories are queued in *sum mode*: with no node id, plus the id of
the package to add into. Their files are `lstat`'ed and counted, and their bytes are added to the
package under the package's forced kind. No names are stored. In views a package is always a leaf
(`p: 1`).

**Kinds** (`kinds.js`) are decided per file, in this order:

1. the nearest forced kind wins (package contents, `node_modules`, `.git`, `DerivedData`, … → Developer; `Library/Caches` → System);
2. otherwise the lowercased extension;
3. otherwise a small table of exact names (`Makefile`, `.DS_Store`, …);
4. otherwise Other.

A directory's displayed kind is the argmax of its per-kind bytes.

### Traversal

- **Breadth first, with bounded concurrency.** The queue is three parallel arrays (path, node id, sum target) with a head index. It's compacted once the head passes 65,536 and more than half the queue has been consumed. `pump()` keeps up to **64 directories** in flight. Each directory `lstat`s its non-directory entries over up to **32 lanes**. Main forks the worker with `UV_THREADPOOL_SIZE=32` so libuv has threads for all of them.
- **Subdirectories are queued before any `lstat`.** `readdir({ withFileTypes: true })` already says which entries are directories, so their nodes are created and queued at once, and the breadth-first pipeline stays full. If a filesystem reports an unknown type and `lstat` then says "directory", that entry is queued afterwards.
- **Sizes** are `st.blocks × 512`, the allocated size, which matches Finder's "on disk" figure, so evicted iCloud files count as 0. Symlinks are never followed; they count their own `lstat` size. Excluded paths are matched exactly and never entered.
- **Hard links** are de-duplicated. A file with `nlink > 1` records `dev:ino` in a set, and later links to the same inode count 0 bytes. They're still stored, but views hide zero-size entries.
- **Errors are never fatal.** `EMFILE`, `ENFILE`, `EAGAIN` and `EINTR` on `readdir` are retried up to 4 times with a short backoff. Anything else (`EACCES`, `EPERM`, `ENOENT`, `ENOTDIR`, …) increments `errors` and skips the entry. Error codes and the first 40 samples are kept for `diagnostics()`, which the bench uses.

### Propagation

When a directory's entries have all been `lstat`'ed, the scanner builds its file arrays,
classifies each file, and sums bytes, file count and per-kind bytes. It then adds those three
totals to the directory and every ancestor in one walk up the parent chain. That's one walk per
directory, not one per file, so the cost is O(depth) per directory.

A directory appears in the tree the moment its parent's `readdir` returns, but with size 0, so
views skip it until its first propagation lands. That's what lets the picture fill in evenly
during a scan.

### Removal

`remove('d…')` tombstones the node and subtracts its size, count and kinds from every ancestor.
`remove('f…')` zeroes the file's size and subtracts the same three from its directory upward.
Work still pending inside a tombstoned subtree is dropped. `isDead()` walks the ancestor chain,
and it's checked both before a queued directory is processed and before each propagation. So a
folder trashed in the middle of a scan never adds bytes back. A view whose focus was removed falls
back to the nearest live ancestor. The response's `k` says which.

## The view query

The renderer never receives the tree. It asks for a **view**: a pruned, sorted subtree rooted at
a focus key.

```js
scanner.view({ key: 'd12', depth: 4, minFrac: 56 / (w * h), maxChildren: 260 })
```

| Parameter | Meaning |
|---|---|
| `key` | The focus: a directory, or a file (which returns that file alone). |
| `depth` | The focus's own children are level 1. Recursion continues into child directories while `level < depth`. A directory at the limit is sent without `ch`. |
| `minFrac` | `minSize = focus.s × minFrac`. A child is included only if `s > 0` and `s ≥ minSize`. The threshold is relative to the **focus**, at every level. |
| `maxChildren` | At most this many included children per directory, largest first. |

For each directory in the view, the scanner:

1. filters by `minSize` *before* sorting, which keeps big directories cheap;
2. sorts by size, descending (ties by name), and truncates to `maxChildren`;
3. folds whatever was left out into one **aggregate** child: `{ k: 'a<id>', n: '', s, t, a: 1, c }`. Here `s` is `dir.s − Σ included`, so the children always add up exactly to the parent, and `c` is the number of entries folded in. `t` is the dominant kind of the folded bytes: a file adds its size under its kind, a subdirectory adds its per-kind bytes, and a package adds its whole size under its forced kind. The aggregate is spliced in at its sorted position, so `ch` stays sorted for the layout.

The root of the response also carries `kinds` (bytes per kind inside the focus, which drives the
legend), `crumbs` (scan root → focus), `path` and `scanning`. Main stamps `scanId` on it.

**Why pull pruned views instead of pushing the tree.**

- **The payload is bounded by the canvas, not the disk.** At any one level the included children's sizes add up to at most `focus.s`, and each is at least `focus.s × minFrac`, so at most `1/minFrac` of them can qualify. The renderer sets `minFrac` to 56 px² divided by the canvas area, so one level can never hold more tiles than would fit at about 56 px² each. `maxChildren` caps any one folder, and `depth` caps the number of levels. A view of a disk with millions of files is no bigger than what the canvas can show.
- **Every message crosses two hops** (scanner → main → renderer) as structured clones. Pushing the whole tree on every update would mean serializing millions of entries twice. A view costs a fraction of a millisecond to build; DESIGN.md quotes about 0.1 ms for a 467k-file tree.
- **The renderer sets the pace.** It keeps at most one poll in flight, and the scanner never computes views nobody will draw.
- **Navigation is just another query with a different key.** The renderer keeps no tree of its own to keep in sync with the scan or with Trash.

The renderer asks for `depth: 4` and `maxChildren: 260`. Main's `scan:view` handler falls back to
`depth: 3`, `minFrac: 0.00008` and `maxChildren: 300` when the renderer leaves them out.

## The renderer

| Module | Role |
|---|---|
| `app.js` | Entry point. Screens (welcome / explorer), scanning and polling, navigation, toolbar, readout, legend, toast, keyboard, drag and drop, language. |
| `treemap.js` | The engine: layout, springs, drawing and hit testing on one `<canvas>`. |
| `squarify.js` | Squarified layout (Bruls, Huizing & van Wijk). |
| `kinds.js` | Kind labels, the palette and per-tile shades. |
| `format.js` | Decimal byte units, counts and percentages through `Intl`. |
| `i18n.js` | Renderer strings and `translateDocument()`. |
| `welcome.js` | Logomark, location cards and the entrance animation. |
| `mock.js` | Fake `window.tessera` for previewing in a browser. |
| `devtour.js` | Screenshot tour (`TESSERA_SHOT_DIR`). |

### Polling while scanning

`startScan()` resets the state, clears the map and starts `startPolling()`. That function fetches
a view right away and then every **950 ms**, skipping a tick while a request is still in flight.
Each poll lands as an `update` transition with a 0.62 s spring, so every update settles before the
next one arrives.

Progress events (`scan:progress`, about 10 per second) don't touch the map. They only feed the
toolbar counter, which eases toward its target on its own `requestAnimationFrame` loop. On
`scan:done`, polling stops and one last `update` fetch picks up the final tree.

If that `scan:done` carries `error: 'scanner-exited'`, the renderer marks the scan as failed. It
shows a toast that says to press ⌘R to scan again, and if no tiles ever arrived the stage reads
*Scan stopped* instead of *Looking around…*. A `startScan` that rejects with `cancelled` (another
start, or Locations, superseded it) is ignored silently, because the newer request owns the screen.

**Resizing re-queries once it settles.** A view is pruned for the canvas it was fetched for, since
`minFrac` is 56 px² divided by the canvas area. The `ResizeObserver` re-lays out the cached view at
once, then waits 220 ms. If the canvas area has changed `minFrac` by more than 25% either way, it
fetches the focus again as an `update`, so a bigger window gains detail and a smaller one sheds it.
While scanning, polling already covers this.

### Stale responses

`fetchView()` can have several requests in flight at once: a poll, a zoom, a refresh after Trash.
Each request records:

- `seq`, from a counter that increases with every request;
- the `scanId` that was current when it was sent;
- the `key` it asked for.

A response is dropped when:

- it's `null` (no scanner, or the scanner was killed);
- the scan has changed since the request went out (`state.scan.scanId !== scanId`);
- the user has navigated since (`key !== state.focus`);
- a newer response has already been applied (`seq < state.appliedSeq`).

Otherwise it's applied, and `appliedSeq = seq`. Two more details:

- If the focus was trashed, the scanner answers with an ancestor, and the renderer adopts `view.k` as the new focus.
- `zoomTo()` sets `pendingTransition = 'zoom'` before fetching. Whichever response for the new focus is applied first animates as a zoom. `returnSelect` re-selects the folder you came from once the parent's view is in.

### Transitions

| Transition | Used for | Spring response |
|---|---|---|
| `initial` | The first view that has tiles | 0.90 s, staggered by rank and depth |
| `update` | Polls, the final fetch after `scan:done`, and the re-query after a resize | 0.62 s |
| `zoom` | `zoomTo()`: double-click, crumbs, chevron, ⌘↑ / ⌘↓, Esc, Backspace, pinch, "Open in Tessera" | 0.56 s |
| `remove` | The refetch after `item:removed` | 0.50 s |
| `resize` | Canvas size or device pixel ratio changes | 0.22 s |

With **Reduce Motion** on, every response is multiplied by 0.45 and the stagger is off. CSS
animations drop to 1 ms.

## The treemap engine

`Treemap` owns a single canvas. `setData(view, { transition })` runs the same three steps for
every change:

1. `layout()` turns the view into a map of target specs: rect, mode, color, depth, rank and parent.
2. `apply()` reconciles those targets with the live `Item`s and sets each item's start, target and spring.
3. The frame loop steps the springs and draws.

The loop only runs while something is moving. `kick()` restarts it, and an idle map draws nothing.

### Layout and nesting rules

The root rect is the canvas's layout area, `[0, 0, width, height]`. `layoutChildren()` takes the
node's children with `s > 0` (already sorted, largest first) and lays them out with `squarify()`:

- Rows grow while the worst aspect ratio improves.
- Strips run along the shorter side: vertical strips on the left when the rect is wider than tall, horizontal strips on top otherwise.
- The last tile in each strip absorbs floating-point drift, so the rect is filled exactly.

**Gaps.** Squarify runs on the parent's content rect grown by `g/2` on every side, and each
resulting cell is then shrunk by `g/2` on every side. Siblings end up exactly `g` apart, and the
outer tiles sit flush with the content rect; the parent's padding provides the inset. A tile under
0.75 px in either dimension after the gap is dropped. Its area stays empty.

**Modes.** `place()` decides how each tile is drawn:

| Mode | Rule |
|---|---|
| `aggregate` | The node has `a: 1`. |
| `container` with header | Expandable, and `w ≥ 72` and `h ≥ header + 30`. Children go in `[x + pad, y + header, w − 2·pad, h − header − pad]`. |
| `container` without header | Expandable, and `w ≥ 30` and `h ≥ 30`. Children go inside a uniform `pad` inset. |
| `leaf` | Everything else: files, packages, and expandable folders too small to nest. Those are colored by their dominant kind. |

A node is *expandable* when it's a non-package directory with a non-empty `ch` and a depth below
4. A container only recurses when its inner rect is larger than 2×2 px. The view is fetched at
depth 4, so there are at most three levels of containers and four levels of tiles.

Per-depth metrics, in CSS px:

| Depth | Gap between siblings | Corner radius | Header height | Padding |
|---|---|---|---|---|
| 1 | 3 | 7 | 24 | 3 |
| 2 | 2 | 5 | 19 | 2.5 |
| 3 | 1.5 | 3.5 | 17 | 2 |
| 4 | 1.25 | 2.5 | n/a (leaves only) | n/a |

**Color.** A leaf takes its kind's palette color, shifted by one of six lightness-only shades. The
shade is chosen by an FNV-1a hash of the tile's key, so it's stable across frames and views.
Containers are white at 5.5% alpha. An aggregate is its dominant kind's color at 15% alpha, with a
6 px mosaic pattern of the same color on top. The palette values and how they were validated are
in DESIGN.md → Color.

**Rank.** Each top-level tile's rank is its index. Its descendants inherit that rank, which drives
the initial stagger: `delay = min(0.5 s, rank × 28 ms + (depth − 1) × 70 ms)`.

### The Item spring model

Each drawn tile is an `Item` with three `Float64Array(9)` buffers: `cur`, `vel` and `tgt`. The nine
channels are **x, y, w, h, opacity, r, g, b, a**. Every channel is a **critically damped spring,
solved analytically**. With displacement `d = cur − tgt`, velocity `v`, `c = v + ω·d`, and a frame
step `dt`:

```
d' = (d + c·dt) · e^(−ω·dt)
v' = (c − ω·(d + c·dt)) · e^(−ω·dt)
```

This is the exact solution of `x″ + 2ω·x′ + ω²·x = 0`, not a numerical integration. It's
unconditionally stable, never overshoots, and gives the same path at any frame rate. Retargeting
mid-flight keeps the current velocity, so interrupted motion stays smooth.

- **Stiffness.** `ω = 2π / response`, where the response comes from the transition table above. Starting from rest, at `t = response` about 1.4% of the distance is left, because `(1 + 2π)·e^(−2π) ≈ 0.014`.
- **Opacity springs faster.** The opacity channel uses `2.4·ω`, so tiles commit to appearing or disappearing early while their shape is still moving.
- **Settling.** A channel snaps to its target once `|d| < ε` and `|v| < 4ε`. ε is 0.01 px for geometry, 0.001 for opacity and alpha, and 0.2 for RGB on the 0–255 scale. When all nine channels have snapped, the item is `settled` and isn't stepped any more.
- **Frame step.** `dt` is clamped to 1–50 ms, so a long stall (a hidden window, a GC pause) doesn't jump.
- **Delays.** `delay` holds every channel until it counts down to zero; it's used for the initial stagger. `fadeHold` holds only the opacity channel, for hand-offs (below).

### Transitions: the camera

A new view never cuts. `apply()` derives each tile's start and end positions so the whole scene
moves as if one camera moved.

**Camera anchor** (zoom only). This is the one rect present before and after the zoom:

- **Entering a tile.** If the new root is currently on screen, the anchor maps its current rect to the full canvas.
- **Exiting to a parent.** Otherwise, if the old root appears in the new layout, the anchor maps the full canvas to the old root's new, smaller rect.
- **No anchor.** This happens, for example, when you jump to a far ancestor and the old root is too small to be laid out. Tiles then fall back to the scale-and-fade defaults below.

Then, in order:

1. **Hand-offs** (zoom with an anchor; `handOff()`). For each persisting tile, shallowest first, the engine works out where the motion would carry it: through its nearest ancestor that persists, or through the camera anchor if none does. If that carried rect overlaps the tile's new rect by less than `HANDOFF_IOU = 0.5` (intersection over union), the tile hands off, along with everything inside it. Its live item is renamed `<key>~<n>`, marked as a ghost, and its children are re-parented to the ghost key. That frees the real key for a fresh item. The ghost then departs like any other tile, riding the camera and fading, while the fresh tile fades in already in place.
   - Zooming in, the swap happens at once.
   - Zooming out, ghosts and fresh tiles hold their opacity for `0.3 × response`, so the swap lands late, once the tiles have shrunk.
   - Without hand-offs, a tile that the new layout moved to the other side of its folder would slide across its neighbours.
2. **Departing tiles** (in the old scene, not in the new one). The target is the tile's current rect mapped through the motion of its nearest persisting ancestor. If no ancestor persists, the camera anchor is used. If there's neither, or the mapping moves the tile less than 2 px in total, it shrinks about its center (to 90% on a zoom, 40% otherwise). The target opacity is 0, and the item is deleted once its opacity is below 0.004 or it has settled.
3. **Arriving tiles.** The start is the target rect mapped into the nearest persisting ancestor's *current* rect, so children grow out of the folder you just opened. If no ancestor persists, the inverse of the camera mapping is used, which means that zooming out, new siblings start off screen exactly where they'd be relative to the old root. If there's neither, the tile scales up from 86% (initial) or 92% of its rect. New tiles start at opacity 0 with their target color already set, so color never animates on arrival.
4. **Persisting tiles** keep their current state and get new targets on all nine channels: they morph. A tile that was departing and comes back is revived from wherever it is.

The tile you zoom into becomes the new root item (`mode: 'root'`, target opacity 0). It grows to
fill the canvas while it fades, and its children are drawn on top without clipping.

### Drawing

- **Tree order with clipping.** `buildTree()` groups the sorted items (depth, then live before departing, then layout order) under their parent items. `drawItem()` draws a tile, then clips to its rounded rect and draws its children inside, so a folder's contents never stray outside it or mix with a sibling's, even mid-flight. Children of the root aren't clipped.
- **Bleed.** The canvas is `BLEED = 8` px larger than the layout area on every side. It's positioned at (−8, −8), the draw transform is translated by +8 px, and `localPoint()` subtracts 8 from pointer coordinates. That's what lets the selection ring on a tile touching the map's edge draw in full. `.infobar` sits above the overhang (`z-index: 1`), so the legend chips stay clickable.
- **Pixel snapping and culling.** Edges are rounded to device pixels. A tile under 0.5 px, or entirely off the canvas, is skipped along with its subtree. A tile's alpha is `opacity × (1 − 0.82 × dim)`.
- **Leaves.** Tiles at least 14 px in both dimensions get a slight vertical gradient (7% lighter at the top, 5% darker at the bottom). Tiles over 9 px get a 1 px rim. If there's room, the label is the name plus the size. The ink is black or white depending on the tile's luminance, and labels fade in as the tile grows past a minimum size.
- **Containers.** A translucent fill. When the container has a header, the name is on the left and the size on the right; the size is dropped before the name gets too short.
- **Aggregates.** The tinted fill, the mosaic pattern, and a pill badge reading "*N* items". The badge is left out rather than truncated when it doesn't fit.
- **Motion fade.** `motionFade()` fades every label while its tile moves fast. The fade runs from full at a summed geometric speed of 120 px/s down to none at 700 px/s.
- **Text.** Text widths are cached per font, and a font's cache is cleared past 6,000 entries. `fit()` finds the longest prefix that fits with an ellipsis by binary search, and draws nothing if fewer than two characters fit. A language change only clears the cache and repaints (`relabel()`).
- **Selection ring.** Drawn last, 1 px outside the tile: a 4 px dark halo, then a 2 px ring in the system accent color. Its alpha eases toward its target, and re-selecting starts it from at most 0.2, so each new selection fades in.

### Hover and dim smoothing

`setHovered()` sets `hoverT = 1` on the tile under the pointer, 0.55 on its parent container and
0.25 on containers further up. The engine draws a white overlay scaled by each item's `hover`:
16% on leaves, 70% of that on aggregates, 5% on containers.

`highlightKind(kind)` sets `dimT = 1` on every leaf and aggregate of another kind. Containers and
the root never dim. New tiles take their dim value immediately instead of easing into it.

`hover`, `dim` and the ring's alpha ease toward their targets exponentially, frame-rate
independently, by `1 − e^(−k·dt)` per frame:

| Value | Rate `k` |
|---|---|
| `hover` | 22 per second |
| `dim` | 14 per second |
| ring alpha | 16 per second |

### Hit testing and input

- **`hitTest()`** walks the sorted items in reverse, deepest first, and returns the first tile whose *current, animated* rect contains the point. It skips the root, departing tiles and ghosts, and anything below 50% opacity. Coordinates are in layout space.
- **Re-testing.** When the loop goes idle, `frame()` runs `refreshHover()` again, so the hover follows tiles that moved under a still pointer. It's also re-run when the hovered tile is deleted.
- **Pointer events.**
  - `pointerdown` (primary button) selects.
  - `dblclick` calls `onOpen`.
  - `contextmenu` selects and calls `onContextMenu`; main shows the native menu.
- **Pinch.** A trackpad pinch arrives as `wheel` events with `ctrlKey`. `deltaY` accumulates until it passes ±28, which fires `onPinch('in' | 'out', hovered)` and starts a 520 ms cooldown. `app.js` maps `in` to "dive into the focus's child under the pointer" and `out` to the enclosing folder.
- **Keyboard selection** (`moveSelection()` in `app.js`). Candidates are the visible siblings of the selected tile. The winner scores lowest on `along + 2.2 × across` in the arrow's direction.

## Languages

Tessera ships English (the default) and Simplified Chinese. It doesn't follow the system
language. Each side owns its strings:

- **Main** (`src/main/i18n.js`). `t(key, vars)` with `{name}` interpolation; a missing key falls back to English, then to the key itself. It covers every menu label (role items get explicit labels so they're translated too), the context menu, the Trash and Trash-failed sheets, the open panel's title and button, the About credits, and the Home location's name.
- **Renderer** (`src/renderer/js/i18n.js`). The same `t()`. `setLang()` sets `<html lang>` (`en` / `zh-Hans`) and notifies listeners. `translateDocument()` fills the `data-i18n`, `data-i18n-tip` and `data-i18n-label` attributes in `index.html`. `format.js` formats numbers with `Intl` for `en-US` or `zh-CN`. Byte units are decimal, and the unit symbols are the same in both languages.
- **Switching.** View → Language is a pair of radio items, each labelled in its own language. Choosing one calls `changeLanguage()` in main, which:
  1. persists the choice to `settings.json`;
  2. updates the About panel;
  3. rebuilds the application menu;
  4. sends `app:language-changed` to every window.

  The renderer asks `getLanguage()` once at boot. After that, on each change it re-runs `translateDocument()`, re-renders the toolbar, legend and readout, and calls `treemap.relabel()`. It re-fetches the locations rather than just re-rendering them, because Home's display name comes from main in main's language.

## Settings and appearance

**Persistence.** Two small JSON files live in `app.getPath('userData')`, which is
`~/Library/Application Support/Tessera`:

| File | Contents | Written |
|---|---|---|
| `settings.json` | `{ "language": "en" \| "zh" }`, merged with any other keys already there. A missing or invalid value reads as `"en"`. | When the language changes. |
| `window-state.json` | The window's normal bounds. On restore they're clamped to a connected display's work area and to the 760×520 minimum. | 400 ms after a resize or move settles, and on close. |

Both are written to a `.tmp` file first and then renamed, so a crash can't leave half a file
behind. The browser mock keeps its language in `localStorage` instead.

**Appearance: dark only.**

- When the app is ready, main sets `nativeTheme.themeSource = 'dark'`. The vibrancy material, menus, context menus and sheets are dark whatever the system setting.
- The renderer declares `color-scheme: dark`, has a single set of CSS tokens, and uses one palette (`kinds.js`) and one drawing palette (`PAL` in `treemap.js`).
- The accent color (the selection ring, focus outlines) comes from `systemPreferences.getAccentColor()`. Main pushes changes on `nativeTheme` `updated` and on `AppleColorPreferencesChangedNotification`.
- The page itself is transparent, so it sits on the window's vibrancy. In a browser preview, and during the screenshot tour (`capturePage()` can't see vibrancy), `html.no-vibrancy` paints a solid stand-in instead.

## Security posture

- **Isolated, sandboxed renderer.** `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`. The preload only uses `contextBridge`, `ipcRenderer` and `webUtils`. It coerces every argument to a string or number before it crosses IPC, and every `on*()` it exposes returns an unsubscribe function. Dev settings reach the preload through `additionalArguments`, because a sandboxed preload can't read the environment.
- **Keys, not paths.** The renderer refers to items by key. Main checks keys against `^(d\d+|f\d+:\d+)$` (actions that need a path) or with `a\d+` allowed as well (views, context menu), and resolves paths itself by asking the scanner. The renderer does pass a path to `scan:start` (a dropped folder or a location), but scanning only reads.
- **Destructive actions are main's job.** Trash always shows a native sheet from main, which the renderer can't skip. It refuses the scan root and `/`, allows one sheet at a time, and only uses `shell.trashItem`, so it's reversible. Tessera can't delete anything permanently.
- **CSP** in `index.html`: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:`. `'unsafe-inline'` is there for `style` attributes: `index.html` and the generated logomark SVG use them for animation indices.
- **Navigation is locked to the app page.** `will-navigate` blocks every URL except `index.html` and opens `http(s)` links in the default browser instead. `setWindowOpenHandler` denies every new window and hands `http(s)` and `mailto` links to `shell.openExternal`. `<webview>` attachment is blocked for every `webContents`.
- **Permissions.** `setPermissionRequestHandler` grants only `clipboard-sanitized-write`.
- **Development affordances are gated.** View → Developer (DevTools, Reload) only exists when the app isn't packaged. `dev:capture` does nothing unless `TESSERA_SHOT_DIR` is set, and it sanitizes the file name.

## Packaging

`scripts/package.js` runs `@electron/packager`. Version 20 is ESM-only, so it's loaded with a
dynamic `import()` from the CommonJS script. Settings:

- `platform: 'darwin'`, `arch: 'arm64'`, `asar: true`, `prune: true`;
- bundle id `app.tessera.mac`, category Utilities, `LSMinimumSystemVersion` 13.0;
- `CFBundleDocumentTypes` declaring `public.folder` and `public.volume` as Viewer/Alternate, which is what makes Dock drops reach `app.on('open-file')`.

The ignore list keeps `docs/`, `scripts/`, `dist/`, `build/icon.iconset`, README-type files and
editor and tooling dotfiles out of the asar. It also drops `node_modules` entirely, because Tessera has no runtime
dependencies. The Electron zip comes from the `@electron/get` cache when it's there.

- **The scanner runs from inside `app.asar`.** In Electron 44, `utilityProcess.fork()` resolves its entry point and `require()`s through the asar archive, so `worker.js`, `core.js` and `kinds.js` need no `asarUnpack`.
- **Ad-hoc signing.** The packager edits `Info.plist` and renames the executable, which breaks the seal on Electron's stock ad-hoc signature. The script runs `codesign --verify --deep --strict`. If that fails, it re-signs with `codesign --force --deep --sign -` and verifies again, and the build fails if it still doesn't verify. The app isn't signed with a Developer ID and isn't notarized.

## Known limitations

These come from reading the code as it stands. Each is specific and checkable.

**Scanning and sizes**

- **Totals won't match the volume's "used" figure.** `st.blocks` can't see shared extents, so APFS clones count once per copy. Snapshots, purgeable space and the excluded system volumes aren't counted at all. Unreadable folders contribute nothing.
- **Hard links.** The first link found carries the bytes, and the other links count 0 and are hidden. If you trash the counted link, Tessera reports and subtracts its size, but the data is still on disk through the other links. Those links stay at 0 until a rescan.
- **"Freed" means removed from the map.** Disk space only comes back when the Trash is emptied. A Home or Macintosh HD scan also covers `~/.Trash`, so trashed items show up there on the next rescan.
- **The "Limited access" pill is coarse.**
  - It only appears for Macintosh HD and Home scans, and only after the scan finishes. Errors in folder or external-volume scans are never surfaced.
  - It counts every error, including `ENOENT` from files deleted mid-scan.
  - Under `npm start`, macOS attributes file access to the terminal that launched Electron, so a Full Disk Access grant for the packaged Tessera.app doesn't apply there.
- **The finished tree stays in memory.** The scanner process keeps it until the next scan, Locations, or the window closing. This is by design, because views, paths and Trash need it.

**Renderer**

- **Rescan starts at the root.** ⌘R starts a new scan, and keys only mean something within one scan, so the zoom level and the selection are lost.
- **Kind highlight is per tile.** A folder drawn as a leaf, and a "smaller items" tile, carry only their dominant kind. Highlighting a kind lights up those tiles as a whole and dims the rest, so the highlighted area won't match the legend's exact per-kind bytes.
- **The map isn't accessible to VoiceOver.** It's a single `<canvas role="img">`. Tiles aren't exposed individually, and the readout isn't a live region. Only the toolbar status (`aria-live`) and the toast (`role="status"`) are announced.
- **Only the first dropped item is scanned** when several are dropped at once.

**Packaging and tooling**

- **Dock drop only works in the packaged app.** The document types are added to `Info.plist` at packaging time. The stock `Electron.app` used by `npm start` declares none, so it never receives `open-file` for folders.
- **arm64 only, ad-hoc signed, not notarized.** On another Mac, Gatekeeper blocks a downloaded copy until it's approved by hand. Because an ad-hoc signature has no stable identity across builds, expect to grant Full Disk Access again after rebuilding.
