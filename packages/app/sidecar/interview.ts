/**
 * Interview routes (Fase 4, docs/03 §4.3): the sidecar face of the
 * extractor-interview engine.
 *
 * Sessions live in memory only — by design, the full transcript never touches
 * the graph repo (privacy, docs/03 §8); what persists is the interview run
 * that /finish imports and commits (excerpts ≤ 300 chars, role, no names).
 *
 * The LLM client is injected for tests; in production the engine is Claude
 * Code — ClaudeCodeLlmClient drives the local `claude` CLI with whatever
 * authentication Claude Code already has (no ANTHROPIC_API_KEY anywhere).
 * Missing extractors or Claude Code → 503 with an actionable message.
 */

import type { Context, Hono } from 'hono';
import type {
  ApiError,
  InterviewAcceptAllRequest,
  InterviewAcceptAllResponse,
  InterviewAnswerRequest,
  InterviewAnswerResponse,
  InterviewFinishResponse,
  InterviewGapsResponse,
  InterviewProposalRequest,
  InterviewProposalResponse,
  InterviewStartRequest,
  InterviewStartResponse,
  InterviewStateResponse,
} from '../src/api-types.js';
import type { CoreModule } from './core-loader.js';
import { extractorsLoadError, loadExtractors, type ExtractorsModule } from './extractors-loader.js';

// Engine types, erased at compile time (runtime goes through the loader).
import type { CoverageGap, InterviewState, LlmClient } from '@untacit/extractors';

type GraphIndexInstance = ReturnType<CoreModule['GraphIndex']['open']>;

export interface InterviewRouteDeps {
  repoRoot: string;
  /** The core-resolving route wrapper from createApp. */
  route: (
    handler: (c: Context, core: CoreModule) => Promise<Response> | Response,
  ) => (c: Context) => Promise<Response>;
  getIndex: (core: CoreModule) => GraphIndexInstance;
  /** Injected LLM client (tests); production resolves AnthropicLlmClient lazily. */
  llm?: LlmClient;
}

interface InterviewSession {
  state: InterviewState;
  gaps: CoverageGap[];
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
  const { repoRoot, route, getIndex } = deps;
  const sessions = new Map<string, InterviewSession>();
  let fallbackLlm: LlmClient | undefined;

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

  /** Resolve the LLM client or explain exactly what is missing. */
  const resolveLlm = (
    extractors: ExtractorsModule,
  ): { llm: LlmClient } | { error: string } => {
    if (deps.llm !== undefined) return { llm: deps.llm };
    if (fallbackLlm !== undefined) return { llm: fallbackLlm };
    // Engine = Claude Code: the sidecar drives the local `claude` CLI with
    // whatever authentication it already has. No API key involved.
    const engine = extractors.claudeCodeAvailable();
    if (!engine.ok) {
      return { error: engine.detail };
    }
    fallbackLlm = new extractors.ClaudeCodeLlmClient();
    return { llm: fallbackLlm };
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
      };
      if ('error' in llm) body.llmDetail = llm.error;
      return c.json(body);
    }),
  );

  // ---------------------------------------------------------------------------
  // POST /api/interview/start { role } — gap analysis, script generation (LLM),
  // verification queue, opening agent turn.
  // ---------------------------------------------------------------------------
  app.post(
    '/api/interview/start',
    interviewRoute(async (c, core, extractors) => {
      const payload = (await c.req.json().catch(() => ({}))) as Partial<InterviewStartRequest>;
      const role = payload.role?.trim() ?? '';
      if (role === '') {
        return c.json({ error: 'role is required (rol del entrevistado, nunca su nombre)' } satisfies ApiError, 400);
      }
      const llm = resolveLlm(extractors);
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
      sessions.set(interviewId, { state, gaps, lastActivity: now });

      const body: InterviewStartResponse = { state: toStateResponse(state), gaps };
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
      };
      return c.json(body);
    }),
  );

  // ---------------------------------------------------------------------------
  // POST /api/interview/:id/answer { text } — one turn: extract triples, reply.
  // ---------------------------------------------------------------------------
  app.post(
    '/api/interview/:id/answer',
    interviewRoute(async (c, _core, extractors) => {
      const session = sessionOf(c);
      const payload = (await c.req.json().catch(() => ({}))) as Partial<InterviewAnswerRequest>;
      const text = payload.text?.trim() ?? '';
      if (text === '') {
        return c.json({ error: 'text is required' } satisfies ApiError, 400);
      }
      const llm = resolveLlm(extractors);
      if ('error' in llm) {
        return c.json({ error: 'LLM no disponible', detail: llm.error } satisfies ApiError, 503);
      }
      const outcome = await extractors.processAnswer(llm.llm, session.state, text);
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
    interviewRoute(async (c, _core, extractors) => {
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
    interviewRoute(async (c, _core, extractors) => {
      const session = sessionOf(c);
      const payload = (await c.req.json().catch(() => ({}))) as Partial<InterviewAcceptAllRequest>;
      const accepted = extractors.acceptAll(session.state, payload.except ?? []);
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
  // import pipeline → commit (one run = one commit). The session is dropped;
  // the transcript is gone on purpose.
  // ---------------------------------------------------------------------------
  app.post(
    '/api/interview/:id/finish',
    interviewRoute(async (c, core, extractors) => {
      const session = sessionOf(c);
      const state = session.state;
      const batch = extractors.finishInterview(state);
      const result = await core.importBatch(repoRoot, batch, {
        extractor: batch.extractor,
      });
      sessions.delete(state.interviewId);

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
