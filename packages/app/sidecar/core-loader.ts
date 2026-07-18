/**
 * Lazy loader for @untacit/core.
 *
 * While agents work in parallel, packages/core may not have a built dist/ yet.
 * Resolution order at runtime:
 *   1. "@untacit/core" — the workspace package (dist/, the normal path; also
 *      what vitest resolves via its alias to core sources).
 *   2. core's TypeScript sources directly — works when the sidecar runs under
 *      tsx (the `pnpm dev` / `pnpm sidecar` path).
 * When neither resolves, the sidecar keeps serving and every /api route that
 * needs the core answers 503 "core not built yet" (see app.ts).
 */

import type * as CoreNS from '@untacit/core';

export type CoreModule = typeof CoreNS;

let cached: CoreModule | undefined;
let lastError: string | undefined;

function candidates(): string[] {
  return [
    '@untacit/core',
    // packages/app/sidecar/ -> packages/core/src/index.ts (tsx can load .ts)
    new URL('../../core/src/index.ts', import.meta.url).href,
  ];
}

export async function loadCore(): Promise<CoreModule | undefined> {
  if (cached !== undefined) return cached;
  const errors: string[] = [];
  for (const specifier of candidates()) {
    try {
      // Non-literal specifier on purpose: tsc must not try to resolve the
      // .ts fallback, and bundlers must not pre-bundle it.
      cached = (await import(specifier)) as CoreModule;
      lastError = undefined;
      return cached;
    } catch (err) {
      errors.push(`${specifier}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  lastError = errors.join(' | ');
  return undefined;
}

/** Why the last loadCore() failed (undefined when it succeeded or never ran). */
export function coreLoadError(): string | undefined {
  return lastError;
}
