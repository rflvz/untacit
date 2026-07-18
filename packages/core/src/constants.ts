/**
 * Ontology constants — closed schema v1 (docs/02).
 * The validator rejects anything outside these tables before it touches disk.
 */

import type { EdgeType, NodeType, SourceType } from './types.js';

export const SCHEMA_VERSION = 1;

export const NODE_TYPES: readonly NodeType[] = [
  'entity',
  'process',
  'rule',
  'policy',
  'event',
  'system',
  'role',
] as const;

export const EDGE_TYPES: readonly EdgeType[] = [
  'OPERATES_ON',
  'VALIDATES',
  'CALCULATES',
  'TRIGGERS',
  'EXECUTES',
  'DEPENDS_ON',
  'GOVERNS',
  'IMPLEMENTED_IN',
  'PART_OF',
] as const;

/**
 * Domain → range restrictions (docs/02 §3). PART_OF additionally requires
 * source.type === target.type (process→process, entity→entity); the validator
 * enforces that with PART_OF_SAME_TYPE.
 */
export const DOMAIN_RANGE: Record<
  EdgeType,
  { source: readonly NodeType[]; target: readonly NodeType[] }
> = {
  OPERATES_ON: { source: ['rule'], target: ['entity'] },
  VALIDATES: { source: ['rule'], target: ['process', 'entity'] },
  CALCULATES: { source: ['rule'], target: ['entity'] },
  TRIGGERS: { source: ['event', 'process'], target: ['process', 'event'] },
  EXECUTES: { source: ['role', 'system'], target: ['process'] },
  DEPENDS_ON: {
    source: ['process', 'rule'],
    target: ['process', 'rule', 'entity', 'system'],
  },
  GOVERNS: { source: ['policy'], target: ['rule', 'process'] },
  IMPLEMENTED_IN: { source: ['rule', 'process'], target: ['system'] },
  PART_OF: { source: ['process', 'entity'], target: ['process', 'entity'] },
};

export const PART_OF_SAME_TYPE = true;

/** Base confidence per evidence origin (docs/02 §7). */
export const BASE_CONFIDENCE: Record<SourceType, number> = {
  code: 0.9,
  document: 0.7,
  interview: 0.6,
};

/** An interview evidence validated live by the interviewee. */
export const INTERVIEW_VALIDATED_CONFIDENCE = 0.95;

/** Bonus per additional *distinct* source type with supporting evidence. */
export const MULTI_SOURCE_BONUS = 0.05;

export const CONFIDENCE_CEILING = 0.99;

/** Edges below this confidence enter the review queue. */
export const DEFAULT_REVIEW_THRESHOLD = 0.7;

/** Resolver thresholds (docs/02 §9): ≥ auto resolves, [gray, auto) proposes merge, < gray creates new node. */
export const DEFAULT_RESOLVER_THRESHOLDS = {
  auto: 0.92,
  gray: 0.75,
} as const;

export const MAX_EXCERPT_LENGTH = 300;

// ---------------------------------------------------------------------------
// Canonical serialization order (docs/02 §12, docs/03 §3).
// Deterministic: re-extracting with unchanged sources leaves `git status` clean.
// ---------------------------------------------------------------------------

/** Frontmatter key order for node files. `id` is the file name, never a key. */
export const NODE_KEY_ORDER = [
  'type',
  'name',
  'status',
  'aliases',
  'attrs',
  'evidence',
  'edges',
  'schema_version',
] as const;

export const EDGE_KEY_ORDER = [
  'type',
  'target',
  'confidence',
  'status',
  'attrs',
  'evidence',
] as const;

export const EVIDENCE_KEY_ORDER = [
  'source_type',
  'locator',
  'excerpt',
  'stance',
  'extractor',
  'extracted_at',
  'run',
  'validated_by',
] as const;

export const LOCATOR_KEY_ORDER: Record<SourceType, readonly string[]> = {
  code: ['repo', 'path', 'line_start', 'line_end', 'commit'],
  document: ['doc_id', 'title', 'section', 'page'],
  interview: ['interview_id', 'speaker_role', 'turn'],
};

export const EXTRACTOR_KEY_ORDER = ['name', 'model', 'prompt_version'] as const;
