/**
 * Shared pieces of the "engine = local Claude Code" surface, used by both
 * sidecar/extract.ts and sidecar/interview.ts.
 *
 * There is no Anthropic API client and no ANTHROPIC_API_KEY anywhere in
 * untacit (docs/03 §4): every completion runs through the local `claude`
 * binary. This module owns the two things both route families need from it.
 */

import type { ExtractorsModule } from './extractors-loader.js';

/**
 * Model ids accepted from a request body.
 *
 * The value ends up in the `claude --model` argv, and on Windows a bare
 * `claude` / `claude.cmd` shim has to be spawned through a shell (see the
 * spawnPlan comment in packages/extractors/src/llm.ts) where argv is NOT
 * escaped. For the CLI that is harmless — `--model` comes from the user's own
 * shell. Here it arrives over HTTP on a CORS-open localhost port, so any page
 * the user visits could post one. Real model ids are aliases (`opus`) or ids
 * (`claude-opus-4-5-20251101`), so a strict allowlist costs nothing and closes
 * the hole.
 */
const MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,79}$/;

/**
 * Read an optional `model` from a request body. Absent/blank → undefined
 * ("whatever Claude Code defaults to"); anything outside the allowlist throws
 * a message the shared error mapper turns into a 400.
 */
export function modelFromPayload(payload: { model?: unknown }): string | undefined {
  const raw = payload.model;
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string') {
    throw new Error('"model" must have a string value (a Claude Code model id or alias)');
  }
  const model = raw.trim();
  if (model === '') return undefined;
  if (!MODEL_PATTERN.test(model)) {
    throw new Error(
      `"model" must have only letters, digits and . _ : @ / - (got ${JSON.stringify(model.slice(0, 40))})`,
    );
  }
  return model;
}

/** How long a `claude --version` probe result is trusted. */
const PROBE_TTL_MS = 30_000;

/**
 * Cached `claudeCodeAvailable()`.
 *
 * The probe is `execFileSync('claude', ['--version'])` with a 15 s timeout —
 * it blocks the sidecar's event loop, which would stall an extraction job's
 * progress stream. GET /api/extract/sources runs it on every mount and after
 * every job, so it is cached; the short TTL still lets someone who installs
 * Claude Code mid-session recover without restarting the app.
 */
export function createEngineProbe(): (extractors: ExtractorsModule) => {
  ok: boolean;
  detail: string;
} {
  let cached: { at: number; result: { ok: boolean; detail: string } } | undefined;
  return (extractors) => {
    const now = Date.now();
    if (cached !== undefined && now - cached.at < PROBE_TTL_MS) return cached.result;
    const result = extractors.claudeCodeAvailable();
    cached = { at: now, result };
    return result;
  };
}
