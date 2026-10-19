# Tessera — engineering spec

Tessera is a macOS disk-space visualizer built on Electron. You pick a disk or a folder, and it
draws everything on it as a zoomable, animated treemap. **The visualization is the product.**
Everything else stays small and quiet.

Runtime: **Electron 44.9.0** (Node 24 inside). Tooling needs Node 22.12 or later; `.nvmrc` pins 24.
Plain JavaScript (CommonJS in main/preload/scanner, ES modules in the renderer). No bundler, no frameworks,
no runtime npm dependencies.

## Product scope (what ships, what doesn't)

Ships:
1. **Locations**: a welcome screen listing Macintosh HD, Home, external volumes and "Choose Folder…". You can also drop a folder anywhere on the window.
2. **Live scan**: the treemap assembles while the scan runs, so you never sit staring at a progress bar.
3. **Explore**: a nested treemap you can zoom with spring animations: double-click to dive in, go back up with the chevron, the breadcrumbs or ⌘↑.
4. **Understand**: tiles are colored by kind (Apps, Video, Photos, Audio, Documents, Archives, Developer, System, Other). The legend names the kinds present (no numbers); hovering a chip writes that kind's total into the readout and isolates its tiles, clicking locks the isolation. The palette lives in `src/renderer/js/kinds.js` and is validated across all pairs (see DESIGN.md → Color).
5. **Act**: Quick Look (Space), Reveal in Finder, Copy Path, Move to Trash (with a confirmation sheet and always reversible), all from a native context menu.

Deliberately left out: filter query syntax, tagging, exports, settings windows, permanent delete, and a list view.

## File layout

```
package.json                 scripts and the two dev dependencies
src/main/main.js             app lifecycle, BrowserWindow, IPC, scanner process manager
src/main/menu.js             application menu + context-menu builders
src/main/locations.js        volume/home discovery + scan exclusion list
src/main/i18n.js             main-process strings (en, zh)
src/preload/preload.js       contextBridge → window.tessera
src/scanner/kinds.js         file-kind classification
src/scanner/core.js          scanning, tree, queries — plain Node, no Electron imports
src/scanner/worker.js        utilityProcess entry: wires core.js to process.parentPort
scripts/scan-bench.js        CLI harness: node scripts/scan-bench.js <path>
scripts/scan-fixture-test.js scanner correctness checks
scripts/make-icon.js         renders build/icon.png + build/icon.icns
scripts/package.js           builds dist/Tessera-darwin-<arch>/Tessera.app (+ release zips)
build/                       icon assets
src/renderer/**              all UI
docs/                        SPEC.md (this file), DESIGN.md, ARCHITECTURE.md
```

## Kinds (shared indices — never reorder)

| idx | id         | label       |
|-----|------------|-------------|
| 0   | apps       | Apps        |
| 1   | video      | Video       |
| 2   | photos     | Photos      |
| 3   | audio      | Audio       |
| 4   | documents  | Documents   |
| 5   | archives   | Archives    |
| 6   | developer  | Developer   |
| 7   | system     | System      |
| 8   | other      | Other       |

`KIND_COUNT = 9`.

Classification:
- **Packages**: these are opaque bundles. Their size is summed, but their contents are never stored as nodes, and they are always leaves in views (`p: 1`). Each package extension forces a kind:
  `.app .appex .prefPane .saver .qlgenerator .mdimporter` → apps;
  `.photoslibrary .photolibrary .aplibrary .migratedphotolibrary` → photos;
  `.tvlibrary .fcpbundle .imovielibrary .fcpproject` → video;
  `.logicx .band .musiclibrary` → audio;
  `.pages .numbers .key .rtfd .scriv .graffle` (directory form) → documents;
  `.framework .bundle .plugin .kext .component .vst .vst3 .xpc .systemextension .driver` → system;
  `.xcarchive .xcodeproj .xcworkspace .playground .xcassets .docc .dSYM` → developer;
  `.sparsebundle .pkg .mpkg` (directory form) → archives.
- **Forced-kind directories** apply to all descendants but stay expandable: `node_modules .git DerivedData Pods .venv venv __pycache__ .gradle .m2 .cargo .rustup .npm .pnpm-store .yarn .cocoapods .swiftpm .build .next .nuxt .turbo` → developer. A directory named exactly `Caches` whose parent is named `Library` → system. The nearest forced kind wins.
- **Files** are classified by lowercased extension, using generous tables. `.ts` is TypeScript, so it's developer, not video:
  - video: mp4 mov m4v mkv avi webm wmv flv mts m2ts 3gp mpg mpeg vob prproj braw r3d
  - photos: jpg jpeg png heic heif gif tif tiff bmp webp avif raw cr2 cr3 nef arw dng orf rw2 raf srw psd psb ai svg sketch fig xcf exr hdr
  - audio: mp3 m4a m4b aac wav aif aiff flac alac ogg oga opus wma caf mid midi amr ape
  - documents: pdf doc docx pages key numbers xls xlsx ppt pptx txt rtf md markdown epub csv tsv odt ods odp tex
  - archives: zip dmg iso pkg mpkg tar gz tgz bz2 xz zst 7z rar xip sparseimage dmgpart ipsw cpgz lz4
  - developer: js mjs cjs ts tsx jsx py rb go rs c h cc cpp hpp m mm swift kt java class jar json yml yaml toml lock wasm o a pyc map sql ipynb sh zsh
  - system: dylib so plist log db sqlite sqlite-wal sqlite-shm cache tmp ttf otf ttc nib car metallib dat bin vmem sleepimage
  - anything else → other

## Scanner process protocol

Main forks `src/scanner/worker.js` with `utilityProcess.fork(path, [], { serviceName: 'Tessera Scanner', env: { ...process.env, UV_THREADPOOL_SIZE: '32' }, stdio: 'inherit' })`.
**One scan per process lifetime**: main kills the process and forks a fresh one for every new scan or cancel. That gives free cancellation and returns the memory.

Main → worker (`child.postMessage(msg)`; worker reads `process.parentPort.on('message', e => e.data)`):
- `{ type: 'scan', root: '/abs/path', name: 'Display Name', exclude: ['/abs/a', …] }`, which starts immediately.
- `{ type: 'view', id: <reqId>, key: 'd0', depth: 3, minFrac: 0.00008, maxChildren: 300 }`
- `{ type: 'path', id, key }` → result is the absolute path string
- `{ type: 'remove', id, key }` → result is `{ freed: <bytes> }`

Worker → main (`process.parentPort.postMessage(msg)`):
- `{ type: 'progress', files, dirs, bytes, errors, elapsed }`, throttled to about every 100 ms while scanning
- `{ type: 'done', files, dirs, bytes, errors, elapsed }` (elapsed is in ms)
- `{ type: 'reply', id, result }` or `{ type: 'reply', id, error: 'message' }`

Queries can arrive at any time while the scan is still running, and must answer from the partial tree.

### Keys
- `d<n>`: directory node id (the scan root is `d0`). Ids are assigned at discovery and stay stable for the life of the scan.
- `f<dirId>:<index>`: a file, by its index in that dir's file list. This is stable because files are never spliced out; a removed file is tombstoned with size 0.
- `a<dirId>`: the aggregate "smaller items" remainder of that dir.

### View response (`result` of `view`)
```js
{
  k, n, s, t, d, c, ch,          // the focus node itself (shape below)
  kinds: [9 numbers],            // bytes per kind inside the focus
  crumbs: [{ k, n }, …],         // scan root → focus, inclusive
  path: '/abs/path/of/focus',
  scanning: true|false
}
```
Node shape (keep the keys short, because these cross IPC often):
```js
{
  k: 'd12' | 'f12:3' | 'a12',
  n: 'Library',          // name; the scan root uses the display name. Aggregates: '' (renderer formats)
  s: 123456789,          // allocated bytes (st.blocks * 512)
  t: 0..8,               // kind: file → its kind; dir → the kind holding the most bytes (argmax of its per-kind bytes); aggregate → the dominant kind of what it folds (8 if none)
  d: 1,                  // present on directories (including packages)
  p: 1,                  // present on packages; packages never have ch
  a: 1,                  // present on aggregates
  c: 4521,               // dirs: total descendant files; aggregate: number of folded entries
  ch: [ … ]              // children, sorted by s desc (ties: name asc). Present on non-package dirs when depth allows; may be []
}
```
Query semantics:
- `minSize = focus.s * minFrac`. A child is included if `s > 0 && s >= minSize`, and each dir includes at most `maxChildren` (largest first).
- The excluded remainder becomes one aggregate child `{ k: 'a<dirId>', n: '', s: remainderBytes, t: foldedKind, a: 1, c: count }`. `remainderBytes = dir.s − Σ included`; emit it only if it is > 0. `count` is the number of folded entries with size > 0. `foldedKind` is the dominant kind of what the aggregate folds: the argmax of the per-kind bytes summed over the folded entries only (a file adds its size under its kind, a subdirectory adds its per-kind bytes, a package adds its whole size under its forced kind); ties go to the lower index, and 8 if nothing folded has bytes.
- `depth`: the focus's own `ch` is level 1. Recurse into child dirs while level < depth. A dir at the depth limit is sent without `ch`.
- Removed (trashed) items never appear.
- Target: under 15 ms for a 1M-file tree at depth 3. Filter by `minSize` *before* sorting.

## Size semantics
- Size is the **allocated** size, `st.blocks * 512`. This matches Finder's "on disk" figure, and evicted iCloud files correctly count as 0.
- Hard links count once (track `dev:ino` when `nlink > 1`).
- Symlinks are never followed; they count as their own lstat size.
- The scanner never descends into a path in `exclude` (exact match on the child's absolute path).
- Permission errors (EACCES/EPERM) and races (ENOENT) increment `errors` and skip the entry. They are never fatal.
- Traversal is **breadth-first** with bounded directory concurrency (about 64 in flight) and async `fs.promises`, so the picture fills in evenly while scanning.
- Propagation: once a directory's entries are stat'ed, its totals (bytes, file count, per-kind bytes) are added up the parent chain once per directory, not once per file. If an ancestor was removed, skip the propagation.

## Preload API — `window.tessera`

```js
tessera.getLocations()                    // → Promise<Location[]>
//   Location = { id, kind: 'disk'|'home'|'external', name, path, total?, free? }  (bytes)
//   disk: the volume that /Volumes/* resolves to "/" (e.g. "Macintosh HD"), path "/", statfs totals (free = bavail*bsize)
//   home: name "Home", path os.homedir(), detail is the user's short name in `user`
//   external: other /Volumes/* entries (skip hidden ones, the root alias, com.apple.TimeMachine.*, and mounted disk images such as .dmg installers, identified via `diskutil info -plist`)
tessera.chooseFolder()                    // → Promise<{ path, name } | null>  (native open panel, button "Scan")
tessera.pathForFile(file)                 // → string  (webUtils.getPathForFile; for drag & drop)
tessera.startScan({ path, name? })        // → Promise<{ scanId, path, name }>; rejects with Error('not-a-folder') if path isn't a dir
tessera.cancelScan()                      // → Promise<void>
tessera.getView({ key, depth, minFrac, maxChildren })   // → Promise<ViewRoot | null>  (null if no scanner)
tessera.reveal(key) / tessera.open(key) / tessera.quickLook(key) / tessera.copyPath(key)  // → Promise<void>
tessera.trash(key)                        // → Promise<{ trashed: boolean, freed?: number }>; main shows a sheet first
tessera.showContextMenu({ key, name, isDir, isPkg, size })  // native menu; "Open in Tessera" comes back as an app:command
tessera.openFullDiskAccess()              // opens System Settings → Privacy & Security → Full Disk Access
tessera.getAccentColor()                  // → Promise<'#rrggbb'>
tessera.onProgress(cb)    // cb({ scanId, files, dirs, bytes, errors, elapsed })
tessera.onScanDone(cb)    // cb({ scanId, files, dirs, bytes, errors, elapsed })
tessera.onCommand(cb)     // cb({ cmd, key?, path? }) — see commands below
tessera.onWindowState(cb) // cb({ fullscreen, focused })  — also sent once after load
tessera.onAccentColor(cb) // cb('#rrggbb')
tessera.onItemRemoved(cb) // cb({ key, freed })  — emitted after EVERY successful trash, whatever its source
tessera.dev               // { autoScan, shotDir, demo, recording, capture(name), record(cmd) } — see Dev hooks
// every on*() returns an unsubscribe function
```

IPC channels (invoke): `locations:get`, `dialog:choose-folder`, `scan:start`, `scan:cancel`, `scan:view`,
`item:reveal`, `item:open`, `item:quicklook`, `item:copy-path`, `item:trash`, `app:full-disk-access`,
`app:accent-color`, `dev:capture`. (send): `item:context-menu`.
Main → renderer: `scan:progress`, `scan:done`, `app:command`, `window:state`, `app:accent-changed`, `item:removed`.

Trash flow (main): resolve the path → `dialog.showMessageBox(win, { type: 'warning', message: 'Move “<name>” to the Trash?', detail: 'This frees up about <size>. You can put it back from the Trash in Finder.', buttons: ['Move to Trash', 'Cancel'], defaultId: 0, cancelId: 1 })`, shown as a sheet → `shell.trashItem(path)` → scanner `remove` → send `item:removed`. Sizes use decimal units like Finder (1 GB = 10^9).

### Commands (`app:command` payloads)
`{cmd:'open-folder'}` ⌘O · `{cmd:'scan-home'}` ⇧⌘H · `{cmd:'rescan'}` ⌘R · `{cmd:'show-locations'}` ⇧⌘L ·
`{cmd:'go-up'}` ⌘↑ · `{cmd:'open-selection'}` ⌘↓ · `{cmd:'quick-look'}` ⌘Y · `{cmd:'copy-path'}` ⌥⌘C ·
`{cmd:'trash-selection'}` ⌘⌫ · `{cmd:'zoom-into', key}` (context menu "Open in Tessera") ·
`{cmd:'scan-path', path}` (app `open-file`: a folder dropped on the Dock icon).

## Window & menus
- `BrowserWindow({ width: 1240, height: 820, minWidth: 760, minHeight: 520, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 20, y: 20 }, vibrancy: 'under-window', visualEffectState: 'followWindow', backgroundColor: '#00000000', show: false, webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, spellcheck: false } })`. Show it on `ready-to-show`. The renderer's toolbar is 52 px tall and has no divider; it blends into the content.
- **Appearance: dark only.** Main sets `nativeTheme.themeSource = 'dark'` on ready, so the vibrancy material, menus and sheets are dark whatever the system setting; the renderer has a single set of dark tokens and one palette.
- Menu: **Tessera** (About, Services, Hide, Hide Others, Show All, Quit) · **File** (Scan Folder… ⌘O, Scan Home Folder ⇧⌘H, Rescan ⌘R, —, Close Window ⌘W) · **Edit** (standard roles, —, Copy Path ⌥⌘C, Move to Trash ⌘⌫) · **View** (Locations ⇧⌘L, —, Enclosing Folder ⌘↑, Open Selection ⌘↓, Quick Look ⌘Y, —, Enter Full Screen role, Developer submenu with Toggle DevTools ⌥⌘I *only when not packaged*) · **Window** (role windowMenu).
- Context menu for a tile: Open in Tessera (non-package dirs) · Open (files & packages, `shell.openPath`) · Quick Look · — · Reveal in Finder · Copy Path · — · Move to Trash…
- Quick Look: `win.previewFile(path, name)`. Reveal: `shell.showItemInFolder`.
- About panel: name Tessera, version from package.json, credits "See what's taking up space."
- In dev (not packaged), set the dock icon to `build/icon.png` when it exists.

## Scan exclusions (main computes, passes in `exclude`)
Every mount point from `/sbin/mount` output (the `on <path> (` part). For each `/System/Volumes/Data/X` mount, also add the firmlinked `/X`. Plus these: `/System/Volumes`, `/Volumes`, `/dev`, `/net`, `/home`, `/private/var/vm`, `/cores`. Keep only the entries strictly inside the scan root (root `/` keeps all of them). Never exclude the root itself.

## Dev hooks
- `TESSERA_AUTOSCAN=/some/path`: exposed as `tessera.dev.autoScan`. The renderer starts that scan on load.
- `TESSERA_SHOT_DIR=/dir`: `tessera.dev.capture(name)` saves `webContents.capturePage()` as `<dir>/<name>.png` and resolves to the path.
- `TESSERA_SELFTEST=/some/path`: main skips the UI flow, scans the path, prints `{files, bytes, elapsed}` plus the top 10 children of the root view as JSON to stdout, then quits (exit code 0 on success).
- `TESSERA_DEMO=1`: exposed as `tessera.dev.demo`. The renderer takes its data from `js/mock.js` (a fabricated home folder) but keeps the real window, language and dev hooks; the tour scans the demo instead of a real path.
- `TESSERA_RECORD_DIR=/dir`: exposed as `tessera.dev.recording`; `tessera.dev.record('start'|'stop')` subscribes to painted frames and writes `fNNNNN.jpg` (1600 px wide) plus `frames.json` (`{ end, frames: [{ file, t }] }`). The tour then plays its paced "film" take instead of taking screenshots.
- With either `TESSERA_SHOT_DIR` or `TESSERA_RECORD_DIR`, background throttling is off and renderer warnings/errors are echoed to stdout.

## Visual identity (shared by icon + in-app logomark)
The mark is a mosaic of seven rounded tiles in the unit square. Each tile is a rect `[x, y, w, h]`, inset by half the gap:
```
blue    #2a78d6  [0.00, 0.00, 0.58, 0.62]
violet  #6250d6  [0.00, 0.62, 0.58, 0.38]
orange  #eb6834  [0.58, 0.00, 0.42, 0.36]
aqua    #1baf7a  [0.58, 0.36, 0.42, 0.26]
magenta #e87ba4  [0.58, 0.62, 0.24, 0.38]
yellow  #eda100  [0.82, 0.62, 0.18, 0.22]
green   #2f9e44  [0.82, 0.84, 0.18, 0.16]
```

## Languages (English default · 简体中文)

Tessera ships in **English (default)** and **Simplified Chinese**. It doesn't follow the system language. The user picks a language in **View → Language** (radio items "English" / "简体中文"). Each label is written in its own language, so it's always findable.

- Persistence: main stores `{ "language": "en" | "zh" }` in `app.getPath('userData')/settings.json`, merged with any other settings there. Missing or invalid values → `"en"`.
- Main-process strings live in `src/main/i18n.js` (`t(key, vars)` plus `setLanguage(lang)`). That covers every menu label (role items get explicit `label`s so they're translated too), the context menu, the trash confirmation sheet, the open panel's title and button, and the About panel credits. Changing the language rebuilds the application menu immediately and notifies the renderer.
- IPC: `app:get-language` (invoke → `'en'|'zh'`), `app:set-language` (invoke with the lang; persists, rebuilds the menu, broadcasts), main → renderer `app:language-changed` (lang).
- Preload: `tessera.getLanguage()`, `tessera.setLanguage(lang)`, `tessera.onLanguage(cb)` (returns unsubscribe).
- The renderer owns its own strings in `src/renderer/js/i18n.js`.

macOS Chinese conventions to use: Finder → 访达, Trash → 废纸篓, Quick Look → 快速查看, Home folder → 个人文件夹, View menu → 显示, File → 文件, Edit → 编辑, Window → 窗口, Copy → 拷贝.

| key | en | zh |
|---|---|---|
| about | About Tessera | 关于 Tessera |
| services | Services | 服务 |
| hide | Hide Tessera | 隐藏 Tessera |
| hideOthers | Hide Others | 隐藏其他 |
| showAll | Show All | 全部显示 |
| quit | Quit Tessera | 退出 Tessera |
| file | File | 文件 |
| scanFolder | Scan Folder… | 扫描文件夹… |
| scanHome | Scan Home Folder | 扫描个人文件夹 |
| rescan | Rescan | 重新扫描 |
| closeWindow | Close Window | 关闭窗口 |
| edit | Edit | 编辑 |
| undo / redo / cut / copy / paste / selectAll | Undo / Redo / Cut / Copy / Paste / Select All | 撤销 / 重做 / 剪切 / 拷贝 / 粘贴 / 全选 |
| copyPath | Copy Path | 拷贝路径 |
| moveToTrash | Move to Trash | 移到废纸篓 |
| view | View | 显示 |
| locations | Locations | 位置 |
| enclosingFolder | Enclosing Folder | 上层文件夹 |
| openSelection | Open Selection | 打开所选项 |
| quickLook | Quick Look | 快速查看 |
| fullScreen | Enter Full Screen | 进入全屏幕 |
| language | Language | 语言 |
| developer | Developer | 开发者 |
| toggleDevTools | Toggle Developer Tools | 切换开发者工具 |
| window | Window | 窗口 |
| minimize / zoom / front | Minimize / Zoom / Bring All to Front | 最小化 / 缩放 / 前置全部窗口 |
| openInTessera | Open in Tessera | 在 Tessera 中打开 |
| open | Open | 打开 |
| revealInFinder | Reveal in Finder | 在访达中显示 |
| moveToTrashEllipsis | Move to Trash… | 移到废纸篓… |
| trashMessage | Move “{name}” to the Trash? | 要将“{name}”移到废纸篓吗？ |
| trashDetail | This frees up about {size}. You can put it back from the Trash in Finder. | 这将释放约 {size} 空间。你可以在访达的废纸篓中将它放回原处。 |
| cancel | Cancel | 取消 |
| openPanelTitle | Choose a Folder to Scan | 选择要扫描的文件夹 |
| openPanelButton | Scan | 扫描 |
| credits | See what's taking up space. | 看清是什么占用了空间。 |
| homeName | Home | 个人文件夹 |
