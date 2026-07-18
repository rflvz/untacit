/**
 * Graph store: the in-memory graph backed by canonical node files
 * (docs/02 §5–§7, docs/03 §3, §5).
 *
 * Applies validated + resolved extraction batches to the graph, recomputes
 * edge confidence/status from evidence, and writes only dirty nodes back to
 * disk through the canonical serializer. Importing the same batch twice is a
 * byte-level no-op (idempotence, verified with `git status`).
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  BASE_CONFIDENCE,
  CONFIDENCE_CEILING,
  INTERVIEW_VALIDATED_CONFIDENCE,
  MULTI_SOURCE_BONUS,
  SCHEMA_VERSION,
} from '../constants.js';
import { canonicalJson, edgeId, evidenceKey, nodeRef, parseNodeRef, shortHash } from '../ids.js';
import { nodeFilePath, runFilePath, runsDir } from '../paths.js';
import { loadGraph, serializeNodeFile } from '../serializer/index.js';
import type {
  BatchEvidence,
  Conflict,
  ConflictResolutionRecord,
  EdgeType,
  Evidence,
  ExtractionBatch,
  GraphEdge,
  GraphNode,
  NodeRef,
  ResolutionDecision,
  RunMeta,
  RunStats,
  SourceType,
  Stance,
} from '../types.js';

// ---------------------------------------------------------------------------
// Confidence & conflicts (docs/02 §6, §7)
// ---------------------------------------------------------------------------

/**
 * Edge confidence = max base of its `supports` evidence (interview validated
 * live → 0.95, else BASE_CONFIDENCE by source type) + MULTI_SOURCE_BONUS per
 * additional distinct source type, capped at CONFIDENCE_CEILING, rounded to
 * two decimals. No supporting evidence → 0.
 */
export function computeEdgeConfidence(evidence: Evidence[]): number {
  const supports = evidence.filter((ev) => ev.stance === 'supports');
  if (supports.length === 0) return 0;
  const bases = supports.map((ev) =>
    ev.source_type === 'interview' && ev.validated_by != null && ev.validated_by !== ''
      ? INTERVIEW_VALIDATED_CONFIDENCE
      : BASE_CONFIDENCE[ev.source_type],
  );
  const distinctSourceTypes = new Set(supports.map((ev) => ev.source_type)).size;
  const raw = Math.max(...bases) + MULTI_SOURCE_BONUS * (distinctSourceTypes - 1);
  return Math.round(Math.min(raw, CONFIDENCE_CEILING) * 100) / 100;
}

/**
 * An evidence set is conflicted when it contains at least one `supports` and
 * one `contradicts` evidence coming from different places: different source
 * types, or different locators (compared as canonical JSON).
 */
export function isConflicted(evidence: Evidence[]): boolean {
  const supports = evidence.filter((ev) => ev.stance === 'supports');
  const contradicts = evidence.filter((ev) => ev.stance === 'contradicts');
  if (supports.length === 0 || contradicts.length === 0) return false;
  return supports.some((s) =>
    contradicts.some(
      (c) =>
        c.source_type !== s.source_type ||
        canonicalJson(c.locator) !== canonicalJson(s.locator),
    ),
  );
}

/**
 * Identity of an evidence set: hash over the sorted identity keys of its
 * members. Conflict resolutions are pinned to this — any added or removed
 * evidence re-opens the human decision.
 */
export function evidenceSetHash(evidence: Evidence[]): string {
  return shortHash(
    evidence
      .map((ev) => evidenceKey(ev))
      .sort()
      .join('\n'),
  );
}

/** The persisted human resolution of an edge, when present and well-formed. */
export function conflictResolutionOf(edge: GraphEdge): ConflictResolutionRecord | undefined {
  const raw = edge.attrs?.['conflict_resolution'];
  if (raw === null || typeof raw !== 'object') return undefined;
  const rec = raw as Partial<ConflictResolutionRecord>;
  if (typeof rec.winner !== 'string' || typeof rec.evidence_set !== 'string') return undefined;
  if (rec.status !== 'active' && rec.status !== 'deprecated') return undefined;
  return rec as ConflictResolutionRecord;
}

/**
 * Status an edge should have given its evidence (docs/02 §6):
 *
 * 1. A human resolution pinned to the CURRENT evidence set wins outright —
 *    re-importing the same batches never re-opens a resolved conflict.
 * 2. A stale resolution (evidence changed since) stops protecting the edge:
 *    the conflict re-opens if the evidence still disagrees. A deprecation
 *    the resolution itself produced re-opens too; a deprecation applied by
 *    OTHER means after the resolution still sticks.
 * 3. `deprecated` set by other means sticks; otherwise conflicted iff the
 *    evidence conflicts, else active.
 */
export function recomputeEdgeStatus(edge: GraphEdge): GraphEdge['status'] {
  const resolution = conflictResolutionOf(edge);
  if (resolution !== undefined) {
    if (resolution.evidence_set === evidenceSetHash(edge.evidence)) return resolution.status;
    if (edge.status === 'deprecated' && resolution.status !== 'deprecated') return 'deprecated';
    return isConflicted(edge.evidence) ? 'conflicted' : 'active';
  }
  if (edge.status === 'deprecated') return 'deprecated';
  return isConflicted(edge.evidence) ? 'conflicted' : 'active';
}

// ---------------------------------------------------------------------------
// Batch application internals
// ---------------------------------------------------------------------------

/** Accent-insensitive, case-insensitive comparison key for names/aliases. */
function normalizeName(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();
}

/** Add an alias unless it matches the canonical name or an existing alias (normalized). */
function addAlias(node: GraphNode, candidate: string): boolean {
  const normalized = normalizeName(candidate);
  if (normalized.length === 0 || normalized === normalizeName(node.name)) return false;
  if (node.aliases.some((alias) => normalizeName(alias) === normalized)) return false;
  node.aliases.push(candidate);
  return true;
}

/** Append evidence unless its identity key (source_type/locator/excerpt/stance) is already present. */
function appendEvidence(list: Evidence[], ev: Evidence): boolean {
  const key = evidenceKey(ev);
  if (list.some((existing) => evidenceKey(existing) === key)) return false;
  list.push(ev);
  return true;
}

/** UTC calendar date (YYYY-MM-DD). */
function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Enrich a batch evidence with the batch context (docs/02 §5). */
function enrichEvidence(
  raw: BatchEvidence,
  stance: Stance,
  batch: ExtractionBatch,
  extractedAt: string | undefined,
): Evidence {
  const ev: Evidence = {
    source_type: batch.source_type,
    locator: raw.locator,
    excerpt: raw.excerpt,
    stance,
  };
  if (batch.extractor !== undefined) ev.extractor = batch.extractor;
  if (extractedAt !== undefined) ev.extracted_at = extractedAt;
  ev.run = batch.run_id;
  if (raw.validated_by != null) ev.validated_by = raw.validated_by;
  return ev;
}


// ---------------------------------------------------------------------------
// GraphStore
// ---------------------------------------------------------------------------

export class GraphStore {
  readonly repoRoot: string;
  /** id → node. */
  nodes: Map<string, GraphNode>;
  private readonly dirty = new Set<string>();

  private constructor(repoRoot: string, nodes: Map<string, GraphNode>) {
    this.repoRoot = repoRoot;
    this.nodes = nodes;
  }

  /** Load every node file under graph/ (an empty/missing graph dir yields an empty store). */
  static load(repoRoot: string): GraphStore {
    return new GraphStore(repoRoot, loadGraph(repoRoot));
  }

  getNode(id: string): GraphNode | undefined {
    return this.nodes.get(id);
  }

  /** Resolve a `<type>/<id>` reference; undefined when missing or the type does not match. */
  getByRef(ref: NodeRef): GraphNode | undefined {
    const { type, id } = parseNodeRef(ref);
    const node = this.nodes.get(id);
    return node !== undefined && node.type === type ? node : undefined;
  }

  /** Insert or replace a node and mark it dirty for the next write(). */
  upsertNode(node: GraphNode): void {
    this.nodes.set(node.id, node);
    this.dirty.add(node.id);
  }

  /**
   * Apply a validated batch whose mentions have all been resolved to node ids
   * (docs/02 §5–§8). Every mention in batch.nodes and in edge source/target
   * mentions must have a ResolutionDecision. Evidence is deduplicated by its
   * identity key, so re-applying an identical batch changes nothing.
   */
  applyResolvedBatch(
    batch: ExtractionBatch,
    resolutions: Map<string, ResolutionDecision>,
    opts?: { now?: Date },
  ): RunStats {
    const stats: RunStats = {
      nodes_created: 0,
      nodes_updated: 0,
      edges_created: 0,
      edges_updated: 0,
      evidence_added: 0,
      rejected: 0, // the validator accounts for rejections; the pipeline overwrites
      merge_proposals: 0, // the resolver accounts for proposals; the pipeline overwrites
    };
    const createdNodes = new Set<string>();
    const updatedNodes = new Set<string>();
    const createdEdges = new Set<string>();
    const updatedEdges = new Set<string>();
    const extractedAt = opts?.now !== undefined ? isoDate(opts.now) : undefined;

    const resolve = (mention: string): ResolutionDecision => {
      const decision = resolutions.get(mention);
      if (decision === undefined) {
        throw new Error(`No resolution decision for mention "${mention}"`);
      }
      return decision;
    };

    for (const batchNode of batch.nodes) {
      const { nodeId } = resolve(batchNode.mention);
      const ev = enrichEvidence(batchNode.evidence, 'supports', batch, extractedAt);
      const existing = this.nodes.get(nodeId);
      if (existing === undefined) {
        const node: GraphNode = {
          id: nodeId,
          type: batchNode.type,
          name: batchNode.name,
          description: batchNode.description,
          aliases:
            normalizeName(batchNode.mention) === normalizeName(batchNode.name)
              ? []
              : [batchNode.mention],
          status: 'active',
          attrs: { ...(batchNode.attrs ?? {}) },
          evidence: [ev],
          edges: [],
          schema_version: SCHEMA_VERSION,
        };
        this.nodes.set(nodeId, node);
        this.dirty.add(nodeId);
        createdNodes.add(nodeId);
        stats.evidence_added += 1;
      } else {
        let changed = false;
        if (addAlias(existing, batchNode.mention)) changed = true;
        if (addAlias(existing, batchNode.name)) changed = true;
        if (existing.description.trim().length === 0 && batchNode.description.trim().length > 0) {
          existing.description = batchNode.description;
          changed = true;
        }
        for (const [key, value] of Object.entries(batchNode.attrs ?? {})) {
          if (!(key in existing.attrs)) {
            existing.attrs[key] = value;
            changed = true;
          }
        }
        if (appendEvidence(existing.evidence, ev)) {
          stats.evidence_added += 1;
          changed = true;
        }
        if (changed) {
          this.dirty.add(nodeId);
          if (!createdNodes.has(nodeId)) updatedNodes.add(nodeId);
        }
      }
    }

    for (const batchEdge of batch.edges) {
      const sourceId = resolve(batchEdge.source_mention).nodeId;
      const targetId = resolve(batchEdge.target_mention).nodeId;
      const source = this.nodes.get(sourceId);
      if (source === undefined) {
        throw new Error(`Edge source node "${sourceId}" is not in the graph store`);
      }
      const target = this.nodes.get(targetId);
      if (target === undefined) {
        throw new Error(`Edge target node "${targetId}" is not in the graph store`);
      }
      const targetRef = nodeRef(target.type, target.id);
      const stance: Stance = batchEdge.stance ?? 'supports';
      const ev = enrichEvidence(batchEdge.evidence, stance, batch, extractedAt);
      const edgeKey = `${batchEdge.type}|${sourceId}|${targetRef}`;

      let edge = source.edges.find((e) => e.type === batchEdge.type && e.target === targetRef);
      let changed = false;
      if (edge === undefined) {
        edge = {
          type: batchEdge.type,
          target: targetRef,
          confidence: 0,
          status: 'active',
          evidence: [],
        };
        if (batchEdge.attrs !== undefined && Object.keys(batchEdge.attrs).length > 0) {
          // conflict_resolution is written ONLY by the review queue — an
          // extractor batch must never pin an edge's status (docs/02 §6).
          const { conflict_resolution: _forged, ...attrs } = batchEdge.attrs;
          if (Object.keys(attrs).length > 0) edge.attrs = attrs;
        }
        source.edges.push(edge);
        createdEdges.add(edgeKey);
        changed = true;
      }
      if (appendEvidence(edge.evidence, ev)) {
        stats.evidence_added += 1;
        changed = true;
      }
      const confidence = computeEdgeConfidence(edge.evidence);
      if (edge.confidence !== confidence) {
        edge.confidence = confidence;
        changed = true;
      }
      const status = recomputeEdgeStatus(edge);
      if (edge.status !== status) {
        edge.status = status;
        changed = true;
      }
      if (changed) {
        this.dirty.add(sourceId);
        // updated = existed before this batch and actually changed
        if (!createdEdges.has(edgeKey)) updatedEdges.add(edgeKey);
      }
    }

    stats.nodes_created = createdNodes.size;
    stats.nodes_updated = updatedNodes.size;
    stats.edges_created = createdEdges.size;
    stats.edges_updated = updatedEdges.size;
    return stats;
  }

  /**
   * Serialize dirty nodes canonically to graph/<type>/<id>.md, skipping files
   * whose bytes are already identical. Returns the paths actually written.
   */
  write(): string[] {
    const written: string[] = [];
    for (const id of [...this.dirty].sort()) {
      const node = this.nodes.get(id);
      if (node === undefined) continue;
      const filePath = nodeFilePath(this.repoRoot, node.type, node.id);
      const content = serializeNodeFile(node);
      if (existsSync(filePath) && readFileSync(filePath, 'utf8') === content) continue;
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, 'utf8');
      written.push(filePath);
    }
    this.dirty.clear();
    return written;
  }
}

// ---------------------------------------------------------------------------
// Conflicts (docs/02 §6) — derived rows for the review queue / index
// ---------------------------------------------------------------------------

/** Stable, wire-safe id of one evidence: shortHash of its identity key. */
export function conflictEvidenceKey(ev: Evidence): string {
  return shortHash(evidenceKey(ev));
}

/** Scan every edge and materialize a Conflict row per conflicted evidence set. */
export function collectConflicts(store: GraphStore): Conflict[] {
  const out: Conflict[] = [];
  for (const node of store.nodes.values()) {
    for (const edge of node.edges) {
      if (edge.status !== 'conflicted') continue;
      const id = edgeId(edge.type, node.id, edge.target);
      const withKeys = edge.evidence.map((ev) => ({ ...ev, key: conflictEvidenceKey(ev) }));
      out.push({
        id: shortHash(id),
        nodeId: node.id,
        edgeId: id,
        edgeType: edge.type,
        target: edge.target,
        supporting: withKeys.filter((ev) => ev.stance === 'supports'),
        contradicting: withKeys.filter((ev) => ev.stance === 'contradicts'),
      });
    }
  }
  return out.sort((a, b) =>
    a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : a.edgeId < b.edgeId ? -1 : 1,
  );
}

// ---------------------------------------------------------------------------
// Conflict resolution (docs/02 §6): resolved ONLY from the app review queue —
// the human marks the winning evidence, the edge returns to active (or turns
// deprecated) and the resolution is recorded on the edge itself.
// ---------------------------------------------------------------------------

export interface ResolveConflictOptions {
  /** Node that owns the conflicted edge. */
  nodeId: string;
  edgeType: EdgeType;
  /** Target ref "<type>/<id>" exactly as stored on the edge. */
  target: NodeRef;
  /** Key of the winning evidence (Conflict rows carry it per evidence). */
  winnerKey: string;
  /** Human role identifier recording the decision (never a person's name). */
  by?: string;
  now?: Date;
}

/**
 * Resolve a conflicted edge by marking one evidence as the winner:
 *
 * - winner supports    → the edge returns to `active`;
 * - winner contradicts → the assertion no longer holds → `deprecated`;
 * - the winner gets `validated_by` (a human vouched for it) and confidence
 *   is recomputed;
 * - the decision is persisted in edge.attrs.conflict_resolution, pinned to
 *   the current evidence-set hash: identical re-imports keep the resolution,
 *   genuinely new evidence re-opens the conflict (recomputeEdgeStatus).
 *
 * The caller owns store.write() and the commit.
 */
export function resolveConflictEdge(
  store: GraphStore,
  opts: ResolveConflictOptions,
): { edge: GraphEdge; resolution: ConflictResolutionRecord } {
  const node = store.getNode(opts.nodeId);
  if (node === undefined) {
    throw new Error(`Conflict owner node "${opts.nodeId}" not found`);
  }
  const edge = node.edges.find((e) => e.type === opts.edgeType && e.target === opts.target);
  if (edge === undefined) {
    throw new Error(`Edge ${opts.nodeId} -${opts.edgeType}-> ${opts.target} not found`);
  }
  if (edge.status !== 'conflicted') {
    throw new Error(
      `Edge ${opts.nodeId} -${opts.edgeType}-> ${opts.target} is already ${edge.status}, not conflicted`,
    );
  }
  const winner = edge.evidence.find((ev) => conflictEvidenceKey(ev) === opts.winnerKey);
  if (winner === undefined) {
    throw new Error(
      `Evidence "${opts.winnerKey}" not found on edge ${opts.nodeId} -${opts.edgeType}-> ${opts.target}`,
    );
  }

  if (opts.by !== undefined && opts.by !== '') winner.validated_by = opts.by;
  const status = winner.stance === 'supports' ? ('active' as const) : ('deprecated' as const);
  const resolution: ConflictResolutionRecord = {
    winner: opts.winnerKey,
    status,
    // evidenceKey ignores validated_by, so setting it above does not shift the set hash.
    evidence_set: evidenceSetHash(edge.evidence),
    at: (opts.now ?? new Date()).toISOString(),
  };
  if (opts.by !== undefined && opts.by !== '') resolution.by = opts.by;

  edge.attrs = { ...(edge.attrs ?? {}), conflict_resolution: { ...resolution } };
  edge.status = status;
  edge.confidence = computeEdgeConfidence(edge.evidence);
  store.upsertNode(node);
  return { edge, resolution };
}

// ---------------------------------------------------------------------------
// Runs (docs/03 §5: one run == one commit)
// ---------------------------------------------------------------------------

/** Run id: "YYYY-MM-DDTHH-mm-ss-<sourceType>" in UTC, e.g. "2026-07-14T17-30-05-code". */
export function newRunId(sourceType: SourceType, date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}` +
    `-${sourceType}`
  );
}

/** Write runs/<id>.json with a stable field order, 2-space indent and trailing newline. */
export function writeRunMeta(repoRoot: string, meta: RunMeta): string {
  const ordered: Record<string, unknown> = {};
  ordered.id = meta.id;
  ordered.source_type = meta.source_type;
  if (meta.extractor !== undefined) ordered.extractor = meta.extractor;
  if (meta.started_at !== undefined) ordered.started_at = meta.started_at;
  if (meta.finished_at !== undefined) ordered.finished_at = meta.finished_at;
  ordered.stats = meta.stats;
  if (meta.commit !== undefined) ordered.commit = meta.commit;
  if (meta.rejections !== undefined) ordered.rejections = meta.rejections;
  const filePath = runFilePath(repoRoot, meta.id);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(ordered, null, 2)}\n`, 'utf8');
  return filePath;
}

export function readRunMeta(repoRoot: string, runId: string): RunMeta {
  return JSON.parse(readFileSync(runFilePath(repoRoot, runId), 'utf8')) as RunMeta;
}

/** All runs/<id>.json metadata, sorted by run id (chronological by construction). */
export function listRuns(repoRoot: string): RunMeta[] {
  const dir = runsDir(repoRoot);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith('.json'))
    .sort()
    .map((name) => readRunMeta(repoRoot, name.slice(0, -'.json'.length)));
}
