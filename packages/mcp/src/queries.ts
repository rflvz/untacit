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
  nameSimilarity,
  spectralEmbedding,
} from '@untacit/core';

// ---------------------------------------------------------------------------
// untacit_context — multi-stage hybrid retrieval
// ---------------------------------------------------------------------------

// The pipeline lives in @untacit/core (retrieval/context.ts) so the desktop
// sidecar and the MCP layer share one implementation; re-exported here to
// keep the historical @untacit/mcp surface stable.
export {
  contextQuery,
  planRetrieval,
  DEFAULT_CHANNEL_WEIGHTS,
  SEED_CHANNELS,
} from '@untacit/core';
export type {
  ContextNode,
  ContextOptions,
  ContextResult,
  PlannedChannel,
  RetrievalChannel,
  RetrievalPlan,
  SeedChannel,
  SkippedChannel,
} from '@untacit/core';

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
  /**
   * Structural similarity: weighted neighborhood Jaccard blended with the
   * cosine of the two nodes' spectral graph embeddings (local overlap +
   * global graph position).
   */
  structural: number;
  /** Name similarity (Levenshtein/token Jaccard max, resolver formula). */
  lexical: number;
}

export interface SimilarResult {
  node: SearchResult;
  similar: SimilarNode[];
}

const SIMILAR_WEIGHTS = { semantic: 0.45, structural: 0.35, lexical: 0.2 };
/** Inside the structural signal: local neighborhood overlap vs global position. */
const STRUCTURAL_JACCARD_SHARE = 0.6;

/**
 * Nodes similar to a given node, blending three orthogonal signals:
 * embedding cosine (what it *means*), structural similarity (how it
 * *connects* — weighted neighborhood Jaccard for local overlap, blended with
 * spectral-embedding cosine so nodes occupying the same *global* graph
 * position score even without directly shared neighbors), and resolver name
 * similarity (what it is *called*). Without embeddings the semantic weight
 * is redistributed onto the other two. This is also the "possible
 * duplicate" lens: a high blend on two same-type nodes is exactly what a
 * merge candidate looks like.
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

  // One adjacency build feeds both structural signals: the neighborhood
  // weight maps (local overlap) and the spectral embedding (global position).
  const adjacency = buildAdjacency(index.allEdges());
  const spectral = spectralEmbedding(adjacency);
  const originSpectral = spectral.get(nodeId);
  const neighborWeights = new Map<string, Map<string, number>>();
  for (const [id, hops] of adjacency) {
    const map = new Map<string, number>();
    for (const hop of hops) map.set(hop.other, Math.max(map.get(hop.other) ?? 0, hop.weight));
    neighborWeights.set(id, map);
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
    const overlap = weightedJaccard(
      neighborWeights.get(candidate.id) ?? new Map<string, number>(),
    );
    const candidateSpectral = spectral.get(candidate.id);
    const position =
      originSpectral !== undefined &&
      candidateSpectral !== undefined &&
      candidateSpectral.length === originSpectral.length
        ? Math.max(0, cosineSimilarity(originSpectral, candidateSpectral))
        : 0;
    const structural =
      STRUCTURAL_JACCARD_SHARE * overlap + (1 - STRUCTURAL_JACCARD_SHARE) * position;
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
