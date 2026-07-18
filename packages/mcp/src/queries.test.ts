import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GraphIndex, HashEmbeddingProvider, importBatch, initGraphRepo } from '@untacit/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { conflictsQuery, contextQuery, diffQuery, evidenceQuery, exploreQuery } from './queries.js';

const here = dirname(fileURLToPath(import.meta.url));
const BATCHES = join(here, '../../../examples/acme-manufactura/batches');

let repo: string;
let index: GraphIndex;

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'untacit-mcp-'));
  initGraphRepo(repo);
  for (const file of ['01-code.json', '02-docs.json', '03-interview.json']) {
    const batch = JSON.parse(readFileSync(join(BATCHES, file), 'utf8')) as unknown;
    await importBatch(repo, batch, { now: new Date('2026-07-14T12:00:00Z') });
  }
  index = GraphIndex.open(repo);
}, 60_000);

afterAll(() => {
  index?.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('contextQuery', () => {
  it('seeds by lexical retrieval and expands the neighborhood', async () => {
    const result = await contextQuery(index, 'prepago');
    const seedIds = result.nodes.filter((n) => n.seed).map((n) => n.id);
    expect(seedIds).toContain('rule-bloqueo-de-pedido-sin-prepago');
    const expandedIds = result.nodes.filter((n) => !n.seed).map((n) => n.id);
    expect(expandedIds).toContain('process-alta-de-pedido');
    expect(result.edges.length).toBeGreaterThan(0);
  });

  it('fuses the semantic channel when an embedding provider is available', async () => {
    const provider = new HashEmbeddingProvider();
    const result = await contextQuery(index, 'bloqueo de pedido sin prepago', {
      embeddings: provider,
    });
    const seeds = result.nodes.filter((n) => n.seed);
    expect(seeds[0]?.id).toBe('rule-bloqueo-de-pedido-sin-prepago');
    // The provider populated the vector cache incrementally on first use.
    expect(index.nodeVectors(provider.name).size).toBeGreaterThan(0);
  });

  it('filters seeds by node type', async () => {
    const result = await contextQuery(index, 'facturación', { nodeTypes: ['process'] });
    expect(result.nodes.filter((n) => n.seed).every((n) => n.type === 'process')).toBe(true);
  });

  it('returns empty for nonsense queries', async () => {
    const result = await contextQuery(index, 'zanahoria cuántica');
    expect(result.nodes).toHaveLength(0);
  });
});

describe('exploreQuery', () => {
  it('returns node detail plus typed neighborhood with confidences', () => {
    const result = exploreQuery(index, 'rule-bloqueo-de-pedido-sin-prepago');
    expect(result?.node.name).toBe('Bloqueo de pedido sin prepago');
    const validates = result?.neighborhood.edges.find(
      (e) => e.type === 'VALIDATES' && e.targetId === 'process-alta-de-pedido',
    );
    expect(validates?.confidence).toBe(0.99);
  });

  it('is undefined for unknown nodes', () => {
    expect(exploreQuery(index, 'rule-inexistente')).toBeUndefined();
  });
});

describe('evidenceQuery', () => {
  it('returns the multi-source provenance of a node', () => {
    const result = evidenceQuery(index, 'rule-bloqueo-de-pedido-sin-prepago');
    const types = new Set(result.items.map((i) => i.evidence.source_type));
    expect(types).toContain('code');
    expect(result.items.some((i) => i.evidence.validated_by === 'administracion')).toBe(true);
  });
});

describe('conflictsQuery', () => {
  it('finds the two designed contradictions with opposing evidence', () => {
    const conflicts = conflictsQuery(index);
    expect(conflicts).toHaveLength(2);
    for (const conflict of conflicts) {
      expect(conflict.supporting.length).toBeGreaterThan(0);
      expect(conflict.contradicting.length).toBeGreaterThan(0);
    }
  });
});

describe('diffQuery', () => {
  it('defaults to the last two run commits and reports drift in ontology terms', () => {
    const diff = diffQuery(repo);
    // Last two commits: docs import -> interview import.
    expect(diff.nodes.filter((n) => n.kind === 'added').map((n) => n.id)).toContain('role-gerencia');
    expect(diff.edges.length).toBeGreaterThan(0);
  });
});
