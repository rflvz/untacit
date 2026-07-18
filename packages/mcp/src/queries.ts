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
import { diffRefs, gitLastCommits } from '@untacit/core';

export interface ContextResult {
  nodes: (SearchResult & { seed: boolean })[];
  edges: EdgeRow[];
  truncated: boolean;
}

/**
 * Hybrid retrieval (docs/03 §6.1): seeds from RRF fusion of the lexical
 * channel (FTS5/bm25) and the semantic channel (embedding k-NN over the
 * derived index), then typed structural expansion (1 hop) trimmed to a
 * budget. Without a provider — or with an empty vector cache — seeding
 * degrades to lexical only. The vector cache is refreshed incrementally
 * before seeding, so post-pull staleness never serves stale vectors.
 */
export async function contextQuery(
  index: GraphIndex,
  query: string,
  opts: { nodeTypes?: NodeType[]; limit?: number; embeddings?: EmbeddingProvider | null } = {},
): Promise<ContextResult> {
  const limit = Math.min(opts.limit ?? 15, 50);
  const provider = opts.embeddings ?? null;
  if (provider !== null) await index.updateEmbeddings(provider);
  const seeds = await index.hybridSearch(query, provider, { types: opts.nodeTypes, limit });

  const nodes = new Map<string, SearchResult & { seed: boolean }>();
  const edges = new Map<string, EdgeRow>();
  for (const seed of seeds) {
    nodes.set(seed.id, { ...seed, seed: true });
  }

  // Structural expansion: bring in the immediate neighborhood of each seed,
  // highest-confidence edges first, until the budget is filled.
  const budget = limit * 3;
  let truncated = false;
  for (const seed of seeds) {
    const around = index
      .edgesOf(seed.id)
      .sort((a, b) => b.edge.confidence - a.edge.confidence);
    for (const { edge } of around) {
      if (edges.size >= budget || nodes.size >= budget) {
        truncated = true;
        break;
      }
      edges.set(edge.id, edge);
      for (const id of [edge.source, edge.targetId]) {
        if (!nodes.has(id)) {
          const node = index.getNode(id);
          if (node) {
            nodes.set(id, {
              id: node.id,
              type: node.type,
              name: node.name,
              summary: node.description.split('\n')[0] ?? '',
              score: 0,
              seed: false,
            });
          }
        }
      }
    }
  }

  return { nodes: [...nodes.values()], edges: [...edges.values()], truncated };
}

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
