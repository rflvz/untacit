/**
 * Sidecar entry point.
 *
 *   UNTACIT_REPO=/path/to/graph-repo pnpm sidecar
 *   pnpm sidecar -- --repo /path/to/graph-repo
 *
 * Port: UNTACIT_PORT (default 4823). In Fase 2 this process becomes a Tauri
 * external binary (see src-tauri/README.md); today it is started by `pnpm dev`.
 */

import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { createApp } from './app.js';

function repoFromArgv(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--repo') return argv[i + 1];
    if (arg.startsWith('--repo=')) return arg.slice('--repo='.length);
  }
  return undefined;
}

const explicitRepo = repoFromArgv(process.argv.slice(2)) ?? process.env.UNTACIT_REPO;
if (explicitRepo === undefined) {
  console.warn(
    '[untacit-sidecar] no --repo argument and no UNTACIT_REPO env var; using the current directory as graph repo',
  );
}
const repoRoot = resolve(explicitRepo ?? process.cwd());
const port = Number(process.env.UNTACIT_PORT ?? 4823);

const app = createApp({ repoRoot });

serve({ fetch: app.fetch, port }, (info) => {
  console.log(`[untacit-sidecar] listening on http://localhost:${info.port}`);
  console.log(`[untacit-sidecar] graph repo: ${repoRoot}`);
});
