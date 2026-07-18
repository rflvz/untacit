/**
 * @untacit/server — self-hosted MCP server over Streamable HTTP (docs/06).
 * `createHttpApp` assembles the Express app (exported for tests);
 * `startServer` binds it and kicks off the background embedding refresher.
 */

import { createServer, type Server } from 'node:http';

import type { ServerConfig } from './config.js';
import { createHttpApp, type CreateHttpAppOptions, type HttpAppDeps } from './http/app.js';

export * from './config.js';
export * from './db.js';
export * from './users/store.js';
export { SqliteUserStore } from './users/sqlite.js';
export { UntacitOAuthProvider, MCP_SCOPE } from './oauth/provider.js';
export { OpaqueTokenStore } from './oauth/tokens-opaque.js';
export { SqliteClientsStore } from './oauth/clients-db.js';
export { createHttpApp, type HttpAppDeps, type CreateHttpAppOptions } from './http/app.js';
export { McpSessionManager } from './http/mcp.js';
export { EmbeddingsRefresher } from './http/embeddings.js';

export interface RunningServer {
  server: Server;
  url: string;
  deps: HttpAppDeps;
  close(): Promise<void>;
}

export async function startServer(
  config: ServerConfig,
  opts: CreateHttpAppOptions = {},
): Promise<RunningServer> {
  const { app, deps } = createHttpApp(config, opts);
  const server = createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, config.host, resolve);
  });

  // Product priority (docs/06 §4.6): embeddings are fresh from boot — the
  // company's only maintenance job is a `git pull` cron on the graph repos.
  if (config.embeddings.refresh === 'auto') deps.refresher.scheduleAll();

  return {
    server,
    url: `http://${config.host}:${config.port}`,
    deps,
    async close() {
      await deps.close();
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}
