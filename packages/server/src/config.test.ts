import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { graphResourceUrl, loadServerConfig, resolveDataDir } from './config.js';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

/** A directory that passes the "is a git repo" startup check. */
function makeGraphDir(base: string, name: string): string {
  const dir = join(base, name);
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

function writeConfig(overrides: Record<string, unknown> = {}, graphIds = ['acme']): string {
  const dir = mkdtempSync(join(tmpdir(), 'untacit-server-config-'));
  tmpDirs.push(dir);
  const graphs = graphIds.map((id) => {
    makeGraphDir(dir, id);
    return { id, path: id };
  });
  const config = {
    publicUrl: 'https://untacit.example.com',
    graphs,
    ...overrides,
  };
  const path = join(dir, 'untacit-server.config.json');
  writeFileSync(path, JSON.stringify(config, null, 2));
  return path;
}

const quiet = { warn: () => {} };

describe('loadServerConfig', () => {
  it('loads a minimal config with defaults and resolves graph paths', () => {
    const configPath = writeConfig();
    const config = loadServerConfig({ configPath, ...quiet });
    expect(config.mode).toBe('stateful');
    expect(config.port).toBe(8787);
    expect(config.host).toBe('0.0.0.0');
    expect(config.auth.accessTokenTtlSeconds).toBe(3600);
    expect(config.session.maxSessionsPerUser).toBe(20);
    expect(config.embeddings.refresh).toBe('auto');
    expect(config.security.trustProxy).toBe(false);
    expect(config.graphs).toHaveLength(1);
    expect(config.graphs[0]!.name).toBe('acme');
    expect(config.graphs[0]!.tools).toBe('query');
    expect(config.graphs[0]!.path.endsWith('/acme')).toBe(true);
    expect(config.dataDir).toBe(join(configPath, '..'));
  });

  it('rejects missing files, bad JSON, unknown keys and bad graph ids', () => {
    expect(() => loadServerConfig({ configPath: '/nowhere/x.json', ...quiet })).toThrow(/not found/);

    const dir = mkdtempSync(join(tmpdir(), 'untacit-server-config-'));
    tmpDirs.push(dir);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{ nope');
    expect(() => loadServerConfig({ configPath: bad, ...quiet })).toThrow(/not valid JSON/);

    expect(() => loadServerConfig({ configPath: writeConfig({ typo: true }), ...quiet })).toThrow(
      /Invalid config/,
    );
    expect(() =>
      loadServerConfig({ configPath: writeConfig({}, ['Not Valid!']), ...quiet }),
    ).toThrow(/must match/);
  });

  it('accepts numeric and boolean trustProxy and rejects the min(1) boundary', () => {
    // trustProxy feeds Express `trust proxy`, which governs req.ip and thus the
    // per-IP login rate-limit key — a security-relevant knob, so pin the schema.
    expect(
      loadServerConfig({ configPath: writeConfig({ security: { trustProxy: 2 } }), ...quiet }).security
        .trustProxy,
    ).toBe(2);
    expect(
      loadServerConfig({ configPath: writeConfig({ security: { trustProxy: true } }), ...quiet })
        .security.trustProxy,
    ).toBe(true);
    expect(() =>
      loadServerConfig({ configPath: writeConfig({ security: { trustProxy: 0 } }), ...quiet }),
    ).toThrow(/Invalid config/);
  });

  it('fails fast when a graph path is missing or not a git repo', () => {
    const configPath = writeConfig();
    const dir = join(configPath, '..');
    writeFileSync(
      configPath,
      JSON.stringify({ publicUrl: 'https://x.example.com', graphs: [{ id: 'ghost', path: 'ghost' }] }),
    );
    expect(() => loadServerConfig({ configPath, ...quiet })).toThrow(/does not exist/);

    mkdirSync(join(dir, 'ghost'), { recursive: true });
    expect(() => loadServerConfig({ configPath, ...quiet })).toThrow(/not a git repository/);
  });

  it('rejects duplicate graph ids', () => {
    expect(() => loadServerConfig({ configPath: writeConfig({}, ['acme', 'acme']), ...quiet })).toThrow(
      /Duplicate graph id/,
    );
  });

  it('requires https for non-loopback public URLs and rejects query strings', () => {
    expect(() =>
      loadServerConfig({ configPath: writeConfig({ publicUrl: 'http://untacit.example.com' }), ...quiet }),
    ).toThrow(/must be https/);
    expect(() =>
      loadServerConfig({ configPath: writeConfig({ publicUrl: 'https://x.example.com/?a=1' }), ...quiet }),
    ).toThrow(/query string/);
    // Loopback http is fine (tests, local dev).
    const config = loadServerConfig({
      configPath: writeConfig({ publicUrl: 'http://127.0.0.1:8787' }),
      ...quiet,
    });
    expect(config.publicUrl).toBe('http://127.0.0.1:8787');
  });

  it('rejects the designed-but-unshipped stateless mode with a clear message', () => {
    expect(() =>
      loadServerConfig({ configPath: writeConfig({ mode: 'stateless' }), ...quiet }),
    ).toThrow(/v1\.1/);
  });

  it('honors env overrides for host, port and public URL', () => {
    const configPath = writeConfig();
    const env = {
      UNTACIT_SERVER_HOST: '127.0.0.1',
      UNTACIT_SERVER_PORT: '9999',
      UNTACIT_SERVER_PUBLIC_URL: 'https://override.example.com/',
    } as NodeJS.ProcessEnv;
    const config = loadServerConfig({ configPath, env, ...quiet });
    expect(config.host).toBe('127.0.0.1');
    expect(config.port).toBe(9999);
    expect(config.publicUrl).toBe('https://override.example.com'); // trailing slash stripped
    expect(() =>
      loadServerConfig({ configPath, env: { UNTACIT_SERVER_PORT: 'abc' } as NodeJS.ProcessEnv, ...quiet }),
    ).toThrow(/Invalid port/);
  });

  it('builds canonical per-graph resource URLs', () => {
    expect(graphResourceUrl({ publicUrl: 'https://x.example.com' }, 'acme')).toBe(
      'https://x.example.com/graphs/acme/mcp',
    );
  });

  it('resolves the data dir from option, env or config location', () => {
    const configPath = writeConfig();
    expect(resolveDataDir({ configPath })).toBe(join(configPath, '..'));
    expect(resolveDataDir({ configPath, dataDir: '/tmp/x' })).toBe('/tmp/x');
    expect(
      resolveDataDir({ configPath, env: { UNTACIT_SERVER_DATA_DIR: '/tmp/y' } as NodeJS.ProcessEnv }),
    ).toBe('/tmp/y');
  });
});
