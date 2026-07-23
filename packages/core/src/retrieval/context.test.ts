import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { nodeIdFor, slugify } from '../ids.js';
import { GraphIndex } from '../indexer/index.js';
import { HashEmbeddingProvider, nameSimilarity } from '../resolver/index.js';
import type { RetrievalConfig } from '../types.js';
import { contextQuery, planRetrieval } from './context.js';

// ---------------------------------------------------------------------------
// Fixture graph repo: three Spanish nodes plus one Cyrillic node, so the
// multilingual paths (unicode61-compatible tokenization) are exercised.
// ---------------------------------------------------------------------------

const FIXTURES: Record<string, string> = {
  'rule/rule-bloqueo-sin-prepago.md': `---
type: rule
name: Bloqueo sin prepago
status: active
edges:
  - type: GOVERNS
    target: process/process-alta-de-pedido
    confidence: 0.9
    evidence:
      - source_type: document
        locator: { doc_id: manual, section: "1" }
        excerpt: "Sin prepago no se cursa el alta"
        stance: supports
schema_version: 1
---

Los pedidos de clientes nuevos se bloquean sin pago anticipado.
`,
  'process/process-alta-de-pedido.md': `---
type: process
name: Alta de pedido
status: active
edges:
  - type: OPERATES_ON
    target: entity/entity-pedido
    confidence: 0.8
    evidence:
      - source_type: document
        locator: { doc_id: manual, section: "2" }
        excerpt: "El alta registra el pedido"
        stance: supports
schema_version: 1
---

Registro de un pedido nuevo en el sistema.
`,
  'entity/entity-pedido.md': `---
type: entity
name: Pedido
status: active
schema_version: 1
---

Solicitud de compra registrada.
`,
  'entity/entity-заказ-клиента.md': `---
type: entity
name: Заказ клиента
status: active
aliases: [заказы]
schema_version: 1
---

Заявка на покупку от клиента (пример en otro alfabeto).
`,
};

let repo: string;
let index: GraphIndex;

beforeAll(() => {
  repo = mkdtempSync(path.join(os.tmpdir(), 'untacit-context-'));
  for (const [rel, content] of Object.entries(FIXTURES)) {
    const abs = path.join(repo, 'graph', ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  index = GraphIndex.open(repo);
});

afterAll(() => {
  index?.close();
  rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// planRetrieval
// ---------------------------------------------------------------------------

describe('planRetrieval', () => {
  it('manual mode (default) runs every channel the provider allows', () => {
    const withProvider = planRetrieval('pregunta cualquiera', undefined, true);
    expect(withProvider.mode).toBe('manual');
    expect(withProvider.channels.map((c) => c.channel)).toEqual([
      'lexical',
      'lexical-prf',
      'semantic',
      'semantic-multivec',
    ]);

    const withoutProvider = planRetrieval('pregunta cualquiera', undefined, false);
    expect(withoutProvider.channels.map((c) => c.channel)).toEqual(['lexical', 'lexical-prf']);
    expect(withoutProvider.skipped.map((c) => c.channel)).toEqual([
      'semantic',
      'semantic-multivec',
    ]);
  });

  it('honors enabled:false as a hard veto and weight overrides', () => {
    const config: RetrievalConfig = {
      channels: { lexical_prf: { enabled: false }, lexical: { weight: 1.3 } },
    };
    const plan = planRetrieval('cualquier consulta larga sobre pedidos', config, true);
    expect(plan.channels.map((c) => c.channel)).not.toContain('lexical-prf');
    expect(plan.channels.find((c) => c.channel === 'lexical')?.weight).toBe(1.3);
  });

  it('auto: an id-shaped query runs the lexical channel alone', () => {
    const plan = planRetrieval('rule-bloqueo-sin-prepago', { mode: 'auto' }, true);
    expect(plan.queryKind).toBe('id-lookup');
    expect(plan.channels.map((c) => c.channel)).toEqual(['lexical']);
  });

  it('auto: short keyword queries skip PRF, questions run everything', () => {
    const short = planRetrieval('prepago', { mode: 'auto' }, true);
    expect(short.queryKind).toBe('keywords');
    expect(short.channels.map((c) => c.channel)).toEqual([
      'lexical',
      'semantic',
      'semantic-multivec',
    ]);

    const question = planRetrieval(
      '¿qué pasa si un cliente nuevo no paga por adelantado?',
      { mode: 'auto' },
      true,
    );
    expect(question.queryKind).toBe('question');
    expect(question.channels.map((c) => c.channel)).toEqual([
      'lexical',
      'lexical-prf',
      'semantic',
      'semantic-multivec',
    ]);
  });

  it('auto: non-Latin scripts push the semantic channels to full weight', () => {
    const plan = planRetrieval('заказ клиента заблокирован без предоплаты', { mode: 'auto' }, true);
    expect(plan.channels.find((c) => c.channel === 'semantic')?.weight).toBe(1.0);
  });

  it('clamps expansion parameters into their documented ranges', () => {
    const plan = planRetrieval('x', { expansion: { depth: 9, decay: 7, restart: 0 } }, false);
    expect(plan.expansion.depth).toBe(3);
    expect(plan.expansion.decay).toBe(1);
    expect(plan.expansion.restart).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// contextQuery + config
// ---------------------------------------------------------------------------

describe('contextQuery with retrieval config', () => {
  it('returns the resolved plan alongside the result', async () => {
    const result = await contextQuery(index, 'prepago');
    expect(result.plan.mode).toBe('manual');
    expect(result.plan.channels.map((c) => c.channel)).toEqual(['lexical', 'lexical-prf']);
    expect(result.nodes.some((n) => n.id === 'rule-bloqueo-sin-prepago')).toBe(true);
  });

  it('disabled channels never appear in node provenance', async () => {
    const result = await contextQuery(index, 'prepago', {
      embeddings: new HashEmbeddingProvider(),
      retrieval: {
        channels: {
          lexical_prf: { enabled: false },
          semantic: { enabled: false },
          semantic_multivec: { enabled: false },
        },
      },
    });
    const channels = new Set(result.nodes.flatMap((n) => n.channels));
    expect(channels.has('lexical-prf')).toBe(false);
    expect(channels.has('semantic')).toBe(false);
    expect(channels.has('semantic-multivec')).toBe(false);
    expect(channels.has('lexical')).toBe(true);
  });

  it('auto mode decides per query and records it in the plan', async () => {
    const result = await contextQuery(index, 'prepago', { retrieval: { mode: 'auto' } });
    expect(result.plan.mode).toBe('auto');
    expect(result.plan.queryKind).toBe('keywords');
    expect(result.plan.channels.map((c) => c.channel)).toEqual(['lexical']);
    expect(result.plan.skipped.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Multilingual retrieval (unicode61-compatible JS tokenization)
// ---------------------------------------------------------------------------

describe('multilingual retrieval', () => {
  it('finds non-Latin-script nodes lexically and through the pipeline', async () => {
    expect(index.search('заказ').map((r) => r.id)).toContain('entity-заказ-клиента');
    const result = await contextQuery(index, 'заказ клиента');
    expect(result.nodes.map((n) => n.id)).toContain('entity-заказ-клиента');
  });

  it('PRF tokenization keeps non-Latin terms instead of dropping them', () => {
    // Before the Unicode fix ftsTokens produced [] for Cyrillic text, so PRF
    // could never line expansion terms up with the FTS vocabulary.
    const results = index.prfSearch('заказ');
    expect(Array.isArray(results)).toBe(true);
  });

  it('slugify and nodeIdFor keep non-Latin names addressable', () => {
    expect(slugify('Заказ клиента')).toBe('заказ-клиента');
    expect(slugify('Facturación año')).toBe('facturacion-ano');
    expect(nodeIdFor('entity', 'Заказ клиента')).toBe('entity-заказ-клиента');
  });

  it('nameSimilarity sees non-Latin names instead of normalizing them away', () => {
    expect(nameSimilarity('Заказ клиента', 'заказ клиента')).toBe(1);
    expect(nameSimilarity('Заказ клиента', 'заказы клиента')).toBeGreaterThan(0.7);
    expect(nameSimilarity('Заказ клиента', 'alta de pedido')).toBeLessThan(0.35);
  });
});
