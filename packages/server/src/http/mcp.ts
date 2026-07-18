/**
 * Streamable HTTP sessions over the existing MCP server (docs/06 §4.3).
 * Stateful mode: `initialize` creates a transport + McpServer pair bound to
 * (user, graph); subsequent POST/GET/DELETE with `mcp-session-id` are routed
 * to it. A session presented by another user or against another graph is a
 * 404 — indistinguishable from "no such session" (anti-fixation/hijack).
 */

import { randomUUID } from 'node:crypto';

import { createServer as createMcpServer } from '@untacit/mcp';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import type { Request, Response } from 'express';

import type { GraphEntry, ServerConfig } from '../config.js';

interface SessionEntry {
  sessionId: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  userId: string;
  graphId: string;
  lastSeenMs: number;
}

function rpcError(res: Response, status: number, code: number, message: string): void {
  res.status(status).json({ jsonrpc: '2.0', error: { code, message }, id: null });
}

export class McpSessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly sweeper: NodeJS.Timeout;
  private readonly idleTimeoutMs: number;
  private readonly maxSessionsPerUser: number;
  private closed = false;

  constructor(
    private readonly config: ServerConfig,
    private readonly log: (message: string) => void = () => {},
  ) {
    this.idleTimeoutMs = config.session.idleTimeoutMinutes * 60_000;
    this.maxSessionsPerUser = config.session.maxSessionsPerUser;
    this.sweeper = setInterval(() => this.evictIdle(Date.now()), 60_000);
    this.sweeper.unref();
  }

  get size(): number {
    return this.sessions.size;
  }

  /** Route one authenticated HTTP request to its session (or create one). */
  async handle(req: Request, res: Response, graph: GraphEntry, userId: string): Promise<void> {
    const sessionId = req.headers['mcp-session-id'];
    if (typeof sessionId === 'string') {
      const entry = this.sessions.get(sessionId);
      // Foreign user or foreign graph → same 404 as unknown session.
      if (!entry || entry.userId !== userId || entry.graphId !== graph.id) {
        rpcError(res, 404, -32001, 'Session not found');
        return;
      }
      entry.lastSeenMs = Date.now();
      await entry.transport.handleRequest(req, res, req.body);
      return;
    }

    if (req.method !== 'POST' || !isInitializeRequest(req.body)) {
      rpcError(res, 400, -32000, 'Bad request: send an initialize request or an mcp-session-id header');
      return;
    }
    // Mirror the transport's own Accept check BEFORE evicting anything: the
    // SDK returns 406 without ever initializing the session, so a malformed
    // initialize must not cost this user their least-recently-used session.
    const accept = String(req.headers.accept ?? '');
    if (!accept.includes('application/json') || !accept.includes('text/event-stream')) {
      rpcError(res, 406, -32000, 'Not Acceptable: accept both application/json and text/event-stream');
      return;
    }

    // Per-user cap: evict this user's least-recently-used session first.
    while (this.countFor(userId) >= this.maxSessionsPerUser) {
      const oldest = [...this.sessions.values()]
        .filter((e) => e.userId === userId)
        .sort((a, b) => a.lastSeenMs - b.lastSeenMs)[0];
      if (!oldest) break;
      await this.destroy(oldest, 'session cap');
    }

    const entry: SessionEntry = {
      sessionId: '',
      userId,
      graphId: graph.id,
      lastSeenMs: Date.now(),
      transport: new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
        onsessioninitialized: (sid) => {
          entry.sessionId = sid;
          this.sessions.set(sid, entry);
        },
        onsessionclosed: (sid) => {
          this.sessions.delete(sid);
        },
      }),
      server: createMcpServer(graph.path, {
        // Company server: read-only always; agent surface only if the graph
        // is explicitly configured with its sources mounted (docs/06 §2).
        agentSurface: graph.tools === 'agent',
      }),
    };
    await entry.server.connect(entry.transport);
    await entry.transport.handleRequest(req, res, req.body);
    // If initialization never happened (any pre-init rejection inside the
    // transport), the entry is not in the Map and would leak its graph SQLite
    // handle until GC — close it eagerly.
    if (entry.sessionId === '') {
      await entry.transport.close().catch(() => {});
      await entry.server.close().catch(() => {});
    }
  }

  private countFor(userId: string): number {
    let n = 0;
    for (const entry of this.sessions.values()) if (entry.userId === userId) n++;
    return n;
  }

  /** Close sessions idle beyond the timeout. Exposed for tests. */
  evictIdle(nowMs: number): void {
    for (const entry of this.sessions.values()) {
      if (nowMs - entry.lastSeenMs > this.idleTimeoutMs) {
        void this.destroy(entry, 'idle');
      }
    }
  }

  private async destroy(entry: SessionEntry, reason: string): Promise<void> {
    this.sessions.delete(entry.sessionId);
    this.log(`session ${entry.sessionId || '(uninitialized)'} closed (${reason})`);
    try {
      await entry.transport.close();
      await entry.server.close();
    } catch {
      // Already closing — nothing useful to do.
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.sweeper);
    await Promise.all([...this.sessions.values()].map((e) => this.destroy(e, 'shutdown')));
  }
}
