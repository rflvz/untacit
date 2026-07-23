/**
 * `untacit doctor` — environment + graph-repo diagnostics in the spirit of
 * `claude doctor`: one line per check with ok/warn/fail and, when something
 * is off, the exact command that fixes it. Read-only by design: no check
 * builds the index, touches the graph, or loads an embedding model.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

import {
  DEFAULT_EMBEDDING_MODEL,
  GraphIndex,
  HashEmbeddingProvider,
  SCHEMA_VERSION,
  configPath,
  gitStatusClean,
  indexStaleness,
  isGitRepo,
  transformersAvailable,
} from '@untacit/core';
import type { EmbeddingsConfig } from '@untacit/core';
import pc from 'picocolors';

import { checkRemote, installRoot } from './update.js';

export type DoctorStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  /** Exact command (or action) that resolves a warn/fail. */
  fix?: string;
}

export interface DoctorOptions {
  /** Graph repo to inspect; without it only the environment checks run. */
  graph?: string;
  /** Skip every network access (the install-update check). */
  offline: boolean;
}

/** Injectable seams so tests can simulate each failure mode. */
export interface DoctorDeps {
  gitVersion: () => string;
  claudeAvailable: () => { ok: boolean; detail: string };
  installRoot: () => string | null;
  checkRemote: typeof checkRemote;
  transformersAvailable: () => Promise<boolean>;
}

function defaultDeps(): DoctorDeps {
  return {
    gitVersion: () =>
      execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim(),
    claudeAvailable: () => {
      throw new Error('claudeAvailable dep is bound in runDoctor'); // replaced there (dynamic import)
    },
    installRoot: () => installRoot(),
    checkRemote,
    transformersAvailable,
  };
}

function checkGit(deps: DoctorDeps): DoctorCheck {
  try {
    return { name: 'git', status: 'ok', detail: deps.gitVersion() };
  } catch {
    return {
      name: 'git',
      status: 'fail',
      detail: 'git not found on PATH — graph repos, imports and diff need it',
      fix: 'install git (https://git-scm.com) and re-run',
    };
  }
}

function checkClaudeEngine(deps: DoctorDeps): DoctorCheck {
  const engine = deps.claudeAvailable();
  if (engine.ok) return { name: 'claude engine', status: 'ok', detail: engine.detail };
  // warn, not fail: only extraction/interview need the engine; querying an
  // existing graph works without it.
  return {
    name: 'claude engine',
    status: 'warn',
    detail: engine.detail,
    fix: 'install Claude Code (https://claude.com/claude-code) or set UNTACIT_CLAUDE_BIN',
  };
}

function checkInstall(deps: DoctorDeps, offline: boolean): DoctorCheck {
  const root = deps.installRoot();
  if (root === null) {
    return {
      name: 'install',
      status: 'warn',
      detail: 'running from a dev checkout — `untacit update` does not apply here',
    };
  }
  if (offline) {
    return { name: 'install', status: 'ok', detail: `install checkout at ${root} (offline — remote not checked)` };
  }
  try {
    const remote = deps.checkRemote(root, 'main');
    if (remote.upToDate) {
      return { name: 'install', status: 'ok', detail: `up to date — untacit ${remote.currentVersion}` };
    }
    return {
      name: 'install',
      status: 'warn',
      detail: `update available: ${remote.currentVersion} → ${remote.remoteVersion}`,
      fix: 'untacit update',
    };
  } catch (err) {
    // A network hiccup must not fail the doctor: degrade to warn.
    return {
      name: 'install',
      status: 'warn',
      detail: `could not check for updates (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`,
    };
  }
}

function checkConfig(repo: string): DoctorCheck {
  const file = configPath(repo);
  if (!existsSync(file)) {
    return {
      name: 'config',
      status: 'fail',
      detail: `no untacit.config.json at ${repo} — is this a graph repo?`,
      fix: `untacit init ${repo} (empty dir), or point --graph at the graph repo`,
    };
  }
  let parsed: { schema_version?: unknown };
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as { schema_version?: unknown };
  } catch (err) {
    return {
      name: 'config',
      status: 'fail',
      detail: `untacit.config.json is not valid JSON (${err instanceof Error ? err.message : String(err)})`,
      fix: `fix the JSON at ${file}`,
    };
  }
  if (parsed.schema_version !== undefined && parsed.schema_version !== SCHEMA_VERSION) {
    return {
      name: 'config',
      status: 'warn',
      detail: `schema_version ${String(parsed.schema_version)} ≠ supported ${SCHEMA_VERSION}`,
      fix: 'update untacit (`untacit update`) or migrate the graph repo',
    };
  }
  return { name: 'config', status: 'ok', detail: 'untacit.config.json is valid' };
}

function checkGraphGit(repo: string): DoctorCheck {
  if (!isGitRepo(repo)) {
    return {
      name: 'graph git',
      status: 'warn',
      detail: 'the graph repo is not under git — runs will not be committed or diffable',
      fix: `git -C ${repo} init && git -C ${repo} add -A && git -C ${repo} commit -m init`,
    };
  }
  if (!gitStatusClean(repo)) {
    return {
      name: 'graph git',
      status: 'warn',
      detail: 'the graph repo working tree has uncommitted changes',
      fix: `git -C ${repo} status`,
    };
  }
  return { name: 'graph git', status: 'ok', detail: 'git repo with a clean working tree' };
}

function checkIndex(repo: string): DoctorCheck {
  const s = indexStaleness(repo);
  if (!s.exists) {
    return {
      name: 'index',
      status: 'warn',
      detail: `no derived index yet (${s.total} node files pending)`,
      fix: `untacit index --graph ${repo}`,
    };
  }
  if (s.stale + s.removed > 0) {
    return {
      name: 'index',
      status: 'warn',
      detail: `index out of date: ${s.stale} stale, ${s.removed} removed of ${s.total} node files`,
      fix: `untacit index --graph ${repo}`,
    };
  }
  return { name: 'index', status: 'ok', detail: `fresh (${s.total} node files)` };
}

async function checkEmbeddings(repo: string, deps: DoctorDeps): Promise<DoctorCheck> {
  let embeddings: EmbeddingsConfig | undefined;
  try {
    const raw = JSON.parse(readFileSync(configPath(repo), 'utf8')) as {
      embeddings?: EmbeddingsConfig;
    };
    embeddings = raw.embeddings;
  } catch {
    return { name: 'embeddings', status: 'warn', detail: 'unreadable config — see the config check' };
  }
  const kind = embeddings?.provider ?? 'auto';
  if (kind === 'none') {
    return { name: 'embeddings', status: 'ok', detail: 'disabled (provider "none")' };
  }

  // Expected cache key without instantiating a provider (a transformers
  // instance would download/load the model — far too heavy for a doctor).
  let providerName: string;
  if (kind === 'hash') {
    providerName = new HashEmbeddingProvider().name;
  } else {
    if (!(await deps.transformersAvailable())) {
      return kind === 'auto'
        ? {
            name: 'embeddings',
            status: 'ok',
            detail: 'provider "auto" without a local model — semantic channel off (documented fallback)',
          }
        : {
            name: 'embeddings',
            status: 'warn',
            detail: 'provider "transformers" but @huggingface/transformers is not installed',
            fix: 'pnpm add @huggingface/transformers (in the install checkout), or set embeddings.provider to "hash"/"none"',
          };
    }
    providerName = `transformers:${embeddings?.model ?? DEFAULT_EMBEDDING_MODEL}`;
  }

  if (!indexStaleness(repo).exists) {
    return {
      name: 'embeddings',
      status: 'warn',
      detail: 'no derived index yet — embedding coverage unknown',
      fix: `untacit index --graph ${repo} --embeddings`,
    };
  }
  try {
    const index = GraphIndex.openReadonly(repo);
    try {
      const cov = index.embeddingCoverage(providerName);
      if (cov.nodes === 0 || cov.embedded >= cov.nodes) {
        return { name: 'embeddings', status: 'ok', detail: `${cov.embedded}/${cov.nodes} nodes cached (${providerName})` };
      }
      return {
        name: 'embeddings',
        status: 'warn',
        detail: `${cov.embedded}/${cov.nodes} nodes cached (${providerName})`,
        fix: `untacit embed --graph ${repo}`,
      };
    } finally {
      index.close();
    }
  } catch (err) {
    return {
      name: 'embeddings',
      status: 'warn',
      detail: `could not read the index (${err instanceof Error ? err.message.split('\n')[0] : String(err)})`,
      fix: `untacit index --graph ${repo}`,
    };
  }
}

/** Run every applicable check. Pure over `deps` — the CLI wiring lives in index.ts. */
export async function doctorChecks(
  opts: DoctorOptions,
  deps: DoctorDeps = defaultDeps(),
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [
    checkGit(deps),
    checkClaudeEngine(deps),
    checkInstall(deps, opts.offline),
  ];
  if (opts.graph !== undefined) {
    checks.push(checkConfig(opts.graph), checkGraphGit(opts.graph), checkIndex(opts.graph));
    checks.push(await checkEmbeddings(opts.graph, deps));
  }
  return checks;
}

const GLYPHS: Record<DoctorStatus, { unicode: string; ascii: string; paint: (s: string) => string }> = {
  ok: { unicode: '✓', ascii: '+', paint: pc.green },
  warn: { unicode: '!', ascii: '!', paint: pc.yellow },
  fail: { unicode: '✗', ascii: 'x', paint: pc.red },
};

/** Human rendering: one line per check, fix hints dimmed, summary last. */
export function formatDoctorText(checks: DoctorCheck[], unicode: boolean): string {
  const lines: string[] = [];
  const width = Math.max(...checks.map((c) => c.name.length));
  for (const check of checks) {
    const glyph = GLYPHS[check.status];
    lines.push(`${glyph.paint(unicode ? glyph.unicode : glyph.ascii)} ${check.name.padEnd(width)}  ${check.detail}`);
    if (check.fix !== undefined) lines.push(pc.dim(`  ${' '.repeat(width)}  fix: ${check.fix}`));
  }
  const fails = checks.filter((c) => c.status === 'fail').length;
  const warns = checks.filter((c) => c.status === 'warn').length;
  lines.push('');
  lines.push(
    fails > 0
      ? pc.red(`${fails} failing, ${warns} warning(s)`)
      : warns > 0
        ? pc.yellow(`no failures, ${warns} warning(s)`)
        : pc.green('everything looks good'),
  );
  return lines.join('\n');
}

/** Bind the heavy claude probe lazily; everything else uses default deps. */
export async function defaultDoctorDeps(): Promise<DoctorDeps> {
  const { claudeCodeAvailable } = await import('@untacit/extractors');
  return { ...defaultDeps(), claudeAvailable: () => claudeCodeAvailable() };
}
