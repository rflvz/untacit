/**
 * Interview endpoint tests (Fase 4): full session over the fixture repo with
 * a scripted mock LLM — start (gap-driven script), turns with live proposals,
 * accept/edit/reject + bulk, verification verdicts, finish → import + commit.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as core from '@untacit/core';
import { MockLlmClient } from '@untacit/extractors';
import type { Hono } from 'hono';
import type {
  ApiError,
  InterviewAcceptAllResponse,
  InterviewAnswerResponse,
  InterviewFinishResponse,
  InterviewGapsResponse,
  InterviewProposalResponse,
  InterviewStartResponse,
  StatsResponse,
} from '../src/api-types.js';
import { createApp } from './app.js';
import { createFixtureRepo } from './fixture.js';

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

const SCRIPT_RESPONSE = {
  questions: ['¿Quién lleva la facturación y cómo funciona?', '¿Qué pasa si un cliente no paga?'],
};

const TURN_1 = {
  run_id: 'pending',
  source_type: 'interview',
  reply: '¿Y qué ocurre exactamente si el cobro falla?',
  topic_done: false,
  nodes: [
    {
      mention: 'Facturación mensual',
      type: 'process',
      name: 'Facturación mensual',
      description: 'Emisión de facturas al cierre de mes.',
      evidence: {
        locator: { interview_id: 'x', speaker_role: 'administracion', turn: 1 },
        excerpt: 'La facturación la hago yo entera a fin de mes.',
      },
    },
    {
      mention: 'Administración',
      type: 'role',
      name: 'Administración',
      description: 'Rol de facturación y cobros.',
      evidence: {
        locator: { interview_id: 'x', speaker_role: 'administracion', turn: 1 },
        excerpt: 'En administración llevamos la facturación.',
      },
    },
  ],
  edges: [
    {
      type: 'EXECUTES',
      source_mention: 'Administración',
      target_mention: 'Facturación mensual',
      evidence: {
        locator: { interview_id: 'x', speaker_role: 'administracion', turn: 1 },
        excerpt: 'La facturación la hago yo entera.',
      },
    },
  ],
};

const EMPTY_TURN = {
  run_id: 'pending',
  source_type: 'interview',
  reply: 'Entendido, gracias.',
  topic_done: true,
  nodes: [],
  edges: [],
};

describe('interview session over the sidecar', () => {
  it('runs the full protocol: gaps → start → turns → validation → finish (run + commit)', async () => {
    const repo = createFixtureRepo();
    const llm = new MockLlmClient([SCRIPT_RESPONSE, TURN_1, EMPTY_TURN]);
    const app = createApp({ repoRoot: repo, llm });

    // Gap preview: the fixture's only sub-threshold edge is EXECUTES (0.6).
    const gaps = await getJson<InterviewGapsResponse>(app, '/api/interview/gaps');
    expect(gaps.llmReady).toBe(true);
    expect(gaps.gaps.some((g) => g.kind === 'low-confidence-edge')).toBe(true);
    expect(gaps.verifications).toHaveLength(1);
    expect(gaps.verifications[0]).toMatchObject({
      sourceId: 'role-comercial',
      edgeType: 'EXECUTES',
      targetId: 'process-alta-pedido',
      confidence: 0.6,
    });
    expect(gaps.verifications[0].statement).toBe('«Comercial» ejecuta «Alta de pedido»');

    // Start: script generated from gaps, verification lands in the panel.
    const started = await postJson<InterviewStartResponse>(app, '/api/interview/start', {
      role: 'administracion',
    });
    const id = started.state.interviewId;
    expect(started.state.script).toEqual(SCRIPT_RESPONSE.questions);
    expect(started.state.transcript[0].speaker).toBe('agent');
    expect(started.state.transcript[0].text).toContain(SCRIPT_RESPONSE.questions[0]);
    expect(started.state.proposals).toHaveLength(1);
    expect(started.state.proposals[0]).toMatchObject({ id: 'v1', kind: 'verification' });
    // The script prompt was built from the actual graph gaps.
    expect(llm.requests[0].prompt).toContain('Confirmar o refutar');

    // Reload does not lose the session.
    const reloaded = await getJson<InterviewStartResponse>(app, `/api/interview/${id}`);
    expect(reloaded.state.interviewId).toBe(id);

    // Turn 1: triples proposed live, agent repregunta (topic_done false).
    const turn1 = await postJson<InterviewAnswerResponse>(app, `/api/interview/${id}/answer`, {
      text: 'La facturación la hago yo entera a fin de mes.',
    });
    expect(turn1.proposals.map((p) => p.id)).toEqual(['p1', 'p2', 'p3']);
    expect(turn1.reply).toBe('¿Y qué ocurre exactamente si el cobro falla?');
    expect(turn1.finished).toBe(false);

    // Turn 2: topic done → the engine advances to the second scripted question.
    const turn2 = await postJson<InterviewAnswerResponse>(app, `/api/interview/${id}/answer`, {
      text: 'Se bloquea el pedido siguiente hasta que pague.',
    });
    expect(turn2.reply).toContain(SCRIPT_RESPONSE.questions[1]);

    // Live validation: edit a node, reject the role, bulk-accept the rest.
    const edited = await postJson<InterviewProposalResponse>(
      app,
      `/api/interview/${id}/proposal/p1`,
      { action: 'edit', patch: { name: 'Facturación de fin de mes' } },
    );
    expect(edited.proposal.statement).toContain('«Facturación de fin de mes»');

    await postJson<InterviewProposalResponse>(app, `/api/interview/${id}/proposal/p2`, {
      action: 'reject',
    });
    const bulk = await postJson<InterviewAcceptAllResponse>(app, `/api/interview/${id}/accept-all`, {});
    expect(bulk.accepted).toEqual(['p1', 'p3']);

    // Cross-verification: confirm the low-confidence EXECUTES claim.
    const confirmed = await postJson<InterviewProposalResponse>(
      app,
      `/api/interview/${id}/proposal/v1`,
      { action: 'confirm' },
    );
    expect(confirmed.proposal.status).toBe('confirmed');

    // Finish: batch → import → commit. p3 (edge) cascades out because its
    // source endpoint (Administración, p2) was rejected.
    const finish = await postJson<InterviewFinishResponse>(app, `/api/interview/${id}/finish`);
    expect(finish.ok).toBe(true);
    expect(finish.noop).toBe(false);
    expect(finish.commit).toBeTruthy();
    expect(finish.acceptedProposals).toBe(2);
    expect(finish.verificationsResolved).toBe(1);
    expect(finish.stats.nodes_created).toBe(1); // Facturación de fin de mes

    // The confirmed edge now carries live-validated evidence → 0.95, and the
    // graph repo is clean (one run = one commit).
    const store = core.GraphStore.load(repo);
    const executes = store
      .getNode('role-comercial')!
      .edges.find((e) => e.type === 'EXECUTES' && e.target === 'process/process-alta-pedido')!;
    expect(executes.confidence).toBe(0.95);
    expect(executes.evidence.some((ev) => ev.validated_by === 'administracion')).toBe(true);
    expect(core.gitStatusClean(repo)).toBe(true);

    const runs = core.listRuns(repo);
    expect(runs.some((r) => r.source_type === 'interview')).toBe(true);

    // The session is gone after finish.
    await getJson<ApiError>(app, `/api/interview/${id}`, 404);
  });

  it('refuting a verification opens a conflict on the existing edge', async () => {
    const repo = createFixtureRepo();
    const llm = new MockLlmClient([SCRIPT_RESPONSE]);
    const app = createApp({ repoRoot: repo, llm });

    const before = await getJson<StatsResponse>(app, '/api/stats');
    const started = await postJson<InterviewStartResponse>(app, '/api/interview/start', {
      role: 'produccion',
    });
    const id = started.state.interviewId;

    await postJson<InterviewProposalResponse>(app, `/api/interview/${id}/proposal/v1`, {
      action: 'refute',
    });
    const finish = await postJson<InterviewFinishResponse>(app, `/api/interview/${id}/finish`);
    expect(finish.rejections).toEqual([]);
    expect(finish.commit).toBeTruthy();

    const after = await getJson<StatsResponse>(app, '/api/stats');
    expect(after.conflicts_open).toBe(before.conflicts_open + 1);

    const store = core.GraphStore.load(repo);
    const executes = store
      .getNode('role-comercial')!
      .edges.find((e) => e.type === 'EXECUTES' && e.target === 'process/process-alta-pedido')!;
    expect(executes.status).toBe('conflicted');
    expect(
      executes.evidence.some((ev) => ev.stance === 'contradicts' && ev.validated_by === 'produccion'),
    ).toBe(true);
  });

  it('validates payloads and maps errors to statuses', async () => {
    const repo = createFixtureRepo();
    const llm = new MockLlmClient([SCRIPT_RESPONSE, EMPTY_TURN]);
    const app = createApp({ repoRoot: repo, llm });

    const noRole = await postJson<ApiError>(app, '/api/interview/start', {}, 400);
    expect(noRole.error).toContain('role');

    await getJson<ApiError>(app, '/api/interview/int-nope', 404);
    await postJson<ApiError>(app, '/api/interview/int-nope/answer', { text: 'hola' }, 404);

    const started = await postJson<InterviewStartResponse>(app, '/api/interview/start', {
      role: 'administracion',
    });
    const id = started.state.interviewId;

    const noText = await postJson<ApiError>(app, `/api/interview/${id}/answer`, {}, 400);
    expect(noText.error).toContain('text');

    const badAction = await postJson<ApiError>(
      app,
      `/api/interview/${id}/proposal/v1`,
      { action: 'promote' },
      400,
    );
    expect(badAction.error).toContain('unknown action');

    const missingProposal = await postJson<ApiError>(
      app,
      `/api/interview/${id}/proposal/p99`,
      { action: 'accept' },
      404,
    );
    expect(missingProposal.error).toContain('not found');

    // accept/reject on a verification demands a verdict instead — client error.
    const wrongKind = await postJson<ApiError>(
      app,
      `/api/interview/${id}/proposal/v1`,
      { action: 'accept' },
      400,
    );
    expect(wrongKind.error).toContain('confirm/refute/skip');
  });

  it('answers 503 with an actionable message when Claude Code is not reachable', async () => {
    const repo = createFixtureRepo();
    const app = createApp({ repoRoot: repo }); // no injected client → engine is Claude Code
    const savedBin = process.env.UNTACIT_CLAUDE_BIN;
    process.env.UNTACIT_CLAUDE_BIN = '/nonexistent/claude-bin';
    try {
      const gaps = await getJson<InterviewGapsResponse>(app, '/api/interview/gaps');
      expect(gaps.llmReady).toBe(false);
      expect(gaps.llmDetail).toContain('Claude Code');
      expect(gaps.llmDetail).toContain('MCP');

      const body = await postJson<ApiError>(app, '/api/interview/start', { role: 'gerencia' }, 503);
      expect(body.error).toContain('LLM');
      expect(body.detail).toContain('Claude Code');
    } finally {
      if (savedBin === undefined) delete process.env.UNTACIT_CLAUDE_BIN;
      else process.env.UNTACIT_CLAUDE_BIN = savedBin;
    }
  });
});
