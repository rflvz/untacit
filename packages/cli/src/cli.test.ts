import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, 'bin.ts');
const TSX = join(here, '../../../node_modules/.bin/tsx');
const BATCHES = join(here, '../../../examples/acme-manufactura/batches');

function cli(args: string[]): string {
  return execFileSync(TSX, [BIN, ...args], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
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

  it('conflicts shows opposing evidence', () => {
    const out = cli(['conflicts', '--graph', repo]);
    expect(out).toContain('rule-recargo-por-pedido-urgente');
    expect(out).toContain('-');
    expect(out).toContain('+');
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
