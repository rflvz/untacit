/**
 * Write-surface tests: a real MCP client over an in-memory transport pair
 * driving the full graph-write workflow — review queue, merge accept /
 * reject / revert, conflict resolution — against a fixture repo with a
 * pending proposal and an open conflict. Every action must land as a git
 * commit and leave the working tree clean.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as core from '@untacit/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServer } from './index.js';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const WRITE_TOOLS = [
  'untacit_import_batch',
  'untacit_review_queue',
  'untacit_merge_accept',
  'untacit_merge_reject',
  'untacit_merge_revert',
  'untacit_conflict_resolve',
];

const nodeBase = {
  aliases: [],
  status: 'active' as const,
  attrs: {},
  evidence: [],
  edges: [],
  schema_version: core.SCHEMA_VERSION,
};

function makeGraphRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'untacit-mcp-review-'));
  tmpDirs.push(repo);
  core.initGraphRepo(repo);

  const supports = {
    source_type: 'code' as const,
    locator: { repo: 'web-pedidos', path: 'src/pricing.ts', line_start: 10, line_end: 14 },
    excerpt: 'if (urgente) total *= 1.15',
    stance: 'supports' as const,
  };
  const contradicts = {
    source_type: 'document' as const,
    locator: { doc_id: 'circular-2026', section: '2' },
    excerpt: 'El recargo por urgencia queda eliminado.',
    stance: 'contradicts' as const,
  };

  const store = core.GraphStore.load(repo);
  store.upsertNode({
    ...nodeBase,
    id: 'process-alta-pedido',
    type: 'process',
    name: 'Alta de pedido',
    description: 'Registro de un pedido nuevo.',
  });
  store.upsertNode({
    ...nodeBase,
    id: 'rule-recargo-urgente',
    type: 'rule',
    name: 'Recargo por pedido urgente',
    description: 'Los pedidos urgentes llevan un recargo del 15%.',
    edges: [
      {
        type: 'GOVERNS',
        target: 'process/process-alta-pedido',
        confidence: core.computeEdgeConfidence([supports, contradicts]),
        status: 'conflicted',
        evidence: [supports, contradicts],
      },
    ],
  });
  // Duplicate entity pair behind the pending merge proposals.
  store.upsertNode({
    ...nodeBase,
    id: 'entity-cliente',
    type: 'entity',
    name: 'Cliente',
    description: 'Cliente de la empresa.',
  });
  store.upsertNode({
    ...nodeBase,
    id: 'entity-clientes',
    type: 'entity',
    name: 'Clientes',
    description: 'Duplicado provisional de Cliente.',
  });
  store.write();

  core.saveMergesFile(repo, {
    proposals: [
      {
        id: 'prop-accept',
        sourceNodeId: 'entity-clientes',
        targetNodeId: 'entity-cliente',
        mention: 'Clientes',
        score: 0.93,
        status: 'pending',
      },
      {
        id: 'prop-reject',
        sourceNodeId: 'entity-clientes',
        targetNodeId: 'entity-cliente',
        mention: 'Los clientes',
        score: 0.71,
        status: 'pending',
      },
    ],
    merges: [],
  });
  core.gitCommitAll(repo, 'fixture');
  return repo;
}

async function connect(repo: string, opts: { write?: boolean } = {}) {
  const server = createServer(repo, opts);
  const client = new Client({ name: 'test-host', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('write surface over MCP', () => {
  let repo: string;
  let client: Client;

  beforeAll(async () => {
    repo = makeGraphRepo();
    client = await connect(repo, { write: true });
  });

  afterAll(async () => {
    await client.close();
  });

  it('read-only server exposes none of the write tools', async () => {
    const ro = await connect(repo);
    const names = (await ro.listTools()).tools.map((t) => t.name);
    for (const tool of WRITE_TOOLS) expect(names).not.toContain(tool);
    await ro.close();
  });

  it('write server exposes the whole write surface, annotated non-read-only', async () => {
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(WRITE_TOOLS));
    for (const tool of WRITE_TOOLS) {
      const readOnly = tools.find((t) => t.name === tool)!.annotations?.readOnlyHint;
      expect(readOnly).toBe(tool === 'untacit_review_queue');
    }
  });

  it('untacit_review_queue lists pending merges and conflicts with evidence keys', async () => {
    const result = await client.callTool({ name: 'untacit_review_queue', arguments: {} });
    const structured = result.structuredContent as {
      proposals: { id: string }[];
      conflicts: core.Conflict[];
      threshold: number;
    };
    expect(structured.proposals.map((p) => p.id).sort()).toEqual(['prop-accept', 'prop-reject']);
    expect(structured.threshold).toBe(core.DEFAULT_REVIEW_THRESHOLD);
    expect(structured.conflicts).toHaveLength(1);
    const conflict = structured.conflicts[0];
    expect(conflict.nodeId).toBe('rule-recargo-urgente');
    expect(conflict.supporting[0]?.key).toBeTruthy();
    expect(conflict.contradicting[0]?.key).toBeTruthy();
  });

  it('untacit_merge_accept absorbs the node, commits, and is revertible', async () => {
    const result = await client.callTool({
      name: 'untacit_merge_accept',
      arguments: { proposal_id: 'prop-accept', by: 'administracion' },
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      record: { id: string; fromNodeId: string; intoNodeId: string };
      commit: string | null;
    };
    expect(structured.record.fromNodeId).toBe('entity-clientes');
    expect(structured.commit).toBeTruthy();
    expect(core.gitStatusClean(repo)).toBe(true);

    let store = core.GraphStore.load(repo);
    expect(store.getNode('entity-clientes')).toBeUndefined();
    expect(store.getNode('entity-cliente')!.aliases).toContain('Clientes');

    // The accepted merge shows up as revertible in the queue…
    const queue = await client.callTool({ name: 'untacit_review_queue', arguments: {} });
    const revertible = (queue.structuredContent as { revertibleMerges: { id: string }[] }).revertibleMerges;
    expect(revertible.map((m) => m.id)).toContain(structured.record.id);

    // …and reverting restores the absorbed node with its own commit.
    const revert = await client.callTool({
      name: 'untacit_merge_revert',
      arguments: { merge_id: structured.record.id },
    });
    expect(revert.isError).toBeFalsy();
    expect((revert.structuredContent as { commit: string | null }).commit).toBeTruthy();
    store = core.GraphStore.load(repo);
    expect(store.getNode('entity-clientes')).toBeDefined();
    expect(core.gitStatusClean(repo)).toBe(true);
  });

  it('untacit_merge_reject marks the proposal rejected and commits', async () => {
    const result = await client.callTool({
      name: 'untacit_merge_reject',
      arguments: { proposal_id: 'prop-reject', by: 'gerencia' },
    });
    expect(result.isError).toBeFalsy();
    const merges = core.loadMergesFile(repo);
    const proposal = merges.proposals.find((p) => p.id === 'prop-reject')!;
    expect(proposal.status).toBe('rejected');
    expect(proposal.resolved_by).toBe('gerencia');
    expect(core.gitStatusClean(repo)).toBe(true);
  });

  it('untacit_conflict_resolve activates the edge when a supporting evidence wins', async () => {
    const queue = await client.callTool({ name: 'untacit_review_queue', arguments: {} });
    const conflict = (queue.structuredContent as { conflicts: core.Conflict[] }).conflicts[0];

    const result = await client.callTool({
      name: 'untacit_conflict_resolve',
      arguments: {
        node_id: conflict.nodeId,
        edge_type: conflict.edgeType,
        target: conflict.target,
        winner_key: conflict.supporting[0]!.key,
        by: 'gerencia',
      },
    });
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { status: string; commit: string | null };
    expect(structured.status).toBe('active');
    expect(structured.commit).toBeTruthy();

    const store = core.GraphStore.load(repo);
    const edge = store.getNode('rule-recargo-urgente')!.edges.find((e) => e.type === 'GOVERNS')!;
    expect(edge.status).toBe('active');
    expect(core.gitStatusClean(repo)).toBe(true);

    // Resolving again fails cleanly over the wire: the edge is no longer conflicted.
    const again = await client.callTool({
      name: 'untacit_conflict_resolve',
      arguments: {
        node_id: conflict.nodeId,
        edge_type: conflict.edgeType,
        target: conflict.target,
        winner_key: conflict.supporting[0]!.key,
      },
    });
    expect(again.isError).toBe(true);
  });

  it('relays actionable errors for unknown ids instead of crashing the session', async () => {
    const result = await client.callTool({
      name: 'untacit_merge_accept',
      arguments: { proposal_id: 'no-such-proposal' },
    });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain('no-such-proposal');
  });
});
