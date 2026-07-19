/**
 * Server-side state (docs/06 §4.1): users, grants, OAuth clients, pending
 * login transactions, auth codes and tokens — everything that is NOT graph
 * content lives in `<dataDir>/server.db`. Graph repos stay read-only.
 *
 * Versioned like the derived index: `PRAGMA user_version`. Auth tables
 * (codes/tokens/requests) are disposable across schema bumps; users and
 * grants must be migrated.
 */

import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

import Database from 'better-sqlite3';

export const SERVER_DB_VERSION = 2;

export function serverDbPath(dataDir: string): string {
  return join(dataDir, 'server.db');
}

const DDL = `
CREATE TABLE IF NOT EXISTS users (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  display_name  TEXT,
  disabled      INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_graphs (
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  graph_id   TEXT NOT NULL,
  granted_at TEXT NOT NULL,
  can_write  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, graph_id)
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  metadata_json TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_requests (
  txn_id      TEXT PRIMARY KEY,
  client_id   TEXT NOT NULL,
  params_json TEXT NOT NULL,
  csrf        TEXT NOT NULL,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_codes (
  code_hash      TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL,
  client_id      TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  redirect_uri   TEXT NOT NULL,
  resource       TEXT,
  scopes         TEXT NOT NULL,
  expires_at     INTEGER NOT NULL,
  used           INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tokens (
  token_hash  TEXT PRIMARY KEY,
  kind        TEXT NOT NULL CHECK (kind IN ('access','refresh')),
  user_id     TEXT NOT NULL,
  client_id   TEXT NOT NULL,
  scopes      TEXT NOT NULL,
  resource    TEXT,
  expires_at  INTEGER NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0,
  parent_hash TEXT,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_tokens_user ON tokens(user_id, kind, revoked);
CREATE INDEX IF NOT EXISTS idx_tokens_expiry ON tokens(expires_at);
CREATE INDEX IF NOT EXISTS idx_tokens_parent ON tokens(parent_hash);
`;

/** Open (creating if needed) the server database. Callers own the handle. */
export function openServerDb(dataDir: string): Database.Database {
  const path = serverDbPath(dataDir);
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  ensureSchema(db);
  return db;
}

function ensureSchema(db: Database.Database): void {
  const version = db.pragma('user_version', { simple: true }) as number;
  if (version === SERVER_DB_VERSION) return;
  if (version > SERVER_DB_VERSION) {
    throw new Error(
      `server.db schema is version ${version}, this build understands ${SERVER_DB_VERSION} — ` +
        'upgrade untacit-server',
    );
  }
  // v0 → creation; v1 → v2 adds the write level to grants (migrated in
  // place — users and grants are never disposable). The DDL is idempotent
  // (IF NOT EXISTS), so running it after the ALTER also backfills any table
  // a future bump may add.
  if (version === 1) {
    db.exec('ALTER TABLE user_graphs ADD COLUMN can_write INTEGER NOT NULL DEFAULT 0');
  }
  db.exec(DDL);
  db.pragma(`user_version = ${SERVER_DB_VERSION}`);
}

/** Drop expired rows that no code path will ever read again. */
export function pruneExpired(db: Database.Database, nowSeconds = Math.floor(Date.now() / 1000)): void {
  db.prepare('DELETE FROM auth_requests WHERE expires_at < ?').run(nowSeconds);
  db.prepare('DELETE FROM auth_codes WHERE expires_at < ?').run(nowSeconds);
  db.prepare('DELETE FROM tokens WHERE expires_at < ?').run(nowSeconds);
}
