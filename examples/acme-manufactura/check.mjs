#!/usr/bin/env node
/**
 * Dataset verification: imports the six Acme batches into a temp graph repo
 * with the real core pipeline and asserts the metrics the README claims.
 * Requires @untacit/core to be built (pnpm --filter @untacit/core build).
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const core = await import(
  join(here, '../../packages/core/dist/index.js')
);

let failures = 0;
function check(label, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

const repo = mkdtempSync(join(tmpdir(), 'acme-check-'));
core.initGraphRepo(repo);
// The dataset's expected metrics were designed for name-based resolution:
// pin embeddings off so the check stays deterministic and offline instead of
// resolving 'auto' to the local multilingual model (workspace-installed).
core.saveConfig(repo, { ...core.loadConfig(repo), embeddings: { provider: 'none' } });

const batches = [
  '01-code.json',
  '02-docs.json',
  '03-interview.json',
  '04-code-extended.json',
  '05-docs-extended.json',
  '06-interview-produccion.json',
];
for (const file of batches) {
  const batch = JSON.parse(readFileSync(join(here, 'batches', file), 'utf8'));
  const validation = core.validateBatch(batch);
  check(`${file} passes the validator with zero issues`, validation.issues.length, 0);
  const result = await core.importBatch(repo, batch, { now: new Date('2026-07-14T12:00:00Z') });
  check(`${file} imports with zero rejections`, result.stats.rejected, 0);
}

// Idempotence (Fase 0 exit criterion): re-import everything, expect a no-op.
for (const file of batches) {
  const batch = JSON.parse(readFileSync(join(here, 'batches', file), 'utf8'));
  const result = await core.importBatch(repo, batch, { now: new Date('2026-07-15T12:00:00Z') });
  check(`${file} re-import is a no-op`, result.noop, true);
}
check('git status clean after re-import', execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), '');

const index = core.GraphIndex.open(repo);
const stats = index.stats();
check('total nodes', stats.nodes_total, 150);
check('total edges', stats.edges_total, 233);
check('open conflicts', stats.conflicts_open, 4);
check('nodes by type', stats.nodes_by_type, {
  entity: 32,
  event: 16,
  policy: 11,
  process: 36,
  role: 12,
  rule: 36,
  system: 7,
});
check('low-confidence review queue has the unvalidated interview edge', stats.low_confidence_edges, 1);

const conflictIds = index
  .conflicts()
  .map((c) => `${c.nodeId} -${c.edgeType}-> ${c.target}`)
  .sort();
check('the four designed conflicts materialize', conflictIds, [
  'rule-aprobacion-de-gerencia-para-pedidos-altos -VALIDATES-> entity/entity-pedido',
  'rule-descuento-por-volumen -CALCULATES-> entity/entity-linea-de-pedido',
  'rule-parada-por-horas-de-uso-de-troqueladora -VALIDATES-> process/process-mantenimiento-preventivo',
  'rule-recargo-por-pedido-urgente -CALCULATES-> entity/entity-pedido',
]);

const bloqueo = index.getNode('rule-bloqueo-de-pedido-sin-prepago');
const triSource = bloqueo.edges.find(
  (e) => e.type === 'VALIDATES' && e.target === 'process/process-alta-de-pedido',
);
check(
  'VALIDATES bloqueo->alta has evidence from the three source types',
  [...new Set(triSource.evidence.filter((ev) => ev.stance === 'supports').map((ev) => ev.source_type))].sort(),
  ['code', 'document', 'interview'],
);
check('and its combined confidence hits the 0.99 ceiling', triSource.confidence, 0.99);

const multiSource = [];
for (const id of ['rule-bloqueo-de-pedido-sin-prepago', 'process-facturacion-mensual', 'policy-pago-anticipado-a-clientes-nuevos']) {
  const node = index.getNode(id);
  for (const e of node.edges) {
    const types = new Set(e.evidence.filter((ev) => ev.stance === 'supports').map((ev) => ev.source_type));
    if (types.size >= 2) multiSource.push(`${id} -${e.type}-> ${e.target}`);
  }
}
check('at least 3 multi-source edges exist', multiSource.length >= 3, true);

check('FTS finds the prepago rule', index.search('prepago').map((r) => r.id), ['rule-bloqueo-de-pedido-sin-prepago']);

// ---------------------------------------------------------------------------
// Fase 6 extended dataset (batches 04–06)
// ---------------------------------------------------------------------------

// Multi-source edges spanning the new business areas.
const fifo = index.getNode('rule-fifo-de-bobinas-por-antiguedad');
const fifoEdge = fifo.edges.find((e) => e.type === 'VALIDATES' && e.target === 'process/process-troquelado');
check(
  'FIFO VALIDATES troquelado is backed by code + validated interview',
  [...new Set(fifoEdge.evidence.filter((ev) => ev.stance === 'supports').map((ev) => ev.source_type))].sort(),
  ['code', 'interview'],
);
check('and reaches the 0.99 ceiling', fifoEdge.confidence, 0.99);

const tecnico = index.getNode('role-tecnico-de-mantenimiento');
const preventivo = tecnico.edges.find(
  (e) => e.type === 'EXECUTES' && e.target === 'process/process-mantenimiento-preventivo',
);
check(
  'EXECUTES técnico->preventivo is backed by document + validated interview at 0.99',
  [preventivo.confidence, [...new Set(preventivo.evidence.map((ev) => ev.source_type))].sort()],
  [0.99, ['document', 'interview']],
);

// The gray-zone resolver proposal (MRP Acme ~ ERP Acme) lands in the queue
// instead of silently merging two different systems.
const merges0 = core.loadMergesFile(repo);
check(
  'the designed gray-zone merge proposal is queued (never auto-merged)',
  merges0.proposals.map((p) => [p.sourceNodeId, p.targetNodeId]),
  [['system-mrp-acme', 'system-erp-acme']],
);

// Impact closure crosses the new areas: from the prepayment policy down to
// picking and the monthly accounting close.
const impact = index.impact('policy-pago-anticipado-a-clientes-nuevos', { direction: 'downstream' });
const impactIds = impact.nodes.map((n) => n.id).sort();
for (const expected of ['process-picking-de-expedicion', 'process-cierre-contable-mensual', 'process-gestion-de-no-conformidades']) {
  check(`downstream impact of the prepayment policy reaches ${expected}`, impactIds.includes(expected), true);
}

// ---------------------------------------------------------------------------
// Fase 3 exit criteria
// ---------------------------------------------------------------------------

// 1. Embeddings pipeline: incremental vectors in the derived index, semantic
//    and hybrid retrieval working offline (deterministic hash provider).
const provider = new core.HashEmbeddingProvider();
const emb1 = await index.updateEmbeddings(provider);
check('embeddings computed for every node', emb1.computed, stats.nodes_total);
const emb2 = await index.updateEmbeddings(provider);
check('re-embedding is incremental (0 recomputes)', emb2.computed, 0);

const semantic = await index.semanticSearch('bloqueo de pedidos sin pago anticipado', provider, { limit: 3 });
check('semantic search ranks the prepago rule first', semantic[0]?.id, 'rule-bloqueo-de-pedido-sin-prepago');
const hybrid = await index.hybridSearch('recargo pedidos urgentes', provider, { limit: 3 });
check('hybrid (RRF) search finds the recargo rule', hybrid[0]?.id, 'rule-recargo-por-pedido-urgente');

// 2. Entity-resolution quality: no two same-type nodes look like evident
//    duplicates (name similarity in or above the gray zone) without an
//    associated merge proposal or merge record.
const merges = core.loadMergesFile(repo);
const linked = new Set();
for (const p of merges.proposals) linked.add(`${p.sourceNodeId}|${p.targetNodeId}`);
for (const m of merges.merges) linked.add(`${m.fromNodeId}|${m.intoNodeId}`);
const store = core.GraphStore.load(repo);
const nodes = [...store.nodes.values()];
const unproposedDuplicates = [];
for (let i = 0; i < nodes.length; i++) {
  for (let j = i + 1; j < nodes.length; j++) {
    const a = nodes[i], b = nodes[j];
    if (a.type !== b.type) continue;
    let score = 0;
    for (const na of [a.name, ...a.aliases]) {
      for (const nb of [b.name, ...b.aliases]) {
        score = Math.max(score, core.nameSimilarity(na, nb));
      }
    }
    if (score >= 0.75 && !linked.has(`${a.id}|${b.id}`) && !linked.has(`${b.id}|${a.id}`)) {
      unproposedDuplicates.push(`${a.id} ~ ${b.id} (${score.toFixed(2)})`);
    }
  }
}
check('no evident duplicates without an associated merge proposal', unproposedDuplicates, []);

// 3. Conflict resolution from the review queue: the human marks the winning
//    evidence, the edge leaves the conflicted state, and identical re-imports
//    never re-open the decision (it is pinned to the evidence set).
const conflict = index
  .conflicts()
  .find((c) => c.nodeId === 'rule-recargo-por-pedido-urgente');
core.resolveConflictEdge(store, {
  nodeId: conflict.nodeId,
  edgeType: conflict.edgeType,
  target: conflict.target,
  winnerKey: conflict.supporting[0].key,
  by: 'administracion',
});
store.write();
core.gitCommitAll(repo, 'untacit: resolve designed conflict (check.mjs)');
index.reindexIfStale();
check('resolving a conflict shrinks the queue to 3', index.stats().conflicts_open, 3);

for (const file of batches) {
  const batch = JSON.parse(readFileSync(join(here, 'batches', file), 'utf8'));
  await core.importBatch(repo, batch, { now: new Date('2026-07-16T12:00:00Z') });
}
index.reindexIfStale();
check('identical re-import does not re-open the resolved conflict', index.stats().conflicts_open, 3);
check('git status clean after the resolution round-trip', execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' }).trim(), '');

index.close();
rmSync(repo, { recursive: true, force: true });

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll dataset checks passed.');
