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

function candidates(): string[] {
  return [
    '@untacit/extractors',
    // packages/app/sidecar/ -> packages/extractors/src/index.ts (tsx loads .ts)
    new URL('../../extractors/src/index.ts', import.meta.url).href,
  ];
}

export async function loadExtractors(): Promise<ExtractorsModule | undefined> {
  if (cached !== undefined) return cached;
  const errors: string[] = [];
  for (const specifier of candidates()) {
    try {
      // Non-literal specifier on purpose: tsc must not try to resolve the
      // .ts fallback, and bundlers must not pre-bundle it.
      cached = (await import(specifier)) as ExtractorsModule;
      lastError = undefined;
      return cached;
    } catch (err) {
      errors.push(`${specifier}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  lastError = errors.join(' | ');
  return undefined;
}

/** Why the last loadExtractors() failed (undefined when it succeeded or never ran). */
export function extractorsLoadError(): string | undefined {
  return lastError;
}
