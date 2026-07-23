/**
 * Agent-surface tests: a real MCP client over an in-memory transport pair —
 * gap analysis, document sections, the write gate (import + idempotence) and
 * the versioned prompts. This is the exact wire a host model (Claude Code /
 * Claude Desktop) uses to run extraction and interviews without untacit
 * calling any LLM.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as core from '@untacit/core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServer } from './index.js';

const tmpDirs: string[] = [];
afterAll(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
});

function makeGraphRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'untacit-mcp-agent-'));
  tmpDirs.push(repo);
  core.initGraphRepo(repo);
  // Hermetic tests: pin embeddings off so imports never resolve 'auto' to
  // the local multilingual model (a download at test time).
  core.saveConfig(repo, { ...core.loadConfig(repo), embeddings: { provider: 'none' } });

  const store = core.GraphStore.load(repo);
  const nodeBase = {
    aliases: [],
    status: 'active' as const,
    attrs: {},
    evidence: [],
    edges: [],
    schema_version: core.SCHEMA_VERSION,
  };
  const interviewEvidence = {
    source_type: 'interview' as const,
    locator: { interview_id: 'int-000', speaker_role: 'gerencia', turn: 2 },
    excerpt: 'Los comerciales meten los pedidos en la web',
    stance: 'supports' as const,
  };
  store.upsertNode({
    ...nodeBase,
    id: 'process-alta-pedido',
    type: 'process',
    name: 'Alta de pedido',
    description: 'Registro de un pedido nuevo.',
  });
  store.upsertNode({
    ...nodeBase,
    id: 'role-comercial',
    type: 'role',
    name: 'Comercial',
    description: 'Función comercial.',
    edges: [
      {
        type: 'EXECUTES',
        target: 'process/process-alta-pedido',
        confidence: core.computeEdgeConfidence([interviewEvidence]),
        status: 'active',
        evidence: [interviewEvidence],
      },
    ],
  });
  store.write();
  core.gitCommitAll(repo, 'fixture');
  return repo;
}

async function connect(repo: string, opts: { write?: boolean } = {}) {
  const server = createServer(repo, opts);
  const client = new Client({ name: 'test-host', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe('agent surface over MCP', () => {
  let repo: string;

  beforeAll(() => {
    repo = makeGraphRepo();
  });

  it('read-only server exposes the agent tools but NOT the write gate', async () => {
    const client = await connect(repo);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('untacit_interview_gaps');
    expect(tools).toContain('untacit_code_candidates');
    expect(tools).toContain('untacit_doc_sections');
    expect(tools).not.toContain('untacit_import_batch');
    await client.close();
  });

  it('untacit_interview_gaps reports gaps and claims to verify', async () => {
    const client = await connect(repo);
    const result = await client.callTool({ name: 'untacit_interview_gaps', arguments: {} });
    const structured = result.structuredContent as {
      gaps: { kind: string }[];
      verifications: { statement: string; confidence: number }[];
    };
    expect(structured.gaps.some((g) => g.kind === 'missing-trigger')).toBe(true);
    expect(structured.verifications).toHaveLength(1);
    expect(structured.verifications[0].statement).toBe('«Comercial» ejecuta «Alta de pedido»');
    await client.close();
  });

  it('untacit_doc_sections segments a markdown file with locators', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'untacit-mcp-docs-'));
    tmpDirs.push(dir);
    writeFileSync(
      join(dir, 'manual.md'),
      '# Manual\n\nIntro.\n\n## Pagos\n\nA clientes nuevos se les exige prepago.\n',
      'utf8',
    );
    const client = await connect(repo);
    const result = await client.callTool({
      name: 'untacit_doc_sections',
      arguments: { files: [join(dir, 'manual.md')] },
    });
    const structured = result.structuredContent as {
      total: number;
      sections: { doc_id: string; section: string; text: string }[];
    };
    expect(structured.total).toBe(2);
    expect(structured.sections[1]).toMatchObject({ doc_id: 'manual', section: '2. Pagos' });
    expect(structured.sections[1].text).toContain('prepago');
    await client.close();
  });

  it('untacit_import_batch (write server) imports, commits and is idempotent', async () => {
    const client = await connect(repo, { write: true });
    const tools = (await client.listTools()).tools;
    const importTool = tools.find((t) => t.name === 'untacit_import_batch');
    expect(importTool).toBeDefined();
    expect(importTool!.annotations?.readOnlyHint).toBe(false);

    const batch = {
      run_id: '2026-07-16T09-00-00-interview',
      source_type: 'interview',
      nodes: [
        {
          mention: 'Comercial',
          candidate_id: 'role-comercial',
          type: 'role',
          name: 'Comercial',
          description: 'Función comercial.',
          evidence: {
            locator: { interview_id: 'int-mcp', speaker_role: 'administracion' },
            excerpt: 'Confirmado en entrevista: «Comercial» ejecuta «Alta de pedido»',
            validated_by: 'administracion',
          },
        },
        {
          mention: 'Alta de pedido',
          candidate_id: 'process-alta-pedido',
          type: 'process',
          name: 'Alta de pedido',
          description: 'Registro de un pedido nuevo.',
          evidence: {
            locator: { interview_id: 'int-mcp', speaker_role: 'administracion' },
            excerpt: 'Confirmado en entrevista: «Comercial» ejecuta «Alta de pedido»',
            validated_by: 'administracion',
          },
        },
      ],
      edges: [
        {
          type: 'EXECUTES',
          source_mention: 'Comercial',
          target_mention: 'Alta de pedido',
          evidence: {
            locator: { interview_id: 'int-mcp', speaker_role: 'administracion' },
            excerpt: 'Confirmado en entrevista: «Comercial» ejecuta «Alta de pedido»',
            validated_by: 'administracion',
          },
        },
      ],
    };

    const result = await client.callTool({ name: 'untacit_import_batch', arguments: { batch } });
    const structured = result.structuredContent as {
      runId: string;
      noop: boolean;
      commit: string | null;
      rejections: unknown[];
    };
    expect(structured.noop).toBe(false);
    expect(structured.commit).toBeTruthy();
    expect(structured.rejections).toEqual([]);

    // The live-validated evidence raised the existing edge to 0.95.
    const store = core.GraphStore.load(repo);
    const edge = store.getNode('role-comercial')!.edges.find((e) => e.type === 'EXECUTES')!;
    expect(edge.confidence).toBe(0.95);

    // Idempotence over the wire: identical re-import is a no-op.
    const again = await client.callTool({ name: 'untacit_import_batch', arguments: { batch } });
    expect((again.structuredContent as { noop: boolean }).noop).toBe(true);
    expect(core.gitStatusClean(repo)).toBe(true);
    await client.close();
  });

  it('serves the versioned extractor prompts', async () => {
    const client = await connect(repo);
    const prompts = (await client.listPrompts()).prompts.map((p) => p.name);
    expect(prompts).toEqual(
      expect.arrayContaining(['untacit-interview', 'untacit-extract-code', 'untacit-extract-docs']),
    );

    const interview = await client.getPrompt({
      name: 'untacit-interview',
      arguments: { role: 'administracion' },
    });
    const text = interview.messages[0].content.type === 'text' ? interview.messages[0].content.text : '';
    expect(text).toContain('Rol del entrevistado: administracion');
    expect(text).toContain('untacit_interview_gaps');
    expect(text).toContain('untacit_import_batch');
    expect(text).toContain('extraction-batch.v1');
    await client.close();
  });
});
