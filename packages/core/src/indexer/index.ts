/**
 * Derived SQLite index (FTS5) over the graph repo (docs/03 §3, §6).
 *
 * The canonical truth is graph/**\/*.md; .untacit/index.db is a disposable,
 * regenerable read model. Every read path (full-text search, typed
 * neighborhoods, business impact traversal, conflicts, review queue, stats)
 * goes against this index; every write goes to files first — the index only
 * ever ingests files.
 *
 * Reindexing is incremental by content hash (sha1) per node file: post-pull,
 * post-checkout or manual-edit refreshes only touch changed files. Dangling
 * edge targets (target node file missing) are indexed anyway and never crash
 * a query — they simply produce no node row.
 *
 * Module map: schema.ts (DDL + versioning), rows.ts (row shapes + pure
 * helpers), fts.ts (FTS5 escaping/tokenization), build.ts (open/sync/build),
 * embeddings-store.ts (vector cache + semantic search). This file holds the
 * GraphIndex query surface and re-exports the public API.
 */

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_REVIEW_THRESHOLD } from '../constants.js';
import { conflictEvidenceKey } from '../graph/index.js';
import { nodeRef } from '../ids.js';
import { indexDbPath } from '../paths.js';
import type { EmbeddingProvider } from '../resolver/index.js';
import type {
  Conflict,
  EdgeType,
  ElementStatus,
  Evidence,
  GraphEdge,
  GraphNode,
  GraphStats,
  NodeRef,
  NodeType,
  SearchResult,
} from '../types.js';
import { openIndexDb, syncIndex } from './build.js';
import {
  embeddingCoverage,
  lateInteractionSearch,
  nodeVectors,
  semanticSearch,
  updateEmbeddings,
  updateFacetEmbeddings,
} from './embeddings-store.js';
import type { EmbeddingUpdateResult } from './embeddings-store.js';
import { ftsTokens, toFtsQuery } from './fts.js';
import { compareEdgeRows, firstLine, rowToEvidence, toEdgeRow } from './rows.js';
import type { EdgeRow, EdgeRowDb, EvidenceRowDb, NodeRowDb } from './rows.js';
import { readNodeFile } from '../serializer/index.js';

export { INDEX_SCHEMA_VERSION } from './schema.js';
export type { EdgeRow } from './rows.js';
export type { BuildIndexOptions } from './build.js';
export { buildIndex, checkpointIndex, indexStaleness } from './build.js';
export type { EmbeddingUpdateResult } from './embeddings-store.js';

/**
 * Refresh the derived index and its node embeddings in one shot: incremental
 * reindex by file hash, then incremental re-embedding by content hash — both
 * the mean-pooled node vectors and the late-interaction facet vectors.
 */
export async function buildEmbeddings(
  repoRoot: string,
  provider: EmbeddingProvider,
): Promise<EmbeddingUpdateResult> {
  const index = GraphIndex.open(repoRoot);
  try {
    const result = await index.updateEmbeddings(provider);
    const facets = await index.updateFacetEmbeddings(provider);
    return { ...result, computed: result.computed + facets.computed };
  } finally {
    index.close();
  }
}

// ---------------------------------------------------------------------------
// GraphIndex — the query surface
// ---------------------------------------------------------------------------

export class GraphIndex {
  private readonly db: Database.Database;
  private readonly repoRoot: string;

  private constructor(db: Database.Database, repoRoot: string) {
    this.db = db;
    this.repoRoot = repoRoot;
  }

  /** Open the index for a graph repo, building it if missing, then refresh. */
  static open(repoRoot: string): GraphIndex {
    const index = new GraphIndex(openIndexDb(repoRoot), repoRoot);
    index.reindexIfStale();
    return index;
  }

  /**
   * Open a pre-built index strictly read-only (docs/06 §4.6): no reindex, no
   * WAL, no writes of any kind — for serverless bundles where the filesystem
   * is immutable. Build the index beforehand and flatten it with
   * `checkpointIndex` so no -wal/-shm sidecar files are needed.
   */
  static openReadonly(repoRoot: string): GraphIndex {
    const dbPath = indexDbPath(repoRoot);
    if (!existsSync(dbPath)) {
      throw new Error(
        `No derived index at ${dbPath} — build it first (untacit index --full) and ` +
          'checkpoint it (checkpointIndex) before bundling',
      );
    }
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });
    return new GraphIndex(db, repoRoot);
  }

  /** Incremental reindex by content hash — cheap when nothing changed. */
  reindexIfStale(): void {
    syncIndex(this.db, this.repoRoot);
  }

  /**
   * FTS5 search over name + aliases + description, BM25F ranked: fielded
   * bm25 weights (name 8 > aliases 4 > description 1) so a hit on what a
   * node is *called* outranks the same term buried in prose. Column 0
   * (node_id, UNINDEXED) gets weight 0.
   */
  search(
    query: string,
    opts?: { types?: NodeType[]; limit?: number; offset?: number },
  ): SearchResult[] {
    const match = toFtsQuery(query);
    if (match === undefined) return [];
    return this.searchWithMatch(match, opts);
  }

  /** Shared FTS runner for `search` (plain query) and `prfSearch` (expanded). */
  private searchWithMatch(
    match: string,
    opts?: { types?: NodeType[]; limit?: number; offset?: number },
  ): SearchResult[] {
    const limit = opts?.limit ?? 20;
    const offset = opts?.offset ?? 0;
    const types = opts?.types !== undefined && opts.types.length > 0 ? opts.types : undefined;

    let sql = `
      SELECT n.id AS id, n.type AS type, n.name AS name, n.description AS description,
             bm25(search, 0.0, 8.0, 4.0, 1.0) AS rank
      FROM search
      JOIN nodes n ON n.id = search.node_id
      WHERE search MATCH ?`;
    const params: unknown[] = [match];
    if (types !== undefined) {
      sql += ` AND n.type IN (${types.map(() => '?').join(', ')})`;
      params.push(...types);
    }
    sql += ' ORDER BY rank ASC, n.id ASC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    let rows: { id: string; type: string; name: string; description: string; rank: number }[];
    try {
      rows = this.db.prepare(sql).all(...params) as typeof rows;
    } catch {
      return []; // defensive: a query the tokenizer reduces to nothing
    }
    return rows.map((r) => ({
      id: r.id,
      type: r.type as NodeType,
      name: r.name,
      summary: firstLine(r.description),
      // bm25() returns negative values, more negative = better; flip the sign
      // so callers get a positive, higher-is-better score.
      score: -r.rank,
    }));
  }

  /**
   * Pseudo-relevance-feedback search (RM3-lite, docs/03 §6.1): run the plain
   * BM25F query, mine the top feedback documents for expansion terms scored
   * by tf-in-feedback × idf (doc frequencies from the fts5vocab shadow of
   * the search table), then re-run the query expanded with the best terms
   * (`(original) OR t1 OR t2 …`). Bridges vocabulary gaps the embedding
   * channel misses at the price of a second FTS pass — e.g. "prepago" pulls
   * in nodes that only ever say "pago anticipado" because both co-occur in
   * the feedback set. Returns [] when there is nothing to expand with
   * (no feedback hits, or no informative terms), so the fusion layer can
   * skip the channel cleanly.
   */
  prfSearch(
    query: string,
    opts?: { types?: NodeType[]; limit?: number; feedbackDocs?: number; expansionTerms?: number },
  ): SearchResult[] {
    const match = toFtsQuery(query);
    if (match === undefined) return [];
    const feedbackDocs = opts?.feedbackDocs ?? 8;
    const expansionTerms = opts?.expansionTerms ?? 5;

    const feedback = this.searchWithMatch(match, { types: opts?.types, limit: feedbackDocs });
    if (feedback.length === 0) return [];

    // Term frequencies over the feedback docs' full indexed text.
    const queryTerms = new Set(ftsTokens(query));
    const tf = new Map<string, number>();
    const docText = this.db.prepare(
      `SELECT n.name AS name, n.description AS description,
              (SELECT GROUP_CONCAT(alias, ' ') FROM node_aliases a WHERE a.node_id = n.id) AS aliases
       FROM nodes n WHERE n.id = ?`,
    );
    for (const hit of feedback) {
      const row = docText.get(hit.id) as
        | { name: string; description: string; aliases: string | null }
        | undefined;
      if (row === undefined) continue;
      for (const term of ftsTokens(`${row.name} ${row.aliases ?? ''} ${row.description}`)) {
        if (term.length < 3 || queryTerms.has(term)) continue;
        tf.set(term, (tf.get(term) ?? 0) + 1);
      }
    }
    if (tf.size === 0) return [];

    // idf from the fts5vocab row-level statistics; terms the tokenizer never
    // produced (or that appear everywhere) score toward zero.
    const totalDocs = (this.db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c;
    const dfStmt = this.db.prepare('SELECT doc AS df FROM search_vocab WHERE term = ?');
    const scored: { term: string; score: number }[] = [];
    for (const [term, freq] of tf) {
      const row = dfStmt.get(term) as { df: number } | undefined;
      if (row === undefined) continue;
      const idf = Math.log(1 + totalDocs / (1 + row.df));
      const score = freq * idf;
      if (score > 0) scored.push({ term, score });
    }
    if (scored.length === 0) return [];
    scored.sort((a, b) => b.score - a.score || a.term.localeCompare(b.term));

    const terms = scored.slice(0, expansionTerms).map((t) => `"${t.term.replaceAll('"', '""')}"`);
    const expanded = `(${match}) OR ${terms.join(' OR ')}`;
    return this.searchWithMatch(expanded, { types: opts?.types, limit: opts?.limit ?? 20 });
  }

  /**
   * Node rows by type (or all), ordered by id — the browse/enumeration query.
   * FTS `search` cannot express "every process" (there is no match-all MATCH
   * expression); gap analysis and pagination go through here instead.
   */
  listNodes(opts?: { types?: NodeType[]; limit?: number; offset?: number }): SearchResult[] {
    const types = opts?.types !== undefined && opts.types.length > 0 ? opts.types : undefined;
    const limit = opts?.limit ?? 1000;
    const offset = opts?.offset ?? 0;
    let sql = 'SELECT id, type, name, description FROM nodes';
    const params: unknown[] = [];
    if (types !== undefined) {
      sql += ` WHERE type IN (${types.map(() => '?').join(', ')})`;
      params.push(...types);
    }
    sql += ' ORDER BY id LIMIT ? OFFSET ?';
    params.push(limit, offset);
    const rows = this.db.prepare(sql).all(...params) as {
      id: string;
      type: string;
      name: string;
      description: string;
    }[];
    return rows.map((r) => ({
      id: r.id,
      type: r.type as NodeType,
      name: r.name,
      summary: firstLine(r.description),
      score: 0,
    }));
  }

  /** Nodes with no edges in either direction — coverage gaps for the interviewer. */
  isolatedNodes(limit = 100): SearchResult[] {
    const rows = this.db
      .prepare(
        `SELECT id, type, name, description FROM nodes n
         WHERE NOT EXISTS (SELECT 1 FROM edges e WHERE e.source_id = n.id OR e.target_id = n.id)
         ORDER BY id LIMIT ?`,
      )
      .all(limit) as { id: string; type: string; name: string; description: string }[];
    return rows.map((r) => ({
      id: r.id,
      type: r.type as NodeType,
      name: r.name,
      summary: firstLine(r.description),
      score: 0,
    }));
  }

  /**
   * One-line summary row by id, straight from the nodes table — the cheap
   * lookup traversal-based retrieval uses to materialize result nodes
   * without touching node files. Undefined for dangling ids.
   */
  nodeSummary(id: string): SearchResult | undefined {
    const row = this.db
      .prepare('SELECT id, type, name, description FROM nodes WHERE id = ?')
      .get(id) as { id: string; type: string; name: string; description: string } | undefined;
    if (row === undefined) return undefined;
    return {
      id: row.id,
      type: row.type as NodeType,
      name: row.name,
      summary: firstLine(row.description),
      score: 0,
    };
  }

  /** Full node by id (the node file is the source of truth when present). */
  getNode(id: string): (GraphNode & { ref: NodeRef }) | undefined {
    const row = this.db.prepare('SELECT * FROM nodes WHERE id = ?').get(id) as
      | NodeRowDb
      | undefined;
    if (row === undefined) return undefined;
    const abs = join(this.repoRoot, ...row.file_path.split('/'));
    const node = existsSync(abs) ? readNodeFile(abs) : this.nodeFromRows(row);
    return { ...node, ref: nodeRef(node.type, node.id) };
  }

  /**
   * Compact snapshot of every edge — the input the in-memory traversal
   * algorithms (core/src/retrieval) consume. One query, ordered for
   * determinism; at v1 scale (~50k edges) this is a few milliseconds.
   */
  allEdges(): EdgeRow[] {
    const rows = this.db
      .prepare('SELECT * FROM edges ORDER BY source_id, type, target_ref')
      .all() as EdgeRowDb[];
    return rows.map(toEdgeRow);
  }

  /** All edges touching a node, with direction relative to it. */
  edgesOf(id: string): { direction: 'out' | 'in'; edge: EdgeRow }[] {
    const out = this.db
      .prepare('SELECT * FROM edges WHERE source_id = ? ORDER BY type, target_ref')
      .all(id) as EdgeRowDb[];
    const inn = this.db
      .prepare(
        'SELECT * FROM edges WHERE target_id = ? AND source_id <> ? ORDER BY type, source_id',
      )
      .all(id, id) as EdgeRowDb[];
    return [
      ...out.map((row) => ({ direction: 'out' as const, edge: toEdgeRow(row) })),
      ...inn.map((row) => ({ direction: 'in' as const, edge: toEdgeRow(row) })),
    ];
  }

  /**
   * Undirected BFS neighborhood up to `depth` (default 1), optionally
   * restricted to `edgeTypes`. The origin is included at distance 0.
   * Dangling targets are traversed but produce no node result.
   */
  neighbors(
    id: string,
    opts?: { depth?: number; edgeTypes?: EdgeType[] },
  ): { nodes: (SearchResult & { distance: number })[]; edges: EdgeRow[] } {
    const depth = opts?.depth ?? 1;
    const filter =
      opts?.edgeTypes !== undefined && opts.edgeTypes.length > 0
        ? new Set<string>(opts.edgeTypes)
        : undefined;
    const adjacent = this.db.prepare('SELECT * FROM edges WHERE source_id = ? OR target_id = ?');

    const dist = new Map<string, number>([[id, 0]]);
    const edges = new Map<string, EdgeRowDb>();
    let frontier = [id];
    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const next: string[] = [];
      for (const cur of frontier) {
        for (const row of adjacent.all(cur, cur) as EdgeRowDb[]) {
          if (filter !== undefined && !filter.has(row.type)) continue;
          edges.set(row.id, row);
          const other = row.source_id === cur ? row.target_id : row.source_id;
          if (!dist.has(other)) {
            dist.set(other, d + 1);
            next.push(other);
          }
        }
      }
      frontier = next;
    }
    return this.materializeTraversal(dist, edges);
  }

  /**
   * Business blast radius (docs/03 §6, untacit_impact): BFS restricted to
   * DEPENDS_ON / GOVERNS / TRIGGERS.
   *
   * "downstream" (default) answers "what is affected if this changes":
   * DEPENDS_ON is followed in REVERSE (the source depends on the target, so
   * sources of edges pointing at X are affected), GOVERNS and TRIGGERS are
   * followed FORWARD. "upstream" is the exact inverse (what X depends on /
   * why it exists). "both" is the union of the two traversals.
   */
  impact(
    id: string,
    opts?: { direction?: 'downstream' | 'upstream' | 'both'; maxDepth?: number },
  ): { nodes: (SearchResult & { distance: number })[]; edges: EdgeRow[] } {
    const direction = opts?.direction ?? 'downstream';
    const maxDepth = opts?.maxDepth ?? 10;

    const dependsBySource = this.db.prepare(
      "SELECT * FROM edges WHERE type = 'DEPENDS_ON' AND source_id = ?",
    );
    const dependsByTarget = this.db.prepare(
      "SELECT * FROM edges WHERE type = 'DEPENDS_ON' AND target_id = ?",
    );
    const flowBySource = this.db.prepare(
      "SELECT * FROM edges WHERE type IN ('GOVERNS', 'TRIGGERS') AND source_id = ?",
    );
    const flowByTarget = this.db.prepare(
      "SELECT * FROM edges WHERE type IN ('GOVERNS', 'TRIGGERS') AND target_id = ?",
    );

    const expand = (cur: string, dir: 'downstream' | 'upstream'): { row: EdgeRowDb; next: string }[] => {
      const steps: { row: EdgeRowDb; next: string }[] = [];
      if (dir === 'downstream') {
        for (const row of dependsByTarget.all(cur) as EdgeRowDb[]) {
          steps.push({ row, next: row.source_id });
        }
        for (const row of flowBySource.all(cur) as EdgeRowDb[]) {
          steps.push({ row, next: row.target_id });
        }
      } else {
        for (const row of dependsBySource.all(cur) as EdgeRowDb[]) {
          steps.push({ row, next: row.target_id });
        }
        for (const row of flowByTarget.all(cur) as EdgeRowDb[]) {
          steps.push({ row, next: row.source_id });
        }
      }
      return steps;
    };

    const traverse = (dir: 'downstream' | 'upstream'): {
      dist: Map<string, number>;
      edges: Map<string, EdgeRowDb>;
    } => {
      const dist = new Map<string, number>([[id, 0]]);
      const edges = new Map<string, EdgeRowDb>();
      let frontier = [id];
      for (let d = 0; d < maxDepth && frontier.length > 0; d++) {
        const next: string[] = [];
        for (const cur of frontier) {
          for (const step of expand(cur, dir)) {
            edges.set(step.row.id, step.row);
            if (!dist.has(step.next)) {
              dist.set(step.next, d + 1);
              next.push(step.next);
            }
          }
        }
        frontier = next;
      }
      return { dist, edges };
    };

    if (direction !== 'both') {
      const { dist, edges } = traverse(direction);
      return this.materializeTraversal(dist, edges);
    }
    const down = traverse('downstream');
    const up = traverse('upstream');
    const dist = new Map(down.dist);
    for (const [nodeId, d] of up.dist) {
      const existing = dist.get(nodeId);
      if (existing === undefined || d < existing) dist.set(nodeId, d);
    }
    const edges = new Map([...down.edges, ...up.edges]);
    return this.materializeTraversal(dist, edges);
  }

  /**
   * Conflicted edges with their evidence split by stance (docs/02 §6). Every
   * evidence carries its stable `key` so the review queue can name a winner.
   */
  conflicts(): Conflict[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM edges WHERE status = 'conflicted' ORDER BY source_id, type, target_ref",
      )
      .all() as EdgeRowDb[];
    return rows.map((row) => {
      const evidence = this.evidenceRows('edge', row.id).map((ev) => ({
        ...ev,
        key: conflictEvidenceKey(ev),
      }));
      return {
        id: `conflict-${row.id.slice(0, 12)}`,
        nodeId: row.source_id,
        edgeId: row.id,
        edgeType: row.type as EdgeType,
        target: row.target_ref,
        supporting: evidence.filter((ev) => ev.stance === 'supports'),
        contradicting: evidence.filter((ev) => ev.stance === 'contradicts'),
      };
    });
  }

  /** Active edges below the review threshold (docs/02 §7 review queue). */
  lowConfidenceEdges(threshold: number = DEFAULT_REVIEW_THRESHOLD): EdgeRow[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM edges WHERE confidence < ? AND status = 'active' ORDER BY confidence ASC, source_id, type, target_ref",
      )
      .all(threshold) as EdgeRowDb[];
    return rows.map(toEdgeRow);
  }

  // -------------------------------------------------------------------------
  // Node embeddings (docs/03 §3) — delegates to embeddings-store.ts
  // -------------------------------------------------------------------------

  /** See {@link updateEmbeddings} in embeddings-store.ts. */
  async updateEmbeddings(provider: EmbeddingProvider): Promise<EmbeddingUpdateResult> {
    return updateEmbeddings(this.db, provider);
  }

  /** See {@link embeddingCoverage} in embeddings-store.ts. */
  embeddingCoverage(providerName: string): { embedded: number; nodes: number } {
    return embeddingCoverage(this.db, providerName);
  }

  /** See {@link nodeVectors} in embeddings-store.ts. */
  nodeVectors(providerName: string): Map<string, number[]> {
    return nodeVectors(this.db, providerName);
  }

  /** See {@link updateFacetEmbeddings} in embeddings-store.ts. */
  async updateFacetEmbeddings(provider: EmbeddingProvider): Promise<EmbeddingUpdateResult> {
    return updateFacetEmbeddings(this.db, provider);
  }

  /** See {@link lateInteractionSearch} in embeddings-store.ts. */
  async lateInteractionSearch(
    query: string,
    provider: EmbeddingProvider,
    opts?: { types?: NodeType[]; limit?: number },
  ): Promise<SearchResult[]> {
    return lateInteractionSearch(this.db, query, provider, opts);
  }

  /** See {@link semanticSearch} in embeddings-store.ts. */
  async semanticSearch(
    query: string,
    provider: EmbeddingProvider,
    opts?: { types?: NodeType[]; limit?: number },
  ): Promise<SearchResult[]> {
    return semanticSearch(this.db, query, provider, opts);
  }

  /**
   * Hybrid retrieval (docs/03 §6.1): weighted reciprocal-rank fusion of up
   * to four channels —
   *
   *   - lexical (BM25F, fielded weights)                weight 1.0
   *   - lexical-prf (RM3 pseudo-relevance expansion)    weight 0.5
   *   - semantic (mean-pooled embedding k-NN)           weight 0.9
   *   - semantic-multivec (late-interaction MaxSim)     weight 1.0
   *
   * Fused score: Σ w_c / (60 + rank_c) over the channels that returned the
   * node — RRF's rank basis keeps incomparable channel scores commensurable,
   * the weights encode channel trust (PRF expansions are recall-oriented and
   * intentionally down-weighted). With no provider — or empty vector
   * tables — the semantic channels drop out and it degrades to
   * lexical + PRF; the fused score is reported in `score`. The facet-vector
   * cache is refreshed incrementally before the multivec channel runs (safe
   * on every read, like updateEmbeddings).
   */
  async hybridSearch(
    query: string,
    provider: EmbeddingProvider | null,
    opts?: { types?: NodeType[]; limit?: number },
  ): Promise<SearchResult[]> {
    const limit = opts?.limit ?? 20;
    // Each channel contributes a pool deeper than the final cut so fusion has
    // something to work with beyond the head of each ranking.
    const pool = Math.max(limit * 3, 30);
    const searchOpts = { types: opts?.types, limit: pool };

    const channels: { weight: number; results: SearchResult[] }[] = [
      { weight: 1.0, results: this.search(query, searchOpts) },
      { weight: 0.5, results: this.prfSearch(query, searchOpts) },
    ];
    if (provider !== null) {
      await this.updateFacetEmbeddings(provider);
      channels.push(
        { weight: 0.9, results: await this.semanticSearch(query, provider, searchOpts) },
        { weight: 1.0, results: await this.lateInteractionSearch(query, provider, searchOpts) },
      );
    }

    const K = 60;
    const fused = new Map<string, SearchResult & { fusedScore: number }>();
    for (const { weight, results } of channels) {
      results.forEach((result, rank) => {
        const entry = fused.get(result.id);
        const contribution = weight / (K + rank + 1);
        if (entry === undefined) {
          fused.set(result.id, { ...result, fusedScore: contribution });
        } else {
          entry.fusedScore += contribution;
        }
      });
    }
    return [...fused.values()]
      .sort((a, b) => b.fusedScore - a.fusedScore || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(({ fusedScore, ...result }) => ({ ...result, score: fusedScore }));
  }

  /** Full provenance of a node or edge (ownerId = node id or edge id). */
  evidenceOf(ownerId: string): { owner: string; kind: 'node' | 'edge'; evidence: Evidence }[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence WHERE owner_id = ? ORDER BY id')
      .all(ownerId) as EvidenceRowDb[];
    return rows.map((row) => ({
      owner: ownerId,
      kind: row.owner_kind as 'node' | 'edge',
      evidence: rowToEvidence(row),
    }));
  }

  stats(): GraphStats {
    const count = (sql: string, ...params: unknown[]): number =>
      (this.db.prepare(sql).get(...params) as { c: number }).c;
    const grouped = (sql: string): Record<string, number> => {
      const out: Record<string, number> = {};
      for (const row of this.db.prepare(sql).all() as { key: string; c: number }[]) {
        out[row.key] = row.c;
      }
      return out;
    };

    const byStatus = grouped('SELECT status AS key, COUNT(*) AS c FROM nodes GROUP BY status');
    for (const row of this.db
      .prepare('SELECT status AS key, COUNT(*) AS c FROM edges GROUP BY status')
      .all() as { key: string; c: number }[]) {
      byStatus[row.key] = (byStatus[row.key] ?? 0) + row.c;
    }

    return {
      nodes_total: count('SELECT COUNT(*) AS c FROM nodes'),
      edges_total: count('SELECT COUNT(*) AS c FROM edges'),
      nodes_by_type: grouped('SELECT type AS key, COUNT(*) AS c FROM nodes GROUP BY type'),
      edges_by_type: grouped('SELECT type AS key, COUNT(*) AS c FROM edges GROUP BY type'),
      by_status: byStatus,
      conflicts_open: count("SELECT COUNT(*) AS c FROM edges WHERE status = 'conflicted'"),
      low_confidence_edges: count(
        "SELECT COUNT(*) AS c FROM edges WHERE confidence < ? AND status = 'active'",
        DEFAULT_REVIEW_THRESHOLD,
      ),
      evidence_total: count('SELECT COUNT(*) AS c FROM evidence'),
    };
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private evidenceRows(kind: 'node' | 'edge', ownerId: string): Evidence[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence WHERE owner_kind = ? AND owner_id = ? ORDER BY id')
      .all(kind, ownerId) as EvidenceRowDb[];
    return rows.map(rowToEvidence);
  }

  /** Turn a BFS result into sorted, dangling-safe node + edge lists. */
  private materializeTraversal(
    dist: Map<string, number>,
    edges: Map<string, EdgeRowDb>,
  ): { nodes: (SearchResult & { distance: number })[]; edges: EdgeRow[] } {
    const nodeStmt = this.db.prepare(
      'SELECT id, type, name, description FROM nodes WHERE id = ?',
    );
    const nodes: (SearchResult & { distance: number })[] = [];
    const entries = [...dist.entries()].sort(
      (a, b) => a[1] - b[1] || a[0].localeCompare(b[0]),
    );
    for (const [nodeId, distance] of entries) {
      const row = nodeStmt.get(nodeId) as
        | { id: string; type: string; name: string; description: string }
        | undefined;
      if (row === undefined) continue; // dangling target — no node file indexed
      nodes.push({
        id: row.id,
        type: row.type as NodeType,
        name: row.name,
        summary: firstLine(row.description),
        score: 0,
        distance,
      });
    }
    return {
      nodes,
      edges: [...edges.values()].map(toEdgeRow).sort(compareEdgeRows),
    };
  }

  /**
   * Reconstruct a GraphNode purely from index rows — fallback for when the
   * node file vanished between reindex and read. `attrs` are not indexed
   * (they live only in the file) and come back empty.
   */
  private nodeFromRows(row: NodeRowDb): GraphNode {
    const aliases = (
      this.db
        .prepare('SELECT alias FROM node_aliases WHERE node_id = ? ORDER BY alias')
        .all(row.id) as { alias: string }[]
    ).map((r) => r.alias);
    const edgeRows = this.db
      .prepare('SELECT * FROM edges WHERE source_id = ? ORDER BY type, target_ref')
      .all(row.id) as EdgeRowDb[];
    const edges: GraphEdge[] = edgeRows.map((e) => {
      const edge: GraphEdge = {
        type: e.type as EdgeType,
        target: e.target_ref,
        confidence: e.confidence,
        status: e.status as ElementStatus,
        evidence: this.evidenceRows('edge', e.id),
      };
      if (e.attrs_json !== null) edge.attrs = JSON.parse(e.attrs_json) as Record<string, unknown>;
      return edge;
    });
    return {
      id: row.id,
      type: row.type as NodeType,
      name: row.name,
      description: row.description,
      aliases,
      status: row.status as ElementStatus,
      attrs: {},
      evidence: this.evidenceRows('node', row.id),
      edges,
      schema_version: row.schema_version,
    };
  }
}
