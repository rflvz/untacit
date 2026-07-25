/**
 * Extraction endpoint tests (desktop Fase 2): the whole job lifecycle over the
 * fixture repo with a scripted mock LLM — source listing, candidate/section
 * preview with no LLM call, a code run that ends in an import + commit, a docs
 * run, cancellation, SSE progress, the one-job-at-a-time guard, and the
 * "Claude Code is not installed" path.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as core from '@untacit/core';
import { MockLlmClient } from '@untacit/extractors';
import type { LlmClient, LlmRequest } from '@untacit/extractors';
import type { Hono } from 'hono';
import type {
  ApiError,
  ExtractJob,
  ExtractJobsResponse,
  ExtractPreviewResponse,
  ExtractSourcesResponse,
  ExtractStartResponse,
  ImportResponse,
  MergeActionResponse,
  RunsResponse,
} from '../src/api-types.js';
import { createApp } from './app.js';
import {
  createFixtureRepo,
  FIXTURE_PROPOSAL_ID,
  withEnv,
  writeRecordingClaudeStub,
} from './fixture.js';

async function getJson<T>(app: Hono, path: string, expectedStatus = 200): Promise<T> {
  const res = await app.request(path);
  expect(res.status).toBe(expectedStatus);
  return (await res.json()) as T;
}

async function postJson<T>(
  app: Hono,
  path: string,
  body: unknown = {},
  expectedStatus = 200,
): Promise<T> {
  const res = await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(expectedStatus);
  return (await res.json()) as T;
}

/**
 * Two business-logic files in the fixture's code source, committed so the
 * graph repo stays clean for the "one run = one commit" assertions. The
 * scanner finds exactly one candidate per file (each signal blocks the next
 * eight lines), which makes chunkSize = 1 produce exactly two LLM calls.
 */
function addCodeSource(repo: string): void {
  const src = join(repo, 'sources', 'web-pedidos', 'src');
  mkdirSync(src, { recursive: true });
  writeFileSync(
    join(src, 'pricing.ts'),
    [
      'export function precioFinal(pedido: Pedido, cliente: Cliente): number {',
      '  if (cliente.esNuevo && !pedido.prepagado) {',
      "    throw new Error('no se puede servir un pedido a un cliente nuevo sin prepago');",
      '  }',
      '  return pedido.importe;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  writeFileSync(
    join(src, 'facturacion.ts'),
    [
      'export function calcularRecargo(pedido: Pedido): number {',
      '  if (pedido.importe > 3000) return 0;',
      '  return 25;',
      '}',
      '',
    ].join('\n'),
    'utf8',
  );
  core.gitCommitAll(repo, 'test: business-logic sources for extraction');
}

/** Batch the mock agent answers with for a code chunk. */
const codeBatch = (mention: string, path: string) => ({
  run_id: 'pending',
  source_type: 'code',
  nodes: [
    {
      mention,
      type: 'rule',
      name: mention,
      description: `Regla de negocio detectada en ${path}.`,
      evidence: {
        locator: { repo: 'web-pedidos', path, line_start: 1, line_end: 6 },
        excerpt: 'if (cliente.esNuevo && !pedido.prepagado) throw new Error(...)',
      },
    },
  ],
  edges: [
    {
      type: 'OPERATES_ON',
      source_mention: mention,
      target_mention: 'Pedido',
      evidence: {
        locator: { repo: 'web-pedidos', path, line_start: 2, line_end: 2 },
        excerpt: 'pedido.prepagado',
      },
    },
  ],
});

const DOCS_BATCH = {
  run_id: 'pending',
  source_type: 'document',
  nodes: [
    {
      mention: 'Pago por adelantado',
      type: 'policy',
      name: 'Pago por adelantado',
      description: 'Los clientes de nueva incorporación pagan antes de recibir mercancía.',
      evidence: {
        locator: { doc_id: 'manual-comercial', title: 'Manual comercial', section: '2. 4.2 Pagos' },
        excerpt: 'A clientes de nueva incorporación se les exigirá el pago por adelantado.',
      },
    },
  ],
  edges: [],
};

const TERMINAL = ['done', 'error', 'cancelled'];

/**
 * Poll a job until it reaches a terminal phase (what the UI does). The deadline
 * stays under vitest's 5 s default so the diagnostic below actually fires
 * instead of the runner killing the test with a generic timeout.
 */
async function waitForJob(app: Hono, id: string, timeoutMs = 4_000): Promise<ExtractJob> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const job = await getJson<ExtractJob>(app, `/api/extract/${id}`);
    if (TERMINAL.includes(job.phase)) return job;
    if (Date.now() > deadline) {
      throw new Error(`job ${id} stuck in phase ${job.phase} (${job.message})`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

/** LlmClient whose every completion runs a hook first (timing control). */
class HookedLlmClient implements LlmClient {
  readonly name = 'hooked';
  readonly model = 'hooked';
  calls = 0;
  requests: LlmRequest[] = [];
  constructor(
    private readonly response: () => object,
    private readonly hook: (call: number) => Promise<void> | void,
  ) {}

  async complete(req: LlmRequest): Promise<string> {
    this.requests.push(req);
    this.calls++;
    await this.hook(this.calls);
    return JSON.stringify(this.response());
  }
}

describe('extraction over the sidecar', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('lists the declared sources with their resolved paths and engine state', async () => {
    const repo = createFixtureRepo();
    addCodeSource(repo);
    const app = createApp({ repoRoot: repo, llm: new MockLlmClient([]) });

    const body = await getJson<ExtractSourcesResponse>(app, '/api/extract/sources');
    expect(body.llmReady).toBe(true);
    expect(body.runningJobId).toBeNull();

    const code = body.sources.find((s) => s.kind === 'code')!;
    expect(code).toMatchObject({ key: 'web-pedidos', label: 'web-pedidos', exists: true });
    expect(code.resolvedPath).toBe(join(repo, 'sources', 'web-pedidos'));

    const docs = body.sources.find((s) => s.kind === 'docs')!;
    // key is the config path: that is what the requests carry.
    expect(docs).toMatchObject({ key: 'sources/docs', exists: true, documentCount: 1 });
  });

  it('previews candidates and sections without spending a single LLM call', async () => {
    const repo = createFixtureRepo();
    addCodeSource(repo);
    const llm = new MockLlmClient([]);
    const app = createApp({ repoRoot: repo, llm });

    const code = await postJson<ExtractPreviewResponse>(app, '/api/extract/preview', {
      kind: 'code',
      source: 'web-pedidos',
      chunkSize: 1,
    });
    expect(code.candidates?.map((c) => c.path)).toEqual([
      'src/facturacion.ts',
      'src/pricing.ts',
    ]);
    expect(code.candidates![1].signals).toContain('conditional-validation');
    expect(code.files).toEqual(['src/facturacion.ts', 'src/pricing.ts']);
    // One candidate per call → one call per candidate.
    expect(code.plannedCalls).toBe(2);

    const docs = await postJson<ExtractPreviewResponse>(app, '/api/extract/preview', {
      kind: 'docs',
      source: 'sources/docs',
    });
    expect(docs.sections).toHaveLength(1);
    expect(docs.sections![0]).toMatchObject({ doc_id: 'manual-comercial', title: 'Manual comercial' });
    expect(docs.files).toEqual(['manual-comercial.md']);
    expect(docs.plannedCalls).toBe(1);

    // The whole point: no LLM was touched.
    expect(llm.requests).toHaveLength(0);
  });

  it('runs a code extraction end to end: scan → LLM chunks → import → commit', async () => {
    const repo = createFixtureRepo();
    addCodeSource(repo);
    const llm = new MockLlmClient([
      codeBatch('Recargo de pedidos grandes', 'src/facturacion.ts'),
      codeBatch('Prepago de clientes nuevos', 'src/pricing.ts'),
    ]);
    const app = createApp({ repoRoot: repo, llm });

    const started = await postJson<ExtractStartResponse>(
      app,
      '/api/extract',
      { kind: 'code', source: 'web-pedidos', chunkSize: 1 },
      202,
    );
    expect(started.job.phase).toBe('scanning');
    expect(started.job.chunkSize).toBe(1);
    expect(started.job.batchAvailable).toBe(false);

    const job = await waitForJob(app, started.job.id);
    expect(job.phase).toBe('done');
    expect(job.error).toBeUndefined();
    expect(job.units).toBe(2);
    expect(job.plannedCalls).toBe(2);
    expect(job.llmCalls).toBe(2);
    expect(job.batchAvailable).toBe(true);
    expect(job.finishedAt).toBeTruthy();

    const result = job.result!;
    expect(result.noop).toBe(false);
    expect(result.commit).toBeTruthy();
    expect(result.branch).toBeNull();
    expect(result.batchNodes).toBe(2);
    expect(result.stats.nodes_created).toBeGreaterThan(0);

    // The run is materialized like any other, and one run = one commit.
    const runs = await getJson<RunsResponse>(app, '/api/runs');
    expect(runs.runs.some((r) => r.id === result.runId && r.source_type === 'code')).toBe(true);
    expect(core.gitStatusClean(repo)).toBe(true);

    // Evidence survived with its code locator (mandatory-evidence invariant).
    const store = core.GraphStore.load(repo);
    const created = [...store.nodes.values()].find((n) => n.name === 'Prepago de clientes nuevos')!;
    expect(created.evidence[0]!.source_type).toBe('code');
    expect(created.evidence[0]!.locator).toMatchObject({ repo: 'web-pedidos', path: 'src/pricing.ts' });

    // The emitted batch stays retrievable (LLM spend is never lost).
    const batch = await getJson<{ run_id: string; nodes: unknown[] }>(
      app,
      `/api/extract/${started.job.id}/batch`,
    );
    expect(batch.nodes).toHaveLength(2);

    // The job is remembered and the sidecar is idle again.
    const jobs = await getJson<ExtractJobsResponse>(app, '/api/extract');
    expect(jobs.runningJobId).toBeNull();
    expect(jobs.jobs.map((j) => j.id)).toContain(started.job.id);
  });

  it('runs a docs extraction and records the document locator', async () => {
    const repo = createFixtureRepo();
    const llm = new MockLlmClient([DOCS_BATCH]);
    const app = createApp({ repoRoot: repo, llm });

    const started = await postJson<ExtractStartResponse>(
      app,
      '/api/extract',
      { kind: 'docs', source: 'sources/docs' },
      202,
    );
    const job = await waitForJob(app, started.job.id);
    expect(job.phase).toBe('done');
    expect(job.units).toBe(1);
    expect(job.llmCalls).toBe(1);
    expect(job.result!.commit).toBeTruthy();

    const runs = await getJson<RunsResponse>(app, '/api/runs');
    expect(runs.runs.some((r) => r.id === job.result!.runId && r.source_type === 'document')).toBe(
      true,
    );
    expect(core.gitStatusClean(repo)).toBe(true);
  });

  it('commits the run on a branch when asked (extraction as PR)', async () => {
    const repo = createFixtureRepo();
    const llm = new MockLlmClient([DOCS_BATCH]);
    const app = createApp({ repoRoot: repo, llm });

    const started = await postJson<ExtractStartResponse>(
      app,
      '/api/extract',
      { kind: 'docs', source: 'sources/docs', branch: true },
      202,
    );
    const job = await waitForJob(app, started.job.id);
    expect(job.phase).toBe('done');
    expect(job.result!.branch).toBe(`run/${job.result!.runId}`);
  });

  it('cancels before the next chunk, keeping the calls already spent visible', async () => {
    const repo = createFixtureRepo();
    addCodeSource(repo);
    let app: Hono;
    let jobId = '';
    // The job runs detached, so the first LLM call can start before the 202 has
    // even been parsed. Block it until the test knows the job id, then cancel
    // from inside the call: deterministic, no race with the scheduler.
    let announceJobId = (): void => {};
    const jobIdKnown = new Promise<void>((resolve) => {
      announceJobId = resolve;
    });
    const llm = new HookedLlmClient(
      () => codeBatch('Prepago de clientes nuevos', 'src/pricing.ts'),
      async (call) => {
        // Cancel while the first chunk is in flight: the wrapper aborts before
        // the second one, so exactly one call is ever spent.
        if (call === 1) {
          await jobIdKnown;
          await postJson<ExtractJob>(app, `/api/extract/${jobId}/cancel`);
        }
      },
    );
    app = createApp({ repoRoot: repo, llm });

    const started = await postJson<ExtractStartResponse>(
      app,
      '/api/extract',
      { kind: 'code', source: 'web-pedidos', chunkSize: 1 },
      202,
    );
    jobId = started.job.id;
    announceJobId();

    const job = await waitForJob(app, jobId);
    expect(job.phase).toBe('cancelled');
    expect(job.cancelRequested).toBe(true);
    expect(llm.calls).toBe(1);
    expect(job.llmCalls).toBe(1);
    expect(job.message).toContain('cancelada');
    // A cancelled run imports nothing: the graph is untouched.
    expect(job.result).toBeUndefined();
    expect(core.gitStatusClean(repo)).toBe(true);

    // Cancelling a finished job is a no-op, not an error.
    const again = await postJson<ExtractJob>(app, `/api/extract/${jobId}/cancel`);
    expect(again.phase).toBe('cancelled');

    // And the sidecar accepts work again.
    const sources = await getJson<ExtractSourcesResponse>(app, '/api/extract/sources');
    expect(sources.runningJobId).toBeNull();
  });

  it('streams the same snapshots over SSE and closes on the terminal phase', async () => {
    const repo = createFixtureRepo();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const llm = new HookedLlmClient(() => DOCS_BATCH, () => gate);
    const app = createApp({ repoRoot: repo, llm });

    const started = await postJson<ExtractStartResponse>(
      app,
      '/api/extract',
      { kind: 'docs', source: 'sources/docs' },
      202,
    );

    // Open the stream while the agent is still blocked on the gate.
    await vi.waitFor(() => expect(llm.calls).toBe(1), { timeout: 5000 });
    const res = await app.request(`/api/extract/${started.job.id}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const phases: string[] = [];
    let buffer = '';
    const readAll = (async () => {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (const frame of buffer.split('\n\n')) {
          const line = frame.split('\n').find((l) => l.startsWith('data:'));
          if (line === undefined) continue;
          const payload = JSON.parse(line.slice('data:'.length).trim()) as ExtractJob;
          if (!phases.includes(payload.phase)) phases.push(payload.phase);
        }
        // Keep only the trailing partial frame.
        const lastBreak = buffer.lastIndexOf('\n\n');
        if (lastBreak !== -1) buffer = buffer.slice(lastBreak + 2);
      }
    })();

    release();
    await readAll; // the sidecar ends the stream itself on the terminal phase
    expect(phases).toContain('extracting');
    expect(phases[phases.length - 1]).toBe('done');
  });

  it('refuses a second concurrent extraction (one SQLite/git writer at a time)', async () => {
    const repo = createFixtureRepo();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const llm = new HookedLlmClient(() => DOCS_BATCH, () => gate);
    const app = createApp({ repoRoot: repo, llm });

    const started = await postJson<ExtractStartResponse>(
      app,
      '/api/extract',
      { kind: 'docs', source: 'sources/docs' },
      202,
    );
    await vi.waitFor(() => expect(llm.calls).toBe(1), { timeout: 5000 });

    const busy = await postJson<ApiError>(
      app,
      '/api/extract',
      { kind: 'docs', source: 'sources/docs' },
      409,
    );
    expect(busy.error).toContain('en curso');
    expect(busy.detail).toContain(started.job.id);

    const sources = await getJson<ExtractSourcesResponse>(app, '/api/extract/sources');
    expect(sources.runningJobId).toBe(started.job.id);

    release();
    await waitForJob(app, started.job.id);
  });

  it('pins the SOURCE repo commit and its config name, not the graph repo (invariant 5)', async () => {
    const repo = createFixtureRepo();
    // A source repo of its own, outside the graph repo, with its own history:
    // the fixture's in-tree source would hide a source/graph-repo confusion,
    // because both would resolve to the same HEAD.
    const sourceRoot = mkdtempSync(join(tmpdir(), 'untacit-source-'));
    mkdirSync(join(sourceRoot, 'src'), { recursive: true });
    writeFileSync(
      join(sourceRoot, 'src', 'pricing.ts'),
      [
        'export function precioFinal(pedido: Pedido, cliente: Cliente): number {',
        '  if (cliente.esNuevo && !pedido.prepagado) {',
        "    throw new Error('no se puede servir un pedido sin prepago');",
        '  }',
        '  return pedido.importe;',
        '}',
        '',
      ].join('\n'),
      'utf8',
    );
    core.gitInit(sourceRoot);
    core.gitCommitAll(sourceRoot, 'initial');
    const sourceHead = core.gitRevParse(sourceRoot, 'HEAD');
    const graphHead = core.gitRevParse(repo, 'HEAD');
    expect(sourceHead).not.toBe(graphHead);

    const config = core.loadConfig(repo);
    config.sources.code = [{ name: 'erp-externo', path: sourceRoot }];
    core.saveConfig(repo, config);

    const llm = new MockLlmClient([
      {
        ...codeBatch('Prepago de clientes nuevos', 'src/pricing.ts'),
        nodes: [
          {
            mention: 'Prepago de clientes nuevos',
            type: 'rule',
            name: 'Prepago de clientes nuevos',
            description: 'Un cliente nuevo no recibe mercancía sin prepago.',
            evidence: {
              locator: {
                repo: 'erp-externo',
                path: 'src/pricing.ts',
                line_start: 1,
                line_end: 6,
                commit: sourceHead.slice(0, 12),
              },
              excerpt: 'if (cliente.esNuevo && !pedido.prepagado) throw new Error(...)',
            },
          },
        ],
        edges: [],
      },
    ]);
    const app = createApp({ repoRoot: repo, llm });

    const started = await postJson<ExtractStartResponse>(
      app,
      '/api/extract',
      { kind: 'code', source: 'erp-externo' },
      202,
    );
    const job = await waitForJob(app, started.job.id);
    expect(job.phase).toBe('done');

    // The prompt pinned the SOURCE repo's HEAD as the locator base — that is
    // what makes the evidence point at the code that was actually read.
    const prompt = llm.requests[0]!.prompt;
    expect(prompt).toContain(sourceHead.slice(0, 12));
    expect(prompt).not.toContain(graphHead.slice(0, 12));
    // And the locator carries the config source *name*, which is what
    // POST /api/open matches on (a directory basename would break it).
    expect(prompt).toContain('"repo":"erp-externo"');

    const store = core.GraphStore.load(repo);
    const created = [...store.nodes.values()].find((n) => n.name === 'Prepago de clientes nuevos')!;
    expect(created.evidence[0]!.locator).toMatchObject({
      repo: 'erp-externo',
      commit: sourceHead.slice(0, 12),
    });
  });

  // The queue's ordering guarantee itself is asserted in write-queue.test.ts —
  // whether two importBatch calls would really interleave depends on where the
  // pipeline yields, so this is the end-to-end smoke test, not the proof.
  it('lands two concurrent imports as two runs, two commits and a clean tree', async () => {
    const repo = createFixtureRepo();
    const app = createApp({ repoRoot: repo, llm: new MockLlmClient([]) });

    const batch = (n: number) => ({
      run_id: `2026-07-25T10-0${n}-00-document`,
      source_type: 'document',
      extractor: { name: 'test', model: 'test', prompt_version: '1' },
      nodes: [
        {
          mention: `Politica ${n}`,
          type: 'policy',
          name: `Politica ${n}`,
          description: `Norma numero ${n} para la prueba de concurrencia.`,
          evidence: {
            locator: {
              doc_id: 'manual-comercial',
              title: 'Manual comercial',
              section: `2. 4.${n} Pagos`,
            },
            excerpt: `Texto de respaldo de la norma ${n}.`,
          },
        },
      ],
      edges: [],
    });

    // Both land on GraphStore.load → write → commit. Without the write queue in
    // createApp they interleave: the second load snapshots the files before the
    // first has written them, and one of the two nodes is lost.
    const results = await Promise.all([
      postJson<ImportResponse>(app, '/api/import', { batch: batch(1) }),
      postJson<ImportResponse>(app, '/api/import', { batch: batch(2) }),
    ]);
    expect(results.map((r) => r.ok)).toEqual([true, true]);
    expect(results[0]!.commit).not.toBe(results[1]!.commit);

    // Both runs are recorded and both nodes survived.
    const runs = await getJson<RunsResponse>(app, '/api/runs');
    for (const n of [1, 2]) {
      expect(runs.runs.some((r) => r.id === `2026-07-25T10-0${n}-00-document`)).toBe(true);
    }
    const store = core.GraphStore.load(repo);
    const names = [...store.nodes.values()].map((node) => node.name);
    expect(names).toContain('Politica 1');
    expect(names).toContain('Politica 2');
    expect(core.gitStatusClean(repo)).toBe(true);
  });

  it('does not lock out other graph writes while the agent is thinking', async () => {
    const repo = createFixtureRepo();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const llm = new HookedLlmClient(() => DOCS_BATCH, () => gate);
    const app = createApp({ repoRoot: repo, llm });

    const started = await postJson<ExtractStartResponse>(
      app,
      '/api/extract',
      { kind: 'docs', source: 'sources/docs' },
      202,
    );
    await vi.waitFor(() => expect(llm.calls).toBe(1), { timeout: 5000 });

    // Only the import step takes the write queue, not the whole job: the
    // reviewer can still accept a merge while the agent is mid-call.
    const accepted = await postJson<MergeActionResponse>(
      app,
      `/api/review/merge/${FIXTURE_PROPOSAL_ID}/accept`,
      {},
    );
    expect(accepted.ok).toBe(true);
    expect(accepted.commit).toBeTruthy();

    release();
    const job = await waitForJob(app, started.job.id);
    expect(job.phase).toBe('done');
    expect(job.result!.commit).toBeTruthy();
    // Two writes, two distinct commits, and a clean tree: neither clobbered
    // the other's files (docs/03 §7 point 3, one write = one commit).
    expect(job.result!.commit).not.toBe(accepted.commit);
    expect(core.gitStatusClean(repo)).toBe(true);
  });

  it('keeps the batch retrievable when the import fails', async () => {
    const repo = createFixtureRepo();
    const llm = new MockLlmClient([DOCS_BATCH]);
    const app = createApp({ repoRoot: repo, llm });

    const started = await postJson<ExtractStartResponse>(
      app,
      '/api/extract',
      // Spaces are not a legal git branch name: the import blows up after the
      // agent has already been paid for.
      { kind: 'docs', source: 'sources/docs', branch: 'rama con espacios' },
      202,
    );
    const job = await waitForJob(app, started.job.id);
    expect(job.phase).toBe('error');
    expect(job.error).toBeTruthy();
    expect(job.batchAvailable).toBe(true);
    expect(job.message).toContain('batch');

    const batch = await getJson<{ nodes: unknown[] }>(
      app,
      `/api/extract/${started.job.id}/batch`,
    );
    expect(batch.nodes).toHaveLength(1);
  });

  it('finishes without importing when the source yields nothing to extract', async () => {
    const repo = createFixtureRepo();
    const llm = new MockLlmClient([]);
    const app = createApp({ repoRoot: repo, llm });

    // The fixture's checkout.ts has no business-logic signal at all.
    const started = await postJson<ExtractStartResponse>(
      app,
      '/api/extract',
      { kind: 'code', source: 'web-pedidos' },
      202,
    );
    const job = await waitForJob(app, started.job.id);
    expect(job.phase).toBe('done');
    expect(job.units).toBe(0);
    expect(job.llmCalls).toBe(0);
    expect(job.result).toBeUndefined();
    expect(job.message).toContain('nada que extraer');
    // No LLM call was made, so nothing was charged for an empty scan.
    expect(llm.requests).toHaveLength(0);
  });

  it('validates payloads and maps errors to statuses', async () => {
    const repo = createFixtureRepo();
    const app = createApp({ repoRoot: repo, llm: new MockLlmClient([]) });

    const badKind = await postJson<ApiError>(app, '/api/extract/preview', { kind: 'sql' }, 400);
    expect(badKind.error).toContain('kind');
    await postJson<ApiError>(app, '/api/extract', { kind: 'code' }, 400);

    const unknownCode = await postJson<ApiError>(
      app,
      '/api/extract/preview',
      { kind: 'code', source: 'no-existe' },
      404,
    );
    expect(unknownCode.error).toContain('not found');

    const unknownDocs = await postJson<ApiError>(
      app,
      '/api/extract',
      { kind: 'docs', source: 'ninguna/parte' },
      404,
    );
    expect(unknownDocs.error).toContain('not found');

    await getJson<ApiError>(app, '/api/extract/ext-nope', 404);
    await getJson<ApiError>(app, '/api/extract/ext-nope/batch', 404);
    await getJson<ApiError>(app, '/api/extract/ext-nope/events', 404);
    await postJson<ApiError>(app, '/api/extract/ext-nope/cancel', {}, 404);

    // A job with no batch yet answers 404 on /batch rather than an empty body.
    const empty = await postJson<ExtractStartResponse>(
      app,
      '/api/extract',
      { kind: 'code', source: 'web-pedidos' },
      202,
    );
    await waitForJob(app, empty.job.id);
    await getJson<ApiError>(app, `/api/extract/${empty.job.id}/batch`, 404);
  });

  it("honors the config's include/exclude as globs, keeping the scanner's own guards", async () => {
    const repo = createFixtureRepo();
    addCodeSource(repo);
    const src = join(repo, 'sources', 'web-pedidos', 'src');
    // Excluded by the config glob.
    mkdirSync(join(src, 'infra'), { recursive: true });
    writeFileSync(
      join(src, 'infra', 'logging.ts'),
      'export function calcularLatencia(pedido: Pedido) { return 0; }\n',
      'utf8',
    );
    // Selected by the include glob, but the scanner's DEFAULT_EXCLUDE still
    // drops it (…/test/…): a config exclude must not disable those guards.
    writeFileSync(
      join(src, 'checkout.test.ts'),
      'if (cliente.esNuevo && !pedido.prepagado) throw new Error("x");\n',
      'utf8',
    );
    // Never scanned: SKIP_DIRS and DEFAULT_EXCLUDE both cover node_modules.
    mkdirSync(join(repo, 'sources', 'web-pedidos', 'node_modules', 'x'), { recursive: true });
    writeFileSync(
      join(repo, 'sources', 'web-pedidos', 'node_modules', 'x', 'index.ts'),
      'if (cliente.esNuevo) throw new Error("no se puede");\n',
      'utf8',
    );
    core.gitCommitAll(repo, 'test: extra sources');

    // Exactly the shape examples/acme-manufactura/untacit.config.json uses.
    const config = core.loadConfig(repo);
    config.sources.code = [
      {
        name: 'web-pedidos',
        path: 'sources/web-pedidos',
        include: ['src/**/*.ts'],
        exclude: ['src/infra/**'],
      },
    ];
    core.saveConfig(repo, config);
    const app = createApp({ repoRoot: repo, llm: new MockLlmClient([]) });

    const preview = await postJson<ExtractPreviewResponse>(app, '/api/extract/preview', {
      kind: 'code',
      source: 'web-pedidos',
    });
    expect(preview.candidates?.map((cand) => cand.path).sort()).toEqual([
      'src/facturacion.ts',
      'src/pricing.ts',
    ]);
  });

  it('refuses a paths entry that escapes the source root', async () => {
    const repo = createFixtureRepo();
    addCodeSource(repo);
    const app = createApp({ repoRoot: repo, llm: new MockLlmClient([]) });

    for (const path of ['../..', '../../etc', '/etc']) {
      const body = await postJson<ApiError>(
        app,
        '/api/extract/preview',
        { kind: 'code', source: 'web-pedidos', paths: [path] },
        400,
      );
      expect(body.error).toContain('escapes the source root');
    }
    // A legitimate scope still works.
    const scoped = await postJson<ExtractPreviewResponse>(app, '/api/extract/preview', {
      kind: 'code',
      source: 'web-pedidos',
      paths: ['src/pricing.ts'],
    });
    expect(scoped.candidates?.map((cand) => cand.path)).toEqual(['src/pricing.ts']);
  });

  it('clamps a chunk size of 0 instead of looping forever on LLM calls', async () => {
    const repo = createFixtureRepo();
    addCodeSource(repo);
    const llm = new MockLlmClient([codeBatch('Prepago de clientes nuevos', 'src/pricing.ts')]);
    const app = createApp({ repoRoot: repo, llm });

    const preview = await postJson<ExtractPreviewResponse>(app, '/api/extract/preview', {
      kind: 'code',
      source: 'web-pedidos',
      chunkSize: 0,
    });
    // 0 would make Math.ceil(units / 0) === Infinity; clamped to the default 8.
    expect(preview.chunkSize).toBe(8);
    expect(preview.plannedCalls).toBe(1);

    const started = await postJson<ExtractStartResponse>(
      app,
      '/api/extract',
      { kind: 'code', source: 'web-pedidos', chunkSize: 0 },
      202,
    );
    expect(started.job.chunkSize).toBe(8);
    const job = await waitForJob(app, started.job.id);
    expect(job.phase).toBe('done');
    expect(job.llmCalls).toBe(1);
  });

  it('rejects a model id that could reach the shell as argv', async () => {
    const repo = createFixtureRepo();
    const app = createApp({ repoRoot: repo, llm: new MockLlmClient([]) });

    const body = await postJson<ApiError>(
      app,
      '/api/extract',
      { kind: 'docs', source: 'sources/docs', model: 'sonnet & calc.exe' },
      400,
    );
    expect(body.error).toContain('model');
    // Real ids and aliases pass.
    const ok = await postJson<ExtractStartResponse>(
      app,
      '/api/extract',
      { kind: 'docs', source: 'sources/docs', model: 'claude-opus-4-5-20251101' },
      202,
    );
    expect(ok.job.model).toBe('claude-opus-4-5-20251101');
    await waitForJob(app, ok.job.id);
  });

  it('reports a source whose path is gone instead of scanning nothing', async () => {
    const repo = createFixtureRepo();
    const config = core.loadConfig(repo);
    config.sources.code = [{ name: 'fantasma', path: 'sources/no-existe' }];
    core.saveConfig(repo, config);
    const app = createApp({ repoRoot: repo, llm: new MockLlmClient([]) });

    const sources = await getJson<ExtractSourcesResponse>(app, '/api/extract/sources');
    expect(sources.sources.find((s) => s.key === 'fantasma')!.exists).toBe(false);

    const body = await postJson<ApiError>(
      app,
      '/api/extract',
      { kind: 'code', source: 'fantasma' },
      404,
    );
    expect(body.error).toContain('source path not found');
  });

  it('explains how to install Claude Code instead of failing raw', async () => {
    const repo = createFixtureRepo();
    const app = createApp({ repoRoot: repo }); // no injected client → engine is Claude Code
    const restore = withEnv({ UNTACIT_CLAUDE_BIN: '/nonexistent/claude-bin' });
    try {
      const sources = await getJson<ExtractSourcesResponse>(app, '/api/extract/sources');
      expect(sources.llmReady).toBe(false);
      expect(sources.llmDetail).toContain('claude.com/claude-code');
      expect(sources.llmDetail).toContain('UNTACIT_CLAUDE_BIN');

      // Preview still works: it never needs the engine.
      const preview = await postJson<ExtractPreviewResponse>(app, '/api/extract/preview', {
        kind: 'docs',
        source: 'sources/docs',
      });
      expect(preview.sections).toHaveLength(1);

      const body = await postJson<ApiError>(
        app,
        '/api/extract',
        { kind: 'docs', source: 'sources/docs' },
        503,
      );
      expect(body.error).toContain('motor de extracción');
      expect(body.detail).toContain('claude.com/claude-code');
    } finally {
      restore();
    }
  });

  it('drives the real Claude Code client, passing the chosen --model', async () => {
    const repo = createFixtureRepo();
    // No injected client: the sidecar builds a real ClaudeCodeLlmClient and
    // spawns the "binary" below, which records its argv and answers a batch.
    const app = createApp({ repoRoot: repo });
    const { bin, argvLog, readInvocations } = writeRecordingClaudeStub(repo, DOCS_BATCH);
    const restore = withEnv({
      UNTACIT_CLAUDE_BIN: bin,
      UNTACIT_TEST_STUB_LOG: argvLog,
      UNTACIT_TEST_STUB_RESULT: JSON.stringify(DOCS_BATCH),
    });
    try {
      const started = await postJson<ExtractStartResponse>(
        app,
        '/api/extract',
        { kind: 'docs', source: 'sources/docs', model: 'sonnet' },
        202,
      );
      expect(started.job.model).toBe('sonnet');

      const job = await waitForJob(app, started.job.id);
      expect(job.phase).toBe('done');
      expect(job.llmCalls).toBe(1);
      expect(job.result!.commit).toBeTruthy();
      expect(job.result!.stats.nodes_created).toBe(1);

      // The model reached the CLI, tools stayed disabled, and no API key was
      // ever involved (print mode over the local binary).
      const invocations = readInvocations();
      expect(invocations).toHaveLength(1);
      const argv = invocations[0]!.argv;
      expect(argv[argv.indexOf('--model') + 1]).toBe('sonnet');
      expect(argv).toContain('--print');
      expect(argv[argv.indexOf('--tools') + 1]).toBe('');
    } finally {
      restore();
    }
  });
});
