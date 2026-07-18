/**
 * Canonical node-file serializer (docs/02 §12, docs/03 §3).
 *
 * One markdown file per node at graph/<type>/<id>.md: YAML frontmatter with
 * the structured fields plus outgoing edges (evidence embedded), description
 * in the body. The node id is the file name — never a frontmatter key.
 *
 * Canonicalization is a hard requirement: byte-deterministic output with a
 * stable key order, sorted edges/evidence/aliases and fixed YAML formatting,
 * so re-extracting with unchanged sources leaves `git status` clean.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { Document, isScalar, parse as parseYaml, Scalar, visit } from 'yaml';
import {
  EDGE_KEY_ORDER,
  EVIDENCE_KEY_ORDER,
  EXTRACTOR_KEY_ORDER,
  LOCATOR_KEY_ORDER,
  NODE_KEY_ORDER,
  SCHEMA_VERSION,
} from '../constants.js';
import { canonicalJson } from '../ids.js';
import { graphDir, nodeFilePath } from '../paths.js';
import type {
  EdgeType,
  ElementStatus,
  Evidence,
  ExtractorInfo,
  GraphEdge,
  GraphNode,
  Locator,
  NodeType,
  SourceType,
} from '../types.js';

// ---------------------------------------------------------------------------
// Canonical form builders (plain objects with keys in canonical order)
// ---------------------------------------------------------------------------

function compareStrings(a: string, b: string): number {
  // Default (code-unit) order, same as Array.prototype.sort() without comparator.
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Recursively sort object keys alphabetically; drop undefined values. */
function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeysDeep);
  if (value !== null && typeof value === 'object') {
    const rec = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec).sort(compareStrings)) {
      if (rec[key] !== undefined) out[key] = sortKeysDeep(rec[key]);
    }
    return out;
  }
  return value;
}

/** Locator keys in the per-source-type canonical order; unknown keys after, alphabetical. */
function canonicalLocator(locator: Locator, sourceType: SourceType): Record<string, unknown> {
  const rec = locator as Record<string, unknown>;
  const known: readonly string[] = LOCATOR_KEY_ORDER[sourceType] ?? [];
  const out: Record<string, unknown> = {};
  for (const key of known) {
    if (rec[key] !== undefined) out[key] = sortKeysDeep(rec[key]);
  }
  for (const key of Object.keys(rec)
    .filter((k) => !known.includes(k))
    .sort(compareStrings)) {
    if (rec[key] !== undefined) out[key] = sortKeysDeep(rec[key]);
  }
  return out;
}

function canonicalExtractor(extractor: ExtractorInfo): Record<string, unknown> {
  const rec = extractor as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of EXTRACTOR_KEY_ORDER) {
    if (rec[key] !== undefined) out[key] = rec[key];
  }
  return out;
}

/** Evidence keys in EVIDENCE_KEY_ORDER; undefined keys omitted. */
function canonicalEvidence(ev: Evidence): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of EVIDENCE_KEY_ORDER) {
    const value = (ev as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (key === 'locator') out.locator = canonicalLocator(ev.locator, ev.source_type);
    else if (key === 'extractor') out.extractor = canonicalExtractor(ev.extractor!);
    else out[key] = value;
  }
  return out;
}

/** Evidence lists sorted by (source_type, canonicalJson(locator), excerpt). */
function canonicalEvidenceList(list: Evidence[]): Record<string, unknown>[] {
  return [...list]
    .sort(
      (a, b) =>
        compareStrings(a.source_type, b.source_type) ||
        compareStrings(canonicalJson(a.locator), canonicalJson(b.locator)) ||
        compareStrings(a.excerpt, b.excerpt),
    )
    .map(canonicalEvidence);
}

/** Edge keys in EDGE_KEY_ORDER; empty attrs/evidence omitted. */
function canonicalEdge(edge: GraphEdge): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of EDGE_KEY_ORDER) {
    switch (key) {
      case 'attrs':
        if (edge.attrs && Object.keys(edge.attrs).length > 0) {
          out.attrs = sortKeysDeep(edge.attrs);
        }
        break;
      case 'evidence':
        if (edge.evidence.length > 0) out.evidence = canonicalEvidenceList(edge.evidence);
        break;
      default:
        out[key] = edge[key];
    }
  }
  return out;
}

/**
 * Frontmatter with keys in NODE_KEY_ORDER; aliases/attrs/evidence/edges
 * omitted when empty; type, name, status, schema_version always present.
 * The id is the file name and never appears here.
 */
function canonicalFrontmatter(node: GraphNode): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of NODE_KEY_ORDER) {
    switch (key) {
      case 'aliases': {
        const aliases = [...new Set(node.aliases)].sort();
        if (aliases.length > 0) out.aliases = aliases;
        break;
      }
      case 'attrs':
        if (node.attrs && Object.keys(node.attrs).length > 0) {
          out.attrs = sortKeysDeep(node.attrs);
        }
        break;
      case 'evidence':
        if (node.evidence.length > 0) out.evidence = canonicalEvidenceList(node.evidence);
        break;
      case 'edges': {
        if (node.edges.length > 0) {
          out.edges = [...node.edges]
            .sort((a, b) => compareStrings(a.type, b.type) || compareStrings(a.target, b.target))
            .map(canonicalEdge);
        }
        break;
      }
      default:
        out[key] = node[key];
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// YAML emission — byte-deterministic
// ---------------------------------------------------------------------------

/**
 * Fixed YAML formatting: 2-space indent, block style, no line wrapping,
 * plain strings quoted (double) only when YAML requires it — except excerpt
 * values, which are always double-quoted (they are literal source fragments).
 */
function toCanonicalYaml(value: Record<string, unknown>): string {
  const doc = new Document(value);
  visit(doc, {
    Pair(_key, pair) {
      if (
        isScalar(pair.key) &&
        pair.key.value === 'excerpt' &&
        isScalar(pair.value) &&
        typeof pair.value.value === 'string'
      ) {
        pair.value.type = Scalar.QUOTE_DOUBLE;
      }
    },
  });
  return doc.toString({
    indent: 2,
    lineWidth: 0,
    minContentWidth: 0,
    singleQuote: false,
    defaultKeyType: 'PLAIN',
    defaultStringType: 'PLAIN',
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Canonical markdown for a node: YAML frontmatter + body (= description). */
export function serializeNodeFile(node: GraphNode): string {
  const yamlText = toCanonicalYaml(canonicalFrontmatter(node));
  const description = node.description.trim();
  if (description.length === 0) return `---\n${yamlText}---\n`;
  // Exactly one blank line after the closing ---, then the description,
  // then a single trailing newline.
  return `---\n${yamlText}---\n\n${description}\n`;
}

function parseEvidenceList(value: unknown): Evidence[] {
  if (!Array.isArray(value)) return [];
  return value as Evidence[];
}

function parseEdges(value: unknown): GraphEdge[] {
  if (!Array.isArray(value)) return [];
  return value.map((raw) => {
    const rec = raw as Record<string, unknown>;
    const edge: GraphEdge = {
      type: rec.type as EdgeType,
      target: rec.target as string,
      confidence: typeof rec.confidence === 'number' ? rec.confidence : 0,
      status: (rec.status as ElementStatus | undefined) ?? 'active',
      evidence: parseEvidenceList(rec.evidence),
    };
    if (
      rec.attrs !== null &&
      typeof rec.attrs === 'object' &&
      Object.keys(rec.attrs as object).length > 0
    ) {
      edge.attrs = rec.attrs as Record<string, unknown>;
    }
    return edge;
  });
}

/** Inverse of serializeNodeFile; the id comes from the file name. */
export function parseNodeFile(content: string, id: string): GraphNode {
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
  if (!match) {
    throw new Error(`Node file for "${id}" is missing YAML frontmatter delimited by ---`);
  }
  const fm = parseYaml(match[1]) as Record<string, unknown> | null;
  if (fm === null || typeof fm !== 'object' || Array.isArray(fm)) {
    throw new Error(`Node file for "${id}" has invalid frontmatter (expected a YAML mapping)`);
  }
  if (typeof fm.type !== 'string' || typeof fm.name !== 'string') {
    throw new Error(`Node file for "${id}" is missing required frontmatter keys "type"/"name"`);
  }
  return {
    id,
    type: fm.type as NodeType,
    name: fm.name,
    description: match[2].trim(),
    aliases: Array.isArray(fm.aliases) ? (fm.aliases as string[]) : [],
    status: (fm.status as ElementStatus | undefined) ?? 'active',
    attrs:
      fm.attrs !== null && typeof fm.attrs === 'object' && !Array.isArray(fm.attrs)
        ? (fm.attrs as Record<string, unknown>)
        : {},
    evidence: parseEvidenceList(fm.evidence),
    edges: parseEdges(fm.edges),
    schema_version: typeof fm.schema_version === 'number' ? fm.schema_version : SCHEMA_VERSION,
  };
}

/** Read a node file; the id is the basename without .md. */
export function readNodeFile(filePath: string): GraphNode {
  const id = basename(filePath).replace(/\.md$/, '');
  return parseNodeFile(readFileSync(filePath, 'utf8'), id);
}

/**
 * Write graph/<type>/<id>.md (creating directories), returning the absolute
 * path. Skips the write when the file already has identical bytes, so an
 * unchanged re-extraction never touches mtimes or git status.
 */
export function writeNodeFile(repoRoot: string, node: GraphNode): string {
  const filePath = nodeFilePath(repoRoot, node.type, node.id);
  const content = serializeNodeFile(node);
  if (existsSync(filePath) && readFileSync(filePath, 'utf8') === content) {
    return filePath;
  }
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

/** Remove a node file; a no-op when the file does not exist. */
export function deleteNodeFile(repoRoot: string, node: { type: NodeType; id: string }): void {
  const filePath = nodeFilePath(repoRoot, node.type, node.id);
  if (existsSync(filePath)) unlinkSync(filePath);
}

/** Absolute paths of all graph/**\/*.md node files, sorted. */
export function listNodeFiles(repoRoot: string): string[] {
  const root = graphDir(repoRoot);
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.md')) out.push(entryPath);
    }
  };
  walk(root);
  return out.sort(compareStrings);
}

/** Load every node file under graph/ into an id → node map. */
export function loadGraph(repoRoot: string): Map<string, GraphNode> {
  const nodes = new Map<string, GraphNode>();
  for (const filePath of listNodeFiles(repoRoot)) {
    const node = readNodeFile(filePath);
    nodes.set(node.id, node);
  }
  return nodes;
}
