/**
 * Ontology diff (docs/03 §5): drift == git diff between two states of the
 * graph repo, presented in ontology terms — nodes and edges added / removed /
 * changed — never as YAML lines.
 *
 * A graph state is the set of node files under graph/ at a git ref (or in
 * the working tree), parsed with the canonical serializer into id → node
 * maps. Comparison rules:
 *
 * - nodes: added/removed by id; `changed` when name, status, description,
 *   aliases or attrs differ (`fields` lists which). Edge-only changes do NOT
 *   mark the node changed.
 * - edges: keyed by (sourceId, type, target); added/removed; `changed` when
 *   confidence or status differ, with before/after carrying only the changed
 *   fields.
 * - deterministic ordering: nodes by id; edges by (sourceId, type, target).
 */

import { gitListFilesAtRef, gitRevParse, gitShowFile } from '../git.js';
import { canonicalJson } from '../ids.js';
import { GRAPH_DIR } from '../paths.js';
import { loadGraph, parseNodeFile } from '../serializer/index.js';
import type { EdgeChange, GraphDiff, GraphEdge, GraphNode, NodeChange } from '../types.js';

/** ref_b label used by diffWorkingTree for the uncommitted state. */
export const WORKING_TREE_LABEL = 'worktree';

// ---------------------------------------------------------------------------
// Graph state loading
// ---------------------------------------------------------------------------

/** Parse every graph/<type>/<id>.md present at `ref` into an id → node map. */
function loadGraphAtRef(repoRoot: string, ref: string): Map<string, GraphNode> {
  const nodes = new Map<string, GraphNode>();
  for (const path of gitListFilesAtRef(repoRoot, ref, GRAPH_DIR)) {
    if (!path.endsWith('.md')) continue;
    const content = gitShowFile(repoRoot, ref, path);
    if (content === null) continue; // listed but unreadable — cannot happen in practice
    const id = path.slice(path.lastIndexOf('/') + 1, -'.md'.length);
    const node = parseNodeFile(content, id);
    nodes.set(node.id, node);
  }
  return nodes;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/** Order-insensitive, duplicate-insensitive canonical form of an alias list. */
function canonicalAliases(aliases: string[]): string {
  return JSON.stringify([...new Set(aliases)].sort());
}

/** Which of the node-identity fields differ (edges excluded by design). */
function changedNodeFields(a: GraphNode, b: GraphNode): string[] {
  const fields: string[] = [];
  if (a.name !== b.name) fields.push('name');
  if (a.status !== b.status) fields.push('status');
  if (a.description !== b.description) fields.push('description');
  if (canonicalAliases(a.aliases) !== canonicalAliases(b.aliases)) fields.push('aliases');
  if (canonicalJson(a.attrs ?? {}) !== canonicalJson(b.attrs ?? {})) fields.push('attrs');
  return fields;
}

interface OwnedEdge {
  sourceId: string;
  edge: GraphEdge;
}

/**
 * Flatten all outgoing edges of a graph state into a map keyed by
 * (sourceId, type, target). NUL separators keep the key-sort equal to the
 * tuple sort.
 */
function collectEdges(nodes: Map<string, GraphNode>): Map<string, OwnedEdge> {
  const out = new Map<string, OwnedEdge>();
  for (const node of nodes.values()) {
    for (const edge of node.edges) {
      out.set(`${node.id}\u0000${edge.type}\u0000${edge.target}`, { sourceId: node.id, edge });
    }
  }
  return out;
}

function compareGraphs(
  a: Map<string, GraphNode>,
  b: Map<string, GraphNode>,
): { nodes: NodeChange[]; edges: EdgeChange[] } {
  const nodes: NodeChange[] = [];
  const nodeIds = [...new Set([...a.keys(), ...b.keys()])].sort();
  for (const id of nodeIds) {
    const na = a.get(id);
    const nb = b.get(id);
    if (na !== undefined && nb === undefined) {
      nodes.push({ id, type: na.type, kind: 'removed' });
    } else if (na === undefined && nb !== undefined) {
      nodes.push({ id, type: nb.type, kind: 'added' });
    } else if (na !== undefined && nb !== undefined) {
      const fields = changedNodeFields(na, nb);
      if (fields.length > 0) nodes.push({ id, type: nb.type, kind: 'changed', fields });
    }
  }

  const ea = collectEdges(a);
  const eb = collectEdges(b);
  const edges: EdgeChange[] = [];
  const edgeKeys = [...new Set([...ea.keys(), ...eb.keys()])].sort();
  for (const key of edgeKeys) {
    const va = ea.get(key);
    const vb = eb.get(key);
    if (va !== undefined && vb === undefined) {
      edges.push({
        sourceId: va.sourceId,
        type: va.edge.type,
        target: va.edge.target,
        kind: 'removed',
      });
    } else if (va === undefined && vb !== undefined) {
      edges.push({
        sourceId: vb.sourceId,
        type: vb.edge.type,
        target: vb.edge.target,
        kind: 'added',
      });
    } else if (va !== undefined && vb !== undefined) {
      const before: NonNullable<EdgeChange['before']> = {};
      const after: NonNullable<EdgeChange['after']> = {};
      if (va.edge.confidence !== vb.edge.confidence) {
        before.confidence = va.edge.confidence;
        after.confidence = vb.edge.confidence;
      }
      if (va.edge.status !== vb.edge.status) {
        before.status = va.edge.status;
        after.status = vb.edge.status;
      }
      if (Object.keys(after).length > 0) {
        edges.push({
          sourceId: vb.sourceId,
          type: vb.edge.type,
          target: vb.edge.target,
          kind: 'changed',
          before,
          after,
        });
      }
    }
  }

  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Graph state at refA vs refB (git refs of the graph repo). */
export function diffRefs(repoRoot: string, refA: string, refB: string): GraphDiff {
  // Fail fast with git's own "unknown revision" error before parsing anything.
  gitRevParse(repoRoot, refA);
  gitRevParse(repoRoot, refB);
  const { nodes, edges } = compareGraphs(
    loadGraphAtRef(repoRoot, refA),
    loadGraphAtRef(repoRoot, refB),
  );
  return { ref_a: refA, ref_b: refB, nodes, edges };
}

/** Graph state at `ref` (default HEAD) vs the current working-tree files. */
export function diffWorkingTree(repoRoot: string, ref = 'HEAD'): GraphDiff {
  gitRevParse(repoRoot, ref);
  const { nodes, edges } = compareGraphs(loadGraphAtRef(repoRoot, ref), loadGraph(repoRoot));
  return { ref_a: ref, ref_b: WORKING_TREE_LABEL, nodes, edges };
}

// ---------------------------------------------------------------------------
// Human presentation — ontology terms, not YAML lines
// ---------------------------------------------------------------------------

function countByKind(changes: readonly { kind: string }[]): Record<string, number> {
  const counts: Record<string, number> = { added: 0, removed: 0, changed: 0 };
  for (const change of changes) counts[change.kind] = (counts[change.kind] ?? 0) + 1;
  return counts;
}

function formatNodeChange(change: NodeChange): string {
  const ref = `${change.type}/${change.id}`;
  switch (change.kind) {
    case 'added':
      return `+ node ${ref} (added)`;
    case 'removed':
      return `- node ${ref} (removed)`;
    case 'changed':
      return `~ node ${ref} (changed: ${(change.fields ?? []).join(', ')})`;
  }
}

function formatEdgeChange(change: EdgeChange): string {
  const label = `${change.sourceId} -${change.type}-> ${change.target}`;
  switch (change.kind) {
    case 'added':
      return `+ edge ${label} (added)`;
    case 'removed':
      return `- edge ${label} (removed)`;
    case 'changed': {
      const parts: string[] = [];
      const before = change.before ?? {};
      const after = change.after ?? {};
      if (before.confidence !== undefined || after.confidence !== undefined) {
        parts.push(`confidence ${before.confidence} -> ${after.confidence}`);
      }
      if (before.status !== undefined || after.status !== undefined) {
        parts.push(`status ${before.status} -> ${after.status}`);
      }
      return `~ edge ${label}: ${parts.join(', ')}`;
    }
  }
}

/**
 * Readable presentation of a GraphDiff: a counts summary line first, then a
 * nodes section and an edges section (each omitted when empty).
 */
export function formatDiffText(diff: GraphDiff): string {
  const header = `graph diff ${diff.ref_a}..${diff.ref_b}`;
  if (diff.nodes.length === 0 && diff.edges.length === 0) {
    return `${header}: no changes\n`;
  }
  const n = countByKind(diff.nodes);
  const e = countByKind(diff.edges);
  const summary =
    `${header}: ` +
    `nodes ${n.added} added, ${n.removed} removed, ${n.changed} changed; ` +
    `edges ${e.added} added, ${e.removed} removed, ${e.changed} changed`;

  const lines: string[] = [summary];
  if (diff.nodes.length > 0) {
    lines.push('', 'nodes:');
    for (const change of diff.nodes) lines.push(formatNodeChange(change));
  }
  if (diff.edges.length > 0) {
    lines.push('', 'edges:');
    for (const change of diff.edges) lines.push(formatEdgeChange(change));
  }
  return `${lines.join('\n')}\n`;
}
