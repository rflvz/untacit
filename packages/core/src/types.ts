/**
 * untacit shared types — the single source of truth for the data model.
 * Derived from docs/02-ontologia-spec.md. Schema identifiers are English;
 * content (name, description, excerpts) is in the organization's language.
 */

// ---------------------------------------------------------------------------
// Ontology enums (docs/02 §2, §3)
// ---------------------------------------------------------------------------

export type NodeType =
  | 'entity'
  | 'process'
  | 'rule'
  | 'policy'
  | 'event'
  | 'system'
  | 'role';

export type EdgeType =
  | 'OPERATES_ON'
  | 'VALIDATES'
  | 'CALCULATES'
  | 'TRIGGERS'
  | 'EXECUTES'
  | 'DEPENDS_ON'
  | 'GOVERNS'
  | 'IMPLEMENTED_IN'
  | 'PART_OF';

/** `stale`: only evidence pointed at a source fragment that disappeared (docs/03 §5). */
export type ElementStatus = 'active' | 'deprecated' | 'conflicted' | 'stale';

export type SourceType = 'code' | 'document' | 'interview';

export type Stance = 'supports' | 'contradicts';

// ---------------------------------------------------------------------------
// Provenance (docs/02 §5)
// ---------------------------------------------------------------------------

export interface CodeLocator {
  repo: string;
  path: string;
  line_start: number;
  line_end: number;
  commit?: string;
}

export interface DocumentLocator {
  doc_id: string;
  title?: string;
  section?: string;
  page?: number;
}

/** speaker_role, never a person's name (privacy, docs/03 §8). */
export interface InterviewLocator {
  interview_id: string;
  speaker_role: string;
  turn?: number;
}

export type Locator =
  | CodeLocator
  | DocumentLocator
  | InterviewLocator
  | Record<string, unknown>;

export interface ExtractorInfo {
  name: string;
  model?: string;
  prompt_version?: string;
}

export interface Evidence {
  source_type: SourceType;
  locator: Locator;
  /** Literal fragment, ≤ 300 chars. */
  excerpt: string;
  stance: Stance;
  extractor?: ExtractorInfo;
  /** ISO date (YYYY-MM-DD). */
  extracted_at?: string;
  /** Run id that asserted this evidence. */
  run?: string;
  /** null | human role identifier that validated it live. */
  validated_by?: string | null;
}

/**
 * Identity key of an evidence for dedup on re-import:
 * (source_type, canonical-JSON locator, excerpt, stance). Two evidences with
 * the same key are the same evidence — re-importing an identical batch must
 * leave the graph repo without diff (idempotence, docs/03 §3).
 */
export type EvidenceKey = string;

// ---------------------------------------------------------------------------
// Graph elements (docs/02 §4) — canonical, file-backed representation
// ---------------------------------------------------------------------------

/** A node reference as stored in edge targets: `"<type>/<id>"`, e.g. `"process/process-alta-pedido"`. */
export type NodeRef = string;

export interface GraphEdge {
  type: EdgeType;
  /** NodeRef of the target node. */
  target: NodeRef;
  /** 0.0–1.0, combined per docs/02 §7. */
  confidence: number;
  status: ElementStatus;
  attrs?: Record<string, unknown>;
  evidence: Evidence[];
}

export interface GraphNode {
  /** Stable kebab-case slug == file name (without .md), e.g. "rule-descuento-volumen". */
  id: string;
  type: NodeType;
  name: string;
  /** Markdown body of the node file, 1–3 sentences. */
  description: string;
  aliases: string[];
  status: ElementStatus;
  attrs: Record<string, unknown>;
  /** Evidence backing the node itself. */
  evidence: Evidence[];
  /** Outgoing edges live in the source node's file. */
  edges: GraphEdge[];
  schema_version: number;
}

// ---------------------------------------------------------------------------
// Extraction batch (docs/02 §8) — the emission contract; never persisted
// ---------------------------------------------------------------------------

export interface BatchEvidence {
  locator: Record<string, unknown>;
  excerpt: string;
  /**
   * Role identifier that validated the assertion live (interview flow only).
   * Drives the 0.95 base confidence of docs/02 §7.
   */
  validated_by?: string | null;
}

export interface BatchNode {
  /** Name exactly as it appears in the source. Canonicalization happens in the resolver. */
  mention: string;
  /** Canonical id if the extractor believes it recognizes an existing node. */
  candidate_id?: string | null;
  type: NodeType;
  name: string;
  description: string;
  attrs?: Record<string, unknown>;
  evidence: BatchEvidence;
}

export interface BatchEdge {
  type: EdgeType;
  source_mention: string;
  target_mention: string;
  stance?: Stance;
  attrs?: Record<string, unknown>;
  evidence: BatchEvidence;
}

export interface ExtractionBatch {
  run_id: string;
  source_type: SourceType;
  schema_version?: number;
  extractor?: ExtractorInfo;
  nodes: BatchNode[];
  edges: BatchEdge[];
}

// ---------------------------------------------------------------------------
// Validation (docs/02 §8: JSON Schema + domain→range; rejected items keep a reason)
// ---------------------------------------------------------------------------

export interface ValidationIssue {
  /** JSON-path-ish location, e.g. "edges/3" or "nodes/0/type". */
  path: string;
  message: string;
  /** The offending item, when it maps to a node/edge. */
  item?: unknown;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
  /**
   * Batch with invalid nodes/edges dropped (salvage mode), so a partially bad
   * batch can still be imported while every rejection is recorded with reason.
   */
  sanitized?: ExtractionBatch;
}

// ---------------------------------------------------------------------------
// Entity resolution (docs/02 §9)
// ---------------------------------------------------------------------------

export type ResolutionAction =
  | 'exact-match'
  | 'fuzzy-match'
  | 'created'
  | 'created-provisional';

export interface ResolutionDecision {
  mention: string;
  action: ResolutionAction;
  /** Canonical node id the mention resolved to (or the newly created id). */
  nodeId: string;
  /** Similarity score for fuzzy / gray-zone decisions. */
  score?: number;
  /** Set when a merge proposal was enqueued (gray zone). */
  proposalId?: string;
}

export interface MergeProposal {
  id: string;
  /** Provisional node created for the unresolved mention. */
  sourceNodeId: string;
  /** Existing candidate node it might be merged into. */
  targetNodeId: string;
  mention: string;
  score: number;
  status: 'pending' | 'accepted' | 'rejected';
  created_at?: string;
  resolved_at?: string;
  resolved_by?: string;
}

export interface MergeRecord {
  id: string;
  /** Node that was absorbed (loses its file). */
  fromNodeId: string;
  /** Surviving canonical node. */
  intoNodeId: string;
  approved_by?: string;
  merged_at?: string;
  /** Snapshot allowing reversal. */
  from_snapshot?: GraphNode;
}

// ---------------------------------------------------------------------------
// Runs (docs/03 §5: one run == one commit)
// ---------------------------------------------------------------------------

export interface RunStats {
  nodes_created: number;
  nodes_updated: number;
  edges_created: number;
  edges_updated: number;
  evidence_added: number;
  rejected: number;
  merge_proposals: number;
}

export interface RunMeta {
  id: string;
  source_type: SourceType;
  extractor?: ExtractorInfo;
  started_at?: string;
  finished_at?: string;
  stats: RunStats;
  /** Hash of the graph-repo commit this run produced. */
  commit?: string;
  /** Everything the validator rejected, with reasons — signal for prompt iteration. */
  rejections?: ValidationIssue[];
}

// ---------------------------------------------------------------------------
// Conflicts (docs/02 §6) — derived, materialized in the index
// ---------------------------------------------------------------------------

/** Evidence inside a Conflict row, addressable for resolution. */
export interface ConflictEvidence extends Evidence {
  /** Stable short id of this evidence (shortHash of its identity key). */
  key: string;
}

export interface Conflict {
  id: string;
  /** Node that owns the conflicted edge, and the edge id. */
  nodeId: string;
  edgeId: string;
  edgeType: EdgeType;
  target: NodeRef;
  supporting: ConflictEvidence[];
  contradicting: ConflictEvidence[];
}

/**
 * Human resolution of a conflicted edge (docs/02 §6): persisted in
 * edge.attrs.conflict_resolution, pinned to the exact evidence set it judged.
 * New evidence changes the set hash and re-opens the conflict.
 */
export interface ConflictResolutionRecord {
  /** Key (shortHash of the evidence identity) of the winning evidence. */
  winner: string;
  /** Status the resolution produced: supports won → active, contradicts won → deprecated. */
  status: 'active' | 'deprecated';
  /** Hash of the sorted evidence keys at resolution time. */
  evidence_set: string;
  /** Human role identifier that resolved it. */
  by?: string;
  /** ISO datetime of the resolution. */
  at: string;
}

// ---------------------------------------------------------------------------
// Index query results (docs/03 §6)
// ---------------------------------------------------------------------------

export interface SearchResult {
  id: string;
  type: NodeType;
  name: string;
  /** First line of the description. */
  summary: string;
  score: number;
}

export interface GraphStats {
  nodes_total: number;
  edges_total: number;
  nodes_by_type: Record<string, number>;
  edges_by_type: Record<string, number>;
  by_status: Record<string, number>;
  conflicts_open: number;
  low_confidence_edges: number;
  evidence_total: number;
}

// ---------------------------------------------------------------------------
// Ontology diff (docs/03 §5: drift == git diff presented in ontology terms)
// ---------------------------------------------------------------------------

export interface EdgeChange {
  sourceId: string;
  type: EdgeType;
  target: NodeRef;
  kind: 'added' | 'removed' | 'changed';
  /** For 'changed': what moved. */
  before?: Partial<Pick<GraphEdge, 'confidence' | 'status'>>;
  after?: Partial<Pick<GraphEdge, 'confidence' | 'status'>>;
}

export interface NodeChange {
  id: string;
  type: NodeType;
  kind: 'added' | 'removed' | 'changed';
  fields?: string[];
}

export interface GraphDiff {
  ref_a: string;
  ref_b: string;
  nodes: NodeChange[];
  edges: EdgeChange[];
}

// ---------------------------------------------------------------------------
// Graph repo config (untacit.config.json, docs/03 §8)
// ---------------------------------------------------------------------------

export interface CodeSourceConfig {
  /** Human name of the source repo (used in code locators as `repo`). */
  name: string;
  path: string;
  include?: string[];
  exclude?: string[];
}

export interface DocumentSourceConfig {
  path: string;
  include?: string[];
  exclude?: string[];
}

/**
 * Node-embedding pipeline configuration (docs/03 §3). Vectors are derived
 * data: they live only in .untacit/index.db, never in the graph repo.
 */
export interface EmbeddingsConfig {
  /**
   * 'auto' uses a local multilingual model when @huggingface/transformers is
   * installed, and otherwise disables the semantic channel; 'hash' is the
   * deterministic offline provider (tests/demos); 'none' disables embeddings.
   */
  provider: 'auto' | 'hash' | 'transformers' | 'none';
  /** Model id for the transformers provider (default: multilingual e5 small). */
  model?: string;
}

export interface UntacitConfig {
  /** Content language of the graph (e.g. "es"). Schema identifiers are always English. */
  language: string;
  schema_version: number;
  sources: {
    code: CodeSourceConfig[];
    documents: DocumentSourceConfig[];
  };
  thresholds: {
    /** Edges below this confidence enter the review queue. */
    review: number;
    /** ≥ auto → automatic resolve; between gray and auto → merge proposal. */
    resolver_auto: number;
    resolver_gray: number;
  };
  embeddings?: EmbeddingsConfig;
}
