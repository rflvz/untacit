/**
 * Interview routes (Fase 4, docs/03 §4.3): the sidecar face of the
 * extractor-interview engine.
 *
 * **The transcript is never persisted.** Live sessions keep it in memory only;
 * what reaches disk between turns is the resumable snapshot the CLI already
 * writes — role, script, script index and proposals, and nothing else
 * (`serializeInterview` strips the transcript; docs/03 §8, audit in
 * docs/05-auditoria-privacidad.md). What reaches the graph repo is the
 * interview run that /finish imports and commits (excerpts ≤ 300 chars, role,
 * no names).
 *
 * Resume uses the very same file and format as `untacit interview --resume`:
 * `.untacit/interview-session.json` (`interviewSessionPath` in core), version
 * 1, written atomically (tmp + rename) after every turn and every validation
 * action. So a session started in the app can be finished from the terminal
 * and vice versa; closing the app or switching repos no longer loses it.
 *
 * The LLM client is injected for tests; in production the engine is Claude
 * Code — ClaudeCodeLlmClient drives the local `claude` CLI with whatever
 * authentication Claude Code already has (no ANTHROPIC_API_KEY anywhere), with
 * an optional per-session model (the CLI's `--model`).
 * Missing extractors or Claude Code → 503 with an actionable message.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Context, Hono } from 'hono';
import type {
  ApiError,
  InterviewAcceptAllRequest,
  InterviewAcceptAllResponse,
  InterviewAnswerRequest,
  InterviewAnswerResponse,
  InterviewDiscardResponse,
  InterviewFinishResponse,
  InterviewGapsResponse,
  InterviewProposalRequest,
  InterviewProposalResponse,
  InterviewResumeRequest,
  InterviewSavedResponse,
  InterviewSavedSession,
  InterviewStartRequest,
  InterviewStartResponse,
  InterviewStateResponse,
} from '../src/api-types.js';
import type { CoreModule } from './core-loader.js';
import { extractorsLoadError, loadExtractors, type ExtractorsModule } from './extractors-loader.js';

// Engine types, erased at compile time (runtime goes through the loader).
import type {
  CoverageGap,
  InterviewState,
  LlmClient,
  PersistedInterview,
} from '@untacit/extractors';

type GraphIndexInstance = ReturnType<CoreModule['GraphIndex']['open']>;

export interface InterviewRouteDeps {
  repoRoot: string;
  /** The core-resolving route wrapper from createApp. */
  route: (
    handler: (c: Context, core: CoreModule) => Promise<Response> | Response,
  ) => (c: Context) => Promise<Response>;
  getIndex: (core: CoreModule) => GraphIndexInstance;
  /**
   * createApp's write queue: /finish imports and commits, so it must not
   * interleave with another graph write (an extraction job, a merge accepted).
   */
  serializeWrite: <T>(work: () => Promise<T> | T) => Promise<T>;
  /** Injected LLM client (tests); production resolves ClaudeCodeLlmClient lazily. */
  llm?: LlmClient;
}

interface InterviewSession {
  state: InterviewState;
  gaps: CoverageGap[];
  /** Model the session's agent runs on ("default" = Claude Code's own). */
  model: string;
  /** Client bound to this session's model, resolved once at start/resume. */
  llm: LlmClient;
  /** Epoch ms of the last request touching this session (TTL eviction). */
  lastActivity: number;
}

/**
 * InterviewState is plain JSON; the response type is its wire mirror. The
 * plain assignment (no cast) is the compile-time proof that the hand-written
 * mirror in api-types.ts still matches the engine types.
 */
function toStateResponse(state: InterviewState): InterviewStateResponse {
  return state;
}

/** Idle sessions are dropped after 4h: transcripts must not outlive the sitting. */
const SESSION_TTL_MS = 4 * 60 * 60 * 1000;
/** Hard cap on concurrent sessions (oldest evicted) — this is a local sidecar. */
const MAX_SESSIONS = 20;

export function registerInterviewRoutes(app: Hono, deps: InterviewRouteDeps): void {
  const { repoRoot, route, getIndex, serializeWrite } = deps;
  const sessions = new Map<string, InterviewSession>();
  /** One client per model id — building it probes nothing, but reuse is cheap. */
  const llmCache = new Map<string, LlmClient>();

  const sweepSessions = (now: number): void => {
    for (const [id, session] of sessions) {
      if (now - session.lastActivity > SESSION_TTL_MS) sessions.delete(id);
    }
    while (sessions.size >= MAX_SESSIONS) {
      let oldest: string | undefined;
      let oldestAt = Infinity;
      for (const [id, session] of sessions) {
        if (session.lastActivity < oldestAt) {
          oldestAt = session.lastActivity;
          oldest = id;
        }
      }
      if (oldest === undefined) break;
      sessions.delete(oldest);
    }
  };

  /**
   * Resolve the LLM client for a model, or explain exactly what is missing.
   * An injected client (tests) always wins and ignores the model override.
   */
  const resolveLlm = (
    extractors: ExtractorsModule,
    model?: string,
  ): { llm: LlmClient } | { error: string } => {
    if (deps.llm !== undefined) return { llm: deps.llm };
    const key = model ?? 'default';
    const cached = llmCache.get(key);
    if (cached !== undefined) return { llm: cached };
    // Engine = Claude Code: the sidecar drives the local `claude` CLI with
    // whatever authentication it already has. No API key involved.
    const engine = extractors.claudeCodeAvailable();
    if (!engine.ok) {
      return { error: engine.detail };
    }
    const llm = new extractors.ClaudeCodeLlmClient(model !== undefined ? { model } : {});
    llmCache.set(key, llm);
    return { llm };
  };

  const modelFrom = (payload: { model?: unknown }): string | undefined =>
    typeof payload.model === 'string' && payload.model.trim() !== ''
      ? payload.model.trim()
      : undefined;

  // ---------------------------------------------------------------------------
  // Resumable session on disk — the CLI's `--resume` file, same format.
  // interviewSessionPath() lives under .untacit/ (gitignored derived state), so
  // nothing here is ever committed. serializeInterview() strips the transcript:
  // that is the single place the privacy invariant is enforced, and it is the
  // engine's own function, shared with the CLI.
  // ---------------------------------------------------------------------------

  const sessionFile = (core: CoreModule): string => core.interviewSessionPath(repoRoot);

  const saveSession = (
    core: CoreModule,
    extractors: ExtractorsModule,
    state: InterviewState,
  ): void => {
    const path = sessionFile(core);
    try {
      mkdirSync(dirname(path), { recursive: true });
      const tmp = `${path}.tmp`;
      // Atomic: a crash mid-write leaves the previous snapshot intact.
      writeFileSync(
        tmp,
        `${JSON.stringify(extractors.serializeInterview(state), null, 2)}\n`,
        'utf8',
      );
      renameSync(tmp, path);
    } catch (err) {
      // Persistence is a convenience (resume); losing it must never cost the
      // caller a turn that already spent an LLM call.
      console.warn(
        `[untacit-sidecar] no se pudo guardar la sesión de entrevista en ${path}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  };

  /**
   * Delete only OUR session: a concurrent interview (the CLI over the same
   * graph repo) may have overwritten the file, and its resumable work must not
   * be swept away by this one closing.
   */
  const removeOwnSession = (core: CoreModule, interviewId: string): void => {
    const path = sessionFile(core);
    try {
      const onDisk = JSON.parse(readFileSync(path, 'utf8')) as {
        state?: { interviewId?: string };
      };
      if (onDisk.state?.interviewId !== interviewId) return;
    } catch {
      return;
    }
    rmSync(path, { force: true });
  };

  /** The persisted snapshot, or a reason it cannot be used. */
  const readSaved = (
    core: CoreModule,
  ): { snapshot: PersistedInterview } | { error: string } | undefined => {
    const path = sessionFile(core);
    if (!existsSync(path)) return undefined;
    let parsed: { version?: unknown };
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown };
    } catch (err) {
      return { error: `sesión guardada ilegible (${err instanceof Error ? err.message : String(err)})` };
    }
    if (parsed.version !== 1) {
      return {
        error: `versión de sesión desconocida (${String(parsed.version)}) — descártala o actualiza untacit`,
      };
    }
    return { snapshot: parsed as unknown as PersistedInterview };
  };

  const savedSummary = (snapshot: PersistedInterview): InterviewSavedSession => {
    const proposals = snapshot.state.proposals;
    return {
      interviewId: snapshot.state.interviewId,
      speakerRole: snapshot.state.speakerRole,
      savedAt: snapshot.savedAt,
      turn: snapshot.state.turn,
      script: snapshot.state.script,
      scriptIndex: snapshot.state.scriptIndex,
      finished: snapshot.state.finished,
      accepted: proposals.filter((p) => p.kind !== 'verification' && p.status === 'accepted').length,
      pending: proposals.filter((p) => p.kind !== 'verification' && p.status === 'proposed').length,
      verificationsPending: proposals.filter(
        (p) => p.kind === 'verification' && p.status === 'proposed',
      ).length,
      live: sessions.has(snapshot.state.interviewId),
    };
  };

  /** Saved-session summary for the start screen, or null when there is none. */
  const savedForResponse = (core: CoreModule): InterviewSavedSession | null => {
    const saved = readSaved(core);
    if (saved === undefined || 'error' in saved) return null;
    return savedSummary(saved.snapshot);
  };

  /** Route wrapper that additionally resolves @untacit/extractors. */
  const interviewRoute = (
    handler: (
      c: Context,
      core: CoreModule,
      extractors: ExtractorsModule,
    ) => Promise<Response> | Response,
  ) =>
    route(async (c, core) => {
      const extractors = await loadExtractors();
      if (extractors === undefined) {
        const body: ApiError = {
          error: 'extractors package not available',
          detail: extractorsLoadError(),
        };
        return c.json(body, 503);
      }
      return handler(c, core, extractors);
    });

  const sessionOf = (c: Context): InterviewSession => {
    const now = Date.now();
    sweepSessions(now);
    const id = c.req.param('id') ?? '';
    const session = sessions.get(id);
    // "not found" phrasing → HTTP 404 via the shared error mapper.
    if (session === undefined) throw new Error(`interview "${id}" not found`);
    session.lastActivity = now;
    return session;
  };

  // ---------------------------------------------------------------------------
  // GET /api/interview/gaps — coverage gaps + verification targets + LLM state,
  // so the start screen can preview the session before spending an LLM call.
  // ---------------------------------------------------------------------------
  app.get(
    '/api/interview/gaps',
    interviewRoute((c, core, extractors) => {
      const index = getIndex(core);
      const gaps = extractors.findCoverageGaps(index, 12);
      const verifications = extractors.verificationTargets(index, 5);
      const llm = resolveLlm(extractors);
      const body: InterviewGapsResponse = {
        gaps,
        verifications,
        llmReady: 'llm' in llm,
        saved: savedForResponse(core),
      };
      if ('error' in llm) body.llmDetail = llm.error;
      return c.json(body);
    }),
  );

  // ---------------------------------------------------------------------------
  // GET /api/interview/saved — is there an interrupted session to resume?
  // Registered before /api/interview/:id so "saved" is not read as an id.
  // ---------------------------------------------------------------------------
  app.get(
    '/api/interview/saved',
    route((c, core) => {
      const saved = readSaved(core);
      if (saved !== undefined && 'error' in saved) {
        // An unreadable/foreign-version file is a client-fixable situation:
        // report it so the UI can offer "descartar" instead of hanging on it.
        return c.json({ error: 'sesión guardada no utilizable', detail: saved.error } satisfies ApiError, 409);
      }
      const body: InterviewSavedResponse = {
        saved: saved === undefined ? null : savedSummary(saved.snapshot),
      };
      return c.json(body);
    }),
  );

  // ---------------------------------------------------------------------------
  // DELETE /api/interview/saved — discard the interrupted session (the UI's
  // "empezar de cero"). Also drops it from memory when it is still live.
  // ---------------------------------------------------------------------------
  app.delete(
    '/api/interview/saved',
    route((c, core) => {
      const path = sessionFile(core);
      const existed = existsSync(path);
      if (existed) {
        const saved = readSaved(core);
        if (saved !== undefined && 'snapshot' in saved) {
          sessions.delete(saved.snapshot.state.interviewId);
        }
        rmSync(path, { force: true });
      }
      const body: InterviewDiscardResponse = { ok: true, discarded: existed };
      return c.json(body);
    }),
  );

  // ---------------------------------------------------------------------------
  // POST /api/interview/start { role, model? } — gap analysis, script
  // generation (LLM), verification queue, opening agent turn. Any saved session
  // is replaced: the UI offers resume/discard before getting here.
  // ---------------------------------------------------------------------------
  app.post(
    '/api/interview/start',
    interviewRoute(async (c, core, extractors) => {
      const payload = (await c.req.json().catch(() => ({}))) as Partial<InterviewStartRequest>;
      const role = payload.role?.trim() ?? '';
      if (role === '') {
        return c.json({ error: 'role is required (rol del entrevistado, nunca su nombre)' } satisfies ApiError, 400);
      }
      const model = modelFrom(payload);
      const llm = resolveLlm(extractors, model);
      if ('error' in llm) {
        return c.json({ error: 'LLM no disponible', detail: llm.error } satisfies ApiError, 503);
      }

      const index = getIndex(core);
      const gaps = extractors.findCoverageGaps(index, 12);
      const verifications = extractors.verificationTargets(index, 5);
      const script = await extractors.generateScript(llm.llm, gaps);

      const now = Date.now();
      sweepSessions(now);
      const interviewId = `int-${now.toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const state = extractors.startInterview(interviewId, role, { script, verifications });
      sessions.set(interviewId, {
        state,
        gaps,
        model: model ?? llm.llm.model,
        llm: llm.llm,
        lastActivity: now,
      });
      // Save right away: the generated script is real LLM spend and must
      // survive a crash from the very first write (as the CLI does).
      saveSession(core, extractors, state);

      const body: InterviewStartResponse = {
        state: toStateResponse(state),
        gaps,
        model: model ?? llm.llm.model,
      };
      return c.json(body);
    }),
  );

  // ---------------------------------------------------------------------------
  // POST /api/interview/resume { model? } — rebuild the interrupted session
  // from disk. The transcript restarts with the engine's recap turn: it was
  // never persisted, and that recap is all the anchoring the turn contract
  // needs. The model is re-picked here, exactly like `--resume --model`.
  // ---------------------------------------------------------------------------
  app.post(
    '/api/interview/resume',
    interviewRoute(async (c, core, extractors) => {
      const saved = readSaved(core);
      if (saved === undefined) {
        return c.json(
          {
            error: 'no hay ninguna sesión de entrevista interrumpida en este grafo',
          } satisfies ApiError,
          404,
        );
      }
      if ('error' in saved) {
        return c.json({ error: 'sesión guardada no utilizable', detail: saved.error } satisfies ApiError, 409);
      }
      const payload = (await c.req.json().catch(() => ({}))) as Partial<InterviewResumeRequest>;
      const model = modelFrom(payload);
      const llm = resolveLlm(extractors, model);
      if ('error' in llm) {
        return c.json({ error: 'LLM no disponible', detail: llm.error } satisfies ApiError, 503);
      }

      const now = Date.now();
      sweepSessions(now);
      const state = extractors.resumeInterview(saved.snapshot);
      // Gaps are recomputed: the graph may have moved since the session began.
      const gaps = extractors.findCoverageGaps(getIndex(core), 12);
      sessions.set(state.interviewId, {
        state,
        gaps,
        model: model ?? llm.llm.model,
        llm: llm.llm,
        lastActivity: now,
      });

      const body: InterviewStartResponse = {
        state: toStateResponse(state),
        gaps,
        model: model ?? llm.llm.model,
        resumed: true,
      };
      return c.json(body);
    }),
  );

  // ---------------------------------------------------------------------------
  // GET /api/interview/:id — full session state (reload without losing context).
  // ---------------------------------------------------------------------------
  app.get(
    '/api/interview/:id',
    interviewRoute((c) => {
      const session = sessionOf(c);
      const body: InterviewStartResponse = {
        state: toStateResponse(session.state),
        gaps: session.gaps,
        model: session.model,
      };
      return c.json(body);
    }),
  );

  // ---------------------------------------------------------------------------
  // POST /api/interview/:id/answer { text } — one turn: extract triples, reply.
  // ---------------------------------------------------------------------------
  app.post(
    '/api/interview/:id/answer',
    interviewRoute(async (c, core, extractors) => {
      const session = sessionOf(c);
      const payload = (await c.req.json().catch(() => ({}))) as Partial<InterviewAnswerRequest>;
      const text = payload.text?.trim() ?? '';
      if (text === '') {
        return c.json({ error: 'text is required' } satisfies ApiError, 400);
      }
      // The session's own client: the model chosen at start/resume holds for
      // the whole conversation.
      const outcome = await extractors.processAnswer(session.llm, session.state, text);
      // Save after the turn (never the transcript): a crash or a closed window
      // loses at most the answer in flight.
      saveSession(core, extractors, session.state);
      const body: InterviewAnswerResponse = {
        reply: outcome.reply,
        // Engine proposals ARE the state objects, already appended to state.
        proposals: outcome.proposals,
        finished: outcome.finished,
        state: toStateResponse(session.state),
      };
      return c.json(body);
    }),
  );

  // ---------------------------------------------------------------------------
  // POST /api/interview/:id/proposal/:pid { action, patch? } — live validation:
  // accept | reject | edit (node/edge) · confirm | refute | skip (verification).
  // ---------------------------------------------------------------------------
  app.post(
    '/api/interview/:id/proposal/:pid',
    interviewRoute(async (c, core, extractors) => {
      const session = sessionOf(c);
      const proposalId = c.req.param('pid') ?? '';
      const payload = (await c.req.json().catch(() => ({}))) as Partial<InterviewProposalRequest>;
      const action = payload.action;
      let proposal;
      try {
        switch (action) {
          case 'accept':
            proposal = extractors.acceptProposal(session.state, proposalId);
            break;
          case 'reject':
            proposal = extractors.rejectProposal(session.state, proposalId);
            break;
          case 'edit':
            proposal = extractors.editProposal(session.state, proposalId, payload.patch ?? {});
            break;
          case 'confirm':
          case 'refute':
          case 'skip':
            proposal = extractors.resolveVerification(session.state, proposalId, action);
            break;
          default:
            return c.json(
              { error: `unknown action "${String(action)}" — expected accept | reject | edit | confirm | refute | skip` } satisfies ApiError,
              400,
            );
        }
      } catch (err) {
        // Wrong action for the proposal's kind is a client error, not a 500.
        const message = err instanceof Error ? err.message : String(err);
        if (/confirm\/refute\/skip|cannot be edited|is not a verification/.test(message)) {
          return c.json({ error: message } satisfies ApiError, 400);
        }
        throw err;
      }
      // Every validation decision is durable: a resumed session skips the
      // verifications already answered and keeps the accepted triples.
      saveSession(core, extractors, session.state);
      const body: InterviewProposalResponse = {
        ok: true,
        proposal,
      };
      return c.json(body);
    }),
  );

  // ---------------------------------------------------------------------------
  // POST /api/interview/:id/accept-all { except? } — bulk accept with exceptions.
  // ---------------------------------------------------------------------------
  app.post(
    '/api/interview/:id/accept-all',
    interviewRoute(async (c, core, extractors) => {
      const session = sessionOf(c);
      const payload = (await c.req.json().catch(() => ({}))) as Partial<InterviewAcceptAllRequest>;
      const accepted = extractors.acceptAll(session.state, payload.except ?? []);
      saveSession(core, extractors, session.state);
      const body: InterviewAcceptAllResponse = {
        ok: true,
        accepted: accepted.map((p) => p.id),
        state: toStateResponse(session.state),
      };
      return c.json(body);
    }),
  );

  // ---------------------------------------------------------------------------
  // POST /api/interview/:id/finish — accepted triples + verdicts → batch →
  // import pipeline → commit (one run = one commit). The session is dropped
  // from memory AND from disk; the transcript is gone on purpose.
  //
  // The resumable snapshot is removed only after a successful import: if the
  // import fails, the session survives so the conversation is not lost to a
  // problem the user can fix (the CLI behaves the same way).
  // ---------------------------------------------------------------------------
  app.post(
    '/api/interview/:id/finish',
    interviewRoute(async (c, core, extractors) => {
      const session = sessionOf(c);
      const state = session.state;
      const batch = extractors.finishInterview(state);
      const result = await serializeWrite(() =>
        core.importBatch(repoRoot, batch, {
          extractor: batch.extractor,
        }),
      );
      sessions.delete(state.interviewId);
      removeOwnSession(core, state.interviewId);

      const body: InterviewFinishResponse = {
        ok: true,
        runId: result.runId,
        stats: result.stats,
        rejections: result.rejections,
        commit: result.commit,
        noop: result.noop,
        acceptedProposals: state.proposals.filter(
          (p) => p.kind !== 'verification' && p.status === 'accepted',
        ).length,
        verificationsResolved: state.proposals.filter(
          (p) => p.status === 'confirmed' || p.status === 'refuted',
        ).length,
      };
      return c.json(body);
    }),
  );
}
