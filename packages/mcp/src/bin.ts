#!/usr/bin/env node
/**
 * Entry point:
 *   untacit-mcp --graph <graph-repo-dir> [--write] [--http [--port N] [--host H]]
 * (or UNTACIT_REPO env var). Default transport is stdio; --http serves
 * streamable HTTP on /mcp. --write enables the untacit_import_batch gate so
 * a host model (Claude Code / Claude Desktop) can run extraction and
 * interviews over MCP.
 */
import { resolve } from 'node:path';

import { serveMcp, serveMcpHttp } from './index.js';

const argv = process.argv.slice(2);

function flagValue(name: string): string | undefined {
  const i = argv.indexOf(name);
  return i !== -1 ? argv[i + 1] : undefined;
}

const repo = resolve(flagValue('--graph') ?? process.env['UNTACIT_REPO'] ?? process.cwd());
const write = argv.includes('--write');

async function main(): Promise<void> {
  if (argv.includes('--http')) {
    const port = Number(flagValue('--port') ?? 8765);
    const host = flagValue('--host') ?? '127.0.0.1';
    await serveMcpHttp(repo, { write, port, host });
    console.error(`untacit MCP (streamable HTTP) en http://${host}:${port}/mcp — graph repo: ${repo}${write ? ' [write]' : ''}`);
    return;
  }
  await serveMcp(repo, { write });
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
