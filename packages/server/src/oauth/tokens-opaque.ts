/**
 * Opaque tokens for the stateful (Docker) deployment (docs/06 §4.1, §4.6):
 * 32 random bytes base64url on the wire, only their SHA-256 in server.db, so
 * a database leak leaks nothing usable. Revocation is immediate (row flag),
 * refresh tokens rotate (the previous one is invalidated and remembered via
 * parent_hash so reuse of a rotated token kills the whole family).
 */

import { createHash, randomBytes } from 'node:crypto';

import type Database from 'better-sqlite3';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function newToken(): string {
  return randomBytes(32).toString('base64url');
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

export interface IssuedTokens {
  accessToken: string;
  refreshToken: string;
  /** Access-token TTL in seconds (for expires_in). */
  expiresIn: number;
  scopes: string[];
  resource: string | null;
}

export interface TokenRow {
  token_hash: string;
  kind: 'access' | 'refresh';
  user_id: string;
  client_id: string;
  scopes: string;
  resource: string | null;
  expires_at: number;
  revoked: number;
  parent_hash: string | null;
  created_at: string;
}

export interface TokenTtls {
  accessTokenTtlSeconds: number;
  refreshTokenTtlSeconds: number;
}

export class OpaqueTokenStore {
  constructor(
    private readonly db: Database.Database,
    private readonly ttls: TokenTtls,
  ) {}

  /** Issue a fresh access+refresh pair for a user/client. */
  issue(
    userId: string,
    clientId: string,
    scopes: string[],
    resource: string | null,
    parentHash: string | null = null,
  ): IssuedTokens {
    const accessToken = newToken();
    const refreshToken = newToken();
    const createdAt = new Date().toISOString();
    const insert = this.db.prepare(
      `INSERT INTO tokens (token_hash, kind, user_id, client_id, scopes, resource, expires_at, revoked, parent_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
    );
    const scopeText = scopes.join(' ');
    const refreshHash = hashToken(refreshToken);
    const tx = this.db.transaction(() => {
      // The access token is a CHILD of its own pair's refresh token so both
      // die together: revokeFamily(refresh) reaches the access sibling, and
      // revoke(access) walks up to the refresh (see revoke()). Without this,
      // RFC 7009 revocation of one leaves the other live.
      insert.run(
        hashToken(accessToken),
        'access',
        userId,
        clientId,
        scopeText,
        resource,
        now() + this.ttls.accessTokenTtlSeconds,
        refreshHash,
        createdAt,
      );
      // The refresh keeps the rotation-chain parent (previous refresh, or null).
      insert.run(
        refreshHash,
        'refresh',
        userId,
        clientId,
        scopeText,
        resource,
        now() + this.ttls.refreshTokenTtlSeconds,
        parentHash,
        createdAt,
      );
    });
    tx();
    return {
      accessToken,
      refreshToken,
      expiresIn: this.ttls.accessTokenTtlSeconds,
      scopes,
      resource,
    };
  }

  private getRow(token: string): TokenRow | undefined {
    return this.db.prepare('SELECT * FROM tokens WHERE token_hash = ?').get(hashToken(token)) as
      | TokenRow
      | undefined;
  }

  /** Live (unexpired, unrevoked) row of the given kind, or undefined. */
  getLive(token: string, kind: 'access' | 'refresh'): TokenRow | undefined {
    const row = this.getRow(token);
    if (!row || row.kind !== kind || row.revoked !== 0 || row.expires_at <= now()) return undefined;
    return row;
  }

  /**
   * Rotate a refresh token: revoke it and issue a new pair. Presenting an
   * already-rotated (revoked) refresh token is treated as theft — the whole
   * descendant family is revoked before returning null.
   */
  rotateRefresh(refreshToken: string, clientId: string): IssuedTokens | null {
    const row = this.getRow(refreshToken);
    if (!row || row.kind !== 'refresh' || row.client_id !== clientId || row.expires_at <= now()) {
      return null;
    }
    if (row.revoked !== 0) {
      this.revokeFamily(row.token_hash);
      return null;
    }
    let issued: IssuedTokens | null = null;
    const tx = this.db.transaction(() => {
      const updated = this.db
        .prepare('UPDATE tokens SET revoked = 1 WHERE token_hash = ? AND revoked = 0')
        .run(row.token_hash);
      if (updated.changes === 0) return; // lost a race — treat as reuse
      issued = this.issue(
        row.user_id,
        row.client_id,
        row.scopes.split(' ').filter(Boolean),
        row.resource,
        row.token_hash,
      );
    });
    tx();
    return issued;
  }

  /** Revoke every token descending from (and including) the given hash. */
  private revokeFamily(rootHash: string): void {
    const queue = [rootHash];
    const revoke = this.db.prepare('UPDATE tokens SET revoked = 1 WHERE token_hash = ?');
    const children = this.db.prepare('SELECT token_hash FROM tokens WHERE parent_hash = ?');
    while (queue.length > 0) {
      const hash = queue.pop()!;
      revoke.run(hash);
      for (const child of children.all(hash) as { token_hash: string }[]) {
        queue.push(child.token_hash);
      }
    }
  }

  /** RFC 7009 revocation: silently ignores unknown tokens (per spec). */
  revoke(token: string, clientId?: string): void {
    const row = this.getRow(token);
    if (!row) return;
    if (clientId !== undefined && row.client_id !== clientId) return;
    // Revoking either token of a pair must kill both: an access token is a
    // child of its refresh, so walk up to the refresh root before sweeping
    // the family — otherwise the sibling survives (RFC 7009 requires both).
    const root = row.kind === 'access' && row.parent_hash !== null ? row.parent_hash : row.token_hash;
    this.revokeFamily(root);
  }

  revokeAllForUser(userId: string): void {
    this.db.prepare('UPDATE tokens SET revoked = 1 WHERE user_id = ?').run(userId);
  }
}
