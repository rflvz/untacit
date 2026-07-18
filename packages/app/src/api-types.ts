/**
 * Response shapes of the sidecar HTTP API (sidecar/server.ts).
 *
 * Shared between the sidecar (Node) and the React frontend (browser). Only
 * *types* are imported from @untacit/core so the browser bundle never pulls
 * in core's Node runtime — the frontend tsconfig maps the package to
 * core/src/types.ts, the sidecar tsconfig to core/src/index.ts.
 */

import type {
  BatchEdge,
  BatchNode,
  Conflict,
  ConflictEvidence,
  ConflictResolutionRecord,
  EdgeChange,
  EdgeType,
  ElementStatus,
  Evidence,
  GraphDiff,
  GraphNode,
  GraphStats,
  MergeProposal,
  MergeRecord,
  NodeChange,
  NodeRef,
  NodeType,
  RunMeta,
  RunStats,
  SearchResult,
  SourceType,
  Stance,
  ValidationIssue,
} from '@untacit/core';

// Re-export the core types API consumers need, so frontend modules can import
// everything from one place.
export type {
  BatchEdge,
  BatchNode,
  Conflict,
  ConflictEvidence,
  ConflictResolutionRecord,
  EdgeChange,
  EdgeType,
  ElementStatus,
  Evidence,
  GraphDiff,
  GraphNode,
  GraphStats,
  MergeProposal,
  MergeRecord,
  NodeChange,
  NodeRef,
  NodeType,
  RunMeta,
  RunStats,
  SearchResult,
  SourceType,
  Stance,
  ValidationIssue,
};

/** Error body returned with any non-2xx status. */
export interface ApiError {
  error: string;
  detail?: string;
}

/**
 * JSON-safe mirror of the core indexer's EdgeRow (packages/core/src/indexer).
 * Re-declared here because the frontend maps @untacit/core to types.ts only.
 */
export interface ApiEdge {
  /** Stable edge id: edgeId(type, source, target). */
  id: string;
  /** Source node id (the node whose file owns the edge). */
  source: string;
  type: EdgeType;
  /** Target node ref "<type>/<id>". */
  target: NodeRef;
  /** Target node id (may be dangling). */
  targetId: string;
  confidence: number;
  status: ElementStatus;
  attrs?: Record<string, unknown>;
}

export interface HealthResponse {
  ok: boolean;
  service: 'untacit-sidecar';
  repo: string;
  repoExists: boolean;
  isGitRepo: boolean;
  /** 'loaded' when @untacit/core resolved; 'unavailable' -> API routes answer 503. */
  core: 'loaded' | 'unavailable';
  coreError?: string;
}

export type StatsResponse = GraphStats;

/** Lightweight node row for the global Sigma view. */
export interface ApiGraphNode {
  id: string;
  ref: NodeRef;
  type: NodeType;
  name: string;
  status: ElementStatus;
  /** First line of the description. */
  summary: string;
}

export interface GraphResponse {
  nodes: ApiGraphNode[];
  edges: ApiEdge[];
  /** Totals before filtering/capping. */
  totalNodes: number;
  totalEdges: number;
  /** True when the ~10k cap dropped elements. */
  truncated: boolean;
}

export interface NodeDetailResponse {
  node: GraphNode & { ref: NodeRef };
  edges: { direction: 'out' | 'in'; edge: ApiEdge }[];
  /** Evidence backing the node itself (same as node.evidence, explicit). */
  evidence: Evidence[];
}

export interface SearchResponse {
  results: SearchResult[];
}

export interface ConflictsResponse {
  conflicts: Conflict[];
}

/** The three review trays (docs/03 §7 point 3). */
export interface ReviewResponse {
  proposals: MergeProposal[];
  lowConfidence: ApiEdge[];
  conflicts: Conflict[];
  /** Confidence threshold used for the lowConfidence tray. */
  threshold: number;
}

export interface RunsResponse {
  runs: RunMeta[];
}

export interface DiffResponse {
  diff: GraphDiff;
  /** Human-readable rendering (core formatDiffText). */
  text: string;
}

/** Body of POST /api/open: an evidence's source_type + locator, verbatim. */
export interface OpenRequest {
  source_type: SourceType;
  locator: Record<string, unknown>;
}

export interface OpenResponse {
  ok: boolean;
  /** Absolute local path the locator resolved to. */
  path: string;
  /** 1-based line jumped to (code locators only). */
  line?: number;
  /** Opener command that ran (diagnostic). */
  command: string;
}

export interface MergeActionResponse {
  ok: boolean;
  proposalId: string;
  action: 'accepted' | 'rejected';
  /** Present when the action was an accept. */
  record?: MergeRecord;
  /** Commit hash of the graph-repo commit, null when nothing changed. */
  commit: string | null;
}

/** Body of POST /api/review/conflict/resolve. */
export interface ConflictResolveRequest {
  /** Node that owns the conflicted edge. */
  nodeId: string;
  edgeType: EdgeType;
  /** Target ref "<type>/<id>" exactly as reported in the Conflict row. */
  target: NodeRef;
  /** Key of the winning evidence (ConflictEvidence.key). */
  winnerKey: string;
  /** Human role identifier recording the decision. */
  by?: string;
}

export interface ConflictResolveResponse {
  ok: boolean;
  /** Status the edge ended in: supports won → active, contradicts won → deprecated. */
  status: 'active' | 'deprecated';
  resolution: ConflictResolutionRecord;
  /** Commit hash of the graph-repo commit, null when nothing changed. */
  commit: string | null;
}

// ---------------------------------------------------------------------------
// Agentic interviews (Fase 4, docs/03 §4.3). The shapes mirror the engine
// types of @untacit/extractors — re-declared here (like ApiEdge) because the
// frontend maps @untacit/core to types.ts and cannot import extractors.
// ---------------------------------------------------------------------------

export interface InterviewGap {
  kind: 'missing-role' | 'missing-trigger' | 'low-confidence-edge' | 'isolated-node';
  nodeId: string;
  detail: string;
}

/** A low-confidence edge rendered as a claim to confirm or refute live. */
export interface InterviewVerificationTarget {
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
  statement: string;
}

export type InterviewProposalStatus =
  | 'proposed'
  | 'accepted'
  | 'rejected'
  | 'confirmed'
  | 'refuted'
  | 'skipped';

export interface InterviewProposal {
  id: string;
  kind: 'node' | 'edge' | 'verification';
  /** Natural-language rendering shown to the interviewee. */
  statement: string;
  /** Turn of the answer this proposal came from (0 = session start). */
  turn: number;
  node?: BatchNode;
  edge?: BatchEdge;
  verification?: InterviewVerificationTarget;
  status: InterviewProposalStatus;
}

export interface InterviewStateResponse {
  interviewId: string;
  /** Role of the interviewee — never a person's name. */
  speakerRole: string;
  turn: number;
  transcript: { speaker: 'agent' | 'interviewee'; text: string }[];
  script: string[];
  scriptIndex: number;
  proposals: InterviewProposal[];
  finished: boolean;
}

/** GET /api/interview/gaps — preview before starting a session. */
export interface InterviewGapsResponse {
  gaps: InterviewGap[];
  verifications: InterviewVerificationTarget[];
  /** False when no LLM is reachable (missing ANTHROPIC_API_KEY): start would 503. */
  llmReady: boolean;
  llmDetail?: string;
}

/** Body of POST /api/interview/start. */
export interface InterviewStartRequest {
  /** Role identifier stored in every locator/validated_by (never a name). */
  role: string;
}

export interface InterviewStartResponse {
  state: InterviewStateResponse;
  gaps: InterviewGap[];
}

/** Body of POST /api/interview/:id/answer. */
export interface InterviewAnswerRequest {
  text: string;
}

export interface InterviewAnswerResponse {
  /** The agent's next utterance (already in state.transcript). */
  reply: string;
  /** Proposals extracted from this answer. */
  proposals: InterviewProposal[];
  finished: boolean;
  state: InterviewStateResponse;
}

export type InterviewProposalAction =
  | 'accept'
  | 'reject'
  | 'edit'
  | 'confirm'
  | 'refute'
  | 'skip';

/** Body of POST /api/interview/:id/proposal/:pid. */
export interface InterviewProposalRequest {
  action: InterviewProposalAction;
  /** Correction applied when action = "edit". */
  patch?: {
    name?: string;
    description?: string;
    type?: NodeType;
    edgeType?: EdgeType;
  };
}

export interface InterviewProposalResponse {
  ok: boolean;
  proposal: InterviewProposal;
}

/** Body of POST /api/interview/:id/accept-all. */
export interface InterviewAcceptAllRequest {
  /** Proposal ids to leave untouched (bulk accept with exceptions). */
  except?: string[];
}

export interface InterviewAcceptAllResponse {
  ok: boolean;
  /** Ids that flipped to accepted. */
  accepted: string[];
  state: InterviewStateResponse;
}

export interface InterviewFinishResponse {
  ok: boolean;
  runId: string;
  stats: RunStats;
  rejections: ValidationIssue[];
  /** Commit hash of the interview run, null when nothing changed. */
  commit: string | null;
  /** True when the session produced no graph changes. */
  noop: boolean;
  /** Node/edge proposals that entered the batch. */
  acceptedProposals: number;
  /** Verifications answered with confirm or refute. */
  verificationsResolved: number;
}
