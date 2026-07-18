import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { gitCommitAll, gitInit, gitStatusClean } from '../git.js';
import { diffRefs, diffWorkingTree, formatDiffText, WORKING_TREE_LABEL } from './index.js';

// ---------------------------------------------------------------------------
// Canonical node files written by hand (docs/03 §3 format): YAML frontmatter
// with type/name/status/aliases/edges/schema_version, description as body.
// ---------------------------------------------------------------------------

const RULE_ID = 'rule-bloqueo-pedido-sin-prepago';

const ruleA = `---
type: rule
name: Bloqueo de pedido sin prepago
status: active
aliases:
  - regla de prepago
edges:
  - type: DEPENDS_ON
    target: system/system-erp
    confidence: 0.8
    status: active
    evidence:
      - source_type: code
        locator:
          repo: web-pedidos
          path: src/checkout.ts
          line_start: 10
          line_end: 20
        excerpt: "erp.lookupCustomer(order.customerId)"
        stance: supports
  - type: OPERATES_ON
    target: entity/entity-cliente
    confidence: 0.9
    status: active
    evidence:
      - source_type: code
        locator:
          repo: web-pedidos
          path: src/checkout.ts
          line_start: 84
          line_end: 91
        excerpt: "if (customer.isNew && !order.prepaid) reject(...)"
        stance: supports
  - type: VALIDATES
    target: process/process-alta-pedido
    confidence: 0.7
    status: active
    evidence:
      - source_type: document
        locator:
          doc_id: manual-comercial
          section: "4.2"
        excerpt: "A clientes de nueva incorporación se les exigirá el pago por adelantado"
        stance: supports
schema_version: 1
---

Se rechaza el pedido de un cliente nuevo sin pago registrado.
`;

// Mutations vs ruleA: DEPENDS_ON edge removed, IMPLEMENTED_IN edge added,
// OPERATES_ON status active -> deprecated, VALIDATES confidence 0.7 -> 0.9.
// Name, aliases, attrs and description are untouched, so the node itself
// must NOT appear as changed (edge-only changes never mark the node).
const ruleB = `---
type: rule
name: Bloqueo de pedido sin prepago
status: active
aliases:
  - regla de prepago
edges:
  - type: IMPLEMENTED_IN
    target: system/system-erp
    confidence: 0.9
    status: active
    evidence:
      - source_type: code
        locator:
          repo: web-pedidos
          path: src/checkout.ts
          line_start: 84
          line_end: 91
        excerpt: "if (customer.isNew && !order.prepaid) reject(...)"
        stance: supports
  - type: OPERATES_ON
    target: entity/entity-cliente
    confidence: 0.9
    status: deprecated
    evidence:
      - source_type: code
        locator:
          repo: web-pedidos
          path: src/checkout.ts
          line_start: 84
          line_end: 91
        excerpt: "if (customer.isNew && !order.prepaid) reject(...)"
        stance: supports
  - type: VALIDATES
    target: process/process-alta-pedido
    confidence: 0.9
    status: active
    evidence:
      - source_type: document
        locator:
          doc_id: manual-comercial
          section: "4.2"
        excerpt: "A clientes de nueva incorporación se les exigirá el pago por adelantado"
        stance: supports
schema_version: 1
---

Se rechaza el pedido de un cliente nuevo sin pago registrado.
`;

const processA = `---
type: process
name: Alta de pedido
status: active
schema_version: 1
---

Registro y validación de un pedido nuevo de cliente.
`;

// Only the status changes: node changed with fields === ['status'].
const processB = `---
type: process
name: Alta de pedido
status: deprecated
schema_version: 1
---

Registro y validación de un pedido nuevo de cliente.
`;

const entityCliente = `---
type: entity
name: Cliente
status: active
schema_version: 1
---

Cliente que realiza pedidos a la empresa.
`;

const entityPedido = `---
type: entity
name: Pedido
status: active
schema_version: 1
---

Pedido realizado por un cliente.
`;

const systemErp = `---
type: system
name: ERP
status: active
schema_version: 1
---

Sistema ERP corporativo.
`;

// New node at B, bringing a new edge with it.
const policyB = `---
type: policy
name: Pago anticipado a clientes nuevos
status: active
edges:
  - type: GOVERNS
    target: rule/${RULE_ID}
    confidence: 0.7
    status: active
    evidence:
      - source_type: document
        locator:
          doc_id: manual-comercial
          section: "4.2"
        excerpt: "A clientes de nueva incorporación se les exigirá el pago por adelantado"
        stance: supports
schema_version: 1
---

Los clientes nuevos pagan por adelantado.
`;

// ---------------------------------------------------------------------------
// Fixture: temp graph repo with commit A (initial) and commit B (mutations)
// ---------------------------------------------------------------------------

let repo: string;
let commitA: string;
let commitB: string;

function write(rel: string, content: string): void {
  const filePath = path.join(repo, rel);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'untacit-'));
  gitInit(repo);

  write(`graph/rule/${RULE_ID}.md`, ruleA);
  write('graph/process/process-alta-pedido.md', processA);
  write('graph/entity/entity-cliente.md', entityCliente);
  write('graph/entity/entity-pedido.md', entityPedido);
  write('graph/system/system-erp.md', systemErp);
  commitA = gitCommitAll(repo, 'run A: initial extraction')!;

  // Mutations: add node (+ its edge), remove node, change an edge confidence,
  // change an edge status, change a node status, add an edge, remove an edge.
  write(`graph/rule/${RULE_ID}.md`, ruleB);
  write('graph/process/process-alta-pedido.md', processB);
  write('graph/policy/policy-pago-anticipado-clientes-nuevos.md', policyB);
  fs.rmSync(path.join(repo, 'graph/entity/entity-pedido.md'));
  commitB = gitCommitAll(repo, 'run B: re-extraction')!;
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('fixture sanity', () => {
  it('produced two distinct commits', () => {
    expect(commitA).toMatch(/^[0-9a-f]{40}$/);
    expect(commitB).toMatch(/^[0-9a-f]{40}$/);
    expect(commitA).not.toBe(commitB);
  });

  it('gitCommitAll returns null on a clean tree (pipeline idempotence check)', () => {
    expect(gitStatusClean(repo)).toBe(true);
    expect(gitCommitAll(repo, 'noop')).toBeNull();
  });
});

describe('diffRefs', () => {
  it('yields exactly the expected GraphDiff between run A and run B', () => {
    const diff = diffRefs(repo, commitA, commitB);

    expect(diff.ref_a).toBe(commitA);
    expect(diff.ref_b).toBe(commitB);

    // Nodes sorted by id. The rule node changed only in its edges, so it is
    // absent; entity-cliente and system-erp are untouched.
    expect(diff.nodes).toEqual([
      { id: 'entity-pedido', type: 'entity', kind: 'removed' },
      { id: 'policy-pago-anticipado-clientes-nuevos', type: 'policy', kind: 'added' },
      { id: 'process-alta-pedido', type: 'process', kind: 'changed', fields: ['status'] },
    ]);

    // Edges sorted by (sourceId, type, target); before/after carry only the
    // changed fields.
    expect(diff.edges).toEqual([
      {
        sourceId: 'policy-pago-anticipado-clientes-nuevos',
        type: 'GOVERNS',
        target: `rule/${RULE_ID}`,
        kind: 'added',
      },
      {
        sourceId: RULE_ID,
        type: 'DEPENDS_ON',
        target: 'system/system-erp',
        kind: 'removed',
      },
      {
        sourceId: RULE_ID,
        type: 'IMPLEMENTED_IN',
        target: 'system/system-erp',
        kind: 'added',
      },
      {
        sourceId: RULE_ID,
        type: 'OPERATES_ON',
        target: 'entity/entity-cliente',
        kind: 'changed',
        before: { status: 'active' },
        after: { status: 'deprecated' },
      },
      {
        sourceId: RULE_ID,
        type: 'VALIDATES',
        target: 'process/process-alta-pedido',
        kind: 'changed',
        before: { confidence: 0.7 },
        after: { confidence: 0.9 },
      },
    ]);
  });

  it('is empty for identical refs', () => {
    const diff = diffRefs(repo, commitB, commitB);
    expect(diff.nodes).toEqual([]);
    expect(diff.edges).toEqual([]);
  });

  it('inverts added/removed when the refs are swapped', () => {
    const diff = diffRefs(repo, commitB, commitA);
    expect(diff.nodes).toEqual([
      { id: 'entity-pedido', type: 'entity', kind: 'added' },
      { id: 'policy-pago-anticipado-clientes-nuevos', type: 'policy', kind: 'removed' },
      { id: 'process-alta-pedido', type: 'process', kind: 'changed', fields: ['status'] },
    ]);
    const validates = diff.edges.find((e) => e.type === 'VALIDATES');
    expect(validates).toEqual({
      sourceId: RULE_ID,
      type: 'VALIDATES',
      target: 'process/process-alta-pedido',
      kind: 'changed',
      before: { confidence: 0.9 },
      after: { confidence: 0.7 },
    });
  });

  it('throws on an unknown ref', () => {
    expect(() => diffRefs(repo, commitA, 'no-such-ref')).toThrow();
  });
});

describe('diffWorkingTree', () => {
  it('is empty when the working tree matches HEAD', () => {
    const diff = diffWorkingTree(repo);
    expect(diff.ref_a).toBe('HEAD');
    expect(diff.ref_b).toBe(WORKING_TREE_LABEL);
    expect(diff.nodes).toEqual([]);
    expect(diff.edges).toEqual([]);
  });

  it('matches diffRefs(A, B) when diffing commit A against a clean tree at B', () => {
    const wt = diffWorkingTree(repo, commitA);
    const refs = diffRefs(repo, commitA, commitB);
    expect(wt.nodes).toEqual(refs.nodes);
    expect(wt.edges).toEqual(refs.edges);
  });

  it('detects uncommitted edits', () => {
    const rel = 'graph/entity/entity-cliente.md';
    const edited = entityCliente.replace(
      'Cliente que realiza pedidos a la empresa.',
      'Cliente (empresa o particular) que realiza pedidos.',
    );
    write(rel, edited);
    try {
      const diff = diffWorkingTree(repo);
      expect(diff.nodes).toEqual([
        { id: 'entity-cliente', type: 'entity', kind: 'changed', fields: ['description'] },
      ]);
      expect(diff.edges).toEqual([]);
    } finally {
      write(rel, entityCliente); // restore the committed state
    }
    expect(gitStatusClean(repo)).toBe(true);
  });
});

describe('formatDiffText', () => {
  it('presents the drift in ontology terms with a counts summary first', () => {
    const text = formatDiffText(diffRefs(repo, commitA, commitB));
    const lines = text.split('\n');

    expect(lines[0]).toBe(
      `graph diff ${commitA}..${commitB}: ` +
        'nodes 1 added, 1 removed, 1 changed; edges 2 added, 1 removed, 2 changed',
    );

    expect(text).toContain('+ node policy/policy-pago-anticipado-clientes-nuevos (added)');
    expect(text).toContain('- node entity/entity-pedido (removed)');
    expect(text).toContain('~ node process/process-alta-pedido (changed: status)');

    expect(text).toContain(
      `+ edge policy-pago-anticipado-clientes-nuevos -GOVERNS-> rule/${RULE_ID} (added)`,
    );
    expect(text).toContain(`+ edge ${RULE_ID} -IMPLEMENTED_IN-> system/system-erp (added)`);
    expect(text).toContain(`- edge ${RULE_ID} -DEPENDS_ON-> system/system-erp (removed)`);
    expect(text).toContain(
      `~ edge ${RULE_ID} -VALIDATES-> process/process-alta-pedido: confidence 0.7 -> 0.9`,
    );
    expect(text).toContain(
      `~ edge ${RULE_ID} -OPERATES_ON-> entity/entity-cliente: status active -> deprecated`,
    );

    // Ontology terms only — never raw YAML diff lines.
    expect(text).not.toContain('---');
    expect(text).not.toContain('source_type:');
  });

  it('says "no changes" for an empty diff', () => {
    const text = formatDiffText(diffRefs(repo, commitA, commitA));
    expect(text).toBe(`graph diff ${commitA}..${commitA}: no changes\n`);
  });
});
