/**
 * Frontend mirror of the closed ontology vocabulary (core constants.ts).
 *
 * The browser bundle must never import core's runtime (it is Node code), so
 * the 7 node types / statuses are re-declared here, typed against the core
 * type definitions so a schema change breaks this file at compile time.
 */

import type { EdgeType, ElementStatus, NodeType, SourceType } from './api-types.js';

export const NODE_TYPES: readonly NodeType[] = [
  'entity',
  'process',
  'rule',
  'policy',
  'event',
  'system',
  'role',
];

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
];

export const ELEMENT_STATUSES: readonly ElementStatus[] = [
  'active',
  'deprecated',
  'conflicted',
  'stale',
];

/**
 * 7-color legend, one per node type — the Untacit DS node palette
 * (tokens/colors.css --node-*). The DS slots use the Spanish ontology names;
 * `event` takes the remaining slot (--node-decision).
 */
export const NODE_TYPE_COLORS: Record<NodeType, string> = {
  entity: '#3D6BE0', // --node-entidad
  process: '#2EC5FF', // --node-proceso
  rule: '#5B8DFF', // --node-regla
  policy: '#9B8AFF', // --node-politica
  event: '#7FE0FF', // --node-decision
  system: '#29D3B8', // --node-sistema
  role: '#C9D6F2', // --node-rol
};

/** Conflicted elements render amber — the DS reserves amber for conflicts. */
export const CONFLICT_COLOR = '#FFB020';
/**
 * Opaque pre-blend of the DS hairline blue over --bg-page: translucent edges
 * stack additively in WebGL and parallel edges bloom white.
 */
export const EDGE_COLOR = '#2A3550';

export const SOURCE_TYPE_LABELS: Record<SourceType, string> = {
  code: 'code',
  document: 'doc',
  interview: 'interview',
};
