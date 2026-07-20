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
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
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
