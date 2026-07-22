import { describe, expect, it } from 'vitest';

import {
  buildAdjacency,
  edgeWeight,
  kBestPaths,
  mmrSelect,
  personalizedPageRank,
  spectralEmbedding,
  spreadingActivation,
} from './index.js';
import type { TraversalEdge } from './index.js';

function edge(
  source: string,
  type: TraversalEdge['type'],
  targetId: string,
  confidence = 0.9,
): TraversalEdge {
  return { id: `${type}:${source}->${targetId}`, source, targetId, type, confidence };
}

/**
 * Toy business graph:
 *
 *   rule-a  VALIDATES  process-p    (0.9)
 *   rule-b  VALIDATES  process-p    (0.5)
 *   process-p TRIGGERS event-e      (0.9)
 *   event-e TRIGGERS   process-q    (0.9)
 *   rule-a  IMPLEMENTED_IN sys      (0.9)
 *   rule-b  IMPLEMENTED_IN sys      (0.9)
 *   process-q IMPLEMENTED_IN sys    (0.9)
 */
const EDGES: TraversalEdge[] = [
  edge('rule-a', 'VALIDATES', 'process-p'),
  edge('rule-b', 'VALIDATES', 'process-p', 0.5),
  edge('process-p', 'TRIGGERS', 'event-e'),
  edge('event-e', 'TRIGGERS', 'process-q'),
  edge('rule-a', 'IMPLEMENTED_IN', 'sys'),
  edge('rule-b', 'IMPLEMENTED_IN', 'sys'),
  edge('process-q', 'IMPLEMENTED_IN', 'sys'),
];

describe('edgeWeight', () => {
  it('weights structural types above descriptive ones and scales by confidence', () => {
    expect(edgeWeight(edge('a', 'TRIGGERS', 'b', 1))).toBeGreaterThan(
      edgeWeight(edge('a', 'IMPLEMENTED_IN', 'b', 1)),
    );
    expect(edgeWeight(edge('a', 'TRIGGERS', 'b', 0.5))).toBeCloseTo(
      edgeWeight(edge('a', 'TRIGGERS', 'b', 1)) / 2,
    );
  });
});

describe('spreadingActivation', () => {
  const adj = buildAdjacency(EDGES);

  it('reaches multi-hop neighbors with decaying scores and hop distances', () => {
    const result = spreadingActivation(adj, new Map([['rule-a', 1]]), { maxDepth: 3 });
    expect(result.distance.get('rule-a')).toBe(0);
    expect(result.distance.get('process-p')).toBe(1);
    expect(result.distance.get('event-e')).toBe(2);
    // process-q is 2 hops away through the sys hub (rule-a → sys → process-q).
    expect(result.distance.get('process-q')).toBe(2);
    const p = result.scores.get('process-p')!;
    const e = result.scores.get('event-e')!;
    const q = result.scores.get('process-q')!;
    expect(p).toBeGreaterThan(e);
    // The strong structural chain (VALIDATES → TRIGGERS) carries more
    // activation than the weak IMPLEMENTED_IN hub route.
    expect(e).toBeGreaterThan(q);
  });

  it('propagates more activation through high-confidence structural edges', () => {
    const result = spreadingActivation(adj, new Map([['process-p', 1]]), { maxDepth: 1 });
    // VALIDATES at 0.9 (rule-a) beats VALIDATES at 0.5 (rule-b).
    expect(result.scores.get('rule-a')!).toBeGreaterThan(result.scores.get('rule-b')!);
  });

  it('stays within maxDepth', () => {
    const result = spreadingActivation(adj, new Map([['rule-a', 1]]), { maxDepth: 1 });
    expect(result.scores.has('event-e')).toBe(false);
  });

  it('accumulates activation arriving from several seeds', () => {
    const one = spreadingActivation(adj, new Map([['rule-a', 1]]), { maxDepth: 1 });
    const two = spreadingActivation(
      adj,
      new Map([
        ['rule-a', 1],
        ['rule-b', 1],
      ]),
      { maxDepth: 1 },
    );
    expect(two.scores.get('process-p')!).toBeGreaterThan(one.scores.get('process-p')!);
  });
});

describe('personalizedPageRank', () => {
  const adj = buildAdjacency(EDGES);

  it('concentrates mass at and around the seeds and sums to ~1', () => {
    const rank = personalizedPageRank(adj, new Map([['rule-a', 1]]));
    let total = 0;
    for (const p of rank.values()) total += p;
    expect(total).toBeCloseTo(1, 3);
    expect(rank.get('rule-a')!).toBeGreaterThan(rank.get('process-q') ?? 0);
    expect(rank.get('process-p')!).toBeGreaterThan(rank.get('process-q') ?? 0);
  });

  it('returns empty for empty or zero-score seeds', () => {
    expect(personalizedPageRank(adj, new Map()).size).toBe(0);
    expect(personalizedPageRank(adj, new Map([['rule-a', 0]])).size).toBe(0);
  });
});

describe('kBestPaths', () => {
  const adj = buildAdjacency(EDGES);

  it('finds the strongest path first and reports multiplicative strength', () => {
    const paths = kBestPaths(adj, 'rule-a', 'process-q', { k: 3 });
    expect(paths.length).toBeGreaterThanOrEqual(2);
    // Strongest chain: rule-a → process-p → event-e → process-q (all 0.9,
    // structural types) beats the 2-hop chain through the low-weight
    // IMPLEMENTED_IN edges (rule-a → sys → process-q).
    expect(paths[0]!.nodes).toEqual(['rule-a', 'process-p', 'event-e', 'process-q']);
    expect(paths[1]!.nodes).toEqual(['rule-a', 'sys', 'process-q']);
    expect(paths[0]!.strength).toBeGreaterThan(paths[1]!.strength);
    for (const path of paths) {
      expect(path.edges.length).toBe(path.nodes.length - 1);
      expect(path.strength).toBeGreaterThan(0);
      expect(path.strength).toBeLessThanOrEqual(1);
    }
  });

  it('returns loopless, distinct paths', () => {
    const paths = kBestPaths(adj, 'rule-a', 'process-q', { k: 5 });
    const keys = paths.map((p) => p.edges.map((e) => e.id).join('|'));
    expect(new Set(keys).size).toBe(keys.length);
    for (const path of paths) {
      expect(new Set(path.nodes).size).toBe(path.nodes.length);
    }
  });

  it('handles unreachable targets and identity', () => {
    expect(kBestPaths(adj, 'rule-a', 'nowhere')).toEqual([]);
    expect(kBestPaths(adj, 'rule-a', 'rule-a')).toEqual([
      { nodes: ['rule-a'], edges: [], strength: 1 },
    ]);
  });

  it('respects maxLength', () => {
    const paths = kBestPaths(adj, 'rule-a', 'process-q', { k: 5, maxLength: 2 });
    for (const path of paths) expect(path.edges.length).toBeLessThanOrEqual(2);
    expect(paths[0]!.nodes).toEqual(['rule-a', 'sys', 'process-q']);
  });
});

describe('mmrSelect', () => {
  it('trades relevance against redundancy', () => {
    const items = [
      { id: 'a', rel: 1.0, group: 1 },
      { id: 'b', rel: 0.95, group: 1 }, // near-duplicate of a
      { id: 'c', rel: 0.6, group: 2 },
    ];
    const picked = mmrSelect(
      items,
      2,
      0.5,
      (i) => i.rel,
      (x, y) => (x.group === y.group ? 1 : 0),
    );
    expect(picked.map((i) => i.id)).toEqual(['a', 'c']);
  });

  it('degenerates to pure relevance ranking at lambda = 1', () => {
    const items = [
      { id: 'a', rel: 0.2 },
      { id: 'b', rel: 0.9 },
      { id: 'c', rel: 0.5 },
    ];
    const picked = mmrSelect(items, 3, 1, (i) => i.rel, () => 1);
    expect(picked.map((i) => i.id)).toEqual(['b', 'c', 'a']);
  });
});

describe('spectralEmbedding', () => {
  const adj = buildAdjacency(EDGES);

  function cosine(a: number[], b: number[]): number {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      na += a[i]! * a[i]!;
      nb += b[i]! * b[i]!;
    }
    return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
  }

  it('is deterministic across runs', () => {
    const one = spectralEmbedding(adj, { dims: 4 });
    const two = spectralEmbedding(adj, { dims: 4 });
    expect([...one.keys()]).toEqual([...two.keys()]);
    for (const [id, vec] of one) expect(two.get(id)).toEqual(vec);
  });

  it('places structurally equivalent nodes closer than unrelated ones', () => {
    const spectral = spectralEmbedding(adj, { dims: 4 });
    // rule-a and rule-b share BOTH neighbors (process-p via VALIDATES, sys
    // via IMPLEMENTED_IN): same graph position, high cosine. event-e sits in
    // a different part of the chain.
    const twins = cosine(spectral.get('rule-a')!, spectral.get('rule-b')!);
    const distant = cosine(spectral.get('rule-a')!, spectral.get('event-e')!);
    expect(twins).toBeGreaterThan(distant);
    expect(twins).toBeGreaterThan(0.5);
  });

  it('only embeds nodes present in the adjacency and caps dims at node count', () => {
    const spectral = spectralEmbedding(adj, { dims: 64 });
    expect(spectral.has('unrelated-node')).toBe(false);
    for (const vec of spectral.values()) {
      expect(vec.length).toBeLessThanOrEqual(adj.size);
    }
  });

  it('returns empty for an empty graph', () => {
    expect(spectralEmbedding(new Map()).size).toBe(0);
  });
});
