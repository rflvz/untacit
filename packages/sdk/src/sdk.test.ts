import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { initGraphRepo, loadConfig, saveConfig } from '@untacit/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { Untacit, extractCode, extractDocs, withGraph } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const BATCHES = join(here, '../../../examples/acme-manufactura/batches');

function readBatch(name: string): unknown {
  return JSON.parse(readFileSync(join(BATCHES, name), 'utf8')) as unknown;
}

/**
 * Hermetic tests: pin embeddings off in the freshly-inited repo so imports
 * never resolve 'auto' to the local multilingual model (a weights download at
 * test time). Committed so `git status` stays clean for the idempotence and
 * working-tree diff assertions.
 */
function pinEmbeddingsOff(graphRepo: string): void {
  saveConfig(graphRepo, { ...loadConfig(graphRepo), embeddings: { provider: 'none' } });
  execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '-am', 'test: pin embeddings off'],
    { cwd: graphRepo, encoding: 'utf8' },
  );
}

let repo: string;
let u: Untacit;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'untacit-sdk-'));
  initGraphRepo(repo);
  pinEmbeddingsOff(repo);
  u = Untacit.open(repo);
}, 60_000);

afterAll(() => {
  u?.close();
  rmSync(repo, { recursive: true, force: true });
});

describe('Untacit', () => {
  it('open rejects a directory that is not a graph repo', () => {
    const stray = mkdtempSync(join(tmpdir(), 'untacit-sdk-stray-'));
    try {
      expect(() => Untacit.open(stray)).toThrow(/not a graph repo/i);
    } finally {
      rmSync(stray, { recursive: true, force: true });
    }
  });

  it('importBatch materializes a batch and reports stats', async () => {
    const result = await u.importBatch(readBatch('01-code.json'), {
      now: new Date('2026-07-14T12:00:00Z'),
    });
    expect(result.noop).toBe(false);
    expect(result.stats.nodes_created).toBe(20);
    expect(result.commit).not.toBeNull();
    expect(u.stats().nodes_total).toBe(20);
  });

  it('re-import of an identical batch is a no-op', async () => {
    const result = await u.importBatch(readBatch('01-code.json'), {
      now: new Date('2026-07-14T12:00:00Z'),
    });
    expect(result.noop).toBe(true);
  });

  it('stats reflects the full example dataset', async () => {
    await u.importBatch(readBatch('02-docs.json'), { now: new Date('2026-07-14T12:05:00Z') });
    await u.importBatch(readBatch('03-interview.json'), { now: new Date('2026-07-14T12:10:00Z') });
    const stats = u.stats();
    expect(stats.nodes_total).toBe(31);
    expect(stats.edges_total).toBe(53);
    expect(stats.conflicts_open).toBe(2);
  });

  it('conflicts returns the two open contradictions with opposing evidence', () => {
    const conflicts = u.conflicts();
    expect(conflicts).toHaveLength(2);
    expect(conflicts.some((c) => c.nodeId === 'rule-recargo-por-pedido-urgente')).toBe(true);
    for (const conflict of conflicts) {
      expect(conflict.supporting.length).toBeGreaterThan(0);
      expect(conflict.contradicting.length).toBeGreaterThan(0);
    }
  });

  it('context retrieves the relevant subgraph for a business question', async () => {
    const result = await u.context('prepago');
    expect(result.nodes.map((n) => n.id)).toContain('rule-bloqueo-de-pedido-sin-prepago');
    expect(result.edges.length).toBeGreaterThan(0);
  });

  it('search answers an FTS query', () => {
    const hits = u.search('prepago');
    expect(hits.map((h) => h.id)).toContain('rule-bloqueo-de-pedido-sin-prepago');
  });

  it('explore returns the node with its neighborhood', () => {
    const result = u.explore('rule-bloqueo-de-pedido-sin-prepago');
    expect(result?.node.name).toBeTruthy();
    expect(result?.neighborhood.edges.length).toBeGreaterThan(0);
    expect(u.explore('no-such-node')).toBeUndefined();
  });

  it('impact traverses the blast radius and rejects unknown ids', () => {
    const result = u.impact('policy-pago-anticipado-a-clientes-nuevos', { direction: 'downstream' });
    expect(result).toBeDefined();
    expect(result!.nodes.length).toBeGreaterThan(1);
    expect(u.impact('no-such-node')).toBeUndefined();
  });

  it('paths connects two concepts through evidence chains', () => {
    const result = u.paths('rule-bloqueo-de-pedido-sin-prepago', 'process-alta-de-pedido');
    expect(result?.paths.length).toBeGreaterThan(0);
    expect(result!.paths[0]!.strength).toBeGreaterThan(0);
  });

  it('similar ranks neighbors without an embedding provider', async () => {
    const result = await u.similar('rule-bloqueo-de-pedido-sin-prepago');
    expect(result?.similar.length).toBeGreaterThan(0);
  });

  it('evidence returns the provenance trail of a node', () => {
    const result = u.evidence('rule-bloqueo-de-pedido-sin-prepago');
    expect(result.items.length).toBeGreaterThan(0);
    expect(result.items[0]!.evidence.excerpt).toBeTruthy();
  });

  it('diff between refs reports drift in ontology terms', () => {
    const between = u.diff('HEAD~1', 'HEAD');
    expect(between.nodes.map((n) => n.id)).toContain('role-gerencia');
    // Clean working tree: a bare diff() (HEAD vs working tree) sees nothing.
    const working = u.diff();
    expect(working.nodes).toHaveLength(0);
    expect(working.edges).toHaveLength(0);
  });
});

describe('withGraph', () => {
  it('returns the callback result and closes the handle', async () => {
    const total = await withGraph(repo, (graph) => graph.stats().nodes_total);
    expect(total).toBe(31);
  });

  it('closes the handle even when the callback throws', async () => {
    let captured: Untacit | undefined;
    await expect(
      withGraph(repo, (graph) => {
        captured = graph;
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    // A closed index rejects further queries.
    expect(() => captured!.stats()).toThrow();
  });
});

describe('extraction surface', () => {
  // extractCode/extractDocs need the Claude Code CLI — here we only assert
  // the surface exists (real runs are exercised manually / by the CLI).
  it('exposes extractCode and extractDocs as functions', () => {
    expect(typeof extractCode).toBe('function');
    expect(typeof extractDocs).toBe('function');
  });
});
