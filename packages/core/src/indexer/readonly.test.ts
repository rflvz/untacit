/**
 * Read-only index access for serverless bundles (docs/06 §4.6):
 * checkpointIndex flattens the WAL so the .db travels alone, and
 * GraphIndex.openReadonly opens it without reindexing or writing.
 */

import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { indexDbPath } from '../paths.js';
import { checkpointIndex, GraphIndex } from './index.js';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

const NODE = `---
type: entity
name: Pedido
status: active
schema_version: 1
---

Solicitud de compra registrada en el sistema.
`;

function makeRepo(): string {
  const repo = mkdtempSync(path.join(os.tmpdir(), 'untacit-readonly-'));
  tmpDirs.push(repo);
  mkdirSync(path.join(repo, 'graph', 'entity'), { recursive: true });
  writeFileSync(path.join(repo, 'graph', 'entity', 'entity-pedido.md'), NODE);
  return repo;
}

describe('checkpointIndex + GraphIndex.openReadonly', () => {
  it('flattens the WAL and serves queries without touching disk', () => {
    const repo = makeRepo();
    GraphIndex.open(repo).close(); // build (leaves WAL sidecars)
    checkpointIndex(repo);

    const dbDir = path.dirname(indexDbPath(repo));
    expect(readdirSync(dbDir).filter((f) => f.endsWith('-wal') || f.endsWith('-shm'))).toEqual([]);

    const index = GraphIndex.openReadonly(repo);
    try {
      expect(index.search('pedido').map((r) => r.id)).toEqual(['entity-pedido']);
    } finally {
      index.close();
    }
  });

  it('does not reindex: content added after the checkpoint stays invisible', () => {
    const repo = makeRepo();
    GraphIndex.open(repo).close();
    checkpointIndex(repo);

    writeFileSync(
      path.join(repo, 'graph', 'entity', 'entity-cliente.md'),
      NODE.replace('Pedido', 'Cliente').replace('entity-pedido', 'entity-cliente'),
    );
    const readonly = GraphIndex.openReadonly(repo);
    try {
      expect(readonly.search('cliente')).toEqual([]); // no reindexIfStale
    } finally {
      readonly.close();
    }
    // A regular open() picks it up, proving the file was valid.
    const rw = GraphIndex.open(repo);
    try {
      expect(rw.search('cliente')).toHaveLength(1);
    } finally {
      rw.close();
    }
  });

  it('fails with an actionable error when the index has not been built', () => {
    const repo = makeRepo();
    expect(() => GraphIndex.openReadonly(repo)).toThrow(/build it first/);
  });
});
