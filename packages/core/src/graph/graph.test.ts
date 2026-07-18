import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {
  Evidence,
  ExtractionBatch,
  GraphNode,
  ResolutionDecision,
  RunMeta,
} from '../types.js';
import { edgeId, shortHash } from '../ids.js';
import { writeNodeFile } from '../serializer/index.js';
import {
  GraphStore,
  collectConflicts,
  computeEdgeConfidence,
  conflictEvidenceKey,
  conflictResolutionOf,
  evidenceSetHash,
  isConflicted,
  listRuns,
  newRunId,
  readRunMeta,
  resolveConflictEdge,
  writeRunMeta,
} from './index.js';

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'untacit-'));
}

function ev(partial: Partial<Evidence> & Pick<Evidence, 'source_type'>): Evidence {
  return {
    locator: { doc_id: `doc-${partial.source_type}` },
    excerpt: 'fragmento',
    stance: 'supports',
    ...partial,
  };
}

const NOW = new Date('2026-07-14T17:30:05Z');

function codeBatch(): ExtractionBatch {
  return {
    run_id: '2026-07-14T10-00-00-code',
    source_type: 'code',
    extractor: { name: 'extractor-code', model: 'claude-fable-5', prompt_version: 'v1' },
    nodes: [
      {
        mention: 'bloqueo prepago',
        type: 'rule',
        name: 'Bloqueo de pedido sin prepago',
        description: 'Se rechaza el pedido de un cliente nuevo sin pago registrado.',
        attrs: { origen: 'checkout' },
        evidence: {
          locator: { repo: 'web-pedidos', path: 'src/checkout.ts', line_start: 84, line_end: 91 },
          excerpt: 'if (customer.isNew && !order.prepaid) reject(order)',
        },
      },
      {
        mention: 'Cliente',
        type: 'entity',
        name: 'Cliente',
        description: 'Cliente de la empresa.',
        evidence: {
          locator: { repo: 'web-pedidos', path: 'src/models/customer.ts', line_start: 1, line_end: 10 },
          excerpt: 'class Customer {',
        },
      },
    ],
    edges: [
      {
        type: 'OPERATES_ON',
        source_mention: 'bloqueo prepago',
        target_mention: 'Cliente',
        evidence: {
          locator: { repo: 'web-pedidos', path: 'src/checkout.ts', line_start: 84, line_end: 91 },
          excerpt: 'if (customer.isNew && !order.prepaid) reject(order)',
        },
      },
    ],
  };
}

function codeResolutions(): Map<string, ResolutionDecision> {
  return new Map<string, ResolutionDecision>([
    ['bloqueo prepago', { mention: 'bloqueo prepago', action: 'created', nodeId: 'rule-bloqueo-pedido-sin-prepago' }],
    ['Cliente', { mention: 'Cliente', action: 'created', nodeId: 'entity-cliente' }],
  ]);
}

describe('computeEdgeConfidence (docs/02 §7)', () => {
  it.each([
    [[ev({ source_type: 'code' })], 0.9],
    [[ev({ source_type: 'document' })], 0.7],
    [[ev({ source_type: 'interview' })], 0.6],
    [[ev({ source_type: 'interview', validated_by: 'administración' })], 0.95],
    [[ev({ source_type: 'code' }), ev({ source_type: 'document' })], 0.95],
    [
      [
        ev({ source_type: 'code' }),
        ev({ source_type: 'document' }),
        ev({ source_type: 'interview' }),
      ],
      0.99, // 0.9 + 2×0.05 = 1.0, capped
    ],
    [[ev({ source_type: 'document' }), ev({ source_type: 'interview' })], 0.75],
    [[], 0],
    [[ev({ source_type: 'code', stance: 'contradicts' })], 0],
  ])('case %#: computes %d', (evidence, expected) => {
    expect(computeEdgeConfidence(evidence as Evidence[])).toBe(expected);
  });

  it('returns exactly 0.95 for code + document (no float dust)', () => {
    const confidence = computeEdgeConfidence([
      ev({ source_type: 'code' }),
      ev({ source_type: 'document' }),
    ]);
    expect(confidence).toBe(0.95);
    expect(String(confidence)).toBe('0.95');
  });

  it('ignores contradicting evidence and duplicate source types for the bonus', () => {
    expect(
      computeEdgeConfidence([
        ev({ source_type: 'code' }),
        ev({ source_type: 'code', excerpt: 'otro' }),
        ev({ source_type: 'document', stance: 'contradicts' }),
      ]),
    ).toBe(0.9);
  });
});

describe('isConflicted (docs/02 §6)', () => {
  it('detects opposite stances from different source types', () => {
    expect(
      isConflicted([ev({ source_type: 'code' }), ev({ source_type: 'document', stance: 'contradicts' })]),
    ).toBe(true);
  });

  it('detects opposite stances from the same source type but different locators', () => {
    expect(
      isConflicted([
        ev({ source_type: 'document', locator: { doc_id: 'manual', section: '4.2' } }),
        ev({ source_type: 'document', locator: { doc_id: 'manual', section: '9.1' }, stance: 'contradicts' }),
      ]),
    ).toBe(true);
  });

  it('is not conflicted when the opposite stances come from the very same fragment', () => {
    expect(
      isConflicted([
        ev({ source_type: 'document', locator: { doc_id: 'manual', section: '4.2' } }),
        ev({ source_type: 'document', locator: { section: '4.2', doc_id: 'manual' }, stance: 'contradicts' }),
      ]),
    ).toBe(false);
  });

  it('is not conflicted without both stances', () => {
    expect(isConflicted([ev({ source_type: 'code' })])).toBe(false);
    expect(isConflicted([ev({ source_type: 'code', stance: 'contradicts' })])).toBe(false);
    expect(isConflicted([])).toBe(false);
  });
});

describe('GraphStore.applyResolvedBatch', () => {
  it('creates nodes and edges from a resolved batch with enriched evidence', () => {
    const store = GraphStore.load(tmpRepo());
    const stats = store.applyResolvedBatch(codeBatch(), codeResolutions(), { now: NOW });

    expect(stats).toEqual({
      nodes_created: 2,
      nodes_updated: 0,
      edges_created: 1,
      edges_updated: 0,
      evidence_added: 3,
      rejected: 0,
      merge_proposals: 0,
    });

    const rule = store.getNode('rule-bloqueo-pedido-sin-prepago')!;
    expect(rule.type).toBe('rule');
    expect(rule.name).toBe('Bloqueo de pedido sin prepago');
    expect(rule.aliases).toEqual(['bloqueo prepago']); // mention differs from name
    expect(rule.status).toBe('active');
    expect(rule.attrs).toEqual({ origen: 'checkout' });
    expect(rule.schema_version).toBe(1);
    expect(rule.evidence).toEqual([
      {
        source_type: 'code',
        locator: { repo: 'web-pedidos', path: 'src/checkout.ts', line_start: 84, line_end: 91 },
        excerpt: 'if (customer.isNew && !order.prepaid) reject(order)',
        stance: 'supports',
        extractor: { name: 'extractor-code', model: 'claude-fable-5', prompt_version: 'v1' },
        extracted_at: '2026-07-14',
        run: '2026-07-14T10-00-00-code',
      },
    ]);

    const entity = store.getNode('entity-cliente')!;
    expect(entity.aliases).toEqual([]); // mention equals name

    expect(rule.edges).toHaveLength(1);
    const edge = rule.edges[0];
    expect(edge.type).toBe('OPERATES_ON');
    expect(edge.target).toBe('entity/entity-cliente'); // ref built from the resolved target type
    expect(edge.confidence).toBe(0.9);
    expect(edge.status).toBe('active');
    expect(edge.evidence).toHaveLength(1);
    expect(edge.evidence[0].run).toBe('2026-07-14T10-00-00-code');
  });

  it('getByRef resolves type-qualified refs; getNode plain ids', () => {
    const store = GraphStore.load(tmpRepo());
    store.applyResolvedBatch(codeBatch(), codeResolutions(), { now: NOW });
    expect(store.getByRef('entity/entity-cliente')).toBe(store.getNode('entity-cliente'));
    expect(store.getByRef('process/entity-cliente')).toBeUndefined();
  });

  it('is idempotent: re-applying the identical batch yields all-zero stats and no writes', () => {
    const repo = tmpRepo();
    const store = GraphStore.load(repo);
    store.applyResolvedBatch(codeBatch(), codeResolutions(), { now: NOW });
    const firstWrite = store.write();
    expect(firstWrite).toHaveLength(2);

    const stats = store.applyResolvedBatch(codeBatch(), codeResolutions(), { now: NOW });
    expect(stats).toEqual({
      nodes_created: 0,
      nodes_updated: 0,
      edges_created: 0,
      edges_updated: 0,
      evidence_added: 0,
      rejected: 0,
      merge_proposals: 0,
    });
    expect(store.write()).toEqual([]);

    // even a fresh store re-applying the batch leaves the files byte-identical
    const store2 = GraphStore.load(repo);
    store2.applyResolvedBatch(codeBatch(), codeResolutions(), { now: NOW });
    expect(store2.write()).toEqual([]);
  });

  it('dedups evidence by identity key even when run/extracted_at differ', () => {
    const store = GraphStore.load(tmpRepo());
    store.applyResolvedBatch(codeBatch(), codeResolutions(), { now: NOW });
    const later = codeBatch();
    later.run_id = '2026-07-15T10-00-00-code';
    const stats = store.applyResolvedBatch(later, codeResolutions(), {
      now: new Date('2026-07-15T10:00:00Z'),
    });
    expect(stats.evidence_added).toBe(0);
    expect(stats.nodes_updated).toBe(0);
    expect(stats.edges_updated).toBe(0);
  });

  it('merges into existing nodes: aliases accumulate, description kept, attrs existing-wins, evidence appended', () => {
    const store = GraphStore.load(tmpRepo());
    store.applyResolvedBatch(codeBatch(), codeResolutions(), { now: NOW });

    const docBatch: ExtractionBatch = {
      run_id: '2026-07-14T12-00-00-document',
      source_type: 'document',
      nodes: [
        {
          mention: 'los clientes',
          type: 'entity',
          name: 'Clientes',
          description: 'Otra descripción que debe ignorarse.',
          attrs: { fuente: 'manual', origen: 'manual-tambien' },
          evidence: {
            locator: { doc_id: 'manual-comercial', section: '2.1' },
            excerpt: 'Los clientes se dan de alta con ficha completa',
          },
        },
      ],
      edges: [],
    };
    const resolutions = new Map<string, ResolutionDecision>([
      ['los clientes', { mention: 'los clientes', action: 'fuzzy-match', nodeId: 'entity-cliente' }],
    ]);
    const stats = store.applyResolvedBatch(docBatch, resolutions, { now: NOW });
    expect(stats.nodes_created).toBe(0);
    expect(stats.nodes_updated).toBe(1);
    expect(stats.evidence_added).toBe(1);

    const entity = store.getNode('entity-cliente')!;
    expect(entity.aliases).toEqual(['los clientes', 'Clientes']);
    expect(entity.description).toBe('Cliente de la empresa.'); // existing non-empty wins
    expect(entity.attrs).toEqual({ fuente: 'manual', origen: 'manual-tambien' });
    expect(entity.evidence).toHaveLength(2);

    // re-merging the same mentions adds nothing (normalized, deduped)
    const again = store.applyResolvedBatch(docBatch, resolutions, { now: NOW });
    expect(again.nodes_updated).toBe(0);
    expect(store.getNode('entity-cliente')!.aliases).toEqual(['los clientes', 'Clientes']);
  });

  it('fills an empty description on merge', () => {
    const repo = tmpRepo();
    const empty: GraphNode = {
      id: 'entity-cliente',
      type: 'entity',
      name: 'Cliente',
      description: '',
      aliases: [],
      status: 'active',
      attrs: {},
      evidence: [],
      edges: [],
      schema_version: 1,
    };
    writeNodeFile(repo, empty);
    const store = GraphStore.load(repo);
    store.applyResolvedBatch(codeBatch(), codeResolutions(), { now: NOW });
    expect(store.getNode('entity-cliente')!.description).toBe('Cliente de la empresa.');
  });

  it('accumulates multi-source evidence on an edge and raises confidence', () => {
    const store = GraphStore.load(tmpRepo());
    store.applyResolvedBatch(codeBatch(), codeResolutions(), { now: NOW });

    const docBatch: ExtractionBatch = {
      run_id: '2026-07-14T12-00-00-document',
      source_type: 'document',
      nodes: [],
      edges: [
        {
          type: 'OPERATES_ON',
          source_mention: 'la regla de prepago',
          target_mention: 'los clientes',
          evidence: {
            locator: { doc_id: 'manual-comercial', section: '4.2' },
            excerpt: 'A clientes nuevos se les exige pago por adelantado',
          },
        },
      ],
    };
    const resolutions = new Map<string, ResolutionDecision>([
      ['la regla de prepago', { mention: 'la regla de prepago', action: 'fuzzy-match', nodeId: 'rule-bloqueo-pedido-sin-prepago' }],
      ['los clientes', { mention: 'los clientes', action: 'fuzzy-match', nodeId: 'entity-cliente' }],
    ]);
    const stats = store.applyResolvedBatch(docBatch, resolutions, { now: NOW });
    expect(stats.edges_created).toBe(0);
    expect(stats.edges_updated).toBe(1);
    expect(stats.evidence_added).toBe(1);

    const edge = store.getNode('rule-bloqueo-pedido-sin-prepago')!.edges[0];
    expect(edge.evidence).toHaveLength(2);
    expect(edge.confidence).toBe(0.95); // code 0.9 + 0.05 distinct-source bonus
    expect(edge.status).toBe('active');
  });

  it('marks edges conflicted on contradicting evidence and collectConflicts reports them', () => {
    const store = GraphStore.load(tmpRepo());
    store.applyResolvedBatch(codeBatch(), codeResolutions(), { now: NOW });

    const contradicting: ExtractionBatch = {
      run_id: '2026-07-14T13-00-00-document',
      source_type: 'document',
      nodes: [],
      edges: [
        {
          type: 'OPERATES_ON',
          source_mention: 'bloqueo prepago',
          target_mention: 'Cliente',
          stance: 'contradicts',
          evidence: {
            locator: { doc_id: 'manual-comercial', section: '9.9' },
            excerpt: 'El prepago solo aplica a pedidos superiores a 3.000 €',
          },
        },
      ],
    };
    const stats = store.applyResolvedBatch(contradicting, codeResolutions(), { now: NOW });
    expect(stats.edges_updated).toBe(1);

    const rule = store.getNode('rule-bloqueo-pedido-sin-prepago')!;
    const edge = rule.edges[0];
    expect(edge.status).toBe('conflicted');
    expect(edge.confidence).toBe(0.9); // confidence independent of conflict

    const conflicts = collectConflicts(store);
    expect(conflicts).toHaveLength(1);
    const conflict = conflicts[0];
    expect(conflict.nodeId).toBe('rule-bloqueo-pedido-sin-prepago');
    expect(conflict.edgeType).toBe('OPERATES_ON');
    expect(conflict.target).toBe('entity/entity-cliente');
    expect(conflict.edgeId).toBe(
      edgeId('OPERATES_ON', 'rule-bloqueo-pedido-sin-prepago', 'entity/entity-cliente'),
    );
    expect(conflict.id).toBe(shortHash(conflict.edgeId));
    expect(conflict.supporting).toHaveLength(1);
    expect(conflict.contradicting).toHaveLength(1);
    expect(conflict.supporting[0].source_type).toBe('code');
    expect(conflict.contradicting[0].source_type).toBe('document');
  });

  it('deprecated edges stay deprecated when new evidence arrives', () => {
    const store = GraphStore.load(tmpRepo());
    store.applyResolvedBatch(codeBatch(), codeResolutions(), { now: NOW });
    store.getNode('rule-bloqueo-pedido-sin-prepago')!.edges[0].status = 'deprecated';

    const docBatch = codeBatch();
    docBatch.run_id = '2026-07-14T14-00-00-document';
    docBatch.source_type = 'document';
    docBatch.nodes = [];
    const stats = store.applyResolvedBatch(docBatch, codeResolutions(), { now: NOW });
    expect(stats.edges_updated).toBe(1); // new evidence (source_type differs) + confidence moved
    expect(store.getNode('rule-bloqueo-pedido-sin-prepago')!.edges[0].status).toBe('deprecated');
  });

  it('sets interview-validated evidence up to 0.95 confidence', () => {
    const store = GraphStore.load(tmpRepo());
    store.applyResolvedBatch(codeBatch(), codeResolutions(), { now: NOW });

    const interview: ExtractionBatch = {
      run_id: '2026-07-14T15-00-00-interview',
      source_type: 'interview',
      nodes: [],
      edges: [
        {
          type: 'OPERATES_ON',
          source_mention: 'bloqueo prepago',
          target_mention: 'Cliente',
          evidence: {
            locator: { interview_id: 'entrevista-01', speaker_role: 'administración', turn: 4 },
            excerpt: 'Sí, a los clientes nuevos siempre se les cobra por adelantado',
            validated_by: 'administración',
          },
        },
      ],
    };
    store.applyResolvedBatch(interview, codeResolutions(), { now: NOW });
    const edge = store.getNode('rule-bloqueo-pedido-sin-prepago')!.edges[0];
    expect(edge.evidence[1].validated_by).toBe('administración');
    expect(edge.confidence).toBe(0.99); // max(0.9, 0.95) + 0.05 = 1.0 → capped
  });

  it('throws on a mention without a resolution decision', () => {
    const store = GraphStore.load(tmpRepo());
    const resolutions = codeResolutions();
    resolutions.delete('Cliente');
    expect(() => store.applyResolvedBatch(codeBatch(), resolutions, { now: NOW })).toThrow(
      /No resolution decision for mention "Cliente"/,
    );
  });
});

describe('GraphStore.write / load round-trip', () => {
  it('writes canonical files that reload to an identical store', () => {
    const repo = tmpRepo();
    const store = GraphStore.load(repo);
    store.applyResolvedBatch(codeBatch(), codeResolutions(), { now: NOW });
    const written = store.write();
    expect(written.sort()).toEqual([
      path.join(repo, 'graph', 'entity', 'entity-cliente.md'),
      path.join(repo, 'graph', 'rule', 'rule-bloqueo-pedido-sin-prepago.md'),
    ]);

    const reloaded = GraphStore.load(repo);
    expect(reloaded.nodes.size).toBe(2);
    expect(reloaded.getNode('rule-bloqueo-pedido-sin-prepago')).toEqual(
      store.getNode('rule-bloqueo-pedido-sin-prepago'),
    );
    // a clean reload + write touches nothing
    expect(reloaded.write()).toEqual([]);
  });

  it('upsertNode marks dirty and write persists it', () => {
    const repo = tmpRepo();
    const store = GraphStore.load(repo);
    const node: GraphNode = {
      id: 'system-erp',
      type: 'system',
      name: 'ERP',
      description: 'Sistema central de gestión.',
      aliases: [],
      status: 'active',
      attrs: {},
      evidence: [],
      edges: [],
      schema_version: 1,
    };
    store.upsertNode(node);
    expect(store.write()).toEqual([path.join(repo, 'graph', 'system', 'system-erp.md')]);
    expect(store.write()).toEqual([]); // no longer dirty
  });
});

describe('runs', () => {
  it('newRunId formats the UTC date as YYYY-MM-DDTHH-mm-ss-<sourceType>', () => {
    expect(newRunId('code', new Date('2026-07-14T17:30:05Z'))).toBe('2026-07-14T17-30-05-code');
    expect(newRunId('interview', new Date('2026-01-02T03:04:05.999Z'))).toBe(
      '2026-01-02T03-04-05-interview',
    );
  });

  it('writeRunMeta / readRunMeta / listRuns round-trip', () => {
    const repo = tmpRepo();
    const metaA: RunMeta = {
      id: '2026-07-14T10-00-00-code',
      source_type: 'code',
      extractor: { name: 'extractor-code', model: 'claude-fable-5', prompt_version: 'v1' },
      started_at: '2026-07-14T10:00:00Z',
      finished_at: '2026-07-14T10:05:00Z',
      stats: {
        nodes_created: 2,
        nodes_updated: 0,
        edges_created: 1,
        edges_updated: 0,
        evidence_added: 3,
        rejected: 0,
        merge_proposals: 0,
      },
      commit: 'abc123',
    };
    const metaB: RunMeta = {
      id: '2026-07-13T09-00-00-document',
      source_type: 'document',
      stats: {
        nodes_created: 0,
        nodes_updated: 0,
        edges_created: 0,
        edges_updated: 0,
        evidence_added: 0,
        rejected: 0,
        merge_proposals: 0,
      },
    };
    const filePath = writeRunMeta(repo, metaA);
    writeRunMeta(repo, metaB);
    expect(filePath).toBe(path.join(repo, 'runs', '2026-07-14T10-00-00-code.json'));

    const raw = fs.readFileSync(filePath, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(Object.keys(JSON.parse(raw))[0]).toBe('id');

    expect(readRunMeta(repo, metaA.id)).toEqual(metaA);
    expect(listRuns(repo)).toEqual([metaB, metaA]); // sorted by id
  });

  it('listRuns returns [] when the runs dir is missing', () => {
    expect(listRuns(tmpRepo())).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Conflict resolution from the review queue (Fase 3, docs/02 §6)
// ---------------------------------------------------------------------------

function contradictingBatch(): ExtractionBatch {
  return {
    run_id: '2026-07-14T13-00-00-document',
    source_type: 'document',
    nodes: [],
    edges: [
      {
        type: 'OPERATES_ON',
        source_mention: 'bloqueo prepago',
        target_mention: 'Cliente',
        stance: 'contradicts',
        evidence: {
          locator: { doc_id: 'manual-comercial', section: '9.9' },
          excerpt: 'El prepago solo aplica a pedidos superiores a 3.000 €',
        },
      },
    ],
  };
}

/** Store with the designed conflict applied: code supports, document contradicts. */
function conflictedStore(): GraphStore {
  const store = GraphStore.load(tmpRepo());
  store.applyResolvedBatch(codeBatch(), codeResolutions(), { now: NOW });
  store.applyResolvedBatch(contradictingBatch(), codeResolutions(), { now: NOW });
  return store;
}

describe('resolveConflictEdge (docs/02 §6)', () => {
  const EDGE = {
    nodeId: 'rule-bloqueo-pedido-sin-prepago',
    edgeType: 'OPERATES_ON' as const,
    target: 'entity/entity-cliente',
  };

  it('supports winner returns the edge to active and records the resolution', () => {
    const store = conflictedStore();
    const conflict = collectConflicts(store)[0];
    const winner = conflict.supporting[0];

    const { edge, resolution } = resolveConflictEdge(store, {
      ...EDGE,
      winnerKey: winner.key,
      by: 'administracion',
      now: NOW,
    });

    expect(edge.status).toBe('active');
    expect(resolution.status).toBe('active');
    expect(resolution.winner).toBe(winner.key);
    expect(resolution.by).toBe('administracion');
    expect(resolution.at).toBe(NOW.toISOString());
    // The winning evidence now carries the human validation.
    const validated = edge.evidence.find((e) => conflictEvidenceKey(e) === winner.key);
    expect(validated?.validated_by).toBe('administracion');
    // The record is pinned to the exact evidence set it judged.
    expect(resolution.evidence_set).toBe(evidenceSetHash(edge.evidence));
    // Resolved conflicts leave the review queue.
    expect(collectConflicts(store)).toHaveLength(0);
  });

  it('contradicts winner deprecates the edge', () => {
    const store = conflictedStore();
    const conflict = collectConflicts(store)[0];
    const { edge, resolution } = resolveConflictEdge(store, {
      ...EDGE,
      winnerKey: conflict.contradicting[0].key,
      by: 'gerencia',
      now: NOW,
    });
    expect(edge.status).toBe('deprecated');
    expect(resolution.status).toBe('deprecated');
  });

  it('an identical re-import never re-opens a resolved conflict', () => {
    const store = conflictedStore();
    const conflict = collectConflicts(store)[0];
    resolveConflictEdge(store, { ...EDGE, winnerKey: conflict.supporting[0].key, now: NOW });

    // Same batches again: evidence dedups, the evidence set is unchanged,
    // so the pinned resolution keeps the edge active.
    store.applyResolvedBatch(codeBatch(), codeResolutions(), { now: NOW });
    store.applyResolvedBatch(contradictingBatch(), codeResolutions(), { now: NOW });
    const edge = store.getNode(EDGE.nodeId)!.edges.find((e) => e.type === 'OPERATES_ON')!;
    expect(edge.status).toBe('active');
    expect(collectConflicts(store)).toHaveLength(0);
  });

  it('genuinely new contradicting evidence re-opens the conflict', () => {
    const store = conflictedStore();
    const conflict = collectConflicts(store)[0];
    resolveConflictEdge(store, { ...EDGE, winnerKey: conflict.supporting[0].key, now: NOW });

    const newer: ExtractionBatch = {
      run_id: '2026-08-01T09-00-00-interview',
      source_type: 'interview',
      nodes: [],
      edges: [
        {
          type: 'OPERATES_ON',
          source_mention: 'bloqueo prepago',
          target_mention: 'Cliente',
          stance: 'contradicts',
          evidence: {
            locator: { interview_id: 'int-02', speaker_role: 'comercial', turn: 4 },
            excerpt: 'Eso se dejó de aplicar el trimestre pasado',
          },
        },
      ],
    };
    store.applyResolvedBatch(newer, codeResolutions(), { now: NOW });
    const edge = store.getNode(EDGE.nodeId)!.edges.find((e) => e.type === 'OPERATES_ON')!;
    expect(edge.status).toBe('conflicted');
    expect(collectConflicts(store)).toHaveLength(1);
  });

  it('the resolution survives the write/load round-trip', () => {
    const repo = tmpRepo();
    const store = GraphStore.load(repo);
    store.applyResolvedBatch(codeBatch(), codeResolutions(), { now: NOW });
    store.applyResolvedBatch(contradictingBatch(), codeResolutions(), { now: NOW });
    const conflict = collectConflicts(store)[0];
    resolveConflictEdge(store, {
      ...EDGE,
      winnerKey: conflict.supporting[0].key,
      by: 'administracion',
      now: NOW,
    });
    store.write();

    const reloaded = GraphStore.load(repo);
    const edge = reloaded.getNode(EDGE.nodeId)!.edges.find((e) => e.type === 'OPERATES_ON')!;
    expect(edge.status).toBe('active');
    expect(conflictResolutionOf(edge)).toMatchObject({
      status: 'active',
      by: 'administracion',
    });
    // And an identical re-import over the reloaded store is still pinned.
    reloaded.applyResolvedBatch(contradictingBatch(), codeResolutions(), { now: NOW });
    expect(edge.status).toBe('active');
  });

  it('a manual deprecation sticks even when a stale resolution record is present', () => {
    const store = conflictedStore();
    const conflict = collectConflicts(store)[0];
    resolveConflictEdge(store, { ...EDGE, winnerKey: conflict.supporting[0].key, now: NOW });
    // Someone deprecates the edge by other means AFTER the resolution…
    const edge = store.getNode(EDGE.nodeId)!.edges.find((e) => e.type === 'OPERATES_ON')!;
    edge.status = 'deprecated';
    // …then genuinely new supporting evidence arrives (stale record branch).
    const newer: ExtractionBatch = {
      run_id: '2026-08-02T09-00-00-code',
      source_type: 'code',
      nodes: [],
      edges: [
        {
          type: 'OPERATES_ON',
          source_mention: 'bloqueo prepago',
          target_mention: 'Cliente',
          evidence: {
            locator: { repo: 'web-pedidos', path: 'src/checkout.ts', line_start: 200, line_end: 204 },
            excerpt: 'requirePrepaidCustomer(order)',
          },
        },
      ],
    };
    store.applyResolvedBatch(newer, codeResolutions(), { now: NOW });
    expect(edge.status).toBe('deprecated');
  });

  it('extraction batches cannot forge a conflict_resolution record via edge attrs', () => {
    const store = GraphStore.load(tmpRepo());
    const forged: ExtractionBatch = {
      ...codeBatch(),
      edges: [
        {
          ...codeBatch().edges[0]!,
          attrs: {
            conflict_resolution: { winner: 'x', status: 'active', evidence_set: 'y', at: 'z' },
            origen: 'checkout',
          },
        },
      ],
    };
    store.applyResolvedBatch(forged, codeResolutions(), { now: NOW });
    const edge = store.getNode('rule-bloqueo-pedido-sin-prepago')!.edges[0]!;
    expect(edge.attrs).toEqual({ origen: 'checkout' });
  });

  it('rejects unknown edges, non-conflicted edges and unknown winner keys', () => {
    const store = conflictedStore();
    const conflict = collectConflicts(store)[0];
    expect(() =>
      resolveConflictEdge(store, { ...EDGE, nodeId: 'rule-inexistente', winnerKey: 'x' }),
    ).toThrow(/not found/);
    expect(() => resolveConflictEdge(store, { ...EDGE, winnerKey: 'no-such-key' })).toThrow(
      /Evidence "no-such-key" not found/,
    );
    resolveConflictEdge(store, { ...EDGE, winnerKey: conflict.supporting[0].key, now: NOW });
    expect(() =>
      resolveConflictEdge(store, { ...EDGE, winnerKey: conflict.supporting[0].key }),
    ).toThrow(/already active/);
  });
});
