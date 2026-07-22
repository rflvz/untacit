/**
 * DDL for the derived SQLite index (docs/03 §3).
 *
 * The index is derived and disposable: .untacit/index.db is rebuilt from
 * graph/**\/*.md at any time, so nothing here is a durability contract.
 * `files` keeps a content hash per node file for incremental reindexing;
 * `search` is the FTS5 table over name + aliases + description; `embeddings`
 * caches one node vector per provider, keyed by a content hash so vectors
 * recompute only when the embedded text changes (docs/03 §3).
 */

import type Database from 'better-sqlite3';

/** Bump when this DDL changes; a mismatch in `meta` forces a full rebuild. */
export const INDEX_SCHEMA_VERSION = 3;

const DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS files (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS nodes (
  id             TEXT PRIMARY KEY,
  type           TEXT NOT NULL,
  name           TEXT NOT NULL,
  status         TEXT NOT NULL,
  description    TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  file_path      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS node_aliases (
  node_id TEXT NOT NULL,
  alias   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS edges (
  id         TEXT PRIMARY KEY,
  source_id  TEXT NOT NULL,
  type       TEXT NOT NULL,
  target_ref TEXT NOT NULL,
  target_id  TEXT NOT NULL,
  confidence REAL NOT NULL,
  status     TEXT NOT NULL,
  attrs_json TEXT
);

CREATE TABLE IF NOT EXISTS evidence (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_kind     TEXT NOT NULL CHECK (owner_kind IN ('node', 'edge')),
  owner_id       TEXT NOT NULL,
  source_type    TEXT NOT NULL,
  locator_json   TEXT NOT NULL,
  excerpt        TEXT NOT NULL,
  stance         TEXT NOT NULL,
  extractor_json TEXT,
  extracted_at   TEXT,
  run            TEXT,
  validated_by   TEXT
);

CREATE TABLE IF NOT EXISTS embeddings (
  node_id  TEXT NOT NULL,
  provider TEXT NOT NULL,
  hash     TEXT NOT NULL,
  dims     INTEGER NOT NULL,
  vector   BLOB NOT NULL,
  PRIMARY KEY (node_id, provider)
);

-- Late-interaction facet vectors (docs/03 §6.1): several vectors per node —
-- facet 0 is name+aliases, facets 1..n are description segments — scored
-- with MaxSim at query time. hash caches per-facet content like embeddings.
CREATE TABLE IF NOT EXISTS embeddings_facets (
  node_id  TEXT NOT NULL,
  provider TEXT NOT NULL,
  facet    INTEGER NOT NULL,
  hash     TEXT NOT NULL,
  dims     INTEGER NOT NULL,
  vector   BLOB NOT NULL,
  PRIMARY KEY (node_id, provider, facet)
);

CREATE INDEX IF NOT EXISTS idx_nodes_type      ON nodes (type);
CREATE INDEX IF NOT EXISTS idx_nodes_file      ON nodes (file_path);
CREATE INDEX IF NOT EXISTS idx_aliases_node    ON node_aliases (node_id);
CREATE INDEX IF NOT EXISTS idx_edges_source    ON edges (source_id);
CREATE INDEX IF NOT EXISTS idx_edges_target    ON edges (target_id);
CREATE INDEX IF NOT EXISTS idx_edges_type      ON edges (type);
CREATE INDEX IF NOT EXISTS idx_edges_status    ON edges (status);
CREATE INDEX IF NOT EXISTS idx_evidence_owner  ON evidence (owner_id);
`;

/**
 * FTS5 table over name + aliases + description. remove_diacritics 2 makes
 * accent-insensitive matching complete ("facturacion" finds "facturación").
 */
const FTS_DDL = `
CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(
  node_id UNINDEXED,
  name,
  aliases,
  description,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE IF NOT EXISTS search_vocab USING fts5vocab(search, 'row');
`;

export function createSchema(db: Database.Database): void {
  db.exec(DDL);
  db.exec(FTS_DDL);
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(
    'schema_version',
    String(INDEX_SCHEMA_VERSION),
  );
}

export function dropSchema(db: Database.Database): void {
  db.exec(`
    DROP TABLE IF EXISTS search_vocab;
    DROP TABLE IF EXISTS search;
    DROP TABLE IF EXISTS embeddings_facets;
    DROP TABLE IF EXISTS embeddings;
    DROP TABLE IF EXISTS evidence;
    DROP TABLE IF EXISTS edges;
    DROP TABLE IF EXISTS node_aliases;
    DROP TABLE IF EXISTS nodes;
    DROP TABLE IF EXISTS files;
    DROP TABLE IF EXISTS meta;
  `);
}

/** Create the schema if absent; drop and recreate on a version mismatch. */
export function ensureSchema(db: Database.Database): void {
  let version: string | undefined;
  try {
    const row = db
      .prepare("SELECT value FROM meta WHERE key = 'schema_version'")
      .get() as { value: string } | undefined;
    version = row?.value;
  } catch {
    version = undefined; // meta table missing — fresh or foreign database
  }
  if (version !== String(INDEX_SCHEMA_VERSION)) {
    dropSchema(db);
    createSchema(db);
  }
}
