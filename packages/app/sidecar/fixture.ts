/**
 * Test fixture: builds a small but complete graph repo in a temp dir using
 * the real core (canonical files, merges.json with a pending proposal, one
 * run, two git commits so /api/diff has something to compare).
 *
 * Only imported from *.test.ts files (vitest resolves @untacit/core to the
 * core sources via vitest.config.ts).
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as core from '@untacit/core';
import type { Evidence, GraphNode } from '@untacit/core';

const codeEvidence = (path: string, lineStart: number, lineEnd: number, excerpt: string): Evidence => ({
  source_type: 'code',
  locator: { repo: 'web-pedidos', path, line_start: lineStart, line_end: lineEnd, commit: 'abc123' },
  excerpt,
  stance: 'supports',
});

const docEvidence = (section: string, excerpt: string, stance: Evidence['stance'] = 'supports'): Evidence => ({
  source_type: 'document',
  locator: { doc_id: 'manual-comercial', title: 'Manual comercial', section },
  excerpt,
  stance,
});

const interviewEvidence = (turn: number, excerpt: string): Evidence => ({
  source_type: 'interview',
  locator: { interview_id: 'entrevista-001', speaker_role: 'administración', turn },
  excerpt,
  stance: 'supports',
});

function node(partial: Omit<GraphNode, 'aliases' | 'status' | 'attrs' | 'evidence' | 'edges' | 'schema_version'> & Partial<GraphNode>): GraphNode {
  return {
    aliases: [],
    status: 'active',
    attrs: {},
    evidence: [],
    edges: [],
    schema_version: core.SCHEMA_VERSION,
    ...partial,
  };
}

/** Edge helper: confidence/status derived from the evidence like the pipeline does. */
function edge(type: core.EdgeType, target: core.NodeRef, evidence: Evidence[]): core.GraphEdge {
  return {
    type,
    target,
    confidence: core.computeEdgeConfidence(evidence),
    status: core.isConflicted(evidence) ? 'conflicted' : 'active',
    evidence,
  };
}

export const FIXTURE_PROPOSAL_ID = 'prop-cliente-nuevo';

/** ids present after createFixtureRepo (first commit: all but the event node). */
export const FIXTURE_NODE_IDS = [
  'entity-cliente',
  'entity-cliente-nuevo',
  'entity-pedido',
  'event-pedido-creado',
  'policy-pago-anticipado-clientes-nuevos',
  'process-alta-pedido',
  'role-comercial',
  'rule-bloqueo-pedido-sin-prepago',
  'system-web-pedidos',
] as const;

export function createFixtureRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'untacit-'));
  writeFileSync(join(root, '.gitignore'), '.untacit/\n', 'utf8');
  writeFileSync(
    join(root, core.CONFIG_FILE),
    `${JSON.stringify(
      {
        language: 'es',
        schema_version: core.SCHEMA_VERSION,
        // Local source roots so POST /api/open can resolve the locators below.
        sources: {
          code: [{ name: 'web-pedidos', path: 'sources/web-pedidos' }],
          documents: [{ path: 'sources/docs' }],
        },
        thresholds: {
          review: core.DEFAULT_REVIEW_THRESHOLD,
          resolver_auto: core.DEFAULT_RESOLVER_THRESHOLDS.auto,
          resolver_gray: core.DEFAULT_RESOLVER_THRESHOLDS.gray,
        },
        // Tests must be hermetic: 'auto' would download the multilingual
        // model on the first import now that transformers.js ships installed.
        embeddings: { provider: 'none' },
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  // Minimal local source files matching the fixture locators (for /api/open).
  mkdirSync(join(root, 'sources/web-pedidos/src'), { recursive: true });
  writeFileSync(
    join(root, 'sources/web-pedidos/src/checkout.ts'),
    'async function createOrder() {}\n',
    'utf8',
  );
  mkdirSync(join(root, 'sources/docs'), { recursive: true });
  writeFileSync(
    join(root, 'sources/docs/manual-comercial.md'),
    '# Manual comercial\n\n## 4.2 Pagos\n\nA clientes de nueva incorporación se les exigirá el pago por adelantado.\n',
    'utf8',
  );

  const store = core.GraphStore.load(root);

  store.upsertNode(
    node({
      id: 'entity-cliente',
      type: 'entity',
      name: 'Cliente',
      description: 'Cliente de la empresa, nuevo o recurrente.',
      aliases: ['clientes'],
      evidence: [codeEvidence('src/models/customer.ts', 1, 20, 'export interface Customer {')],
    }),
  );
  store.upsertNode(
    node({
      id: 'entity-pedido',
      type: 'entity',
      name: 'Pedido',
      description: 'Pedido de mercancía realizado por un cliente.',
      evidence: [codeEvidence('src/models/order.ts', 1, 25, 'export interface Order {')],
    }),
  );
  // Provisional node created by the resolver's gray zone; subject of the
  // pending merge proposal into entity-cliente.
  store.upsertNode(
    node({
      id: 'entity-cliente-nuevo',
      type: 'entity',
      name: 'Cliente nuevo',
      description: 'Cliente de nueva incorporación, sin historial de pagos.',
      evidence: [docEvidence('4.2', 'A clientes de nueva incorporación se les exigirá el pago por adelantado')],
    }),
  );
  store.upsertNode(
    node({
      id: 'process-alta-pedido',
      type: 'process',
      name: 'Alta de pedido',
      description: 'Registro de un pedido nuevo en la web de pedidos.',
      evidence: [codeEvidence('src/checkout.ts', 10, 40, 'async function createOrder(')],
    }),
  );
  store.upsertNode(
    node({
      id: 'rule-bloqueo-pedido-sin-prepago',
      type: 'rule',
      name: 'Bloqueo de pedido sin prepago',
      description: 'Se rechaza el pedido de un cliente nuevo sin pago registrado.',
      aliases: ['regla de prepago'],
      evidence: [codeEvidence('src/checkout.ts', 84, 91, 'if (customer.isNew && !order.prepaid) reject(...)')],
      edges: [
        edge('VALIDATES', 'process/process-alta-pedido', [
          codeEvidence('src/checkout.ts', 84, 91, 'if (customer.isNew && !order.prepaid) reject(...)'),
        ]),
        edge('OPERATES_ON', 'entity/entity-cliente', [
          codeEvidence('src/checkout.ts', 84, 91, 'customer.isNew'),
        ]),
        // Conflicted edge: code supports, document contradicts (docs/02 §6).
        edge('OPERATES_ON', 'entity/entity-pedido', [
          codeEvidence('src/checkout.ts', 84, 91, 'order.prepaid'),
          docEvidence('4.3', 'El prepago solo aplica a pedidos superiores a 3.000 EUR', 'contradicts'),
        ]),
        edge('OPERATES_ON', 'entity/entity-cliente-nuevo', [
          docEvidence('4.2', 'A clientes de nueva incorporación se les exigirá el pago por adelantado'),
        ]),
        edge('IMPLEMENTED_IN', 'system/system-web-pedidos', [
          codeEvidence('src/checkout.ts', 84, 91, 'if (customer.isNew && !order.prepaid) reject(...)'),
        ]),
      ],
    }),
  );
  store.upsertNode(
    node({
      id: 'policy-pago-anticipado-clientes-nuevos',
      type: 'policy',
      name: 'Pago anticipado a clientes nuevos',
      description: 'No se sirve mercancía a clientes nuevos sin pago anticipado.',
      evidence: [docEvidence('4.2', 'A clientes de nueva incorporación se les exigirá el pago por adelantado')],
      edges: [
        edge('GOVERNS', 'rule/rule-bloqueo-pedido-sin-prepago', [
          docEvidence('4.2', 'A clientes de nueva incorporación se les exigirá el pago por adelantado'),
        ]),
      ],
    }),
  );
  store.upsertNode(
    node({
      id: 'system-web-pedidos',
      type: 'system',
      name: 'Web de pedidos',
      description: 'Aplicación web donde los comerciales dan de alta los pedidos.',
      evidence: [codeEvidence('README.md', 1, 3, '# web-pedidos')],
    }),
  );
  store.upsertNode(
    node({
      id: 'role-comercial',
      type: 'role',
      name: 'Comercial',
      description: 'Función comercial: da de alta pedidos y gestiona clientes.',
      evidence: [interviewEvidence(4, 'Los comerciales meten los pedidos en la web')],
      edges: [
        // Unvalidated interview evidence -> confidence 0.6 -> low-confidence tray.
        edge('EXECUTES', 'process/process-alta-pedido', [
          interviewEvidence(4, 'Los comerciales meten los pedidos en la web'),
        ]),
      ],
    }),
  );
  store.write();

  core.saveMergesFile(root, {
    proposals: [
      {
        id: FIXTURE_PROPOSAL_ID,
        sourceNodeId: 'entity-cliente-nuevo',
        targetNodeId: 'entity-cliente',
        mention: 'cliente nuevo',
        score: 0.83,
        status: 'pending',
        created_at: '2026-07-13T10:30:00.000Z',
      },
    ],
    merges: [],
  });

  core.writeRunMeta(root, {
    id: '2026-07-13T10-30-00-code',
    source_type: 'code',
    stats: {
      nodes_created: 8,
      nodes_updated: 0,
      edges_created: 7,
      edges_updated: 0,
      evidence_added: 16,
      rejected: 0,
      merge_proposals: 1,
    },
  });

  core.gitInit(root);
  core.gitCommitAll(root, 'run 2026-07-13T10-30-00-code: initial extraction');

  // Second commit so HEAD~1..HEAD has drift: a new event + TRIGGERS edge.
  const store2 = core.GraphStore.load(root);
  store2.upsertNode(
    node({
      id: 'event-pedido-creado',
      type: 'event',
      name: 'Pedido creado',
      description: 'Se ha registrado un pedido nuevo.',
      evidence: [codeEvidence('src/events.ts', 5, 9, "emit('order:created')")],
      edges: [
        edge('TRIGGERS', 'process/process-alta-pedido', [
          codeEvidence('src/events.ts', 5, 9, "emit('order:created')"),
        ]),
      ],
    }),
  );
  store2.write();
  core.gitCommitAll(root, 'run 2026-07-14T09-00-00-code: add order-created event');

  return root;
}
