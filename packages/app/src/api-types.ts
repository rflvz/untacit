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
  CodeSourceConfig,
  DocumentSourceConfig,
  EmbeddingsConfig,
  RetrievalChannel,
  RetrievalConfig,
  RetrievalPlan,
  UntacitConfig,
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
  CodeSourceConfig,
  DocumentSourceConfig,
  EmbeddingsConfig,
  RetrievalChannel,
  RetrievalConfig,
  RetrievalPlan,
  UntacitConfig,
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
  /** True when the directory has an untacit.config.json (initialized graph repo). */
  isGraphRepo: boolean;
  /** 'loaded' when @untacit/core resolved; 'unavailable' -> API routes answer 503. */
  core: 'loaded' | 'unavailable';
  coreError?: string;
}

/** Body of POST /api/init (all fields optional). */
export interface InitRequest {
  /** Content language for the new graph (default "es"). */
  language?: string;
}

export interface InitResponse {
  ok: boolean;
  /** Absolute path of the initialized graph repo. */
  repo: string;
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

/** Body of POST /api/import: an extraction batch plus import options. */
export interface ImportRequest {
  /** The batch JSON, verbatim (validated by the core pipeline). */
  batch: unknown;
  /** Commit the run on a new branch (extraction-as-PR). */
  branch?: string;
}

/** JSON-safe mirror of the core pipeline's ImportResult. */
export interface ImportResponse {
  ok: boolean;
  runId: string;
  stats: RunStats;
  rejections: ValidationIssue[];
  proposals: MergeProposal[];
  /** Commit hash of the run, null when nothing changed / repo not git. */
  commit: string | null;
  /** Branch the run was committed on, null for the current branch. */
  branch: string | null;
  /** True when the import changed nothing (identical re-import). */
  noop: boolean;
}

// ---------------------------------------------------------------------------
// Git surface (Runs view + Drift ref picker)
// ---------------------------------------------------------------------------

export interface GitLogEntry {
  hash: string;
  subject: string;
  /** Strict-ISO committer date. */
  date: string;
}

export interface GitLogResponse {
  commits: GitLogEntry[];
}

/** JSON-safe mirror of core's GitRemoteStatus. */
export interface GitStatusResponse {
  /** Current branch, null on detached HEAD / unborn repo. */
  branch: string | null;
  /** Upstream ref ("origin/main"), null when the branch tracks nothing. */
  upstream: string | null;
  /** Local commits to push. */
  ahead: number;
  /** Upstream commits to pull. */
  behind: number;
  /** True when the working tree has uncommitted changes. */
  dirty: boolean;
  /** Set when ?fetch=1 was requested and the fetch failed (offline, no remote). */
  fetchError?: string;
}

/** POST /api/git/pull | push. */
export interface GitSyncResponse {
  ok: boolean;
  /** HEAD after the operation. */
  head: string;
  status: GitStatusResponse;
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
// Extraction from the app (sidecar/extract.ts): `extract code` / `extract
// docs` over the sources declared in untacit.config.json, as a long-running
// in-memory job. The engine is the local `claude` CLI — no API key anywhere.
// ---------------------------------------------------------------------------

export type ExtractKind = 'code' | 'docs';

/** A declared source resolved against this machine, ready to extract from. */
export interface ExtractSource {
  kind: ExtractKind;
  /** Stable key used in requests: the `name` (code) or the config `path` (docs). */
  key: string;
  /** Label for the picker: the source name, or the folder name for documents. */
  label: string;
  /** Path exactly as declared in untacit.config.json. */
  path: string;
  /** Absolute path it resolves to on this machine. */
  resolvedPath: string;
  exists: boolean;
  /** Parseable documents found under the source (document sources only). */
  documentCount?: number;
}

/** GET /api/extract/sources — the picker plus engine availability. */
export interface ExtractSourcesResponse {
  sources: ExtractSource[];
  /** False when the local `claude` binary is unreachable: POST /api/extract 503s. */
  llmReady: boolean;
  /** Why the engine is unavailable, with the install hint (when llmReady false). */
  llmDetail?: string;
  /** Job currently running, null when the sidecar is idle (one at a time). */
  runningJobId: string | null;
}

/** JSON-safe mirror of the extractors' Candidate (heuristic code fragment). */
export interface ExtractCandidate {
  repo: string;
  path: string;
  line_start: number;
  line_end: number;
  snippet: string;
  /** Heuristic signals that fired, for judging candidate quality. */
  signals: string[];
}

/** JSON-safe mirror of the extractors' DocumentSection. */
export interface ExtractSection {
  doc_id: string;
  title: string;
  section: string;
  /** 1-based page number — present for paginated sources (PDF). */
  page?: number;
  text: string;
}

/** A source file the segmenter could not parse (reported, never fatal). */
export interface ExtractSkippedFile {
  /** Path relative to the source root. */
  path: string;
  reason: string;
}

/** Body of POST /api/extract/preview — the CLI's --candidates-only / --sections-only. */
export interface ExtractPreviewRequest {
  kind: ExtractKind;
  /** ExtractSource.key. */
  source: string;
  /** code: cap on candidates scanned (default 50). */
  maxCandidates?: number;
  /** code: repo-relative files/dirs to scan instead of the whole source. */
  paths?: string[];
  /** Candidates (code) or sections (docs) per LLM call, for plannedCalls. */
  chunkSize?: number;
}

/** POST /api/extract/preview — what an extraction would send, with no LLM call. */
export interface ExtractPreviewResponse {
  kind: ExtractKind;
  source: string;
  /** Chunk size the estimate used. */
  chunkSize: number;
  /** Present for kind = "code". */
  candidates?: ExtractCandidate[];
  /** Present for kind = "docs". */
  sections?: ExtractSection[];
  /** Source-relative files behind the preview. */
  files: string[];
  /** LLM calls the extraction would make with this chunking. */
  plannedCalls: number;
  /** Documents whose format could not be parsed (docs only). */
  skipped?: ExtractSkippedFile[];
}

/** Body of POST /api/extract. */
export interface ExtractStartRequest {
  kind: ExtractKind;
  /** ExtractSource.key. */
  source: string;
  maxCandidates?: number;
  paths?: string[];
  /** code: candidates per LLM call. docs: sections per LLM call. */
  chunkSize?: number;
  /** Model for the extraction agent (`claude --model`); default = Claude Code's. */
  model?: string;
  /** Commit the run on a branch (extraction-as-PR); true → run/<run_id>. */
  branch?: string | boolean;
}

/**
 * escaneo de candidatos → llamadas LLM → import, then a terminal phase.
 * "cancelled" discards the partial batch, like Ctrl+C on `untacit extract`.
 */
export type ExtractPhase = 'scanning' | 'extracting' | 'importing' | 'done' | 'error' | 'cancelled';

/** What the import produced once a job reaches phase "done" with changes. */
export interface ExtractJobResult {
  runId: string;
  stats: RunStats;
  rejections: ValidationIssue[];
  proposals: MergeProposal[];
  /** Commit hash of the run, null when nothing changed / repo not git. */
  commit: string | null;
  /** Branch the run was committed on, null for the current branch. */
  branch: string | null;
  noop: boolean;
  /** Nodes the agent emitted, before the resolver merged them into the graph. */
  batchNodes: number;
  batchEdges: number;
}

/** Snapshot of an extraction job (GET /api/extract/:id and SSE `job` events). */
export interface ExtractJob {
  id: string;
  kind: ExtractKind;
  /** ExtractSource.key the job runs over. */
  source: string;
  phase: ExtractPhase;
  /** Human-readable current step, shown verbatim in the UI. */
  message: string;
  startedAt: string;
  finishedAt?: string;
  /** Candidates (code) or sections (docs) the scan produced. */
  units: number;
  /** Units per LLM call. */
  chunkSize: number;
  /** LLM calls completed so far. */
  llmCalls: number;
  /** LLM calls the run will make in total (0 until the scan finishes). */
  plannedCalls: number;
  /** Elements the validator rejected during extraction. */
  rejections: ValidationIssue[];
  /** Model the agent runs on ("default" = Claude Code's own default). */
  model: string;
  /** True once a cancellation was requested (effective at the next chunk). */
  cancelRequested: boolean;
  /** Documents whose format could not be parsed (docs only). */
  skipped?: ExtractSkippedFile[];
  result?: ExtractJobResult;
  /** Message of the failure that ended the job (phase "error"). */
  error?: string;
  /** True while the emitted batch is retrievable at /api/extract/:id/batch. */
  batchAvailable: boolean;
  /**
   * Where a failed import's batch was rescued to (under the repo's gitignored
   * `.untacit/`), so the LLM spend survives the job's in-memory lifetime.
   */
  rescuePath?: string;
}

/** POST /api/extract — 202 with the freshly created job. */
export interface ExtractStartResponse {
  job: ExtractJob;
}

/** GET /api/extract — remembered jobs, newest first. */
export interface ExtractJobsResponse {
  jobs: ExtractJob[];
  runningJobId: string | null;
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
  /** False when the local `claude` binary is unreachable: start would 503. */
  llmReady: boolean;
  llmDetail?: string;
  /** Interrupted session found on disk, resumable (null when there is none). */
  saved: InterviewSavedSession | null;
}

/**
 * Summary of the interrupted session persisted in
 * `.untacit/interview-session.json` — the same file and format the CLI's
 * `untacit interview --resume` reads.
 *
 * The transcript is NOT part of it: only the role, the script, the index and
 * the proposals are ever written to disk (docs/05 §privacidad).
 */
export interface InterviewSavedSession {
  interviewId: string;
  /** Role of the interviewee — never a person's name. */
  speakerRole: string;
  /** ISO timestamp of the last save. */
  savedAt: string;
  turn: number;
  script: string[];
  scriptIndex: number;
  finished: boolean;
  /** Node/edge proposals already accepted. */
  accepted: number;
  /** Node/edge proposals still awaiting a decision. */
  pending: number;
  /** Cross-verifications still unanswered. */
  verificationsPending: number;
  /** True when the session is also live in the sidecar's memory. */
  live: boolean;
}

/** GET /api/interview/saved — is there an interrupted session to resume? */
export interface InterviewSavedResponse {
  saved: InterviewSavedSession | null;
}

/** Body of POST /api/interview/start. */
export interface InterviewStartRequest {
  /** Role identifier stored in every locator/validated_by (never a name). */
  role: string;
  /** Model for the interviewer agent (`claude --model`, the CLI's --model). */
  model?: string;
  /**
   * Overwrite an interrupted session instead of refusing. Without it, a saved
   * snapshot makes start answer 409 — that work cost a real conversation.
   */
  discardSaved?: boolean;
}

/** Body of POST /api/interview/resume — re-pick the model, like the CLI. */
export interface InterviewResumeRequest {
  model?: string;
}

export interface InterviewStartResponse {
  state: InterviewStateResponse;
  gaps: InterviewGap[];
  /** Model this session's agent runs on ("default" = Claude Code's own). */
  model: string;
  /** True when the state came from the persisted session (resume). */
  resumed?: boolean;
}

/** DELETE /api/interview/saved — drop the interrupted session. */
export interface InterviewDiscardResponse {
  ok: boolean;
  /** False when there was nothing on disk to discard. */
  discarded: boolean;
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

// ---------------------------------------------------------------------------
// Settings & retrieval (Ajustes view)
// ---------------------------------------------------------------------------

/** GET /api/settings — current config + embedding-model status. */
export interface SettingsResponse {
  config: UntacitConfig;
  embeddings: {
    /** Whether @huggingface/transformers resolves in this installation. */
    transformersInstalled: boolean;
    /**
     * Name of the provider currently loaded in the sidecar (e.g.
     * "transformers:Xenova/multilingual-e5-small"), null when the semantic
     * channel is off or the model has not been loaded yet (lazy).
     */
    activeProvider: string | null;
    /** Default model id used when embeddings.model is not set. */
    defaultModel: string;
  };
}

/** Body of PUT /api/settings — sections replace their config counterpart. */
export interface SettingsUpdateRequest {
  embeddings?: EmbeddingsConfig;
  retrieval?: RetrievalConfig;
  /** Source repos/folders used to resolve evidence locators (POST /api/open). */
  sources?: {
    code: CodeSourceConfig[];
    documents: DocumentSourceConfig[];
  };
}

export interface SettingsUpdateResponse {
  ok: boolean;
  config: UntacitConfig;
  /** Commit hash, null when the repo is not git or nothing changed. */
  commit: string | null;
}

/** Body of POST /api/retrieval/test. */
export interface RetrievalTestRequest {
  query: string;
  limit?: number;
  /** Try the query under a config other than the saved one (unsaved UI state). */
  retrieval?: RetrievalConfig;
}

export interface RetrievalTestNode extends SearchResult {
  seed: boolean;
  distance: number;
  channels: RetrievalChannel[];
}

/** POST /api/retrieval/test — one full pipeline run with provenance. */
export interface RetrievalTestResponse {
  nodes: RetrievalTestNode[];
  edges: ApiEdge[];
  truncated: boolean;
  plan: RetrievalPlan;
  /** Provider used for the semantic channels, null when unavailable. */
  provider: string | null;
  tookMs: number;
}
