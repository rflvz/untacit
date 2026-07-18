import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import * as core from '@untacit/core';
import type { Hono } from 'hono';
import type {
  ApiError,
  ConflictResolveResponse,
  DiffResponse,
  GraphResponse,
  HealthResponse,
  MergeActionResponse,
  NodeDetailResponse,
  OpenResponse,
  ReviewResponse,
  RunsResponse,
  SearchResponse,
  StatsResponse,
} from '../src/api-types.js';
import { createApp } from './app.js';
import { createFixtureRepo, FIXTURE_PROPOSAL_ID } from './fixture.js';
import { buildOpenCommands } from './open.js';

async function getJson<T>(app: Hono, path: string, expectedStatus = 200): Promise<T> {
  const res = await app.request(path);
  expect(res.status).toBe(expectedStatus);
  return (await res.json()) as T;
}

async function postJson<T>(app: Hono, path: string, body: unknown = {}, expectedStatus = 200): Promise<T> {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(expectedStatus);
  return (await res.json()) as T;
}

describe('sidecar read routes', () => {
  let repo: string;
  let app: Hono;

  beforeAll(() => {
    repo = createFixtureRepo();
    app = createApp({ repoRoot: repo });
  });

  it('GET /api/health reports the repo and a loaded core', async () => {
    const body = await getJson<HealthResponse>(app, '/api/health');
    expect(body.ok).toBe(true);
    expect(body.service).toBe('untacit-sidecar');
    expect(body.repo).toBe(repo);
    expect(body.repoExists).toBe(true);
    expect(body.isGitRepo).toBe(true);
    expect(body.core).toBe('loaded');
  });

  it('GET /api/stats counts nodes, edges and conflicts', async () => {
    const body = await getJson<StatsResponse>(app, '/api/stats');
    expect(body.nodes_total).toBe(9);
    expect(body.edges_total).toBe(8);
    expect(body.nodes_by_type.entity).toBe(3);
    expect(body.nodes_by_type.rule).toBe(1);
    expect(body.conflicts_open).toBe(1);
    expect(body.low_confidence_edges).toBeGreaterThanOrEqual(1);
  });

  it('GET /api/graph returns all nodes and edge rows', async () => {
    const body = await getJson<GraphResponse>(app, '/api/graph');
    expect(body.nodes).toHaveLength(9);
    expect(body.edges).toHaveLength(8);
    expect(body.truncated).toBe(false);
    expect(body.totalNodes).toBe(9);
    expect(body.totalEdges).toBe(8);

    const rule = body.nodes.find((n) => n.id === 'rule-bloqueo-pedido-sin-prepago');
    expect(rule?.type).toBe('rule');
    expect(rule?.ref).toBe('rule/rule-bloqueo-pedido-sin-prepago');
    expect(rule?.summary).toContain('Se rechaza');

    const conflicted = body.edges.find((e) => e.status === 'conflicted');
    expect(conflicted?.type).toBe('OPERATES_ON');
    expect(conflicted?.targetId).toBe('entity-pedido');
    // Stable edge id from core ids.ts
    expect(conflicted?.id).toBe(
      core.edgeId('OPERATES_ON', 'rule-bloqueo-pedido-sin-prepago', 'entity/entity-pedido'),
    );
  });

  it('GET /api/graph?minConfidence drops weak edges but keeps nodes', async () => {
    const body = await getJson<GraphResponse>(app, '/api/graph?minConfidence=0.7');
    expect(body.nodes).toHaveLength(9);
    expect(body.edges.some((e) => e.type === 'EXECUTES')).toBe(false); // 0.6 < 0.7
    expect(body.edges).toHaveLength(7);
  });

  it('GET /api/graph?types filters nodes and their edges', async () => {
    const body = await getJson<GraphResponse>(app, '/api/graph?types=rule,entity');
    expect(body.nodes.map((n) => n.type).every((t) => t === 'rule' || t === 'entity')).toBe(true);
    expect(body.nodes).toHaveLength(4);
    // Only edges between kept nodes survive: the rule's three OPERATES_ON.
    expect(body.edges).toHaveLength(3);
    expect(body.edges.every((e) => e.type === 'OPERATES_ON')).toBe(true);
  });

  it('GET /api/graph?status=conflicted keeps only conflicted elements', async () => {
    const body = await getJson<GraphResponse>(app, '/api/graph?status=active');
    expect(body.edges.some((e) => e.status === 'conflicted')).toBe(false);
  });

  it('GET /api/graph rejects a non-numeric minConfidence', async () => {
    const body = await getJson<ApiError>(app, '/api/graph?minConfidence=high', 400);
    expect(body.error).toContain('minConfidence');
  });

  it('GET /api/node/:id returns node + evidence + edges in/out', async () => {
    const body = await getJson<NodeDetailResponse>(app, '/api/node/rule-bloqueo-pedido-sin-prepago');
    expect(body.node.name).toBe('Bloqueo de pedido sin prepago');
    expect(body.node.ref).toBe('rule/rule-bloqueo-pedido-sin-prepago');
    expect(body.evidence.length).toBeGreaterThanOrEqual(1);
    const out = body.edges.filter((e) => e.direction === 'out');
    const inn = body.edges.filter((e) => e.direction === 'in');
    expect(out).toHaveLength(5);
    expect(inn).toHaveLength(1); // GOVERNS from the policy
    expect(inn[0].edge.type).toBe('GOVERNS');
  });

  it('GET /api/node/:id is 404 for an unknown node', async () => {
    const body = await getJson<ApiError>(app, '/api/node/entity-no-existe', 404);
    expect(body.error).toContain('not found');
  });

  it('GET /api/search finds nodes by text', async () => {
    const body = await getJson<SearchResponse>(app, '/api/search?q=prepago');
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(body.results.map((r) => r.id)).toContain('rule-bloqueo-pedido-sin-prepago');
  });

  it('GET /api/search respects the types filter', async () => {
    const body = await getJson<SearchResponse>(app, '/api/search?q=pedido&types=entity');
    expect(body.results.length).toBeGreaterThanOrEqual(1);
    expect(body.results.every((r) => r.type === 'entity')).toBe(true);
  });

  it('GET /api/search with no query returns empty results', async () => {
    const body = await getJson<SearchResponse>(app, '/api/search');
    expect(body.results).toEqual([]);
  });

  it('GET /api/conflicts returns the two evidence stacks', async () => {
    const body = await getJson<{ conflicts: core.Conflict[] }>(app, '/api/conflicts');
    expect(body.conflicts).toHaveLength(1);
    const conflict = body.conflicts[0];
    expect(conflict.nodeId).toBe('rule-bloqueo-pedido-sin-prepago');
    expect(conflict.target).toBe('entity/entity-pedido');
    expect(conflict.supporting.length).toBeGreaterThanOrEqual(1);
    expect(conflict.contradicting.length).toBeGreaterThanOrEqual(1);
    expect(conflict.contradicting[0].stance).toBe('contradicts');
  });

  it('GET /api/review returns the three trays', async () => {
    const body = await getJson<ReviewResponse>(app, '/api/review');
    expect(body.proposals).toHaveLength(1);
    expect(body.proposals[0].id).toBe(FIXTURE_PROPOSAL_ID);
    expect(body.lowConfidence.length).toBeGreaterThanOrEqual(1);
    expect(body.lowConfidence.some((e) => e.type === 'EXECUTES')).toBe(true);
    expect(body.conflicts).toHaveLength(1);
    expect(body.threshold).toBe(core.DEFAULT_REVIEW_THRESHOLD);
  });

  it('GET /api/runs lists run metadata', async () => {
    const body = await getJson<RunsResponse>(app, '/api/runs');
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].id).toBe('2026-07-13T10-30-00-code');
    expect(body.runs[0].source_type).toBe('code');
  });

  it('GET /api/diff defaults to HEAD~1..HEAD and reports the drift', async () => {
    const body = await getJson<DiffResponse>(app, '/api/diff');
    expect(body.diff.ref_a).toBe('HEAD~1');
    expect(body.diff.ref_b).toBe('HEAD');
    const added = body.diff.nodes.filter((n) => n.kind === 'added');
    expect(added.map((n) => n.id)).toContain('event-pedido-creado');
    expect(body.diff.edges.some((e) => e.kind === 'added' && e.type === 'TRIGGERS')).toBe(true);
    expect(typeof body.text).toBe('string');
    expect(body.text.length).toBeGreaterThan(0);
  });

  it('GET /api/diff with a bad ref is a 400', async () => {
    const body = await getJson<ApiError>(app, '/api/diff?a=no-such-ref', 400);
    expect(body.error).toContain('no-such-ref');
  });
});

describe('POST /api/open (clickable locator)', () => {
  let repo: string;
  let executed: string[][];
  let app: Hono;

  beforeAll(() => {
    repo = createFixtureRepo();
    executed = [];
    app = createApp({
      repoRoot: repo,
      openCmdTemplate: 'my-editor {path}:{line}',
      openExecutor: (commands) => {
        executed.push(...commands);
        return Promise.resolve(commands[0]);
      },
    });
  });

  it('resolves a code locator against sources.code and jumps to the line', async () => {
    executed.length = 0;
    const body = await postJson<OpenResponse>(app, '/api/open', {
      source_type: 'code',
      locator: { repo: 'web-pedidos', path: 'src/checkout.ts', line_start: 84, line_end: 91 },
    });
    expect(body.ok).toBe(true);
    expect(body.path).toBe(join(repo, 'sources/web-pedidos/src/checkout.ts'));
    expect(body.line).toBe(84);
    // The UNTACIT_OPEN_CMD template wins, with placeholders substituted.
    expect(executed[0]).toEqual(['my-editor', `${body.path}:84`]);
    expect(body.command).toBe(`my-editor ${body.path}:84`);
  });

  it('resolves a document locator by doc_id under sources.documents', async () => {
    const body = await postJson<OpenResponse>(app, '/api/open', {
      source_type: 'document',
      locator: { doc_id: 'manual-comercial', title: 'Manual comercial', section: '4.2' },
    });
    expect(body.ok).toBe(true);
    expect(body.path).toBe(join(repo, 'sources/docs/manual-comercial.md'));
    expect(body.line).toBeUndefined();
  });

  it('is a 404 when the source repo is not configured', async () => {
    const body = await postJson<ApiError>(
      app,
      '/api/open',
      { source_type: 'code', locator: { repo: 'otro-repo', path: 'a.ts', line_start: 1, line_end: 1 } },
      404,
    );
    expect(body.error).toContain('otro-repo');
    expect(body.error).toContain('untacit.config.json');
  });

  it('is a 404 when the file no longer exists', async () => {
    const body = await postJson<ApiError>(
      app,
      '/api/open',
      { source_type: 'code', locator: { repo: 'web-pedidos', path: 'src/gone.ts', line_start: 1, line_end: 1 } },
      404,
    );
    expect(body.error).toContain('not found');
  });

  it('rejects path traversal out of the source root', async () => {
    const body = await postJson<ApiError>(
      app,
      '/api/open',
      {
        source_type: 'code',
        locator: { repo: 'web-pedidos', path: '../../untacit.config.json', line_start: 1, line_end: 1 },
      },
      400,
    );
    expect(body.error).toContain('escapes');
  });

  it('rejects interview evidence (no local file) and malformed bodies', async () => {
    const interview = await postJson<ApiError>(
      app,
      '/api/open',
      { source_type: 'interview', locator: { interview_id: 'entrevista-001', speaker_role: 'administración' } },
      400,
    );
    expect(interview.error).toContain('no local file');

    await postJson<ApiError>(app, '/api/open', { locator: {} }, 400);
  });
});

describe('buildOpenCommands', () => {
  it('falls back from template to VS Code to the OS opener', () => {
    const commands = buildOpenCommands(
      { path: '/tmp/a.ts', line: 12 },
      { template: 'subl {path}:{line}', platform: 'linux' },
    );
    expect(commands).toEqual([
      ['subl', '/tmp/a.ts:12'],
      ['code', '--goto', '/tmp/a.ts:12'],
      ['xdg-open', '/tmp/a.ts'],
    ]);
  });

  it('defaults to line 1 and the platform opener without a template', () => {
    const commands = buildOpenCommands({ path: '/tmp/doc.md' }, { platform: 'darwin' });
    expect(commands).toEqual([
      ['code', '--goto', '/tmp/doc.md:1'],
      ['open', '/tmp/doc.md'],
    ]);
  });
});

describe('sidecar merge actions (write + commit)', () => {
  it('POST accept executes the merge, deletes the absorbed file and commits', async () => {
    const repo = createFixtureRepo();
    const app = createApp({ repoRoot: repo });

    const body = await postJson<MergeActionResponse>(
      app,
      `/api/review/merge/${FIXTURE_PROPOSAL_ID}/accept`,
      { by: 'administracion' },
    );
    expect(body.ok).toBe(true);
    expect(body.action).toBe('accepted');
    expect(body.record?.fromNodeId).toBe('entity-cliente-nuevo');
    expect(body.record?.intoNodeId).toBe('entity-cliente');
    expect(body.commit).toBeTruthy();

    // Canonical files updated: absorbed node gone, alias moved to survivor.
    expect(existsSync(join(repo, 'graph/entity/entity-cliente-nuevo.md'))).toBe(false);
    const store = core.GraphStore.load(repo);
    expect(store.getNode('entity-cliente-nuevo')).toBeUndefined();
    expect(store.getNode('entity-cliente')?.aliases).toContain('Cliente nuevo');

    // merges.json: proposal resolved, merge record persisted.
    const merges = core.loadMergesFile(repo);
    expect(merges.proposals[0].status).toBe('accepted');
    expect(merges.proposals[0].resolved_by).toBe('administracion');
    expect(merges.merges).toHaveLength(1);

    // The commit left the working tree clean and the review tray empty.
    expect(core.gitStatusClean(repo)).toBe(true);
    const review = await getJson<ReviewResponse>(app, '/api/review');
    expect(review.proposals).toHaveLength(0);

    // The reindexed graph no longer serves the absorbed node.
    const graph = await getJson<GraphResponse>(app, '/api/graph');
    expect(graph.nodes.some((n) => n.id === 'entity-cliente-nuevo')).toBe(false);
    const detail = await getJson<NodeDetailResponse>(app, '/api/node/entity-cliente');
    expect(detail.node.aliases).toContain('Cliente nuevo');
  });

  it('POST reject marks the proposal rejected and commits merges.json', async () => {
    const repo = createFixtureRepo();
    const app = createApp({ repoRoot: repo });

    const body = await postJson<MergeActionResponse>(
      app,
      `/api/review/merge/${FIXTURE_PROPOSAL_ID}/reject`,
      { by: 'gerencia' },
    );
    expect(body.ok).toBe(true);
    expect(body.action).toBe('rejected');
    expect(body.commit).toBeTruthy();

    const merges = core.loadMergesFile(repo);
    expect(merges.proposals[0].status).toBe('rejected');
    expect(merges.proposals[0].resolved_by).toBe('gerencia');
    // The provisional node keeps its own file.
    expect(existsSync(join(repo, 'graph/entity/entity-cliente-nuevo.md'))).toBe(true);
    expect(core.gitStatusClean(repo)).toBe(true);
  });

  it('acting twice on the same proposal is a 409, unknown proposal a 404', async () => {
    const repo = createFixtureRepo();
    const app = createApp({ repoRoot: repo });

    await postJson<MergeActionResponse>(app, `/api/review/merge/${FIXTURE_PROPOSAL_ID}/reject`);
    const again = await postJson<ApiError>(
      app,
      `/api/review/merge/${FIXTURE_PROPOSAL_ID}/accept`,
      {},
      409,
    );
    expect(again.error).toContain('already');

    const missing = await postJson<ApiError>(app, '/api/review/merge/prop-nope/accept', {}, 404);
    expect(missing.error).toContain('not found');
  });
});

describe('sidecar conflict resolution (write + commit)', () => {
  it('POST resolve with the supporting winner returns the edge to active', async () => {
    const repo = createFixtureRepo();
    const app = createApp({ repoRoot: repo });

    const review = await getJson<ReviewResponse>(app, '/api/review');
    const conflict = review.conflicts[0];
    expect(conflict.supporting[0].key).toBeTruthy();

    const body = await postJson<ConflictResolveResponse>(app, '/api/review/conflict/resolve', {
      nodeId: conflict.nodeId,
      edgeType: conflict.edgeType,
      target: conflict.target,
      winnerKey: conflict.supporting[0].key,
      by: 'administración',
    });
    expect(body.ok).toBe(true);
    expect(body.status).toBe('active');
    expect(body.resolution.by).toBe('administración');
    expect(body.commit).toBeTruthy();
    expect(core.gitStatusClean(repo)).toBe(true);

    // The conflict left the queue and the canonical file carries the record.
    const after = await getJson<ReviewResponse>(app, '/api/review');
    expect(after.conflicts).toHaveLength(0);
    const store = core.GraphStore.load(repo);
    const edge = store
      .getNode(conflict.nodeId)!
      .edges.find((e) => e.type === conflict.edgeType && e.target === conflict.target)!;
    expect(edge.status).toBe('active');
    expect(core.conflictResolutionOf(edge)?.by).toBe('administración');
    // The winning evidence carries the human validation.
    expect(edge.evidence.some((ev) => ev.validated_by === 'administración')).toBe(true);
  });

  it('POST resolve with the contradicting winner deprecates the edge', async () => {
    const repo = createFixtureRepo();
    const app = createApp({ repoRoot: repo });
    const review = await getJson<ReviewResponse>(app, '/api/review');
    const conflict = review.conflicts[0];

    const body = await postJson<ConflictResolveResponse>(app, '/api/review/conflict/resolve', {
      nodeId: conflict.nodeId,
      edgeType: conflict.edgeType,
      target: conflict.target,
      winnerKey: conflict.contradicting[0].key,
    });
    expect(body.status).toBe('deprecated');

    const stats = await getJson<StatsResponse>(app, '/api/stats');
    expect(stats.conflicts_open).toBe(0);
  });

  it('validates the payload and maps core errors to statuses', async () => {
    const repo = createFixtureRepo();
    const app = createApp({ repoRoot: repo });
    const review = await getJson<ReviewResponse>(app, '/api/review');
    const conflict = review.conflicts[0];

    const missing = await postJson<ApiError>(app, '/api/review/conflict/resolve', {}, 400);
    expect(missing.error).toContain('required');

    const badKey = await postJson<ApiError>(
      app,
      '/api/review/conflict/resolve',
      { nodeId: conflict.nodeId, edgeType: conflict.edgeType, target: conflict.target, winnerKey: 'nope' },
      404,
    );
    expect(badKey.error).toContain('not found');

    await postJson<ConflictResolveResponse>(app, '/api/review/conflict/resolve', {
      nodeId: conflict.nodeId,
      edgeType: conflict.edgeType,
      target: conflict.target,
      winnerKey: conflict.supporting[0].key,
    });
    const again = await postJson<ApiError>(
      app,
      '/api/review/conflict/resolve',
      { nodeId: conflict.nodeId, edgeType: conflict.edgeType, target: conflict.target, winnerKey: conflict.supporting[0].key },
      409,
    );
    expect(again.error).toContain('already');
  });
});
