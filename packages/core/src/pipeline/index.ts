/**
 * Import pipeline (docs/03 §4): batch JSON → validate → resolve mentions →
 * apply to store → canonical files → run metadata → commit → reindex.
 *
 * Idempotence guarantee: importing the exact same batch twice leaves the
 * graph repo with `git status` clean — evidence dedups by identity key, file
 * writes skip identical bytes, and a no-op import records nothing.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  DEFAULT_RESOLVER_THRESHOLDS,
  DEFAULT_REVIEW_THRESHOLD,
  SCHEMA_VERSION,
} from '../constants.js';
import { createEmbeddingProvider } from '../embeddings/index.js';
import {
  gitBranchExists,
  gitCheckout,
  gitCommitAll,
  gitCreateBranch,
  gitCurrentBranch,
  gitInit,
  isGitRepo,
} from '../git.js';
import { GraphStore, writeRunMeta } from '../graph/index.js';
import { GraphIndex, buildIndex } from '../indexer/index.js';
import { configPath, graphDir, runsDir } from '../paths.js';
import {
  loadMergesFile,
  resolveBatch,
  saveMergesFile,
  type EmbeddingProvider,
} from '../resolver/index.js';
import type {
  UntacitConfig,
  ExtractorInfo,
  MergeProposal,
  RunStats,
  ValidationIssue,
} from '../types.js';
import { validateBatch } from '../validator/index.js';

export interface ImportOptions {
  /** Commit the run to the graph repo (default true when the repo is a git repo). */
  commit?: boolean;
  /**
   * Extraction-as-PR (docs/03 §5): commit the run on this NEW branch instead
   * of the current one, then return the working tree to the previous branch.
   * The graph change stays proposed — ready to push and review as a pull
   * request — while the local graph keeps its pre-run state.
   */
  branch?: string;
  /** Rebuild the derived index after import (default true). */
  reindex?: boolean;
  extractor?: ExtractorInfo;
  /** Clock injection for deterministic tests. */
  now?: Date;
  thresholds?: { auto: number; gray: number };
  /**
   * Embedding provider for the resolver's fuzzy match. `undefined` resolves
   * it from untacit.config.json (`embeddings`, default 'auto'); `null`
   * disables the semantic channel for this import.
   */
  embeddings?: EmbeddingProvider | null;
}

export interface ImportResult {
  runId: string;
  stats: RunStats;
  rejections: ValidationIssue[];
  proposals: MergeProposal[];
  /** Commit hash of the run, or null when no commit was made. */
  commit: string | null;
  /** Branch the run was committed on (opts.branch), or null for the current branch. */
  branch: string | null;
  writtenFiles: string[];
  /** True when the import changed nothing (identical re-import). */
  noop: boolean;
}

export async function importBatch(
  repoRoot: string,
  batchJson: unknown,
  opts: ImportOptions = {},
): Promise<ImportResult> {
  const now = opts.now ?? new Date();

  const validation = validateBatch(batchJson);
  if (!validation.sanitized) {
    const reasons = validation.issues
      .map((issue) => `${issue.path}: ${issue.message}`)
      .join('; ');
    throw new Error(`Batch rejected by validator: ${reasons || 'malformed batch'}`);
  }
  const batch = validation.sanitized;

  // Validate the extraction-as-PR preconditions before touching any file, so
  // a bad --branch never leaves a half-written working tree behind.
  if (opts.branch !== undefined) {
    if (opts.commit === false) {
      throw new Error('branch option requires committing (do not combine with commit: false)');
    }
    if (!isGitRepo(repoRoot)) {
      throw new Error(`branch option requires the graph repo to be a git repository: ${repoRoot}`);
    }
    if (gitBranchExists(repoRoot, opts.branch)) {
      throw new Error(`branch "${opts.branch}" already exists in the graph repo — pick a new branch per run`);
    }
    if (gitCurrentBranch(repoRoot) === null) {
      throw new Error('branch option requires the graph repo to be on a branch (detached HEAD)');
    }
  }

  // Embedding provider: explicit option wins; undefined falls back to the
  // repo config ('auto' → local model when installed, else hash provider).
  const provider =
    opts.embeddings !== undefined
      ? opts.embeddings
      : await createEmbeddingProvider(loadConfig(repoRoot)?.embeddings);

  // Reuse index-cached vectors for the pre-batch store (incremental by
  // content hash); the resolver embeds only what is missing.
  let nodeVectors: Map<string, number[]> | undefined;
  if (provider !== null) {
    const index = GraphIndex.open(repoRoot);
    try {
      await index.updateEmbeddings(provider);
      nodeVectors = index.nodeVectors(provider.name);
    } finally {
      index.close();
    }
  }

  const store = GraphStore.load(repoRoot);
  const { resolutions, proposals } = await resolveBatch(batch, store, {
    thresholds: opts.thresholds,
    embeddings: provider,
    nodeVectors,
    now,
  });

  const stats = store.applyResolvedBatch(batch, resolutions, { now });
  stats.rejected = validation.issues.length;
  stats.merge_proposals = proposals.length;

  const writtenFiles = store.write();

  if (proposals.length > 0) {
    const merges = loadMergesFile(repoRoot);
    const known = new Set(merges.proposals.map((p) => p.id));
    for (const proposal of proposals) {
      if (!known.has(proposal.id)) merges.proposals.push(proposal);
    }
    saveMergesFile(repoRoot, merges);
  }

  const noop =
    writtenFiles.length === 0 &&
    proposals.length === 0 &&
    stats.nodes_created === 0 &&
    stats.nodes_updated === 0 &&
    stats.edges_created === 0 &&
    stats.edges_updated === 0 &&
    stats.evidence_added === 0;

  let commitHash: string | null = null;
  if (!noop) {
    writeRunMeta(repoRoot, {
      id: batch.run_id,
      source_type: batch.source_type,
      extractor: opts.extractor ?? batch.extractor,
      started_at: now.toISOString(),
      finished_at: now.toISOString(),
      stats,
      rejections: validation.issues,
    });

    const shouldCommit = opts.commit ?? true;
    if (shouldCommit && isGitRepo(repoRoot)) {
      // The run→commit mapping is recoverable from git log: the commit
      // subject carries the run id (writing the hash back into the run file
      // would dirty the tree it just committed).
      if (opts.branch !== undefined) {
        // Extraction-as-PR: the run commit lands on a fresh branch and the
        // working tree returns to the previous branch untouched, so the
        // change is a proposal to push and review, not an applied fact.
        const previous = gitCurrentBranch(repoRoot)!;
        gitCreateBranch(repoRoot, opts.branch);
        try {
          commitHash = gitCommitAll(repoRoot, formatRunCommitMessage(batch.run_id, stats));
        } finally {
          gitCheckout(repoRoot, previous);
        }
      } else {
        commitHash = gitCommitAll(repoRoot, formatRunCommitMessage(batch.run_id, stats));
      }
    }
  }

  if (opts.reindex ?? true) {
    buildIndex(repoRoot);
    // Keep the vector cache fresh for the nodes this run created/changed.
    if (provider !== null) {
      const index = GraphIndex.open(repoRoot);
      try {
        await index.updateEmbeddings(provider);
      } finally {
        index.close();
      }
    }
  }

  return {
    runId: batch.run_id,
    stats,
    rejections: validation.issues,
    proposals,
    commit: commitHash,
    branch: commitHash !== null && opts.branch !== undefined ? opts.branch : null,
    writtenFiles,
    noop,
  };
}

function formatRunCommitMessage(runId: string, stats: RunStats): string {
  const summary = [
    `+${stats.nodes_created}/~${stats.nodes_updated} nodes`,
    `+${stats.edges_created}/~${stats.edges_updated} edges`,
    `+${stats.evidence_added} evidence`,
    `${stats.rejected} rejected`,
    `${stats.merge_proposals} merge proposals`,
  ].join(', ');
  return `run: ${runId}\n\n${summary}`;
}

// ---------------------------------------------------------------------------
// Graph repo initialization (untacit init)
// ---------------------------------------------------------------------------

export interface InitOptions {
  language?: string;
  /** Initialize git and make the first commit (default true). */
  git?: boolean;
}

export function defaultConfig(language = 'es'): UntacitConfig {
  return {
    language,
    schema_version: SCHEMA_VERSION,
    sources: { code: [], documents: [] },
    thresholds: {
      review: DEFAULT_REVIEW_THRESHOLD,
      resolver_auto: DEFAULT_RESOLVER_THRESHOLDS.auto,
      resolver_gray: DEFAULT_RESOLVER_THRESHOLDS.gray,
    },
    embeddings: { provider: 'auto' },
  };
}

/**
 * Reads untacit.config.json from the graph repo. Missing file → defaultConfig
 * (a fresh repo is valid without one); missing sections are filled in so
 * callers can rely on the full UntacitConfig shape.
 */
export function loadConfig(repoRoot: string): UntacitConfig {
  const file = configPath(repoRoot);
  if (!existsSync(file)) return defaultConfig();
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<UntacitConfig>;
  const base = defaultConfig(raw.language);
  return {
    ...base,
    ...raw,
    sources: {
      code: raw.sources?.code ?? [],
      documents: raw.sources?.documents ?? [],
    },
    thresholds: { ...base.thresholds, ...raw.thresholds },
  };
}

/**
 * Write untacit.config.json (2-space indent, trailing newline). The settings
 * surface of the desktop app persists embeddings/retrieval choices through
 * here; saving the result of loadConfig back is stable.
 */
export function saveConfig(repoRoot: string, config: UntacitConfig): void {
  writeFileSync(configPath(repoRoot), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/** Creates the graph-repo skeleton of docs/03 §3. Idempotent: existing files are kept. */
export function initGraphRepo(dir: string, opts: InitOptions = {}): void {
  mkdirSync(dir, { recursive: true });
  mkdirSync(graphDir(dir), { recursive: true });
  mkdirSync(runsDir(dir), { recursive: true });

  if (!existsSync(configPath(dir))) {
    writeFileSync(
      configPath(dir),
      `${JSON.stringify(defaultConfig(opts.language), null, 2)}\n`,
      'utf8',
    );
  }

  const gitignore = join(dir, '.gitignore');
  if (!existsSync(gitignore)) {
    writeFileSync(gitignore, '.untacit/\n', 'utf8');
  }

  const keepGraph = join(graphDir(dir), '.gitkeep');
  if (!existsSync(keepGraph)) writeFileSync(keepGraph, '', 'utf8');
  const keepRuns = join(runsDir(dir), '.gitkeep');
  if (!existsSync(keepRuns)) writeFileSync(keepRuns, '', 'utf8');

  if (opts.git ?? true) {
    // A graph must be its OWN git repo (the self-hosted server serves graphs
    // from git clones and rejects a dir without .git). Check for dir's own
    // .git, NOT isGitRepo(dir) — the latter runs `rev-parse --is-inside-work-tree`
    // and returns true when dir is merely nested inside a PARENT repo (e.g.
    // `untacit init ./graph` from within any project), which would skip the
    // init and leave the graph without its own repo.
    if (!existsSync(join(dir, '.git'))) {
      gitInit(dir);
      gitCommitAll(dir, 'untacit: initialize graph repo');
    }
  }
}
