/**
 * Row shapes and pure row/value helpers shared by the index builder
 * (build.ts) and the GraphIndex query surface (index.ts).
 */

import { createHash } from 'node:crypto';
import { relative, sep } from 'node:path';
import type {
  EdgeType,
  ElementStatus,
  Evidence,
  ExtractorInfo,
  Locator,
  NodeRef,
  SourceType,
  Stance,
} from '../types.js';

// ---------------------------------------------------------------------------
// Public row shapes
// ---------------------------------------------------------------------------

export interface EdgeRow {
  /** Stable edge id: edgeId(type, source, target) from ids.ts. */
  id: string;
  /** Source node id (the node whose file owns the edge). */
  source: string;
  type: EdgeType;
  /** Target node ref "<type>/<id>" exactly as written in the file. */
  target: NodeRef;
  /** Target node id (may be dangling — no node file for it). */
  targetId: string;
  confidence: number;
  status: ElementStatus;
  attrs?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Internal row shapes (database column names)
// ---------------------------------------------------------------------------

export interface NodeRowDb {
  id: string;
  type: string;
  name: string;
  status: string;
  description: string;
  schema_version: number;
  file_path: string;
}

export interface EdgeRowDb {
  id: string;
  source_id: string;
  type: string;
  target_ref: string;
  target_id: string;
  confidence: number;
  status: string;
  attrs_json: string | null;
}

export interface EvidenceRowDb {
  id: number;
  owner_kind: string;
  owner_id: string;
  source_type: string;
  locator_json: string;
  excerpt: string;
  stance: string;
  extractor_json: string | null;
  extracted_at: string | null;
  run: string | null;
  validated_by: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function sha1(content: Buffer | string): string {
  return createHash('sha1').update(content).digest('hex');
}

/** Repo-relative path with forward slashes, so the index survives repo moves. */
export function toRepoRel(repoRoot: string, absPath: string): string {
  return relative(repoRoot, absPath).split(sep).join('/');
}

/** Target node id from a "<type>/<id>" ref; tolerant of malformed refs. */
export function targetIdOf(target: NodeRef): string {
  const idx = target.indexOf('/');
  return idx === -1 ? target : target.slice(idx + 1);
}

export function firstLine(description: string): string {
  const nl = description.indexOf('\n');
  return (nl === -1 ? description : description.slice(0, nl)).trim();
}

/** SQLite only binds primitives; coerce YAML surprises (dates, numbers) to text. */
export function asTextOrNull(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === 'string' ? value : String(value);
}

export function toEdgeRow(row: EdgeRowDb): EdgeRow {
  const edge: EdgeRow = {
    id: row.id,
    source: row.source_id,
    type: row.type as EdgeType,
    target: row.target_ref,
    targetId: row.target_id,
    confidence: row.confidence,
    status: row.status as ElementStatus,
  };
  if (row.attrs_json !== null) {
    edge.attrs = JSON.parse(row.attrs_json) as Record<string, unknown>;
  }
  return edge;
}

export function rowToEvidence(row: EvidenceRowDb): Evidence {
  const ev: Evidence = {
    source_type: row.source_type as SourceType,
    locator: JSON.parse(row.locator_json) as Locator,
    excerpt: row.excerpt,
    stance: row.stance as Stance,
  };
  if (row.extractor_json !== null) {
    ev.extractor = JSON.parse(row.extractor_json) as ExtractorInfo;
  }
  if (row.extracted_at !== null) ev.extracted_at = row.extracted_at;
  if (row.run !== null) ev.run = row.run;
  if (row.validated_by !== null) ev.validated_by = row.validated_by;
  return ev;
}

export function compareEdgeRows(a: EdgeRow, b: EdgeRow): number {
  return (
    a.source.localeCompare(b.source) ||
    a.type.localeCompare(b.type) ||
    a.target.localeCompare(b.target)
  );
}
