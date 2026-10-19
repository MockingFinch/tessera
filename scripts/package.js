// Builds dist/Tessera-darwin-<arch>/Tessera.app.
//
//   npm run package                          arm64 only (= node scripts/package.js)
//   npm run release                          arm64 + x64, each zipped for a GitHub release
//   node scripts/package.js --arch=x64 --zip
//
// --zip writes dist/Tessera-<version>-mac-<arch>.zip with `ditto`, which keeps
// the bundle's symlinks and signature intact (plain `zip` does not).
//
// Uses @electron/packager (ESM-only since v20, so it is loaded with a dynamic
// import from this CommonJS script). The Electron zip comes from the
// @electron/get cache (~/Library/Caches/electron) when present.
//
// The scanner (src/scanner/worker.js) runs from inside app.asar: Electron 44's
// utilityProcess.fork() resolves entry points and require()s through the asar
// archive, so nothing needs to be unpacked.
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

const ICON = path.join(ROOT, 'build', 'icon.icns');

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
const ARCHS = (flag('arch')?.split('=')[1] || 'arm64').split(',');
const ZIP = Boolean(flag('zip'));

// Matched against paths relative to ROOT, with a leading slash.
const IGNORE = [
  /^\/(dist|docs|scripts|build\/icon\.iconset|\.nvmrc|SPEC\.md)/,
  /^\/build\/icon\.icns$/, // copied into Contents/Resources by the packager; build/icon.png stays (main uses it)
  /^\/(README|CHANGELOG|CONTRIBUTING|CLAUDE|AGENTS)(\.md)?$/i,
  /^\/\.(claude|vscode|idea|github|cache)(\/|$)/,
  /^\/\.(gitignore|gitattributes|editorconfig|npmrc|prettierrc.*|eslintrc.*)$/,
  /^\/(eslint|prettier)\.config\.[cm]?js$/,
  /^\/(test|tests|__tests__|bench|coverage|tmp)(\/|$)/,
  /\.(log|map)$/,
  /^\/node_modules\/\.package-lock\.json$/,
];
// Tessera has no runtime dependencies. Pruning drops the devDependencies but
// leaves their empty scope folders behind, so skip node_modules outright
// unless a runtime dependency gets added.
if (!Object.keys(pkg.dependencies || {}).length) IGNORE.push(/^\/node_modules(\/|$)/);

function signatureValid(app) {
  const r = spawnSync('codesign', ['--verify', '--deep', '--strict', app], { encoding: 'utf8' });
  return { ok: r.status === 0, detail: (r.stderr || '').trim() };
}

function duSize(p) {
  try {
    return execFileSync('du', ['-sh', p], { encoding: 'utf8' }).split('\t')[0].trim();
  } catch {
    return '?';
  }
}

async function main() {
  if (process.platform !== 'darwin') throw new Error('Tessera packages for macOS only');
  if (!fs.existsSync(ICON)) {
    throw new Error('build/icon.icns is missing; run `npm run icon` first');
  }

  const { packager } = await import('@electron/packager');
  const year = new Date().getFullYear();

  const appPaths = await packager({
    dir: ROOT,
    name: 'Tessera',
    appBundleId: 'app.tessera.mac',
    appCategoryType: 'public.app-category.utilities',
    appVersion: pkg.version,
    buildVersion: pkg.version,
    icon: ICON,
    platform: 'darwin',
    arch: ARCHS,
    out: path.join(ROOT, 'dist'),
    overwrite: true,
    asar: true,
    prune: true,
    darwinDarkModeSupport: true,
    ignore: IGNORE,
    extendInfo: {
      NSHumanReadableCopyright: `Copyright © ${year} Tessera. All rights reserved.`,
      LSMinimumSystemVersion: '13.0',
      // Lets folders and volumes be dropped onto the Dock icon (main handles
      // app 'open-file' and starts a scan of that path).
      CFBundleDocumentTypes: [
        {
          CFBundleTypeName: 'Folder',
          CFBundleTypeRole: 'Viewer',
          LSHandlerRank: 'Alternate',
          LSItemContentTypes: ['public.folder', 'public.volume'],
        },
      ],
    },
  });

  for (const outDir of appPaths) {
    const app = path.join(outDir, 'Tessera.app');
    // The packager edits Info.plist and renames the executable, which breaks
    // the bundle seal of Electron's stock ad-hoc signature. Re-seal ad hoc so
    // the app verifies and launches cleanly on Apple silicon.
    const before = signatureValid(app);
    if (!before.ok) {
      execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
      const after = signatureValid(app);
      if (!after.ok) throw new Error(`ad-hoc signing failed: ${after.detail}`);
      console.log('signed:   ad hoc (codesign --force --deep --sign -)');
    } else {
      console.log('signed:   existing signature verifies');
    }
    console.log(`built:    ${path.relative(ROOT, app)} (${duSize(app)})`);
    console.log(`asar:     ${duSize(path.join(app, 'Contents', 'Resources', 'app.asar'))}`);

    if (ZIP) {
      const arch = path.basename(outDir).split('-').pop();
      const zip = path.join(ROOT, 'dist', `Tessera-${pkg.version}-mac-${arch}.zip`);
      fs.rmSync(zip, { force: true });
      execFileSync('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, zip]);
      console.log(`zipped:   ${path.relative(ROOT, zip)} (${duSize(zip)})`);
    }
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
