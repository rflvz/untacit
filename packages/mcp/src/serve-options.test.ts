/**
 * ServeOptions flags added for the self-hosted server (docs/06 §7):
 * `agentSurface: false` serves only the six query tools, and
 * `gitAvailable: false` turns untacit_diff into a clear error instead of a
 * git spawn failure.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as core from '@untacit/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, describe, expect, it } from 'vitest';

import { createServer, type ServeOptions } from './index.js';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'untacit-mcp-opts-'));
  tmpDirs.push(repo);
  core.initGraphRepo(repo);
  return repo;
}

async function connect(repo: string, opts: ServeOptions = {}) {
  const server = createServer(repo, opts);
  const client = new Client({ name: 'test-host', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

const QUERY_TOOLS = [
  'untacit_context',
  'untacit_explore',
  'untacit_impact',
  'untacit_evidence',
  'untacit_diff',
  'untacit_conflicts',
];

describe('ServeOptions.agentSurface', () => {
  it('serves only the query tools when disabled', async () => {
    const client = await connect(makeRepo(), { agentSurface: false });
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...QUERY_TOOLS].sort());
  });

  it('keeps the agent surface by default', async () => {
    const client = await connect(makeRepo());
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining([...QUERY_TOOLS, 'untacit_interview_gaps']));
  });
});

describe('ServeOptions.gitAvailable', () => {
  it('makes untacit_diff fail with an explanation instead of spawning git', async () => {
    const client = await connect(makeRepo(), { gitAvailable: false });
    const result = await client.callTool({ name: 'untacit_diff', arguments: {} });
    expect(result.isError).toBe(true);
    const text = (result.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain('needs the git binary');
  });
});
