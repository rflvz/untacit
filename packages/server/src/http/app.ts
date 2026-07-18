/**
 * Express assembly (docs/06 §3, §6): security middleware → per-graph
 * protected-resource metadata (RFC 9728) → SDK OAuth router → login →
 * MCP endpoint with bearer auth + grants + sessions → healthz.
 */

import { accessSync, constants } from 'node:fs';

import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import type Database from 'better-sqlite3';
import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';

import { graphResourceUrl, type ServerConfig } from '../config.js';
import { openServerDb, pruneExpired } from '../db.js';
import { loginRouter } from '../oauth/login.js';
import { UntacitOAuthProvider, MCP_SCOPE } from '../oauth/provider.js';
import { OpaqueTokenStore } from '../oauth/tokens-opaque.js';
import { SqliteUserStore } from '../users/sqlite.js';
import type { UserStore } from '../users/store.js';
import { EmbeddingsRefresher } from './embeddings.js';
import { checkGraphAccess, graphIdFromResource, graphNotFound, hostGuard, originGuard, resolveGraph } from './guards.js';
import { McpSessionManager } from './mcp.js';

export interface HttpAppDeps {
  db: Database.Database;
  users: UserStore;
  tokens: OpaqueTokenStore;
  provider: UntacitOAuthProvider;
  sessions: McpSessionManager;
  refresher: EmbeddingsRefresher;
  close(): Promise<void>;
}

export interface CreateHttpAppOptions {
  log?: (message: string) => void;
  /** Override the login rate limit (tests). */
  loginRateLimit?: Parameters<typeof loginRouter>[0]['rateLimit'];
}

export function createHttpApp(
  config: ServerConfig,
  opts: CreateHttpAppOptions = {},
): { app: Express; deps: HttpAppDeps } {
  const log = opts.log ?? ((m: string) => console.log(`[untacit-server] ${m}`));

  const db = openServerDb(config.dataDir);
  const users = new SqliteUserStore(db);
  const tokens = new OpaqueTokenStore(db, config.auth);
  const provider = new UntacitOAuthProvider({
    db,
    users,
    tokens,
    graphIdFromResource: (resource) => graphIdFromResource(config, resource),
  });
  const sessions = new McpSessionManager(config, log);
  const refresher = new EmbeddingsRefresher(config.graphs, log);

  const app = express();
  app.disable('x-powered-by');
  // `true` means one hop: trusting every hop would let a client spoof
  // X-Forwarded-For past the per-IP login rate limit.
  if (config.security.trustProxy !== false) {
    app.set('trust proxy', config.security.trustProxy === true ? 1 : config.security.trustProxy);
  }

  // Liveness first — Docker healthchecks hit 127.0.0.1, not the public host.
  app.get('/healthz', (_req: Request, res: Response) => {
    const graphs = config.graphs.map((g) => {
      try {
        accessSync(g.path, constants.R_OK);
        return { id: g.id, ok: true };
      } catch {
        return { id: g.id, ok: false };
      }
    });
    let dbOk = true;
    try {
      db.prepare('SELECT 1').get();
    } catch {
      dbOk = false;
    }
    const ok = dbOk && graphs.every((g) => g.ok);
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'degraded', db: dbOk, graphs });
  });

  app.use(hostGuard(config));
  app.use(originGuard(config));

  // Per-graph RFC 9728 metadata must precede the SDK router: its root
  // oauth-protected-resource route is mounted with `use` and would swallow
  // these more specific paths.
  app.get('/.well-known/oauth-protected-resource/graphs/:graphId/mcp', (req: Request, res: Response) => {
    const graph = resolveGraph(config, req);
    if (!graph) {
      graphNotFound(res);
      return;
    }
    res.json({
      resource: graphResourceUrl(config, graph.id),
      // Must be byte-identical to the AS metadata's `issuer`, which the SDK
      // sets to `new URL(issuerUrl).href` (RFC 8414 §3.3). For a bare-origin
      // publicUrl, config.publicUrl has its trailing slash stripped (config.ts)
      // while .href re-adds it — advertise .href here so a strict client's
      // issuer comparison matches.
      authorization_servers: [new URL(config.publicUrl).href],
      scopes_supported: [MCP_SCOPE],
      resource_name: graph.name,
      bearer_methods_supported: ['header'],
    });
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(config.publicUrl),
      scopesSupported: [MCP_SCOPE],
      resourceName: 'untacit',
    }),
  );

  app.use(loginRouter({ provider, users, rateLimit: opts.loginRateLimit }));

  // Bearer middleware per graph so the 401 advertises that graph's metadata
  // URL (RFC 9728 discovery starts from WWW-Authenticate).
  const bearerByGraph = new Map<string, RequestHandler>();
  const bearerFor = (graphId: string): RequestHandler => {
    let handler = bearerByGraph.get(graphId);
    if (!handler) {
      handler = requireBearerAuth({
        verifier: provider,
        requiredScopes: [MCP_SCOPE],
        resourceMetadataUrl: `${config.publicUrl}/.well-known/oauth-protected-resource/graphs/${graphId}/mcp`,
      });
      bearerByGraph.set(graphId, handler);
    }
    return handler;
  };

  const mcpHandler = express.Router();
  mcpHandler.use(express.json({ limit: '4mb' }));
  mcpHandler.all('/graphs/:graphId/mcp', (req: Request, res: Response, next: NextFunction) => {
    const graph = resolveGraph(config, req);
    if (!graph) {
      graphNotFound(res);
      return;
    }
    bearerFor(graph.id)(req, res, (err?: unknown) => {
      if (err) {
        next(err);
        return;
      }
      const access = checkGraphAccess(config, users, req, res, graph);
      if (!access) return;
      void sessions
        .handle(req, res, graph, access.userId)
        .then(() => {
          // A POST may have triggered a staleness reindex inside a tool call
          // — bring the semantic channel up to date (docs/06 §4.6).
          if (req.method === 'POST' && config.embeddings.refresh === 'auto') {
            refresher.schedule(graph.id);
          }
        })
        .catch(next);
    });
  });
  app.use(mcpHandler);

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  // Last-resort error handler: log server-side, never leak internals.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    log(`unhandled error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    res.status(500).json({ error: 'server_error' });
  });

  // Opportunistic cleanup of expired auth rows, cheap and unref'd.
  const pruneTimer = setInterval(() => pruneExpired(db), 15 * 60_000);
  pruneTimer.unref();

  const deps: HttpAppDeps = {
    db,
    users,
    tokens,
    provider,
    sessions,
    refresher,
    async close() {
      clearInterval(pruneTimer);
      refresher.stop();
      await refresher.idle();
      await sessions.close();
      db.close();
    },
  };
  return { app, deps };
}
