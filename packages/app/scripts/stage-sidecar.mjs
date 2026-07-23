/**
 * Stage a self-contained sidecar under sidecar/dist/ for the installed app
 * (`pnpm bundle:sidecar`, run by Tauri's beforeBuildCommand and shipped as
 * the `sidecar/` bundle resource — see src-tauri/tauri.conf.json).
 *
 * Layout produced:
 *   sidecar/dist/server.mjs        esbuild bundle of the sidecar with
 *                                  @untacit/core and @untacit/extractors
 *                                  compiled in from their TypeScript sources
 *                                  (tsconfig.sidecar.json "paths" — the same
 *                                  mapping tsc and vitest use)
 *   sidecar/dist/node_modules/     the native module better-sqlite3 plus its
 *                                  runtime deps (bindings, file-uri-to-path),
 *                                  copied with the prebuilt .node binary
 *
 * The only runtime requirement left on the user's machine is Node.js ≥ 20
 * (docs/08). Because better-sqlite3 ships a platform-specific binary, this
 * script must run on the same OS/arch as the installer it feeds — the
 * desktop workflow runs it on windows-latest for the Windows installer.
 */

import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = join(appRoot, 'sidecar', 'dist');

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

await build({
  entryPoints: [join(appRoot, 'sidecar', 'server.ts')],
  outfile: join(outDir, 'server.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  // NOT the auto-discovered tsconfig.json (its "paths" maps @untacit/core to
  // types.ts, the type-only view for the frontend): the sidecar mapping
  // resolves the workspace packages to their real sources.
  tsconfig: join(appRoot, 'tsconfig.sidecar.json'),
  // Native module: stays external and is copied as a real package below.
  external: ['better-sqlite3'],
  // CJS deps reached from the ESM bundle need a require() in scope.
  banner: {
    js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
  },
  logLevel: 'info',
});

// Copy the native module next to the bundle. Resolution starts from
// @untacit/core (its dependent), so pnpm's isolated layout is honored.
const coreDir = resolve(appRoot, '..', 'core');
const requireFromCore = createRequire(join(coreDir, 'package.json'));
/** Packages needed at runtime: better-sqlite3 requires bindings, which
 * requires file-uri-to-path. (prebuild-install is install-time only.) */
const NATIVE_RUNTIME_PACKAGES = ['better-sqlite3', 'bindings', 'file-uri-to-path'];

let resolveFrom = requireFromCore;
for (const name of NATIVE_RUNTIME_PACKAGES) {
  const pkgJson = resolveFrom.resolve(`${name}/package.json`);
  const srcDir = dirname(pkgJson);
  const destDir = join(outDir, 'node_modules', name);
  cpSync(srcDir, destDir, { recursive: true, dereference: true });
  // bindings/file-uri-to-path are deps of better-sqlite3, not of core:
  // resolve each package from the previous one in the chain.
  resolveFrom = createRequire(pkgJson);
  console.log(`[stage-sidecar] copied ${name} <- ${srcDir}`);
}

// ---------------------------------------------------------------------------
// Local multilingual embeddings: @huggingface/transformers and its full
// production-dependency closure. The core resolves it with a dynamic
// non-literal import (packages/core/src/embeddings), so esbuild leaves it
// external and the staged sidecar needs it as real packages on disk.
// UNTACIT_SIDECAR_SLIM=1 skips it (the app then runs with the semantic
// channel disabled — embeddings.provider 'auto' degrades gracefully).
// ---------------------------------------------------------------------------

if (process.env.UNTACIT_SIDECAR_SLIM === '1') {
  console.log('[stage-sidecar] UNTACIT_SIDECAR_SLIM=1 — skipping @huggingface/transformers');
} else {
  stageDependencyClosure('@huggingface/transformers', createRequire(join(appRoot, '..', '..', 'package.json')));
  pruneOnnxRuntimeBinaries();
}

/**
 * Copy a package and every transitive production dependency into
 * sidecar/dist/node_modules, resolving each dependency from its dependent so
 * pnpm's isolated layout is honored. Optional dependencies that do not
 * resolve on this host (e.g. other platforms' sharp binaries) are skipped.
 */
function stageDependencyClosure(rootName, rootRequire) {
  const queue = [[rootName, rootRequire]];
  // Declared but not needed at runtime: transformers.node.mjs inlines
  // onnxruntime-web into its own bundle (only -node/-common are imported),
  // and @types/node is a types-only package some dep declares as prod.
  const staged = new Set([...NATIVE_RUNTIME_PACKAGES, 'onnxruntime-web', '@types/node']);
  while (queue.length > 0) {
    const [name, requireFromParent] = queue.shift();
    if (staged.has(name)) continue;
    let pkgJsonPath;
    try {
      // Packages with an "exports" map (no ./package.json subpath) need the
      // resolve-from-module-dir fallback.
      pkgJsonPath = requireFromParent.resolve(`${name}/package.json`);
    } catch {
      try {
        const entry = requireFromParent.resolve(name);
        pkgJsonPath = findPackageJson(entry, name);
      } catch {
        // Binary-only packages (e.g. @img/sharp-linux-x64) have no importable
        // entry point: locate their directory through the parent's search
        // paths instead. Foreign-platform variants are genuinely absent.
        pkgJsonPath = undefined;
        for (const searchDir of requireFromParent.resolve.paths(name) ?? []) {
          const candidate = join(searchDir, ...name.split('/'), 'package.json');
          if (existsSync(candidate)) {
            pkgJsonPath = candidate;
            break;
          }
        }
        if (pkgJsonPath === undefined) {
          console.log(`[stage-sidecar] optional ${name} not resolvable on this host — skipped`);
          continue;
        }
      }
    }
    if (pkgJsonPath === undefined) {
      console.log(`[stage-sidecar] could not locate package.json of ${name} — skipped`);
      continue;
    }
    staged.add(name);
    const srcDir = dirname(pkgJsonPath);
    const destDir = join(outDir, 'node_modules', ...name.split('/'));
    cpSync(srcDir, destDir, { recursive: true, dereference: true });
    console.log(`[stage-sidecar] copied ${name} <- ${srcDir}`);
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    const requireFromHere = createRequire(pkgJsonPath);
    for (const dep of Object.keys({
      ...(pkg.dependencies ?? {}),
      ...(pkg.optionalDependencies ?? {}),
    })) {
      queue.push([dep, requireFromHere]);
    }
  }
}

/** Walk up from a resolved entry file to the package.json of `name`. */
function findPackageJson(entryFile, name) {
  let dir = dirname(entryFile);
  const tail = join(...name.split('/'));
  for (let i = 0; i < 10; i++) {
    const candidate = join(dir, 'package.json');
    if (dir.endsWith(tail) && existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * onnxruntime-node ships prebuilt binaries for every OS/arch (~200 MB). The
 * staged sidecar runs on the same platform this script runs on (see the
 * header), so foreign platform/arch directories only bloat the installer.
 */
function pruneOnnxRuntimeBinaries() {
  const binRoot = join(outDir, 'node_modules', 'onnxruntime-node', 'bin', 'napi-v6');
  if (!existsSync(binRoot)) return;
  for (const platform of readdirSync(binRoot)) {
    const platformDir = join(binRoot, platform);
    if (platform !== process.platform) {
      rmSync(platformDir, { recursive: true, force: true });
      console.log(`[stage-sidecar] pruned onnxruntime binaries for ${platform}`);
      continue;
    }
    for (const arch of readdirSync(platformDir)) {
      if (arch !== process.arch) {
        rmSync(join(platformDir, arch), { recursive: true, force: true });
        console.log(`[stage-sidecar] pruned onnxruntime binaries for ${platform}/${arch}`);
        continue;
      }
      // GPU execution providers (CUDA ~300 MB, TensorRT) — the sidecar runs
      // CPU inference; onnxruntime loads these lazily only when requested.
      for (const file of readdirSync(join(platformDir, arch))) {
        if (/cuda|tensorrt/i.test(file)) {
          rmSync(join(platformDir, arch, file), { force: true });
          console.log(`[stage-sidecar] pruned GPU provider ${file}`);
        }
      }
    }
  }
}

const nativeBinary = join(
  outDir,
  'node_modules',
  'better-sqlite3',
  'build',
  'Release',
  'better_sqlite3.node',
);
if (!existsSync(nativeBinary)) {
  console.error(
    `[stage-sidecar] better_sqlite3.node missing at ${nativeBinary} — ` +
      'reinstall dependencies (pnpm install) so the prebuilt binary exists',
  );
  process.exit(1);
}

console.log(`[stage-sidecar] staged sidecar at ${outDir}`);
