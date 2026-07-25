/**
 * Interview persistence tests (desktop Fase 2): the sidecar writes the same
 * resumable snapshot the CLI's `untacit interview --resume` reads, so closing
 * the app or switching repos no longer loses the sitting.
 *
 * The invariant under test above all others: **the transcript never reaches
 * disk**. Only role, script, script index and proposals do (docs/05
 * §auditoría-privacidad) — the agent's conversational turns must be absent
 * from the persisted file.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as core from '@untacit/core';
import { MockLlmClient } from '@untacit/extractors';
import type { PersistedInterview } from '@untacit/extractors';
import type { Hono } from 'hono';
import type {
  ApiError,
  InterviewAcceptAllResponse,
  InterviewAnswerResponse,
  InterviewDiscardResponse,
  InterviewFinishResponse,
  InterviewGapsResponse,
  InterviewProposalResponse,
  InterviewSavedResponse,
  InterviewStartResponse,
} from '../src/api-types.js';
import { createApp } from './app.js';
import { createFixtureRepo, withEnv, writeRecordingClaudeStub } from './fixture.js';

async function getJson<T>(app: Hono, path: string, expectedStatus = 200): Promise<T> {
  const res = await app.request(path);
  expect(res.status).toBe(expectedStatus);
  return (await res.json()) as T;
}

async function sendJson<T>(
  app: Hono,
  method: 'POST' | 'DELETE',
  path: string,
  body: unknown = {},
  expectedStatus = 200,
): Promise<T> {
  const res = await app.request(path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  expect(res.status).toBe(expectedStatus);
  return (await res.json()) as T;
}

const postJson = <T>(app: Hono, path: string, body: unknown = {}, expectedStatus = 200) =>
  sendJson<T>(app, 'POST', path, body, expectedStatus);

const SCRIPT_RESPONSE = {
  questions: ['¿Quién lleva la facturación y cómo funciona?', '¿Qué pasa si un cliente no paga?'],
};

/** The agent's conversational reply: purely transcript, never persistable. */
const AGENT_REPLY = '¿Y qué ocurre exactamente si el cobro falla?';

/**
 * What the interviewee types. Deliberately NOT byte-identical to the evidence
 * excerpt below, and carrying a sentence the excerpt does not quote: an excerpt
 * ≤300 chars is supposed to reach disk, the rest of the answer is not, and with
 * the two identical a leak of the whole answer would be undetectable.
 */
const INTERVIEWEE_ANSWER =
  'La facturación la hago yo entera a fin de mes. Y entre nosotros, a Pepe le pasamos las de Acme sin revisar.';
/** The part of that answer the agent quoted as evidence — this one may persist. */
const EVIDENCE_EXCERPT = 'La facturación la hago yo entera a fin de mes.';
/** The part that is pure conversation and must never reach disk. */
const OFF_THE_RECORD = 'a Pepe le pasamos las de Acme sin revisar';

const TURN_1 = {
  run_id: 'pending',
  source_type: 'interview',
  reply: AGENT_REPLY,
  topic_done: false,
  nodes: [
    {
      mention: 'Facturación mensual',
      type: 'process',
      name: 'Facturación mensual',
      description: 'Emisión de facturas al cierre de mes.',
      evidence: {
        locator: { interview_id: 'x', speaker_role: 'administracion', turn: 1 },
        excerpt: EVIDENCE_EXCERPT,
      },
    },
  ],
  edges: [],
};

const readSnapshot = (repo: string): PersistedInterview =>
  JSON.parse(readFileSync(core.interviewSessionPath(repo), 'utf8')) as PersistedInterview;

describe('interview session persistence and resume', () => {
  it('persists role, script and proposals after every turn — never the transcript', async () => {
    const repo = createFixtureRepo();
    const app = createApp({ repoRoot: repo, llm: new MockLlmClient([SCRIPT_RESPONSE, TURN_1]) });
    const sessionPath = core.interviewSessionPath(repo);

    const started = await postJson<InterviewStartResponse>(app, '/api/interview/start', {
      role: 'administracion',
    });
    const id = started.state.interviewId;

    // Saved from the very first write: the generated script is real LLM spend.
    expect(existsSync(sessionPath)).toBe(true);
    const afterStart = readSnapshot(repo);
    expect(afterStart.version).toBe(1);
    expect(afterStart.savedAt).toBeTruthy();
    expect(afterStart.state.interviewId).toBe(id);
    expect(afterStart.state.speakerRole).toBe('administracion');
    expect(afterStart.state.script).toEqual(SCRIPT_RESPONSE.questions);
    // The privacy invariant, structurally: there is no transcript field at all.
    expect('transcript' in afterStart.state).toBe(false);

    await postJson<InterviewAnswerResponse>(app, `/api/interview/${id}/answer`, {
      text: INTERVIEWEE_ANSWER,
    });

    const afterTurn = readSnapshot(repo);
    expect(afterTurn.state.turn).toBe(1);
    expect(afterTurn.state.proposals.some((p) => p.kind === 'node')).toBe(true);
    expect('transcript' in afterTurn.state).toBe(false);

    const raw = readFileSync(sessionPath, 'utf8');
    // Neither side of the conversation is in the file: not the agent's reply,
    // and not the interviewee's answer — only the excerpt the agent quoted as
    // evidence, which is what an import materializes anyway (≤300 chars).
    expect(raw).not.toContain(AGENT_REPLY);
    expect(raw).not.toContain(INTERVIEWEE_ANSWER);
    expect(raw).not.toContain(OFF_THE_RECORD);
    expect(raw).toContain(EVIDENCE_EXCERPT);

    // And the snapshot lives under .untacit/, so it is never committed.
    expect(sessionPath.includes(core.INDEX_DIR)).toBe(true);
    expect(core.gitStatusClean(repo)).toBe(true);
  });

  it('persists every validation decision so a resume does not re-ask them', async () => {
    const repo = createFixtureRepo();
    const app = createApp({ repoRoot: repo, llm: new MockLlmClient([SCRIPT_RESPONSE, TURN_1]) });

    const started = await postJson<InterviewStartResponse>(app, '/api/interview/start', {
      role: 'administracion',
    });
    const id = started.state.interviewId;

    // The fixture's one low-confidence edge lands as verification v1.
    await postJson<InterviewProposalResponse>(app, `/api/interview/${id}/proposal/v1`, {
      action: 'confirm',
    });
    expect(readSnapshot(repo).state.proposals.find((p) => p.id === 'v1')!.status).toBe('confirmed');

    await postJson<InterviewAnswerResponse>(app, `/api/interview/${id}/answer`, {
      text: INTERVIEWEE_ANSWER,
    });
    expect(readSnapshot(repo).state.proposals.find((p) => p.id === 'p1')!.status).toBe('proposed');

    // A correction persists too, not just a status flip.
    await postJson<InterviewProposalResponse>(app, `/api/interview/${id}/proposal/p1`, {
      action: 'edit',
      patch: { name: 'Facturación de fin de mes' },
    });
    expect(readSnapshot(repo).state.proposals.find((p) => p.id === 'p1')!.node!.name).toBe(
      'Facturación de fin de mes',
    );

    // And accept-all is what flips it: p1 is still pending when it runs.
    const bulk = await postJson<InterviewAcceptAllResponse>(
      app,
      `/api/interview/${id}/accept-all`,
      {},
    );
    expect(bulk.accepted).toEqual(['p1']);
    const snapshot = readSnapshot(repo);
    expect(snapshot.state.proposals.find((p) => p.id === 'p1')!.status).toBe('accepted');
    expect(
      snapshot.state.proposals.filter((p) => p.kind !== 'verification' && p.status === 'proposed'),
    ).toHaveLength(0);
  });

  it('reports the saved session and resumes it in a brand-new sidecar', async () => {
    const repo = createFixtureRepo();
    const first = createApp({ repoRoot: repo, llm: new MockLlmClient([SCRIPT_RESPONSE, TURN_1]) });

    const started = await postJson<InterviewStartResponse>(first, '/api/interview/start', {
      role: 'administracion',
    });
    const id = started.state.interviewId;
    await postJson<InterviewAnswerResponse>(first, `/api/interview/${id}/answer`, {
      text: INTERVIEWEE_ANSWER,
    });

    // A new app = the app reopened (or the repo switched back): memory is gone.
    const reopened = createApp({ repoRoot: repo, llm: new MockLlmClient([]) });
    await getJson<ApiError>(reopened, `/api/interview/${id}`, 404);

    const saved = (await getJson<InterviewSavedResponse>(reopened, '/api/interview/saved')).saved!;
    expect(saved).toMatchObject({
      interviewId: id,
      speakerRole: 'administracion',
      turn: 1,
      pending: 1,
      accepted: 0,
      verificationsPending: 1,
      finished: false,
      live: false,
    });
    expect(saved.script).toEqual(SCRIPT_RESPONSE.questions);

    // The start screen sees it through /gaps too, without a second request.
    const gaps = await getJson<InterviewGapsResponse>(reopened, '/api/interview/gaps');
    expect(gaps.saved?.interviewId).toBe(id);

    const resumed = await postJson<InterviewStartResponse>(reopened, '/api/interview/resume');
    expect(resumed.resumed).toBe(true);
    expect(resumed.state.interviewId).toBe(id);
    expect(resumed.state.speakerRole).toBe('administracion');
    expect(resumed.state.proposals.map((p) => p.id)).toEqual(['v1', 'p1']);
    // The transcript restarts with the engine's recap turn — the conversation
    // itself was never stored, and the recap is the only anchoring there is.
    expect(resumed.state.transcript).toHaveLength(1);
    expect(resumed.state.transcript[0].speaker).toBe('agent');
    expect(resumed.state.transcript[0].text).toContain('Retomamos');
    expect(resumed.state.transcript[0].text).not.toContain(AGENT_REPLY);

    // It is live again: the normal session routes work on it.
    const reloaded = await getJson<InterviewStartResponse>(reopened, `/api/interview/${id}`);
    expect(reloaded.state.interviewId).toBe(id);
    expect((await getJson<InterviewSavedResponse>(reopened, '/api/interview/saved')).saved!.live).toBe(
      true,
    );
  });

  it('finishing a resumed session imports it and clears the snapshot', async () => {
    const repo = createFixtureRepo();
    const first = createApp({ repoRoot: repo, llm: new MockLlmClient([SCRIPT_RESPONSE, TURN_1]) });
    const started = await postJson<InterviewStartResponse>(first, '/api/interview/start', {
      role: 'administracion',
    });
    const id = started.state.interviewId;
    await postJson<InterviewAnswerResponse>(first, `/api/interview/${id}/answer`, {
      text: INTERVIEWEE_ANSWER,
    });

    const reopened = createApp({ repoRoot: repo, llm: new MockLlmClient([]) });
    await postJson<InterviewStartResponse>(reopened, '/api/interview/resume');
    await postJson<{ accepted: string[] }>(reopened, `/api/interview/${id}/accept-all`, {});

    const finish = await postJson<InterviewFinishResponse>(
      reopened,
      `/api/interview/${id}/finish`,
    );
    expect(finish.ok).toBe(true);
    expect(finish.commit).toBeTruthy();
    expect(finish.stats.nodes_created).toBe(1);

    // A finished interview leaves nothing to resume, in memory or on disk.
    expect(existsSync(core.interviewSessionPath(repo))).toBe(false);
    expect((await getJson<InterviewSavedResponse>(reopened, '/api/interview/saved')).saved).toBeNull();
    await postJson<ApiError>(reopened, '/api/interview/resume', {}, 404);
    expect(core.gitStatusClean(repo)).toBe(true);
  });

  it('a failed import keeps the session resumable instead of losing the conversation', async () => {
    const repo = createFixtureRepo();
    const app = createApp({ repoRoot: repo, llm: new MockLlmClient([SCRIPT_RESPONSE, TURN_1]) });
    const started = await postJson<InterviewStartResponse>(app, '/api/interview/start', {
      role: 'administracion',
    });
    const id = started.state.interviewId;
    await postJson<InterviewAnswerResponse>(app, `/api/interview/${id}/answer`, {
      text: INTERVIEWEE_ANSWER,
    });
    await postJson<{ accepted: string[] }>(app, `/api/interview/${id}/accept-all`, {});

    // Break the import before it writes anything: a hand-mangled node file
    // makes GraphStore.load refuse to open the graph.
    writeFileSync(
      core.nodeFilePath(repo, 'entity', 'entity-cliente'),
      'esto ya no es un nodo canónico\n',
      'utf8',
    );

    const res = await app.request(`/api/interview/${id}/finish`, { method: 'POST' });
    expect(res.status).toBeGreaterThanOrEqual(400);

    // The session survived the failure — the sitting is not lost.
    expect(existsSync(core.interviewSessionPath(repo))).toBe(true);
    const saved = (await getJson<InterviewSavedResponse>(app, '/api/interview/saved')).saved!;
    expect(saved.interviewId).toBe(id);
    expect(saved.accepted).toBe(1);
  });

  it('refuses to start over an interrupted session unless told to discard it', async () => {
    const repo = createFixtureRepo();
    const app = createApp({
      repoRoot: repo,
      llm: new MockLlmClient([SCRIPT_RESPONSE, SCRIPT_RESPONSE, SCRIPT_RESPONSE]),
    });

    const first = await postJson<InterviewStartResponse>(app, '/api/interview/start', {
      role: 'administracion',
    });

    // Starting again would overwrite work that cost a real conversation, which
    // the CLI refuses without a typed confirmation. The 409 says what to do.
    const blocked = await postJson<ApiError>(
      app,
      '/api/interview/start',
      { role: 'produccion' },
      409,
    );
    expect(blocked.error).toContain('sin terminar');
    expect(blocked.detail).toContain('resume');
    expect(blocked.detail).toContain('discardSaved');
    // Nothing changed: the original session is still the resumable one.
    expect(readSnapshot(repo).state.interviewId).toBe(first.state.interviewId);
    expect(readSnapshot(repo).state.speakerRole).toBe('administracion');

    // Explicit opt-in replaces it.
    const replaced = await postJson<InterviewStartResponse>(app, '/api/interview/start', {
      role: 'produccion',
      discardSaved: true,
    });
    expect(replaced.state.interviewId).not.toBe(first.state.interviewId);
    expect(readSnapshot(repo).state.speakerRole).toBe('produccion');

    // So does discarding first (what the app's Descartar button does).
    await sendJson<InterviewDiscardResponse>(app, 'DELETE', '/api/interview/saved');
    const afterDiscard = await postJson<InterviewStartResponse>(app, '/api/interview/start', {
      role: 'gerencia',
    });
    expect(afterDiscard.state.speakerRole).toBe('gerencia');
  });

  it('rejects a model id that could reach the shell as argv', async () => {
    const repo = createFixtureRepo();
    const app = createApp({ repoRoot: repo, llm: new MockLlmClient([SCRIPT_RESPONSE]) });

    const body = await postJson<ApiError>(
      app,
      '/api/interview/start',
      { role: 'administracion', model: 'opus | rm -rf /' },
      400,
    );
    expect(body.error).toContain('model');
    // The rejected request must not have left a session behind.
    expect(existsSync(core.interviewSessionPath(repo))).toBe(false);
  });

  it('discards the saved session on request', async () => {
    const repo = createFixtureRepo();
    const app = createApp({ repoRoot: repo, llm: new MockLlmClient([SCRIPT_RESPONSE]) });
    const started = await postJson<InterviewStartResponse>(app, '/api/interview/start', {
      role: 'produccion',
    });

    const discarded = await sendJson<InterviewDiscardResponse>(
      app,
      'DELETE',
      '/api/interview/saved',
    );
    expect(discarded).toEqual({ ok: true, discarded: true });
    expect(existsSync(core.interviewSessionPath(repo))).toBe(false);
    // The live session went with it, so nothing is left half-alive.
    await getJson<ApiError>(app, `/api/interview/${started.state.interviewId}`, 404);
    await postJson<ApiError>(app, '/api/interview/resume', {}, 404);

    // Idempotent: discarding nothing is not an error.
    const again = await sendJson<InterviewDiscardResponse>(app, 'DELETE', '/api/interview/saved');
    expect(again).toEqual({ ok: true, discarded: false });
  });

  it('refuses an unreadable or future-version snapshot, and lets it be discarded', async () => {
    const repo = createFixtureRepo();
    const app = createApp({ repoRoot: repo, llm: new MockLlmClient([SCRIPT_RESPONSE]) });
    const path = core.interviewSessionPath(repo);

    await postJson<InterviewStartResponse>(app, '/api/interview/start', { role: 'gerencia' });
    const snapshot = readSnapshot(repo);
    writeFileSync(path, JSON.stringify({ ...snapshot, version: 99 }), 'utf8');

    const conflict = await getJson<ApiError>(app, '/api/interview/saved', 409);
    expect(conflict.detail).toContain('versión de sesión desconocida');
    const onResume = await postJson<ApiError>(app, '/api/interview/resume', {}, 409);
    expect(onResume.detail).toContain('99');
    // /gaps stays usable (it reports null) so the start screen still renders.
    expect((await getJson<InterviewGapsResponse>(app, '/api/interview/gaps')).saved).toBeNull();

    await sendJson<InterviewDiscardResponse>(app, 'DELETE', '/api/interview/saved');
    expect(existsSync(path)).toBe(false);

    writeFileSync(path, '{ not json', 'utf8');
    const broken = await getJson<ApiError>(app, '/api/interview/saved', 409);
    expect(broken.detail).toContain('ilegible');
  });

  it('never deletes a snapshot that belongs to another session', async () => {
    const repo = createFixtureRepo();
    const app = createApp({ repoRoot: repo, llm: new MockLlmClient([SCRIPT_RESPONSE, TURN_1]) });
    const started = await postJson<InterviewStartResponse>(app, '/api/interview/start', {
      role: 'administracion',
    });
    const id = started.state.interviewId;
    await postJson<InterviewAnswerResponse>(app, `/api/interview/${id}/answer`, {
      text: INTERVIEWEE_ANSWER,
    });
    await postJson<{ accepted: string[] }>(app, `/api/interview/${id}/accept-all`, {});

    // Simulate a concurrent CLI interview over the same graph repo overwriting
    // the file between our last turn and our finish.
    const snapshot = readSnapshot(repo);
    const foreign: PersistedInterview = {
      ...snapshot,
      state: { ...snapshot.state, interviewId: 'int-desde-la-cli', speakerRole: 'produccion' },
    };
    writeFileSync(core.interviewSessionPath(repo), JSON.stringify(foreign, null, 2), 'utf8');

    const finish = await postJson<InterviewFinishResponse>(app, `/api/interview/${id}/finish`);
    expect(finish.ok).toBe(true);
    // The other session's resumable work is still there.
    const saved = (await getJson<InterviewSavedResponse>(app, '/api/interview/saved')).saved!;
    expect(saved.interviewId).toBe('int-desde-la-cli');
  });

  it('honors the model on start and on resume, down to the claude argv', async () => {
    const repo = createFixtureRepo();
    // Injected client: the response only has to echo the chosen model back.
    const mocked = createApp({ repoRoot: repo, llm: new MockLlmClient([SCRIPT_RESPONSE]) });
    const started = await postJson<InterviewStartResponse>(mocked, '/api/interview/start', {
      role: 'administracion',
      model: 'opus',
    });
    expect(started.model).toBe('opus');
    const reloaded = await getJson<InterviewStartResponse>(
      mocked,
      `/api/interview/${started.state.interviewId}`,
    );
    expect(reloaded.model).toBe('opus');

    // Resume may re-pick it, exactly like `untacit interview --resume --model`.
    const reopened = createApp({ repoRoot: repo, llm: new MockLlmClient([]) });
    const resumed = await postJson<InterviewStartResponse>(reopened, '/api/interview/resume', {
      model: 'haiku',
    });
    expect(resumed.model).toBe('haiku');

    // And with the real client (no injected mock), the model reaches the CLI
    // invocation — a fresh repo so this app builds its own engine client.
    const repo2 = createFixtureRepo();
    const engine = createApp({ repoRoot: repo2 });
    const stub = writeRecordingClaudeStub(repo2, SCRIPT_RESPONSE);
    const restore = withEnv({
      UNTACIT_CLAUDE_BIN: stub.bin,
      UNTACIT_TEST_STUB_LOG: stub.argvLog,
      UNTACIT_TEST_STUB_RESULT: JSON.stringify(SCRIPT_RESPONSE),
    });
    try {
      const engineStart = await postJson<InterviewStartResponse>(engine, '/api/interview/start', {
        role: 'administracion',
        model: 'sonnet',
      });
      expect(engineStart.model).toBe('sonnet');
      expect(engineStart.state.script).toEqual(SCRIPT_RESPONSE.questions);
      const startArgv = stub.readInvocations()[0]!.argv;
      expect(startArgv[startArgv.indexOf('--model') + 1]).toBe('sonnet');
      // No API key path anywhere: the engine is the local binary in print mode.
      expect(startArgv).toContain('--print');

      // Resume with a different model, then take a turn: the model chosen at
      // resume is the one the conversation actually runs on from then on.
      const reopenedEngine = createApp({ repoRoot: repo2 });
      const engineResume = await postJson<InterviewStartResponse>(
        reopenedEngine,
        '/api/interview/resume',
        { model: 'haiku' },
      );
      expect(engineResume.model).toBe('haiku');

      process.env.UNTACIT_TEST_STUB_RESULT = JSON.stringify(TURN_1);
      await postJson<InterviewAnswerResponse>(
        reopenedEngine,
        `/api/interview/${engineResume.state.interviewId}/answer`,
        { text: INTERVIEWEE_ANSWER },
      );
      const invocations = stub.readInvocations();
      expect(invocations).toHaveLength(2);
      const turnArgv = invocations[1]!.argv;
      expect(turnArgv[turnArgv.indexOf('--model') + 1]).toBe('haiku');
      // The answer travelled over stdin, never in argv (and never to a disk log).
      expect(invocations[1]!.stdin).toContain(INTERVIEWEE_ANSWER);
      expect(turnArgv.join(' ')).not.toContain(INTERVIEWEE_ANSWER);
    } finally {
      restore();
    }
  });
});
