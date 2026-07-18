import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import addFormatsExport from 'ajv-formats';

// CJS/ESM interop under NodeNext (see src/validator/index.ts).
const addFormats = addFormatsExport.default;

import { BATCH_JSON_SCHEMA, validateBatch } from './index.js';
import { MAX_EXCERPT_LENGTH, SCHEMA_VERSION } from '../constants.js';
import type { BatchEdge, BatchEvidence, BatchNode, ExtractionBatch } from '../types.js';

// ---------------------------------------------------------------------------
// Fixtures: realistic Spanish manufacturing content (Diseños NT flavor)
// ---------------------------------------------------------------------------

function codeEvidence(overrides: Partial<BatchEvidence> = {}): BatchEvidence {
  return {
    locator: {
      repo: 'erp-interno',
      path: 'src/facturacion/descuentos.ts',
      line_start: 42,
      line_end: 58,
      commit: 'abc1234',
    },
    excerpt: 'if (pedido.unidades >= 5000) { precio = aplicarDescuentoVolumen(precio); }',
    ...overrides,
  };
}

function node(overrides: Partial<BatchNode>): BatchNode {
  return {
    mention: 'Pedido',
    type: 'entity',
    name: 'Pedido',
    description: 'Encargo de un cliente con líneas de producto, cantidades y precios.',
    evidence: codeEvidence(),
    ...overrides,
  } as BatchNode;
}

function edge(overrides: Partial<BatchEdge>): BatchEdge {
  return {
    type: 'OPERATES_ON',
    source_mention: 'descuento por volumen',
    target_mention: 'Pedido',
    evidence: codeEvidence(),
    ...overrides,
  } as BatchEdge;
}

/** A fully valid batch covering every edge type family used in the tests. */
function validBatch(): ExtractionBatch {
  return {
    run_id: '2026-07-14T09-00-code',
    source_type: 'code',
    schema_version: SCHEMA_VERSION,
    extractor: { name: 'extractor-code', model: 'claude-x', prompt_version: 'v1' },
    nodes: [
      node({
        mention: 'Pedido',
        type: 'entity',
        name: 'Pedido',
        description: 'Encargo de un cliente con líneas de producto y cantidades.',
      }),
      node({
        mention: 'descuento por volumen',
        type: 'rule',
        name: 'Descuento por volumen',
        description:
          'A partir de 5.000 unidades el precio unitario aplica descuento por volumen.',
      }),
      node({
        mention: 'Facturación mensual',
        type: 'process',
        name: 'Facturación mensual',
        description: 'Proceso de emisión de facturas a fin de mes para todos los pedidos servidos.',
      }),
      node({
        mention: 'Alta de pedido',
        type: 'process',
        name: 'Alta de pedido',
        description: 'Registro de un pedido nuevo en el ERP desde la web de pedidos.',
      }),
      node({
        mention: 'pago anticipado a clientes nuevos',
        type: 'policy',
        name: 'Pago anticipado a clientes nuevos',
        description: 'No se sirve mercancía a clientes nuevos sin pago anticipado.',
      }),
      node({
        mention: 'ERP',
        type: 'system',
        name: 'ERP',
        description: 'Sistema central de gestión donde viven pedidos, facturas y stock.',
      }),
      node({
        mention: 'Administración',
        type: 'role',
        name: 'Administración',
        description: 'Departamento que emite facturas y controla los cobros.',
      }),
      node({
        mention: 'Pedido creado',
        type: 'event',
        name: 'Pedido creado',
        description: 'Suceso que se produce al confirmarse un pedido en la web.',
      }),
    ],
    edges: [
      edge({
        type: 'OPERATES_ON',
        source_mention: 'descuento por volumen',
        target_mention: 'Pedido',
      }),
      edge({
        type: 'CALCULATES',
        source_mention: 'descuento por volumen',
        target_mention: 'Pedido',
        attrs: { attribute: 'precio_unitario' },
        stance: 'supports',
      }),
      edge({
        type: 'VALIDATES',
        source_mention: 'descuento por volumen',
        target_mention: 'Alta de pedido',
      }),
      // Accent/case-insensitive mention matching, on purpose:
      edge({
        type: 'GOVERNS',
        source_mention: 'Pago anticipado a clientes nuevos',
        target_mention: 'descuento por volumen',
      }),
      edge({
        type: 'EXECUTES',
        source_mention: 'administración',
        target_mention: 'facturacion mensual',
      }),
      edge({
        type: 'TRIGGERS',
        source_mention: 'Pedido creado',
        target_mention: 'Alta de pedido',
      }),
      edge({
        type: 'IMPLEMENTED_IN',
        source_mention: 'descuento por volumen',
        target_mention: 'ERP',
      }),
      edge({
        type: 'DEPENDS_ON',
        source_mention: 'Facturación mensual',
        target_mention: 'ERP',
      }),
      edge({
        type: 'PART_OF',
        source_mention: 'Alta de pedido',
        target_mention: 'Facturación mensual',
      }),
    ],
  };
}

// ---------------------------------------------------------------------------
// BATCH_JSON_SCHEMA
// ---------------------------------------------------------------------------

describe('BATCH_JSON_SCHEMA', () => {
  it('carries the contract $id and required root fields', () => {
    expect(BATCH_JSON_SCHEMA.$id).toBe('untacit/extraction-batch.v1');
    expect(BATCH_JSON_SCHEMA.required).toEqual(['run_id', 'source_type', 'nodes', 'edges']);
  });

  it('compiles under Ajv 2020-12 and accepts a valid batch', () => {
    const ajv = new Ajv2020({ allErrors: true });
    addFormats(ajv);
    const validate = ajv.compile(BATCH_JSON_SCHEMA);
    expect(validate(validBatch())).toBe(true);
  });

  it('limits evidence excerpts to MAX_EXCERPT_LENGTH', () => {
    const defs = BATCH_JSON_SCHEMA.$defs as Record<string, Record<string, unknown>>;
    const evidence = defs.evidence.properties as Record<string, Record<string, unknown>>;
    expect(evidence.excerpt.maxLength).toBe(MAX_EXCERPT_LENGTH);
  });
});

// ---------------------------------------------------------------------------
// Fully valid batch
// ---------------------------------------------------------------------------

describe('validateBatch — valid batch', () => {
  it('accepts a fully valid batch with zero issues', () => {
    const batch = validBatch();
    const result = validateBatch(batch);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.sanitized).toBeDefined();
    expect(result.sanitized!.nodes).toHaveLength(batch.nodes.length);
    expect(result.sanitized!.edges).toHaveLength(batch.edges.length);
    expect(result.sanitized!.run_id).toBe(batch.run_id);
    expect(result.sanitized!.source_type).toBe('code');
    expect(result.sanitized!.schema_version).toBe(SCHEMA_VERSION);
    expect(result.sanitized!.extractor).toEqual(batch.extractor);
  });

  it('does not mutate the input', () => {
    const batch = validBatch();
    const snapshot = structuredClone(batch);
    validateBatch(batch);
    expect(batch).toEqual(snapshot);
  });

  it('defaults absent stance to "supports" in the sanitized batch', () => {
    const result = validateBatch(validBatch());
    expect(result.valid).toBe(true);
    for (const e of result.sanitized!.edges) {
      expect(['supports', 'contradicts']).toContain(e.stance);
    }
    // The OPERATES_ON edge had no stance in the input:
    expect(result.sanitized!.edges[0]!.stance).toBe('supports');
  });

  it('matches mentions case- and accent-insensitively', () => {
    // validBatch already wires "administración"→"Administración" and
    // "facturacion mensual"→"Facturación mensual".
    const result = validateBatch(validBatch());
    expect(result.valid).toBe(true);
    const executes = result.sanitized!.edges.find((e) => e.type === 'EXECUTES');
    expect(executes).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Malformed root (no salvage)
// ---------------------------------------------------------------------------

describe('validateBatch — malformed root', () => {
  it('rejects a non-object input without sanitized', () => {
    for (const bad of [null, undefined, 42, 'hola', [1, 2]]) {
      const result = validateBatch(bad);
      expect(result.valid).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.sanitized).toBeUndefined();
    }
  });

  it('rejects a batch missing run_id, naming the field', () => {
    const { run_id: _drop, ...rest } = validBatch();
    const result = validateBatch(rest);
    expect(result.valid).toBe(false);
    expect(result.sanitized).toBeUndefined();
    expect(result.issues.some((i) => i.path === 'run_id')).toBe(true);
    expect(result.issues.some((i) => i.message.includes('run_id'))).toBe(true);
  });

  it('rejects a bad source_type with the allowed values in the message', () => {
    const result = validateBatch({ ...validBatch(), source_type: 'email' });
    expect(result.valid).toBe(false);
    expect(result.sanitized).toBeUndefined();
    const issue = result.issues.find((i) => i.path === 'source_type');
    expect(issue).toBeDefined();
    expect(issue!.message).toContain('"email"');
    expect(issue!.message).toContain('code');
    expect(issue!.message).toContain('document');
    expect(issue!.message).toContain('interview');
  });

  it('rejects nodes/edges that are not arrays', () => {
    const result = validateBatch({ ...validBatch(), nodes: {}, edges: 'ninguna' });
    expect(result.valid).toBe(false);
    expect(result.sanitized).toBeUndefined();
    expect(result.issues.some((i) => i.path === 'nodes' && i.message.includes('array'))).toBe(true);
    expect(result.issues.some((i) => i.path === 'edges' && i.message.includes('array'))).toBe(true);
  });

  it('rejects a malformed extractor at root level', () => {
    const result = validateBatch({ ...validBatch(), extractor: { model: 'claude-x' } });
    expect(result.valid).toBe(false);
    expect(result.sanitized).toBeUndefined();
    expect(result.issues.some((i) => i.message.includes('name'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// schema_version (docs/02 §11: incompatible batches are rejected outright)
// ---------------------------------------------------------------------------

describe('validateBatch — schema_version', () => {
  it('rejects the whole batch on an incompatible schema_version with a single issue', () => {
    const result = validateBatch({ ...validBatch(), schema_version: SCHEMA_VERSION + 1 });
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.path).toBe('schema_version');
    expect(result.issues[0]!.message).toContain('incompatible schema_version');
    expect(result.issues[0]!.message).toContain(String(SCHEMA_VERSION));
    expect(result.sanitized).toBeUndefined();
  });

  it('rejects a non-integer schema_version at root level', () => {
    const result = validateBatch({ ...validBatch(), schema_version: 1.5 });
    expect(result.valid).toBe(false);
    expect(result.sanitized).toBeUndefined();
  });

  it('accepts a batch without schema_version', () => {
    const batch = validBatch();
    delete batch.schema_version;
    const result = validateBatch(batch);
    expect(result.valid).toBe(true);
    expect(result.sanitized!.schema_version).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Node-level salvage
// ---------------------------------------------------------------------------

describe('validateBatch — node salvage', () => {
  it('rejects a hallucinated node type and keeps the rest', () => {
    const batch = validBatch();
    const bad = node({ mention: 'tabla clientes', type: 'database_table' as never });
    batch.nodes.push(bad);
    const result = validateBatch(batch);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0]!;
    expect(issue.path).toBe(`nodes/${batch.nodes.length - 1}`);
    expect(issue.message).toContain('"database_table"');
    expect(issue.message).toContain('"type"');
    expect(issue.message).toContain('"entity"'); // allowed values listed
    expect(issue.item).toBe(bad);
    expect(result.sanitized!.nodes).toHaveLength(batch.nodes.length - 1);
    expect(result.sanitized!.edges).toHaveLength(batch.edges.length);
  });

  it('rejects a node whose evidence excerpt exceeds 300 characters', () => {
    const batch = validBatch();
    batch.nodes.push(
      node({
        mention: 'Bobina',
        name: 'Bobina',
        evidence: codeEvidence({ excerpt: 'x'.repeat(MAX_EXCERPT_LENGTH + 1) }),
      }),
    );
    const result = validateBatch(batch);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.path).toBe(`nodes/${batch.nodes.length - 1}`);
    expect(result.issues[0]!.message).toContain('evidence.excerpt');
    expect(result.issues[0]!.message).toContain('300');
    expect(result.sanitized!.nodes).toHaveLength(batch.nodes.length - 1);
  });

  it('rejects a node missing required fields, naming each one', () => {
    const batch = validBatch();
    batch.nodes.push({ mention: 'Bobina', type: 'entity', name: 'Bobina' } as BatchNode);
    const result = validateBatch(batch);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.message).toContain('description');
    expect(result.issues[0]!.message).toContain('evidence');
  });

  it('rejects nodes with blank mention or name after trimming', () => {
    const batch = validBatch();
    batch.nodes.push(node({ mention: '   ', name: 'Bobina' }));
    batch.nodes.push(node({ mention: 'Bobina', name: '  \t ' }));
    const result = validateBatch(batch);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]!.message).toContain('"mention" must be non-empty');
    expect(result.issues[1]!.message).toContain('"name" must be non-empty');
    expect(result.sanitized!.nodes).toHaveLength(batch.nodes.length - 2);
  });

  it('drops duplicate nodes (same mention+type, accent/case-insensitive) keeping the first', () => {
    const batch = validBatch();
    const dupe = node({
      mention: 'pedido', // duplicates "Pedido" (nodes/0) once normalized
      type: 'entity',
      name: 'Pedido duplicado',
    });
    batch.nodes.push(dupe);
    const result = validateBatch(batch);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0]!;
    expect(issue.path).toBe(`nodes/${batch.nodes.length - 1}`);
    expect(issue.message).toContain('duplicate node');
    expect(issue.message).toContain('nodes/0');
    expect(issue.item).toBe(dupe);
    // The first occurrence survives, the duplicate is gone:
    const pedidos = result.sanitized!.nodes.filter(
      (n) => n.type === 'entity' && n.mention.toLowerCase() === 'pedido',
    );
    expect(pedidos).toHaveLength(1);
    expect(pedidos[0]!.name).toBe('Pedido');
    // Edges pointing at the deduped mention still resolve:
    expect(result.sanitized!.edges.some((e) => e.type === 'OPERATES_ON')).toBe(true);
  });

  it('keeps a same-mention node of a DIFFERENT type (not a duplicate)', () => {
    const batch = validBatch();
    batch.nodes.push(
      node({ mention: 'Pedido', type: 'event', name: 'Pedido', description: 'Evento pedido.' }),
    );
    const result = validateBatch(batch);
    expect(result.valid).toBe(true);
    expect(result.sanitized!.nodes).toHaveLength(batch.nodes.length);
  });
});

// ---------------------------------------------------------------------------
// Edge-level salvage
// ---------------------------------------------------------------------------

describe('validateBatch — edge salvage', () => {
  it('rejects a taxonomy-hallucinated edge type with the allowed values', () => {
    const batch = validBatch();
    const bad = edge({ type: 'USES' as never });
    batch.edges.push(bad);
    const result = validateBatch(batch);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    const issue = result.issues[0]!;
    expect(issue.path).toBe(`edges/${batch.edges.length - 1}`);
    expect(issue.message).toContain('"USES"');
    expect(issue.message).toContain('"OPERATES_ON"');
    expect(issue.message).toContain('"PART_OF"');
    expect(issue.item).toBe(bad);
    expect(result.sanitized!.edges).toHaveLength(batch.edges.length - 1);
    expect(result.sanitized!.nodes).toHaveLength(batch.nodes.length);
  });

  it('rejects OPERATES_ON whose source is not a rule', () => {
    const batch = validBatch();
    batch.edges.push(
      edge({
        type: 'OPERATES_ON',
        source_mention: 'Facturación mensual', // process
        target_mention: 'Pedido',
      }),
    );
    const result = validateBatch(batch);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.message).toContain('OPERATES_ON requires source type rule, got process');
    expect(result.sanitized!.edges).toHaveLength(batch.edges.length - 1);
  });

  it('rejects GOVERNS whose source is not a policy', () => {
    const batch = validBatch();
    batch.edges.push(
      edge({
        type: 'GOVERNS',
        source_mention: 'descuento por volumen', // rule
        target_mention: 'Alta de pedido',
      }),
    );
    const result = validateBatch(batch);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.message).toContain('GOVERNS requires source type policy, got rule');
  });

  it('rejects EXECUTES whose target is not a process', () => {
    const batch = validBatch();
    batch.edges.push(
      edge({
        type: 'EXECUTES',
        source_mention: 'Administración', // role: valid source
        target_mention: 'Pedido', // entity: invalid target
      }),
    );
    const result = validateBatch(batch);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.message).toContain('EXECUTES requires target type process, got entity');
  });

  it('rejects PART_OF across types (process → entity)', () => {
    const batch = validBatch();
    batch.edges.push(
      edge({
        type: 'PART_OF',
        source_mention: 'Alta de pedido', // process (valid domain)
        target_mention: 'Pedido', // entity (valid range, but cross-type)
      }),
    );
    const result = validateBatch(batch);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.message).toContain('PART_OF requires source and target of the same type');
    expect(result.issues[0]!.message).toContain('process');
    expect(result.issues[0]!.message).toContain('entity');
  });

  it('rejects edges pointing at an unknown mention', () => {
    const batch = validBatch();
    batch.edges.push(
      edge({
        type: 'DEPENDS_ON',
        source_mention: 'Facturación mensual',
        target_mention: 'Almacén central', // no such node
      }),
    );
    const result = validateBatch(batch);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.message).toContain('unknown mention "Almacén central"');
    expect(result.sanitized!.edges).toHaveLength(batch.edges.length - 1);
  });

  it('cascades: an edge referencing a rejected node is rejected as unknown mention', () => {
    const batch = validBatch();
    const badNode = node({ mention: 'Tirada', type: 'lote' as never, name: 'Tirada' });
    batch.nodes.push(badNode);
    batch.edges.push(
      edge({
        type: 'OPERATES_ON',
        source_mention: 'descuento por volumen',
        target_mention: 'Tirada',
      }),
    );
    const result = validateBatch(batch);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(2);
    const edgeIssue = result.issues.find((i) => i.path.startsWith('edges/'));
    expect(edgeIssue).toBeDefined();
    expect(edgeIssue!.message).toContain('unknown mention "Tirada"');
    expect(result.sanitized!.nodes).toHaveLength(batch.nodes.length - 1);
    expect(result.sanitized!.edges).toHaveLength(batch.edges.length - 1);
  });

  it('rejects an invalid stance and an over-long edge excerpt', () => {
    const batch = validBatch();
    batch.edges.push(edge({ stance: 'denies' as never }));
    batch.edges.push(edge({ evidence: codeEvidence({ excerpt: 'y'.repeat(301) }) }));
    const result = validateBatch(batch);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(2);
    expect(result.issues[0]!.message).toContain('"stance"');
    expect(result.issues[0]!.message).toContain('"supports"');
    expect(result.issues[1]!.message).toContain('evidence.excerpt');
    expect(result.issues[1]!.message).toContain('300');
    expect(result.sanitized!.edges).toHaveLength(batch.edges.length - 2);
  });

  it('rejects an edge missing its evidence', () => {
    const batch = validBatch();
    const bad = {
      type: 'DEPENDS_ON',
      source_mention: 'Facturación mensual',
      target_mention: 'ERP',
    } as BatchEdge;
    batch.edges.push(bad);
    const result = validateBatch(batch);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.message).toContain('missing required field "evidence"');
  });

  it('accepts evidence.validated_by as string or null', () => {
    const batch = validBatch();
    batch.edges.push(
      edge({
        type: 'DEPENDS_ON',
        source_mention: 'Facturación mensual',
        target_mention: 'ERP',
        evidence: codeEvidence({ validated_by: 'administración' }),
      }),
    );
    batch.nodes.push(
      node({
        mention: 'Bobina',
        name: 'Bobina',
        evidence: codeEvidence({ validated_by: null }),
      }),
    );
    const result = validateBatch(batch);
    expect(result.valid).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Fase 0 exit criterion (docs/04): the malformed-batch fixture is rejected
// with recorded reasons, salvaging only the good parts.
// ---------------------------------------------------------------------------

describe('validateBatch — Fase 0 malformed-batch fixture', () => {
  const malformedFixture = {
    run_id: 'run-fase0-malformed',
    source_type: 'code',
    nodes: [
      // Good node — must survive.
      {
        mention: 'Cliente',
        type: 'entity',
        name: 'Cliente',
        description: 'Empresa o persona que compra producto terminado.',
        evidence: {
          locator: { repo: 'erp-interno', path: 'src/clientes.ts', line_start: 10, line_end: 12 },
          excerpt: 'export interface Cliente { id: string; nuevo: boolean }',
        },
      },
      // Hallucinated node type.
      {
        mention: 'tabla_clientes',
        type: 'database_table',
        name: 'tabla_clientes',
        description: 'Tabla SQL de clientes.',
        evidence: { locator: {}, excerpt: 'CREATE TABLE clientes (...)' },
      },
      // Missing description and evidence.
      { mention: 'Pedido', type: 'entity', name: 'Pedido' },
    ],
    edges: [
      // Hallucinated edge type.
      {
        type: 'RELATES_TO',
        source_mention: 'Cliente',
        target_mention: 'Pedido',
        evidence: { locator: {}, excerpt: 'cliente.pedidos' },
      },
      // Unknown/rejected target mention AND domain violation (entity as source).
      {
        type: 'OPERATES_ON',
        source_mention: 'Cliente',
        target_mention: 'Pedido',
        evidence: { locator: {}, excerpt: 'pedido.cliente_id' },
      },
    ],
  };

  it('rejects the fixture, recording an actionable reason per rejection', () => {
    const result = validateBatch(structuredClone(malformedFixture));
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(4); // 2 bad nodes + 2 bad edges
    for (const issue of result.issues) {
      expect(issue.path).toMatch(/^(nodes|edges)\/\d+$/);
      expect(issue.message.length).toBeGreaterThan(10);
      expect(issue.item).toBeDefined();
    }
    expect(result.issues[0]!.message).toContain('"database_table"');
    expect(result.issues[1]!.message).toContain('missing required field');
    expect(result.issues[2]!.message).toContain('"RELATES_TO"');
    expect(result.issues[3]!.message).toContain('unknown mention "Pedido"');
    expect(result.issues[3]!.message).toContain('OPERATES_ON requires source type rule, got entity');
  });

  it('still salvages the good parts', () => {
    const result = validateBatch(structuredClone(malformedFixture));
    expect(result.sanitized).toBeDefined();
    expect(result.sanitized!.run_id).toBe('run-fase0-malformed');
    expect(result.sanitized!.nodes).toHaveLength(1);
    expect(result.sanitized!.nodes[0]!.mention).toBe('Cliente');
    expect(result.sanitized!.edges).toHaveLength(0);
  });
});
