#!/usr/bin/env node
/**
 * Fase 5 eval runner: verifies the 10 read-only evals of evals.json against
 * the REAL MCP server (same tools, schemas and structuredContent an agent
 * sees), over a temp graph repo built from the six Acme batches.
 *
 * This is the deterministic half of the Fase 5 gate: each eval's
 * `verification` recipe is executed as actual MCP tool calls and asserted
 * mechanically, so CI proves the graph answers every question. The LLM half
 * (an agent connected only to the MCP scoring >= 8/10) is recorded in
 * RESULTS.md.
 *
 * Requires core and mcp to be built (pnpm build).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const core = await import(pathToFileURL(join(here, '../../../packages/core/dist/index.js')));
const mcp = await import(pathToFileURL(join(here, '../../../packages/mcp/dist/index.js')));

// Resolve the MCP SDK through packages/mcp's own dependency tree (pnpm).
const requireFromMcp = createRequire(join(here, '../../../packages/mcp/package.json'));
const { Client } = await import(pathToFileURL(requireFromMcp.resolve('@modelcontextprotocol/sdk/client/index.js')));
const { InMemoryTransport } = await import(pathToFileURL(requireFromMcp.resolve('@modelcontextprotocol/sdk/inMemory.js')));

// ---------------------------------------------------------------------------
// Graph repo from the six batches
// ---------------------------------------------------------------------------

const repo = mkdtempSync(join(tmpdir(), 'acme-evals-'));
core.initGraphRepo(repo);
for (const file of [
  '01-code.json',
  '02-docs.json',
  '03-interview.json',
  '04-code-extended.json',
  '05-docs-extended.json',
  '06-interview-produccion.json',
]) {
  const batch = JSON.parse(readFileSync(join(here, '../batches', file), 'utf8'));
  await core.importBatch(repo, batch, { now: new Date('2026-07-14T12:00:00Z') });
}

// ---------------------------------------------------------------------------
// Real MCP server + client over an in-memory transport
// ---------------------------------------------------------------------------

const server = mcp.createServer(repo);
const client = new Client({ name: 'acme-evals', version: '1.0.0' });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
await server.connect(serverTransport);
await client.connect(clientTransport);

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    throw new Error(`${name} returned an error: ${result.content?.[0]?.text ?? 'unknown'}`);
  }
  return result.structuredContent;
}

// ---------------------------------------------------------------------------
// Assertions per eval (mirroring the `verification` field of evals.json)
// ---------------------------------------------------------------------------

const evals = JSON.parse(readFileSync(join(here, 'evals.json'), 'utf8')).evals;
let failures = 0;

async function evalCase(id, fn) {
  const spec = evals.find((e) => e.id === id);
  try {
    await fn();
    console.log(`ok   ${id} — ${spec.question}`);
  } catch (err) {
    failures++;
    console.log(`FAIL ${id} — ${spec.question}\n     ${err.message}`);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

const edgeIn = (edges, source, type, targetId) =>
  edges.find((e) => e.source === source && e.type === type && e.targetId === targetId);

await evalCase('eval-01', async () => {
  const ctx = await call('untacit_context', { query: 'prepago' });
  const rule = ctx.nodes.find((n) => n.id === 'rule-bloqueo-de-pedido-sin-prepago');
  assert(rule, 'context("prepago") does not surface rule-bloqueo-de-pedido-sin-prepago');
  assert(
    edgeIn(ctx.edges, 'rule-bloqueo-de-pedido-sin-prepago', 'IMPLEMENTED_IN', 'system-web-de-pedidos'),
    'missing IMPLEMENTED_IN edge to system-web-de-pedidos',
  );
});

await evalCase('eval-02', async () => {
  const ex = await call('untacit_explore', { node_id: 'rule-bloqueo-de-pedido-sin-prepago' });
  const governs = edgeIn(
    ex.neighborhood.edges,
    'policy-pago-anticipado-a-clientes-nuevos',
    'GOVERNS',
    'rule-bloqueo-de-pedido-sin-prepago',
  );
  assert(governs, 'missing incoming GOVERNS from policy-pago-anticipado-a-clientes-nuevos');
  const ev = await call('untacit_evidence', { id: governs.id });
  const types = ev.items.map((i) => i.evidence.source_type);
  assert(types.includes('document'), 'GOVERNS edge lacks document evidence');
  assert(
    ev.items.some((i) => i.evidence.source_type === 'interview' && i.evidence.validated_by === 'administracion'),
    'GOVERNS edge lacks interview evidence validated_by administracion',
  );
});

await evalCase('eval-03', async () => {
  const { conflicts } = await call('untacit_conflicts', {});
  assert(conflicts.length === 4, `expected exactly 4 open conflicts, got ${conflicts.length}`);
  const keys = conflicts.map((c) => `${c.nodeId} -${c.edgeType}-> ${c.target}`).sort();
  const expected = [
    'rule-aprobacion-de-gerencia-para-pedidos-altos -VALIDATES-> entity/entity-pedido',
    'rule-descuento-por-volumen -CALCULATES-> entity/entity-linea-de-pedido',
    'rule-parada-por-horas-de-uso-de-troqueladora -VALIDATES-> process/process-mantenimiento-preventivo',
    'rule-recargo-por-pedido-urgente -CALCULATES-> entity/entity-pedido',
  ];
  assert(
    keys.length === expected.length && keys.every((k, i) => k === expected[i]),
    `unexpected conflict set: ${keys.join(' | ')}`,
  );
});

await evalCase('eval-04', async () => {
  const { conflicts } = await call('untacit_conflicts', {});
  const c = conflicts.find((x) => x.nodeId === 'rule-aprobacion-de-gerencia-para-pedidos-altos');
  assert(c, 'missing the gerencia-approval conflict');
  assert(
    c.supporting.some((ev) => ev.source_type === 'code' && /LIMITE_APROBACION|importeTotal/.test(ev.excerpt)),
    'supporting code evidence with the amount-based approval condition not found',
  );
  assert(
    c.contradicting.some((ev) => ev.source_type === 'document'),
    'contradicting document evidence (manual de procedimientos) not found',
  );
});

await evalCase('eval-05', async () => {
  const { conflicts } = await call('untacit_conflicts', {});
  const c = conflicts.find((x) => x.nodeId === 'rule-recargo-por-pedido-urgente');
  assert(c, 'missing the recargo-urgente conflict');
  assert(c.supporting.length === 1 && c.supporting[0].source_type === 'code', 'expected 1 supporting code evidence');
  const contra = c.contradicting.map((ev) => ev.source_type).sort();
  assert(
    contra.length === 2 && contra[0] === 'document' && contra[1] === 'interview',
    `expected contradicting document+interview, got ${contra.join(',')}`,
  );
});

await evalCase('eval-06', async () => {
  const impact = await call('untacit_impact', {
    node_id: 'policy-pago-anticipado-a-clientes-nuevos',
    direction: 'downstream',
  });
  const at = (id) => impact.nodes.find((n) => n.id === id);
  for (const direct of ['process-alta-de-pedido', 'process-gestion-de-reclamaciones']) {
    assert(at(direct)?.distance === 1, `${direct} not at distance 1`);
  }
  for (const transitive of [
    'process-planificacion-de-la-produccion',
    'process-troquelado',
    'process-expedicion',
    'process-picking-de-expedicion',
    'process-facturacion-mensual',
    'process-cierre-contable-mensual',
    'process-gestion-de-no-conformidades',
  ]) {
    assert(at(transitive) && at(transitive).distance >= 2, `${transitive} missing from the transitive closure`);
  }
});

await evalCase('eval-07', async () => {
  const ex = await call('untacit_explore', { node_id: 'process-facturacion-mensual' });
  const executes = edgeIn(ex.neighborhood.edges, 'role-administracion', 'EXECUTES', 'process-facturacion-mensual');
  assert(executes, 'missing incoming EXECUTES from role-administracion');
  assert(executes.confidence === 0.99, `expected confidence 0.99, got ${executes.confidence}`);
  const ev = await call('untacit_evidence', { id: executes.id });
  const types = ev.items.map((i) => i.evidence.source_type).sort();
  assert(
    types.includes('document') && types.includes('interview'),
    `expected document+interview evidence, got ${types.join(',')}`,
  );
});

await evalCase('eval-08', async () => {
  const plan = await call('untacit_explore', { node_id: 'process-planificacion-de-la-produccion' });
  assert(
    edgeIn(plan.neighborhood.edges, 'event-pedido-creado', 'TRIGGERS', 'process-planificacion-de-la-produccion'),
    'planning is not triggered by event-pedido-creado',
  );
  const event = await call('untacit_explore', { node_id: 'event-pedido-creado' });
  assert(
    edgeIn(event.neighborhood.edges, 'process-alta-de-pedido', 'TRIGGERS', 'event-pedido-creado'),
    'event-pedido-creado is not produced by process-alta-de-pedido',
  );
});

await evalCase('eval-09', async () => {
  const ex = await call('untacit_explore', { node_id: 'rule-asignacion-de-bobina-por-gramaje' });
  assert(
    edgeIn(ex.neighborhood.edges, 'rule-asignacion-de-bobina-por-gramaje', 'DEPENDS_ON', 'rule-calculo-de-merma-de-bobina'),
    'missing DEPENDS_ON to rule-calculo-de-merma-de-bobina',
  );
  const merma = await call('untacit_explore', { node_id: 'rule-calculo-de-merma-de-bobina' });
  assert(
    edgeIn(merma.neighborhood.edges, 'rule-calculo-de-merma-de-bobina', 'CALCULATES', 'entity-bobina'),
    'merma rule does not CALCULATES entity-bobina',
  );
});

await evalCase('eval-10', async () => {
  const ex = await call('untacit_explore', { node_id: 'process-control-de-calidad-de-tirada' });
  const edges = ex.neighborhood.edges;
  assert(
    edgeIn(edges, 'policy-calidad-obligatoria-por-tirada', 'GOVERNS', 'process-control-de-calidad-de-tirada'),
    'missing GOVERNS from policy-calidad-obligatoria-por-tirada',
  );
  assert(
    edgeIn(edges, 'role-jefe-de-produccion', 'EXECUTES', 'process-control-de-calidad-de-tirada'),
    'missing EXECUTES from role-jefe-de-produccion',
  );
  assert(
    edgeIn(edges, 'process-control-de-calidad-de-tirada', 'PART_OF', 'process-troquelado'),
    'missing PART_OF to process-troquelado',
  );
});

// ---------------------------------------------------------------------------

await client.close();
await server.close();
rmSync(repo, { recursive: true, force: true });

const passed = evals.length - failures;
console.log(`\n${passed}/${evals.length} evals verified against the MCP server`);
if (failures > 0) {
  console.error(`${failures} eval(s) failed`);
  process.exit(1);
}
