/**
 * Multi-stage hybrid retrieval (docs/03 §6.1) — the pipeline behind
 * untacit_context, shared by the MCP query layer and the desktop app.
 *
 *   1. Planning — resolve which seed channels run and at what RRF weight.
 *      In 'manual' mode the untacit.config.json switches decide; in 'auto'
 *      mode the engine reads the query's shape (id lookup, short keywords,
 *      natural-language question, non-Latin script) and provider availability
 *      and picks per query. The plan is returned with the result so callers
 *      (and the settings UI) can show *why* each channel ran.
 *   2. Seeding — weighted RRF fusion of the planned channels: lexical (BM25F,
 *      fielded weights), lexical-prf (RM3 pseudo-relevance query expansion,
 *      recall-oriented), semantic (mean-pooled embedding k-NN) and
 *      semantic-multivec (ColBERT-style late-interaction MaxSim over
 *      per-facet vectors). Without a provider the semantic channels drop out.
 *   3. Diversification — MMR over the fused pool, so near-duplicate seeds
 *      don't burn the budget distinct sub-topics deserve.
 *   4. Expansion — spreading activation from the seeds blended with
 *      personalized PageRank, weighted by edge confidence × type weight.
 *   5. Budget trim — expansion nodes cut to 3× limit; edges reported are the
 *      induced subgraph over the kept nodes.
 */

import type { EdgeRow, GraphIndex } from '../indexer/index.js';
import type { EmbeddingProvider } from '../resolver/index.js';
import { cosineSimilarity } from '../resolver/index.js';
import type {
  NodeType,
  PlannedChannel,
  RetrievalChannel,
  RetrievalConfig,
  RetrievalPlan,
  SearchResult,
  SeedChannel,
  SkippedChannel,
} from '../types.js';
import {
  buildAdjacency,
  edgeWeight,
  mmrSelect,
  personalizedPageRank,
  spreadingActivation,
} from './index.js';

// ---------------------------------------------------------------------------
// Channels & defaults
// ---------------------------------------------------------------------------

// RetrievalChannel/SeedChannel/RetrievalPlan live in types.ts so the app
// frontend (whose tsconfig maps @untacit/core to the types-only view) can
// share them; re-exported here for the core's own consumers.
export type {
  PlannedChannel,
  RetrievalChannel,
  RetrievalPlan,
  SeedChannel,
  SkippedChannel,
} from '../types.js';

export const SEED_CHANNELS: readonly SeedChannel[] = [
  'lexical',
  'lexical-prf',
  'semantic',
  'semantic-multivec',
];

/** Default RRF weights — mirror GraphIndex.hybridSearch channel trust. */
export const DEFAULT_CHANNEL_WEIGHTS: Record<SeedChannel, number> = {
  lexical: 1.0,
  'lexical-prf': 0.5,
  semantic: 0.9,
  'semantic-multivec': 1.0,
};

/** RRF constant (standard 60): flattens the head so channels vote, not dominate. */
const RRF_K = 60;
/** MMR relevance/diversity trade-off for seed selection. */
const DEFAULT_MMR_LAMBDA = 0.7;
/** Blend of the two graph signals for expansion ranking. */
const DEFAULT_ACTIVATION_BLEND = 0.65;

/** config keys use '_' (JSON style); channel names use '-' (provenance style). */
const CHANNEL_CONFIG_KEY: Record<SeedChannel, 'lexical' | 'lexical_prf' | 'semantic' | 'semantic_multivec'> = {
  lexical: 'lexical',
  'lexical-prf': 'lexical_prf',
  semantic: 'semantic',
  'semantic-multivec': 'semantic_multivec',
};

/** Unicode-aware tokens of a query (any script, diacritics stripped). */
function queryTokens(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

/** Looks like a canonical node id ("rule-bloqueo-de-pedido-sin-prepago"). */
function looksLikeNodeId(query: string): boolean {
  return /^[a-z]+(-[\p{L}\p{N}]+){2,}$/u.test(query.trim());
}

/**
 * Resolve the retrieval plan for a query. Deterministic and side-effect
 * free — exported so the settings UI can preview the decision.
 *
 * Manual mode: every channel enabled in the config runs at its configured
 * (or default) weight; semantic channels still need a provider.
 *
 * Auto mode ("the agent decides") — per-query heuristics:
 * - id-like queries → lexical only: the caller is naming a node, expansion
 *   and embeddings only add noise around an exact lookup;
 * - short keyword queries (≤ 2 tokens) → lexical + semantic channels; PRF
 *   is skipped because one or two terms give RM3 too little context and its
 *   expansions drift;
 * - longer natural-language queries → all four channels, PRF included: the
 *   query carries enough signal to mine feedback documents safely;
 * - non-Latin scripts in the query lean on the multilingual embedding
 *   channels (weight up) since lexical overlap across scripts is weaker.
 * Per-channel `enabled: false` remains a hard veto in both modes.
 */
export function planRetrieval(
  query: string,
  config: RetrievalConfig | undefined,
  providerAvailable: boolean,
): RetrievalPlan {
  const mode = config?.mode ?? 'manual';
  const tokens = queryTokens(query);
  const idLookup = looksLikeNodeId(query);
  const queryKind: RetrievalPlan['queryKind'] = idLookup
    ? 'id-lookup'
    : tokens.length <= 2
      ? 'keywords'
      : 'question';
  // A letter outside the Latin blocks (Basic..Extended-B + Extended
  // Additional) signals weak lexical overlap with a Latin-script graph.
  const nonLatin = [...query].some(
    (ch) => /\p{L}/u.test(ch) && !/[A-Za-z\u00C0-\u024F\u1E00-\u1EFF]/.test(ch),
  );

  const channels: PlannedChannel[] = [];
  const skipped: SkippedChannel[] = [];
  for (const channel of SEED_CHANNELS) {
    const settings = config?.channels?.[CHANNEL_CONFIG_KEY[channel]];
    const semantic = channel === 'semantic' || channel === 'semantic-multivec';
    if (settings?.enabled === false) {
      skipped.push({ channel, reason: 'desactivado en la configuración' });
      continue;
    }
    if (semantic && !providerAvailable) {
      skipped.push({ channel, reason: 'sin proveedor de embeddings disponible' });
      continue;
    }

    let weight = settings?.weight ?? DEFAULT_CHANNEL_WEIGHTS[channel];
    let reason = mode === 'manual' ? 'activado en la configuración' : '';
    if (mode === 'auto') {
      if (queryKind === 'id-lookup' && channel !== 'lexical') {
        skipped.push({ channel, reason: 'consulta con forma de id — basta la búsqueda exacta' });
        continue;
      }
      if (queryKind === 'keywords' && channel === 'lexical-prf') {
        skipped.push({ channel, reason: 'consulta de 1–2 términos — la expansión RM3 derivaría' });
        continue;
      }
      reason =
        queryKind === 'id-lookup'
          ? 'consulta con forma de id — búsqueda exacta'
          : queryKind === 'keywords'
            ? 'consulta corta de palabras clave'
            : 'pregunta en lenguaje natural — todos los canales aportan';
      if (nonLatin && semantic && settings?.weight === undefined) {
        weight = Math.max(weight, 1.0);
        reason += '; alfabeto no latino — peso extra al canal multilingüe';
      }
    }
    channels.push({ channel, weight, reason });
  }

  return {
    mode,
    queryKind,
    channels,
    skipped,
    expansion: {
      depth: clamp(config?.expansion?.depth ?? 2, 1, 3),
      decay: clamp(config?.expansion?.decay ?? 0.6, 0.05, 1),
      fanoutPenalty: clamp(config?.expansion?.fanout_penalty ?? 0.3, 0, 1),
      restart: clamp(config?.expansion?.restart ?? 0.15, 0.01, 0.9),
      activationBlend: clamp(config?.expansion?.activation_blend ?? DEFAULT_ACTIVATION_BLEND, 0, 1),
    },
    mmrLambda: clamp(config?.mmr_lambda ?? DEFAULT_MMR_LAMBDA, 0, 1),
    prf: {
      feedbackDocs: clamp(config?.channels?.lexical_prf?.feedback_docs ?? 8, 1, 50),
      expansionTerms: clamp(config?.channels?.lexical_prf?.expansion_terms ?? 5, 1, 20),
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

// ---------------------------------------------------------------------------
// contextQuery
// ---------------------------------------------------------------------------

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
  /** The channel/parameter decision this result was produced with. */
  plan: RetrievalPlan;
}

export interface ContextOptions {
  nodeTypes?: NodeType[];
  limit?: number;
  /** Structural expansion hops from the seeds (overrides config; default 2). */
  depth?: number;
  embeddings?: EmbeddingProvider | null;
  /** Channel switches, weights and stage parameters (untacit.config.json → retrieval). */
  retrieval?: RetrievalConfig;
}

/** Token set of a normalized name — the embedding-free seed-similarity fallback. */
function nameTokens(text: string): Set<string> {
  return new Set(queryTokens(text));
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/** Hybrid multi-stage retrieval — see the module docstring for the stages. */
export async function contextQuery(
  index: GraphIndex,
  query: string,
  opts: ContextOptions = {},
): Promise<ContextResult> {
  const limit = Math.min(opts.limit ?? 15, 50);
  const provider = opts.embeddings ?? null;
  if (provider !== null) {
    await index.updateEmbeddings(provider);
    await index.updateFacetEmbeddings(provider);
  }

  const plan = planRetrieval(query, opts.retrieval, provider !== null);
  const depth = clamp(opts.depth ?? plan.expansion.depth, 1, 3);

  // --- Stage 1: multi-channel seeding, weighted-RRF fused, channel
  // provenance kept.
  const pool = Math.max(limit * 3, 30);
  const searchOpts = { types: opts.nodeTypes, limit: pool };
  const channelRuns: [RetrievalChannel, number, SearchResult[]][] = [];
  for (const { channel, weight } of plan.channels) {
    switch (channel) {
      case 'lexical':
        channelRuns.push([channel, weight, index.search(query, searchOpts)]);
        break;
      case 'lexical-prf':
        channelRuns.push([
          channel,
          weight,
          index.prfSearch(query, {
            ...searchOpts,
            feedbackDocs: plan.prf.feedbackDocs,
            expansionTerms: plan.prf.expansionTerms,
          }),
        ]);
        break;
      case 'semantic':
        channelRuns.push([channel, weight, await index.semanticSearch(query, provider!, searchOpts)]);
        break;
      case 'semantic-multivec':
        channelRuns.push([
          channel,
          weight,
          await index.lateInteractionSearch(query, provider!, searchOpts),
        ]);
        break;
    }
  }

  interface FusedSeed extends SearchResult {
    fused: number;
    channels: RetrievalChannel[];
  }
  const fused = new Map<string, FusedSeed>();
  for (const [channel, weight, run] of channelRuns) {
    run.forEach((result, rank) => {
      const contribution = weight / (RRF_K + rank + 1);
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
  if (fusedPool.length === 0) return { nodes: [], edges: [], truncated: false, plan };

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
    plan.mmrLambda,
    (s) => s.fused / maxFused,
    seedSimilarity,
  );

  // --- Stage 3: graph expansion — spreading activation blended with PPR.
  const adjacency = buildAdjacency(index.allEdges());
  const seedScores = new Map(seeds.map((s) => [s.id, s.fused / maxFused]));
  const activation = spreadingActivation(adjacency, seedScores, {
    maxDepth: depth,
    decay: plan.expansion.decay,
    fanoutPenalty: plan.expansion.fanoutPenalty,
  });
  const ppr = personalizedPageRank(adjacency, seedScores, { restart: plan.expansion.restart });

  const seedIds = new Set(seedScores.keys());
  let maxActivation = 0;
  let maxPpr = 0;
  for (const [id, score] of activation.scores) {
    if (!seedIds.has(id) && score > maxActivation) maxActivation = score;
  }
  for (const [id, score] of ppr) {
    if (!seedIds.has(id) && score > maxPpr) maxPpr = score;
  }
  const blend = plan.expansion.activationBlend;
  const graphScore = (id: string): number => {
    const act = maxActivation > 0 ? (activation.scores.get(id) ?? 0) / maxActivation : 0;
    const walk = maxPpr > 0 ? (ppr.get(id) ?? 0) / maxPpr : 0;
    return blend * act + (1 - blend) * walk;
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

  // Edges of the induced subgraph over the kept nodes. Trim order: edges
  // touching a seed first (they explain the retrieved context directly),
  // then by hop distance of the closest endpoint, then by weight — so a
  // low-weight IMPLEMENTED_IN on a seed survives the cut ahead of a strong
  // edge deep in the expansion.
  const edges: EdgeRow[] = [];
  const traversed = [...activation.edges.values()] as EdgeRow[];
  const edgeDistance = (e: EdgeRow): number =>
    Math.min(
      activation.distance.get(e.source) ?? depth,
      activation.distance.get(e.targetId) ?? depth,
    );
  traversed.sort(
    (a, b) =>
      edgeDistance(a) - edgeDistance(b) ||
      edgeWeight(b) - edgeWeight(a) ||
      a.id.localeCompare(b.id),
  );
  for (const edge of traversed) {
    if (edges.length >= budget) {
      truncated = true;
      break;
    }
    if (nodes.has(edge.source) && nodes.has(edge.targetId)) edges.push(edge);
  }

  return { nodes: [...nodes.values()], edges, truncated, plan };
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}
