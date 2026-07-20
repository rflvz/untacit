/**
 * CLI tests (docs/06 §4.5). The security-sensitive token-revocation SQL lives
 * only in bin.ts — `user disable` (revoke ALL the user's tokens) and graph-
 * scoped `revoke` (the hand-built `resource LIKE …/graphs/<id>/mcp`). Drive
 * buildProgram().parseAsync against a temp server.db and inspect the effect.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';

import { buildProgram } from './bin.js';
import { openServerDb } from './db.js';
import { SqliteUserStore } from './users/sqlite.js';

const tmpDirs: string[] = [];
afterAll(() => {
  // maxRetries/retryDelay: on Windows the SQLite -wal/-shm mmap lingers a few
  // ms after close(), so a recursive rm can hit a transient EPERM/EBUSY.
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'untacit-server-bin-'));
  tmpDirs.push(dir);
  return dir;
}

// Global -d must precede the subcommand (commander parses root options first).
async function run(dataDir: string, ...args: string[]): Promise<void> {
  await buildProgram().parseAsync(['node', 'untacit-server', '-d', dataDir, ...args]);
}

function insertToken(db: Database.Database, hash: string, userId: string, resource: string | null): void {
  db.prepare(
    `INSERT INTO tokens (token_hash, kind, user_id, client_id, scopes, resource, expires_at, created_at)
     VALUES (?, 'access', ?, 'c', 'mcp', ?, ?, 'now')`,
  ).run(hash, userId, resource, Math.floor(Date.now() / 1000) + 3600);
}

function revokedOf(db: Database.Database, hash: string): number {
  return (db.prepare('SELECT revoked FROM tokens WHERE token_hash = ?').get(hash) as { revoked: number })
    .revoked;
}

describe('untacit-server CLI', () => {
  it('user disable revokes all of the user\'s live tokens', async () => {
    const dataDir = makeDataDir();
    let db = openServerDb(dataDir);
    const ana = new SqliteUserStore(db).add('ana', 'ana-password-123');
    insertToken(db, 'tok-access', ana.id, null);
    insertToken(db, 'tok-refresh', ana.id, null);
    db.close();

    await run(dataDir, 'user', 'disable', 'ana');

    db = openServerDb(dataDir);
    expect(revokedOf(db, 'tok-access')).toBe(1);
    expect(revokedOf(db, 'tok-refresh')).toBe(1);
    expect(new SqliteUserStore(db).getByUsername('ana')!.disabled).toBeTruthy();
    db.close();
  });

  it('revoke <graph> revokes only the tokens bound to that graph', async () => {
    const dataDir = makeDataDir();
    let db = openServerDb(dataDir);
    const users = new SqliteUserStore(db);
    const ana = users.add('ana', 'ana-password-123');
    users.grant(ana.id, 'acme');
    users.grant(ana.id, 'logistica');
    insertToken(db, 'tok-acme', ana.id, 'https://x/graphs/acme/mcp');
    insertToken(db, 'tok-logistica', ana.id, 'https://x/graphs/logistica/mcp');
    db.close();

    await run(dataDir, 'revoke', 'ana', 'acme');

    db = openServerDb(dataDir);
    expect(revokedOf(db, 'tok-acme')).toBe(1);
    expect(revokedOf(db, 'tok-logistica')).toBe(0); // the other graph is untouched
    expect(new SqliteUserStore(db).grants(ana.id)).toEqual(['logistica']);
    db.close();
  });
});
