/**
 * Lazy loader for @untacit/extractors — same contract as core-loader.ts.
 *
 * The interview routes are the only consumer: the sidecar keeps serving all
 * read/review routes when extractors (or its LLM dependency) cannot resolve,
 * and the interview endpoints answer 503 with the load error instead.
 */

import type * as ExtractorsNS from '@untacit/extractors';

export type ExtractorsModule = typeof ExtractorsNS;

let cached: ExtractorsModule | undefined;
let lastError: string | undefined;

export async function loadExtractors(): Promise<ExtractorsModule | undefined> {
  if (cached !== undefined) return cached;
  const errors: string[] = [];
  try {
    // Literal specifier on purpose: the release bundle (scripts/
    // stage-sidecar.mjs) statically inlines the workspace package here, so
    // the interview engine works in the installed app without node_modules.
    cached = await import('@untacit/extractors');
    lastError = undefined;
    return cached;
  } catch (err) {
    errors.push(`@untacit/extractors: ${err instanceof Error ? err.message : String(err)}`);
  }
  // packages/app/sidecar/ -> packages/extractors/src/index.ts (tsx loads
  // .ts). Non-literal on purpose: tsc must not try to resolve the .ts
  // fallback, and bundlers must not pre-bundle it.
  const fallback = new URL('../../extractors/src/index.ts', import.meta.url).href;
  try {
    cached = (await import(fallback)) as ExtractorsModule;
    lastError = undefined;
    return cached;
  } catch (err) {
    errors.push(`${fallback}: ${err instanceof Error ? err.message : String(err)}`);
  }
  lastError = errors.join(' | ');
  return undefined;
}

/** Why the last loadExtractors() failed (undefined when it succeeded or never ran). */
export function extractorsLoadError(): string | undefined {
  return lastError;
}
