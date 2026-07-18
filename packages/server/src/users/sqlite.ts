/**
 * SQLite-backed user store (Docker / stateful mode). All mutations are
 * effective immediately — the CLI edits the same server.db the running
 * server reads, so `docker exec … user add` works in-place (docs/06 §4.5).
 */

import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import {
  DUMMY_PASSWORD_HASH,
  hashPassword,
  verifyPassword,
  type UserRecord,
  type UserStore,
} from './store.js';

interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  display_name: string | null;
  disabled: number;
  created_at: string;
  updated_at: string;
}

function toRecord(row: UserRow): UserRecord {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    disabled: row.disabled !== 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class SqliteUserStore implements UserStore {
  constructor(private readonly db: Database.Database) {}

  add(username: string, password: string, displayName?: string): UserRecord {
    const name = username.trim();
    if (!/^[a-zA-Z0-9._@-]{1,64}$/.test(name)) {
      throw new Error(
        `Invalid username "${username}": use 1-64 characters of a-z, 0-9, ".", "_", "@" or "-"`,
      );
    }
    if (this.getByUsername(name)) throw new Error(`User "${name}" already exists`);
    const now = new Date().toISOString();
    const record: UserRow = {
      id: randomUUID(),
      username: name,
      password_hash: hashPassword(password),
      display_name: displayName ?? null,
      disabled: 0,
      created_at: now,
      updated_at: now,
    };
    this.db
      .prepare(
        `INSERT INTO users (id, username, password_hash, display_name, disabled, created_at, updated_at)
         VALUES (@id, @username, @password_hash, @display_name, @disabled, @created_at, @updated_at)`,
      )
      .run(record);
    return toRecord(record);
  }

  getByUsername(username: string): UserRecord | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      | UserRow
      | undefined;
    return row ? toRecord(row) : undefined;
  }

  getById(id: string): UserRecord | undefined {
    const row = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
    return row ? toRecord(row) : undefined;
  }

  list(): UserRecord[] {
    const rows = this.db.prepare('SELECT * FROM users ORDER BY username').all() as UserRow[];
    return rows.map(toRecord);
  }

  setDisabled(username: string, disabled: boolean): void {
    const result = this.db
      .prepare('UPDATE users SET disabled = ?, updated_at = ? WHERE username = ?')
      .run(disabled ? 1 : 0, new Date().toISOString(), username);
    if (result.changes === 0) throw new Error(`User "${username}" not found`);
  }

  setPassword(username: string, password: string): void {
    const result = this.db
      .prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE username = ?')
      .run(hashPassword(password), new Date().toISOString(), username);
    if (result.changes === 0) throw new Error(`User "${username}" not found`);
  }

  verifyCredentials(username: string, password: string): UserRecord | null {
    const row = this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as
      | UserRow
      | undefined;
    // Always run one scrypt verification so unknown users cost the same as
    // wrong passwords (no account enumeration via response timing).
    const ok = verifyPassword(password, row?.password_hash ?? DUMMY_PASSWORD_HASH);
    if (!row || !ok || row.disabled !== 0) return null;
    return toRecord(row);
  }

  grant(userId: string, graphId: string): void {
    this.db
      .prepare(
        'INSERT INTO user_graphs (user_id, graph_id, granted_at) VALUES (?, ?, ?) ' +
          'ON CONFLICT (user_id, graph_id) DO NOTHING',
      )
      .run(userId, graphId, new Date().toISOString());
  }

  revoke(userId: string, graphId: string): void {
    this.db.prepare('DELETE FROM user_graphs WHERE user_id = ? AND graph_id = ?').run(userId, graphId);
  }

  grants(userId: string): string[] {
    const rows = this.db
      .prepare('SELECT graph_id FROM user_graphs WHERE user_id = ? ORDER BY graph_id')
      .all(userId) as { graph_id: string }[];
    return rows.map((r) => r.graph_id);
  }

  hasGrant(userId: string, graphId: string): boolean {
    return (
      this.db
        .prepare('SELECT 1 FROM user_graphs WHERE user_id = ? AND graph_id = ?')
        .get(userId, graphId) !== undefined
    );
  }
}
