import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { edgeId } from '../ids.js';
import { indexDbPath } from '../paths.js';
import { HashEmbeddingProvider } from '../resolver/index.js';
import { buildIndex, GraphIndex } from './index.js';

// ---------------------------------------------------------------------------
// Fixture graph repo — raw canonical markdown, written directly to disk
// (docs/03 §3 file format). Six nodes, seven edges, one conflict, one
// dangling target (system/system-erp has no file).
// ---------------------------------------------------------------------------

const FIXTURES: Record<string, string> = {
  'entity/entity-cliente.md': `---
type: entity
name: Cliente
status: active
aliases: [clientes, comprador habitual]
evidence:
  - source_type: document
    locator: { doc_id: manual-comercial, section: "4.2" }
    excerpt: "El cliente es toda persona o empresa que realiza pedidos"
    stance: supports
    extracted_at: "2026-07-13"
    run: 2026-07-13T10-30-docs
schema_version: 1
---

Persona o empresa que realiza pedidos con facturación recurrente.
`,

  'entity/entity-pedido.md': `---
type: entity
name: Pedido
status: active
schema_version: 1
---

Solicitud de compra registrada en el sistema.

Incluye líneas de pedido y condiciones de entrega.
`,

  'process/process-alta-pedido.md': `---
type: process
name: Alta de pedido
status: active
edges:
  - type: DEPENDS_ON
    target: rule/rule-bloqueo-prepago
    confidence: 0.9
    status: active
  - type: TRIGGERS
    target: event/event-pedido-creado
    confidence: 0.85
    status: active
schema_version: 1
---

Proceso de registro y validación de un pedido nuevo.
`,

  'event/event-pedido-creado.md': `---
type: event
name: Pedido creado
status: active
schema_version: 1
---

Se ha creado un pedido en el sistema.
`,

  'rule/rule-bloqueo-prepago.md': `---
type: rule
name: Bloqueo de pedido sin prepago
status: active
aliases: [regla de prepago]
edges:
  - type: DEPENDS_ON
    target: entity/entity-cliente
    confidence: 0.9
    status: active
  - type: IMPLEMENTED_IN
    target: system/system-erp
    confidence: 0.9
    status: conflicted
    evidence:
      - source_type: code
        locator: { repo: web-pedidos, path: src/checkout.ts, line_start: 84, line_end: 91 }
        excerpt: "if (customer.isNew && !order.prepaid) reject()"
        stance: supports
      - source_type: interview
        locator: { interview_id: int-01, speaker_role: administracion, turn: 12 }
        excerpt: "Eso ya no vive en el ERP"
        stance: contradicts
  - type: OPERATES_ON
    target: entity/entity-cliente
    confidence: 0.6
    status: active
    attrs: { field: prepago }
  - type: VALIDATES
    target: process/process-alta-pedido
    confidence: 0.9
    status: active
    evidence:
      - source_type: code
        locator: { repo: web-pedidos, path: src/checkout.ts, line_start: 84, line_end: 91 }
        excerpt: "reject order when new customer without prepayment"
        stance: supports
schema_version: 1
---

Se rechaza el pedido de un cliente nuevo sin pago registrado.
`,

  'policy/policy-pago-anticipado.md': `---
type: policy
name: Pago anticipado a clientes nuevos
status: active
edges:
  - type: GOVERNS
    target: rule/rule-bloqueo-prepago
    confidence: 0.95
    status: active
    evidence:
      - source_type: interview
        locator: { interview_id: int-01, speaker_role: administracion, turn: 3 }
        excerpt: "A los clientes nuevos siempre se les cobra por adelantado"
        stance: supports
        validated_by: administracion
schema_version: 1
---

Los clientes nuevos pagan por adelantado.
`,
};

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function makeRepo(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'untacit-'));
  tmpDirs.push(root);
  for (const [rel, content] of Object.entries(FIXTURES)) {
    const abs = path.join(root, 'graph', rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return root;
}

function openIndex(root: string): GraphIndex {
  const index = GraphIndex.open(root);
  return index;
}

// ---------------------------------------------------------------------------
// buildIndex — full and incremental
// ---------------------------------------------------------------------------

describe('buildIndex', () => {
  it('full build indexes every node file', () => {
    const root = makeRepo();
    const result = buildIndex(root, { full: true });
    expect(result).toEqual({ indexed: 6, removed: 0, total: 6 });
  });

  it('incremental rebuild with no changes indexes nothing', () => {
    const root = makeRepo();
    buildIndex(root);
    const again = buildIndex(root);
    expect(again).toEqual({ indexed: 0, removed: 0, total: 6 });
  });

  it('touching one file reindexes only that file', () => {
    const root = makeRepo();
    buildIndex(root);
    const target = path.join(root, 'graph', 'entity', 'entity-pedido.md');
    writeFileSync(
      target,
      FIXTURES['entity/entity-pedido.md'].replace(
        'Solicitud de compra registrada en el sistema.',
        'Solicitud reprogramada de compra.',
      ),
      'utf8',
    );
    const result = buildIndex(root);
    expect(result).toEqual({ indexed: 1, removed: 0, total: 6 });

    const index = openIndex(root);
    try {
      const hits = index.search('reprogramada');
      expect(hits.map((h) => h.id)).toEqual(['entity-pedido']);
    } finally {
      index.close();
    }
  });

  it('deleting a file removes its rows', () => {
    const root = makeRepo();
    buildIndex(root);
    rmSync(path.join(root, 'graph', 'entity', 'entity-pedido.md'));
    const result = buildIndex(root);
    expect(result).toEqual({ indexed: 0, removed: 1, total: 5 });

    const index = openIndex(root);
    try {
      expect(index.getNode('entity-pedido')).toBeUndefined();
      expect(index.search('solicitud')).toEqual([]);
      expect(index.stats().nodes_total).toBe(5);
    } finally {
      index.close();
    }
  });

  it('full rebuild recreates everything from scratch', () => {
    const root = makeRepo();
    buildIndex(root);
    const result = buildIndex(root, { full: true });
    expect(result).toEqual({ indexed: 6, removed: 0, total: 6 });
  });
});

// ---------------------------------------------------------------------------
// GraphIndex.open + reindexIfStale
// ---------------------------------------------------------------------------

describe('GraphIndex.open', () => {
  it('builds the index when the db file is missing', () => {
    const root = makeRepo();
    const index = GraphIndex.open(root);
    try {
      expect(index.stats().nodes_total).toBe(6);
    } finally {
      index.close();
    }
  });

  it('reindexIfStale picks up files written after open', () => {
    const root = makeRepo();
    const index = GraphIndex.open(root);
    try {
      expect(index.getNode('system-erp')).toBeUndefined();
      const abs = path.join(root, 'graph', 'system', 'system-erp.md');
      mkdirSync(path.dirname(abs), { recursive: true });
      writeFileSync(
        abs,
        `---
type: system
name: ERP
status: active
schema_version: 1
---

Sistema de gestión donde vive la lógica de facturación.
`,
        'utf8',
      );
      index.reindexIfStale();
      expect(index.getNode('system-erp')?.name).toBe('ERP');
      expect(index.stats().nodes_total).toBe(7);
    } finally {
      index.close();
    }
  });

  it('creates the db at indexDbPath', () => {
    const root = makeRepo();
    const index = GraphIndex.open(root);
    index.close();
    expect(indexDbPath(root).endsWith(path.join('.untacit', 'index.db'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// listNodes / isolatedNodes — enumeration queries (gap analysis, browse)
// ---------------------------------------------------------------------------

describe('listNodes', () => {
  it('lists every node ordered by id', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const all = index.listNodes();
      expect(all.map((n) => n.id)).toEqual([
        'entity-cliente',
        'entity-pedido',
        'event-pedido-creado',
        'policy-pago-anticipado',
        'process-alta-pedido',
        'rule-bloqueo-prepago',
      ]);
      expect(all[0].summary).toContain('Persona o empresa');
    } finally {
      index.close();
    }
  });

  it('filters by type and paginates', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      expect(index.listNodes({ types: ['entity'] }).map((n) => n.id)).toEqual([
        'entity-cliente',
        'entity-pedido',
      ]);
      expect(index.listNodes({ types: ['entity'], limit: 1, offset: 1 }).map((n) => n.id)).toEqual([
        'entity-pedido',
      ]);
    } finally {
      index.close();
    }
  });
});

describe('isolatedNodes', () => {
  it('returns only nodes with no edges in either direction', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      // entity-pedido has no edges at all; every other node is source or
      // target of at least one edge (event-pedido-creado is a TRIGGERS target).
      expect(index.isolatedNodes().map((n) => n.id)).toEqual(['entity-pedido']);
    } finally {
      index.close();
    }
  });
});

// ---------------------------------------------------------------------------
// FTS search
// ---------------------------------------------------------------------------

describe('search', () => {
  it('finds a node by name, ranked first', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const hits = index.search('Cliente');
      expect(hits.length).toBeGreaterThan(0);
      expect(hits[0].id).toBe('entity-cliente');
      expect(hits[0].type).toBe('entity');
      expect(hits[0].score).toBeGreaterThan(0);
    } finally {
      index.close();
    }
  });

  it('finds a node by alias', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const hits = index.search('comprador');
      expect(hits.map((h) => h.id)).toEqual(['entity-cliente']);
    } finally {
      index.close();
    }
  });

  it('finds a description word with and without Spanish accents', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      expect(index.search('facturación').map((h) => h.id)).toContain('entity-cliente');
      expect(index.search('facturacion').map((h) => h.id)).toContain('entity-cliente');
    } finally {
      index.close();
    }
  });

  it('supports trailing-* prefix queries', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      expect(index.search('factur*').map((h) => h.id)).toContain('entity-cliente');
    } finally {
      index.close();
    }
  });

  it('filters by node types', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const all = index.search('pedido');
      expect(all.length).toBeGreaterThan(1);
      const entities = index.search('pedido', { types: ['entity'] });
      expect(entities.length).toBeGreaterThan(0);
      for (const hit of entities) expect(hit.type).toBe('entity');
      expect(entities.map((h) => h.id)).toContain('entity-pedido');
    } finally {
      index.close();
    }
  });

  it('summary is the first line of the description', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const [hit] = index.search('solicitud');
      expect(hit.id).toBe('entity-pedido');
      expect(hit.summary).toBe('Solicitud de compra registrada en el sistema.');
    } finally {
      index.close();
    }
  });

  it('respects limit and offset, and quotes hostile input safely', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const limited = index.search('pedido', { limit: 1 });
      expect(limited).toHaveLength(1);
      const offset = index.search('pedido', { limit: 1, offset: 1 });
      expect(offset).toHaveLength(1);
      expect(offset[0].id).not.toBe(limited[0].id);
      // FTS5 operators in raw input must not blow up
      expect(() => index.search('cliente OR (NEAR "x)')).not.toThrow();
      expect(index.search('   ')).toEqual([]);
    } finally {
      index.close();
    }
  });
});

// ---------------------------------------------------------------------------
// getNode / edgesOf
// ---------------------------------------------------------------------------

describe('getNode and edgesOf', () => {
  it('returns the full node with its ref', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const node = index.getNode('rule-bloqueo-prepago');
      expect(node).toBeDefined();
      expect(node?.ref).toBe('rule/rule-bloqueo-prepago');
      expect(node?.name).toBe('Bloqueo de pedido sin prepago');
      expect(node?.aliases).toEqual(['regla de prepago']);
      expect(node?.edges).toHaveLength(4);
      expect(index.getNode('nope')).toBeUndefined();
    } finally {
      index.close();
    }
  });

  it('lists outgoing and incoming edges with direction', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const rows = index.edgesOf('process-alta-pedido');
      const out = rows.filter((r) => r.direction === 'out');
      const inn = rows.filter((r) => r.direction === 'in');
      expect(out.map((r) => r.edge.type).sort()).toEqual(['DEPENDS_ON', 'TRIGGERS']);
      expect(inn).toHaveLength(1);
      expect(inn[0].edge.type).toBe('VALIDATES');
      expect(inn[0].edge.source).toBe('rule-bloqueo-prepago');
      expect(inn[0].edge.target).toBe('process/process-alta-pedido');
      expect(inn[0].edge.targetId).toBe('process-alta-pedido');
      expect(inn[0].edge.id).toBe(
        edgeId('VALIDATES', 'rule-bloqueo-prepago', 'process/process-alta-pedido'),
      );
    } finally {
      index.close();
    }
  });

  it('round-trips edge attrs and survives dangling targets', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const rows = index.edgesOf('rule-bloqueo-prepago');
      const operates = rows.find((r) => r.edge.type === 'OPERATES_ON');
      expect(operates?.edge.attrs).toEqual({ field: 'prepago' });
      const implemented = rows.find((r) => r.edge.type === 'IMPLEMENTED_IN');
      expect(implemented?.edge.targetId).toBe('system-erp'); // dangling: no file
      expect(index.getNode('system-erp')).toBeUndefined();
    } finally {
      index.close();
    }
  });
});

// ---------------------------------------------------------------------------
// neighbors
// ---------------------------------------------------------------------------

describe('neighbors', () => {
  it('depth 1 returns direct neighborhood in both directions', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const { nodes, edges } = index.neighbors('process-alta-pedido');
      const byId = new Map(nodes.map((n) => [n.id, n.distance]));
      expect(byId.get('process-alta-pedido')).toBe(0);
      expect(byId.get('rule-bloqueo-prepago')).toBe(1);
      expect(byId.get('event-pedido-creado')).toBe(1);
      expect(byId.size).toBe(3);
      expect(edges.map((e) => e.type).sort()).toEqual(['DEPENDS_ON', 'TRIGGERS', 'VALIDATES']);
    } finally {
      index.close();
    }
  });

  it('depth 2 expands and skips dangling nodes without crashing', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const { nodes, edges } = index.neighbors('process-alta-pedido', { depth: 2 });
      const byId = new Map(nodes.map((n) => [n.id, n.distance]));
      expect(byId.get('entity-cliente')).toBe(2);
      expect(byId.get('policy-pago-anticipado')).toBe(2);
      expect(byId.has('system-erp')).toBe(false); // dangling target excluded
      expect(byId.has('entity-pedido')).toBe(false); // disconnected
      // ...but the edge to the dangling target is still reported
      expect(edges.some((e) => e.type === 'IMPLEMENTED_IN' && e.targetId === 'system-erp')).toBe(
        true,
      );
    } finally {
      index.close();
    }
  });

  it('filters by edge types', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const { nodes, edges } = index.neighbors('process-alta-pedido', {
        edgeTypes: ['TRIGGERS'],
      });
      expect(nodes.map((n) => n.id).sort()).toEqual([
        'event-pedido-creado',
        'process-alta-pedido',
      ]);
      expect(edges).toHaveLength(1);
      expect(edges[0].type).toBe('TRIGGERS');
    } finally {
      index.close();
    }
  });
});

// ---------------------------------------------------------------------------
// impact — DEPENDS_ON reversed, GOVERNS/TRIGGERS forward (downstream)
// ---------------------------------------------------------------------------

describe('impact', () => {
  it('downstream: what is affected if the entity changes', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const { nodes } = index.impact('entity-cliente');
      const byId = new Map(nodes.map((n) => [n.id, n.distance]));
      expect(byId.get('entity-cliente')).toBe(0);
      expect(byId.get('rule-bloqueo-prepago')).toBe(1); // rule DEPENDS_ON cliente
      expect(byId.get('process-alta-pedido')).toBe(2); // process DEPENDS_ON rule
      expect(byId.get('event-pedido-creado')).toBe(3); // process TRIGGERS event
      expect(byId.has('policy-pago-anticipado')).toBe(false); // GOVERNS not reversed
      expect(byId.size).toBe(4); // OPERATES_ON / VALIDATES never traversed
    } finally {
      index.close();
    }
  });

  it('upstream: what the event depends on / why it exists', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const { nodes } = index.impact('event-pedido-creado', { direction: 'upstream' });
      const byId = new Map(nodes.map((n) => [n.id, n.distance]));
      expect(byId.get('event-pedido-creado')).toBe(0);
      expect(byId.get('process-alta-pedido')).toBe(1); // TRIGGERS reversed
      expect(byId.get('rule-bloqueo-prepago')).toBe(2); // DEPENDS_ON forward
      expect(byId.get('entity-cliente')).toBe(3); // DEPENDS_ON forward
      expect(byId.get('policy-pago-anticipado')).toBe(3); // GOVERNS reversed
      expect(byId.size).toBe(5);
    } finally {
      index.close();
    }
  });

  it('respects maxDepth', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const { nodes } = index.impact('entity-cliente', { maxDepth: 1 });
      expect(nodes.map((n) => n.id).sort()).toEqual(['entity-cliente', 'rule-bloqueo-prepago']);
    } finally {
      index.close();
    }
  });

  it('both is the union of downstream and upstream', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const { nodes } = index.impact('rule-bloqueo-prepago', { direction: 'both' });
      const byId = new Map(nodes.map((n) => [n.id, n.distance]));
      expect(byId.get('rule-bloqueo-prepago')).toBe(0);
      expect(byId.get('process-alta-pedido')).toBe(1); // downstream
      expect(byId.get('event-pedido-creado')).toBe(2); // downstream
      expect(byId.get('entity-cliente')).toBe(1); // upstream
      expect(byId.get('policy-pago-anticipado')).toBe(1); // upstream
      expect(byId.size).toBe(5);
    } finally {
      index.close();
    }
  });

  it('does not crash when the origin does not exist', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const { nodes, edges } = index.impact('no-such-node');
      expect(nodes).toEqual([]);
      expect(edges).toEqual([]);
    } finally {
      index.close();
    }
  });
});

// ---------------------------------------------------------------------------
// conflicts / lowConfidenceEdges / evidenceOf / stats
// ---------------------------------------------------------------------------

describe('conflicts', () => {
  it('extracts conflicted edges with evidence split by stance', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const conflicts = index.conflicts();
      expect(conflicts).toHaveLength(1);
      const [conflict] = conflicts;
      expect(conflict.nodeId).toBe('rule-bloqueo-prepago');
      expect(conflict.edgeType).toBe('IMPLEMENTED_IN');
      expect(conflict.target).toBe('system/system-erp');
      expect(conflict.edgeId).toBe(
        edgeId('IMPLEMENTED_IN', 'rule-bloqueo-prepago', 'system/system-erp'),
      );
      expect(conflict.supporting).toHaveLength(1);
      expect(conflict.supporting[0].source_type).toBe('code');
      expect(conflict.contradicting).toHaveLength(1);
      expect(conflict.contradicting[0].source_type).toBe('interview');
      expect(conflict.contradicting[0].excerpt).toBe('Eso ya no vive en el ERP');
    } finally {
      index.close();
    }
  });
});

describe('lowConfidenceEdges', () => {
  it('defaults to the review threshold over active edges', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const low = index.lowConfidenceEdges();
      expect(low).toHaveLength(1);
      expect(low[0].type).toBe('OPERATES_ON');
      expect(low[0].confidence).toBe(0.6);
    } finally {
      index.close();
    }
  });

  it('accepts a custom threshold and skips non-active edges', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const low = index.lowConfidenceEdges(0.95);
      // active edges < 0.95: 2× DEPENDS_ON (0.9), OPERATES_ON (0.6),
      // VALIDATES (0.9), TRIGGERS (0.85); conflicted IMPLEMENTED_IN excluded.
      expect(low).toHaveLength(5);
      expect(low.every((e) => e.status === 'active')).toBe(true);
      expect(low[0].confidence).toBe(0.6); // sorted ascending
    } finally {
      index.close();
    }
  });
});

describe('evidenceOf', () => {
  it('returns node evidence by node id', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const rows = index.evidenceOf('entity-cliente');
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe('node');
      expect(rows[0].owner).toBe('entity-cliente');
      expect(rows[0].evidence.source_type).toBe('document');
      expect(rows[0].evidence.locator).toEqual({ doc_id: 'manual-comercial', section: '4.2' });
      expect(rows[0].evidence.extracted_at).toBe('2026-07-13');
    } finally {
      index.close();
    }
  });

  it('returns edge evidence by edge id', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const id = edgeId('GOVERNS', 'policy-pago-anticipado', 'rule/rule-bloqueo-prepago');
      const rows = index.evidenceOf(id);
      expect(rows).toHaveLength(1);
      expect(rows[0].kind).toBe('edge');
      expect(rows[0].evidence.source_type).toBe('interview');
      expect(rows[0].evidence.validated_by).toBe('administracion');
      expect(index.evidenceOf('nothing-here')).toEqual([]);
    } finally {
      index.close();
    }
  });
});

describe('stats', () => {
  it('matches the GraphStats shape exactly', () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      expect(index.stats()).toEqual({
        nodes_total: 6,
        edges_total: 7,
        nodes_by_type: { entity: 2, event: 1, policy: 1, process: 1, rule: 1 },
        edges_by_type: {
          DEPENDS_ON: 2,
          GOVERNS: 1,
          IMPLEMENTED_IN: 1,
          OPERATES_ON: 1,
          TRIGGERS: 1,
          VALIDATES: 1,
        },
        by_status: { active: 12, conflicted: 1 },
        conflicts_open: 1,
        low_confidence_edges: 1,
        evidence_total: 5,
      });
    } finally {
      index.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Embeddings pipeline (Fase 3, docs/03 §3) — incremental by content hash
// ---------------------------------------------------------------------------

describe('updateEmbeddings', () => {
  it('embeds every node on the first pass and nothing on the second', async () => {
    const root = makeRepo();
    const index = openIndex(root);
    const provider = new HashEmbeddingProvider();
    try {
      const first = await index.updateEmbeddings(provider);
      expect(first).toEqual({
        provider: 'hash-char-trigram-256',
        computed: 6,
        removed: 0,
        total: 6,
      });
      const second = await index.updateEmbeddings(provider);
      expect(second.computed).toBe(0);
      expect(second.total).toBe(6);
    } finally {
      index.close();
    }
  });

  it('re-embeds only nodes whose embedded text changed', async () => {
    const root = makeRepo();
    const index = openIndex(root);
    const provider = new HashEmbeddingProvider();
    try {
      await index.updateEmbeddings(provider);
      // Description change → embedded text changes → 1 recompute.
      writeFileSync(
        path.join(root, 'graph', 'entity', 'entity-pedido.md'),
        FIXTURES['entity/entity-pedido.md'].replace(
          'Solicitud de compra registrada en el sistema.',
          'Solicitud de compra confirmada por el comercial.',
        ),
        'utf8',
      );
      index.reindexIfStale();
      const afterDescription = await index.updateEmbeddings(provider);
      expect(afterDescription.computed).toBe(1);

      // Edge-only change → embedded text identical → 0 recomputes.
      writeFileSync(
        path.join(root, 'graph', 'process', 'process-alta-pedido.md'),
        FIXTURES['process/process-alta-pedido.md'].replace('confidence: 0.85', 'confidence: 0.8'),
        'utf8',
      );
      index.reindexIfStale();
      const afterEdgeTweak = await index.updateEmbeddings(provider);
      expect(afterEdgeTweak.computed).toBe(0);
    } finally {
      index.close();
    }
  });

  it('drops orphan vectors but keeps other providers warm', async () => {
    const root = makeRepo();
    const index = openIndex(root);
    const original = new HashEmbeddingProvider();
    try {
      await index.updateEmbeddings(original);
      rmSync(path.join(root, 'graph', 'event', 'event-pedido-creado.md'));
      index.reindexIfStale();
      const smaller = new HashEmbeddingProvider(64);
      const result = await index.updateEmbeddings(smaller);
      // The orphan row goes; the 5 live nodes are embedded with the new
      // provider; the original provider's 5 live vectors stay warm.
      expect(result.removed).toBe(1);
      expect(result.computed).toBe(5);
      expect(result.total).toBe(5);
      expect(index.nodeVectors(smaller.name).size).toBe(5);
      expect(index.nodeVectors(original.name).size).toBe(5);
      // Switching back costs nothing.
      const back = await index.updateEmbeddings(original);
      expect(back.computed).toBe(0);
    } finally {
      index.close();
    }
  });

  it('never caches under-returned or empty vectors, and refuses count mismatches', async () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const short: import('../resolver/index.js').EmbeddingProvider = {
        name: 'broken-short',
        embed: async (texts) => texts.slice(1).map(() => [1, 0]),
      };
      await expect(index.updateEmbeddings(short)).rejects.toThrow(/returned 5 vectors for 6/);

      const sometimesEmpty: import('../resolver/index.js').EmbeddingProvider = {
        name: 'sometimes-empty',
        embed: async (texts) => texts.map((_, i) => (i === 0 ? [] : [1, 0])),
      };
      const result = await index.updateEmbeddings(sometimesEmpty);
      expect(result.computed).toBe(6);
      // The empty vector was NOT cached: the next pass retries exactly it.
      expect(index.nodeVectors('sometimes-empty').size).toBe(5);
    } finally {
      index.close();
    }
  });

  it('nodeVectors returns unit-norm vectors keyed by node id', async () => {
    const root = makeRepo();
    const index = openIndex(root);
    const provider = new HashEmbeddingProvider();
    try {
      await index.updateEmbeddings(provider);
      const vectors = index.nodeVectors(provider.name);
      expect(vectors.size).toBe(6);
      const cliente = vectors.get('entity-cliente')!;
      expect(cliente).toHaveLength(256);
      const norm = Math.sqrt(cliente.reduce((s, v) => s + v * v, 0));
      expect(norm).toBeCloseTo(1, 5);
    } finally {
      index.close();
    }
  });
});

describe('semanticSearch and hybridSearch', () => {
  it('semanticSearch ranks the closest node first', async () => {
    const root = makeRepo();
    const index = openIndex(root);
    const provider = new HashEmbeddingProvider();
    try {
      await index.updateEmbeddings(provider);
      const results = await index.semanticSearch(
        'entity Cliente clientes comprador habitual persona o empresa que realiza pedidos',
        provider,
        { limit: 3 },
      );
      expect(results[0]!.id).toBe('entity-cliente');
      expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
    } finally {
      index.close();
    }
  });

  it('semanticSearch returns nothing for queries with a zero-norm vector', async () => {
    const root = makeRepo();
    const index = openIndex(root);
    const provider = new HashEmbeddingProvider();
    try {
      await index.updateEmbeddings(provider);
      // "!!!" normalizes to an empty string → all-zeros vector.
      expect(await index.semanticSearch('!!!', provider, { limit: 5 })).toEqual([]);
    } finally {
      index.close();
    }
  });

  it('semanticSearch honors the types filter', async () => {
    const root = makeRepo();
    const index = openIndex(root);
    const provider = new HashEmbeddingProvider();
    try {
      await index.updateEmbeddings(provider);
      const results = await index.semanticSearch('pedido', provider, {
        types: ['process'],
        limit: 5,
      });
      expect(results.map((r) => r.type)).toEqual(['process']);
    } finally {
      index.close();
    }
  });

  it('hybridSearch degrades to the lexical channel without a provider', async () => {
    const root = makeRepo();
    const index = openIndex(root);
    try {
      const lexical = index.search('prepago', { limit: 5 });
      const hybrid = await index.hybridSearch('prepago', null, { limit: 5 });
      expect(hybrid.map((r) => r.id)).toEqual(lexical.map((r) => r.id));
    } finally {
      index.close();
    }
  });

  it('hybridSearch fuses both channels with RRF', async () => {
    const root = makeRepo();
    const index = openIndex(root);
    const provider = new HashEmbeddingProvider();
    try {
      await index.updateEmbeddings(provider);
      const results = await index.hybridSearch('bloqueo de pedido sin prepago', provider, {
        limit: 4,
      });
      expect(results[0]!.id).toBe('rule-bloqueo-prepago');
      // Nodes surfaced by both channels outrank single-channel nodes:
      // 2/(60+1) > 1/(60+1) for any single-channel rank-1 result.
      expect(results.length).toBeGreaterThan(1);
      expect(results.length).toBeLessThanOrEqual(4);
    } finally {
      index.close();
    }
  });
});
