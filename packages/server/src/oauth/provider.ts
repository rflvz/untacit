/**
 * OAuth 2.1 provider for the MCP authorization spec (docs/06 §4.2),
 * composed from the SQLite-backed pieces: UserStore (credentials + grants),
 * SqliteClientsStore (RFC 7591 dynamic registration) and OpaqueTokenStore.
 *
 * The SDK's mcpAuthRouter owns the protocol surface (/authorize, /token,
 * /register, /revoke, metadata) and PKCE S256 validation; this provider owns
 * the state: pending login transactions, single-use authorization codes and
 * token lifecycle. `authorize()` never sees credentials — it parks the
 * request and redirects to our /login page (step 3 of docs/06 §11).
 */

import { createHash, randomBytes } from 'node:crypto';

import type Database from 'better-sqlite3';
import type { Response } from 'express';

import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import {
  AccessDeniedError,
  InvalidGrantError,
  InvalidScopeError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';

import type { UserStore } from '../users/store.js';
import { SqliteClientsStore } from './clients-db.js';
import { OpaqueTokenStore, type IssuedTokens } from './tokens-opaque.js';

/** The only scope in v1 (docs/06 §4.2). */
export const MCP_SCOPE = 'mcp';

const AUTH_REQUEST_TTL_SECONDS = 600; // pending login transaction (docs/06 §4.1)
const AUTH_CODE_TTL_SECONDS = 600;

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex');
}

interface AuthRequestParams {
  state?: string;
  scopes: string[];
  codeChallenge: string;
  redirectUri: string;
  resource?: string;
}

export interface AuthRequest {
  txnId: string;
  clientId: string;
  csrf: string;
  params: AuthRequestParams;
  expiresAt: number;
}

interface AuthCodeRow {
  code_hash: string;
  user_id: string;
  client_id: string;
  code_challenge: string;
  redirect_uri: string;
  resource: string | null;
  scopes: string;
  expires_at: number;
  used: number;
}

export interface ProviderOptions {
  db: Database.Database;
  users: UserStore;
  tokens: OpaqueTokenStore;
  /**
   * Maps an RFC 8707 resource URL to a graph id when it is one of ours, so
   * grants can be enforced at code-issuance time (fail at login, not at the
   * first tool call).
   */
  graphIdFromResource?: (resource: string) => string | undefined;
}

export class UntacitOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: SqliteClientsStore;
  private readonly db: Database.Database;
  private readonly users: UserStore;
  private readonly tokens: OpaqueTokenStore;
  private readonly graphIdFromResource: (resource: string) => string | undefined;

  constructor(opts: ProviderOptions) {
    this.db = opts.db;
    this.users = opts.users;
    this.tokens = opts.tokens;
    this.clientsStore = new SqliteClientsStore(opts.db);
    this.graphIdFromResource = opts.graphIdFromResource ?? (() => undefined);
  }

  // -------------------------------------------------------------------------
  // Authorization endpoint: park the request, send the browser to /login
  // -------------------------------------------------------------------------

  async authorize(
    client: OAuthClientInformationFull,
    params: AuthorizationParams,
    res: Response,
  ): Promise<void> {
    const requested = params.scopes ?? [];
    if (requested.some((s) => s !== MCP_SCOPE)) {
      throw new InvalidScopeError(`only the "${MCP_SCOPE}" scope is supported`);
    }
    const txnId = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    const stored: AuthRequestParams = {
      state: params.state,
      scopes: [MCP_SCOPE],
      codeChallenge: params.codeChallenge,
      redirectUri: params.redirectUri,
      resource: params.resource?.href,
    };
    this.db
      .prepare(
        'INSERT INTO auth_requests (txn_id, client_id, params_json, csrf, expires_at) VALUES (?, ?, ?, ?, ?)',
      )
      .run(txnId, client.client_id, JSON.stringify(stored), csrf, now() + AUTH_REQUEST_TTL_SECONDS);
    // Relative redirect: same origin as the /authorize request, proxy-safe.
    res.redirect(302, `/login?txn=${encodeURIComponent(txnId)}`);
  }

  /** Pending login transaction, or undefined when unknown/expired. */
  getAuthRequest(txnId: string): AuthRequest | undefined {
    const row = this.db.prepare('SELECT * FROM auth_requests WHERE txn_id = ?').get(txnId) as
      | { txn_id: string; client_id: string; params_json: string; csrf: string; expires_at: number }
      | undefined;
    if (!row || row.expires_at <= now()) return undefined;
    return {
      txnId: row.txn_id,
      clientId: row.client_id,
      csrf: row.csrf,
      params: JSON.parse(row.params_json) as AuthRequestParams,
      expiresAt: row.expires_at,
    };
  }

  /**
   * Successful login: consume the transaction, mint a single-use code and
   * return the client redirect URL (code + state). Enforces the graph grant
   * when the request is bound to one of our graphs via RFC 8707 `resource`.
   */
  issueAuthorizationCode(txn: AuthRequest, userId: string): string {
    const user = this.users.getById(userId);
    if (!user || user.disabled) throw new AccessDeniedError('user is not active');
    if (txn.params.resource) {
      const graphId = this.graphIdFromResource(txn.params.resource);
      if (graphId !== undefined && !this.users.hasGrant(userId, graphId)) {
        throw new AccessDeniedError(`user has no access to graph "${graphId}"`);
      }
    }

    const code = randomBytes(32).toString('base64url');
    const consumed = this.db.prepare('DELETE FROM auth_requests WHERE txn_id = ?').run(txn.txnId);
    if (consumed.changes === 0) throw new AccessDeniedError('login transaction already used');
    this.db
      .prepare(
        `INSERT INTO auth_codes (code_hash, user_id, client_id, code_challenge, redirect_uri, resource, scopes, expires_at, used)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
      )
      .run(
        hashCode(code),
        userId,
        txn.clientId,
        txn.params.codeChallenge,
        txn.params.redirectUri,
        txn.params.resource ?? null,
        txn.params.scopes.join(' '),
        now() + AUTH_CODE_TTL_SECONDS,
      );

    const redirect = new URL(txn.params.redirectUri);
    redirect.searchParams.set('code', code);
    if (txn.params.state !== undefined) redirect.searchParams.set('state', txn.params.state);
    return redirect.href;
  }

  // -------------------------------------------------------------------------
  // Token endpoint
  // -------------------------------------------------------------------------

  private liveCode(client: OAuthClientInformationFull, code: string): AuthCodeRow {
    const row = this.db.prepare('SELECT * FROM auth_codes WHERE code_hash = ?').get(hashCode(code)) as
      | AuthCodeRow
      | undefined;
    if (!row || row.used !== 0 || row.expires_at <= now() || row.client_id !== client.client_id) {
      throw new InvalidGrantError('invalid or expired authorization code');
    }
    return row;
  }

  async challengeForAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
  ): Promise<string> {
    return this.liveCode(client, authorizationCode).code_challenge;
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string,
    resource?: URL,
  ): Promise<OAuthTokens> {
    const row = this.liveCode(client, authorizationCode);
    // Single use, race-safe: whoever flips `used` first wins.
    const used = this.db
      .prepare('UPDATE auth_codes SET used = 1 WHERE code_hash = ? AND used = 0')
      .run(row.code_hash);
    if (used.changes === 0) throw new InvalidGrantError('authorization code already used');

    if (redirectUri !== undefined && redirectUri !== row.redirect_uri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    if (resource !== undefined && row.resource !== null && resource.href !== row.resource) {
      throw new InvalidGrantError('resource does not match the authorization request');
    }
    const boundResource = row.resource ?? resource?.href ?? null;

    const user = this.users.getById(row.user_id);
    if (!user || user.disabled) throw new InvalidGrantError('user is not active');

    return toOAuthTokens(
      this.tokens.issue(row.user_id, row.client_id, row.scopes.split(' ').filter(Boolean), boundResource),
    );
  }

  async exchangeRefreshToken(
    client: OAuthClientInformationFull,
    refreshToken: string,
    scopes?: string[],
    resource?: URL,
  ): Promise<OAuthTokens> {
    if (scopes !== undefined && scopes.some((s) => s !== MCP_SCOPE)) {
      throw new InvalidScopeError(`only the "${MCP_SCOPE}" scope is supported`);
    }
    const current = this.tokens.getLive(refreshToken, 'refresh');
    if (current) {
      if (resource !== undefined && current.resource !== null && resource.href !== current.resource) {
        throw new InvalidGrantError('resource does not match the refresh token');
      }
      const user = this.users.getById(current.user_id);
      if (!user || user.disabled) throw new InvalidGrantError('user is not active');
      if (current.resource !== null) {
        const graphId = this.graphIdFromResource(current.resource);
        if (graphId !== undefined && !this.users.hasGrant(user.id, graphId)) {
          throw new InvalidGrantError(`user has no access to graph "${graphId}"`);
        }
      }
    }
    const rotated = this.tokens.rotateRefresh(refreshToken, client.client_id);
    if (!rotated) throw new InvalidGrantError('invalid or expired refresh token');
    return toOAuthTokens(rotated);
  }

  // -------------------------------------------------------------------------
  // Resource-server side
  // -------------------------------------------------------------------------

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = this.tokens.getLive(token, 'access');
    if (!row) throw new InvalidTokenError('invalid or expired access token');
    const user = this.users.getById(row.user_id);
    if (!user || user.disabled) throw new InvalidTokenError('user is not active');
    return {
      token,
      clientId: row.client_id,
      scopes: row.scopes.split(' ').filter(Boolean),
      expiresAt: row.expires_at,
      resource: row.resource !== null ? new URL(row.resource) : undefined,
      extra: { userId: user.id, username: user.username },
    };
  }

  async revokeToken(
    client: OAuthClientInformationFull,
    request: OAuthTokenRevocationRequest,
  ): Promise<void> {
    // Per RFC 7009 unknown/foreign tokens are ignored silently.
    this.tokens.revoke(request.token, client.client_id);
  }
}

function toOAuthTokens(issued: IssuedTokens): OAuthTokens {
  return {
    access_token: issued.accessToken,
    token_type: 'bearer',
    expires_in: issued.expiresIn,
    refresh_token: issued.refreshToken,
    scope: issued.scopes.join(' '),
  };
}
