/**
 * Pure query layer behind the MCP tools — testable without a transport.
 * Every function reads from the derived index (never from source files) and
 * returns concise, budget-trimmed structures (docs/03 §6).
 */

import type {
  Conflict,
  EdgeRow,
  EdgeType,
  EmbeddingProvider,
  Evidence,
  GraphDiff,
  GraphIndex,
  NodeType,
  SearchResult,
} from '@untacit/core';
import {
  buildAdjacency,
  cosineSimilarity,
  diffRefs,
  edgeWeight,
  gitLastCommits,
  kBestPaths,
  mmrSelect,
  nameSimilarity,
  personalizedPageRank,
  spreadingActivation,
} from '@untacit/core';

// ---------------------------------------------------------------------------
// untacit_context — multi-stage hybrid retrieval
// ---------------------------------------------------------------------------

/** Which retrieval stage(s) surfaced a node. */
export type RetrievalChannel = 'lexical' | 'semantic' | 'graph';

export interface ContextNode extends SearchResult {
  seed: boolean;
  /** Hops from the closest seed (0 for seeds themselves). */
  distance: number;
  channels: RetrievalChannel[];
}

export interface ContextResult {
  nodes: ContextNode[];
  edges: EdgeRow[];
  truncated: boolean;
}

export interface ContextOptions {
  nodeTypes?: NodeType[];
  limit?: number;
  /** Structural expansion hops from the seeds (default 2, docs/03 §6.1). */
  depth?: number;
  embeddings?: EmbeddingProvider | null;
}

/** RRF constant (standard 60): flattens the head so channels vote, not dominate. */
const RRF_K = 60;
/** MMR relevance/diversity trade-off for seed selection. */
const MMR_LAMBDA = 0.7;
/** Blend of the two graph signals for expansion ranking. */
const ACTIVATION_BLEND = 0.65;

/** Token set of a normalized name — the embedding-free seed-similarity fallback. */
function nameTokens(text: string): Set<string> {
  return new Set(
    text
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 0),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Hybrid multi-stage retrieval (docs/03 §6.1):
 *
 *   1. Seeding — RRF fusion of the lexical channel (FTS5/bm25) and the
 *      semantic channel (embedding k-NN), each contributing a pool deeper
 *      than the final cut. Without a provider (or an empty vector cache)
 *      seeding degrades to lexical only. The vector cache is refreshed
 *      incrementally before seeding, so post-pull staleness never serves
 *      stale vectors.
 *   2. Diversification — MMR over the fused pool, so near-duplicate seeds
 *      (same concept found under two names) don't burn the budget that
 *      distinct sub-topics of the question deserve.
 *   3. Expansion — spreading activation from the seeds over the whole graph:
 *      multi-hop (default 2), each hop weighted by edge confidence × edge-type
 *      weight, decayed by depth and hub-damped, blended with personalized
 *      PageRank (random walk with restart at the seeds) so both "strong short
 *      chain" and "well-connected near many seeds" count.
 *   4. Budget trim — expansion nodes ranked by blended graph score, cut to
 *      3× limit; edges reported are the induced subgraph over the kept nodes.
 */
export async function contextQuery(
  index: GraphIndex,
  query: string,
  opts: ContextOptions = {},
): Promise<ContextResult> {
  const limit = Math.min(opts.limit ?? 15, 50);
  const depth = Math.min(Math.max(opts.depth ?? 2, 1), 3);
  const provider = opts.embeddings ?? null;
  if (provider !== null) await index.updateEmbeddings(provider);

  // --- Stage 1: dual-channel seeding, RRF-fused, channel provenance kept.
  const pool = Math.max(limit * 3, 30);
  const lexical = index.search(query, { types: opts.nodeTypes, limit: pool });
  const semantic =
    provider !== null
      ? await index.semanticSearch(query, provider, { types: opts.nodeTypes, limit: pool })
      : [];

  interface FusedSeed extends SearchResult {
    fused: number;
    channels: RetrievalChannel[];
  }
  const fused = new Map<string, FusedSeed>();
  const channelRuns: [RetrievalChannel, SearchResult[]][] = [
    ['lexical', lexical],
    ['semantic', semantic],
  ];
  for (const [channel, run] of channelRuns) {
    run.forEach((result, rank) => {
      const contribution = 1 / (RRF_K + rank + 1);
      const entry = fused.get(result.id);
      if (entry === undefined) {
        fused.set(result.id, { ...result, fused: contribution, channels: [channel] });
      } else {
        entry.fused += contribution;
        entry.channels.push(channel);
      }
    });
  }
  const fusedPool = [...fused.values()].sort(
    (a, b) => b.fused - a.fused || a.id.localeCompare(b.id),
  );
  if (fusedPool.length === 0) return { nodes: [], edges: [], truncated: false };

  // --- Stage 2: MMR diversification of the seed set. Similarity between two
  // candidates is embedding cosine when both vectors exist, else token
  // Jaccard over names. Relevance is the fused score normalized to [0, 1].
  const vectors = provider !== null ? index.nodeVectors(provider.name) : new Map<string, number[]>();
  const tokens = new Map(fusedPool.map((s) => [s.id, nameTokens(s.name)]));
  const maxFused = fusedPool[0]!.fused;
  const seedSimilarity = (a: FusedSeed, b: FusedSeed): number => {
    const va = vectors.get(a.id);
    const vb = vectors.get(b.id);
    if (va !== undefined && vb !== undefined && va.length === vb.length) {
      return cosineSimilarity(va, vb);
    }
    return jaccard(tokens.get(a.id)!, tokens.get(b.id)!);
  };
  const seeds = mmrSelect(
    fusedPool,
    limit,
    MMR_LAMBDA,
    (s) => s.fused / maxFused,
    seedSimilarity,
  );

  // --- Stage 3: graph expansion — spreading activation blended with PPR.
  const adjacency = buildAdjacency(index.allEdges());
  const seedScores = new Map(seeds.map((s) => [s.id, s.fused / maxFused]));
  const activation = spreadingActivation(adjacency, seedScores, { maxDepth: depth });
  const ppr = personalizedPageRank(adjacency, seedScores);

  const seedIds = new Set(seedScores.keys());
  let maxActivation = 0;
  let maxPpr = 0;
  for (const [id, score] of activation.scores) {
    if (!seedIds.has(id) && score > maxActivation) maxActivation = score;
  }
  for (const [id, score] of ppr) {
    if (!seedIds.has(id) && score > maxPpr) maxPpr = score;
  }
  const graphScore = (id: string): number => {
    const act = maxActivation > 0 ? (activation.scores.get(id) ?? 0) / maxActivation : 0;
    const walk = maxPpr > 0 ? (ppr.get(id) ?? 0) / maxPpr : 0;
    return ACTIVATION_BLEND * act + (1 - ACTIVATION_BLEND) * walk;
  };

  // --- Stage 4: budget trim + induced subgraph.
  const budget = limit * 3;
  const nodes = new Map<string, ContextNode>();
  for (const seed of seeds) {
    nodes.set(seed.id, {
      id: seed.id,
      type: seed.type,
      name: seed.name,
      summary: seed.summary,
      score: round4(seed.fused),
      seed: true,
      distance: 0,
      channels: seed.channels,
    });
  }

  const expansion = [...activation.scores.keys()]
    .filter((id) => !nodes.has(id))
    .map((id) => ({ id, score: graphScore(id) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

  let truncated = false;
  for (const candidate of expansion) {
    if (nodes.size >= budget) {
      truncated = true;
      break;
    }
    const summary = index.nodeSummary(candidate.id);
    if (summary === undefined) continue; // dangling edge target
    nodes.set(candidate.id, {
      ...summary,
      score: round4(candidate.score),
      seed: false,
      distance: activation.distance.get(candidate.id) ?? depth,
      channels: ['graph'],
    });
  }

  // Edges of the induced subgraph over the kept nodes, strongest first.
  const edges: EdgeRow[] = [];
  const traversed = [...activation.edges.values()] as EdgeRow[];
  traversed.sort(
    (a, b) => edgeWeight(b) - edgeWeight(a) || a.id.localeCompare(b.id),
  );
  for (const edge of traversed) {
    if (edges.length >= budget) {
      truncated = true;
      break;
    }
    if (nodes.has(edge.source) && nodes.has(edge.targetId)) edges.push(edge);
  }

  return { nodes: [...nodes.values()], edges, truncated };
}

// ---------------------------------------------------------------------------
// untacit_explore
// ---------------------------------------------------------------------------

export interface ExploreResult {
  node: {
    id: string;
    type: NodeType;
    name: string;
    description: string;
    aliases: string[];
    status: string;
    attrs: Record<string, unknown>;
  };
  neighborhood: {
    nodes: (SearchResult & { distance: number })[];
    edges: EdgeRow[];
  };
}

export function exploreQuery(
  index: GraphIndex,
  nodeId: string,
  opts: { depth?: number; edgeTypes?: EdgeType[] } = {},
): ExploreResult | undefined {
  const node = index.getNode(nodeId);
  if (!node) return undefined;
  const neighborhood = index.neighbors(nodeId, {
    depth: Math.min(opts.depth ?? 1, 3),
    edgeTypes: opts.edgeTypes,
  });
  return {
    node: {
      id: node.id,
      type: node.type,
      name: node.name,
      description: node.description,
      aliases: node.aliases,
      status: node.status,
      attrs: node.attrs,
    },
    neighborhood,
  };
}

// ---------------------------------------------------------------------------
// untacit_paths — strongest evidence chains between two nodes
// ---------------------------------------------------------------------------

export interface PathsResult {
  from: SearchResult;
  to: SearchResult;
  paths: {
    /** Node chain from `from` to `to`, materialized with one-line summaries. */
    nodes: SearchResult[];
    /** Edges traversed, aligned with consecutive node pairs. */
    edges: EdgeRow[];
    /** Multiplicative chain strength in (0, 1] — confidence × type weight per hop. */
    strength: number;
  }[];
}

/**
 * "How are these two concepts connected?" — Yen's k-best loopless paths over
 * the confidence-weighted graph (hop cost = -ln(confidence × type weight)),
 * so the strongest evidence chain comes first, and weaker/longer alternative
 * explanations follow. Undefined when either endpoint is unknown.
 */
export function pathsQuery(
  index: GraphIndex,
  fromId: string,
  toId: string,
  opts: { maxPaths?: number; maxLength?: number } = {},
): PathsResult | undefined {
  const from = index.nodeSummary(fromId);
  const to = index.nodeSummary(toId);
  if (from === undefined || to === undefined) return undefined;

  const adjacency = buildAdjacency(index.allEdges());
  const found = kBestPaths(adjacency, fromId, toId, {
    k: opts.maxPaths ?? 3,
    maxLength: opts.maxLength ?? 6,
  });

  const paths: PathsResult['paths'] = [];
  for (const path of found) {
    const nodes: SearchResult[] = [];
    let complete = true;
    for (const id of path.nodes) {
      const summary = index.nodeSummary(id);
      if (summary === undefined) {
        complete = false; // path through a dangling target — not presentable
        break;
      }
      nodes.push(summary);
    }
    if (!complete) continue;
    paths.push({ nodes, edges: path.edges as EdgeRow[], strength: path.strength });
  }
  return { from, to, paths };
}

// ---------------------------------------------------------------------------
// untacit_similar — hybrid semantic + structural + lexical similarity
// ---------------------------------------------------------------------------

export interface SimilarNode extends SearchResult {
  /** Blended similarity in [0, 1]. */
  score: number;
  /** Embedding cosine (absent without a provider or cached vectors). */
  semantic?: number;
  /** Weighted Jaccard over the two nodes' neighborhoods. */
  structural: number;
  /** Name similarity (Levenshtein/token Jaccard max, resolver formula). */
  lexical: number;
}

export interface SimilarResult {
  node: SearchResult;
  similar: SimilarNode[];
}

const SIMILAR_WEIGHTS = { semantic: 0.45, structural: 0.35, lexical: 0.2 };

/**
 * Nodes similar to a given node, blending three orthogonal signals:
 * embedding cosine (what it *means*), weighted neighborhood Jaccard (how it
 * *connects* — two rules validating the same processes are alike even with
 * disjoint wording), and resolver name similarity (what it is *called*).
 * Without embeddings the semantic weight is redistributed onto the other two.
 * This is also the "possible duplicate" lens: a high blend on two same-type
 * nodes is exactly what a merge candidate looks like.
 */
export async function similarQuery(
  index: GraphIndex,
  nodeId: string,
  opts: { limit?: number; nodeTypes?: NodeType[]; embeddings?: EmbeddingProvider | null } = {},
): Promise<SimilarResult | undefined> {
  const origin = index.getNode(nodeId);
  if (origin === undefined) return undefined;
  const limit = Math.min(opts.limit ?? 10, 30);

  const provider = opts.embeddings ?? null;
  let vectors = new Map<string, number[]>();
  if (provider !== null) {
    await index.updateEmbeddings(provider);
    vectors = index.nodeVectors(provider.name);
  }
  const originVec = vectors.get(nodeId);

  // Neighborhood weight maps (other node → strongest connecting edge weight),
  // built once from the full edge snapshot.
  const neighborWeights = new Map<string, Map<string, number>>();
  const noteNeighbor = (a: string, b: string, w: number): void => {
    let map = neighborWeights.get(a);
    if (map === undefined) {
      map = new Map();
      neighborWeights.set(a, map);
    }
    map.set(b, Math.max(map.get(b) ?? 0, w));
  };
  for (const edge of index.allEdges()) {
    if (edge.source === edge.targetId) continue;
    const w = edgeWeight(edge);
    noteNeighbor(edge.source, edge.targetId, w);
    noteNeighbor(edge.targetId, edge.source, w);
  }
  const originNeighbors = neighborWeights.get(nodeId) ?? new Map<string, number>();

  const weightedJaccard = (other: Map<string, number>): number => {
    if (originNeighbors.size === 0 || other.size === 0) return 0;
    let intersection = 0;
    let union = 0;
    for (const [id, w] of originNeighbors) {
      const ow = other.get(id);
      if (ow !== undefined) {
        intersection += Math.min(w, ow);
        union += Math.max(w, ow);
      } else {
        union += w;
      }
    }
    for (const [id, w] of other) {
      if (!originNeighbors.has(id)) union += w;
    }
    return union === 0 ? 0 : intersection / union;
  };

  const originNames = [origin.name, ...origin.aliases];
  const scored: SimilarNode[] = [];
  for (const candidate of index.listNodes({ types: opts.nodeTypes })) {
    if (candidate.id === nodeId) continue;

    let lexical = 0;
    for (const ours of originNames) {
      lexical = Math.max(lexical, nameSimilarity(ours, candidate.name));
    }
    const structural = weightedJaccard(
      neighborWeights.get(candidate.id) ?? new Map<string, number>(),
    );
    const candidateVec = vectors.get(candidate.id);
    const semantic =
      originVec !== undefined &&
      candidateVec !== undefined &&
      candidateVec.length === originVec.length
        ? Math.max(0, cosineSimilarity(originVec, candidateVec))
        : undefined;

    // Redistribute the semantic weight when the signal is unavailable.
    const structuralW = SIMILAR_WEIGHTS.structural;
    const lexicalW = SIMILAR_WEIGHTS.lexical;
    const score =
      semantic !== undefined
        ? SIMILAR_WEIGHTS.semantic * semantic + structuralW * structural + lexicalW * lexical
        : (structuralW * structural + lexicalW * lexical) / (structuralW + lexicalW);
    if (score <= 0) continue;

    const entry: SimilarNode = {
      ...candidate,
      score: round4(score),
      structural: round4(structural),
      lexical: round4(lexical),
    };
    if (semantic !== undefined) entry.semantic = round4(semantic);
    scored.push(entry);
  }

  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return {
    node: {
      id: origin.id,
      type: origin.type,
      name: origin.name,
      summary: origin.description.split('\n')[0] ?? '',
      score: 0,
    },
    similar: scored.slice(0, limit),
  };
}

// ---------------------------------------------------------------------------
// untacit_evidence / untacit_conflicts / untacit_diff
// ---------------------------------------------------------------------------

export interface EvidenceResult {
  owner: string;
  items: { kind: 'node' | 'edge'; owner: string; evidence: Evidence }[];
}

export function evidenceQuery(index: GraphIndex, ownerId: string): EvidenceResult {
  const rows = index.evidenceOf(ownerId);
  return {
    owner: ownerId,
    items: rows.map((r) => ({ kind: r.kind, owner: r.owner, evidence: r.evidence })),
  };
}

export function conflictsQuery(index: GraphIndex): Conflict[] {
  return index.conflicts();
}

/** Default refs: the graph state produced by the two most recent commits (runs). */
export function diffQuery(repoRoot: string, refA?: string, refB?: string): GraphDiff {
  if (!refA || !refB) {
    const commits = gitLastCommits(repoRoot, 2);
    if (commits.length < 2) {
      return { ref_a: refA ?? 'HEAD', ref_b: refB ?? 'HEAD', nodes: [], edges: [] };
    }
    refA = refA ?? commits[1]!.hash;
    refB = refB ?? commits[0]!.hash;
  }
  return diffRefs(repoRoot, refA, refB);
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
