/**
 * Streamable HTTP transport for the untacit MCP server (docs/03 §6).
 *
 * Stateless mode: each POST /mcp gets a fresh server + transport pair, so any
 * MCP host that speaks streamable HTTP (Claude Desktop remote connectors,
 * Claude Code `--mcp-config` with a url, other agents) can connect without
 * session bookkeeping. The graph state itself lives in the repo + derived
 * index, so statelessness costs nothing here.
 */

import { createServer as createHttpServer, type Server } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createServer, type ServeOptions } from './index.js';

export interface HttpServeOptions extends ServeOptions {
  port?: number;
  host?: string;
}

export async function serveMcpHttp(
  repoRoot: string,
  opts: HttpServeOptions = {},
): Promise<Server> {
  const port = opts.port ?? 8765;
  const host = opts.host ?? '127.0.0.1';

  const httpServer = createHttpServer((req, res) => {
    void (async () => {
      if (req.url === undefined || new URL(req.url, `http://${host}`).pathname !== '/mcp') {
        res.writeHead(404, { 'content-type': 'text/plain' });
        res.end('untacit MCP: use POST /mcp (streamable HTTP)\n');
        return;
      }
      // Stateless: one server+transport per request; GET/DELETE (SSE resume,
      // session teardown) have no meaning without sessions.
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32000, message: 'Method not allowed: stateless server, POST only' },
            id: null,
          }),
        );
        return;
      }
      const server = createServer(repoRoot, opts);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      res.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(req, res);
    })().catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: err instanceof Error ? err.message : String(err) },
            id: null,
          }),
        );
      } else {
        res.end();
      }
    });
  });

  await new Promise<void>((resolvePromise) => httpServer.listen(port, host, resolvePromise));
  return httpServer;
}
