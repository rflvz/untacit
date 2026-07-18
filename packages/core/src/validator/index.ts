/**
 * Extraction-batch validator — the anti-hallucination gate (docs/02 §8, §3).
 *
 * Extractors only ever emit batches; nothing touches the graph repo before it
 * passes this module. Validation happens in two layers:
 *
 *   1. Structural (JSON Schema, Ajv 2020-12): root shape, then each node and
 *      edge item independently.
 *   2. Semantic (closed ontology): node types, edge types, domain→range
 *      restrictions, mention resolution within the batch, duplicates.
 *
 * Salvage mode: a parseable batch with bad items still yields a `sanitized`
 * batch containing only the surviving items, so the pipeline can import the
 * good parts while every rejection is recorded with an actionable reason.
 * Batches with an incompatible schema_version are rejected outright (docs/02 §11).
 */

import { Ajv2020 } from 'ajv/dist/2020.js';
import type { ErrorObject, ValidateFunction } from 'ajv/dist/2020.js';
import addFormatsExport from 'ajv-formats';

// CJS/ESM interop under NodeNext: the default import of ajv-formats is typed
// as the module namespace; at runtime module.exports is the plugin function
// and also carries itself as `.default`.
const addFormats = addFormatsExport.default;

import type {
  BatchEdge,
  BatchNode,
  ExtractionBatch,
  ExtractorInfo,
  NodeType,
  SourceType,
  ValidationIssue,
  ValidationResult,
} from '../types.js';
import {
  DOMAIN_RANGE,
  EDGE_TYPES,
  MAX_EXCERPT_LENGTH,
  NODE_TYPES,
  PART_OF_SAME_TYPE,
  SCHEMA_VERSION,
} from '../constants.js';
import { slugify } from '../ids.js';

// ---------------------------------------------------------------------------
// JSON Schema (docs/02 §8), tightened: exact enums, excerpt maxLength,
// optional evidence.validated_by, optional root schema_version/extractor.
// ---------------------------------------------------------------------------

const SOURCE_TYPES: readonly SourceType[] = ['code', 'document', 'interview'];
const STANCES = ['supports', 'contradicts'] as const;

const EVIDENCE_DEF: Record<string, unknown> = {
  type: 'object',
  required: ['locator', 'excerpt'],
  properties: {
    locator: { type: 'object' },
    excerpt: { type: 'string', maxLength: MAX_EXCERPT_LENGTH },
    validated_by: { type: ['string', 'null'] },
  },
};

const NODE_ITEM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['mention', 'type', 'name', 'description', 'evidence'],
  properties: {
    mention: {
      type: 'string',
      description: 'Name exactly as it appears in the source',
    },
    candidate_id: {
      type: ['string', 'null'],
      description: 'Canonical id if the extractor believes it recognizes an existing node',
    },
    type: { enum: [...NODE_TYPES] },
    name: { type: 'string' },
    description: { type: 'string' },
    attrs: { type: 'object' },
    evidence: { $ref: '#/$defs/evidence' },
  },
};

const EDGE_ITEM_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['type', 'source_mention', 'target_mention', 'evidence'],
  properties: {
    type: { enum: [...EDGE_TYPES] },
    source_mention: { type: 'string' },
    target_mention: { type: 'string' },
    stance: { enum: [...STANCES], default: 'supports' },
    attrs: { type: 'object' },
    evidence: { $ref: '#/$defs/evidence' },
  },
};

const EXTRACTOR_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['name'],
  properties: {
    name: { type: 'string' },
    model: { type: 'string' },
    prompt_version: { type: 'string' },
  },
};

const ROOT_PROPERTIES: Record<string, unknown> = {
  run_id: { type: 'string' },
  source_type: { enum: [...SOURCE_TYPES] },
  schema_version: { type: 'integer' },
  extractor: EXTRACTOR_SCHEMA,
};

/** The extraction-batch emission contract (docs/02 §8), id "untacit/extraction-batch.v1". */
export const BATCH_JSON_SCHEMA: Record<string, unknown> = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'untacit/extraction-batch.v1',
  type: 'object',
  required: ['run_id', 'source_type', 'nodes', 'edges'],
  properties: {
    ...ROOT_PROPERTIES,
    nodes: { type: 'array', items: NODE_ITEM_SCHEMA },
    edges: { type: 'array', items: EDGE_ITEM_SCHEMA },
  },
  $defs: { evidence: EVIDENCE_DEF },
};

// ---------------------------------------------------------------------------
// Compiled validators (module level, compiled once)
// ---------------------------------------------------------------------------

const ajv = new Ajv2020({ allErrors: true, verbose: true });
addFormats(ajv);

// Registers the public schema and asserts at load time that it is well-formed.
ajv.compile(BATCH_JSON_SCHEMA);

/** Root shape only — items are validated one by one so bad items can be salvaged. */
const validateRoot: ValidateFunction = ajv.compile({
  type: 'object',
  required: ['run_id', 'source_type', 'nodes', 'edges'],
  properties: {
    ...ROOT_PROPERTIES,
    nodes: { type: 'array' },
    edges: { type: 'array' },
  },
});

const validateNodeItem: ValidateFunction = ajv.compile({
  ...NODE_ITEM_SCHEMA,
  $defs: { evidence: EVIDENCE_DEF },
});

const validateEdgeItem: ValidateFunction = ajv.compile({
  ...EDGE_ITEM_SCHEMA,
  $defs: { evidence: EVIDENCE_DEF },
});

// ---------------------------------------------------------------------------
// Ajv error → actionable human message
// ---------------------------------------------------------------------------

function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Dotted field label relative to the validated value, e.g. "evidence.excerpt". */
function fieldLabel(err: ErrorObject): string {
  const parts = err.instancePath.split('/').filter((p) => p.length > 0);
  if (err.keyword === 'required') {
    parts.push(String((err.params as Record<string, unknown>).missingProperty));
  }
  return parts.join('.');
}

/** Slash-separated issue path relative to the validated value, e.g. "evidence/excerpt". */
function issuePath(err: ErrorObject): string {
  const parts = err.instancePath.split('/').filter((p) => p.length > 0);
  if (err.keyword === 'required') {
    parts.push(String((err.params as Record<string, unknown>).missingProperty));
  }
  return parts.join('/');
}

function formatAjvError(err: ErrorObject): string {
  const params = err.params as Record<string, unknown>;
  const field = fieldLabel(err);
  const subject = field === '' ? 'batch' : `"${field}"`;
  switch (err.keyword) {
    case 'required':
      return `missing required field "${field}"`;
    case 'enum': {
      const allowed = (params.allowedValues as unknown[])
        .map((v) => JSON.stringify(v))
        .join(', ');
      return `${subject} must be one of ${allowed}, got ${JSON.stringify(err.data)}`;
    }
    case 'maxLength': {
      const got =
        typeof err.data === 'string' ? ` (got ${err.data.length} characters)` : '';
      return `${subject} exceeds the maximum length of ${String(params.limit)} characters${got}`;
    }
    case 'type': {
      const expected = Array.isArray(params.type)
        ? (params.type as string[]).join(' or ')
        : String(params.type);
      return `${subject} must be of type ${expected}, got ${describeType(err.data)}`;
    }
    default:
      return `${subject} ${err.message ?? 'is invalid'}`;
  }
}

/** One combined, de-duplicated reason string for all Ajv errors of one item. */
function joinAjvErrors(errors: ErrorObject[] | null | undefined): string {
  const messages = new Set<string>();
  for (const err of errors ?? []) {
    messages.add(formatAjvError(err));
  }
  return [...messages].join('; ');
}

// ---------------------------------------------------------------------------
// validateBatch
// ---------------------------------------------------------------------------

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function listTypes(types: readonly NodeType[]): string {
  return types.join(' or ');
}

/** Normalized mention key: trimmed, case- and accent-insensitive (docs/02 §9 step 1). */
function mentionKey(mention: string): string {
  return slugify(mention.trim());
}

interface RootShape {
  run_id: string;
  source_type: SourceType;
  schema_version?: number;
  extractor?: ExtractorInfo;
  nodes: unknown[];
  edges: unknown[];
}

/**
 * Validate an extraction batch against the JSON Schema and the closed
 * ontology (docs/02 §3 domain→range). Returns:
 *
 * - `valid`: true only when there are zero issues of any kind.
 * - `issues`: every rejection with a path ("nodes/3"), an actionable message
 *   and the offending item.
 * - `sanitized`: the batch with only the surviving items — always present when
 *   the root was parseable and the schema_version is compatible, even when
 *   issues exist, so the pipeline can import the good parts while recording
 *   the rejections. Absent for malformed roots and incompatible versions.
 *
 * The input is never mutated; `sanitized` defaults edge stance to "supports".
 */
export function validateBatch(input: unknown): ValidationResult {
  // 1. Root structure (not an object / missing run_id / bad source_type /
  //    nodes-edges not arrays / malformed schema_version or extractor).
  if (!validateRoot(input)) {
    const issues: ValidationIssue[] = (validateRoot.errors ?? []).map((err) => ({
      path: issuePath(err),
      message: formatAjvError(err),
    }));
    return { valid: false, issues };
  }
  const root = input as unknown as RootShape;

  // 2. Schema version compatibility: incompatible batches are rejected
  //    outright, nothing is salvaged (docs/02 §11).
  if (root.schema_version !== undefined && root.schema_version !== SCHEMA_VERSION) {
    return {
      valid: false,
      issues: [
        {
          path: 'schema_version',
          message:
            `incompatible schema_version ${root.schema_version}: this core accepts only ` +
            `schema_version ${SCHEMA_VERSION}; the whole batch is rejected`,
        },
      ],
    };
  }

  const issues: ValidationIssue[] = [];

  // 3a. Nodes — each item validated independently (salvage mode).
  const survivingNodes: BatchNode[] = [];
  /** dedupe key (type + normalized mention) -> index of the first occurrence */
  const firstSeenAt = new Map<string, number>();
  root.nodes.forEach((raw, i) => {
    const path = `nodes/${i}`;
    if (!validateNodeItem(raw)) {
      issues.push({ path, message: joinAjvErrors(validateNodeItem.errors), item: raw });
      return;
    }
    const node = raw as BatchNode;

    const reasons: string[] = [];
    if (node.mention.trim() === '') {
      reasons.push('"mention" must be non-empty after trimming');
    }
    if (node.name.trim() === '') {
      reasons.push('"name" must be non-empty after trimming');
    }
    if (reasons.length > 0) {
      issues.push({ path, message: reasons.join('; '), item: raw });
      return;
    }

    const key = `${node.type}|${mentionKey(node.mention)}`;
    const firstIndex = firstSeenAt.get(key);
    if (firstIndex !== undefined) {
      issues.push({
        path,
        message:
          `duplicate node: same mention "${node.mention}" and type "${node.type}" ` +
          `as nodes/${firstIndex} — dropped, keeping the first occurrence (warning)`,
        item: raw,
      });
      return;
    }
    firstSeenAt.set(key, i);
    survivingNodes.push(node);
  });

  // Mention lookup over SURVIVING nodes only: edges referencing rejected
  // nodes cascade into "unknown mention" rejections.
  const nodesByMention = new Map<string, BatchNode[]>();
  for (const node of survivingNodes) {
    const key = mentionKey(node.mention);
    const list = nodesByMention.get(key);
    if (list) {
      list.push(node);
    } else {
      nodesByMention.set(key, [node]);
    }
  }

  // 3b. Edges — schema, mention resolution, domain→range, PART_OF same-type.
  const survivingEdges: BatchEdge[] = [];
  root.edges.forEach((raw, i) => {
    const path = `edges/${i}`;
    if (!validateEdgeItem(raw)) {
      issues.push({ path, message: joinAjvErrors(validateEdgeItem.errors), item: raw });
      return;
    }
    const edge = raw as BatchEdge;
    const reasons: string[] = [];

    const constraint = DOMAIN_RANGE[edge.type];
    const sourceCandidates = nodesByMention.get(mentionKey(edge.source_mention)) ?? [];
    const targetCandidates = nodesByMention.get(mentionKey(edge.target_mention)) ?? [];

    if (sourceCandidates.length === 0) {
      reasons.push(
        `unknown mention "${edge.source_mention}": source_mention must match a ` +
          `surviving node of this batch (the node may be missing or rejected)`,
      );
    }
    if (targetCandidates.length === 0) {
      reasons.push(
        `unknown mention "${edge.target_mention}": target_mention must match a ` +
          `surviving node of this batch (the node may be missing or rejected)`,
      );
    }

    const sourceTypes = unique(sourceCandidates.map((n) => n.type));
    const targetTypes = unique(targetCandidates.map((n) => n.type));
    const validSourceTypes = sourceTypes.filter((t) => constraint.source.includes(t));
    const validTargetTypes = targetTypes.filter((t) => constraint.target.includes(t));

    if (sourceCandidates.length > 0 && validSourceTypes.length === 0) {
      reasons.push(
        `${edge.type} requires source type ${listTypes(constraint.source)}, ` +
          `got ${listTypes(sourceTypes)}`,
      );
    }
    if (targetCandidates.length > 0 && validTargetTypes.length === 0) {
      reasons.push(
        `${edge.type} requires target type ${listTypes(constraint.target)}, ` +
          `got ${listTypes(targetTypes)}`,
      );
    }

    // PART_OF composes only within one type: process→process or entity→entity.
    if (
      edge.type === 'PART_OF' &&
      PART_OF_SAME_TYPE &&
      validSourceTypes.length > 0 &&
      validTargetTypes.length > 0 &&
      !validSourceTypes.some((t) => validTargetTypes.includes(t))
    ) {
      reasons.push(
        `PART_OF requires source and target of the same type ` +
          `(process→process or entity→entity), got ${listTypes(sourceTypes)} → ` +
          `${listTypes(targetTypes)}`,
      );
    }

    if (reasons.length > 0) {
      issues.push({ path, message: reasons.join('; '), item: raw });
      return;
    }
    // Stance defaults to "supports" (docs/02 §8).
    survivingEdges.push({ ...edge, stance: edge.stance ?? 'supports' });
  });

  // 4. Result: salvaged batch is always present for a parseable, compatible root.
  const sanitized: ExtractionBatch = {
    run_id: root.run_id,
    source_type: root.source_type,
    nodes: survivingNodes,
    edges: survivingEdges,
  };
  if (root.schema_version !== undefined) {
    sanitized.schema_version = root.schema_version;
  }
  if (root.extractor !== undefined) {
    sanitized.extractor = root.extractor;
  }

  return { valid: issues.length === 0, issues, sanitized };
}
