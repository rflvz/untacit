import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GraphIndex, HashEmbeddingProvider, importBatch, initGraphRepo, loadConfig, saveConfig } from '@untacit/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  conflictsQuery,
  contextQuery,
  diffQuery,
  evidenceQuery,
  exploreQuery,
  pathsQuery,
  similarQuery,
} from './queries.js';

const here = dirname(fileURLToPath(import.meta.url));
const BATCHES = join(here, '../../../examples/acme-manufactura/batches');

let repo: string;
let index: GraphIndex;

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'untacit-mcp-'));
  initGraphRepo(repo);
  // Hermetic tests: pin embeddings off so imports never resolve 'auto' to
  // the local multilingual model (a download at test time).
  saveConfig(repo, { ...loadConfig(repo), embeddings: { provider: 'none' } });
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
    // The governed process reaches the result set — as a PRF seed (the
    // expansion term "pedido" recalls it lexically) or by graph expansion.
    expect(result.nodes.map((n) => n.id)).toContain('process-alta-de-pedido');
    expect(result.nodes.some((n) => !n.seed)).toBe(true);
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

  it('tags every node with its retrieval channels and hop distance', async () => {
    const result = await contextQuery(index, 'prepago', {
      embeddings: new HashEmbeddingProvider(),
    });
    for (const node of result.nodes) {
      if (node.seed) {
        expect(node.distance).toBe(0);
        expect(node.channels.length).toBeGreaterThan(0);
        expect(
          node.channels.every(
            (c) =>
              c === 'lexical' ||
              c === 'lexical-prf' ||
              c === 'semantic' ||
              c === 'semantic-multivec',
          ),
        ).toBe(true);
      } else {
        expect(node.distance).toBeGreaterThanOrEqual(1);
        expect(node.channels).toEqual(['graph']);
        expect(node.score).toBeGreaterThan(0);
      }
    }
  });

  it('expands further with a deeper hop budget', async () => {
    const shallow = await contextQuery(index, 'prepago', { depth: 1 });
    const deep = await contextQuery(index, 'prepago', { depth: 2 });
    expect(deep.nodes.length).toBeGreaterThan(shallow.nodes.length);
    expect(Math.max(...deep.nodes.map((n) => n.distance))).toBe(2);
    expect(Math.max(...shallow.nodes.map((n) => n.distance))).toBe(1);
  });

  it('only reports edges of the induced subgraph over returned nodes', async () => {
    const result = await contextQuery(index, 'facturación');
    const ids = new Set(result.nodes.map((n) => n.id));
    for (const edge of result.edges) {
      expect(ids.has(edge.source)).toBe(true);
      expect(ids.has(edge.targetId)).toBe(true);
    }
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

describe('pathsQuery', () => {
  it('ranks evidence chains between two concepts strongest-first', () => {
    const result = pathsQuery(
      index,
      'policy-pago-anticipado-a-clientes-nuevos',
      'process-facturacion-mensual',
    );
    expect(result).toBeDefined();
    expect(result!.paths.length).toBeGreaterThanOrEqual(2);
    for (const path of result!.paths) {
      expect(path.nodes[0]!.id).toBe('policy-pago-anticipado-a-clientes-nuevos');
      expect(path.nodes[path.nodes.length - 1]!.id).toBe('process-facturacion-mensual');
      expect(path.edges.length).toBe(path.nodes.length - 1);
      expect(path.strength).toBeGreaterThan(0);
      expect(path.strength).toBeLessThanOrEqual(1);
    }
    const strengths = result!.paths.map((p) => p.strength);
    expect([...strengths].sort((a, b) => b - a)).toEqual(strengths);
    // The strongest chain runs through the shared Pedido entity (0.99 GOVERNS
    // + 0.99 DEPENDS_ON), not the weaker 0.7 GOVERNS route via reclamaciones.
    expect(result!.paths[0]!.nodes.map((n) => n.id)).toContain('entity-pedido');
  });

  it('respects max_length and reports alternatives as distinct loopless chains', () => {
    const result = pathsQuery(index, 'rule-bloqueo-de-pedido-sin-prepago', 'entity-factura', {
      maxPaths: 5,
      maxLength: 3,
    });
    const keys = result!.paths.map((p) => p.edges.map((e) => e.id).join('|'));
    expect(new Set(keys).size).toBe(keys.length);
    for (const path of result!.paths) {
      expect(path.edges.length).toBeLessThanOrEqual(3);
      expect(new Set(path.nodes.map((n) => n.id)).size).toBe(path.nodes.length);
    }
  });

  it('is undefined for unknown endpoints and empty for disconnected ones', () => {
    expect(pathsQuery(index, 'nope', 'entity-pedido')).toBeUndefined();
    expect(pathsQuery(index, 'entity-pedido', 'nope')).toBeUndefined();
  });
});

describe('similarQuery', () => {
  it('surfaces the structurally overlapping rule as a top similar node', async () => {
    const result = await similarQuery(index, 'rule-bloqueo-de-pedido-sin-prepago', {
      embeddings: new HashEmbeddingProvider(),
    });
    expect(result).toBeDefined();
    const ids = result!.similar.map((n) => n.id);
    // Shares entity-pedido (OPERATES_ON + VALIDATES) with the origin rule.
    expect(ids).toContain('rule-aprobacion-de-gerencia-para-pedidos-altos');
    const overlap = result!.similar.find(
      (n) => n.id === 'rule-aprobacion-de-gerencia-para-pedidos-altos',
    )!;
    expect(overlap.structural).toBeGreaterThan(0);
    expect(overlap.semantic).toBeDefined();
    const scores = result!.similar.map((n) => n.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('works without embeddings by redistributing onto structure + name', async () => {
    const result = await similarQuery(index, 'rule-calculo-de-merma-de-bobina');
    expect(result!.similar.length).toBeGreaterThan(0);
    for (const node of result!.similar) {
      expect(node.semantic).toBeUndefined();
      expect(node.score).toBeGreaterThan(0);
      expect(node.score).toBeLessThanOrEqual(1);
    }
    // Chained through DEPENDS_ON + shared bobina/ERP neighborhood.
    expect(result!.similar.map((n) => n.id)).toContain('rule-asignacion-de-bobina-por-gramaje');
  });

  it('filters candidates by node type', async () => {
    const result = await similarQuery(index, 'process-alta-de-pedido', {
      nodeTypes: ['process'],
    });
    expect(result!.similar.every((n) => n.type === 'process')).toBe(true);
  });

  it('is undefined for unknown nodes', async () => {
    expect(await similarQuery(index, 'rule-inexistente')).toBeUndefined();
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
