/**
 * OAuth core tests (docs/06 §11 step 2): token issuance, PKCE, rotation and
 * revocation — exercised through the real SDK mcpAuthRouter over HTTP where
 * it matters (registration, /token exchange), plus unit coverage of the
 * opaque token store's rotation/reuse semantics.
 */

import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type Database from 'better-sqlite3';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openServerDb } from '../db.js';
import { SqliteUserStore } from '../users/sqlite.js';
import { SqliteClientsStore } from './clients-db.js';
import { UntacitOAuthProvider, MCP_SCOPE } from './provider.js';
import { OpaqueTokenStore, hashToken } from './tokens-opaque.js';

const tmpDirs: string[] = [];
const servers: Server[] = [];
afterAll(async () => {
  for (const server of servers) await new Promise((r) => server.close(r));
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function makeDb() {
  const dir = mkdtempSync(join(tmpdir(), 'untacit-server-oauth-'));
  tmpDirs.push(dir);
  return openServerDb(dir);
}

function makeStores(db: Database.Database) {
  const users = new SqliteUserStore(db);
  const tokens = new OpaqueTokenStore(db, { accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 86400 });
  const provider = new UntacitOAuthProvider({
    db,
    users,
    tokens,
    graphIdFromResource: (resource) =>
      /^https?:\/\/[^/]+\/graphs\/([a-z0-9-]+)\/mcp$/.exec(resource)?.[1],
  });
  return { users, tokens, provider };
}

function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function listen(app: express.Express): Promise<string> {
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return `http://127.0.0.1:${address.port}`;
}

describe('OpaqueTokenStore', () => {
  it('issues pairs, verifies access tokens and stores only hashes', () => {
    const db = makeDb();
    const { tokens } = makeStores(db);
    const issued = tokens.issue('u1', 'c1', [MCP_SCOPE], null);

    expect(tokens.getLive(issued.accessToken, 'access')?.user_id).toBe('u1');
    expect(tokens.getLive(issued.accessToken, 'refresh')).toBeUndefined(); // kind is enforced
    expect(tokens.getLive(issued.refreshToken, 'refresh')?.user_id).toBe('u1');

    const raw = db.prepare('SELECT token_hash FROM tokens').all() as { token_hash: string }[];
    expect(raw.map((r) => r.token_hash)).toContain(hashToken(issued.accessToken));
    expect(raw.map((r) => r.token_hash)).not.toContain(issued.accessToken);
    db.close();
  });

  it('rotates refresh tokens and kills the family on reuse of a rotated one', () => {
    const db = makeDb();
    const { tokens } = makeStores(db);
    const first = tokens.issue('u1', 'c1', [MCP_SCOPE], null);

    const second = tokens.rotateRefresh(first.refreshToken, 'c1');
    expect(second).not.toBeNull();
    expect(tokens.getLive(first.refreshToken, 'refresh')).toBeUndefined(); // rotated away

    // Reuse of the rotated token = theft signal → descendants die too.
    expect(tokens.rotateRefresh(first.refreshToken, 'c1')).toBeNull();
    expect(tokens.getLive(second!.refreshToken, 'refresh')).toBeUndefined();
    expect(tokens.getLive(second!.accessToken, 'access')).toBeUndefined();
    db.close();
  });

  it('revocation of either token of a fresh pair kills its sibling (RFC 7009)', () => {
    const db = makeDb();
    const { tokens } = makeStores(db);

    // Revoke the refresh → the access sibling must die too.
    const a = tokens.issue('u1', 'c1', [MCP_SCOPE], null);
    tokens.revoke(a.refreshToken, 'c1');
    expect(tokens.getLive(a.accessToken, 'access')).toBeUndefined();
    expect(tokens.getLive(a.refreshToken, 'refresh')).toBeUndefined();

    // Revoke the access → the refresh sibling must die too (no re-mint path).
    const b = tokens.issue('u1', 'c1', [MCP_SCOPE], null);
    tokens.revoke(b.accessToken, 'c1');
    expect(tokens.getLive(b.refreshToken, 'refresh')).toBeUndefined();
    expect(tokens.rotateRefresh(b.refreshToken, 'c1')).toBeNull();

    // A wrong-client revoke is still ignored (RFC 7009) — pair stays live.
    const c = tokens.issue('u1', 'c1', [MCP_SCOPE], null);
    tokens.revoke(c.accessToken, 'other-client');
    expect(tokens.getLive(c.accessToken, 'access')).toBeTruthy();
    db.close();
  });

  it('normal rotation keeps the current access token alive until it expires', () => {
    const db = makeDb();
    const { tokens } = makeStores(db);
    const first = tokens.issue('u1', 'c1', [MCP_SCOPE], null);
    const second = tokens.rotateRefresh(first.refreshToken, 'c1');
    // Old access is NOT revoked by rotation (OAuth: it lives out its TTL).
    expect(tokens.getLive(first.accessToken, 'access')).toBeTruthy();
    expect(tokens.getLive(second!.accessToken, 'access')).toBeTruthy();
    db.close();
  });

  it('scopes rotation to the owning client and revokes per user', () => {
    const db = makeDb();
    const { tokens } = makeStores(db);
    const issued = tokens.issue('u1', 'c1', [MCP_SCOPE], null);
    expect(tokens.rotateRefresh(issued.refreshToken, 'other-client')).toBeNull();

    tokens.revokeAllForUser('u1');
    expect(tokens.getLive(issued.accessToken, 'access')).toBeUndefined();
    db.close();
  });
});

describe('UntacitOAuthProvider.exchangeRefreshToken grant re-check', () => {
  it('rejects refresh of a resource-bound token after the graph grant is revoked', async () => {
    const db = makeDb();
    const { users, tokens, provider } = makeStores(db);
    const user = users.add('ana', 'ana-password-123');
    users.grant(user.id, 'acme');
    const resource = 'https://untacit.example.com/graphs/acme/mcp';
    const pair = tokens.issue(user.id, 'c1', [MCP_SCOPE], resource);

    users.revoke(user.id, 'acme');
    await expect(
      provider.exchangeRefreshToken({ client_id: 'c1' } as never, pair.refreshToken),
    ).rejects.toThrow(/no access to graph/);
    db.close();
  });

  it('allows refresh of a token not bound to any resource regardless of grants', async () => {
    const db = makeDb();
    const { users, tokens, provider } = makeStores(db);
    const user = users.add('ana', 'ana-password-123');
    const pair = tokens.issue(user.id, 'c1', [MCP_SCOPE], null);
    await expect(
      provider.exchangeRefreshToken({ client_id: 'c1' } as never, pair.refreshToken),
    ).resolves.toBeTruthy();
    db.close();
  });
});

describe('SqliteClientsStore', () => {
  it('round-trips registered clients and rejects malformed rows', () => {
    const db = makeDb();
    const store = new SqliteClientsStore(db);
    const client = {
      client_id: 'client-1',
      redirect_uris: ['https://client.example.com/callback'],
      token_endpoint_auth_method: 'none',
    };
    store.registerClient(client);
    expect(store.getClient('client-1')?.redirect_uris).toEqual(client.redirect_uris);
    expect(store.getClient('ghost')).toBeUndefined();

    db.prepare("UPDATE oauth_clients SET metadata_json = '{\"client_id\":\"client-1\"}'").run();
    expect(store.getClient('client-1')).toBeUndefined(); // no redirect_uris → invalid
    db.close();
  });
});

describe('OAuth flow through the SDK router', () => {
  let db: Database.Database;
  let stores: ReturnType<typeof makeStores>;
  let baseUrl: string;
  let userId: string;

  beforeAll(async () => {
    db = makeDb();
    stores = makeStores(db);
    userId = stores.users.add('ana', 'ana-password-123').id;
    stores.users.grant(userId, 'acme');

    const app = express();
    app.use(
      mcpAuthRouter({
        provider: stores.provider,
        issuerUrl: new URL('http://127.0.0.1'),
        scopesSupported: [MCP_SCOPE],
      }),
    );
    baseUrl = await listen(app);
  });

  async function registerClient(): Promise<{ client_id: string }> {
    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_name: 'test client',
        redirect_uris: ['http://127.0.0.1:33333/callback'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      }),
    });
    expect(res.status).toBe(201);
    return (await res.json()) as { client_id: string };
  }

  /** /authorize → 302 /login?txn → (login simulated) → code. */
  async function authorizeToCode(clientId: string, challenge: string, resource?: string) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:33333/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'st4te',
      scope: MCP_SCOPE,
    });
    if (resource) params.set('resource', resource);
    const res = await fetch(`${baseUrl}/authorize?${params}`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location.startsWith('/login?txn=')).toBe(true);
    const txnId = new URL(location, baseUrl).searchParams.get('txn')!;

    const txn = stores.provider.getAuthRequest(txnId)!;
    expect(txn.clientId).toBe(clientId);
    expect(txn.params.codeChallenge).toBe(challenge);
    const redirect = new URL(stores.provider.issueAuthorizationCode(txn, userId));
    expect(redirect.searchParams.get('state')).toBe('st4te');
    return redirect.searchParams.get('code')!;
  }

  it('serves RFC 8414 authorization-server metadata', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.code_challenge_methods_supported).toEqual(['S256']);
    expect(meta.registration_endpoint).toContain('/register');
  });

  it('runs authorization code + PKCE, refresh rotation and revocation end to end', async () => {
    const { client_id } = await registerClient();
    const { verifier, challenge } = pkcePair();
    const code = await authorizeToCode(client_id, challenge);

    // Wrong verifier → invalid_grant, and the code must survive (it was not consumed).
    const bad = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id,
        code,
        code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier',
      }),
    });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe('invalid_grant');

    const good = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id,
        code,
        code_verifier: verifier,
        redirect_uri: 'http://127.0.0.1:33333/callback',
      }),
    });
    expect(good.status).toBe(200);
    const tokens = (await good.json()) as {
      access_token: string;
      refresh_token: string;
      token_type: string;
      scope: string;
    };
    expect(tokens.token_type).toBe('bearer');
    expect(tokens.scope).toBe(MCP_SCOPE);

    const auth = await stores.provider.verifyAccessToken(tokens.access_token);
    expect(auth.extra).toMatchObject({ userId, username: 'ana' });

    // Single use: replaying the code fails.
    const replay = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id,
        code,
        code_verifier: verifier,
      }),
    });
    expect(replay.status).toBe(400);

    // Refresh rotation: new pair works, old refresh is dead.
    const refreshed = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id,
        refresh_token: tokens.refresh_token,
      }),
    });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
    await expect(stores.provider.verifyAccessToken(next.access_token)).resolves.toBeTruthy();

    const reuse = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id,
        refresh_token: tokens.refresh_token,
      }),
    });
    expect(reuse.status).toBe(400);
    // Reuse of a rotated refresh token revoked the whole family.
    await expect(stores.provider.verifyAccessToken(next.access_token)).rejects.toThrow();

    // RFC 7009 revocation endpoint.
    const { verifier: v2, challenge: c2 } = pkcePair();
    const code2 = await authorizeToCode(client_id, c2);
    const grant2 = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id,
        code: code2,
        code_verifier: v2,
      }),
    });
    const tokens2 = (await grant2.json()) as { access_token: string };
    const revoke = await fetch(`${baseUrl}/revoke`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id, token: tokens2.access_token }),
    });
    expect(revoke.status).toBe(200);
    await expect(stores.provider.verifyAccessToken(tokens2.access_token)).rejects.toThrow();
  });

  it('enforces graph grants at code issuance when the request is resource-bound', async () => {
    const { client_id } = await registerClient();
    const { challenge } = pkcePair();
    // acme is granted → works.
    await authorizeToCode(client_id, challenge, 'https://untacit.example.com/graphs/acme/mcp');
    // logistica is not → AccessDenied at login time.
    const params = new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: 'http://127.0.0.1:33333/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      resource: 'https://untacit.example.com/graphs/logistica/mcp',
    });
    const res = await fetch(`${baseUrl}/authorize?${params}`, { redirect: 'manual' });
    const txnId = new URL(res.headers.get('location')!, baseUrl).searchParams.get('txn')!;
    const txn = stores.provider.getAuthRequest(txnId)!;
    expect(() => stores.provider.issueAuthorizationCode(txn, userId)).toThrow(/no access to graph/);
  });

  it('rejects scopes other than mcp', async () => {
    const { client_id } = await registerClient();
    const { challenge } = pkcePair();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: 'http://127.0.0.1:33333/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'admin',
      state: 'x',
    });
    const res = await fetch(`${baseUrl}/authorize?${params}`, { redirect: 'manual' });
    // Post-redirect error: sent back to the client's redirect_uri.
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(location.searchParams.get('error')).toBe('invalid_scope');
  });

  it('expires pending login transactions', async () => {
    const { client_id } = await registerClient();
    const { challenge } = pkcePair();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id,
      redirect_uri: 'http://127.0.0.1:33333/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const res = await fetch(`${baseUrl}/authorize?${params}`, { redirect: 'manual' });
    const txnId = new URL(res.headers.get('location')!, baseUrl).searchParams.get('txn')!;
    db.prepare('UPDATE auth_requests SET expires_at = 1 WHERE txn_id = ?').run(txnId);
    expect(stores.provider.getAuthRequest(txnId)).toBeUndefined();
  });
});
