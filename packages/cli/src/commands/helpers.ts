/** Shared option parsing/resolution helpers for the untacit CLI commands. */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { configPath, createEmbeddingProvider, loadConfig } from '@untacit/core';
import type { EmbeddingProvider, EmbeddingsConfig } from '@untacit/core';

/**
 * Resolve --graph and refuse a directory that is not a graph repo. Without
 * this, GraphIndex.open would fabricate an empty index at the typo'd path
 * and e.g. `conflicts --json` would report a clean graph (exit 0) for a
 * repo that was never looked at — poison under the "exit 2 = findings"
 * contract.
 */
export function graphRoot(opts: { graph?: string }): string {
  const dir = resolve(opts.graph ?? process.cwd());
  if (!existsSync(configPath(dir))) {
    throw new Error(
      `no untacit.config.json at ${dir} — not a graph repo (create one with \`untacit init ${dir}\`, or fix --graph)`,
    );
  }
  return dir;
}

/**
 * Branch for an extraction-as-PR import: `--branch name` uses the name,
 * bare `--branch` derives `run/<run_id>` from the batch, absent → undefined.
 */
export function runBranchName(
  flag: string | boolean | undefined,
  batchJson: unknown,
): string | undefined {
  if (flag === undefined || flag === false) return undefined;
  if (typeof flag === 'string') return flag;
  const runId =
    typeof batchJson === 'object' && batchJson !== null && 'run_id' in batchJson
      ? String((batchJson as { run_id: unknown }).run_id)
      : 'batch';
  return `run/${runId}`;
}

/** Parse a numeric CLI option strictly: a positive integer or a loud error. */
export function positiveInt(raw: string, flag: string): number {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${flag} must be a positive integer, got "${raw}"`);
  }
  return value;
}

/**
 * Provider for CLI commands: --provider/--model override the repo config;
 * without either, untacit.config.json decides (docs/03 §3).
 */
export async function providerFor(
  repo: string,
  opts: { provider?: string; model?: string },
): Promise<EmbeddingProvider | null> {
  const config = loadConfig(repo)?.embeddings;
  const merged: EmbeddingsConfig = {
    provider: (opts.provider ?? config?.provider ?? 'auto') as EmbeddingsConfig['provider'],
    ...(opts.model ?? config?.model ? { model: opts.model ?? config?.model } : {}),
  };
  return createEmbeddingProvider(merged);
}

/** Version from the package manifest (works from dist/ and from src/ under tsx). */
export function cliVersion(): string {
  try {
    const manifest = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');
    const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}
