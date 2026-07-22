/**
 * Graph-retrieval algorithms (docs/03 §6.1) — pure functions over a compact
 * edge snapshot, shared by the MCP query layer and any future consumer.
 *
 * Everything here is deterministic and dependency-free: the graph at v1 scale
 * (thousands of nodes) fits comfortably in memory, so the algorithms operate
 * on an in-memory weighted adjacency built from the derived index rather than
 * pushing traversal logic into SQL.
 *
 *   - spreading activation: multi-hop expansion from scored seeds, decaying
 *     by depth and weighting each hop by edge confidence × edge-type weight;
 *   - personalized PageRank: stationary relevance under random walk with
 *     restart at the seeds — rewards well-connected nodes near many seeds,
 *     complementing activation's shortest-chain view;
 *   - k-best paths (Yen over Dijkstra): strongest evidence chains between two
 *     nodes, with cost = -ln(confidence × type weight) so path strength
 *     multiplies along the chain;
 *   - MMR: diversity-aware selection used to de-duplicate near-identical
 *     retrieval seeds before spending the expansion budget on them.
 */

import { createHash } from 'node:crypto';
import type { EdgeType } from '../types.js';

// ---------------------------------------------------------------------------
// Weighted adjacency
// ---------------------------------------------------------------------------

/** Minimal edge shape the algorithms need; EdgeRow from the index satisfies it. */
export interface TraversalEdge {
  id: string;
  source: string;
  targetId: string;
  type: EdgeType;
  confidence: number;
}

/**
 * Semantic strength of each edge type for traversal (docs/03 §6.1: "1–2
 * saltos ponderando por tipo de arista y confianza"). Structural/causal
 * types carry more relevance across hops than descriptive ones: if a rule
 * VALIDATES a process, the process is almost certainly relevant to a
 * question about the rule; IMPLEMENTED_IN mostly drags in systems.
 */
export const EDGE_TYPE_WEIGHTS: Record<EdgeType, number> = {
  DEPENDS_ON: 1.0,
  GOVERNS: 1.0,
  TRIGGERS: 1.0,
  VALIDATES: 0.9,
  CALCULATES: 0.9,
  EXECUTES: 0.85,
  OPERATES_ON: 0.75,
  PART_OF: 0.75,
  IMPLEMENTED_IN: 0.5,
};

/** Hop weight in (0, 1]: confidence × type weight, floored to stay traversable. */
export function edgeWeight(edge: TraversalEdge): number {
  const conf = Math.min(Math.max(edge.confidence, 0.01), 1);
  return conf * (EDGE_TYPE_WEIGHTS[edge.type] ?? 0.75);
}

interface AdjacentHop {
  edge: TraversalEdge;
  /** The node on the other end. */
  other: string;
  weight: number;
}

/** Undirected weighted adjacency (self-loops dropped, dangling targets kept). */
export function buildAdjacency(edges: Iterable<TraversalEdge>): Map<string, AdjacentHop[]> {
  const adj = new Map<string, AdjacentHop[]>();
  const push = (from: string, hop: AdjacentHop): void => {
    const list = adj.get(from);
    if (list === undefined) adj.set(from, [hop]);
    else list.push(hop);
  };
  for (const edge of edges) {
    if (edge.source === edge.targetId) continue;
    const weight = edgeWeight(edge);
    push(edge.source, { edge, other: edge.targetId, weight });
    push(edge.targetId, { edge, other: edge.source, weight });
  }
  return adj;
}

// ---------------------------------------------------------------------------
// Spreading activation
// ---------------------------------------------------------------------------

export interface ActivationOptions {
  /** Maximum hops from any seed (default 2 — docs/03 §6.1). */
  maxDepth?: number;
  /** Multiplicative decay per hop on top of edge weights (default 0.6). */
  decay?: number;
  /**
   * Hub damping: each hop's contribution is divided by
   * max(1, degree(from))^fanoutPenalty (default 0.3), so high-degree hubs
   * (e.g. the ERP system every rule is IMPLEMENTED_IN) don't flood the
   * expansion with their entire neighborhood.
   */
  fanoutPenalty?: number;
}

export interface ActivationResult {
  /** Accumulated activation per reached node (seeds included at their seed score). */
  scores: Map<string, number>;
  /** Fewest hops from the closest seed (0 for seeds). */
  distance: Map<string, number>;
  /** Edges traversed by any contributing hop. */
  edges: Map<string, TraversalEdge>;
}

/**
 * Propagate seed scores through the weighted adjacency. A node's activation
 * accumulates over every path of length ≤ maxDepth from every seed:
 *
 *   contribution(path) = seedScore × Π_hops (edgeWeight × decay / degree^p)
 *
 * Frontier expansion is breadth-first by hop count; activation arriving at a
 * node already reached on an earlier hop still accumulates (reinforcement),
 * but only the first arrival re-expands, keeping the pass O(E · depth).
 */
export function spreadingActivation(
  adjacency: Map<string, AdjacentHop[]>,
  seeds: Map<string, number>,
  opts: ActivationOptions = {},
): ActivationResult {
  const maxDepth = opts.maxDepth ?? 2;
  const decay = opts.decay ?? 0.6;
  const fanoutPenalty = opts.fanoutPenalty ?? 0.3;

  const scores = new Map<string, number>();
  const distance = new Map<string, number>();
  const edges = new Map<string, TraversalEdge>();

  let frontier = new Map<string, number>(); // node → activation mass to push
  for (const [id, score] of seeds) {
    scores.set(id, (scores.get(id) ?? 0) + score);
    distance.set(id, 0);
    frontier.set(id, (frontier.get(id) ?? 0) + score);
  }

  for (let depth = 1; depth <= maxDepth && frontier.size > 0; depth++) {
    const next = new Map<string, number>();
    for (const [from, mass] of frontier) {
      const hops = adjacency.get(from);
      if (hops === undefined || hops.length === 0) continue;
      const damping = Math.pow(Math.max(1, hops.length), fanoutPenalty);
      for (const hop of hops) {
        const contribution = (mass * hop.weight * decay) / damping;
        if (contribution <= 0) continue;
        edges.set(hop.edge.id, hop.edge);
        const known = distance.get(hop.other);
        scores.set(hop.other, (scores.get(hop.other) ?? 0) + contribution);
        if (known === undefined) {
          distance.set(hop.other, depth);
          next.set(hop.other, (next.get(hop.other) ?? 0) + contribution);
        }
      }
    }
    frontier = next;
  }

  return { scores, distance, edges };
}

// ---------------------------------------------------------------------------
// Personalized PageRank (random walk with restart)
// ---------------------------------------------------------------------------

export interface PageRankOptions {
  /** Restart probability α (default 0.15): higher keeps mass nearer the seeds. */
  restart?: number;
  /** Power-iteration cap (default 30). */
  iterations?: number;
  /** L1 convergence tolerance (default 1e-6). */
  tolerance?: number;
}

/**
 * Personalized PageRank over the weighted undirected graph, restarting at the
 * seeds (mass proportional to seed scores). Transition probability out of a
 * node is proportional to edge weight. Returns the stationary distribution
 * restricted to reached nodes; scores sum to ~1.
 */
export function personalizedPageRank(
  adjacency: Map<string, AdjacentHop[]>,
  seeds: Map<string, number>,
  opts: PageRankOptions = {},
): Map<string, number> {
  const restart = opts.restart ?? 0.15;
  const iterations = opts.iterations ?? 30;
  const tolerance = opts.tolerance ?? 1e-6;

  let seedTotal = 0;
  for (const score of seeds.values()) seedTotal += Math.max(score, 0);
  if (seedTotal <= 0) return new Map();
  const restartVec = new Map<string, number>();
  for (const [id, score] of seeds) {
    if (score > 0) restartVec.set(id, score / seedTotal);
  }

  let rank = new Map(restartVec);
  for (let it = 0; it < iterations; it++) {
    const next = new Map<string, number>();
    // Restart mass.
    for (const [id, p] of restartVec) next.set(id, restart * p);
    // Walk mass.
    for (const [id, p] of rank) {
      const hops = adjacency.get(id);
      if (hops === undefined || hops.length === 0) {
        // Dangling node: its walk mass restarts.
        for (const [sid, sp] of restartVec) {
          next.set(sid, (next.get(sid) ?? 0) + (1 - restart) * p * sp);
        }
        continue;
      }
      let total = 0;
      for (const hop of hops) total += hop.weight;
      for (const hop of hops) {
        const share = (1 - restart) * p * (hop.weight / total);
        if (share > 0) next.set(hop.other, (next.get(hop.other) ?? 0) + share);
      }
    }
    // L1 delta for convergence.
    let delta = 0;
    for (const [id, p] of next) delta += Math.abs(p - (rank.get(id) ?? 0));
    for (const [id, p] of rank) if (!next.has(id)) delta += p;
    rank = next;
    if (delta < tolerance) break;
  }
  return rank;
}

// ---------------------------------------------------------------------------
// k-best paths (Yen's algorithm over confidence-weighted Dijkstra)
// ---------------------------------------------------------------------------

export interface WeightedPath {
  /** Node ids from source to target, inclusive. */
  nodes: string[];
  /** Edges traversed, aligned with consecutive node pairs. */
  edges: TraversalEdge[];
  /** Π (confidence × type weight) over the hops — in (0, 1]. */
  strength: number;
}

export interface BestPathsOptions {
  /** How many paths (default 3). */
  k?: number;
  /** Maximum hops per path (default 6). */
  maxLength?: number;
}

interface DijkstraHit {
  nodes: string[];
  edges: TraversalEdge[];
  cost: number;
}

/** Additive hop cost; -ln makes path strength multiply along the chain. */
function hopCost(weight: number): number {
  return -Math.log(Math.min(Math.max(weight, 1e-6), 1));
}

function dijkstra(
  adjacency: Map<string, AdjacentHop[]>,
  from: string,
  to: string,
  maxLength: number,
  bannedEdges: ReadonlySet<string>,
  bannedNodes: ReadonlySet<string>,
): DijkstraHit | undefined {
  interface State {
    node: string;
    cost: number;
    hops: number;
  }
  // Binary heap keyed by cost — small enough to keep local.
  const heap: State[] = [{ node: from, cost: 0, hops: 0 }];
  const heapPush = (s: State): void => {
    heap.push(s);
    let i = heap.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (heap[parent]!.cost <= heap[i]!.cost) break;
      [heap[parent], heap[i]] = [heap[i]!, heap[parent]!];
      i = parent;
    }
  };
  const heapPop = (): State | undefined => {
    if (heap.length === 0) return undefined;
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let smallest = i;
        if (l < heap.length && heap[l]!.cost < heap[smallest]!.cost) smallest = l;
        if (r < heap.length && heap[r]!.cost < heap[smallest]!.cost) smallest = r;
        if (smallest === i) break;
        [heap[smallest], heap[i]] = [heap[i]!, heap[smallest]!];
        i = smallest;
      }
    }
    return top;
  };

  const dist = new Map<string, number>();
  const prev = new Map<string, { node: string; edge: TraversalEdge }>();
  dist.set(from, 0);

  for (let state = heapPop(); state !== undefined; state = heapPop()) {
    if (state.cost > (dist.get(state.node) ?? Infinity)) continue;
    if (state.node === to) break;
    if (state.hops >= maxLength) continue;
    for (const hop of adjacency.get(state.node) ?? []) {
      if (bannedEdges.has(hop.edge.id) || bannedNodes.has(hop.other)) continue;
      const cost = state.cost + hopCost(hop.weight);
      if (cost < (dist.get(hop.other) ?? Infinity)) {
        dist.set(hop.other, cost);
        prev.set(hop.other, { node: state.node, edge: hop.edge });
        heapPush({ node: hop.other, cost, hops: state.hops + 1 });
      }
    }
  }

  const cost = dist.get(to);
  if (cost === undefined) return undefined;
  const nodes: string[] = [to];
  const edges: TraversalEdge[] = [];
  let cur = to;
  while (cur !== from) {
    const step = prev.get(cur);
    if (step === undefined) return undefined; // unreachable (defensive)
    edges.unshift(step.edge);
    nodes.unshift(step.node);
    cur = step.node;
  }
  if (edges.length > maxLength) return undefined;
  return { nodes, edges, cost };
}

/**
 * Yen's k-shortest loopless paths between two nodes, ranked by evidence
 * strength (strongest first). Each successive path is found by banning, per
 * candidate spur, the edges that previous paths took out of the spur node
 * plus the root-path nodes, then splicing root + spur.
 */
export function kBestPaths(
  adjacency: Map<string, AdjacentHop[]>,
  from: string,
  to: string,
  opts: BestPathsOptions = {},
): WeightedPath[] {
  const k = Math.min(opts.k ?? 3, 10);
  const maxLength = Math.min(opts.maxLength ?? 6, 10);
  if (from === to) return [{ nodes: [from], edges: [], strength: 1 }];

  const accepted: DijkstraHit[] = [];
  const first = dijkstra(adjacency, from, to, maxLength, new Set(), new Set());
  if (first === undefined) return [];
  accepted.push(first);

  const candidates: DijkstraHit[] = [];
  const pathKey = (p: DijkstraHit): string => p.edges.map((e) => e.id).join('|');
  const seen = new Set<string>([pathKey(first)]);

  while (accepted.length < k) {
    const last = accepted[accepted.length - 1]!;
    for (let i = 0; i < last.nodes.length - 1; i++) {
      const spurNode = last.nodes[i]!;
      const rootNodes = last.nodes.slice(0, i + 1);
      const rootEdges = last.edges.slice(0, i);

      const bannedEdges = new Set<string>();
      for (const path of accepted) {
        if (
          path.nodes.length > i &&
          rootNodes.every((n, j) => path.nodes[j] === n) &&
          path.edges.length > i
        ) {
          bannedEdges.add(path.edges[i]!.id);
        }
      }
      const bannedNodes = new Set(rootNodes.slice(0, -1));

      const spur = dijkstra(adjacency, spurNode, to, maxLength - rootEdges.length, bannedEdges, bannedNodes);
      if (spur === undefined) continue;
      const total: DijkstraHit = {
        nodes: [...rootNodes.slice(0, -1), ...spur.nodes],
        edges: [...rootEdges, ...spur.edges],
        cost: rootEdges.reduce((sum, e) => sum + hopCost(edgeWeight(e)), 0) + spur.cost,
      };
      if (total.edges.length > maxLength) continue;
      const key = pathKey(total);
      if (seen.has(key)) continue;
      seen.add(key);
      candidates.push(total);
    }
    if (candidates.length === 0) break;
    candidates.sort((a, b) => a.cost - b.cost);
    accepted.push(candidates.shift()!);
  }

  return accepted.map((p) => ({
    nodes: p.nodes,
    edges: p.edges,
    strength: round4(Math.exp(-p.cost)),
  }));
}

// ---------------------------------------------------------------------------
// Spectral structural embeddings
// ---------------------------------------------------------------------------

export interface SpectralOptions {
  /** Embedding dimensions = leading eigenvectors extracted (default 16). */
  dims?: number;
  /** Power iterations per eigenvector (default 30). */
  iterations?: number;
}

/** Deterministic pseudo-random in [-0.5, 0.5) from a string key (no RNG state). */
function hashUnit(key: string): number {
  const digest = createHash('sha1').update(key).digest();
  return digest.readUInt32BE(0) / 0x100000000 - 0.5;
}

/**
 * Structural node embeddings: adjacency spectral embedding of the
 * symmetrically normalized weighted adjacency (D^-1/2 · A · D^-1/2),
 * computed with power iteration + Gram-Schmidt deflation. Each node gets a
 * vector whose d-th component is its coordinate on the d-th leading
 * eigenvector, scaled by sqrt(|eigenvalue|); cosine between two vectors
 * measures similarity of *graph position* — two rules validating the same
 * processes land close even with disjoint wording. Everything is
 * deterministic: initialization is hashed from node ids, so repeated runs
 * (and tests) get identical vectors.
 *
 * Cost is O(dims × iterations × E) — the deliberate "more compute, better
 * signal" trade of docs/03 §6.1; at v1 scale (~50k edges, 16 dims) this is
 * a few tens of milliseconds. Isolated nodes have no adjacency row and get
 * no vector.
 */
export function spectralEmbedding(
  adjacency: Map<string, AdjacentHop[]>,
  opts: SpectralOptions = {},
): Map<string, number[]> {
  const ids = [...adjacency.keys()].sort();
  const n = ids.length;
  if (n === 0) return new Map();
  const dims = Math.min(opts.dims ?? 16, n);
  const iterations = opts.iterations ?? 30;
  const indexOf = new Map(ids.map((id, i) => [id, i]));

  // Normalized adjacency rows: neighbors as (index, weight / sqrt(d_i · d_j)).
  const degree = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    for (const hop of adjacency.get(ids[i]!) ?? []) degree[i] += hop.weight;
  }
  const rows: { j: number; w: number }[][] = ids.map((id, i) => {
    const out: { j: number; w: number }[] = [];
    for (const hop of adjacency.get(id) ?? []) {
      const j = indexOf.get(hop.other);
      if (j === undefined) continue; // dangling target with no own adjacency row
      const denom = Math.sqrt(Math.max(degree[i]!, 1e-12) * Math.max(degree[j]!, 1e-12));
      out.push({ j, w: hop.weight / denom });
    }
    return out;
  });

  const multiply = (v: Float64Array): Float64Array => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      for (const { j, w } of rows[i]!) out[i] += w * v[j]!;
    }
    return out;
  };
  const dot = (a: Float64Array, b: Float64Array): number => {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += a[i]! * b[i]!;
    return sum;
  };
  const normalize = (v: Float64Array): number => {
    const norm = Math.sqrt(dot(v, v));
    if (norm > 1e-12) for (let i = 0; i < n; i++) v[i]! /= norm;
    return norm;
  };
  const deflate = (v: Float64Array, basis: Float64Array[]): void => {
    for (const u of basis) {
      const proj = dot(v, u);
      for (let i = 0; i < n; i++) v[i]! -= proj * u[i]!;
    }
  };

  const eigenvectors: Float64Array[] = [];
  const eigenvalues: number[] = [];
  for (let d = 0; d < dims; d++) {
    let v: Float64Array = new Float64Array(n);
    for (let i = 0; i < n; i++) v[i] = hashUnit(`${ids[i]}|${d}`);
    deflate(v, eigenvectors);
    if (normalize(v) <= 1e-12) break;
    for (let it = 0; it < iterations; it++) {
      const next = multiply(v);
      deflate(next, eigenvectors);
      if (normalize(next) <= 1e-12) break; // spectrum exhausted
      v = next;
    }
    const lambda = dot(v, multiply(v));
    eigenvectors.push(v);
    eigenvalues.push(lambda);
  }

  const result = new Map<string, number[]>();
  for (let i = 0; i < n; i++) {
    const vec = eigenvectors.map((v, d) => v[i]! * Math.sqrt(Math.abs(eigenvalues[d]!)));
    result.set(ids[i]!, vec);
  }
  return result;
}

// ---------------------------------------------------------------------------
// Maximal Marginal Relevance
// ---------------------------------------------------------------------------

/**
 * Greedy MMR selection: repeatedly pick the item maximizing
 * λ·relevance − (1−λ)·max-similarity-to-selected. Returns the selected items
 * in pick order. Deterministic: ties resolve to the earlier item.
 */
export function mmrSelect<T>(
  items: readonly T[],
  k: number,
  lambda: number,
  relevance: (item: T) => number,
  similarity: (a: T, b: T) => number,
): T[] {
  if (items.length === 0 || k <= 0) return [];
  const remaining = [...items];
  const selected: T[] = [];
  while (selected.length < k && remaining.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const item = remaining[i]!;
      let redundancy = 0;
      for (const chosen of selected) {
        redundancy = Math.max(redundancy, similarity(item, chosen));
      }
      const score = lambda * relevance(item) - (1 - lambda) * redundancy;
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    selected.push(remaining.splice(bestIdx, 1)[0]!);
  }
  return selected;
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
