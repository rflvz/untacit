import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { DEFAULT_REVIEW_THRESHOLD } from '../constants.js';
import { gitCurrentBranch, gitInit, gitShowFile, gitStatusClean } from '../git.js';
import { configPath } from '../paths.js';
import { defaultConfig, importBatch, initGraphRepo, loadConfig } from './index.js';

const tmp = () => mkdtempSync(join(tmpdir(), 'untacit-config-'));

describe('initGraphRepo git initialization', () => {
  it('gives the graph its OWN .git even when nested inside a parent repo', () => {
    // Regression: a graph created under an existing repo (e.g. the CI smoke
    // fixture, or `untacit init ./graph` from within any project) must still
    // be its own git repo — the self-hosted server rejects a graph dir with no
    // .git (config.ts, docs/07 §3). The old check used isGitRepo(dir), which
    // reports the PARENT work tree and skipped the init.
    const parent = tmp();
    gitInit(parent);
    const graph = join(parent, 'graphs', 'acme');
    initGraphRepo(graph);
    expect(existsSync(join(graph, '.git'))).toBe(true);
    expect(gitStatusClean(graph)).toBe(true);
  });

  it('is idempotent: re-initializing an existing graph repo does not throw', () => {
    const dir = tmp();
    initGraphRepo(dir);
    expect(() => initGraphRepo(dir)).not.toThrow();
    expect(existsSync(join(dir, '.git'))).toBe(true);
  });
});

describe('loadConfig', () => {
  it('returns defaultConfig when the file is missing', () => {
    const dir = tmp();
    expect(loadConfig(dir)).toEqual(defaultConfig());
  });

  it('reads the config written by initGraphRepo', () => {
    const dir = tmp();
    initGraphRepo(dir, { git: false, language: 'en' });
    const config = loadConfig(dir);
    expect(config.language).toBe('en');
    expect(config.thresholds.review).toBe(DEFAULT_REVIEW_THRESHOLD);
    expect(config.sources).toEqual({ code: [], documents: [] });
  });

  it('fills in missing sections of a hand-edited config', () => {
    const dir = tmp();
    writeFileSync(
      configPath(dir),
      JSON.stringify({
        language: 'es',
        sources: { code: [{ name: 'web-pedidos', path: '../web-pedidos' }] },
        thresholds: { review: 0.5 },
      }),
      'utf8',
    );
    const config = loadConfig(dir);
    expect(config.sources.code).toEqual([{ name: 'web-pedidos', path: '../web-pedidos' }]);
    expect(config.sources.documents).toEqual([]);
    expect(config.thresholds.review).toBe(0.5);
    expect(config.thresholds.resolver_auto).toBe(defaultConfig().thresholds.resolver_auto);
    expect(config.schema_version).toBe(defaultConfig().schema_version);
  });
});

describe('importBatch with branch (extraction-as-PR, docs/03 §5)', () => {
  const batch = (runId: string) => ({
    run_id: runId,
    source_type: 'code',
    extractor: { name: 'extractor-code', model: 'test', prompt_version: 'v1' },
    nodes: [
      {
        mention: 'Pedido',
        type: 'entity',
        name: 'Pedido',
        description: 'Pedido de venta.',
        evidence: {
          locator: { repo: 'demo', path: 'src/pedidos.ts', line_start: 1, line_end: 3, commit: 'abc123' },
          excerpt: 'export interface Pedido {}',
        },
      },
    ],
    edges: [],
  });

  it('commits the run on a new branch and returns the working tree to the previous one', async () => {
    const dir = tmp();
    initGraphRepo(dir);
    const before = gitCurrentBranch(dir);
    expect(before).not.toBeNull();

    const result = await importBatch(dir, batch('2026-07-16T10-00-00-code'), {
      branch: 'run/2026-07-16-code',
      embeddings: null,
    });

    expect(result.commit).not.toBeNull();
    expect(result.branch).toBe('run/2026-07-16-code');
    // The proposal lives on the run branch…
    expect(gitShowFile(dir, 'run/2026-07-16-code', 'graph/entity/entity-pedido.md')).toContain('Pedido');
    // …while the checked-out branch keeps its pre-run state, clean.
    expect(gitCurrentBranch(dir)).toBe(before);
    expect(gitStatusClean(dir)).toBe(true);
    expect(existsSync(join(dir, 'graph/entity/entity-pedido.md'))).toBe(false);
    expect(gitShowFile(dir, before!, 'graph/entity/entity-pedido.md')).toBeNull();
  });

  it('rejects an existing branch before writing anything', async () => {
    const dir = tmp();
    initGraphRepo(dir);
    const current = gitCurrentBranch(dir)!;
    await expect(
      importBatch(dir, batch('2026-07-16T11-00-00-code'), { branch: current, embeddings: null }),
    ).rejects.toThrow(/already exists/);
    expect(gitStatusClean(dir)).toBe(true);
  });

  it('rejects branch combined with commit: false', async () => {
    const dir = tmp();
    initGraphRepo(dir);
    await expect(
      importBatch(dir, batch('2026-07-16T12-00-00-code'), { branch: 'run/x', commit: false, embeddings: null }),
    ).rejects.toThrow(/requires committing/);
  });
});
