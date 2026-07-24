/**
 * Index construction and freshness: open the database, diff node files
 * against the `files` table, and (re)ingest what changed. The canonical
 * truth is graph/**\/*.md; everything here only ever ingests files.
 */

import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { canonicalJson, edgeId } from '../ids.js';
import { indexDbPath } from '../paths.js';
import { listNodeFiles, readNodeFile } from '../serializer/index.js';
import type { Evidence, GraphNode } from '../types.js';
import { asTextOrNull, sha1, targetIdOf, toRepoRel } from './rows.js';
import { createSchema, dropSchema, ensureSchema } from './schema.js';

export interface BuildIndexOptions {
  /** Recreate the database from scratch instead of diffing file hashes. */
  full?: boolean;
}

// ---------------------------------------------------------------------------
// Database open + sync (shared by buildIndex and GraphIndex)
// ---------------------------------------------------------------------------

export function openIndexDb(repoRoot: string): Database.Database {
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
export function syncIndex(
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
 * Read-only freshness report of the derived index against the node files on
 * disk (for diagnostics like `untacit doctor`). Never creates or mutates the
 * database file itself: a missing .untacit/index.db reports `exists: false`
 * with every file pending, instead of building one as openIndexDb would.
 * (Caveat: opening a WAL-mode database read-only may still create the empty
 * -shm/-wal sidecars — a SQLite requirement — and can throw on a read-only
 * filesystem; callers surface that as a diagnostic, not a crash.)
 */
export function indexStaleness(repoRoot: string): {
  exists: boolean;
  stale: number;
  removed: number;
  total: number;
} {
  const disk = new Map<string, string>();
  for (const abs of listNodeFiles(repoRoot)) {
    disk.set(toRepoRel(repoRoot, abs), sha1(readFileSync(abs)));
  }

  const dbPath = indexDbPath(repoRoot);
  if (!existsSync(dbPath)) {
    return { exists: false, stale: disk.size, removed: 0, total: disk.size };
  }

  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const known = new Map<string, string>();
    for (const row of db.prepare('SELECT path, hash FROM files').all() as {
      path: string;
      hash: string;
    }[]) {
      known.set(row.path, row.hash);
    }
    const stale = [...disk.entries()].filter(([rel, hash]) => known.get(rel) !== hash).length;
    const removed = [...known.keys()].filter((rel) => !disk.has(rel)).length;
    return { exists: true, stale, removed, total: disk.size };
  } finally {
    db.close();
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
