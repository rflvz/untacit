/**
 * extractor-interview (docs/03 §4.3) — the differentiating feature.
 *
 * Full protocol engine: (1) gap-driven target selection over the derived
 * index, (2) question script generation, (3) a conversational turn loop where
 * one LLM call per answer extracts triples AND produces the agent's follow-up
 * (repregunta until statements carry condition and consequence), (4) live
 * proposals the interviewee accepts / edits / rejects — individually or in
 * bulk with exceptions, (5) cross-verification of existing low-confidence
 * edges (confirm → supports evidence with validated_by → 0.95; refute →
 * contradicts evidence → conflict), and (6) batch emission where everything
 * accepted carries validated_by = speaker role.
 *
 * The engine is UI-agnostic: the app drives it over the sidecar and the CLI
 * over readline. State is plain JSON so it travels over HTTP untouched.
 *
 * Module map: render.ts (natural-language statements), gaps.ts (gap analysis
 * + verification targets), state.ts (session state, proposal actions,
 * persistence), script.ts (script generation). This file holds the turn loop
 * and batch emission, and re-exports the public API.
 */

import { MAX_EXCERPT_LENGTH, newRunId, slugify, validateBatch } from '@untacit/core';
import type { BatchNode, ExtractionBatch } from '@untacit/core';

import type { LlmClient } from '../llm.js';
import { parseJsonResponse } from '../llm.js';
import {
  PROMPT_VERSIONS,
  interviewSystemPrompt,
  interviewTurnSchemaForLlm,
} from '../prompts.js';
import type { VerificationTarget } from './gaps.js';
import { renderEdgeStatement, renderNodeStatement } from './render.js';
import { nextScriptQuestion } from './state.js';
import type { InterviewState, ProposedTriple } from './state.js';

export { renderEdgeStatement, renderNodeStatement } from './render.js';
export type { CoverageGap, VerificationTarget } from './gaps.js';
export { findCoverageGaps, verificationTargets } from './gaps.js';
export type {
  InterviewState,
  PersistedInterview,
  ProposalKind,
  ProposalPatch,
  ProposalStatus,
  ProposedTriple,
  StartInterviewOptions,
  VerificationVerdict,
} from './state.js';
export {
  acceptAll,
  acceptProposal,
  editProposal,
  rejectProposal,
  resolveVerification,
  resumeInterview,
  serializeInterview,
  startInterview,
} from './state.js';
export { generateScript } from './script.js';

// ---------------------------------------------------------------------------
// 3 + 4. Turn loop: extract triples, repregunta or advance the script
// ---------------------------------------------------------------------------

export interface TurnOutcome {
  /** Proposals extracted from this answer (already appended to state). */
  proposals: ProposedTriple[];
  /** The agent's next utterance (already appended to the transcript). */
  reply: string;
  /** True when the script is exhausted and the agent proposed wrapping up. */
  finished: boolean;
}

/** Last few transcript turns, rendered for the LLM's conversational context. */
function transcriptContext(state: InterviewState, maxTurns = 6): string {
  return state.transcript
    .slice(-maxTurns)
    .map((t) => `${t.speaker === 'agent' ? 'ENTREVISTADOR' : 'ENTREVISTADO'}: ${t.text}`)
    .join('\n');
}

/**
 * Process one interviewee answer: a single LLM call extracts candidate
 * triples AND decides the agent's reply (repregunta while condition or
 * consequence is missing; otherwise the engine advances the script).
 */
export async function processAnswer(
  llm: LlmClient,
  state: InterviewState,
  answer: string,
): Promise<TurnOutcome> {
  // Nothing mutates until the LLM call parses: a failed/garbled call leaves
  // the state exactly as it was, so the caller can simply retry the answer.
  const turn = state.turn + 1;
  const context = transcriptContext(state);
  const locator = {
    interview_id: state.interviewId,
    speaker_role: state.speakerRole,
    turn,
  };
  const raw = await llm.complete({
    system: interviewSystemPrompt(),
    prompt: [
      `Entrevista en curso (rol del entrevistado: ${state.speakerRole}). Conversación reciente:`,
      context,
      '',
      `El entrevistado (turno ${turn}) acaba de responder:`,
      `"""${answer}"""`,
      `Extrae los triples de negocio de esta respuesta como batch (run_id "pending", source_type "interview", locator ${JSON.stringify(locator)}, excerpt literal <= ${MAX_EXCERPT_LENGTH} chars) y emite tu "reply" y "topic_done" según el contrato del turno.`,
    ].join('\n'),
    schema: interviewTurnSchemaForLlm(),
  });
  const parsed = parseJsonResponse(raw) as ExtractionBatch & {
    reply?: string;
    topic_done?: boolean;
  };
  state.turn = turn;
  state.transcript.push({ speaker: 'interviewee', text: answer });
  const validation = validateBatch({ ...parsed, run_id: 'pending', source_type: 'interview' });
  const batch = validation.sanitized ?? {
    run_id: 'pending',
    source_type: 'interview' as const,
    nodes: [],
    edges: [],
  };
  // Provenance is not the model's to decide: stamp the trusted locator over
  // whatever the LLM emitted (it only ever knew it from the prompt anyway).
  for (const node of batch.nodes) node.evidence.locator = { ...locator };
  for (const edge of batch.edges) edge.evidence.locator = { ...locator };

  const proposals: ProposedTriple[] = [];
  const nextId = (): string =>
    `p${state.proposals.filter((p) => p.kind !== 'verification').length + proposals.length + 1}`;
  for (const node of batch.nodes) {
    proposals.push({
      id: nextId(),
      kind: 'node',
      statement: renderNodeStatement(node),
      turn: state.turn,
      node,
      status: 'proposed',
    });
  }
  for (const edge of batch.edges) {
    proposals.push({
      id: nextId(),
      kind: 'edge',
      statement: renderEdgeStatement(edge.type, edge.source_mention, edge.target_mention, edge.stance),
      turn: state.turn,
      edge,
      status: 'proposed',
    });
  }
  state.proposals.push(...proposals);

  // Compose the agent's next utterance: the LLM's reply about the current
  // topic, plus — when the topic is done — the next script question or the
  // wrap-up proposal (the engine owns transitions, docs/03 §4.3 mitigation:
  // the script comes from graph gaps, not from the model's imagination).
  const replyParts: string[] = [];
  const llmReply = typeof parsed.reply === 'string' ? parsed.reply.trim() : '';
  if (llmReply.length > 0) replyParts.push(llmReply);
  let finished = state.finished;
  if (parsed.topic_done !== false) {
    const next = nextScriptQuestion(state);
    if (next !== undefined) {
      replyParts.push(next);
    } else {
      finished = true;
      const pendingVerifications = state.proposals.filter(
        (p) => p.kind === 'verification' && p.status === 'proposed',
      ).length;
      replyParts.push(
        pendingVerifications > 0
          ? `Hemos cubierto el guion. Quedan ${pendingVerifications} afirmación${pendingVerifications === 1 ? '' : 'es'} por confirmar o refutar en el panel; cuando termines, revisa las propuestas y cierra la sesión.`
          : 'Hemos cubierto el guion. Revisa las propuestas del panel y cierra la sesión cuando quieras.',
      );
    }
  }
  if (replyParts.length === 0) replyParts.push('¿Puedes darme algún detalle más?');
  const reply = replyParts.join(' ');
  state.transcript.push({ speaker: 'agent', text: reply });
  state.finished = finished;

  return { proposals, reply, finished };
}

// ---------------------------------------------------------------------------
// 6. Close the session: accepted triples + verification verdicts → batch
// ---------------------------------------------------------------------------

function truncateExcerpt(text: string): string {
  return text.length <= MAX_EXCERPT_LENGTH ? text : `${text.slice(0, MAX_EXCERPT_LENGTH - 1)}…`;
}

/**
 * Close the session: accepted triples become the interview batch, each
 * evidence stamped validated_by = speaker role (0.95 base confidence
 * downstream). Accepting an edge implies accepting its endpoints: endpoint
 * node proposals still pending are pulled into the batch (an explicit
 * rejection still cascades the edge out). Verification verdicts materialize
 * as edges over the EXISTING nodes: their endpoints enter the batch as anchor
 * nodes with candidate_id so the resolver attaches the new evidence to the
 * current graph instead of creating duplicates.
 */
export function finishInterview(state: InterviewState, now = new Date()): ExtractionBatch {
  const runId = newRunId('interview', now);
  const batch: ExtractionBatch = {
    run_id: runId,
    source_type: 'interview',
    extractor: {
      name: 'extractor-interview',
      model: 'live',
      prompt_version: PROMPT_VERSIONS.interview,
    },
    nodes: [],
    edges: [],
  };

  const mentionKey = (mention: string): string => slugify(mention.trim());
  /** Mention keys usable as edge endpoints (any type). */
  const mentioned = new Set<string>();
  /** (type, mention) pairs already in the batch — the validator's dedup key. */
  const declared = new Set<string>();
  const pushNode = (node: BatchNode): void => {
    node.evidence.validated_by = state.speakerRole;
    batch.nodes.push(node);
    mentioned.add(mentionKey(node.mention));
    declared.add(`${node.type}|${mentionKey(node.mention)}`);
  };

  for (const proposal of state.proposals) {
    if (proposal.status !== 'accepted') continue;
    if (proposal.node) pushNode(proposal.node);
    if (proposal.edge) {
      proposal.edge.evidence.validated_by = state.speakerRole;
      batch.edges.push(proposal.edge);
    }
  }

  // Accepting an edge implies its endpoints: pull still-pending endpoint node
  // proposals into the batch instead of silently dropping the accepted edge.
  // An endpoint the interviewee explicitly REJECTED keeps cascading the edge
  // out (final filter below).
  for (const edge of batch.edges) {
    for (const mention of [edge.source_mention, edge.target_mention]) {
      const key = mentionKey(mention);
      if (mentioned.has(key)) continue;
      const candidates = state.proposals.filter(
        (p) => p.kind === 'node' && p.node !== undefined && mentionKey(p.node.mention) === key,
      );
      if (candidates.some((p) => p.status === 'rejected')) continue;
      const pending = candidates.find((p) => p.status === 'proposed');
      if (pending?.node !== undefined) {
        pending.status = 'accepted';
        pushNode(pending.node);
      }
    }
  }

  // Cross-verification verdicts (docs/03 §4.3.5). Anchor nodes enter once per
  // (type, mention) — the validator would drop duplicates with a warning.
  const baseLocator = { interview_id: state.interviewId, speaker_role: state.speakerRole };
  const anchorNode = (v: VerificationTarget, side: 'source' | 'target', excerpt: string): void => {
    const id = side === 'source' ? v.sourceId : v.targetId;
    const type = side === 'source' ? v.sourceType : v.targetType;
    const name = side === 'source' ? v.sourceName : v.targetName;
    const description = side === 'source' ? v.sourceDescription : v.targetDescription;
    if (declared.has(`${type}|${mentionKey(name)}`)) return;
    pushNode({
      mention: name,
      candidate_id: id,
      type,
      name,
      description: description !== '' ? description : name,
      evidence: {
        locator: baseLocator,
        excerpt,
        validated_by: state.speakerRole,
      },
    });
  };

  for (const proposal of state.proposals) {
    if (proposal.kind !== 'verification' || proposal.verification === undefined) continue;
    if (proposal.status !== 'confirmed' && proposal.status !== 'refuted') continue;
    const v = proposal.verification;
    const confirmed = proposal.status === 'confirmed';
    const excerpt = truncateExcerpt(
      `${confirmed ? 'Confirmado' : 'Refutado'} en entrevista: ${v.statement}`,
    );
    anchorNode(v, 'source', excerpt);
    anchorNode(v, 'target', excerpt);
    batch.edges.push({
      type: v.edgeType,
      source_mention: v.sourceName,
      target_mention: v.targetName,
      stance: confirmed ? 'supports' : 'contradicts',
      evidence: {
        locator: baseLocator,
        excerpt,
        validated_by: state.speakerRole,
      },
    });
  }

  // Drop accepted edges whose endpoints were rejected (validator would anyway).
  batch.edges = batch.edges.filter(
    (e) => mentioned.has(mentionKey(e.source_mention)) && mentioned.has(mentionKey(e.target_mention)),
  );
  return batch;
}
