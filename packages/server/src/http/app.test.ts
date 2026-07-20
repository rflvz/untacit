/**
 * Integration tests for the whole HTTP server (docs/06 §9): a real
 * StreamableHTTPClientTransport speaking MCP against fixture graph repos,
 * plus the authorization matrix (401/403/404), multi-graph session
 * isolation, session lifecycle, host/origin guards and the background
 * embedding refresher (semantic channel verified active, not FTS fallback).
 */

import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as core from '@untacit/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { loadServerConfig, type ServerConfig } from '../config.js';
import { createHttpApp, type HttpAppDeps } from './app.js';

const tmpDirs: string[] = [];
const servers: Server[] = [];
const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
  for (const server of servers) await new Promise((r) => server.close(r));
  // maxRetries/retryDelay: on Windows the SQLite -wal/-shm mmap lingers a few
  // ms after close(), so a recursive rm can hit a transient EPERM/EBUSY.
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** Fixture graph repo with a couple of business nodes and hash embeddings. */
function makeGraphRepo(label: string): string {
  const repo = mkdtempSync(join(tmpdir(), `untacit-http-${label}-`));
  tmpDirs.push(repo);
  core.initGraphRepo(repo);
  // Deterministic offline embeddings so the semantic channel is verifiable.
  const configPath = join(repo, 'untacit.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  config.embeddings = { provider: 'hash' };
  writeFileSync(configPath, JSON.stringify(config, null, 2));

  const store = core.GraphStore.load(repo);
  const nodeBase = {
    aliases: [],
    status: 'active' as const,
    attrs: {},
    evidence: [],
    edges: [],
    schema_version: core.SCHEMA_VERSION,
  };
  const evidence = {
    source_type: 'document' as const,
    locator: { doc_id: 'manual', section: '1' },
    excerpt: `Los pedidos urgentes de ${label} llevan recargo`,
    stance: 'supports' as const,
  };
  store.upsertNode({
    ...nodeBase,
    id: 'rule-recargo-urgente',
    type: 'rule',
    name: `Recargo por pedido urgente (${label})`,
    description: 'Los pedidos urgentes llevan un recargo del 15%.',
    evidence: [evidence],
  });
  store.upsertNode({
    ...nodeBase,
    id: 'process-alta-pedido',
    type: 'process',
    name: 'Alta de pedido',
    description: 'Registro de un pedido nuevo.',
    edges: [
      {
        type: 'DEPENDS_ON',
        target: 'rule/rule-recargo-urgente',
        confidence: core.computeEdgeConfidence([evidence]),
        status: 'active' as const,
        evidence: [evidence],
      },
    ],
  });
  store.write();
  core.gitCommitAll(repo, 'fixture');
  return repo;
}

interface Harness {
  baseUrl: string;
  config: ServerConfig;
  deps: HttpAppDeps;
  tokenFor(username: string, resource?: string | null): string;
  users: { ana: string; eva: string; carlos: string };
}

let h: Harness;

beforeAll(async () => {
  const acme = makeGraphRepo('acme');
  const logistica = makeGraphRepo('logistica');
  const escritura = makeGraphRepo('escritura');

  // Bind first so the ephemeral port can be baked into publicUrl (issuer,
  // host guard and resource URLs all derive from it).
  const server = createServer();
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const dataDir = mkdtempSync(join(tmpdir(), 'untacit-http-data-'));
  tmpDirs.push(dataDir);
  const configPath = join(dataDir, 'untacit-server.config.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      publicUrl: baseUrl,
      host: '127.0.0.1',
      port: address.port,
      graphs: [
        { id: 'acme', name: 'ACME Manufactura', path: acme },
        { id: 'logistica', name: 'Logística', path: logistica, tools: 'agent' },
        { id: 'escritura', name: 'Escritura', path: escritura, write: true },
      ],
      session: { idleTimeoutMinutes: 30, maxSessionsPerUser: 2 },
      security: { allowedOrigins: ['https://inspector.example.com'] },
    }),
  );
  const config = loadServerConfig({ configPath, warn: () => {} });

  const { app, deps } = createHttpApp(config, { log: () => {}, loginRateLimit: false });
  server.on('request', app);
  cleanups.push(() => deps.close());

  const ana = deps.users.add('ana', 'ana-password-123');
  deps.users.grant(ana.id, 'acme');
  deps.users.grant(ana.id, 'logistica');
  deps.users.grant(ana.id, 'escritura', { write: true });
  const eva = deps.users.add('eva', 'eva-password-123');
  deps.users.grant(eva.id, 'logistica');
  const carlos = deps.users.add('carlos', 'carlos-password-123');
  deps.users.grant(carlos.id, 'acme');
  deps.users.grant(carlos.id, 'escritura'); // read-only on the writable graph

  h = {
    baseUrl,
    config,
    deps,
    users: { ana: ana.id, eva: eva.id, carlos: carlos.id },
    tokenFor(username, resource = null) {
      const user = deps.users.getByUsername(username)!;
      return deps.tokens.issue(user.id, 'test-client', ['mcp'], resource).accessToken;
    },
  };
});

async function connectClient(graphId: string, token: string): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(`${h.baseUrl}/graphs/${graphId}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'integration-test', version: '0.0.0' });
  await client.connect(transport);
  return client;
}

/** Raw JSON-RPC POST — for the session-identity tests. */
async function rawPost(
  graphId: string,
  token: string,
  body: unknown,
  sessionId?: string,
): Promise<globalThis.Response> {
  return fetch(`${h.baseUrl}/graphs/${graphId}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${token}`,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

function initializeBody(id = 1) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'initialize',
    params: {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'raw-client', version: '0.0.0' },
    },
  };
}

describe('MCP endpoint over Streamable HTTP', () => {
  it('serves the six query tools to an SDK client and answers a context query', async () => {
    const client = await connectClient('acme', h.tokenFor('ana'));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'untacit_conflicts',
      'untacit_context',
      'untacit_diff',
      'untacit_evidence',
      'untacit_explore',
      'untacit_impact',
    ]);

    const result = await client.callTool({ name: 'untacit_context', arguments: { query: 'recargo urgente' } });
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain('rule-recargo-urgente');
    await client.close();
  });

  it('exposes the agent surface only for graphs configured with tools:"agent"', async () => {
    const client = await connectClient('logistica', h.tokenFor('ana'));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('untacit_interview_gaps');
    await client.close();
  });

  it('keeps the write gate closed on graphs not configured for writes', async () => {
    for (const graphId of ['acme', 'logistica']) {
      const client = await connectClient(graphId, h.tokenFor('ana'));
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).not.toContain('untacit_import_batch');
      await client.close();
    }
  });
});

describe('write mode: per-graph flag + per-user write grants', () => {
  const WRITE_TOOLS = [
    'untacit_import_batch',
    'untacit_review_queue',
    'untacit_merge_accept',
    'untacit_merge_reject',
    'untacit_merge_revert',
    'untacit_conflict_resolve',
  ];

  it('serves the write surface only to write-granted users of a write-enabled graph', async () => {
    const writer = await connectClient('escritura', h.tokenFor('ana'));
    const writerTools = (await writer.listTools()).tools.map((t) => t.name);
    expect(writerTools).toEqual(expect.arrayContaining(WRITE_TOOLS));
    await writer.close();

    // carlos holds a read grant on the same graph: query tools only.
    const reader = await connectClient('escritura', h.tokenFor('carlos'));
    const readerTools = (await reader.listTools()).tools.map((t) => t.name);
    for (const tool of WRITE_TOOLS) expect(readerTools).not.toContain(tool);
    await reader.close();
  });

  it('a write over Streamable HTTP lands as a commit in the graph repo', async () => {
    const graphPath = h.config.graphs.find((g) => g.id === 'escritura')!.path;
    const client = await connectClient('escritura', h.tokenFor('ana'));
    const result = await client.callTool({
      name: 'untacit_import_batch',
      arguments: {
        batch: {
          run_id: '2026-07-19T10-00-00-document',
          source_type: 'document',
          nodes: [
            {
              mention: 'Nave central',
              type: 'entity',
              name: 'Nave central',
              description: 'Almacén central de producto terminado.',
              evidence: {
                locator: { doc_id: 'manual', section: '3' },
                excerpt: 'El producto terminado se deposita en la nave central.',
              },
            },
          ],
          edges: [],
        },
      },
    });
    await client.close();
    const structured = result.structuredContent as { noop: boolean; commit: string | null };
    expect(structured.noop).toBe(false);
    expect(structured.commit).toBeTruthy();

    const store = core.GraphStore.load(graphPath);
    expect(store.getNode('entity-nave-central')).toBeDefined();
    expect(core.gitStatusClean(graphPath)).toBe(true);
  });

  it('downgrading the write grant kills the write session; re-initialize is read-only', async () => {
    const token = h.tokenFor('ana');
    const init = await rawPost('escritura', token, initializeBody());
    expect(init.status).toBe(200);
    const sessionId = init.headers.get('mcp-session-id')!;

    // Plain re-grant strips the write level (docs/06 §5) — the live write
    // session must die on its next request, like a revoked read grant does.
    h.deps.users.grant(h.users.ana, 'escritura');
    try {
      const after = await rawPost('escritura', token, { jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionId);
      expect(after.status).toBe(404);

      // Re-initializing works, but lands on the read-only surface.
      const client = await connectClient('escritura', token);
      const tools = (await client.listTools()).tools.map((t) => t.name);
      for (const tool of WRITE_TOOLS) expect(tools).not.toContain(tool);
      await client.close();
    } finally {
      h.deps.users.grant(h.users.ana, 'escritura', { write: true });
    }
  });
});

describe('authorization matrix', () => {
  it('401 without a token, advertising the per-graph resource metadata', async () => {
    const res = await rawPost('acme', '', initializeBody());
    expect(res.status).toBe(401);
    const wwwAuth = res.headers.get('www-authenticate') ?? '';
    expect(wwwAuth).toContain(`resource_metadata="${h.baseUrl}/.well-known/oauth-protected-resource/graphs/acme/mcp"`);
  });

  it('serves per-graph RFC 9728 metadata pointing at the instance AS', async () => {
    const res = await fetch(`${h.baseUrl}/.well-known/oauth-protected-resource/graphs/acme/mcp`);
    expect(res.status).toBe(200);
    const meta = (await res.json()) as Record<string, unknown>;
    expect(meta.resource).toBe(`${h.baseUrl}/graphs/acme/mcp`);
    // Must be byte-identical to the AS metadata's issuer (RFC 8414 §3.3), which
    // the SDK sets to new URL(issuer).href.
    expect(meta.authorization_servers).toEqual([new URL(h.baseUrl).href]);
    expect(meta.resource_name).toBe('ACME Manufactura');

    const as = await fetch(`${h.baseUrl}/.well-known/oauth-authorization-server`);
    const asMeta = (await as.json()) as { issuer: string };
    expect((meta.authorization_servers as string[])[0]).toBe(asMeta.issuer);
  });

  it('403 with a valid token but no grant on the graph', async () => {
    const res = await rawPost('acme', h.tokenFor('eva'), initializeBody());
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe('access_denied');
  });

  it('404 for unknown graphs — same for authenticated and not', async () => {
    const anon = await rawPost('ghost', '', initializeBody());
    expect(anon.status).toBe(404);
    const authed = await rawPost('ghost', h.tokenFor('ana'), initializeBody());
    expect(authed.status).toBe(404);
  });

  it('401 for a disabled user even with a live token', async () => {
    const token = h.tokenFor('carlos');
    h.deps.users.setDisabled('carlos', true);
    try {
      const res = await rawPost('acme', token, initializeBody());
      expect(res.status).toBe(401);
    } finally {
      h.deps.users.setDisabled('carlos', false);
    }
  });

  it('revoking a grant cuts access immediately, token still live', async () => {
    const eva = h.deps.users.getByUsername('eva')!;
    const token = h.tokenFor('eva');
    const ok = await rawPost('logistica', token, initializeBody());
    expect(ok.status).toBe(200);
    h.deps.users.revoke(eva.id, 'logistica');
    try {
      const denied = await rawPost('logistica', token, initializeBody(2));
      expect(denied.status).toBe(403);
    } finally {
      h.deps.users.grant(eva.id, 'logistica');
    }
  });

  it('rejects a token bound to another graph via RFC 8707 resource', async () => {
    const bound = h.tokenFor('ana', `${h.baseUrl}/graphs/acme/mcp`);
    const ok = await rawPost('acme', bound, initializeBody());
    expect(ok.status).toBe(200);
    const denied = await rawPost('logistica', bound, initializeBody(2));
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toBe('invalid_resource');
  });
});

describe('session isolation and lifecycle', () => {
  async function openSession(graphId: string, token: string): Promise<string> {
    const res = await rawPost(graphId, token, initializeBody());
    expect(res.status).toBe(200);
    const sessionId = res.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();
    return sessionId!;
  }

  const toolsListBody = { jsonrpc: '2.0', id: 9, method: 'tools/list' };

  it('rejects a session presented by another user or another graph with 404', async () => {
    const anaSession = await openSession('acme', h.tokenFor('ana'));

    // Same graph, same session id, different (granted) user → 404.
    const hijack = await rawPost('acme', h.tokenFor('carlos'), toolsListBody, anaSession);
    expect(hijack.status).toBe(404);

    // Same user, other graph → 404 too.
    const crossGraph = await rawPost('logistica', h.tokenFor('ana'), toolsListBody, anaSession);
    expect(crossGraph.status).toBe(404);

    // The rightful owner still works.
    const owner = await rawPost('acme', h.tokenFor('ana'), toolsListBody, anaSession);
    expect(owner.status).toBe(200);
  });

  it('ignores a foreign or unauthenticated DELETE: owner session survives', async () => {
    const anaSession = await openSession('acme', h.tokenFor('ana'));

    // carlos is granted on acme but does not own this session → 404, no kill.
    const foreign = await fetch(`${h.baseUrl}/graphs/acme/mcp`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${h.tokenFor('carlos')}`, 'mcp-session-id': anaSession },
    });
    expect(foreign.status).toBe(404);
    expect((await rawPost('acme', h.tokenFor('ana'), toolsListBody, anaSession)).status).toBe(200);

    // No Authorization header → 401 from bearer middleware, not a silent kill.
    const anon = await fetch(`${h.baseUrl}/graphs/acme/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': anaSession },
    });
    expect(anon.status).toBe(401);
    expect((await rawPost('acme', h.tokenFor('ana'), toolsListBody, anaSession)).status).toBe(200);
  });

  it('rejects a forged session id and a non-initialize request without session', async () => {
    const forged = await rawPost('acme', h.tokenFor('ana'), toolsListBody, randomUUID());
    expect(forged.status).toBe(404);
    const sessionless = await rawPost('acme', h.tokenFor('ana'), toolsListBody);
    expect(sessionless.status).toBe(400);
  });

  it('DELETE terminates the session', async () => {
    const token = h.tokenFor('ana');
    const sessionId = await openSession('acme', token);
    const del = await fetch(`${h.baseUrl}/graphs/acme/mcp`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}`, 'mcp-session-id': sessionId },
    });
    expect(del.status).toBeLessThan(300);
    const after = await rawPost('acme', token, toolsListBody, sessionId);
    expect(after.status).toBe(404);
  });

  it('evicts idle sessions after the configured timeout', async () => {
    const token = h.tokenFor('ana');
    const sessionId = await openSession('acme', token);
    h.deps.sessions.evictIdle(Date.now() + 31 * 60_000); // 31 min later
    // Eviction closes transports asynchronously; poll briefly.
    for (let i = 0; i < 50; i++) {
      const res = await rawPost('acme', token, toolsListBody, sessionId);
      if (res.status === 404) return;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error('idle session was not evicted');
  });

  it('does not evict a live session when a malformed initialize is rejected (406)', async () => {
    const token = h.tokenFor('eva'); // cap is 2 for eva on logistica
    const keep = await openSession('logistica', token);
    // An initialize that omits text/event-stream from Accept gets 406 from the
    // transport — it must NOT cost eva her existing session on the way in.
    const bad = await fetch(`${h.baseUrl}/graphs/logistica/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(initializeBody(77)),
    });
    expect(bad.status).toBe(406);
    const still = await rawPost('logistica', token, toolsListBody, keep);
    expect(still.status).toBe(200);
  });

  it('caps concurrent sessions per user, evicting the least recently used', async () => {
    const token = h.tokenFor('eva'); // eva only uses logistica; cap is 2
    const first = await openSession('logistica', token);
    const second = await openSession('logistica', token);
    const third = await openSession('logistica', token);
    const gone = await rawPost('logistica', token, toolsListBody, first);
    expect(gone.status).toBe(404);
    for (const alive of [second, third]) {
      const ok = await rawPost('logistica', token, toolsListBody, alive);
      expect(ok.status).toBe(200);
    }
  });
});

describe('host and origin guards', () => {
  it('421 for a Host header that is not the public host', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        `${h.baseUrl}/graphs/acme/mcp`,
        { method: 'POST', headers: { host: 'evil.example.com', 'content-type': 'application/json' } },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on('error', reject);
      req.end('{}');
    });
    expect(status).toBe(421);
  });

  it('does not host-guard /healthz (Docker healthcheck path)', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        `${h.baseUrl}/healthz`,
        { headers: { host: 'container-internal:8787' } },
        (res) => resolve(res.statusCode ?? 0),
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(200);
  });

  it('403 for browser calls from a non-allowlisted Origin, allowlisted passes', async () => {
    const denied = await fetch(`${h.baseUrl}/graphs/acme/mcp`, {
      method: 'POST',
      headers: {
        origin: 'https://evil.example.com',
        'content-type': 'application/json',
        authorization: `Bearer ${h.tokenFor('ana')}`,
      },
      body: JSON.stringify(initializeBody()),
    });
    expect(denied.status).toBe(403);

    // An opaque origin ("null") is a present Origin and must face the
    // allowlist, not be waved through (sandboxed iframes, data:/file: docs).
    const opaque = await rawPostWithOrigin('null');
    expect(opaque.status).toBe(403);

    const allowed = await rawPostWithOrigin('https://inspector.example.com');
    expect(allowed.status).toBe(200);

    async function rawPostWithOrigin(origin: string) {
      return fetch(`${h.baseUrl}/graphs/acme/mcp`, {
        method: 'POST',
        headers: {
          origin,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${h.tokenFor('ana')}`,
        },
        body: JSON.stringify(initializeBody()),
      });
    }
  });
});

describe('healthz and embeddings freshness', () => {
  it('reports db and graph readability', async () => {
    const res = await fetch(`${h.baseUrl}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; graphs: { id: string; ok: boolean }[] };
    expect(body.status).toBe('ok');
    expect(body.graphs.map((g) => g.id).sort()).toEqual(['acme', 'escritura', 'logistica']);
  });

  it('returns 503 degraded when a graph path becomes unreadable at runtime', async () => {
    // Dedicated instance: the shared harness graphs are used by other tests.
    const gone = makeGraphRepo('gone');
    const srv = createServer();
    servers.push(srv);
    await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
    const addr = srv.address();
    if (addr === null || typeof addr === 'string') throw new Error('no port');
    const base = `http://127.0.0.1:${addr.port}`;
    const dir = mkdtempSync(join(tmpdir(), 'untacit-http-degraded-'));
    tmpDirs.push(dir);
    const cfgPath = join(dir, 'untacit-server.config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        publicUrl: base,
        host: '127.0.0.1',
        port: addr.port,
        graphs: [{ id: 'gone', name: 'Gone', path: gone }],
      }),
    );
    const cfg = loadServerConfig({ configPath: cfgPath, warn: () => {} });
    const { app, deps } = createHttpApp(cfg, { log: () => {}, loginRateLimit: false });
    srv.on('request', app);
    cleanups.push(() => deps.close());

    // Config load requires the path to exist; induce the failure post-boot
    // (a git mount vanishing at runtime). Deletion, not chmod: the suite runs
    // as root and root bypasses R_OK mode bits.
    rmSync(gone, { recursive: true, force: true });
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { status: string; graphs: { id: string; ok: boolean }[] };
    expect(body.status).toBe('degraded');
    expect(body.graphs.find((g) => g.id === 'gone')!.ok).toBe(false);
  });

  it('keeps node embeddings fresh so hybrid retrieval has a live semantic channel', async () => {
    // Startup refresh (scheduleAll is startServer's job; the harness calls it here).
    h.deps.refresher.scheduleAll();
    await h.deps.refresher.idle();

    const acmePath = h.config.graphs.find((g) => g.id === 'acme')!.path;
    const db = new Database(join(acmePath, '.untacit', 'index.db'), { readonly: true });
    const rows = db.prepare("SELECT COUNT(*) AS n FROM embeddings WHERE provider LIKE 'hash%'").get() as {
      n: number;
    };
    db.close();
    expect(rows.n).toBeGreaterThanOrEqual(2); // both fixture nodes embedded

    // And the semantic channel actually answers (not silent FTS fallback).
    const index = core.GraphIndex.open(acmePath);
    try {
      const provider = await core.createEmbeddingProvider({ provider: 'hash' });
      const hits = await index.semanticSearch('recargo para pedidos urgentes', provider!, { limit: 3 });
      expect(hits.map((r) => r.id)).toContain('rule-recargo-urgente');
    } finally {
      index.close();
    }
  });

  it('schedules a refresh after MCP posts when embeddings.refresh = auto', async () => {
    const acmePath = h.config.graphs.find((g) => g.id === 'acme')!.path;
    // Simulate an external git pull: new node lands on disk.
    const store = core.GraphStore.load(acmePath);
    store.upsertNode({
      id: 'entity-almacen',
      type: 'entity',
      name: 'Almacén',
      description: 'Nave de almacenaje central.',
      aliases: [],
      status: 'active',
      attrs: {},
      evidence: [],
      edges: [],
      schema_version: core.SCHEMA_VERSION,
    });
    store.write();

    // Any MCP POST reindexes (staleness) and then schedules the refresher.
    const client = await connectClient('acme', h.tokenFor('ana'));
    await client.callTool({ name: 'untacit_context', arguments: { query: 'almacén' } });
    await client.close();
    await h.deps.refresher.idle();

    const db = new Database(join(acmePath, '.untacit', 'index.db'), { readonly: true });
    const row = db
      .prepare("SELECT COUNT(*) AS n FROM embeddings WHERE provider LIKE 'hash%' AND node_id = 'entity-almacen'")
      .get() as { n: number };
    db.close();
    expect(row.n).toBe(1);
  });
});

describe('trust proxy setting', () => {
  async function appWith(trustProxy: unknown): Promise<{ setting: unknown; close: () => Promise<void> }> {
    const graph = makeGraphRepo('tp');
    const dir = mkdtempSync(join(tmpdir(), 'untacit-http-tp-'));
    tmpDirs.push(dir);
    const cfgPath = join(dir, 'untacit-server.config.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        publicUrl: 'http://127.0.0.1:8787',
        graphs: [{ id: 'tp', name: 'TP', path: graph }],
        security: { trustProxy },
      }),
    );
    const cfg = loadServerConfig({ configPath: cfgPath, warn: () => {} });
    const { app, deps } = createHttpApp(cfg, { log: () => {}, loginRateLimit: false });
    return { setting: app.get('trust proxy'), close: () => deps.close() };
  }

  it('maps trustProxy true to a single hop and a number to that hop count', async () => {
    // Guards the app.ts ternary: trusting every hop would let a client spoof
    // X-Forwarded-For past the per-IP login rate limit.
    const one = await appWith(true);
    expect(one.setting).toBe(1);
    await one.close();

    const two = await appWith(2);
    expect(two.setting).toBe(2);
    await two.close();

    const off = await appWith(false);
    expect(off.setting).toBe(false); // Express default: do not trust any proxy
    await off.close();
  });
});
