/**
 * Gap analysis over the derived index (docs/03 §4.3.1 and §4.3.5): zones of
 * the graph worth interviewing about, plus low-confidence edges rendered as
 * claims the interviewee can confirm or refute.
 */

import type { EdgeType, GraphIndex, NodeType } from '@untacit/core';

import { NODE_TYPE_LABELS, renderEdgeStatement } from './render.js';

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
