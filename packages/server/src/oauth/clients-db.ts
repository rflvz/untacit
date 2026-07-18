/**
 * Persistent store for dynamically registered OAuth clients (RFC 7591,
 * docs/06 §4.1). MCP clients (Claude, Claude Code, Cursor, Inspector)
 * register themselves on first connect; the SDK's registration handler
 * generates the client_id and hands us the full record to keep.
 */

import type Database from 'better-sqlite3';

import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import { OAuthClientInformationFullSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';

export class SqliteClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly db: Database.Database) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.db
      .prepare('SELECT metadata_json FROM oauth_clients WHERE client_id = ?')
      .get(clientId) as { metadata_json: string } | undefined;
    if (!row) return undefined;
    // Validate on the way out so a hand-edited row cannot smuggle a malformed
    // client (e.g. without redirect_uris) into the authorization flow.
    const parsed = OAuthClientInformationFullSchema.safeParse(JSON.parse(row.metadata_json));
    return parsed.success ? parsed.data : undefined;
  }

  registerClient(client: OAuthClientInformationFull): OAuthClientInformationFull {
    if (!client.client_id) throw new Error('registerClient: missing client_id');
    if (!client.redirect_uris || client.redirect_uris.length === 0) {
      throw new Error('registerClient: at least one redirect_uri is required');
    }
    this.db
      .prepare(
        'INSERT OR REPLACE INTO oauth_clients (client_id, metadata_json, created_at) VALUES (?, ?, ?)',
      )
      .run(client.client_id, JSON.stringify(client), new Date().toISOString());
    return client;
  }
}
