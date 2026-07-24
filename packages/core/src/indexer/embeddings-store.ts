/**
 * Node embeddings over the derived index (docs/03 §3): cached vectors,
 * incremental by content hash, plus the semantic search primitives that
 * consume them. Every function takes the open index database — GraphIndex
 * exposes them as methods and passes its own handle.
 */

import type Database from 'better-sqlite3';
import { cosineSimilarity, embeddingTextForNode } from '../resolver/index.js';
import type { EmbeddingProvider } from '../resolver/index.js';
import type { NodeType, SearchResult } from '../types.js';
import { segmentDescription } from './fts.js';
import { firstLine, sha1 } from './rows.js';

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
// Embedding vector encoding — Float32 BLOBs, little-endian
// ---------------------------------------------------------------------------

export function encodeVector(vector: number[]): Buffer {
  return Buffer.from(new Float32Array(vector).buffer);
}

export function decodeVector(blob: Buffer): number[] {
  const floats = new Float32Array(blob.buffer, blob.byteOffset, blob.byteLength / 4);
  return Array.from(floats);
}

/** Cache key of a node's vector: provider identity + embedded text. */
export function embeddingHash(providerName: string, text: string): string {
  return sha1(`${providerName}\0${text}`);
}

// ---------------------------------------------------------------------------
// Per-node embedding texts (composed from index rows)
// ---------------------------------------------------------------------------

/**
 * Embedded text per node, composed from index rows exactly like the
 * resolver composes it from GraphNodes (embeddingTextForNode), so cached
 * vectors and on-the-fly vectors agree.
 */
function embeddingTexts(db: Database.Database): { id: string; text: string }[] {
  const nodes = db
    .prepare('SELECT id, type, name, description FROM nodes ORDER BY id')
    .all() as { id: string; type: string; name: string; description: string }[];
  const aliasStmt = db.prepare('SELECT alias FROM node_aliases WHERE node_id = ? ORDER BY rowid');
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

/**
 * Facet texts per node for late interaction: facet 0 = "type name aliases"
 * (what the node IS), facets 1..n = description segments (what it SAYS).
 */
function nodeFacetTexts(db: Database.Database): { id: string; facets: string[] }[] {
  const nodes = db
    .prepare('SELECT id, type, name, description FROM nodes ORDER BY id')
    .all() as { id: string; type: string; name: string; description: string }[];
  const aliasStmt = db.prepare('SELECT alias FROM node_aliases WHERE node_id = ? ORDER BY rowid');
  return nodes.map((row) => {
    const aliases = (aliasStmt.all(row.id) as { alias: string }[]).map((a) => a.alias);
    const nameFacet = [row.type, row.name, ...aliases].join(' ').trim();
    return { id: row.id, facets: [nameFacet, ...segmentDescription(row.description)] };
  });
}

// ---------------------------------------------------------------------------
// Cache maintenance
// ---------------------------------------------------------------------------

/**
 * Bring the `embeddings` table up to date with the current provider:
 * re-embeds only nodes whose embedded text ("type name aliases description")
 * or provider changed, and drops vectors of vanished nodes. Safe to call on
 * every read path — when nothing changed it costs one table scan.
 */
export async function updateEmbeddings(
  db: Database.Database,
  provider: EmbeddingProvider,
): Promise<EmbeddingUpdateResult> {
  // Vectors of vanished nodes go first (any provider). Other providers'
  // live vectors are kept: the table is keyed by (node_id, provider), so
  // switching providers back and forth never throws away a warm cache.
  const removed =
    db.prepare('DELETE FROM embeddings WHERE node_id NOT IN (SELECT id FROM nodes)').run()
      .changes ?? 0;

  const known = new Map<string, string>();
  for (const row of db
    .prepare('SELECT node_id, hash FROM embeddings WHERE provider = ?')
    .all(provider.name) as { node_id: string; hash: string }[]) {
    known.set(row.node_id, row.hash);
  }

  const stale: { id: string; text: string; hash: string }[] = [];
  for (const { id, text } of embeddingTexts(db)) {
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
    const upsert = db.prepare(
      'INSERT OR REPLACE INTO embeddings (node_id, provider, hash, dims, vector) VALUES (?, ?, ?, ?, ?)',
    );
    const tx = db.transaction(() => {
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
    db.prepare('SELECT COUNT(*) AS c FROM embeddings WHERE provider = ?').get(provider.name) as {
      c: number;
    }
  ).c;
  return { provider: provider.name, computed: stale.length, removed, total };
}

/**
 * Embedding-cache coverage for a provider: cached vectors vs node count.
 * Joined against `nodes` because reindexing does not purge vectors of
 * deleted nodes (updateEmbeddings does) — orphans must not count as
 * coverage while new nodes sit unembedded.
 */
export function embeddingCoverage(
  db: Database.Database,
  providerName: string,
): { embedded: number; nodes: number } {
  const embedded = (
    db
      .prepare(
        'SELECT COUNT(*) AS c FROM embeddings e JOIN nodes n ON n.id = e.node_id WHERE e.provider = ?',
      )
      .get(providerName) as { c: number }
  ).c;
  const nodes = (db.prepare('SELECT COUNT(*) AS c FROM nodes').get() as { c: number }).c;
  return { embedded, nodes };
}

/**
 * Cached node vectors for a provider (node id → vector), restricted to
 * nodes still present. This is what the resolver's fuzzy match consumes.
 */
export function nodeVectors(db: Database.Database, providerName: string): Map<string, number[]> {
  const rows = db
    .prepare(
      'SELECT e.node_id AS id, e.vector AS vector FROM embeddings e JOIN nodes n ON n.id = e.node_id WHERE e.provider = ?',
    )
    .all(providerName) as { id: string; vector: Buffer }[];
  return new Map(rows.map((row) => [row.id, decodeVector(row.vector)]));
}

/**
 * Bring the `embeddings_facets` table up to date: facet 0 is
 * "type name aliases", facets 1..n are description segments
 * (segmentDescription). Incremental per node by joint content hash — a
 * node re-embeds all its facets only when any facet text (or the facet
 * count) changed. This is the deliberately compute-heavier sibling of
 * `updateEmbeddings` (docs/03 §6.1): several vectors per node instead of
 * one mean-pooled vector, so a query can match one sentence of a long
 * description at full strength instead of being diluted across the pool.
 */
export async function updateFacetEmbeddings(
  db: Database.Database,
  provider: EmbeddingProvider,
): Promise<EmbeddingUpdateResult> {
  const removed =
    db.prepare('DELETE FROM embeddings_facets WHERE node_id NOT IN (SELECT id FROM nodes)').run()
      .changes ?? 0;

  // Stored joint hash per node: sha1 over the per-facet hashes in order.
  const known = new Map<string, string>();
  const knownRows = db
    .prepare('SELECT node_id, hash FROM embeddings_facets WHERE provider = ? ORDER BY node_id, facet')
    .all(provider.name) as { node_id: string; hash: string }[];
  const grouped = new Map<string, string[]>();
  for (const row of knownRows) {
    const list = grouped.get(row.node_id);
    if (list === undefined) grouped.set(row.node_id, [row.hash]);
    else list.push(row.hash);
  }
  for (const [id, hashes] of grouped) known.set(id, sha1(hashes.join('|')));

  const stale: { id: string; facets: { text: string; hash: string }[] }[] = [];
  for (const { id, facets } of nodeFacetTexts(db)) {
    const withHashes = facets.map((text) => ({ text, hash: embeddingHash(provider.name, text) }));
    const joint = sha1(withHashes.map((f) => f.hash).join('|'));
    if (known.get(id) !== joint) stale.push({ id, facets: withHashes });
  }

  if (stale.length > 0) {
    const texts = stale.flatMap((s) => s.facets.map((f) => f.text));
    const vectors = await provider.embed(texts, 'passage');
    if (vectors.length !== texts.length) {
      throw new Error(
        `Embedding provider "${provider.name}" returned ${vectors.length} vectors for ${texts.length} facet texts`,
      );
    }
    const del = db.prepare('DELETE FROM embeddings_facets WHERE node_id = ? AND provider = ?');
    const ins = db.prepare(
      'INSERT OR REPLACE INTO embeddings_facets (node_id, provider, facet, hash, dims, vector) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const tx = db.transaction(() => {
      let cursor = 0;
      for (const s of stale) {
        del.run(s.id, provider.name);
        s.facets.forEach((f, facetIdx) => {
          const vector = vectors[cursor]!;
          cursor += 1;
          // Same rule as updateEmbeddings: an empty vector must never look
          // fresh under a valid content hash.
          if (vector.length === 0) return;
          ins.run(s.id, provider.name, facetIdx, f.hash, vector.length, encodeVector(vector));
        });
      }
    });
    tx();
  }

  const total = (
    db
      .prepare('SELECT COUNT(DISTINCT node_id) AS c FROM embeddings_facets WHERE provider = ?')
      .get(provider.name) as { c: number }
  ).c;
  return { provider: provider.name, computed: stale.length, removed, total };
}

// ---------------------------------------------------------------------------
// Semantic search primitives
// ---------------------------------------------------------------------------

/**
 * Late-interaction semantic search (ColBERT-style MaxSim over the facet
 * vectors, docs/03 §6.1): the query embeds once, every node scores as the
 * MAXIMUM cosine over its facet vectors — a node whose *one* relevant
 * sentence matches the query ranks as if that sentence were its whole
 * text, instead of the signal drowning in mean-pooled prose. Costs
 * (facets × nodes) cosines per query; empty when the facet table has no
 * matching vectors.
 */
export async function lateInteractionSearch(
  db: Database.Database,
  query: string,
  provider: EmbeddingProvider,
  opts?: { types?: NodeType[]; limit?: number },
): Promise<SearchResult[]> {
  const limit = opts?.limit ?? 20;
  const types =
    opts?.types !== undefined && opts.types.length > 0 ? new Set<string>(opts.types) : undefined;
  const [queryVec] = await provider.embed([query], 'query');
  if (queryVec === undefined || !queryVec.some((v) => v !== 0)) return [];

  const rows = db
    .prepare(
      `SELECT n.id AS id, n.type AS type, n.name AS name, n.description AS description, f.vector AS vector
       FROM embeddings_facets f JOIN nodes n ON n.id = f.node_id
       WHERE f.provider = ? AND f.dims = ?
       ORDER BY n.id, f.facet`,
    )
    .all(provider.name, queryVec.length) as {
    id: string;
    type: string;
    name: string;
    description: string;
    vector: Buffer;
  }[];

  const best = new Map<string, SearchResult>();
  for (const row of rows) {
    if (types !== undefined && !types.has(row.type)) continue;
    const score = cosineSimilarity(queryVec, decodeVector(row.vector));
    const entry = best.get(row.id);
    if (entry === undefined) {
      best.set(row.id, {
        id: row.id,
        type: row.type as NodeType,
        name: row.name,
        summary: firstLine(row.description),
        score,
      });
    } else if (score > entry.score) {
      entry.score = score;
    }
  }
  return [...best.values()]
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/**
 * k-NN over the cached node vectors (cosine, linear scan). At v1 scale
 * (thousands of nodes) a scan is milliseconds; sqlite-vec remains the
 * planned upgrade path if graphs outgrow it (docs/03 §3).
 */
export async function semanticSearch(
  db: Database.Database,
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

  const rows = db
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
