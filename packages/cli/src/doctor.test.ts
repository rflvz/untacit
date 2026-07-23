import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildIndex, initGraphRepo } from '@untacit/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { doctorChecks } from './doctor.js';
import type { DoctorCheck, DoctorDeps } from './doctor.js';

const here = dirname(fileURLToPath(import.meta.url));
const BIN = join(here, 'bin.ts');
const TSX = join(here, '../../../node_modules/tsx/dist/cli.mjs');

/** Deps where everything is healthy; tests override one seam at a time. */
function healthyDeps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    gitVersion: () => 'git version 2.x (test)',
    claudeAvailable: () => ({ ok: true, detail: 'claude test 1.0.0' }),
    installRoot: () => null,
    checkRemote: () => {
      throw new Error('network disabled in tests');
    },
    transformersAvailable: async () => false,
    ...overrides,
  };
}

function byName(checks: DoctorCheck[], name: string): DoctorCheck {
  const found = checks.find((c) => c.name === name);
  if (!found) throw new Error(`no check named ${name}`);
  return found;
}

let graphRepo: string;

beforeAll(() => {
  graphRepo = mkdtempSync(join(tmpdir(), 'untacit-doctor-'));
  initGraphRepo(graphRepo, { language: 'es', git: true });
});

afterAll(() => {
  rmSync(graphRepo, { recursive: true, force: true });
});

describe('untacit doctor checks', () => {
  it('reports a missing git as fail with an actionable fix', async () => {
    const checks = await doctorChecks(
      { offline: true },
      healthyDeps({
        gitVersion: () => {
          throw new Error('ENOENT');
        },
      }),
    );
    const git = byName(checks, 'git');
    expect(git.status).toBe('fail');
    expect(git.fix).toContain('git');
  });

  it('reports a missing claude engine as warn (querying still works)', async () => {
    const checks = await doctorChecks(
      { offline: true },
      healthyDeps({ claudeAvailable: () => ({ ok: false, detail: 'no claude' }) }),
    );
    const engine = byName(checks, 'claude engine');
    expect(engine.status).toBe('warn');
    expect(engine.fix).toContain('UNTACIT_CLAUDE_BIN');
  });

  it('flags an available update as warn with the update command', async () => {
    const checks = await doctorChecks(
      { offline: false },
      healthyDeps({
        installRoot: () => '/opt/untacit',
        checkRemote: (root) => ({
          root,
          current: 'aaa',
          currentVersion: '0.1.0',
          remote: 'bbb',
          remoteVersion: '0.2.0',
          upToDate: false,
        }),
      }),
    );
    const install = byName(checks, 'install');
    expect(install.status).toBe('warn');
    expect(install.fix).toBe('untacit update');
  });

  it('degrades a failed update check to warn (network hiccup ≠ broken install)', async () => {
    const checks = await doctorChecks(
      { offline: false },
      healthyDeps({ installRoot: () => '/opt/untacit' }),
    );
    expect(byName(checks, 'install').status).toBe('warn');
  });

  it('runs the graph checks on a healthy repo', async () => {
    buildIndex(graphRepo);
    const checks = await doctorChecks({ graph: graphRepo, offline: true }, healthyDeps());
    expect(byName(checks, 'config').status).toBe('ok');
    expect(byName(checks, 'graph git').status).toBe('ok');
    expect(byName(checks, 'index').status).toBe('ok');
  });

  it('fails the config check on a directory that is not a graph repo', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'untacit-doctor-empty-'));
    try {
      const checks = await doctorChecks({ graph: empty, offline: true }, healthyDeps());
      const config = byName(checks, 'config');
      expect(config.status).toBe('fail');
      expect(config.fix).toContain('untacit init');
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('fails the config check on invalid JSON', async () => {
    const broken = mkdtempSync(join(tmpdir(), 'untacit-doctor-json-'));
    try {
      writeFileSync(join(broken, 'untacit.config.json'), '{ nope', 'utf8');
      const checks = await doctorChecks({ graph: broken, offline: true }, healthyDeps());
      expect(byName(checks, 'config').status).toBe('fail');
    } finally {
      rmSync(broken, { recursive: true, force: true });
    }
  });
});

describe('untacit doctor (end to end)', () => {
  it('doctor --json --offline exits 0 with a claude stub and reports every check', () => {
    const stubDir = mkdtempSync(join(tmpdir(), 'untacit-doctor-stub-'));
    try {
      const stub = join(stubDir, 'claude-stub.mjs');
      writeFileSync(stub, "console.log('stub-claude 9.9.9');\n", 'utf8');
      const result = spawnSync(process.execPath, [TSX, BIN, 'doctor', '--json', '--offline'], {
        encoding: 'utf8',
        env: { ...process.env, NO_COLOR: '1', UNTACIT_CLAUDE_BIN: stub },
      });
      expect(result.status).toBe(0);
      const parsed = JSON.parse(result.stdout) as { ok: boolean; checks: DoctorCheck[] };
      expect(parsed.ok).toBe(true);
      expect(byName(parsed.checks, 'git').status).toBe('ok');
      expect(byName(parsed.checks, 'claude engine').detail).toContain('stub-claude 9.9.9');
    } finally {
      rmSync(stubDir, { recursive: true, force: true });
    }
  });

  it('doctor --graph on a non-graph dir exits 2 (findings)', () => {
    const empty = mkdtempSync(join(tmpdir(), 'untacit-doctor-e2e-'));
    try {
      const result = spawnSync(
        process.execPath,
        [TSX, BIN, 'doctor', '--json', '--offline', '--graph', empty],
        { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } },
      );
      expect(result.status).toBe(2);
      const parsed = JSON.parse(result.stdout) as { ok: boolean };
      expect(parsed.ok).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// execFileSync is imported for parity with cli.test.ts helpers but the doctor
// suite drives everything through spawnSync; keep TS happy:
void execFileSync;
