/**
 * Local user accounts (docs/06 §4.1): passwords hashed with node:crypto
 * scrypt (N=2^15, r=8, p=1, 16-byte salt, 32-byte key) and compared with
 * timingSafeEqual. The stored string embeds its own parameters so they can
 * be raised later without breaking existing hashes:
 *
 *   scrypt$<logN>$<r>$<p>$<salt b64url>$<hash b64url>
 */

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const LOG_N = 15;
const R = 8;
const P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 32;

export function hashPassword(password: string): string {
  if (password.length === 0) throw new Error('password must not be empty');
  const salt = randomBytes(SALT_BYTES);
  // 128*N*r bytes ≈ 34 MB at these parameters — above scrypt's 32 MB default.
  const hash = scryptSync(password, salt, KEY_BYTES, {
    N: 2 ** LOG_N,
    r: R,
    p: P,
    maxmem: 256 * 1024 * 1024,
  });
  return ['scrypt', LOG_N, R, P, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const logN = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![logN, r, p].every((n) => Number.isInteger(n) && n > 0) || logN > 20) return false;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const expected = Buffer.from(parts[5]!, 'base64url');
  if (salt.length === 0 || expected.length === 0) return false;
  const actual = scryptSync(password, salt, expected.length, {
    N: 2 ** logN,
    r,
    p,
    maxmem: 256 * 1024 * 1024,
  });
  return timingSafeEqual(actual, expected);
}

/**
 * Hash to verify against when the username does not exist, so the login
 * path costs the same for unknown users (no account enumeration by timing).
 */
export const DUMMY_PASSWORD_HASH = hashPassword('untacit-dummy-password');

export interface UserRecord {
  id: string;
  username: string;
  displayName: string | null;
  disabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface UserStore {
  add(username: string, password: string, displayName?: string): UserRecord;
  getByUsername(username: string): UserRecord | undefined;
  getById(id: string): UserRecord | undefined;
  list(): UserRecord[];
  setDisabled(username: string, disabled: boolean): void;
  setPassword(username: string, password: string): void;
  /** Timing-safe credential check; null for unknown, disabled or wrong password. */
  verifyCredentials(username: string, password: string): UserRecord | null;

  /**
   * Grant access to a graph. `write: true` also allows graph writes (the MCP
   * write surface on write-enabled graphs); granting again always sets the
   * level explicitly, so a plain re-grant downgrades a write grant to read.
   */
  grant(userId: string, graphId: string, opts?: { write?: boolean }): void;
  revoke(userId: string, graphId: string): void;
  grants(userId: string): string[];
  hasGrant(userId: string, graphId: string): boolean;
  /** Graph ids where the user may write (subset of grants()). */
  writeGrants(userId: string): string[];
  hasWriteGrant(userId: string, graphId: string): boolean;
}
