/**
 * Full OAuth flow over pure HTTP including the login form (docs/06 §11
 * step 3): /register → /authorize → GET /login (form + CSRF) → POST /login
 * → code → /token. Plus the abuse paths: wrong credentials (no enumeration),
 * CSRF mismatch, expired transaction, missing grant and rate limiting.
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
import { loginRouter } from './login.js';
import { UntacitOAuthProvider, MCP_SCOPE } from './provider.js';
import { OpaqueTokenStore } from './tokens-opaque.js';

const tmpDirs: string[] = [];
const dbs: Database.Database[] = [];
const servers: Server[] = [];
afterAll(async () => {
  for (const server of servers) await new Promise((r) => server.close(r));
  // Close every db before removing its dir: an open better-sqlite3 handle
  // holds a WAL lock that blocks recursive removal on Windows (unlink of an
  // open file only works on POSIX). maxRetries covers any residual AV lag.
  for (const db of dbs) db.close();
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

interface Harness {
  baseUrl: string;
  users: SqliteUserStore;
  provider: UntacitOAuthProvider;
}

async function makeHarness(loginRateLimit: false | { limit: number } = false): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'untacit-server-login-'));
  tmpDirs.push(dir);
  const db = openServerDb(dir);
  dbs.push(db);
  const users = new SqliteUserStore(db);
  const tokens = new OpaqueTokenStore(db, { accessTokenTtlSeconds: 3600, refreshTokenTtlSeconds: 86400 });
  const provider = new UntacitOAuthProvider({
    db,
    users,
    tokens,
    graphIdFromResource: (resource) =>
      /^https?:\/\/[^/]+\/graphs\/([a-z0-9-]+)\/mcp$/.exec(resource)?.[1],
  });

  const app = express();
  app.use(mcpAuthRouter({ provider, issuerUrl: new URL('http://127.0.0.1'), scopesSupported: [MCP_SCOPE] }));
  app.use(
    loginRouter({
      provider,
      users,
      rateLimit: loginRateLimit === false ? false : { windowMs: 60_000, limit: loginRateLimit.limit },
    }),
  );

  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return { baseUrl: `http://127.0.0.1:${address.port}`, users, provider };
}

async function registerClient(baseUrl: string): Promise<string> {
  const res = await fetch(`${baseUrl}/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Claude Code',
      redirect_uris: ['http://127.0.0.1:44444/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    }),
  });
  return ((await res.json()) as { client_id: string }).client_id;
}

function pkcePair() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** /authorize → follow the redirect to GET /login → scrape txn + csrf. */
async function openLoginForm(baseUrl: string, clientId: string, challenge: string, resource?: string) {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: 'http://127.0.0.1:44444/callback',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'client-state',
  });
  if (resource) params.set('resource', resource);
  const authorize = await fetch(`${baseUrl}/authorize?${params}`, { redirect: 'manual' });
  expect(authorize.status).toBe(302);
  const loginUrl = new URL(authorize.headers.get('location')!, baseUrl);

  const form = await fetch(loginUrl);
  expect(form.status).toBe(200);
  const html = await form.text();
  const txn = /name="txn" value="([^"]+)"/.exec(html)?.[1];
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  expect(txn).toBeTruthy();
  expect(csrf).toBeTruthy();
  return { txn: txn!, csrf: csrf!, html };
}

async function postLogin(
  baseUrl: string,
  fields: Record<string, string>,
): Promise<globalThis.Response> {
  return fetch(`${baseUrl}/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields),
    redirect: 'manual',
  });
}

describe('login flow', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await makeHarness();
    const ana = h.users.add('ana', 'ana-password-123', 'Ana Ruiz');
    h.users.grant(ana.id, 'acme');
    const disabled = h.users.add('bob', 'bob-password-123');
    h.users.setDisabled('bob', true);
  });

  it('completes the whole browser flow: authorize → login form → code → tokens', async () => {
    const clientId = await registerClient(h.baseUrl);
    const { verifier, challenge } = pkcePair();
    const { txn, csrf, html } = await openLoginForm(h.baseUrl, clientId, challenge);
    expect(html).toContain('Claude Code'); // the client_name shows up on the page

    const success = await postLogin(h.baseUrl, {
      txn,
      csrf,
      username: 'ana',
      password: 'ana-password-123',
    });
    expect(success.status).toBe(302);
    const redirect = new URL(success.headers.get('location')!);
    expect(redirect.origin + redirect.pathname).toBe('http://127.0.0.1:44444/callback');
    expect(redirect.searchParams.get('state')).toBe('client-state');
    const code = redirect.searchParams.get('code')!;

    const tokenRes = await fetch(`${h.baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: clientId,
        code,
        code_verifier: verifier,
      }),
    });
    expect(tokenRes.status).toBe(200);
    const tokens = (await tokenRes.json()) as { access_token: string };
    const auth = await h.provider.verifyAccessToken(tokens.access_token);
    expect(auth.extra?.username).toBe('ana');

    // The transaction was consumed: the form is gone.
    const replay = await postLogin(h.baseUrl, { txn, csrf, username: 'ana', password: 'ana-password-123' });
    expect(replay.status).toBe(400);
  });

  it('shows one generic error for wrong password, unknown user and disabled user', async () => {
    const clientId = await registerClient(h.baseUrl);
    const { challenge } = pkcePair();
    const { txn, csrf } = await openLoginForm(h.baseUrl, clientId, challenge);

    for (const creds of [
      { username: 'ana', password: 'wrong' },
      { username: 'ghost', password: 'whatever-pass' },
      { username: 'bob', password: 'bob-password-123' },
    ]) {
      const res = await postLogin(h.baseUrl, { txn, csrf, ...creds });
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain('Wrong username or password.');
      expect(html).toContain('name="txn"'); // form re-rendered, txn still usable
    }
  });

  it('rejects a POST with a wrong CSRF token without leaking the form', async () => {
    const clientId = await registerClient(h.baseUrl);
    const { challenge } = pkcePair();
    const { txn } = await openLoginForm(h.baseUrl, clientId, challenge);
    const res = await postLogin(h.baseUrl, {
      txn,
      csrf: 'forged',
      username: 'ana',
      password: 'ana-password-123',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('Cross-site request rejected');
  });

  it('rejects unknown or expired transactions on GET and POST', async () => {
    const get = await fetch(`${h.baseUrl}/login?txn=nonsense`);
    expect(get.status).toBe(400);
    expect(await get.text()).toContain('expired');
    const post = await postLogin(h.baseUrl, { txn: 'nonsense', csrf: 'x', username: 'a', password: 'b' });
    expect(post.status).toBe(400);
  });

  it('refuses login for a user without a grant on the resource-bound graph', async () => {
    const clientId = await registerClient(h.baseUrl);
    const { challenge } = pkcePair();
    const { txn, csrf } = await openLoginForm(
      h.baseUrl,
      clientId,
      challenge,
      'https://untacit.example.com/graphs/logistica/mcp',
    );
    const res = await postLogin(h.baseUrl, { txn, csrf, username: 'ana', password: 'ana-password-123' });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('no access');
  });

  it('sets no-store, CSP and no-referrer headers on the login page', async () => {
    const clientId = await registerClient(h.baseUrl);
    const { challenge } = pkcePair();
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'http://127.0.0.1:44444/callback',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });
    const authorize = await fetch(`${h.baseUrl}/authorize?${params}`, { redirect: 'manual' });
    const res = await fetch(new URL(authorize.headers.get('location')!, h.baseUrl));
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'");
    expect(res.headers.get('x-frame-options')).toBe('DENY');
  });
});

describe('login rate limiting', () => {
  it('throttles brute-force attempts per IP', async () => {
    const h = await makeHarness({ limit: 3 });
    const ana = h.users.add('ana', 'ana-password-123');
    h.users.grant(ana.id, 'acme');
    const clientId = await registerClient(h.baseUrl);
    const { challenge } = pkcePair();
    const { txn, csrf } = await openLoginForm(h.baseUrl, clientId, challenge);

    for (let i = 0; i < 3; i++) {
      const res = await postLogin(h.baseUrl, { txn, csrf, username: 'ana', password: `wrong-${i}` });
      expect(res.status).toBe(200);
    }
    const blocked = await postLogin(h.baseUrl, { txn, csrf, username: 'ana', password: 'ana-password-123' });
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toContain('Too many sign-in attempts');
  });
});
