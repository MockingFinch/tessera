'use strict';
// File-kind classification for the Tessera scanner.
// Kind indices are shared with the renderer (docs/SPEC.md, "Kinds") — never reorder.

const KIND_IDS = Object.freeze([
  'apps', 'video', 'photos', 'audio', 'documents', 'archives', 'developer', 'system', 'other',
]);
const KIND_LABELS = Object.freeze([
  'Apps', 'Video', 'Photos', 'Audio', 'Documents', 'Archives', 'Developer', 'System', 'Other',
]);
const KIND_COUNT = 9;

const APPS = 0, VIDEO = 1, PHOTOS = 2, AUDIO = 3, DOCUMENTS = 4, ARCHIVES = 5,
  DEVELOPER = 6, SYSTEM = 7, OTHER = 8;

function table(groups) {
  const m = new Map();
  for (const [kind, list] of groups) {
    for (const ext of list.split(/\s+/)) if (ext) m.set(ext.toLowerCase(), kind);
  }
  return m;
}

// ---- File extensions (lowercased, without the dot) -------------------------------------------
// The first word list on each line is the spec table; the rest are obvious additions.
const FILE_EXT = table([
  [VIDEO, 'mp4 mov m4v mkv avi webm wmv flv mts m2ts 3gp mpg mpeg vob prproj braw r3d ' +
    'ogv f4v m2v mxf divx hevc 3g2 asf rm rmvb dv insv lrv'],
  [PHOTOS, 'jpg jpeg png heic heif gif tif tiff bmp webp avif raw cr2 cr3 nef arw dng orf rw2 raf srw ' +
    'psd psb ai svg sketch fig xcf exr hdr ' +
    'jxl jfif jp2 ico icns pef nrw kdc x3f erf mrw 3fr eps afphoto afdesign pxd procreate xd aae xmp'],
  [AUDIO, 'mp3 m4a m4b aac wav aif aiff flac alac ogg oga opus wma caf mid midi amr ape ' +
    'aifc wv dsf dff mka au snd ra spx mpc als ptx'],
  [DOCUMENTS, 'pdf doc docx pages key numbers xls xlsx ppt pptx txt rtf md markdown epub csv tsv odt ods odp tex ' +
    'docm dotx xlsm xltx pptm ppsx pps odg mobi azw azw3 djvu xps oxps rst adoc org vcf ics eml emlx mbox ' +
    'webarchive indd'],
  [ARCHIVES, 'zip dmg iso pkg mpkg tar gz tgz bz2 xz zst 7z rar xip sparseimage dmgpart ipsw cpgz lz4 ' +
    'tbz tbz2 txz lzma lz z cab sit sitx zipx xar cpio deb rpm apk ipa img toast vhd vhdx vmdk qcow2 vdi'],
  [DEVELOPER, 'js mjs cjs ts tsx jsx py rb go rs c h cc cpp hpp m mm swift kt java class jar json yml yaml ' +
    'toml lock wasm o a pyc map sql ipynb sh zsh ' +
    'cts vue svelte css scss sass less html htm xml xib storyboard pbxproj xcconfig entitlements ' +
    'modulemap swiftmodule swiftdoc swiftinterface swiftsourceinfo pch gch pcm obj pdb php pl pm lua r scala ' +
    'kts gradle groovy clj cljs ex exs erl hrl hs ml dart cs fs vb cxx hxx hh inl ipp asm s ll bc rlib rmeta ' +
    'pyi pyd pyo egg whl gem node tsbuildinfo snap patch diff proto graphql gql tf ini cfg conf env bash fish ' +
    'ps1 bat cmd mk cmake jsonc json5 jsonl ndjson npy npz pkl pickle h5 hdf5 parquet arrow feather onnx ' +
    'pt pth ckpt safetensors gguf tflite mlmodel xcuserstate xcscheme'],
  [SYSTEM, 'dylib so plist log db sqlite sqlite-wal sqlite-shm cache tmp ttf otf ttc nib car metallib dat ' +
    'bin vmem sleepimage ' +
    'sqlite3 sqlitedb db-wal db-shm db-journal ldb realm pak asar strings stringsdict tbd dll sys ' +
    'woff woff2 eot dfont fon crash ips diag spin tracev3 mobileprovision keychain keychain-db savedstate bom ' +
    'journal idx swap pid lck heapsnapshot'],
]);

// Exact (lowercased) file names that carry no useful extension.
const FILE_NAMES = new Map([
  ['.ds_store', SYSTEM], ['.localized', SYSTEM], ['icon\r', SYSTEM],
  ['makefile', DEVELOPER], ['dockerfile', DEVELOPER], ['gemfile', DEVELOPER], ['podfile', DEVELOPER],
  ['rakefile', DEVELOPER], ['cartfile', DEVELOPER], ['brewfile', DEVELOPER], ['procfile', DEVELOPER],
  ['.gitignore', DEVELOPER], ['.gitattributes', DEVELOPER], ['.gitmodules', DEVELOPER],
  ['.npmrc', DEVELOPER], ['.nvmrc', DEVELOPER], ['.editorconfig', DEVELOPER], ['.eslintrc', DEVELOPER],
  ['.prettierrc', DEVELOPER], ['.babelrc', DEVELOPER], ['.env', DEVELOPER],
]);

// ---- Packages (directory extensions → forced kind) -------------------------------------------
const PACKAGE_EXT = table([
  [APPS, 'app appex prefPane saver qlgenerator mdimporter'],
  [PHOTOS, 'photoslibrary photolibrary aplibrary migratedphotolibrary'],
  [VIDEO, 'tvlibrary fcpbundle imovielibrary fcpproject'],
  [AUDIO, 'logicx band musiclibrary'],
  [DOCUMENTS, 'pages numbers key rtfd scriv graffle'],
  [SYSTEM, 'framework bundle plugin kext component vst vst3 xpc systemextension driver'],
  [DEVELOPER, 'xcarchive xcodeproj xcworkspace playground xcassets docc dSYM'],
  [ARCHIVES, 'sparsebundle pkg mpkg'],
]);

// ---- Forced-kind directories (apply to all descendants, stay expandable) ----------------------
const FORCED_DEV_DIRS = new Set(('node_modules .git DerivedData Pods .venv venv __pycache__ .gradle .m2 ' +
  '.cargo .rustup .npm .pnpm-store .yarn .cocoapods .swiftpm .build .next .nuxt .turbo').split(' '));

function extOf(name) {
  const dot = name.lastIndexOf('.');
  // dot === 0 is a dotfile with no extension; long "extensions" are just names with dots in them.
  if (dot <= 0 || name.length - dot > 16) return '';
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Kind index for a file. `forcedKind` (≥ 0) comes from the nearest forced-kind ancestor and wins.
 */
function classifyFile(name, forcedKind) {
  if (forcedKind >= 0) return forcedKind;
  const ext = extOf(name);
  if (ext) {
    const k = FILE_EXT.get(ext);
    if (k !== undefined) return k;
  }
  if (ext === '' || name.charCodeAt(0) === 46 /* . */) {
    const k = FILE_NAMES.get(name.toLowerCase());
    if (k !== undefined) return k;
  }
  return OTHER;
}

/** Kind index if `dirName` is an opaque package (e.g. Foo.app), otherwise -1. */
function packageKind(dirName) {
  const ext = extOf(dirName);
  if (!ext) return -1;
  const k = PACKAGE_EXT.get(ext);
  return k === undefined ? -1 : k;
}

/** Forced kind a directory imposes on its descendants (node_modules, Library/Caches, …), or -1. */
function forcedDirKind(dirName, parentName) {
  if (FORCED_DEV_DIRS.has(dirName)) return DEVELOPER;
  if (dirName === 'Caches' && parentName === 'Library') return SYSTEM;
  return -1;
}

module.exports = {
  KIND_COUNT,
  KIND_IDS,
  KIND_LABELS,
  KIND: Object.freeze({ APPS, VIDEO, PHOTOS, AUDIO, DOCUMENTS, ARCHIVES, DEVELOPER, SYSTEM, OTHER }),
  classifyFile,
  packageKind,
  forcedDirKind,
};
