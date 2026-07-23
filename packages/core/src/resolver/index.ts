/**
 * Entity resolver (docs/02 §9) + reversible merges.
 *
 * The hard problem of the system: "Cliente" in the code, "cliente" in the
 * manual and "los clientes" in an interview are the same node. Pipeline per
 * mention:
 *
 *   1. candidate_id — trusted when it points to an existing node of the
 *      same type.
 *   2. Exact match — normalized (case/accents/naive es-en singular-plural)
 *      against name + aliases of same-type nodes.
 *   3. Fuzzy match — max of name similarity and (optional) embedding cosine;
 *      score >= thresholds.auto resolves automatically.
 *   4. Gray zone [gray, auto) — creates a provisional node and enqueues a
 *      MergeProposal. NEVER auto-merges: a silent wrong merge corrupts the
 *      graph in ways that are hard to detect.
 *   5. Below gray — new node.
 *
 * Merges are reversible: merges.json keeps proposals plus MergeRecords with a
 * full snapshot of the absorbed node and the list of inbound edges that were
 * rewired, so revertMerge can restore the pre-merge topology.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { DEFAULT_RESOLVER_THRESHOLDS } from '../constants.js';
import { evidenceKey, nodeIdFor, nodeRef, shortHash } from '../ids.js';
import { mergesFilePath } from '../paths.js';
import { computeEdgeConfidence, recomputeEdgeStatus } from '../graph/index.js';
import type { GraphStore } from '../graph/index.js';
import { deleteNodeFile } from '../serializer/index.js';
import type {
  BatchNode,
  EdgeType,
  Evidence,
  ExtractionBatch,
  GraphEdge,
  GraphNode,
  MergeProposal,
  MergeRecord,
  NodeRef,
  NodeType,
  ResolutionDecision,
} from '../types.js';

// ---------------------------------------------------------------------------
// Text normalization
// ---------------------------------------------------------------------------

/** Lowercase, strip accents, collapse every non-alphanumeric run to a single space. */
function normalizeText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Naive es/en singularization: strip one trailing "s" (len > 3), e.g. "clientes" → "cliente". */
function singularizeToken(token: string): string {
  return token.endsWith('s') && token.length > 3 ? token.slice(0, -1) : token;
}

/**
 * Normalized match keys for exact matching. Besides the plain normalized
 * string, adds per-token variants with a trailing "s" (len > 3) or "es"
 * (len > 4) stripped, so "clientes"/"cliente" and "ordenes"/"orden" share a
 * key. Stripping on both sides subsumes "adding s/es" on one side.
 */
function matchKeys(text: string): Set<string> {
  const keys = new Set<string>();
  const norm = normalizeText(text);
  if (norm.length === 0) return keys;
  keys.add(norm);
  const tokens = norm.split(' ');
  const stripped = (suffix: string, minLen: number): string =>
    tokens
      .map((t) => (t.endsWith(suffix) && t.length > minLen ? t.slice(0, -suffix.length) : t))
      .join(' ');
  keys.add(stripped('s', 3));
  keys.add(stripped('es', 4));
  return keys;
}

function keysIntersect(a: Set<string>, b: Set<string>): boolean {
  for (const key of a) if (b.has(key)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Name similarity
// ---------------------------------------------------------------------------

/** Classic two-row Levenshtein distance. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;
  let prev = new Array<number>(b.length + 1);
  let curr = new Array<number>(b.length + 1);
  for (let j = 0; j <= b.length; j++) prev[j] = j;
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length];
}

/**
 * Name similarity in [0, 1]. Formula (deterministic, documented):
 *
 *   na, nb = normalized strings (lowercase, accents stripped, punctuation → space)
 *   na === nb                       → 1
 *   either empty                    → 0
 *   lev = 1 - levenshtein(na, nb) / max(len(na), len(nb))
 *   jac = Jaccard over the sets of singularized tokens (trailing "s" stripped)
 *   result = max(lev, jac)
 *
 * Singular/plural variants of the same tokens ("cliente" vs "clientes") give
 * jac = 1, matching the exact-match normalization semantics.
 */
export function nameSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 1;
  if (na.length === 0 || nb.length === 0) return 0;
  const lev = 1 - levenshtein(na, nb) / Math.max(na.length, nb.length);
  const ta = new Set(na.split(' ').map(singularizeToken));
  const tb = new Set(nb.split(' ').map(singularizeToken));
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter += 1;
  const union = ta.size + tb.size - inter;
  const jac = union === 0 ? 0 : inter / union;
  return Math.max(lev, jac);
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

/**
 * Asymmetric-retrieval hint: e5/bge-family models embed queries and passages
 * with different prefixes. Symmetric providers (hash) ignore it.
 */
export type EmbeddingKind = 'query' | 'passage';

export interface EmbeddingProvider {
  /** Stable identifier persisted next to each vector (cache key component). */
  name: string;
  /**
   * Cosine value that counts as "no similarity" for this provider's vectors.
   * Sentence-embedding families (e5/bge) concentrate cosine in a high band
   * (~0.75–1.0 even for unrelated same-domain texts), so their raw cosine
   * cannot be compared against thresholds calibrated for name similarity —
   * without a floor, the resolver would auto-merge unrelated concepts.
   * Absent/0 leaves the cosine untouched (hash provider, tests).
   */
  similarityFloor?: number;
  embed(texts: string[], kind?: EmbeddingKind): Promise<number[][]>;
}

/**
 * Cosine rescaled so `floor` maps to 0 and 1 stays 1 — the value that IS
 * comparable against the resolver/similarity thresholds. Negative results
 * clamp to 0.
 */
export function calibratedCosine(a: number[], b: number[], floor = 0): number {
  const cos = cosineSimilarity(a, b);
  if (floor <= 0) return cos;
  return Math.max(0, (cos - floor) / (1 - floor));
}

/**
 * Deterministic local embedding: bag of character trigrams over the
 * normalized text (space-padded), each trigram hashed with sha1 into one of
 * 256 buckets, l2-normalized. Purely local, zero dependencies — used by tests
 * and as a placeholder until a real multilingual model provider lands
 * (e5/bge via transformers.js, docs/03 §3; deliberately NOT added as a
 * dependency here).
 */
export class HashEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dims: number;

  constructor(dims = 256) {
    this.dims = dims;
    this.name = `hash-char-trigram-${dims}`;
  }

  /** Symmetric provider: the query/passage distinction is ignored. */
  async embed(texts: string[], _kind?: EmbeddingKind): Promise<number[][]> {
    return texts.map((text) => this.embedOne(text));
  }

  private embedOne(text: string): number[] {
    const vec = new Array<number>(this.dims).fill(0);
    const norm = normalizeText(text);
    if (norm.length === 0) return vec;
    const padded = ` ${norm} `;
    for (let i = 0; i + 3 <= padded.length; i++) {
      const trigram = padded.slice(i, i + 3);
      const digest = createHash('sha1').update(trigram).digest();
      const bucket = digest.readUInt32BE(0) % this.dims;
      vec[bucket] += 1;
    }
    const len = Math.sqrt(vec.reduce((sum, v) => sum + v * v, 0));
    return len === 0 ? vec : vec.map((v) => v / len);
  }
}

/** Cosine similarity; 0 when either vector has zero norm. Throws on length mismatch. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`cosineSimilarity: length mismatch (${a.length} vs ${b.length})`);
  }
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// ---------------------------------------------------------------------------
// resolveBatch
// ---------------------------------------------------------------------------

export interface ResolveOptions {
  thresholds?: { auto: number; gray: number };
  embeddings?: EmbeddingProvider | null;
  /**
   * Cached store-node vectors (node id → vector), typically read from the
   * derived index (GraphIndex.nodeVectors). Store nodes missing from the map
   * are embedded on the fly with `embeddings`.
   */
  nodeVectors?: Map<string, number[]>;
  now?: Date;
}

export interface ResolveResult {
  /** mention → decision, covering every node mention and edge mention of the batch. */
  resolutions: Map<string, ResolutionDecision>;
  proposals: MergeProposal[];
}

/**
 * Text embedded for a canonical node: "type name aliases description"
 * (docs/03 §3). The index's embedding pipeline uses the same composition, so
 * cached vectors are interchangeable with freshly computed ones.
 */
export function embeddingTextForNode(
  node: Pick<GraphNode, 'type' | 'name' | 'aliases' | 'description'>,
): string {
  return [node.type, node.name, ...node.aliases, node.description].join(' ').trim();
}

/** Symmetric text for a batch node (mention included when it differs from name). */
function embeddingTextForBatchNode(bn: BatchNode): string {
  const parts = [bn.type, bn.name];
  if (normalizeText(bn.mention) !== normalizeText(bn.name)) parts.push(bn.mention);
  parts.push(bn.description);
  return parts.join(' ').trim();
}

/** A node id assigned during this batch (not yet in the store), with its match keys. */
interface CreatedEntry {
  id: string;
  type: NodeType;
  keys: Set<string>;
}

/**
 * Resolve every mention of a batch against the canonical store. Processes
 * batch.nodes first, then any edge source/target mentions not covered by a
 * node mention (the validator guarantees coverage; this is defensive).
 *
 * Two identical unseen mentions in one batch resolve to the same new id, and
 * different mentions that normalize to the same key (e.g. "Bobina" and
 * "bobinas") reuse the id assigned earlier in the batch.
 */
export async function resolveBatch(
  batch: ExtractionBatch,
  store: GraphStore,
  opts: ResolveOptions = {},
): Promise<ResolveResult> {
  const thresholds = opts.thresholds ?? DEFAULT_RESOLVER_THRESHOLDS;
  const now = opts.now ?? new Date();
  const resolutions = new Map<string, ResolutionDecision>();
  const proposals: MergeProposal[] = [];
  /** Ids assigned this batch, for collision suffixing. */
  const assigned = new Set<string>();
  /** Batch-created nodes, matched exactly so equivalent mentions share the id. */
  const createdRegistry: CreatedEntry[] = [];

  // Deterministic candidate order: sorted by node id; ties resolve to the first.
  const storeNodes = [...store.nodes.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );

  // Optional embeddings: cached store-node vectors (from the derived index)
  // are reused; only uncached store nodes and batch mentions are embedded.
  const provider = opts.embeddings ?? null;
  let nodeVectors: Map<string, number[]> | null = null;
  let mentionVectors: Map<string, number[]> | null = null;
  if (provider !== null && storeNodes.length > 0 && batch.nodes.length > 0) {
    nodeVectors = new Map(opts.nodeVectors ?? []);
    const missing = storeNodes.filter((node) => !nodeVectors!.has(node.id));
    if (missing.length > 0) {
      const vecs = await provider.embed(missing.map(embeddingTextForNode), 'passage');
      missing.forEach((node, i) => nodeVectors!.set(node.id, vecs[i] ?? []));
    }
    const uniqueBatchNodes: BatchNode[] = [];
    const seen = new Set<string>();
    for (const bn of batch.nodes) {
      if (!seen.has(bn.mention)) {
        seen.add(bn.mention);
        uniqueBatchNodes.push(bn);
      }
    }
    const mentionVecs = await provider.embed(
      uniqueBatchNodes.map(embeddingTextForBatchNode),
      'passage',
    );
    mentionVectors = new Map(uniqueBatchNodes.map((bn, i) => [bn.mention, mentionVecs[i] ?? []]));
  }

  const nodeKeys = (node: GraphNode): Set<string> => {
    const keys = matchKeys(node.name);
    for (const alias of node.aliases) for (const k of matchKeys(alias)) keys.add(k);
    return keys;
  };

  const assignNewId = (type: NodeType, name: string): string => {
    const base = nodeIdFor(type, name);
    let id = base;
    let n = 2;
    while (store.nodes.has(id) || assigned.has(id)) {
      id = `${base}-${n}`;
      n += 1;
    }
    assigned.add(id);
    return id;
  };

  const registerCreated = (id: string, type: NodeType, keys: Set<string>): void => {
    createdRegistry.push({ id, type, keys });
  };

  const resolveNodeMention = (bn: BatchNode): ResolutionDecision => {
    // 1. Extractor-provided candidate id, trusted when type matches.
    if (bn.candidate_id != null) {
      const candidate = store.getNode(bn.candidate_id);
      if (candidate !== undefined && candidate.type === bn.type) {
        return { mention: bn.mention, action: 'exact-match', nodeId: candidate.id };
      }
    }

    const keys = matchKeys(bn.mention);
    for (const k of matchKeys(bn.name)) keys.add(k);

    // 2. Exact normalized match against same-type store nodes...
    for (const candidate of storeNodes) {
      if (candidate.type !== bn.type) continue;
      if (keysIntersect(keys, nodeKeys(candidate))) {
        return { mention: bn.mention, action: 'exact-match', nodeId: candidate.id };
      }
    }
    // ...and against nodes created earlier in this batch.
    for (const entry of createdRegistry) {
      if (entry.type !== bn.type) continue;
      if (keysIntersect(keys, entry.keys)) {
        return { mention: bn.mention, action: 'exact-match', nodeId: entry.id };
      }
    }

    // 3. Fuzzy: max of name similarity (mention/name vs name/aliases) and
    //    embedding cosine, best over same-type store nodes.
    let bestScore = 0;
    let bestNode: GraphNode | null = null;
    const mentionVec = mentionVectors?.get(bn.mention);
    for (const candidate of storeNodes) {
      if (candidate.type !== bn.type) continue;
      let score = 0;
      for (const ours of [bn.mention, bn.name]) {
        score = Math.max(score, nameSimilarity(ours, candidate.name));
        for (const alias of candidate.aliases) {
          score = Math.max(score, nameSimilarity(ours, alias));
        }
      }
      if (mentionVec !== undefined && nodeVectors !== null) {
        const candidateVec = nodeVectors.get(candidate.id);
        if (candidateVec !== undefined && candidateVec.length === mentionVec.length) {
          score = Math.max(
            score,
            calibratedCosine(mentionVec, candidateVec, provider?.similarityFloor ?? 0),
          );
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestNode = candidate;
      }
    }

    if (bestNode !== null && bestScore >= thresholds.auto) {
      // applyResolvedBatch records the mention as alias of the matched node.
      return {
        mention: bn.mention,
        action: 'fuzzy-match',
        nodeId: bestNode.id,
        score: round4(bestScore),
      };
    }

    // 4. Gray zone: provisional node + merge proposal. NEVER auto-merge here.
    if (bestNode !== null && bestScore >= thresholds.gray) {
      const newId = assignNewId(bn.type, bn.name);
      registerCreated(newId, bn.type, keys);
      const proposal: MergeProposal = {
        id: shortHash(`${bn.mention}|${bestNode.id}|${batch.run_id}`),
        sourceNodeId: newId,
        targetNodeId: bestNode.id,
        mention: bn.mention,
        score: round4(bestScore),
        status: 'pending',
        created_at: now.toISOString(),
      };
      proposals.push(proposal);
      return {
        mention: bn.mention,
        action: 'created-provisional',
        nodeId: newId,
        score: round4(bestScore),
        proposalId: proposal.id,
      };
    }

    // 5. No match: new node.
    const newId = assignNewId(bn.type, bn.name);
    registerCreated(newId, bn.type, keys);
    return { mention: bn.mention, action: 'created', nodeId: newId };
  };

  /**
   * Defensive resolution for an edge mention with no covering batch node
   * (the validator should prevent this). Without a declared type we match
   * across ALL node types, resolve exactly or above the auto threshold, and
   * otherwise create a fallback `entity` id so the decision map stays
   * complete; no gray-zone proposal is enqueued (no type for a provisional
   * node).
   */
  const resolveEdgeMention = (mention: string): ResolutionDecision => {
    const keys = matchKeys(mention);
    for (const candidate of storeNodes) {
      if (keysIntersect(keys, nodeKeys(candidate))) {
        return { mention, action: 'exact-match', nodeId: candidate.id };
      }
    }
    for (const entry of createdRegistry) {
      if (keysIntersect(keys, entry.keys)) {
        return { mention, action: 'exact-match', nodeId: entry.id };
      }
    }
    let bestScore = 0;
    let bestNode: GraphNode | null = null;
    for (const candidate of storeNodes) {
      let score = nameSimilarity(mention, candidate.name);
      for (const alias of candidate.aliases) {
        score = Math.max(score, nameSimilarity(mention, alias));
      }
      if (score > bestScore) {
        bestScore = score;
        bestNode = candidate;
      }
    }
    if (bestNode !== null && bestScore >= thresholds.auto) {
      return { mention, action: 'fuzzy-match', nodeId: bestNode.id, score: round4(bestScore) };
    }
    const newId = assignNewId('entity', mention);
    registerCreated(newId, 'entity', keys);
    return { mention, action: 'created', nodeId: newId };
  };

  for (const bn of batch.nodes) {
    if (resolutions.has(bn.mention)) continue; // identical mention → same decision/id
    resolutions.set(bn.mention, resolveNodeMention(bn));
  }
  for (const edge of batch.edges) {
    for (const mention of [edge.source_mention, edge.target_mention]) {
      if (resolutions.has(mention)) continue;
      resolutions.set(mention, resolveEdgeMention(mention));
    }
  }

  return { resolutions, proposals };
}

function round4(value: number): number {
  return Math.round(value * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// merges.json — proposals + reversible merge records (docs/02 §9)
// ---------------------------------------------------------------------------

export interface MergesFile {
  proposals: MergeProposal[];
  merges: MergeRecord[];
}

/** An inbound edge retargeted during a merge, so revertMerge can restore it. */
export interface RewiredEdge {
  nodeId: string;
  edgeType: EdgeType;
  from: NodeRef;
  to: NodeRef;
  /**
   * True when the rewired edge was folded into a pre-existing (type, target)
   * edge on the same node; its evidence cannot be cleanly split back out, so
   * revertMerge skips these entries (known limitation).
   */
  merged?: boolean;
}

/** MergeRecord as persisted, extended with reversal bookkeeping. */
export interface StoredMergeRecord extends MergeRecord {
  rewired?: RewiredEdge[];
  reverted_at?: string;
}

/** Load merges.json; a missing file (or missing keys) yields empty arrays. */
export function loadMergesFile(repoRoot: string): MergesFile {
  const filePath = mergesFilePath(repoRoot);
  if (!existsSync(filePath)) return { proposals: [], merges: [] };
  const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<MergesFile>;
  return {
    proposals: Array.isArray(raw.proposals) ? raw.proposals : [],
    merges: Array.isArray(raw.merges) ? raw.merges : [],
  };
}

const PROPOSAL_KEY_ORDER = [
  'id',
  'sourceNodeId',
  'targetNodeId',
  'mention',
  'score',
  'status',
  'created_at',
  'resolved_at',
  'resolved_by',
] as const;

const MERGE_KEY_ORDER = [
  'id',
  'fromNodeId',
  'intoNodeId',
  'approved_by',
  'merged_at',
  'from_snapshot',
  'rewired',
  'reverted_at',
] as const;

/** Fixed key order first, any extra keys sorted after, undefined skipped. */
function orderKeys(obj: Record<string, unknown>, order: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) {
    if (obj[key] !== undefined) out[key] = obj[key];
  }
  for (const key of Object.keys(obj).sort()) {
    if (!(key in out) && obj[key] !== undefined) out[key] = obj[key];
  }
  return out;
}

/**
 * Write merges.json deterministically: proposals sorted by id, merges sorted
 * by id, stable key order, 2-space indent, trailing newline. Saving the same
 * data twice is byte-identical.
 */
export function saveMergesFile(repoRoot: string, data: MergesFile): void {
  const byId = <T extends { id: string }>(a: T, b: T): number =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  const ordered = {
    proposals: [...data.proposals]
      .sort(byId)
      .map((p) => orderKeys(p as unknown as Record<string, unknown>, PROPOSAL_KEY_ORDER)),
    merges: [...data.merges]
      .sort(byId)
      .map((m) => orderKeys(m as unknown as Record<string, unknown>, MERGE_KEY_ORDER)),
  };
  const filePath = mergesFilePath(repoRoot);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Merge execution (reversible)
// ---------------------------------------------------------------------------

function appendEvidenceDedup(list: Evidence[], ev: Evidence): void {
  const key = evidenceKey(ev);
  if (!list.some((existing) => evidenceKey(existing) === key)) list.push(ev);
}

function mergeEvidenceInto(edge: GraphEdge, evidence: Evidence[]): void {
  for (const ev of evidence) appendEvidenceDedup(edge.evidence, ev);
  edge.confidence = computeEdgeConfidence(edge.evidence);
  edge.status = recomputeEdgeStatus(edge);
}

function addAliasNormalized(node: GraphNode, candidate: string): void {
  const norm = normalizeText(candidate);
  if (norm.length === 0 || norm === normalizeText(node.name)) return;
  if (node.aliases.some((alias) => normalizeText(alias) === norm)) return;
  node.aliases.push(candidate);
}

/**
 * Accept a pending merge proposal: absorb the source node into the target.
 *
 * - aliases: source name + aliases added to the target (deduped, target name
 *   excluded);
 * - node evidence: merged, deduped by evidence key;
 * - outgoing edges: re-keyed by (type, target); evidence merged and
 *   confidence recomputed for edges that collide;
 * - inbound edges: every edge in the store pointing at the source is
 *   retargeted to the target (tracked in the MergeRecord for reversal);
 * - the source node is removed from the store and its file deleted; a
 *   MergeRecord with a deep from_snapshot is persisted to merges.json.
 *
 * The caller still owns store.write() (and the run commit).
 */
export function acceptMergeProposal(
  store: GraphStore,
  proposalId: string,
  approvedBy?: string,
): MergeRecord {
  const file = loadMergesFile(store.repoRoot);
  const proposal = file.proposals.find((p) => p.id === proposalId);
  if (proposal === undefined) {
    throw new Error(`Merge proposal "${proposalId}" not found in merges.json`);
  }
  if (proposal.status !== 'pending') {
    throw new Error(`Merge proposal "${proposalId}" is already ${proposal.status}`);
  }
  const source = store.getNode(proposal.sourceNodeId);
  if (source === undefined) {
    throw new Error(`Merge source node "${proposal.sourceNodeId}" is not in the store`);
  }
  const target = store.getNode(proposal.targetNodeId);
  if (target === undefined) {
    throw new Error(`Merge target node "${proposal.targetNodeId}" is not in the store`);
  }
  if (source.type !== target.type) {
    throw new Error(
      `Cannot merge across types: ${source.type}/${source.id} into ${target.type}/${target.id}`,
    );
  }

  const fromSnapshot = structuredClone(source);
  const sourceRef = nodeRef(source.type, source.id);
  const targetRef = nodeRef(target.type, target.id);

  // Aliases: source name + aliases, deduped, target name excluded.
  for (const alias of [source.name, ...source.aliases]) addAliasNormalized(target, alias);

  // Node evidence, deduped by evidence key.
  for (const ev of source.evidence) appendEvidenceDedup(target.evidence, ev);

  // Outgoing edges, re-keyed by (type, target).
  for (const edge of source.edges) {
    const newTarget = edge.target === sourceRef ? targetRef : edge.target;
    const existing = target.edges.find((e) => e.type === edge.type && e.target === newTarget);
    if (existing !== undefined) {
      if (edge.attrs !== undefined && Object.keys(edge.attrs).length > 0) {
        // A conflict_resolution record is pinned to the exact evidence set of
        // ITS edge — transplanting it onto the surviving edge could silently
        // flip that edge's status through the stale-record branch.
        const { conflict_resolution: _pinned, ...attrs } = edge.attrs;
        if (Object.keys(attrs).length > 0) {
          existing.attrs = { ...attrs, ...(existing.attrs ?? {}) };
        }
      }
      mergeEvidenceInto(existing, edge.evidence);
    } else {
      const moved = structuredClone(edge);
      moved.target = newTarget;
      moved.confidence = computeEdgeConfidence(moved.evidence);
      target.edges.push(moved);
    }
  }

  // Inbound edges: rewrite every edge in the store pointing at the source.
  const rewired: RewiredEdge[] = [];
  const nodesSorted = [...store.nodes.values()].sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  for (const node of nodesSorted) {
    if (node.id === source.id) continue;
    const removeAt: number[] = [];
    let changed = false;
    for (let i = 0; i < node.edges.length; i++) {
      const edge = node.edges[i];
      if (edge.target !== sourceRef) continue;
      const duplicate = node.edges.find(
        (e) => e !== edge && e.type === edge.type && e.target === targetRef,
      );
      if (duplicate !== undefined) {
        // Fold into the pre-existing edge; not cleanly reversible.
        mergeEvidenceInto(duplicate, edge.evidence);
        removeAt.push(i);
        rewired.push({ nodeId: node.id, edgeType: edge.type, from: sourceRef, to: targetRef, merged: true });
      } else {
        edge.target = targetRef;
        rewired.push({ nodeId: node.id, edgeType: edge.type, from: sourceRef, to: targetRef });
      }
      changed = true;
    }
    for (let i = removeAt.length - 1; i >= 0; i--) node.edges.splice(removeAt[i], 1);
    if (changed) store.upsertNode(node);
  }

  // Remove the absorbed node (store + file) and mark the survivor dirty.
  store.nodes.delete(source.id);
  deleteNodeFile(store.repoRoot, source);
  store.upsertNode(target);

  const now = new Date().toISOString();
  const record: StoredMergeRecord = {
    id: shortHash(`merge|${proposal.id}|${source.id}|${target.id}`),
    fromNodeId: source.id,
    intoNodeId: target.id,
    merged_at: now,
    from_snapshot: fromSnapshot,
  };
  if (approvedBy !== undefined) record.approved_by = approvedBy;
  if (rewired.length > 0) record.rewired = rewired;

  proposal.status = 'accepted';
  proposal.resolved_at = now;
  if (approvedBy !== undefined) proposal.resolved_by = approvedBy;

  file.merges.push(record);
  saveMergesFile(store.repoRoot, file);
  return record;
}

/** Mark a pending proposal rejected (the provisional node stays as its own node). */
export function rejectMergeProposal(repoRoot: string, proposalId: string, by?: string): void {
  const file = loadMergesFile(repoRoot);
  const proposal = file.proposals.find((p) => p.id === proposalId);
  if (proposal === undefined) {
    throw new Error(`Merge proposal "${proposalId}" not found in merges.json`);
  }
  if (proposal.status !== 'pending') {
    throw new Error(`Merge proposal "${proposalId}" is already ${proposal.status}`);
  }
  proposal.status = 'rejected';
  proposal.resolved_at = new Date().toISOString();
  if (by !== undefined) proposal.resolved_by = by;
  saveMergesFile(repoRoot, file);
}

/**
 * Revert an accepted merge: restore the absorbed node from its snapshot and
 * retarget the rewired inbound edges back to it. The MergeRecord is marked
 * with reverted_at and persisted.
 *
 * Known limitations (documented, accepted for v1):
 * - aliases/evidence/edges that were folded into the surviving node during
 *   the merge stay there (they cannot be attributed back safely);
 * - rewired entries flagged `merged: true` (folded into a pre-existing edge)
 *   are skipped: their evidence cannot be split back out.
 *
 * The caller owns store.write() to re-materialize the restored node file.
 */
export function revertMerge(store: GraphStore, mergeId: string): void {
  const file = loadMergesFile(store.repoRoot);
  const record = file.merges.find((m) => m.id === mergeId) as StoredMergeRecord | undefined;
  if (record === undefined) {
    throw new Error(`Merge record "${mergeId}" not found in merges.json`);
  }
  if (record.reverted_at !== undefined) {
    throw new Error(`Merge "${mergeId}" was already reverted at ${record.reverted_at}`);
  }
  if (record.from_snapshot === undefined) {
    throw new Error(`Merge "${mergeId}" has no from_snapshot; cannot revert`);
  }

  store.upsertNode(structuredClone(record.from_snapshot));

  for (const entry of record.rewired ?? []) {
    if (entry.merged === true) continue; // evidence folded into a pre-existing edge; see docstring
    const node = store.getNode(entry.nodeId);
    if (node === undefined) continue;
    const edge = node.edges.find((e) => e.type === entry.edgeType && e.target === entry.to);
    if (edge === undefined) continue;
    edge.target = entry.from;
    store.upsertNode(node);
  }

  record.reverted_at = new Date().toISOString();
  saveMergesFile(store.repoRoot, file);
}
