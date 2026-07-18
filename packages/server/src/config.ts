/**
 * Server configuration (docs/06 §4.4): `<dataDir>/untacit-server.config.json`
 * validated with zod, env-var overrides, graph paths resolved and checked at
 * startup so a bad deployment fails fast with an actionable message.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { z } from 'zod';

/** Graph ids go into URLs — keep them boring on purpose (docs/06 §4.4). */
export const GRAPH_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

const graphSchema = z.object({
  id: z
    .string()
    .regex(GRAPH_ID_PATTERN, 'graph id must match [a-z0-9-]{1,64} (it is part of the URL)'),
  name: z.string().min(1).optional(),
  path: z.string().min(1),
  tools: z.enum(['query', 'agent']).default('query'),
});

const configSchema = z
  .object({
    mode: z.enum(['stateful', 'stateless']).default('stateful'),
    publicUrl: z.string().url(),
    host: z.string().default('0.0.0.0'),
    port: z.number().int().min(1).max(65535).default(8787),
    graphs: z.array(graphSchema).min(1, 'configure at least one graph'),
    auth: z
      .object({
        accessTokenTtlSeconds: z.number().int().min(60).default(3600),
        refreshTokenTtlSeconds: z.number().int().min(300).default(2_592_000),
      })
      .default({}),
    session: z
      .object({
        idleTimeoutMinutes: z.number().int().min(1).default(30),
        maxSessionsPerUser: z.number().int().min(1).default(20),
      })
      .default({}),
    embeddings: z
      .object({
        refresh: z.enum(['auto', 'external']).default('auto'),
      })
      .default({}),
    security: z
      .object({
        allowedHosts: z.array(z.string().min(1)).default([]),
        allowedOrigins: z.array(z.string().url()).default([]),
        /**
         * Honor X-Forwarded-* — only behind a reverse proxy (docs/06 §6).
         * `true` trusts exactly ONE hop (Caddy/nginx in front); a number
         * trusts that many hops. Trusting every hop would let clients spoof
         * their IP past the login rate limit, so it is never an option.
         */
        trustProxy: z.union([z.boolean(), z.number().int().min(1)]).default(false),
      })
      .default({}),
  })
  .strict();

export interface GraphEntry {
  id: string;
  name: string;
  /** Absolute path of the graph repo on disk. */
  path: string;
  tools: 'query' | 'agent';
}

export interface ServerConfig {
  mode: 'stateful';
  /** OAuth issuer + announced URLs; no trailing slash, no query/fragment. */
  publicUrl: string;
  host: string;
  port: number;
  graphs: GraphEntry[];
  auth: { accessTokenTtlSeconds: number; refreshTokenTtlSeconds: number };
  session: { idleTimeoutMinutes: number; maxSessionsPerUser: number };
  embeddings: { refresh: 'auto' | 'external' };
  security: { allowedHosts: string[]; allowedOrigins: string[]; trustProxy: boolean | number };
  /** Where server.db lives. */
  dataDir: string;
  configPath: string;
}

export interface LoadConfigOptions {
  /** Explicit config file path (CLI --config). */
  configPath?: string;
  /** Explicit data dir (CLI --data-dir). */
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
  /** Startup warnings (missing index, …) land here; defaults to console.warn. */
  warn?: (message: string) => void;
}

export function defaultConfigFileName(): string {
  return 'untacit-server.config.json';
}

/**
 * Resolution order (docs/06 §4.4): explicit option → `UNTACIT_SERVER_*` env
 * var → convention. The data dir defaults to the config file's directory so a
 * single `--config /data/untacit-server.config.json` pins both.
 */
export function resolveConfigPath(opts: LoadConfigOptions = {}): string {
  const env = opts.env ?? process.env;
  if (opts.configPath) return resolve(opts.configPath);
  if (env.UNTACIT_SERVER_CONFIG) return resolve(env.UNTACIT_SERVER_CONFIG);
  const dataDir = opts.dataDir ?? env.UNTACIT_SERVER_DATA_DIR;
  return resolve(dataDir ?? 'data', defaultConfigFileName());
}

export function resolveDataDir(opts: LoadConfigOptions = {}): string {
  const env = opts.env ?? process.env;
  if (opts.dataDir) return resolve(opts.dataDir);
  if (env.UNTACIT_SERVER_DATA_DIR) return resolve(env.UNTACIT_SERVER_DATA_DIR);
  return dirname(resolveConfigPath(opts));
}

export function loadServerConfig(opts: LoadConfigOptions = {}): ServerConfig {
  const env = opts.env ?? process.env;
  const warn = opts.warn ?? ((m: string) => console.warn(`[untacit-server] ${m}`));
  const configPath = resolveConfigPath(opts);

  if (!existsSync(configPath)) {
    throw new Error(
      `Config file not found: ${configPath}. Create it (see deploy/config.example.json) ` +
        'or point --config / UNTACIT_SERVER_CONFIG at it.',
    );
  }

  let rawText: string;
  let rawJson: unknown;
  try {
    rawText = readFileSync(configPath, 'utf8');
    rawJson = JSON.parse(rawText);
  } catch (err) {
    throw new Error(`Config file ${configPath} is not valid JSON: ${(err as Error).message}`);
  }

  const parsed = configSchema.safeParse(rawJson);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid config ${configPath}:\n${issues}`);
  }
  const cfg = parsed.data;

  if (cfg.mode === 'stateless') {
    throw new Error(
      'mode "stateless" (Vercel) is a designed v1.1 option, not implemented yet — ' +
        'use mode "stateful" (docs/06 §4.6).',
    );
  }

  // Env overrides on top of the file (docs/06 §4.4).
  const publicUrlRaw = env.UNTACIT_SERVER_PUBLIC_URL ?? cfg.publicUrl;
  const host = env.UNTACIT_SERVER_HOST ?? cfg.host;
  const port = env.UNTACIT_SERVER_PORT ? Number(env.UNTACIT_SERVER_PORT) : cfg.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port "${env.UNTACIT_SERVER_PORT ?? cfg.port}"`);
  }

  let publicUrl: URL;
  try {
    publicUrl = new URL(publicUrlRaw);
  } catch {
    throw new Error(`publicUrl "${publicUrlRaw}" is not a valid URL`);
  }
  if (publicUrl.search !== '' || publicUrl.hash !== '') {
    throw new Error('publicUrl must not have a query string or fragment (it is the OAuth issuer)');
  }
  // The issuer must be plain https in production; http is tolerated only for
  // loopback (local development and tests) — same rule the MCP SDK enforces.
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname);
  if (publicUrl.protocol !== 'https:' && !loopback) {
    throw new Error(`publicUrl must be https (got "${publicUrlRaw}") — put TLS in front (docs/07)`);
  }
  const normalizedPublicUrl = publicUrl.href.replace(/\/$/, '');

  const configDir = dirname(configPath);
  const seen = new Set<string>();
  const graphs: GraphEntry[] = cfg.graphs.map((g) => {
    if (seen.has(g.id)) throw new Error(`Duplicate graph id "${g.id}"`);
    seen.add(g.id);
    const path = isAbsolute(g.path) ? g.path : resolve(configDir, g.path);
    if (!existsSync(path)) {
      throw new Error(`Graph "${g.id}": path does not exist: ${path}`);
    }
    if (!existsSync(join(path, '.git'))) {
      throw new Error(
        `Graph "${g.id}": ${path} is not a git repository — graphs are served from git clones ` +
          '(clone the graph repo there, docs/07 §3)',
      );
    }
    if (!existsSync(join(path, '.untacit', 'index.db'))) {
      warn(`graph "${g.id}": no derived index yet at ${path}/.untacit — it will be built on first use`);
    }
    return { id: g.id, name: g.name ?? g.id, path, tools: g.tools };
  });

  return {
    mode: 'stateful',
    publicUrl: normalizedPublicUrl,
    host,
    port,
    graphs,
    auth: cfg.auth,
    session: cfg.session,
    embeddings: cfg.embeddings,
    security: cfg.security,
    dataDir: resolveDataDir(opts),
    configPath,
  };
}

/** Canonical resource URL of one graph's MCP endpoint (RFC 8707 / RFC 9728). */
export function graphResourceUrl(config: Pick<ServerConfig, 'publicUrl'>, graphId: string): string {
  return `${config.publicUrl}/graphs/${graphId}/mcp`;
}
