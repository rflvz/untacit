/**
 * Sidecar HTTP API over @untacit/core (docs/03 §3 "Acceso desde la app").
 *
 * The React frontend consumes these routes through the Vite dev proxy
 * (/api -> localhost:4823). All reads go through the derived SQLite index
 * (reindexed incrementally when stale) except /api/graph and the merge
 * actions, which read/write the canonical node files through GraphStore.
 * Every write ends in a git commit (docs/03 §7 point 3).
 */

import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { cors } from 'hono/cors';
import type {
  ApiEdge,
  ApiError,
  ApiGraphNode,
  ConflictResolveRequest,
  ConflictResolveResponse,
  DiffResponse,
  ElementStatus,
  GraphResponse,
  HealthResponse,
  MergeActionResponse,
  NodeDetailResponse,
  NodeType,
  OpenRequest,
  OpenResponse,
  ReviewResponse,
  RunsResponse,
  SearchResponse,
  SourceType,
} from '../src/api-types.js';
import type { LlmClient } from '@untacit/extractors';
import { coreLoadError, loadCore, type CoreModule } from './core-loader.js';
import { registerInterviewRoutes } from './interview.js';
import {
  buildOpenCommands,
  resolveOpenTarget,
  spawnOpenExecutor,
  type OpenExecutor,
} from './open.js';

const MAX_GRAPH_NODES = 10_000;
const MAX_GRAPH_EDGES = 20_000;

const ALL_STATUSES: readonly ElementStatus[] = ['active', 'deprecated', 'conflicted', 'stale'];

export interface SidecarOptions {
  /** Root of the graph repo (the directory holding graph/, runs/, merges.json). */
  repoRoot: string;
  /**
   * LLM client for the interview agent (tests inject a mock). Production
   * resolves ClaudeCodeLlmClient lazily (engine = local Claude Code CLI).
   */
  llm?: LlmClient;
  /** Executes the opener commands of POST /api/open (injectable for tests). */
  openExecutor?: OpenExecutor;
  /** UNTACIT_OPEN_CMD template override (defaults to the env var). */
  openCmdTemplate?: string;
}

// GraphIndex has a private constructor; derive the instance type from open().
type GraphIndexInstance = ReturnType<CoreModule['GraphIndex']['open']>;

/** Map thrown core errors to HTTP statuses ("not found" -> 404, "already ..." -> 409). */
function errorStatus(message: string): 400 | 404 | 409 | 500 {
  if (/not found/i.test(message)) return 404;
  if (/already/i.test(message)) return 409;
  if (/no local file|must have|escapes the source root/i.test(message)) return 400;
  return 500;
}

function parseListParam(raw: string | undefined): string[] | undefined {
  if (raw === undefined || raw.trim() === '') return undefined;
  const items = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return items.length > 0 ? items : undefined;
}

function firstLine(text: string): string {
  return text.split('\n', 1)[0].trim();
}

export function createApp(opts: SidecarOptions): Hono {
  const { repoRoot } = opts;
  const openExecutor = opts.openExecutor ?? spawnOpenExecutor;
  const openCmdTemplate = opts.openCmdTemplate ?? process.env.UNTACIT_OPEN_CMD;
  const app = new Hono();

  // Derived-index cache: opened once, incrementally reindexed per read.
  let index: GraphIndexInstance | undefined;
  const getIndex = (core: CoreModule): GraphIndexInstance => {
    if (index === undefined) {
      index = core.GraphIndex.open(repoRoot);
    } else {
      index.reindexIfStale();
    }
    return index;
  };

  app.use('/api/*', cors());

  /**
   * Wrap a handler: resolve core (503 when unavailable, docs note "core not
   * built yet"), catch thrown errors and map them to JSON error responses.
   */
  const route =
    (handler: (c: Context, core: CoreModule) => Promise<Response> | Response) =>
    async (c: Context): Promise<Response> => {
      const core = await loadCore();
      if (core === undefined) {
        const body: ApiError = { error: 'core not built yet', detail: coreLoadError() };
        return c.json(body, 503);
      }
      try {
        return await handler(c, core);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const body: ApiError = { error: message };
        return c.json(body, errorStatus(message));
      }
    };

  // -------------------------------------------------------------------------
  // GET /api/health — liveness; works even when core is unavailable.
  // -------------------------------------------------------------------------
  app.get('/api/health', async (c) => {
    const core = await loadCore();
    const repoExists = existsSync(repoRoot);
    const body: HealthResponse = {
      ok: core !== undefined && repoExists,
      service: 'untacit-sidecar',
      repo: repoRoot,
      repoExists,
      isGitRepo: core !== undefined && repoExists ? core.isGitRepo(repoRoot) : false,
      core: core !== undefined ? 'loaded' : 'unavailable',
    };
    const coreError = coreLoadError();
    if (coreError !== undefined) body.coreError = coreError;
    return c.json(body);
  });

  // -------------------------------------------------------------------------
  // GET /api/stats — GraphStats from the derived index.
  // -------------------------------------------------------------------------
  app.get(
    '/api/stats',
    route((c, core) => c.json(getIndex(core).stats())),
  );

  // -------------------------------------------------------------------------
  // GET /api/graph?minConfidence&types&status — everything the Sigma view
  // needs, read from the canonical files, capped at ~10k nodes.
  // -------------------------------------------------------------------------
  app.get(
    '/api/graph',
    route((c, core) => {
      const typesParam = parseListParam(c.req.query('types'));
      const statusParam = parseListParam(c.req.query('status'));
      const minConfidenceRaw = c.req.query('minConfidence');
      const minConfidence =
        minConfidenceRaw !== undefined && minConfidenceRaw !== ''
          ? Number(minConfidenceRaw)
          : undefined;
      if (minConfidence !== undefined && Number.isNaN(minConfidence)) {
        return c.json({ error: 'minConfidence must be a number' } satisfies ApiError, 400);
      }
      const typeFilter =
        typesParam !== undefined
          ? new Set(typesParam.filter((t): t is NodeType => (core.NODE_TYPES as readonly string[]).includes(t)))
          : undefined;
      const statusFilter =
        statusParam !== undefined
          ? new Set(statusParam.filter((s): s is ElementStatus => (ALL_STATUSES as readonly string[]).includes(s)))
          : undefined;

      const store = core.GraphStore.load(repoRoot);
      const allNodes = [...store.nodes.values()].sort((a, b) => (a.id < b.id ? -1 : 1));

      let totalEdges = 0;
      for (const node of allNodes) totalEdges += node.edges.length;

      const keptNodes = allNodes.filter(
        (n) =>
          (typeFilter === undefined || typeFilter.has(n.type)) &&
          (statusFilter === undefined || statusFilter.has(n.status)),
      );
      const cappedNodes = keptNodes.slice(0, MAX_GRAPH_NODES);
      const keptIds = new Set(cappedNodes.map((n) => n.id));

      const edges: ApiEdge[] = [];
      let edgesDropped = false;
      for (const node of cappedNodes) {
        for (const edge of node.edges) {
          const targetId = core.parseNodeRef(edge.target).id;
          if (!keptIds.has(targetId)) continue; // dangling or filtered-out target
          if (minConfidence !== undefined && edge.confidence < minConfidence) continue;
          if (statusFilter !== undefined && !statusFilter.has(edge.status)) continue;
          if (edges.length >= MAX_GRAPH_EDGES) {
            edgesDropped = true;
            break;
          }
          const row: ApiEdge = {
            id: core.edgeId(edge.type, node.id, edge.target),
            source: node.id,
            type: edge.type,
            target: edge.target,
            targetId,
            confidence: edge.confidence,
            status: edge.status,
          };
          if (edge.attrs !== undefined && Object.keys(edge.attrs).length > 0) {
            row.attrs = edge.attrs;
          }
          edges.push(row);
        }
      }

      const body: GraphResponse = {
        nodes: cappedNodes.map((n) => ({
          id: n.id,
          ref: core.nodeRef(n.type, n.id),
          type: n.type,
          name: n.name,
          status: n.status,
          summary: firstLine(n.description),
        })) satisfies ApiGraphNode[],
        edges,
        totalNodes: allNodes.length,
        totalEdges,
        truncated: keptNodes.length > cappedNodes.length || edgesDropped,
      };
      return c.json(body);
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/node/:id — full node + its evidence + edges in/out.
  // -------------------------------------------------------------------------
  app.get(
    '/api/node/:id',
    route((c, core) => {
      const id = c.req.param('id') ?? '';
      const idx = getIndex(core);
      const node = idx.getNode(id);
      if (node === undefined) {
        return c.json({ error: `node "${id}" not found` } satisfies ApiError, 404);
      }
      const body: NodeDetailResponse = {
        node,
        edges: idx.edgesOf(id),
        evidence: node.evidence,
      };
      return c.json(body);
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/search?q&types&limit — FTS5, bm25 ranked.
  // -------------------------------------------------------------------------
  app.get(
    '/api/search',
    route((c, core) => {
      const q = c.req.query('q');
      if (q === undefined || q.trim() === '') {
        return c.json({ results: [] } satisfies SearchResponse);
      }
      const typesParam = parseListParam(c.req.query('types'));
      const types =
        typesParam !== undefined
          ? typesParam.filter((t): t is NodeType => (core.NODE_TYPES as readonly string[]).includes(t))
          : undefined;
      const limitRaw = c.req.query('limit');
      const limit = Math.min(Math.max(Number(limitRaw ?? 20) || 20, 1), 100);
      const results = getIndex(core).search(q, { types, limit });
      return c.json({ results } satisfies SearchResponse);
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/conflicts — open contradictions with their evidence stacks.
  // -------------------------------------------------------------------------
  app.get(
    '/api/conflicts',
    route((c, core) => c.json({ conflicts: getIndex(core).conflicts() })),
  );

  // -------------------------------------------------------------------------
  // GET /api/review — the three review trays (docs/03 §7 point 3).
  // -------------------------------------------------------------------------
  app.get(
    '/api/review',
    route((c, core) => {
      const idx = getIndex(core);
      const merges = core.loadMergesFile(repoRoot);
      const body: ReviewResponse = {
        proposals: merges.proposals.filter((p) => p.status === 'pending'),
        lowConfidence: idx.lowConfidenceEdges(),
        conflicts: idx.conflicts(),
        threshold: core.DEFAULT_REVIEW_THRESHOLD,
      };
      return c.json(body);
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/runs — run metadata, newest first.
  // -------------------------------------------------------------------------
  app.get(
    '/api/runs',
    route((c, core) => {
      const body: RunsResponse = { runs: core.listRuns(repoRoot).reverse() };
      return c.json(body);
    }),
  );

  // -------------------------------------------------------------------------
  // GET /api/diff?a&b — ontology diff between two git refs (default HEAD~1..HEAD).
  // -------------------------------------------------------------------------
  app.get(
    '/api/diff',
    route((c, core) => {
      const refA = c.req.query('a') ?? 'HEAD~1';
      const refB = c.req.query('b') ?? 'HEAD';
      try {
        const diff = core.diffRefs(repoRoot, refA, refB);
        const body: DiffResponse = { diff, text: core.formatDiffText(diff) };
        return c.json(body);
      } catch (err) {
        // Bad refs (unknown ref, single-commit repo, ...) are a client problem.
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: `cannot diff ${refA}..${refB}`, detail: message } satisfies ApiError, 400);
      }
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/open — resolve an evidence locator against the config's sources
  // and open the local file in the user's editor (docs/04 Fase 2: "locator
  // clicable que abre el fichero local").
  // -------------------------------------------------------------------------
  app.post(
    '/api/open',
    route(async (c, core) => {
      const payload = (await c.req.json().catch(() => undefined)) as OpenRequest | undefined;
      if (
        payload === undefined ||
        typeof payload.source_type !== 'string' ||
        typeof payload.locator !== 'object' ||
        payload.locator === null
      ) {
        return c.json(
          { error: 'body must be { source_type, locator }' } satisfies ApiError,
          400,
        );
      }
      const config = core.loadConfig(repoRoot);
      const target = resolveOpenTarget(
        repoRoot,
        config,
        payload.source_type as SourceType,
        payload.locator,
      );
      const command = await openExecutor(buildOpenCommands(target, { template: openCmdTemplate }));
      const body: OpenResponse = {
        ok: true,
        path: target.path,
        command: command.join(' '),
      };
      if (target.line !== undefined) body.line = target.line;
      return c.json(body);
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/review/merge/:id/accept — execute the merge, write files, commit.
  // -------------------------------------------------------------------------
  app.post(
    '/api/review/merge/:id/accept',
    route(async (c, core) => {
      const proposalId = c.req.param('id') ?? '';
      const payload = (await c.req.json().catch(() => ({}))) as { by?: string };
      const store = core.GraphStore.load(repoRoot);
      const record = core.acceptMergeProposal(store, proposalId, payload.by);
      store.write();
      const commit = core.gitCommitAll(
        repoRoot,
        `untacit: accept merge ${record.fromNodeId} -> ${record.intoNodeId} (proposal ${proposalId})`,
      );
      const body: MergeActionResponse = {
        ok: true,
        proposalId,
        action: 'accepted',
        record,
        commit,
      };
      return c.json(body);
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/review/merge/:id/reject — mark rejected in merges.json, commit.
  // -------------------------------------------------------------------------
  app.post(
    '/api/review/merge/:id/reject',
    route(async (c, core) => {
      const proposalId = c.req.param('id') ?? '';
      const payload = (await c.req.json().catch(() => ({}))) as { by?: string };
      core.rejectMergeProposal(repoRoot, proposalId, payload.by);
      const commit = core.gitCommitAll(repoRoot, `untacit: reject merge proposal ${proposalId}`);
      const body: MergeActionResponse = {
        ok: true,
        proposalId,
        action: 'rejected',
        commit,
      };
      return c.json(body);
    }),
  );

  // -------------------------------------------------------------------------
  // POST /api/review/conflict/resolve — mark the winning evidence of a
  // conflicted edge (docs/02 §6), write files, commit.
  // -------------------------------------------------------------------------
  app.post(
    '/api/review/conflict/resolve',
    route(async (c, core) => {
      const payload = (await c.req.json().catch(() => ({}))) as Partial<ConflictResolveRequest>;
      const { nodeId, edgeType, target, winnerKey, by } = payload;
      if (!nodeId || !edgeType || !target || !winnerKey) {
        return c.json(
          { error: 'nodeId, edgeType, target and winnerKey are required' } satisfies ApiError,
          400,
        );
      }
      const store = core.GraphStore.load(repoRoot);
      const { edge, resolution } = core.resolveConflictEdge(store, {
        nodeId,
        edgeType,
        target,
        winnerKey,
        by,
      });
      store.write();
      const commit = core.gitCommitAll(
        repoRoot,
        `untacit: resolve conflict ${nodeId} -${edgeType}-> ${target} (${resolution.status})`,
      );
      const body: ConflictResolveResponse = {
        ok: true,
        status: edge.status as 'active' | 'deprecated',
        resolution,
        commit,
      };
      return c.json(body);
    }),
  );

  // Interview endpoints (Fase 4): /api/interview/* — see sidecar/interview.ts.
  registerInterviewRoutes(app, { repoRoot, route, getIndex, llm: opts.llm });

  app.get('/', (c) =>
    c.text(`untacit sidecar — graph repo: ${repoRoot}\nAPI under /api (try /api/health)\n`),
  );

  return app;
}
