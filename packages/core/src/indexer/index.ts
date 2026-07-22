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
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_REVIEW_THRESHOLD } from '../constants.js';
import { conflictEvidenceKey } from '../graph/index.js';
import { canonicalJson, edgeId, nodeRef } from '../ids.js';
import { indexDbPath } from '../paths.js';
import { cosineSimilarity, embeddingTextForNode } from '../resolver/index.js';
import type { EmbeddingProvider } from '../resolver/index.js';
import { listNodeFiles, readNodeFile } from '../serializer/index.js';
import type {
  Conflict,
  EdgeType,
  ElementStatus,
  Evidence,
  ExtractorInfo,
  GraphEdge,
  GraphNode,
  GraphStats,
  Locator,
  NodeRef,
  NodeType,
  SearchResult,
  SourceType,
  Stance,
} from '../types.js';
import { createSchema, dropSchema, ensureSchema } from './schema.js';

export { INDEX_SCHEMA_VERSION } from './schema.js';

// ---------------------------------------------------------------------------
// Public row shapes
// ---------------------------------------------------------------------------

export interface EdgeRow {
  /** Stable edge id: edgeId(type, source, target) from ids.ts. */
  id: string;
  /** Source node id (the node whose file owns the edge). */
  source: string;
  type: EdgeType;
  /** Target node ref "<type>/<id>" exactly as written in the file. */
  target: NodeRef;
  /** Target node id (may be dangling — no node file for it). */
  targetId: string;
  confidence: number;
  status: ElementStatus;
  attrs?: Record<string, unknown>;
}

export interface BuildIndexOptions {
  /** Recreate the database from scratch instead of diffing file hashes. */
  full?: boolean;
}

export interface EmbeddingUpdateResult {
  /** Provider whose vectors the table now holds. */
  provider: string;
  /** Nodes (re)embedded in this pass. */
  computed: number;
  /** Rows dropped (nodes gone, or vectors from another provider). */
  removed: number;
  /** Nodes with a vector after the pass. */
  total: number;
}

// ---------------------------------------------------------------------------
// Internal row shapes (database column names)
// ---------------------------------------------------------------------------

interface NodeRowDb {
  id: string;
  type: string;
  name: string;
  status: string;
  description: string;
  schema_version: number;
  file_path: string;
}

interface EdgeRowDb {
  id: string;
  source_id: string;
  type: string;
  target_ref: string;
  target_id: string;
  confidence: number;
  status: string;
  attrs_json: string | null;
}

interface EvidenceRowDb {
  id: number;
  owner_kind: string;
  owner_id: string;
  source_type: string;
  locator_json: string;
  excerpt: string;
  stance: string;
  extractor_json: string | null;
  extracted_at: string | null;
  run: string | null;
  validated_by: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sha1(content: Buffer | string): string {
  return createHash('sha1').update(content).digest('hex');
}

/** Repo-relative path with forward slashes, so the index survives repo moves. */
function toRepoRel(repoRoot: string, absPath: string): string {
  return relative(repoRoot, absPath).split(sep).join('/');
}

/** Target node id from a "<type>/<id>" ref; tolerant of malformed refs. */
function targetIdOf(target: NodeRef): string {
  const idx = target.indexOf('/');
  return idx === -1 ? target : target.slice(idx + 1);
}

function firstLine(description: string): string {
  const nl = description.indexOf('\n');
  return (nl === -1 ? description : description.slice(0, nl)).trim();
}

/** SQLite only binds primitives; coerce YAML surprises (dates, numbers) to text. */
function asTextOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : String(value);
}

/**
 * Escape a raw user query into a safe FTS5 MATCH expression: each whitespace
 * token becomes a double-quoted phrase (implicit AND); a trailing `*` on the
 * raw query turns the last phrase into a prefix query.
 */
function toFtsQuery(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return undefined;
  const prefix = trimmed.endsWith('*');
  const body = prefix ? trimmed.slice(0, -1) : trimmed;
  const tokens = body.split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return undefined;
  const phrases = tokens.map((t) => `"${t.replaceAll('"', '""')}"`);
  if (prefix) phrases[phrases.length - 1] += '*';
  return phrases.join(' ');
}

function toEdgeRow(row: EdgeRowDb): EdgeRow {
  const edge: EdgeRow = {
    id: row.id,
    source: row.source_id,
    type: row.type as EdgeType,
    target: row.target_ref,
    targetId: row.target_id,
    confidence: row.confidence,
    status: row.status as ElementStatus,
  };
  if (row.attrs_json !== null) {
    edge.attrs = JSON.parse(row.attrs_json) as Record<string, unknown>;
  }
  return edge;
}

function rowToEvidence(row: EvidenceRowDb): Evidence {
  const ev: Evidence = {
    source_type: row.source_type as SourceType,
    locator: JSON.parse(row.locator_json) as Locator,
    excerpt: row.excerpt,
    stance: row.stance as Stance,
  };
  if (row.extractor_json !== null) {
    ev.extractor = JSON.parse(row.extractor_json) as ExtractorInfo;
  }
  if (row.extracted_at !== null) ev.extracted_at = row.extracted_at;
  if (row.run !== null) ev.run = row.run;
  if (row.validated_by !== null) ev.validated_by = row.validated_by;
  return ev;
}

function compareEdgeRows(a: EdgeRow, b: EdgeRow): number {
  return (
    a.source.localeCompare(b.source) ||
    a.type.localeCompare(b.type) ||
    a.target.localeCompare(b.target)
  );
}

// ---------------------------------------------------------------------------
// Embedding vector encoding — Float32 BLOBs, little-endian
// ---------------------------------------------------------------------------

function encodeVector(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

function decodeVector(blob: Buffer): number[] {
  const floats = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  return Array.from(floats);
}

/** Cache key of a node's vector: provider identity + embedded text. */
function embeddingHash(providerName: string, text: string): string {
  return sha1(`${providerName}\0${text}`);
}

// ---------------------------------------------------------------------------
// Database open + sync (shared by buildIndex and GraphIndex)
// ---------------------------------------------------------------------------

function openIndexDb(repoRoot: string): Database.Database {
  const dbPath = indexDbPath(repoRoot);
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  ensureSchema(db);
  return db;
}

/**
 * Diff the `files` table (path → content hash) against the node files on
 * disk; reindex added/changed files, drop rows for removed files. Each
 * file's multi-table update runs inside a transaction.
 */
function syncIndex(
  db: Database.Database,
  repoRoot: string,
): { indexed: number; removed: number; total: number } {
  const disk = new Map<string, { abs: string; hash: string }>();
  for (const abs of listNodeFiles(repoRoot)) {
    disk.set(toRepoRel(repoRoot, abs), { abs, hash: sha1(readFileSync(abs)) });
  }

  const known = new Map<string, string>();
  const knownRows = db.prepare('SELECT path, hash FROM files').all() as {
    path: string;
    hash: string;
  }[];
  for (const row of knownRows) known.set(row.path, row.hash);

  const toIndex = [...disk.entries()].filter(([rel, f]) => known.get(rel) !== f.hash);
  const toRemove = [...known.keys()].filter((rel) => !disk.has(rel));

  const stmts = {
    nodeIdsForFile: db.prepare('SELECT id FROM nodes WHERE file_path = ?'),
    delEdgeEvidence: db.prepare(
      "DELETE FROM evidence WHERE owner_kind = 'edge' AND owner_id IN (SELECT id FROM edges WHERE source_id = ?)",
    ),
    delNodeEvidence: db.prepare("DELETE FROM evidence WHERE owner_kind = 'node' AND owner_id = ?"),
    delEdges: db.prepare('DELETE FROM edges WHERE source_id = ?'),
    delAliases: db.prepare('DELETE FROM node_aliases WHERE node_id = ?'),
    delSearch: db.prepare('DELETE FROM search WHERE node_id = ?'),
    delNode: db.prepare('DELETE FROM nodes WHERE id = ?'),
    delFile: db.prepare('DELETE FROM files WHERE path = ?'),
    insNode: db.prepare(
      'INSERT OR REPLACE INTO nodes (id, type, name, status, description, schema_version, file_path) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ),
    insAlias: db.prepare('INSERT INTO node_aliases (node_id, alias) VALUES (?, ?)'),
    insSearch: db.prepare(
      'INSERT INTO search (node_id, name, aliases, description) VALUES (?, ?, ?, ?)',
    ),
    insEdge: db.prepare(
      'INSERT OR REPLACE INTO edges (id, source_id, type, target_ref, target_id, confidence, status, attrs_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    insEvidence: db.prepare(
      'INSERT INTO evidence (owner_kind, owner_id, source_type, locator_json, excerpt, stance, extractor_json, extracted_at, run, validated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ),
    insFile: db.prepare('INSERT OR REPLACE INTO files (path, hash) VALUES (?, ?)'),
    setMeta: db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)'),
  };

  const addEvidence = (kind: 'node' | 'edge', ownerId: string, ev: Evidence): void => {
    stmts.insEvidence.run(
      kind,
      ownerId,
      ev.source_type,
      canonicalJson(ev.locator ?? {}),
      asTextOrNull(ev.excerpt) ?? '',
      ev.stance ?? 'supports',
      ev.extractor ? canonicalJson(ev.extractor) : null,
      asTextOrNull(ev.extracted_at),
      asTextOrNull(ev.run),
      asTextOrNull(ev.validated_by),
    );
  };

  const removeRows = (rel: string): void => {
    const owners = stmts.nodeIdsForFile.all(rel) as { id: string }[];
    for (const { id } of owners) {
      stmts.delEdgeEvidence.run(id);
      stmts.delNodeEvidence.run(id);
      stmts.delEdges.run(id);
      stmts.delAliases.run(id);
      stmts.delSearch.run(id);
      stmts.delNode.run(id);
    }
    stmts.delFile.run(rel);
  };

  const indexOne = (rel: string, abs: string, hash: string): void => {
    const node: GraphNode = readNodeFile(abs);
    removeRows(rel);
    stmts.insNode.run(
      node.id,
      node.type,
      node.name,
      node.status,
      node.description,
      node.schema_version,
      rel,
    );
    for (const alias of node.aliases) stmts.insAlias.run(node.id, alias);
    stmts.insSearch.run(node.id, node.name, node.aliases.join(' '), node.description);
    for (const ev of node.evidence) addEvidence('node', node.id, ev);
    const seen = new Set<string>();
    for (const edge of node.edges) {
      const id = edgeId(edge.type, node.id, edge.target);
      if (seen.has(id)) continue; // duplicate (type, target) inside one file
      seen.add(id);
      stmts.insEdge.run(
        id,
        node.id,
        edge.type,
        edge.target,
        targetIdOf(edge.target),
        edge.confidence,
        edge.status,
        edge.attrs && Object.keys(edge.attrs).length > 0 ? canonicalJson(edge.attrs) : null,
      );
      for (const ev of edge.evidence) addEvidence('edge', id, ev);
    }
    stmts.insFile.run(rel, hash);
  };

  const removeTx = db.transaction(removeRows);
  const indexTx = db.transaction(indexOne);

  for (const rel of toRemove) removeTx(rel);
  for (const [rel, f] of toIndex) indexTx(rel, f.abs, f.hash);
  stmts.setMeta.run('built_at', new Date().toISOString());

  return { indexed: toIndex.length, removed: toRemove.length, total: disk.size };
}

// ---------------------------------------------------------------------------
// buildIndex
// ---------------------------------------------------------------------------

/**
 * Build or refresh .untacit/index.db. Default is incremental (hash diff);
 * `full` drops everything and reingests every node file.
 */
export function buildIndex(
  repoRoot: string,
  opts?: BuildIndexOptions,
): { indexed: number; removed: number; total: number } {
  const db = openIndexDb(repoRoot);
  try {
    if (opts?.full) {
      dropSchema(db);
      createSchema(db);
    }
    return syncIndex(db, repoRoot);
  } finally {
    db.close();
  }
}

/**
 * Refresh the derived index and its node embeddings in one shot: incremental
 * reindex by file hash, then incremental re-embedding by content hash.
 */
export async function buildEmbeddings(
  repoRoot: string,
  provider: EmbeddingProvider,
): Promise<EmbeddingUpdateResult> {
  const index = GraphIndex.open(repoRoot);
  try {
    return await index.updateEmbeddings(provider);
  } finally {
    index.close();
  }
}

/**
 * Flatten the index file for read-only distribution (docs/06 §4.6): fold the
 * WAL back into the main file and switch to the DELETE journal so the .db can
 * be shipped alone (serverless bundles) and opened with `openReadonly`.
 */
export function checkpointIndex(repoRoot: string): void {
  const db = openIndexDb(repoRoot);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.pragma('journal_mode = DELETE');
  } finally {
    db.close();
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

  /** FTS5 search over name + aliases + description, bm25 ranked. */
  search(
    query: string,
    opts?: { types?: NodeType[]; limit?: number; offset?: number },
  ): SearchResult[] {
    const match = toFtsQuery(query);
    if (match === undefined) return [];
    const limit = opts?.limit ?? 20;
    const offset = opts?.offset ?? 0;
    const types = opts?.types !== undefined && opts.types.length > 0 ? opts.types : undefined;

    let sql = `
      SELECT n.id AS id, n.type AS type, n.name AS name, n.description AS description,
             bm25(search) AS rank
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
  // Node embeddings (docs/03 §3): derived vectors, incremental by content hash
  // -------------------------------------------------------------------------

  /**
   * Bring the `embeddings` table up to date with the current provider:
   * re-embeds only nodes whose embedded text ("type name aliases description")
   * or provider changed, and drops vectors of vanished nodes. Safe to call on
   * every read path — when nothing changed it costs one table scan.
   */
  async updateEmbeddings(provider: EmbeddingProvider): Promise<EmbeddingUpdateResult> {
    // Vectors of vanished nodes go first (any provider). Other providers'
    // live vectors are kept: the table is keyed by (node_id, provider), so
    // switching providers back and forth never throws away a warm cache.
    const removed =
      this.db
        .prepare('DELETE FROM embeddings WHERE node_id NOT IN (SELECT id FROM nodes)')
        .run().changes ?? 0;

    const known = new Map<string, string>();
    for (const row of this.db
      .prepare('SELECT node_id, hash FROM embeddings WHERE provider = ?')
      .all(provider.name) as { node_id: string; hash: string }[]) {
      known.set(row.node_id, row.hash);
    }

    const stale: { id: string; text: string; hash: string }[] = [];
    for (const { id, text } of this.embeddingTexts()) {
      const hash = embeddingHash(provider.name, text);
      if (known.get(id) !== hash) stale.push({ id, text, hash });
    }

    if (stale.length > 0) {
      const vectors = await provider.embed(
        stale.map((s) => s.text),
        'passage',
      );
      if (vectors.length !== stale.length) {
        throw new Error(
          `Embedding provider "${provider.name}" returned ${vectors.length} vectors for ${stale.length} texts`,
        );
      }
      const upsert = this.db.prepare(
        'INSERT OR REPLACE INTO embeddings (node_id, provider, hash, dims, vector) VALUES (?, ?, ?, ?, ?)',
      );
      const tx = this.db.transaction(() => {
        stale.forEach((s, i) => {
          const vector = vectors[i]!;
          // Never cache an empty vector under a valid content hash — it
          // would look fresh forever and poison the cache.
          if (vector.length === 0) return;
          upsert.run(s.id, provider.name, s.hash, vector.length, encodeVector(vector));
        });
      });
      tx();
    }

    const total = (
      this.db
        .prepare('SELECT COUNT(*) AS c FROM embeddings WHERE provider = ?')
        .get(provider.name) as { c: number }
    ).c;
    return { provider: provider.name, computed: stale.length, removed, total };
  }

  /**
   * Cached node vectors for a provider (node id → vector), restricted to
   * nodes still present. This is what the resolver's fuzzy match consumes.
   */
  nodeVectors(providerName: string): Map<string, number[]> {
    const rows = this.db
      .prepare(
        'SELECT e.node_id AS id, e.vector AS vector FROM embeddings e JOIN nodes n ON n.id = e.node_id WHERE e.provider = ?',
      )
      .all(providerName) as { id: string; vector: Buffer }[];
    return new Map(rows.map((row) => [row.id, decodeVector(row.vector)]));
  }

  /**
   * k-NN over the cached node vectors (cosine, linear scan). At v1 scale
   * (thousands of nodes) a scan is milliseconds; sqlite-vec remains the
   * planned upgrade path if graphs outgrow it (docs/03 §3).
   */
  async semanticSearch(
    query: string,
    provider: EmbeddingProvider,
    opts?: { types?: NodeType[]; limit?: number },
  ): Promise<SearchResult[]> {
    const limit = opts?.limit ?? 20;
    const types =
      opts?.types !== undefined && opts.types.length > 0 ? new Set<string>(opts.types) : undefined;
    const [queryVec] = await provider.embed([query], 'query');
    // A missing or zero-norm query vector (e.g. text that normalizes to
    // nothing) has no meaningful neighbors — cosine would be 0 everywhere
    // and the "top k" would be arbitrary nodes.
    if (queryVec === undefined || !queryVec.some((v) => v !== 0)) return [];

    const rows = this.db
      .prepare(
        `SELECT n.id AS id, n.type AS type, n.name AS name, n.description AS description, e.vector AS vector
         FROM embeddings e JOIN nodes n ON n.id = e.node_id
         WHERE e.provider = ? AND e.dims = ?`,
      )
      .all(provider.name, queryVec.length) as {
      id: string;
      type: string;
      name: string;
      description: string;
      vector: Buffer;
    }[];

    const scored: SearchResult[] = [];
    for (const row of rows) {
      if (types !== undefined && !types.has(row.type)) continue;
      scored.push({
        id: row.id,
        type: row.type as NodeType,
        name: row.name,
        summary: firstLine(row.description),
        score: cosineSimilarity(queryVec, decodeVector(row.vector)),
      });
    }
    scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
    return scored.slice(0, limit);
  }

  /**
   * Hybrid retrieval (docs/03 §6.1): reciprocal-rank fusion of the lexical
   * channel (FTS5/bm25) and the semantic channel (embedding k-NN). With no
   * provider — or an empty embeddings table — it degrades to lexical only.
   * RRF score: Σ 1/(60 + rank), summed over the channels that returned the
   * node; the fused score is reported in `score`.
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
    const lexical = this.search(query, { types: opts?.types, limit: pool });
    const semantic =
      provider !== null ? await this.semanticSearch(query, provider, { types: opts?.types, limit: pool }) : [];

    const K = 60;
    const fused = new Map<string, SearchResult & { fusedScore: number }>();
    for (const channel of [lexical, semantic]) {
      channel.forEach((result, rank) => {
        const entry = fused.get(result.id);
        const contribution = 1 / (K + rank + 1);
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

  /**
   * Embedded text per node, composed from index rows exactly like the
   * resolver composes it from GraphNodes (embeddingTextForNode), so cached
   * vectors and on-the-fly vectors agree.
   */
  private embeddingTexts(): { id: string; text: string }[] {
    const nodes = this.db
      .prepare('SELECT id, type, name, description FROM nodes ORDER BY id')
      .all() as { id: string; type: string; name: string; description: string }[];
    const aliasStmt = this.db.prepare(
      'SELECT alias FROM node_aliases WHERE node_id = ? ORDER BY rowid',
    );
    return nodes.map((row) => {
      const aliases = (aliasStmt.all(row.id) as { alias: string }[]).map((a) => a.alias);
      return {
        id: row.id,
        text: embeddingTextForNode({
          type: row.type as NodeType,
          name: row.name,
          aliases,
          description: row.description,
        }),
      };
    });
  }

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
