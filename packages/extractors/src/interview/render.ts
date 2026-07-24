/**
 * Natural-language rendering of proposals — statements are validated by
 * non-technical people, so they must read as natural Spanish.
 */

import type { BatchNode, EdgeType, NodeType, Stance } from '@untacit/core';

/** Type label WITH its article — statements must read as natural Spanish. */
export const NODE_TYPE_LABELS: Record<NodeType, string> = {
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
