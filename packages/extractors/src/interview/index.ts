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
 */

import { MAX_EXCERPT_LENGTH, newRunId, slugify, validateBatch } from '@untacit/core';
import type {
  BatchEdge,
  BatchNode,
  EdgeType,
  ExtractionBatch,
  GraphIndex,
  NodeType,
  Stance,
} from '@untacit/core';

import type { LlmClient } from '../llm.js';
import { parseJsonResponse } from '../llm.js';
import {
  PROMPT_VERSIONS,
  interviewSystemPrompt,
  interviewTurnSchemaForLlm,
} from '../prompts.js';

// ---------------------------------------------------------------------------
// Natural-language rendering (proposals are validated by non-technical people)
// ---------------------------------------------------------------------------

/** Type label WITH its article — statements must read as natural Spanish. */
const NODE_TYPE_LABELS: Record<NodeType, string> = {
  entity: 'una entidad',
  process: 'un proceso',
  rule: 'una regla',
  policy: 'una política',
  event: 'un evento',
  system: 'un sistema',
  role: 'un rol',
};

const EDGE_TEMPLATES: Record<EdgeType, (s: string, t: string) => string> = {
  OPERATES_ON: (s, t) => `La regla «${s}» opera sobre «${t}»`,
  VALIDATES: (s, t) => `La regla «${s}» valida «${t}»`,
  CALCULATES: (s, t) => `La regla «${s}» calcula «${t}»`,
  TRIGGERS: (s, t) => `«${s}» dispara «${t}»`,
  EXECUTES: (s, t) => `«${s}» ejecuta «${t}»`,
  DEPENDS_ON: (s, t) => `«${s}» depende de «${t}»`,
  GOVERNS: (s, t) => `La política «${s}» gobierna «${t}»`,
  IMPLEMENTED_IN: (s, t) => `«${s}» está implementado en «${t}»`,
  PART_OF: (s, t) => `«${s}» forma parte de «${t}»`,
};

export function renderNodeStatement(node: BatchNode): string {
  return `«${node.name}» es ${NODE_TYPE_LABELS[node.type]}: ${node.description}`;
}

export function renderEdgeStatement(
  type: EdgeType,
  source: string,
  target: string,
  stance?: Stance,
): string {
  const base = EDGE_TEMPLATES[type](source, target);
  return stance === 'contradicts' ? `${base} — REFUTA lo afirmado por otra fuente` : base;
}

// ---------------------------------------------------------------------------
// 1. Gap analysis: zones of the graph worth interviewing about
// ---------------------------------------------------------------------------

export interface CoverageGap {
  kind: 'missing-role' | 'missing-trigger' | 'low-confidence-edge' | 'isolated-node';
  nodeId: string;
  detail: string;
}

/**
 * Coverage gaps over the derived index: processes with no executor, processes
 * nothing triggers, nodes with no edges at all, and low-confidence edges the
 * interview should cross-verify.
 */
export function findCoverageGaps(index: GraphIndex, limit = 10): CoverageGap[] {
  const stats = index.stats();
  if (stats.nodes_total === 0) return [];

  const processGaps: CoverageGap[] = [];
  for (const process of index.listNodes({ types: ['process' as NodeType], limit: 200 })) {
    const edges = index.edgesOf(process.id);
    const hasExecutor = edges.some((e) => e.direction === 'in' && e.edge.type === 'EXECUTES');
    if (!hasExecutor) {
      processGaps.push({
        kind: 'missing-role',
        nodeId: process.id,
        detail: `Nadie ejecuta «${process.name}» según el grafo. ¿Quién lo hace?`,
      });
    }
    const hasTrigger = edges.some((e) => e.direction === 'in' && e.edge.type === 'TRIGGERS');
    if (!hasTrigger) {
      processGaps.push({
        kind: 'missing-trigger',
        nodeId: process.id,
        detail: `No consta qué dispara «${process.name}». ¿Cuándo/por qué se ejecuta?`,
      });
    }
  }

  const isolatedGaps: CoverageGap[] = index.isolatedNodes(50).map((node) => ({
    kind: 'isolated-node',
    nodeId: node.id,
    detail: `«${node.name}» (${NODE_TYPE_LABELS[node.type]}) no está conectado con nada. ¿Con qué se relaciona?`,
  }));

  const lowConfidenceGaps: CoverageGap[] = index.lowConfidenceEdges().map((edge) => ({
    kind: 'low-confidence-edge',
    nodeId: edge.source,
    detail: `Confirmar o refutar: ${edge.source} -${edge.type}→ ${edge.target} (confianza ${edge.confidence}).`,
  }));

  // Round-robin across the gap families so a graph with many under-documented
  // processes cannot starve the isolated-node / low-confidence kinds out of
  // the script.
  const buckets = [processGaps, isolatedGaps, lowConfidenceGaps];
  const gaps: CoverageGap[] = [];
  for (let i = 0; gaps.length < limit; i++) {
    const bucket = buckets[i % buckets.length];
    const gap = bucket.shift();
    if (gap !== undefined) gaps.push(gap);
    if (buckets.every((b) => b.length === 0)) break;
  }
  return gaps;
}

// ---------------------------------------------------------------------------
// 5. Cross-verification targets: existing low-confidence edges (docs/03 §4.3.5)
// ---------------------------------------------------------------------------

export interface VerificationTarget {
  /** Stable edge id from the derived index. */
  edgeKey: string;
  sourceId: string;
  sourceType: NodeType;
  sourceName: string;
  sourceDescription: string;
  edgeType: EdgeType;
  targetId: string;
  targetType: NodeType;
  targetName: string;
  targetDescription: string;
  confidence: number;
  /** Natural-language rendering of the claim, shown to the interviewee. */
  statement: string;
}

/**
 * Low-confidence edges rendered as claims the interviewee can confirm or
 * refute. Dangling targets are skipped — there is nothing to show a human.
 */
export function verificationTargets(index: GraphIndex, limit = 5): VerificationTarget[] {
  const targets: VerificationTarget[] = [];
  for (const edge of index.lowConfidenceEdges()) {
    if (targets.length >= limit) break;
    const source = index.getNode(edge.source);
    const target = index.getNode(edge.targetId);
    if (source === undefined || target === undefined) continue;
    targets.push({
      edgeKey: edge.id,
      sourceId: source.id,
      sourceType: source.type,
      sourceName: source.name,
      sourceDescription: firstLine(source.description),
      edgeType: edge.type,
      targetId: target.id,
      targetType: target.type,
      targetName: target.name,
      targetDescription: firstLine(target.description),
      confidence: edge.confidence,
      statement: renderEdgeStatement(edge.type, source.name, target.name),
    });
  }
  return targets;
}

function firstLine(text: string): string {
  const nl = text.indexOf('\n');
  return (nl === -1 ? text : text.slice(0, nl)).trim();
}

// ---------------------------------------------------------------------------
// Interview state — plain JSON, UI-agnostic
// ---------------------------------------------------------------------------

export type ProposalKind = 'node' | 'edge' | 'verification';

export type ProposalStatus =
  | 'proposed'
  | 'accepted'
  | 'rejected'
  // verification-only verdicts:
  | 'confirmed'
  | 'refuted'
  | 'skipped';

export interface ProposedTriple {
  id: string;
  kind: ProposalKind;
  /** Natural-language rendering shown to the interviewee. */
  statement: string;
  /** Turn of the answer this proposal was extracted from (0 = session start). */
  turn: number;
  node?: BatchNode;
  edge?: BatchEdge;
  verification?: VerificationTarget;
  status: ProposalStatus;
}

export interface InterviewState {
  interviewId: string;
  /** Role of the interviewee — never a person's name (privacy, docs/03 §8). */
  speakerRole: string;
  turn: number;
  transcript: { speaker: 'agent' | 'interviewee'; text: string }[];
  /** Question script generated from graph gaps. */
  script: string[];
  /** Index of the next unasked script question. */
  scriptIndex: number;
  proposals: ProposedTriple[];
  /** True once the script is exhausted and the agent proposed wrapping up. */
  finished: boolean;
}

export interface StartInterviewOptions {
  script?: string[];
  verifications?: VerificationTarget[];
}

const FALLBACK_QUESTION =
  '¿Qué proceso de negocio ocupa la mayor parte de tu jornada y cómo funciona, paso a paso?';

/**
 * Open a session: the opening agent turn greets, points at the verification
 * panel when there are claims to check, and asks the first script question.
 */
export function startInterview(
  interviewId: string,
  speakerRole: string,
  opts: StartInterviewOptions = {},
): InterviewState {
  const script = opts.script !== undefined && opts.script.length > 0 ? opts.script : [FALLBACK_QUESTION];
  const verifications = opts.verifications ?? [];
  const state: InterviewState = {
    interviewId,
    speakerRole,
    turn: 0,
    transcript: [],
    script,
    scriptIndex: 0,
    proposals: verifications.map((v, i) => ({
      id: `v${i + 1}`,
      kind: 'verification' as const,
      statement: v.statement,
      turn: 0,
      verification: v,
      status: 'proposed' as const,
    })),
    finished: false,
  };

  const parts = [
    `Hola — soy el entrevistador de untacit. Voy a hacerte preguntas concretas sobre cómo funciona el negocio; cada afirmación tuya aparecerá como una propuesta que puedes aceptar, corregir o rechazar.`,
  ];
  if (verifications.length > 0) {
    parts.push(
      `Además hay ${verifications.length} afirmación${verifications.length === 1 ? '' : 'es'} de otras fuentes con poca confianza en el panel: confirma o refuta las que conozcas.`,
    );
  }
  parts.push(nextScriptQuestion(state) ?? FALLBACK_QUESTION);
  state.transcript.push({ speaker: 'agent', text: parts.join(' ') });
  return state;
}

/** Consume and return the next unasked script question. */
function nextScriptQuestion(state: InterviewState): string | undefined {
  if (state.scriptIndex >= state.script.length) return undefined;
  const question = state.script[state.scriptIndex];
  state.scriptIndex++;
  return question;
}

// ---------------------------------------------------------------------------
// 2. Script generation from gaps
// ---------------------------------------------------------------------------

/** Generate the opening script from graph gaps. */
export async function generateScript(llm: LlmClient, gaps: CoverageGap[]): Promise<string[]> {
  if (gaps.length === 0) return [FALLBACK_QUESTION];
  const raw = await llm.complete({
    system: interviewSystemPrompt(),
    prompt: [
      'Genera un guion de preguntas concretas (una por línea, sin numerar) a partir de estos huecos del grafo:',
      ...gaps.map((g) => `- ${g.detail}`),
      'Devuelve JSON: { "questions": ["...", "..."] }',
    ].join('\n'),
    schema: {
      type: 'object',
      properties: { questions: { type: 'array', items: { type: 'string' } } },
      required: ['questions'],
      additionalProperties: false,
    },
  });
  const parsed = parseJsonResponse(raw) as { questions: string[] };
  const questions = parsed.questions.filter((q) => q.trim().length > 0);
  return questions.length > 0 ? questions : [FALLBACK_QUESTION];
}

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
// 4. Live validation actions: accept / edit / reject, bulk, verification verdicts
// ---------------------------------------------------------------------------

function proposalById(state: InterviewState, proposalId: string): ProposedTriple {
  const proposal = state.proposals.find((p) => p.id === proposalId);
  // "not found" phrasing on purpose: the sidecar maps it to HTTP 404.
  if (proposal === undefined) throw new Error(`proposal "${proposalId}" not found`);
  return proposal;
}

export function acceptProposal(state: InterviewState, proposalId: string): ProposedTriple {
  const proposal = proposalById(state, proposalId);
  if (proposal.kind === 'verification') {
    throw new Error(`Proposal ${proposalId} is a verification — use confirm/refute/skip`);
  }
  proposal.status = 'accepted';
  return proposal;
}

export function rejectProposal(state: InterviewState, proposalId: string): ProposedTriple {
  const proposal = proposalById(state, proposalId);
  if (proposal.kind === 'verification') {
    throw new Error(`Proposal ${proposalId} is a verification — use confirm/refute/skip`);
  }
  proposal.status = 'rejected';
  return proposal;
}

export interface ProposalPatch {
  /** Node corrections. */
  name?: string;
  description?: string;
  type?: NodeType;
  /** Edge correction. */
  edgeType?: EdgeType;
}

/**
 * Apply the interviewee's correction to a proposal ("acepta, corrige o
 * rechaza") and re-render its statement. Editing does not auto-accept: the
 * corrected proposal goes back to the panel for an explicit accept.
 */
export function editProposal(
  state: InterviewState,
  proposalId: string,
  patch: ProposalPatch,
): ProposedTriple {
  const proposal = proposalById(state, proposalId);
  if (proposal.kind === 'node' && proposal.node !== undefined) {
    if (patch.name !== undefined && patch.name.trim() !== '') {
      const newName = patch.name.trim();
      const oldKey = slugify(proposal.node.mention.trim());
      proposal.node.name = newName;
      proposal.node.mention = newName;
      // Edge proposals reference endpoints by mention: follow the rename so
      // an accepted edge is not orphaned by its corrected endpoint.
      for (const other of state.proposals) {
        if (other.edge === undefined) continue;
        let touched = false;
        if (slugify(other.edge.source_mention.trim()) === oldKey) {
          other.edge.source_mention = newName;
          touched = true;
        }
        if (slugify(other.edge.target_mention.trim()) === oldKey) {
          other.edge.target_mention = newName;
          touched = true;
        }
        if (touched) {
          other.statement = renderEdgeStatement(
            other.edge.type,
            other.edge.source_mention,
            other.edge.target_mention,
            other.edge.stance,
          );
        }
      }
    }
    if (patch.description !== undefined && patch.description.trim() !== '') {
      proposal.node.description = patch.description.trim();
    }
    if (patch.type !== undefined) proposal.node.type = patch.type;
    proposal.statement = renderNodeStatement(proposal.node);
  } else if (proposal.kind === 'edge' && proposal.edge !== undefined) {
    if (patch.edgeType !== undefined) proposal.edge.type = patch.edgeType;
    proposal.statement = renderEdgeStatement(
      proposal.edge.type,
      proposal.edge.source_mention,
      proposal.edge.target_mention,
      proposal.edge.stance,
    );
  } else {
    throw new Error(`Proposal ${proposalId} is a verification and cannot be edited`);
  }
  proposal.status = 'proposed';
  return proposal;
}

/**
 * Bulk accept with exceptions (docs/04 Fase 4 mitigation for triple-by-triple
 * friction): every pending node/edge proposal is accepted except the listed ids.
 */
export function acceptAll(state: InterviewState, except: string[] = []): ProposedTriple[] {
  const excluded = new Set(except);
  const accepted: ProposedTriple[] = [];
  for (const proposal of state.proposals) {
    if (proposal.kind === 'verification') continue;
    if (proposal.status !== 'proposed') continue;
    if (excluded.has(proposal.id)) continue;
    proposal.status = 'accepted';
    accepted.push(proposal);
  }
  return accepted;
}

export type VerificationVerdict = 'confirm' | 'refute' | 'skip';

/**
 * Verdict on an existing low-confidence edge: confirm adds `supports`
 * interview evidence with validated_by (edge recomputes to 0.95), refute adds
 * `contradicts` evidence (the edge turns conflicted), skip records nothing.
 */
export function resolveVerification(
  state: InterviewState,
  proposalId: string,
  verdict: VerificationVerdict,
): ProposedTriple {
  const proposal = proposalById(state, proposalId);
  if (proposal.kind !== 'verification' || proposal.verification === undefined) {
    throw new Error(`Proposal ${proposalId} is not a verification`);
  }
  proposal.status = verdict === 'confirm' ? 'confirmed' : verdict === 'refute' ? 'refuted' : 'skipped';
  return proposal;
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
