/**
 * Stable identifiers: node slugs, edge ids, node refs, evidence keys.
 */

import { createHash } from 'node:crypto';
import type { EdgeType, Evidence, NodeRef, NodeType } from './types.js';

/** kebab-case slug from a human name: lowercased, accents stripped, non-alphanumerics collapsed to '-'. */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Canonical node id: `<type>-<slug(name)>`, e.g. "rule-descuento-volumen". */
export function nodeIdFor(type: NodeType, name: string): string {
  const slug = slugify(name);
  return slug.startsWith(`${type}-`) ? slug : `${type}-${slug}`;
}

/** Node reference as used in edge targets and file paths: `<type>/<id>`. */
export function nodeRef(type: NodeType, id: string): NodeRef {
  return `${type}/${id}`;
}

export function parseNodeRef(ref: NodeRef): { type: NodeType; id: string } {
  const idx = ref.indexOf('/');
  if (idx === -1) {
    throw new Error(`Invalid node ref "${ref}" — expected "<type>/<id>"`);
  }
  return {
    type: ref.slice(0, idx) as NodeType,
    id: ref.slice(idx + 1),
  };
}

/** Stable edge id: sha1 of (type, source_id, target_ref) (docs/02 §4). */
export function edgeId(type: EdgeType, sourceId: string, target: NodeRef): string {
  return createHash('sha1').update(`${type}|${sourceId}|${target}`).digest('hex');
}

/** Canonical JSON with sorted keys, for hashing/dedup. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortValue(v);
    }
    return out;
  }
  return value;
}

/**
 * Evidence identity for dedup on re-import: (source_type, locator, excerpt, stance).
 * Importing the same batch twice must be a no-op (idempotence, docs/03 §10).
 */
export function evidenceKey(ev: Pick<Evidence, 'source_type' | 'locator' | 'excerpt' | 'stance'>): string {
  return canonicalJson({
    source_type: ev.source_type,
    locator: ev.locator,
    excerpt: ev.excerpt,
    stance: ev.stance,
  });
}

/** Short stable hash for derived ids (proposals, conflicts). */
export function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12);
}
