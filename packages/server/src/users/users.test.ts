import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { openServerDb, pruneExpired, serverDbPath, SERVER_DB_VERSION } from '../db.js';
import { SqliteUserStore } from './sqlite.js';
import { hashPassword, verifyPassword } from './store.js';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function makeDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'untacit-server-users-'));
  tmpDirs.push(dir);
  return dir;
}

describe('password hashing', () => {
  it('round-trips and rejects wrong passwords', () => {
    const stored = hashPassword('correct horse battery staple');
    expect(stored.startsWith('scrypt$15$8$1$')).toBe(true);
    expect(verifyPassword('correct horse battery staple', stored)).toBe(true);
    expect(verifyPassword('correct horse battery stapl', stored)).toBe(false);
    expect(verifyPassword('', stored)).toBe(false);
  });

  it('produces a distinct salt per hash', () => {
    expect(hashPassword('same')).not.toBe(hashPassword('same'));
  });

  it('rejects malformed or hostile stored hashes instead of throwing', () => {
    expect(verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(verifyPassword('x', 'scrypt$99$8$1$AAAA$AAAA')).toBe(false); // absurd cost param
    expect(verifyPassword('x', 'scrypt$15$8$1$$')).toBe(false);
  });
});

describe('server db', () => {
  it('creates the schema once and stamps user_version', () => {
    const dataDir = makeDataDir();
    const db = openServerDb(dataDir);
    expect(db.pragma('user_version', { simple: true })).toBe(SERVER_DB_VERSION);
    db.close();
    // Reopen: idempotent.
    const again = openServerDb(dataDir);
    expect(again.prepare('SELECT COUNT(*) AS n FROM users').get()).toEqual({ n: 0 });
    again.close();
    expect(serverDbPath(dataDir)).toBe(join(dataDir, 'server.db'));
  });

  it('refuses a db from a newer schema version', () => {
    const dataDir = makeDataDir();
    const db = openServerDb(dataDir);
    db.pragma(`user_version = ${SERVER_DB_VERSION + 1}`);
    db.close();
    expect(() => openServerDb(dataDir)).toThrow(/upgrade untacit-server/);
  });

  it('prunes expired auth material', () => {
    const db = openServerDb(makeDataDir());
    const past = Math.floor(Date.now() / 1000) - 10;
    const future = Math.floor(Date.now() / 1000) + 1000;
    db.prepare(
      "INSERT INTO tokens (token_hash, kind, user_id, client_id, scopes, expires_at, created_at) VALUES ('a','access','u','c','mcp',?,'now')",
    ).run(past);
    db.prepare(
      "INSERT INTO tokens (token_hash, kind, user_id, client_id, scopes, expires_at, created_at) VALUES ('b','access','u','c','mcp',?,'now')",
    ).run(future);
    // pruneExpired sweeps three tables — seed the other two so all DELETEs are
    // observably covered, not run against empty tables.
    db.prepare(
      "INSERT INTO auth_requests (txn_id, client_id, params_json, csrf, expires_at) VALUES ('req-old','c','{}','x',?)",
    ).run(past);
    db.prepare(
      "INSERT INTO auth_requests (txn_id, client_id, params_json, csrf, expires_at) VALUES ('req-new','c','{}','x',?)",
    ).run(future);
    db.prepare(
      "INSERT INTO auth_codes (code_hash, user_id, client_id, code_challenge, redirect_uri, scopes, expires_at) VALUES ('code-old','u','c','ch','http://x','mcp',?)",
    ).run(past);
    db.prepare(
      "INSERT INTO auth_codes (code_hash, user_id, client_id, code_challenge, redirect_uri, scopes, expires_at) VALUES ('code-new','u','c','ch','http://x','mcp',?)",
    ).run(future);
    pruneExpired(db);
    const left = db.prepare('SELECT token_hash FROM tokens').all() as { token_hash: string }[];
    expect(left.map((r) => r.token_hash)).toEqual(['b']);
    expect(
      (db.prepare('SELECT txn_id FROM auth_requests').all() as { txn_id: string }[]).map((r) => r.txn_id),
    ).toEqual(['req-new']);
    expect(
      (db.prepare('SELECT code_hash FROM auth_codes').all() as { code_hash: string }[]).map(
        (r) => r.code_hash,
      ),
    ).toEqual(['code-new']);
    db.close();
  });
});

describe('SqliteUserStore', () => {
  it('adds, lists, disables and re-enables users', () => {
    const db = openServerDb(makeDataDir());
    const store = new SqliteUserStore(db);
    const ana = store.add('ana', 'secret-password', 'Ana Ruiz');
    expect(ana.username).toBe('ana');
    expect(store.list().map((u) => u.username)).toEqual(['ana']);

    expect(store.verifyCredentials('ana', 'secret-password')?.id).toBe(ana.id);
    expect(store.verifyCredentials('ana', 'wrong')).toBeNull();
    expect(store.verifyCredentials('nobody', 'secret-password')).toBeNull();

    store.setDisabled('ana', true);
    expect(store.verifyCredentials('ana', 'secret-password')).toBeNull();
    store.setDisabled('ana', false);
    expect(store.verifyCredentials('ana', 'secret-password')).not.toBeNull();
    db.close();
  });

  it('treats usernames as case-insensitively unique and validates the charset', () => {
    const db = openServerDb(makeDataDir());
    const store = new SqliteUserStore(db);
    store.add('Ana', 'x'.repeat(12));
    expect(() => store.add('ana', 'y'.repeat(12))).toThrow(/already exists/);
    expect(() => store.add('ana ruiz', 'z'.repeat(12))).toThrow(/Invalid username/);
    db.close();
  });

  it('changes passwords', () => {
    const db = openServerDb(makeDataDir());
    const store = new SqliteUserStore(db);
    store.add('ana', 'old-password');
    store.setPassword('ana', 'new-password');
    expect(store.verifyCredentials('ana', 'old-password')).toBeNull();
    expect(store.verifyCredentials('ana', 'new-password')).not.toBeNull();
    expect(() => store.setPassword('ghost', 'x')).toThrow(/not found/);
    db.close();
  });

  it('manages grants idempotently', () => {
    const db = openServerDb(makeDataDir());
    const store = new SqliteUserStore(db);
    const ana = store.add('ana', 'secret-password');
    store.grant(ana.id, 'acme');
    store.grant(ana.id, 'acme'); // idempotent
    store.grant(ana.id, 'logistica');
    expect(store.grants(ana.id)).toEqual(['acme', 'logistica']);
    expect(store.hasGrant(ana.id, 'acme')).toBe(true);
    store.revoke(ana.id, 'acme');
    expect(store.hasGrant(ana.id, 'acme')).toBe(false);
    expect(store.grants(ana.id)).toEqual(['logistica']);
    db.close();
  });
});
