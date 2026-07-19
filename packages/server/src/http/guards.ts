/**
 * Request guards (docs/06 §5, §6): Host/Origin validation in our own
 * middleware (the transport's DNS-rebinding options are deprecated in SDK
 * 1.29), graph resolution, per-request grant checks and RFC 8707 resource
 * binding. Error statuses are deliberately uniform: 401 token, 403 grant,
 * 404 unknown graph or foreign session — without leaking what exists.
 */

import type { NextFunction, Request, RequestHandler, Response } from 'express';

import type { GraphEntry, ServerConfig } from '../config.js';
import { graphResourceUrl } from '../config.js';
import type { UserStore } from '../users/store.js';

/**
 * Anti DNS-rebinding: the Host header must be the public host or an explicit
 * ally. /healthz is mounted before this guard (Docker healthchecks hit
 * 127.0.0.1 directly).
 */
export function hostGuard(config: ServerConfig): RequestHandler {
  const allowed = new Set<string>(
    [new URL(config.publicUrl).host, ...config.security.allowedHosts].map((h) => h.toLowerCase()),
  );
  return (req: Request, res: Response, next: NextFunction) => {
    const host = req.headers.host?.toLowerCase();
    if (host === undefined || !allowed.has(host)) {
      res.status(421).json({
        error: 'misdirected_request',
        error_description: 'Host header does not match this server (security.allowedHosts)',
      });
      return;
    }
    next();
  };
}

/**
 * Browsers set Origin; MCP clients are not browsers, so by default any
 * cross-origin browser call is refused. Allowlist MCP Inspector & co. via
 * security.allowedOrigins.
 */
export function originGuard(config: ServerConfig): RequestHandler {
  const allowed = new Set<string>([
    new URL(config.publicUrl).origin,
    ...config.security.allowedOrigins.map((o) => new URL(o).origin),
  ]);
  return (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    // An opaque origin serializes to the literal "null" (sandboxed iframes,
    // data:/file: docs, some cross-site redirects) — it is a present Origin
    // and must face the allowlist like any other, not be waved through.
    if (origin !== undefined && !allowed.has(origin)) {
      res.status(403).json({
        error: 'forbidden_origin',
        error_description: 'Origin not allowed (security.allowedOrigins)',
      });
      return;
    }
    next();
  };
}

export function graphNotFound(res: Response): void {
  res.status(404).json({ error: 'not_found', error_description: 'Unknown graph' });
}

/** Resolve :graphId or 404 — same body for unknown ids of any shape. */
export function resolveGraph(config: ServerConfig, req: Request): GraphEntry | undefined {
  const graphId = req.params.graphId;
  return config.graphs.find((g) => g.id === graphId);
}

/**
 * Post-bearer checks (docs/06 §5): the grant is evaluated on every request —
 * revoking cuts access immediately even while tokens are live — and a token
 * bound to a resource (RFC 8707) only works against that exact graph URL.
 * `canWrite` is the effective write capability of THIS request: the graph
 * must be write-enabled in the config AND the user must hold a write grant.
 */
export function checkGraphAccess(
  config: ServerConfig,
  users: UserStore,
  req: Request,
  res: Response,
  graph: GraphEntry,
): { userId: string; canWrite: boolean } | undefined {
  const auth = req.auth;
  const userId = typeof auth?.extra?.userId === 'string' ? auth.extra.userId : undefined;
  if (auth === undefined || userId === undefined) {
    res.status(401).json({ error: 'invalid_token', error_description: 'Missing authentication' });
    return undefined;
  }
  if (!users.hasGrant(userId, graph.id)) {
    res.status(403).json({
      error: 'access_denied',
      error_description: `No access to graph "${graph.id}" — ask your administrator for a grant`,
    });
    return undefined;
  }
  if (auth.resource !== undefined && auth.resource.href !== graphResourceUrl(config, graph.id)) {
    res.status(403).json({
      error: 'invalid_resource',
      error_description: 'Token is bound to a different resource (RFC 8707)',
    });
    return undefined;
  }
  return { userId, canWrite: graph.write && users.hasWriteGrant(userId, graph.id) };
}

/** Strict parser for the RFC 8707 resources we issue: publicUrl + /graphs/<id>/mcp. */
export function graphIdFromResource(config: Pick<ServerConfig, 'publicUrl'>, resource: string): string | undefined {
  const prefix = `${config.publicUrl}/graphs/`;
  if (!resource.startsWith(prefix) || !resource.endsWith('/mcp')) return undefined;
  const id = resource.slice(prefix.length, -'/mcp'.length);
  return /^[a-z0-9-]{1,64}$/.test(id) ? id : undefined;
}
