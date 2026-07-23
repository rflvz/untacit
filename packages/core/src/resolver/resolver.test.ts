import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { GraphStore } from '../graph/index.js';
import { nodeFilePath } from '../paths.js';
import type {
  BatchEdge,
  BatchNode,
  ExtractionBatch,
  GraphNode,
  MergeProposal,
  NodeType,
} from '../types.js';
import {
  HashEmbeddingProvider,
  acceptMergeProposal,
  calibratedCosine,
  cosineSimilarity,
  loadMergesFile,
  nameSimilarity,
  rejectMergeProposal,
  resolveBatch,
  revertMerge,
  saveMergesFile,
} from './index.js';
import type { StoredMergeRecord } from './index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpRepo(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'untacit-'));
}

function makeNode(partial: Partial<GraphNode> & { id: string; type: NodeType; name: string }): GraphNode {
  return {
    description: 'Descripción de prueba.',
    aliases: [],
    status: 'active',
    attrs: {},
    evidence: [],
    edges: [],
    schema_version: 1,
    ...partial,
  };
}

function bnode(mention: string, type: NodeType = 'entity', extra: Partial<BatchNode> = {}): BatchNode {
  return {
    mention,
    type,
    name: mention,
    description: 'desc',
    evidence: {
      locator: { repo: 'r', path: 'src/a.ts', line_start: 1, line_end: 2 },
      excerpt: 'x',
    },
    ...extra,
  };
}

function batchOf(nodes: BatchNode[], edges: BatchEdge[] = []): ExtractionBatch {
  return { run_id: '2026-07-14T10-00-00-code', source_type: 'code', nodes, edges };
}

function storeWith(...nodes: GraphNode[]): GraphStore {
  const store = GraphStore.load(tmpRepo());
  for (const node of nodes) store.upsertNode(node);
  return store;
}

const NOW = new Date('2026-07-14T12:00:00.000Z');

// ---------------------------------------------------------------------------
// nameSimilarity
// ---------------------------------------------------------------------------

describe('nameSimilarity', () => {
  it('returns 1 for normalized-equal strings (case, accents, whitespace)', () => {
    expect(nameSimilarity('Pago Anticipado ', 'pago anticipado')).toBe(1);
    expect(nameSimilarity('Facturación', 'facturacion')).toBe(1);
  });

  it('returns 1 for singular/plural token variants via jaccard', () => {
    expect(nameSimilarity('Cliente', 'clientes')).toBe(1);
    expect(nameSimilarity('pedidos urgentes', 'pedido urgente')).toBe(1);
  });

  it('is levenshtein-based for typo variants', () => {
    // "cliyente" vs "cliente": distance 1 over max length 8 → 0.875
    expect(nameSimilarity('cliyente', 'cliente')).toBeCloseTo(0.875, 10);
  });

  it('is low for unrelated names and 0 against empty', () => {
    expect(nameSimilarity('proveedor', 'cliente')).toBeLessThan(0.5);
    expect(nameSimilarity('', 'cliente')).toBe(0);
  });

  it('is symmetric', () => {
    expect(nameSimilarity('pago antiicipado', 'Pago Anticipado')).toBe(
      nameSimilarity('Pago Anticipado', 'pago antiicipado'),
    );
  });
});

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

describe('HashEmbeddingProvider / cosineSimilarity', () => {
  it('is deterministic and l2-normalized', async () => {
    const provider = new HashEmbeddingProvider();
    const [a1] = await provider.embed(['pago anticipado']);
    const [a2] = await provider.embed(['pago anticipado']);
    expect(a1).toEqual(a2);
    expect(a1).toHaveLength(256);
    const norm = Math.sqrt(a1.reduce((s, v) => s + v * v, 0));
    expect(norm).toBeCloseTo(1, 10);
  });

  it('scores similar texts above dissimilar ones', async () => {
    const provider = new HashEmbeddingProvider();
    const [a, b, c] = await provider.embed([
      'entity Cliente cliente habitual',
      'entity Clientes los clientes de la empresa',
      'process Facturación mensual proceso contable',
    ]);
    expect(cosineSimilarity(a, b)).toBeGreaterThan(cosineSimilarity(a, c));
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 10);
  });

  it('cosineSimilarity throws on length mismatch and returns 0 for zero vectors', () => {
    expect(() => cosineSimilarity([1, 0], [1])).toThrow(/length mismatch/);
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// resolveBatch
// ---------------------------------------------------------------------------

describe('resolveBatch', () => {
  it('exact-matches case/accent/plural variants against name and aliases', async () => {
    const store = storeWith(
      makeNode({ id: 'entity-cliente', type: 'entity', name: 'Cliente' }),
      makeNode({
        id: 'process-facturacion',
        type: 'process',
        name: 'Facturación',
        aliases: ['facturación mensual'],
      }),
    );
    const batch = batchOf([
      bnode('clientes'),
      bnode('CLIENTE'),
      bnode('facturacion', 'process'),
      bnode('Facturación Mensual', 'process'),
    ]);
    const { resolutions, proposals } = await resolveBatch(batch, store, { now: NOW });
    expect(proposals).toEqual([]);
    for (const mention of ['clientes', 'CLIENTE']) {
      const d = resolutions.get(mention);
      expect(d).toMatchObject({ action: 'exact-match', nodeId: 'entity-cliente' });
    }
    for (const mention of ['facturacion', 'Facturación Mensual']) {
      const d = resolutions.get(mention);
      expect(d).toMatchObject({ action: 'exact-match', nodeId: 'process-facturacion' });
    }
  });

  it('does not exact-match across node types', async () => {
    const store = storeWith(makeNode({ id: 'entity-cliente', type: 'entity', name: 'Cliente' }));
    const batch = batchOf([bnode('Cliente', 'process')]);
    const { resolutions } = await resolveBatch(batch, store, { now: NOW });
    expect(resolutions.get('Cliente')).toMatchObject({
      action: 'created',
      nodeId: 'process-cliente',
    });
  });

  it('honors candidate_id when it exists with a matching type', async () => {
    const store = storeWith(
      makeNode({ id: 'rule-descuento-volumen', type: 'rule', name: 'Descuento por volumen' }),
    );
    const batch = batchOf([
      bnode('regla de descuentos', 'rule', { candidate_id: 'rule-descuento-volumen' }),
    ]);
    const { resolutions } = await resolveBatch(batch, store, { now: NOW });
    expect(resolutions.get('regla de descuentos')).toMatchObject({
      action: 'exact-match',
      nodeId: 'rule-descuento-volumen',
    });
  });

  it('ignores candidate_id when missing or of the wrong type', async () => {
    const store = storeWith(makeNode({ id: 'entity-cliente', type: 'entity', name: 'Cliente' }));
    const batch = batchOf([
      bnode('Bobina', 'entity', { candidate_id: 'entity-nope' }),
      bnode('Tirada', 'process', { candidate_id: 'entity-cliente' }),
    ]);
    const { resolutions } = await resolveBatch(batch, store, { now: NOW });
    expect(resolutions.get('Bobina')).toMatchObject({ action: 'created', nodeId: 'entity-bobina' });
    expect(resolutions.get('Tirada')).toMatchObject({ action: 'created', nodeId: 'process-tirada' });
  });

  it('fuzzy-resolves typo-ish variants at or above the auto threshold', async () => {
    const store = storeWith(
      makeNode({ id: 'policy-pago-anticipado', type: 'policy', name: 'Pago Anticipado' }),
    );
    // "pago antiicipado": levenshtein 1 over 16 → 0.9375 ≥ 0.92, not an exact key match.
    const batch = batchOf([bnode('pago antiicipado', 'policy')]);
    const { resolutions, proposals } = await resolveBatch(batch, store, { now: NOW });
    expect(proposals).toEqual([]);
    const d = resolutions.get('pago antiicipado');
    expect(d).toMatchObject({ action: 'fuzzy-match', nodeId: 'policy-pago-anticipado' });
    expect(d?.score).toBeGreaterThanOrEqual(0.92);
  });

  it('fuzzy-resolves with an embedding provider in the loop', async () => {
    const store = storeWith(
      makeNode({ id: 'policy-pago-anticipado', type: 'policy', name: 'Pago Anticipado' }),
    );
    const batch = batchOf([bnode('pago antiicipado', 'policy')]);
    const { resolutions } = await resolveBatch(batch, store, {
      now: NOW,
      embeddings: new HashEmbeddingProvider(),
    });
    expect(resolutions.get('pago antiicipado')).toMatchObject({
      action: 'fuzzy-match',
      nodeId: 'policy-pago-anticipado',
    });
  });

  it('calibratedCosine rescales through the provider floor', async () => {
    const provider = new HashEmbeddingProvider();
    const [a, b] = await provider.embed(['pago anticipado', 'pago anticipado']);
    expect(calibratedCosine(a!, b!, 0)).toBeCloseTo(1, 6);
    expect(calibratedCosine(a!, b!, 0.8)).toBeCloseTo(1, 6);
    // A raw cosine at the floor reads as zero similarity; below it clamps.
    expect(calibratedCosine([1, 0], [Math.SQRT1_2, Math.SQRT1_2], 0.8)).toBeCloseTo(0, 6);
    // Halfway between floor and 1 lands at 0.5.
    expect(calibratedCosine([1, 0], [0.9, Math.sqrt(1 - 0.81)], 0.8)).toBeCloseTo(0.5, 6);
  });

  it('a provider similarityFloor keeps high raw cosine from auto-merging', async () => {
    // Two same-type nodes whose vectors are engineered to a raw cosine of
    // ~0.95 — the band where e5-family models place *unrelated* same-domain
    // texts. Without the floor this would fuzzy-match at ≥ auto (0.92).
    const store = storeWith(
      makeNode({ id: 'process-facturacion', type: 'process', name: 'Facturación mensual' }),
    );
    const vec = (angle: number): number[] => [Math.cos(angle), Math.sin(angle)];
    const raw = 0.96;
    const floored = {
      name: 'fake-e5',
      similarityFloor: 0.8,
      embed: async (texts: string[]) => texts.map(() => vec(Math.acos(raw))),
    };
    const nodeVectors = new Map([['process-facturacion', vec(0)]]);
    const batch = batchOf([bnode('Cuadrante de turnos', 'process')]);
    const { resolutions, proposals } = await resolveBatch(batch, store, {
      now: NOW,
      embeddings: floored,
      nodeVectors,
    });
    // (0.96 - 0.8) / 0.2 = 0.8 → inside the gray zone [0.75, 0.92): a
    // proposal is queued for review, but NEVER an automatic merge.
    expect(resolutions.get('Cuadrante de turnos')).toMatchObject({
      action: 'created-provisional',
    });
    expect(proposals).toHaveLength(1);

    // The same vectors without a floor would auto-merge — pinning the danger
    // this calibration exists to prevent.
    const unfloored = { ...floored, name: 'fake-raw', similarityFloor: 0 };
    const again = await resolveBatch(batch, store, {
      now: NOW,
      embeddings: unfloored,
      nodeVectors,
    });
    expect(again.resolutions.get('Cuadrante de turnos')).toMatchObject({
      action: 'fuzzy-match',
      nodeId: 'process-facturacion',
    });
  });

  it('reuses precomputed store-node vectors and embeds only the mentions', async () => {
    const store = storeWith(
      makeNode({ id: 'policy-pago-anticipado', type: 'policy', name: 'Pago Anticipado' }),
      makeNode({ id: 'entity-cliente', type: 'entity', name: 'Cliente' }),
    );
    const inner = new HashEmbeddingProvider();
    const calls: string[][] = [];
    const counting = {
      name: inner.name,
      embed: (texts: string[], kind?: 'query' | 'passage') => {
        calls.push(texts);
        return inner.embed(texts, kind);
      },
    };
    // Precompute vectors for every store node with the same provider+text
    // composition the index uses, then hand them to the resolver.
    const nodeVectors = new Map<string, number[]>();
    for (const node of store.nodes.values()) {
      const [vec] = await inner.embed(
        [[node.type, node.name, ...node.aliases, node.description].join(' ').trim()],
        'passage',
      );
      nodeVectors.set(node.id, vec!);
    }

    const batch = batchOf([bnode('pago antiicipado', 'policy')]);
    const { resolutions } = await resolveBatch(batch, store, {
      now: NOW,
      embeddings: counting,
      nodeVectors,
    });
    expect(resolutions.get('pago antiicipado')).toMatchObject({
      action: 'fuzzy-match',
      nodeId: 'policy-pago-anticipado',
    });
    // One embed call total: the batch mentions. Store nodes came from the cache.
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
  });

  it('gray zone creates a provisional node plus a pending proposal and never merges', async () => {
    const store = storeWith(makeNode({ id: 'entity-cliente', type: 'entity', name: 'Cliente' }));
    // "cliyente" vs "Cliente" → 0.875 ∈ [0.75, 0.92)
    const batch = batchOf([bnode('cliyente')]);
    const { resolutions, proposals } = await resolveBatch(batch, store, { now: NOW });
    const d = resolutions.get('cliyente');
    expect(d?.action).toBe('created-provisional');
    expect(d?.nodeId).toBe('entity-cliyente');
    expect(d?.score).toBeGreaterThanOrEqual(0.75);
    expect(d?.score).toBeLessThan(0.92);
    expect(proposals).toHaveLength(1);
    const proposal = proposals[0];
    expect(proposal).toMatchObject({
      sourceNodeId: 'entity-cliyente',
      targetNodeId: 'entity-cliente',
      mention: 'cliyente',
      status: 'pending',
      created_at: NOW.toISOString(),
    });
    expect(d?.proposalId).toBe(proposal.id);
    // Never merged: the canonical node is untouched, the decision points elsewhere.
    expect(d?.nodeId).not.toBe('entity-cliente');
    expect(store.getNode('entity-cliente')?.aliases).toEqual([]);
  });

  it('creates a new node below the gray threshold', async () => {
    const store = storeWith(makeNode({ id: 'entity-cliente', type: 'entity', name: 'Cliente' }));
    const batch = batchOf([bnode('Proveedor')]);
    const { resolutions, proposals } = await resolveBatch(batch, store, { now: NOW });
    expect(proposals).toEqual([]);
    expect(resolutions.get('Proveedor')).toMatchObject({
      action: 'created',
      nodeId: 'entity-proveedor',
    });
  });

  it('resolves the same unseen mention twice in one batch to a single id', async () => {
    const store = storeWith();
    const batch = batchOf([bnode('Bobina'), bnode('Bobina')]);
    const { resolutions } = await resolveBatch(batch, store, { now: NOW });
    expect(resolutions.size).toBe(1);
    expect(resolutions.get('Bobina')).toMatchObject({ action: 'created', nodeId: 'entity-bobina' });
  });

  it('reuses the id assigned earlier in the batch for normalized-equal mentions', async () => {
    const store = storeWith();
    const batch = batchOf([bnode('Bobina'), bnode('bobinas')]);
    const { resolutions } = await resolveBatch(batch, store, { now: NOW });
    expect(resolutions.get('Bobina')?.nodeId).toBe('entity-bobina');
    expect(resolutions.get('bobinas')).toMatchObject({
      action: 'exact-match',
      nodeId: 'entity-bobina',
    });
  });

  it('suffixes new ids on collision with existing store ids', async () => {
    // Existing node occupies the slug "entity-pago" but its name does not match.
    const store = storeWith(makeNode({ id: 'entity-pago', type: 'entity', name: 'Cosa Distinta' }));
    const batch = batchOf([bnode('Pago')]);
    const { resolutions } = await resolveBatch(batch, store, { now: NOW });
    expect(resolutions.get('Pago')).toMatchObject({ action: 'created', nodeId: 'entity-pago-2' });
  });

  it('suffixes gray-zone provisional ids against the store too', async () => {
    // "Pago" vs "Pagoo": 1 - 1/5 = 0.8 → gray zone; slug collides with the candidate id.
    const store = storeWith(makeNode({ id: 'entity-pago', type: 'entity', name: 'Pagoo' }));
    const batch = batchOf([bnode('Pago')]);
    const { resolutions, proposals } = await resolveBatch(batch, store, { now: NOW });
    const d = resolutions.get('Pago');
    expect(d).toMatchObject({ action: 'created-provisional', nodeId: 'entity-pago-2' });
    expect(proposals[0]).toMatchObject({
      sourceNodeId: 'entity-pago-2',
      targetNodeId: 'entity-pago',
    });
  });

  it('gives decisions to edge mentions not covered by batch nodes (defensive)', async () => {
    const store = storeWith(makeNode({ id: 'entity-cliente', type: 'entity', name: 'Cliente' }));
    const batch = batchOf(
      [bnode('Regla X', 'rule')],
      [
        {
          type: 'OPERATES_ON',
          source_mention: 'Regla X',
          target_mention: 'clientes',
          evidence: {
            locator: { repo: 'r', path: 'src/a.ts', line_start: 3, line_end: 4 },
            excerpt: 'y',
          },
        },
      ],
    );
    const { resolutions } = await resolveBatch(batch, store, { now: NOW });
    expect(resolutions.get('Regla X')).toMatchObject({ action: 'created', nodeId: 'rule-regla-x' });
    expect(resolutions.get('clientes')).toMatchObject({
      action: 'exact-match',
      nodeId: 'entity-cliente',
    });
  });

  it('respects custom thresholds', async () => {
    const store = storeWith(makeNode({ id: 'entity-cliente', type: 'entity', name: 'Cliente' }));
    const batch = batchOf([bnode('cliyente')]); // score 0.875
    const { resolutions } = await resolveBatch(batch, store, {
      now: NOW,
      thresholds: { auto: 0.85, gray: 0.5 },
    });
    expect(resolutions.get('cliyente')).toMatchObject({
      action: 'fuzzy-match',
      nodeId: 'entity-cliente',
    });
  });
});

// ---------------------------------------------------------------------------
// merges.json
// ---------------------------------------------------------------------------

function proposalOf(extra: Partial<MergeProposal> = {}): MergeProposal {
  return {
    id: 'prop-b',
    sourceNodeId: 'entity-b',
    targetNodeId: 'entity-a',
    mention: 'b',
    score: 0.8,
    status: 'pending',
    created_at: NOW.toISOString(),
    ...extra,
  };
}

describe('merges file', () => {
  it('loadMergesFile returns empty defaults when the file is missing', () => {
    const repo = tmpRepo();
    expect(loadMergesFile(repo)).toEqual({ proposals: [], merges: [] });
  });

  it('save/load round-trips and is deterministic (sorted, 2-space indent, trailing newline)', () => {
    const repo = tmpRepo();
    const data = {
      proposals: [proposalOf({ id: 'zz-prop' }), proposalOf({ id: 'aa-prop' })],
      merges: [
        { id: 'zz-merge', fromNodeId: 'entity-b', intoNodeId: 'entity-a' },
        { id: 'aa-merge', fromNodeId: 'entity-c', intoNodeId: 'entity-a' },
      ],
    };
    saveMergesFile(repo, data);
    const first = readFileSync(path.join(repo, 'merges.json'), 'utf8');
    expect(first.endsWith('\n')).toBe(true);
    expect(first).toContain('  "proposals"');
    const loaded = loadMergesFile(repo);
    expect(loaded.proposals.map((p) => p.id)).toEqual(['aa-prop', 'zz-prop']);
    expect(loaded.merges.map((m) => m.id)).toEqual(['aa-merge', 'zz-merge']);
    // Saving what was loaded (already sorted) is byte-identical.
    saveMergesFile(repo, loaded);
    expect(readFileSync(path.join(repo, 'merges.json'), 'utf8')).toBe(first);
    // Saving the original unsorted input again is byte-identical too.
    saveMergesFile(repo, data);
    expect(readFileSync(path.join(repo, 'merges.json'), 'utf8')).toBe(first);
  });

  it('rejectMergeProposal marks the proposal rejected and persists', () => {
    const repo = tmpRepo();
    saveMergesFile(repo, { proposals: [proposalOf({ id: 'p1' })], merges: [] });
    rejectMergeProposal(repo, 'p1', 'admin');
    const { proposals } = loadMergesFile(repo);
    expect(proposals[0]).toMatchObject({ id: 'p1', status: 'rejected', resolved_by: 'admin' });
    expect(proposals[0].resolved_at).toBeTruthy();
    expect(() => rejectMergeProposal(repo, 'p1')).toThrow(/already rejected/);
    expect(() => rejectMergeProposal(repo, 'missing')).toThrow(/not found/);
  });
});

// ---------------------------------------------------------------------------
// accept + revert merge round-trip
// ---------------------------------------------------------------------------

describe('acceptMergeProposal / revertMerge', () => {
  function setupMergeScenario() {
    const store = GraphStore.load(tmpRepo());
    const evidence = {
      source_type: 'code' as const,
      locator: { repo: 'r', path: 'src/checkout.ts', line_start: 84, line_end: 91 },
      excerpt: 'if (customer.isNew && !order.prepaid) reject()',
      stance: 'supports' as const,
    };
    const target = makeNode({
      id: 'entity-cliente',
      type: 'entity',
      name: 'Cliente',
      evidence: [evidence],
    });
    const source = makeNode({
      id: 'entity-cliente-nuevo',
      type: 'entity',
      name: 'Cliente Nuevo',
      aliases: ['clientes de nueva incorporación'],
      evidence: [
        {
          ...evidence,
          locator: { doc_id: 'manual', section: '4.2' },
          source_type: 'document' as const,
        },
      ],
      edges: [
        {
          type: 'PART_OF',
          target: 'entity/entity-cartera',
          confidence: 0.9,
          status: 'active',
          evidence: [evidence],
        },
      ],
    });
    const other = makeNode({ id: 'entity-cartera', type: 'entity', name: 'Cartera' });
    const rule = makeNode({
      id: 'rule-prepago',
      type: 'rule',
      name: 'Bloqueo sin prepago',
      edges: [
        {
          type: 'OPERATES_ON',
          target: 'entity/entity-cliente-nuevo',
          confidence: 0.9,
          status: 'active',
          evidence: [evidence],
        },
      ],
    });
    store.upsertNode(target);
    store.upsertNode(source);
    store.upsertNode(other);
    store.upsertNode(rule);
    store.write();
    const proposal = proposalOf({
      id: 'prop-cliente-nuevo',
      sourceNodeId: 'entity-cliente-nuevo',
      targetNodeId: 'entity-cliente',
      mention: 'cliente nuevo',
      score: 0.85,
    });
    saveMergesFile(store.repoRoot, { proposals: [proposal], merges: [] });
    return { store, sourceSnapshot: structuredClone(source) };
  }

  it('accept moves aliases/evidence/edges, rewires inbound edges, deletes the source', () => {
    const { store } = setupMergeScenario();
    const record = acceptMergeProposal(store, 'prop-cliente-nuevo', 'rafa') as StoredMergeRecord;

    expect(record.fromNodeId).toBe('entity-cliente-nuevo');
    expect(record.intoNodeId).toBe('entity-cliente');
    expect(record.approved_by).toBe('rafa');
    expect(record.from_snapshot?.id).toBe('entity-cliente-nuevo');
    expect(record.rewired).toEqual([
      {
        nodeId: 'rule-prepago',
        edgeType: 'OPERATES_ON',
        from: 'entity/entity-cliente-nuevo',
        to: 'entity/entity-cliente',
      },
    ]);

    // Source gone from store and disk.
    expect(store.getNode('entity-cliente-nuevo')).toBeUndefined();
    expect(existsSync(nodeFilePath(store.repoRoot, 'entity', 'entity-cliente-nuevo'))).toBe(false);

    // Target absorbed aliases, evidence, outgoing edges.
    const target = store.getNode('entity-cliente')!;
    expect(target.aliases).toEqual(['Cliente Nuevo', 'clientes de nueva incorporación']);
    expect(target.evidence).toHaveLength(2);
    expect(target.edges).toHaveLength(1);
    expect(target.edges[0]).toMatchObject({ type: 'PART_OF', target: 'entity/entity-cartera' });

    // Inbound edge rewired.
    const rule = store.getNode('rule-prepago')!;
    expect(rule.edges[0].target).toBe('entity/entity-cliente');

    // Persisted: proposal accepted, record on disk.
    const file = loadMergesFile(store.repoRoot);
    expect(file.proposals[0]).toMatchObject({ status: 'accepted', resolved_by: 'rafa' });
    expect(file.merges).toHaveLength(1);
    expect(file.merges[0].id).toBe(record.id);

    // Double-accept fails.
    expect(() => acceptMergeProposal(store, 'prop-cliente-nuevo')).toThrow(/already accepted/);
  });

  it('revert restores the snapshot node and the rewired inbound edges', () => {
    const { store, sourceSnapshot } = setupMergeScenario();
    const record = acceptMergeProposal(store, 'prop-cliente-nuevo', 'rafa');

    revertMerge(store, record.id);

    // Snapshot restored byte-for-byte.
    expect(store.getNode('entity-cliente-nuevo')).toEqual(sourceSnapshot);
    // Inbound edge points back to the restored node.
    expect(store.getNode('rule-prepago')!.edges[0].target).toBe('entity/entity-cliente-nuevo');
    // Record marked reverted and persisted.
    const file = loadMergesFile(store.repoRoot);
    expect((file.merges[0] as StoredMergeRecord).reverted_at).toBeTruthy();
    // Restored node file re-materializes on write().
    store.write();
    expect(existsSync(nodeFilePath(store.repoRoot, 'entity', 'entity-cliente-nuevo'))).toBe(true);
    // A second revert fails.
    expect(() => revertMerge(store, record.id)).toThrow(/already reverted/);
  });

  it('folds duplicate inbound edges into the pre-existing edge and skips them on revert', () => {
    const store = GraphStore.load(tmpRepo());
    const ev = (line: number) => ({
      source_type: 'code' as const,
      locator: { repo: 'r', path: 'src/a.ts', line_start: line, line_end: line },
      excerpt: `line ${line}`,
      stance: 'supports' as const,
    });
    store.upsertNode(makeNode({ id: 'entity-cliente', type: 'entity', name: 'Cliente' }));
    store.upsertNode(makeNode({ id: 'entity-cliente-2', type: 'entity', name: 'Cliente 2' }));
    store.upsertNode(
      makeNode({
        id: 'rule-r',
        type: 'rule',
        name: 'Regla',
        edges: [
          {
            type: 'OPERATES_ON',
            target: 'entity/entity-cliente',
            confidence: 0.9,
            status: 'active',
            evidence: [ev(1)],
          },
          {
            type: 'OPERATES_ON',
            target: 'entity/entity-cliente-2',
            confidence: 0.9,
            status: 'active',
            evidence: [ev(2)],
          },
        ],
      }),
    );
    saveMergesFile(store.repoRoot, {
      proposals: [
        proposalOf({ id: 'p-dup', sourceNodeId: 'entity-cliente-2', targetNodeId: 'entity-cliente' }),
      ],
      merges: [],
    });

    const record = acceptMergeProposal(store, 'p-dup') as StoredMergeRecord;
    const rule = store.getNode('rule-r')!;
    expect(rule.edges).toHaveLength(1);
    expect(rule.edges[0].target).toBe('entity/entity-cliente');
    expect(rule.edges[0].evidence).toHaveLength(2);
    expect(record.rewired?.[0].merged).toBe(true);

    revertMerge(store, record.id);
    // The folded edge is not split back out (documented limitation), but the
    // absorbed node itself is restored.
    expect(store.getNode('entity-cliente-2')).toBeDefined();
    expect(store.getNode('rule-r')!.edges).toHaveLength(1);
  });

  it('accept fails for unknown proposals or missing nodes', () => {
    const store = GraphStore.load(tmpRepo());
    saveMergesFile(store.repoRoot, {
      proposals: [proposalOf({ id: 'p-x', sourceNodeId: 'entity-nope', targetNodeId: 'entity-also-nope' })],
      merges: [],
    });
    expect(() => acceptMergeProposal(store, 'missing')).toThrow(/not found/);
    expect(() => acceptMergeProposal(store, 'p-x')).toThrow(/not in the store/);
  });
});

// ---------------------------------------------------------------------------
// End-to-end: resolveBatch → applyResolvedBatch → alias recorded on fuzzy match
// ---------------------------------------------------------------------------

describe('resolver + graph integration', () => {
  it('a fuzzy-matched mention ends up as alias after applyResolvedBatch', async () => {
    const store = GraphStore.load(tmpRepo());
    store.upsertNode(
      makeNode({ id: 'policy-pago-anticipado', type: 'policy', name: 'Pago Anticipado' }),
    );
    const batch = batchOf([bnode('pago antiicipado', 'policy')]);
    const { resolutions } = await resolveBatch(batch, store, { now: NOW });
    store.applyResolvedBatch(batch, resolutions, { now: NOW });
    const node = store.getNode('policy-pago-anticipado')!;
    expect(node.aliases).toContain('pago antiicipado');
  });
});
