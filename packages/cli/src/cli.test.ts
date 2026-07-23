import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { unicodeOk } from './output.js';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, 'bin.ts');
// Run tsx's actual entry through Node rather than the `.bin/tsx` shim: the
// shim is extensionless (unspawnable on Windows) and its .CMD wrapper would
// still need a shell. `node .../tsx/dist/cli.mjs bin.ts ...` is portable.
const TSX = join(here, '../../../node_modules/tsx/dist/cli.mjs');
const BATCHES = join(here, '../../../examples/acme-manufactura/batches');

function cli(args: string[]): string {
  return execFileSync(process.execPath, [TSX, BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
}

/** Like cli() but never throws: for asserting on exit codes (0/1/2). */
function cliRaw(args: string[]): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(process.execPath, [TSX, BIN, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

/**
 * Hermetic tests: pin embeddings off in a freshly-inited repo so imports
 * never resolve 'auto' to the local multilingual model (a weights download
 * at test time, and semantic fuzzy matching that would change the expected
 * resolution counts). Committed so `git status` stays clean for the
 * idempotence/branch assertions.
 */
function pinEmbeddingsOff(graphRepo: string): void {
  const configPath = join(graphRepo, 'untacit.config.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  writeFileSync(
    configPath,
    `${JSON.stringify({ ...config, embeddings: { provider: 'none' } }, null, 2)}\n`,
    'utf8',
  );
  execFileSync(
    'git',
    ['-c', 'user.name=test', '-c', 'user.email=test@localhost', 'commit', '-am', 'test: pin embeddings off'],
    { cwd: graphRepo, encoding: 'utf8' },
  );
}

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), 'untacit-cli-'));
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe('untacit CLI (Fase 0 exit criteria)', () => {
  it('init creates a graph repo', () => {
    const out = cli(['init', repo]);
    expect(out).toContain('initialized');
    pinEmbeddingsOff(repo);
  });

  it('import materializes a batch and commits a run', () => {
    const out = cli(['import', join(BATCHES, '01-code.json'), '--graph', repo]);
    expect(out).toContain('+20/~0 nodes');
    expect(out).toContain('commit');
  });

  it('re-import of the same batch is a no-op (idempotence)', () => {
    const out = cli(['import', join(BATCHES, '01-code.json'), '--graph', repo]);
    expect(out).toContain('no changes');
    const status = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8' });
    expect(status.trim()).toBe('');
  });

  it('stats reports the graph metrics', () => {
    cli(['import', join(BATCHES, '02-docs.json'), '--graph', repo]);
    cli(['import', join(BATCHES, '03-interview.json'), '--graph', repo]);
    const out = cli(['stats', '--graph', repo]);
    expect(out).toContain('31 nodes, 53 edges');
    expect(out).toContain('open conflicts: 2');
  });

  it('search answers an FTS query', () => {
    const out = cli(['search', 'prepago', '--graph', repo]);
    expect(out).toContain('rule-bloqueo-de-pedido-sin-prepago');
  });

  it('conflicts shows opposing evidence and exits 2 (findings)', () => {
    const { stdout, status } = cliRaw(['conflicts', '--graph', repo]);
    expect(stdout).toContain('rule-recargo-por-pedido-urgente');
    expect(stdout).toContain('-');
    expect(stdout).toContain('+');
    expect(status).toBe(2);
  });

  it('diff between refs reports drift in ontology terms', () => {
    const out = cli(['diff', 'HEAD~1', 'HEAD', '--graph', repo]);
    expect(out).toContain('role-gerencia');
  });

  it('interview --gaps-only reports coverage gaps without an LLM (Fase 4)', () => {
    const out = cli(['interview', '--graph', repo, '--gaps-only']);
    const parsed = JSON.parse(out) as {
      gaps: { kind: string; nodeId: string; detail: string }[];
      verifications: unknown[];
    };
    expect(parsed.gaps.length).toBeGreaterThan(0);
    expect(parsed.gaps.some((g) => g.kind === 'missing-role' && g.nodeId === 'process-expedicion')).toBe(
      true,
    );
    expect(Array.isArray(parsed.verifications)).toBe(true);
  });

  it('interview --resume without a saved session fails with an actionable message', () => {
    const { status, stderr } = cliRaw(['interview', '--graph', repo, '--resume']);
    expect(status).toBe(1);
    expect(stderr).toContain('no hay ninguna sesión');
    expect(stderr).toContain('--resume');
  });

  it('rejects a malformed batch with actionable reasons', () => {
    const bad = join(repo, 'bad-batch.json');
    execFileSync('node', [
      '-e',
      `require('fs').writeFileSync(${JSON.stringify(bad)}, JSON.stringify({ run_id: 'x', source_type: 'code', nodes: [{ mention: 'X', type: 'tabla', name: 'X', description: 'x', evidence: { locator: {}, excerpt: 'x' } }], edges: [] }))`,
    ]);
    const out = cli(['import', bad, '--graph', repo]);
    expect(out).toContain('rejected');
    rmSync(bad, { force: true });
  });
});

describe('agent-friendly output (--json + exit codes)', () => {
  it('stats --json emits machine-readable metrics', () => {
    const parsed = JSON.parse(cli(['stats', '--graph', repo, '--json'])) as {
      nodes_total: number;
      edges_total: number;
      conflicts_open: number;
      runs: { count: number; last: string | null };
    };
    expect(parsed.nodes_total).toBe(31);
    expect(parsed.edges_total).toBe(53);
    expect(parsed.conflicts_open).toBe(2);
    expect(parsed.runs.count).toBeGreaterThanOrEqual(3);
    expect(parsed.runs.last).toBeTruthy();
  });

  it('search --json emits the result array', () => {
    const parsed = JSON.parse(cli(['search', 'prepago', '--graph', repo, '--json'])) as {
      id: string;
    }[];
    expect(parsed.some((r) => r.id === 'rule-bloqueo-de-pedido-sin-prepago')).toBe(true);
  });

  it('conflicts --json emits the conflicts array and still exits 2', () => {
    const { stdout, status } = cliRaw(['conflicts', '--graph', repo, '--json']);
    const parsed = JSON.parse(stdout) as { nodeId: string }[];
    expect(parsed).toHaveLength(2);
    expect(status).toBe(2);
  });

  it('diff --json emits the structured GraphDiff', () => {
    const out = cli(['diff', 'HEAD~1', 'HEAD', '--graph', repo, '--json']);
    const parsed = JSON.parse(out) as { nodes: unknown; edges: unknown };
    expect(parsed.nodes).toBeDefined();
    expect(parsed.edges).toBeDefined();
    expect(out).toContain('role-gerencia');
  });

  it('import --json reports an idempotent re-import as noop', () => {
    const { stdout, status } = cliRaw([
      'import',
      join(BATCHES, '01-code.json'),
      '--graph',
      repo,
      '--json',
    ]);
    expect(status).toBe(0);
    const parsed = JSON.parse(stdout) as { noop: boolean; runId: string };
    expect(parsed.noop).toBe(true);
    expect(parsed.runId).toBeTruthy();
  });

  it('unicodeOk follows the locale, like install.sh', () => {
    expect(unicodeOk({ LANG: 'es_ES.UTF-8' })).toBe(true);
    expect(unicodeOk({ LC_ALL: 'C.utf8' })).toBe(true);
    expect(unicodeOk({ LANG: 'C' })).toBe(false);
    expect(unicodeOk({})).toBe(false);
    expect(unicodeOk({ WT_SESSION: 'x' })).toBe(true);
  });
});

describe('untacit extract docs (Fase 3)', () => {
  it('--sections-only segments documents without any LLM call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'untacit-cli-docs-'));
    writeFileSync(
      join(dir, 'manual.md'),
      '# Manual comercial\n\nIntro.\n\n## Pagos\n\nPrepago a clientes nuevos.\n',
      'utf8',
    );
    const out = cli(['extract', 'docs', join(dir, 'manual.md'), '--sections-only']);
    const sections = JSON.parse(out) as { doc_id: string; section: string; text: string }[];
    expect(sections.map((s) => s.section)).toEqual(['1. Manual comercial', '2. Pagos']);
    expect(sections[0]!.doc_id).toBe('manual');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('untacit import --branch (extraction-as-PR, Fase 5)', () => {
  it('commits the run on a run/<run_id> branch and keeps the current branch clean', () => {
    const prRepo = mkdtempSync(join(tmpdir(), 'untacit-cli-pr-'));
    try {
      cli(['init', prRepo]);
      pinEmbeddingsOff(prRepo);
      const out = cli(['import', join(BATCHES, '01-code.json'), '--graph', prRepo, '--branch']);
      expect(out).toContain('on branch run/2026-07-01T10-00-00-code');
      const status = execFileSync('git', ['status', '--porcelain'], { cwd: prRepo, encoding: 'utf8' });
      expect(status.trim()).toBe('');
      const branches = execFileSync('git', ['branch', '--list'], { cwd: prRepo, encoding: 'utf8' });
      expect(branches).toContain('run/2026-07-01T10-00-00-code');
    } finally {
      rmSync(prRepo, { recursive: true, force: true });
    }
  });
});

describe('untacit extract code (Fase 5: partial re-extraction)', () => {
  it('--candidates-only scopes the scan to --paths without any LLM call', () => {
    const src = mkdtempSync(join(tmpdir(), 'untacit-src-'));
    try {
      writeFileSync(
        join(src, 'checkout.ts'),
        "if (cliente.esNuevo && !pedido.prepagado) { throw new Error('bloqueado'); }\n",
      );
      writeFileSync(join(src, 'infra.ts'), 'export const noop = () => {};\n');

      const all = JSON.parse(cli(['extract', 'code', src, '--candidates-only'])) as { path: string }[];
      expect(all.some((c) => c.path === 'checkout.ts')).toBe(true);

      const scoped = JSON.parse(
        cli(['extract', 'code', src, '--candidates-only', '--paths', 'infra.ts', 'borrado.ts']),
      ) as unknown[];
      expect(scoped).toHaveLength(0);
    } finally {
      rmSync(src, { recursive: true, force: true });
    }
  });
});
