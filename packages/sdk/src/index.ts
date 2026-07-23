/**
 * @untacit/sdk — the stable programmatic surface over a graph repo.
 *
 * A thin wrapper over @untacit/core plus the pure query layer of @untacit/mcp
 * (queries.ts, re-exported from the mcp package root): the same functions the
 * MCP tools call, without any transport. This package is the semver contract
 * for automations; the internals it wraps may change shape between minors.
 */

import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import {
  GraphIndex,
  configPath,
  contextQuery,
  createEmbeddingProvider,
  diffRefs,
  diffWorkingTree,
  gitRevParse,
  graphDir,
  importBatch as coreImportBatch,
  isGitRepo,
  loadConfig,
} from '@untacit/core';
import type {
  Conflict,
  ContextOptions,
  ContextResult,
  EdgeRow,
  EdgeType,
  EmbeddingProvider,
  GraphDiff,
  GraphStats,
  ImportOptions,
  ImportResult,
  NodeType,
  SearchResult,
  UntacitConfig,
} from '@untacit/core';
import {
  conflictsQuery,
  evidenceQuery,
  exploreQuery,
  pathsQuery,
  similarQuery,
} from '@untacit/mcp';
import type { EvidenceResult, ExploreResult, PathsResult, SimilarResult } from '@untacit/mcp';
import type {
  DocsExtractionResult,
  DocumentSection,
  ExtractionRunResult,
} from '@untacit/extractors';

// ---------------------------------------------------------------------------
// Result shapes owned by the SDK surface
// ---------------------------------------------------------------------------

/** Transitive business blast radius: impacted nodes with hop distance. */
export interface ImpactResult {
  nodes: (SearchResult & { distance: number })[];
  edges: EdgeRow[];
}

// ---------------------------------------------------------------------------
// Untacit — one open graph repo
// ---------------------------------------------------------------------------

export class Untacit {
  /** Absolute path of the graph repo. */
  readonly dir: string;
  /** untacit.config.json as loaded at open time (defaults filled in). */
  readonly config: UntacitConfig;

  private index: GraphIndex;
  // Embedding provider resolved once from the repo config ('auto' without a
  // local model → null → lexical-only retrieval), like the MCP server does.
  private providerPromise: Promise<EmbeddingProvider | null> | undefined;

  private constructor(dir: string, index: GraphIndex, config: UntacitConfig) {
    this.dir = dir;
    this.index = index;
    this.config = config;
  }

  /**
   * Open a graph repo: resolves the path, opens (and incrementally refreshes)
   * the derived SQLite index, and loads untacit.config.json. Throws when the
   * directory is not a graph repo — opening blindly would silently create a
   * .untacit/ index inside an arbitrary folder.
   */
  static open(graphDirPath: string): Untacit {
    const dir = resolve(graphDirPath);
    if (!existsSync(configPath(dir)) && !existsSync(graphDir(dir))) {
      throw new Error(`Not a graph repo (no untacit.config.json or graph/ in ${dir}) — run "untacit init" first`);
    }
    return new Untacit(dir, GraphIndex.open(dir), loadConfig(dir));
  }

  private embeddings(): Promise<EmbeddingProvider | null> {
    this.providerPromise ??= createEmbeddingProvider(this.config.embeddings).catch(() => null);
    return this.providerPromise;
  }

  /**
   * Retrieve the subgraph relevant to a business question (untacit_context):
   * multi-channel hybrid seeding + graph expansion. Channel switches come
   * from the repo config; pass `opts.embeddings` (or null) to override the
   * config-resolved embedding provider for this call.
   */
  async context(query: string, opts: ContextOptions = {}): Promise<ContextResult> {
    return contextQuery(this.index, query, {
      retrieval: this.config.retrieval,
      ...opts,
      embeddings: opts.embeddings !== undefined ? opts.embeddings : await this.embeddings(),
    });
  }

  /**
   * Full detail of one node plus its typed neighborhood (untacit_explore).
   * Undefined when the node id is unknown.
   */
  explore(
    nodeId: string,
    opts: { depth?: number; edgeTypes?: EdgeType[] } = {},
  ): ExploreResult | undefined {
    return exploreQuery(this.index, nodeId, opts);
  }

  /**
   * Transitive impact closure over DEPENDS_ON / GOVERNS / TRIGGERS
   * (untacit_impact). "downstream" (default) answers "what breaks if this
   * changes"; "upstream" answers "what this depends on / why it exists".
   * Undefined when the node id is unknown.
   */
  impact(
    nodeId: string,
    opts: { direction?: 'downstream' | 'upstream' | 'both'; maxDepth?: number } = {},
  ): ImpactResult | undefined {
    if (this.index.getNode(nodeId) === undefined) return undefined;
    return this.index.impact(nodeId, opts);
  }

  /**
   * The k strongest evidence chains between two nodes (untacit_paths),
   * ranked by multiplicative strength (confidence × edge-type weight per
   * hop). Undefined when either endpoint is unknown.
   */
  paths(
    fromId: string,
    toId: string,
    opts: { maxPaths?: number; maxLength?: number } = {},
  ): PathsResult | undefined {
    return pathsQuery(this.index, fromId, toId, opts);
  }

  /**
   * Nodes most similar to a given node (untacit_similar), blending semantic,
   * structural and lexical signals — the duplicate/merge-candidate lens.
   * Undefined when the node id is unknown.
   */
  async similar(
    nodeId: string,
    opts: { limit?: number; nodeTypes?: NodeType[]; embeddings?: EmbeddingProvider | null } = {},
  ): Promise<SimilarResult | undefined> {
    return similarQuery(this.index, nodeId, {
      ...opts,
      embeddings: opts.embeddings !== undefined ? opts.embeddings : await this.embeddings(),
    });
  }

  /**
   * Complete provenance trail of a node or an edge (untacit_evidence).
   * `ownerId` is a node id or an edge id as returned by other queries.
   */
  evidence(ownerId: string): EvidenceResult {
    return evidenceQuery(this.index, ownerId);
  }

  /** Open contradictions: conflicted edges with opposing evidence (untacit_conflicts). */
  conflicts(): Conflict[] {
    return conflictsQuery(this.index);
  }

  /**
   * Ontology-level drift (untacit_diff): with both refs, diffRefs(refA, refB);
   * with one or none, the working tree against `refA` (default HEAD) — so a
   * bare `diff()` answers "what changed since the last commit".
   */
  diff(refA?: string, refB?: string): GraphDiff {
    if (refA !== undefined && refB !== undefined) return diffRefs(this.dir, refA, refB);
    return diffWorkingTree(this.dir, refA ?? 'HEAD');
  }

  /** Aggregate graph metrics: node/edge counts, statuses, open conflicts. */
  stats(): GraphStats {
    return this.index.stats();
  }

  /** BM25F full-text search over name, aliases and description. */
  search(
    query: string,
    opts: { types?: NodeType[]; limit?: number; offset?: number } = {},
  ): SearchResult[] {
    return this.index.search(query, opts);
  }

  /**
   * Import an extraction batch (validate → resolve → canonical files →
   * commit → reindex). Re-importing an identical batch is a no-op
   * (`result.noop === true`). Core's importBatch rebuilds the derived index
   * itself, so this instance's handle is closed for the duration and
   * reopened afterwards — the instance stays usable either way.
   */
  async importBatch(batch: unknown, opts: ImportOptions = {}): Promise<ImportResult> {
    this.index.close();
    try {
      return await coreImportBatch(this.dir, batch, opts);
    } finally {
      this.index = GraphIndex.open(this.dir);
    }
  }

  /** Release the index handle. The instance must not be used afterwards. */
  close(): void {
    this.index.close();
  }
}

/**
 * Open a graph repo, run `fn`, and always close the handle — even when `fn`
 * throws. Returns whatever `fn` returns.
 */
export async function withGraph<T>(
  dir: string,
  fn: (u: Untacit) => Promise<T> | T,
): Promise<T> {
  const u = Untacit.open(dir);
  try {
    return await fn(u);
  } finally {
    u.close();
  }
}

// ---------------------------------------------------------------------------
// Extraction — Claude Code CLI required; @untacit/extractors loads lazily so
// read-only SDK usage never pays for it
// ---------------------------------------------------------------------------

export interface ExtractCodeOptions {
  /** Human name for the repo in code locators; default: directory base name. */
  repoName?: string;
  /** Repo-relative files/dirs to scan instead of the whole repo. */
  paths?: string[];
  /** Candidate cap for the heuristic scan (default 200). */
  maxCandidates?: number;
  /** Candidates per LLM call (default 8). */
  chunkSize?: number;
  /** Model override for the Claude Code session. */
  model?: string;
  /** Clock injection for deterministic run ids. */
  now?: Date;
}

/**
 * Extract business logic from a source repo: heuristic candidate scan, then
 * the code extraction agent over the Claude Code CLI. Returns the validated
 * batch (plus per-chunk rejections) — persist it with `Untacit.importBatch`.
 * Throws when the `claude` CLI is not available.
 */
export async function extractCode(
  repoDir: string,
  opts: ExtractCodeOptions = {},
): Promise<ExtractionRunResult> {
  const { ClaudeCodeLlmClient, claudeCodeAvailable, extractFromCandidates, scanRepo } =
    await import('@untacit/extractors');
  const engine = claudeCodeAvailable();
  if (!engine.ok) {
    throw new Error(`code extraction runs on the Claude Code CLI and it is not available: ${engine.detail}`);
  }
  const root = resolve(repoDir);
  const candidates = scanRepo(root, {
    repoName: opts.repoName ?? basename(root),
    maxCandidates: opts.maxCandidates,
    paths: opts.paths,
  });
  const llm = new ClaudeCodeLlmClient(opts.model !== undefined ? { model: opts.model } : {});
  const commit = isGitRepo(root) ? gitRevParse(root, 'HEAD').slice(0, 12) : undefined;
  return extractFromCandidates(llm, candidates, {
    chunkSize: opts.chunkSize,
    commit,
    now: opts.now,
  });
}

export interface ExtractDocsOptions {
  /** Sections per LLM call (default 4). */
  sectionsPerCall?: number;
  /** Model override for the Claude Code session. */
  model?: string;
  /** Clock injection for deterministic run ids. */
  now?: Date;
}

/**
 * Extract business logic from documents (.md/.markdown/.txt/.pdf/.docx):
 * each file is segmented into sections, then the docs extraction agent runs
 * over the Claude Code CLI. Returns the validated batch — persist it with
 * `Untacit.importBatch`. Throws when the `claude` CLI is not available.
 */
export async function extractDocs(
  files: string[],
  opts: ExtractDocsOptions = {},
): Promise<DocsExtractionResult> {
  const { ClaudeCodeLlmClient, claudeCodeAvailable, extractFromSections, loadDocumentSections, slugifyDocId } =
    await import('@untacit/extractors');
  const engine = claudeCodeAvailable();
  if (!engine.ok) {
    throw new Error(`docs extraction runs on the Claude Code CLI and it is not available: ${engine.detail}`);
  }
  const sections: DocumentSection[] = [];
  // One doc_id per file, deduplicated: two "manual.md" in different folders
  // must not share provenance.
  const usedDocIds = new Set<string>();
  for (const file of files) {
    const base = slugifyDocId(file);
    let docId = base;
    for (let n = 2; usedDocIds.has(docId); n++) docId = `${base}-${n}`;
    usedDocIds.add(docId);
    sections.push(...(await loadDocumentSections(resolve(file), { docId })));
  }
  const llm = new ClaudeCodeLlmClient(opts.model !== undefined ? { model: opts.model } : {});
  return extractFromSections(llm, sections, {
    sectionsPerCall: opts.sectionsPerCall,
    now: opts.now,
  });
}

// ---------------------------------------------------------------------------
// Stable type re-exports — the shapes SDK methods return or accept
// ---------------------------------------------------------------------------

export type {
  Conflict,
  ContextNode,
  ContextOptions,
  ContextResult,
  EdgeRow,
  EdgeType,
  EmbeddingProvider,
  Evidence,
  ExtractionBatch,
  GraphDiff,
  GraphNode,
  GraphStats,
  ImportOptions,
  ImportResult,
  NodeType,
  RetrievalPlan,
  SearchResult,
  UntacitConfig,
} from '@untacit/core';
export type {
  EvidenceResult,
  ExploreResult,
  PathsResult,
  SimilarNode,
  SimilarResult,
} from '@untacit/mcp';
export type {
  Candidate,
  DocsExtractionResult,
  DocumentSection,
  ExtractionRunResult,
} from '@untacit/extractors';
