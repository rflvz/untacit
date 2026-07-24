/**
 * Interview state — plain JSON, UI-agnostic (the app drives it over the
 * sidecar and the CLI over readline; state travels over HTTP untouched).
 * Holds the session lifecycle (start/serialize/resume) and the live
 * validation actions on proposals (accept / edit / reject, bulk,
 * verification verdicts).
 */

import { slugify } from '@untacit/core';
import type { BatchEdge, BatchNode, EdgeType, NodeType } from '@untacit/core';

import type { VerificationTarget } from './gaps.js';
import { renderEdgeStatement, renderNodeStatement } from './render.js';

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

export const FALLBACK_QUESTION =
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
export function nextScriptQuestion(state: InterviewState): string | undefined {
  if (state.scriptIndex >= state.script.length) return undefined;
  const question = state.script[state.scriptIndex];
  state.scriptIndex++;
  return question;
}

// ---------------------------------------------------------------------------
// 4. Live validation actions: accept / edit / reject, bulk, verification verdicts
// ---------------------------------------------------------------------------

export function proposalById(state: InterviewState, proposalId: string): ProposedTriple {
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
// Session persistence: resume an interrupted interview (CLI --resume)
// ---------------------------------------------------------------------------

export interface PersistedInterview {
  version: 1;
  savedAt: string;
  /**
   * Everything except the transcript. The conversation itself is deliberately
   * never persisted (privacy, docs/05): what survives is role + proposal
   * excerpts — exactly what an import would materialize anyway.
   */
  state: Omit<InterviewState, 'transcript'>;
}

/** Snapshot for disk, with the transcript stripped. */
export function serializeInterview(state: InterviewState, now = new Date()): PersistedInterview {
  const { transcript: _transcript, ...rest } = state;
  return { version: 1, savedAt: now.toISOString(), state: structuredClone(rest) };
}

/**
 * Rebuild a live session from a snapshot. The transcript restarts with a
 * recap turn (progress + the question that was on the table) — that recap is
 * all the conversational context the next processAnswer call gets, which is
 * enough anchoring for the turn contract.
 */
export function resumeInterview(persisted: PersistedInterview): InterviewState {
  const state: InterviewState = { ...structuredClone(persisted.state), transcript: [] };
  const accepted = state.proposals.filter(
    (p) => p.kind !== 'verification' && p.status === 'accepted',
  ).length;
  const pending = state.proposals.filter(
    (p) => p.kind !== 'verification' && p.status === 'proposed',
  ).length;
  const parts = [
    `Retomamos la entrevista anterior (rol: ${state.speakerRole}): ${accepted} propuesta(s) aceptada(s), ${pending} pendiente(s).`,
  ];
  if (state.finished) {
    parts.push('Habíamos cubierto el guion; puedes seguir aportando detalle o cerrar con ":fin".');
  } else if (state.scriptIndex > 0) {
    parts.push(`Seguimos donde lo dejamos: ${state.script[state.scriptIndex - 1]!}`);
  } else {
    parts.push(nextScriptQuestion(state) ?? FALLBACK_QUESTION);
  }
  state.transcript.push({ speaker: 'agent', text: parts.join(' ') });
  return state;
}
