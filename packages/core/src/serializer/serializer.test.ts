import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Evidence, GraphNode } from '../types.js';
import {
  deleteNodeFile,
  listNodeFiles,
  loadGraph,
  parseNodeFile,
  readNodeFile,
  serializeNodeFile,
  writeNodeFile,
} from './index.js';

function tmpRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'untacit-'));
}

function codeEvidence(): Evidence {
  return {
    source_type: 'code',
    locator: {
      repo: 'web-pedidos',
      path: 'src/checkout.ts',
      line_start: 84,
      line_end: 91,
      commit: 'abc123',
    },
    excerpt: 'if (customer.isNew && !order.prepaid) reject(order)',
    stance: 'supports',
    extractor: { name: 'extractor-code', model: 'claude-fable-5', prompt_version: 'v1' },
    extracted_at: '2026-07-13',
    run: '2026-07-13T10-30-00-code',
  };
}

function documentEvidence(): Evidence {
  return {
    source_type: 'document',
    locator: { doc_id: 'manual-comercial', title: 'Manual comercial', section: '4.2' },
    excerpt: 'A clientes de nueva incorporación se les exigirá el pago por adelantado',
    stance: 'supports',
    extracted_at: '2026-07-13',
    run: '2026-07-13T11-00-00-document',
    validated_by: null,
  };
}

/** Canonical-form fixture: arrays already in canonical order. */
function fixtureNode(): GraphNode {
  return {
    id: 'rule-bloqueo-pedido-sin-prepago',
    type: 'rule',
    name: 'Bloqueo de pedido sin prepago',
    description: 'Se rechaza el pedido de un cliente nuevo sin pago registrado.',
    aliases: ['bloqueo prepago', 'regla de prepago'],
    status: 'active',
    attrs: { severity: 'alta', threshold: 3000 },
    evidence: [documentEvidence()],
    edges: [
      {
        type: 'OPERATES_ON',
        target: 'entity/entity-cliente',
        confidence: 0.9,
        status: 'active',
        evidence: [codeEvidence()],
      },
      {
        type: 'VALIDATES',
        target: 'process/process-alta-pedido',
        confidence: 0.95,
        status: 'active',
        attrs: { attribute: 'estado' },
        evidence: [codeEvidence(), documentEvidence()],
      },
    ],
    schema_version: 1,
  };
}

function minimalNode(): GraphNode {
  return {
    id: 'entity-cliente',
    type: 'entity',
    name: 'Cliente',
    description: 'Objeto de negocio sobre el que operan pedidos y facturas.',
    aliases: [],
    status: 'active',
    attrs: {},
    evidence: [],
    edges: [],
    schema_version: 1,
  };
}

describe('serializeNodeFile / parseNodeFile', () => {
  it('round-trips a full node (parse(serialize(n)) deep-equals n)', () => {
    const node = fixtureNode();
    const parsed = parseNodeFile(serializeNodeFile(node), node.id);
    expect(parsed).toEqual(node);
  });

  it('round-trips a minimal node with empty collections', () => {
    const node = minimalNode();
    const parsed = parseNodeFile(serializeNodeFile(node), node.id);
    expect(parsed).toEqual(node);
  });

  it('emits the exact canonical bytes for a minimal node', () => {
    expect(serializeNodeFile(minimalNode())).toBe(
      '---\n' +
        'type: entity\n' +
        'name: Cliente\n' +
        'status: active\n' +
        'schema_version: 1\n' +
        '---\n' +
        '\n' +
        'Objeto de negocio sobre el que operan pedidos y facturas.\n',
    );
  });

  it('is deterministic: serialize twice and serialize(parse(serialize(n))) are identical', () => {
    const node = fixtureNode();
    const first = serializeNodeFile(node);
    const second = serializeNodeFile(fixtureNode());
    expect(second).toBe(first);
    expect(serializeNodeFile(parseNodeFile(first, node.id))).toBe(first);
  });

  it('never puts the id in the frontmatter', () => {
    const text = serializeNodeFile(fixtureNode());
    const frontmatter = text.split('---')[1];
    expect(frontmatter).not.toMatch(/^id:/m);
    expect(frontmatter).not.toContain('rule-bloqueo-pedido-sin-prepago');
  });

  it('is independent of object key insertion order', () => {
    const a = fixtureNode();
    const b = fixtureNode();
    // Rebuild nested objects with reversed key insertion order.
    b.attrs = { threshold: 3000, severity: 'alta' };
    b.edges[0].evidence[0].locator = {
      commit: 'abc123',
      line_end: 91,
      line_start: 84,
      path: 'src/checkout.ts',
      repo: 'web-pedidos',
    };
    b.evidence[0].locator = {
      section: '4.2',
      title: 'Manual comercial',
      doc_id: 'manual-comercial',
    };
    expect(serializeNodeFile(b)).toBe(serializeNodeFile(a));
  });

  it('sorts and dedupes aliases, sorts edges by (type, target) and evidence by (source_type, locator, excerpt)', () => {
    const node = fixtureNode();
    node.aliases = ['regla de prepago', 'bloqueo prepago', 'regla de prepago'];
    node.edges = [node.edges[1], node.edges[0]];
    node.edges[0].evidence = [documentEvidence(), codeEvidence()];
    const parsed = parseNodeFile(serializeNodeFile(node), node.id);
    expect(parsed).toEqual(fixtureNode());
  });

  it('always double-quotes excerpt values', () => {
    const text = serializeNodeFile(fixtureNode());
    expect(text).toContain('excerpt: "if (customer.isNew && !order.prepaid) reject(order)"');
    expect(text).toContain(
      'excerpt: "A clientes de nueva incorporación se les exigirá el pago por adelantado"',
    );
  });

  it('survives Spanish accents, quotes and colons in names, aliases and excerpts', () => {
    const node = minimalNode();
    node.id = 'process-facturacion-mensual';
    node.type = 'process';
    node.name = 'Facturación: cierre "mensual" — año fiscal';
    node.description = 'Descripción con tildes: facturación, niño, güito. Y "comillas".';
    node.aliases = ['cierre: mensual', 'facturación año'];
    node.evidence = [
      {
        source_type: 'interview',
        locator: { interview_id: 'entrevista-01', speaker_role: 'administración', turn: 12 },
        excerpt: 'La facturación se hace "a mes vencido": siempre, sí o sí',
        stance: 'supports',
        validated_by: 'administración',
      },
    ];
    const text = serializeNodeFile(node);
    const parsed = parseNodeFile(text, node.id);
    expect(parsed).toEqual(node);
    // still canonical after a round trip
    expect(serializeNodeFile(parsed)).toBe(text);
  });

  it('emits shortest-decimal confidences', () => {
    const node = fixtureNode();
    node.edges[0].confidence = 0.9;
    node.edges[1].confidence = 0.99;
    const text = serializeNodeFile(node);
    expect(text).toContain('confidence: 0.9\n');
    expect(text).toContain('confidence: 0.99\n');
    expect(text).not.toContain('confidence: 0.90');
  });

  it('throws on content without frontmatter', () => {
    expect(() => parseNodeFile('just a body\n', 'entity-x')).toThrow(/frontmatter/);
  });
});

describe('writeNodeFile / readNodeFile / deleteNodeFile', () => {
  it('writes graph/<type>/<id>.md and reads it back (id from basename)', () => {
    const repo = tmpRepo();
    const node = fixtureNode();
    const filePath = writeNodeFile(repo, node);
    expect(filePath).toBe(path.join(repo, 'graph', 'rule', 'rule-bloqueo-pedido-sin-prepago.md'));
    expect(fs.existsSync(filePath)).toBe(true);
    expect(readNodeFile(filePath)).toEqual(node);
  });

  it('skips the write when the file already has identical bytes (mtime unchanged)', () => {
    const repo = tmpRepo();
    const node = fixtureNode();
    const filePath = writeNodeFile(repo, node);
    const past = new Date('2020-01-01T00:00:00Z');
    fs.utimesSync(filePath, past, past);
    const before = fs.statSync(filePath).mtimeMs;

    const again = writeNodeFile(repo, fixtureNode());
    expect(again).toBe(filePath);
    expect(fs.statSync(filePath).mtimeMs).toBe(before);

    // a real change does rewrite
    node.description = 'Descripción nueva.';
    writeNodeFile(repo, node);
    expect(fs.statSync(filePath).mtimeMs).not.toBe(before);
    expect(readNodeFile(filePath).description).toBe('Descripción nueva.');
  });

  it('deleteNodeFile removes the file and is a no-op when missing', () => {
    const repo = tmpRepo();
    const node = minimalNode();
    const filePath = writeNodeFile(repo, node);
    deleteNodeFile(repo, node);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(() => deleteNodeFile(repo, node)).not.toThrow();
  });
});

describe('listNodeFiles / loadGraph', () => {
  it('lists all node files sorted and loads them into an id → node map', () => {
    const repo = tmpRepo();
    const rule = fixtureNode();
    const entity = minimalNode();
    writeNodeFile(repo, rule);
    writeNodeFile(repo, entity);

    const files = listNodeFiles(repo);
    expect(files).toEqual(
      [
        path.join(repo, 'graph', 'entity', 'entity-cliente.md'),
        path.join(repo, 'graph', 'rule', 'rule-bloqueo-pedido-sin-prepago.md'),
      ].sort(),
    );

    const graph = loadGraph(repo);
    expect(graph.size).toBe(2);
    expect(graph.get(entity.id)).toEqual(entity);
    expect(graph.get(rule.id)).toEqual(rule);
  });

  it('returns empty results for a repo without a graph dir', () => {
    const repo = tmpRepo();
    expect(listNodeFiles(repo)).toEqual([]);
    expect(loadGraph(repo).size).toBe(0);
  });
});
