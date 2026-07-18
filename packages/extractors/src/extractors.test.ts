import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as core from '@untacit/core';
import { validateBatch } from '@untacit/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { extractFromCandidates, scanRepo } from './code/index.js';
import { extractFromSections, htmlToMarkdownish, loadDocumentSections, segmentMarkdown } from './docs/index.js';
import {
  acceptAll,
  acceptProposal,
  editProposal,
  findCoverageGaps,
  finishInterview,
  processAnswer,
  rejectProposal,
  resolveVerification,
  startInterview,
  verificationTargets,
} from './interview/index.js';
import { ClaudeCodeLlmClient, MockLlmClient, claudeCodeAvailable, parseJsonResponse } from './llm.js';

const NOW = new Date('2026-07-14T12:00:00Z');

describe('code candidate scanner', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'untacit-scan-'));
    mkdirSync(join(repo, 'src'), { recursive: true });
    writeFileSync(
      join(repo, 'src', 'checkout.ts'),
      [
        'export function altaPedido(cliente: Cliente, pedido: Pedido) {',
        '  if (cliente.esNuevo && !pedido.prepagado) {',
        "    throw new Error('Pedido bloqueado: cliente nuevo sin pago anticipado');",
        '  }',
        '  return registrar(pedido);',
        '}',
      ].join('\n'),
    );
    writeFileSync(join(repo, 'src', 'utils.ts'), 'export const pad = (s: string) => s.trim();\n');
    mkdirSync(join(repo, 'src', '__tests__'), { recursive: true });
    writeFileSync(join(repo, 'src', '__tests__', 'checkout.test.ts'), 'if (cliente.esNuevo) {}\n');
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('finds business-logic candidates and skips utilities and tests', () => {
    const candidates = scanRepo(repo, { repoName: 'acme-erp' });
    expect(candidates.length).toBe(1);
    expect(candidates[0]!.path).toBe('src/checkout.ts');
    expect(candidates[0]!.signals).toContain('conditional-validation');
    expect(candidates[0]!.snippet).toContain('prepagado');
  });

  it('scans only the given paths (partial re-extraction) and skips deleted ones', () => {
    expect(scanRepo(repo, { repoName: 'acme-erp', paths: ['src/checkout.ts'] })).toHaveLength(1);
    expect(scanRepo(repo, { repoName: 'acme-erp', paths: ['src'] })).toHaveLength(1);
    expect(scanRepo(repo, { repoName: 'acme-erp', paths: ['src/utils.ts'] })).toHaveLength(0);
    // A file the merge deleted is normal input, not an error.
    expect(scanRepo(repo, { repoName: 'acme-erp', paths: ['src/borrado.ts'] })).toHaveLength(0);
    expect(
      scanRepo(repo, { repoName: 'acme-erp', paths: ['src/borrado.ts', 'src/checkout.ts'] }),
    ).toHaveLength(1);
  });
});

const CODE_LLM_BATCH = {
  run_id: 'ignored',
  source_type: 'code',
  nodes: [
    {
      mention: 'Cliente',
      type: 'entity',
      name: 'Cliente',
      description: 'Comprador de Acme.',
      evidence: {
        locator: { repo: 'acme-erp', path: 'src/checkout.ts', line_start: 2, line_end: 2 },
        excerpt: 'cliente.esNuevo',
      },
    },
    {
      mention: 'bloqueoPrepago',
      type: 'rule',
      name: 'Bloqueo de pedido sin prepago',
      description: 'Rechaza pedidos de clientes nuevos sin pago.',
      evidence: {
        locator: { repo: 'acme-erp', path: 'src/checkout.ts', line_start: 2, line_end: 4 },
        excerpt: 'if (cliente.esNuevo && !pedido.prepagado) { throw ... }',
      },
    },
    {
      mention: 'tablaClientes',
      type: 'tabla',
      name: 'Tabla clientes',
      description: 'Hallucinated node type that must be rejected.',
      evidence: { locator: { repo: 'acme-erp', path: 'x', line_start: 1, line_end: 1 }, excerpt: 'x' },
    },
  ],
  edges: [
    {
      type: 'OPERATES_ON',
      source_mention: 'bloqueoPrepago',
      target_mention: 'Cliente',
      evidence: {
        locator: { repo: 'acme-erp', path: 'src/checkout.ts', line_start: 2, line_end: 2 },
        excerpt: 'cliente.esNuevo && !pedido.prepagado',
      },
    },
  ],
};

describe('extractor-code', () => {
  it('emits a validated batch, salvaging good triples and logging rejections', async () => {
    const llm = new MockLlmClient([CODE_LLM_BATCH]);
    const result = await extractFromCandidates(
      llm,
      [
        {
          repo: 'acme-erp',
          path: 'src/checkout.ts',
          line_start: 1,
          line_end: 6,
          snippet: 'if (cliente.esNuevo && !pedido.prepagado) ...',
          signals: ['conditional-validation'],
        },
      ],
      { now: NOW },
    );

    expect(result.llmCalls).toBe(1);
    expect(result.batch.run_id).toBe('2026-07-14T12-00-00-code');
    expect(result.batch.nodes.map((n) => n.mention)).toEqual(['Cliente', 'bloqueoPrepago']);
    expect(result.batch.edges).toHaveLength(1);
    expect(result.rejections.some((r) => r.message.includes('tabla'))).toBe(true);
    // The merged batch itself passes the core validator cleanly.
    expect(validateBatch(result.batch).valid).toBe(true);
    // The LLM was given the strict schema and the versioned system prompt.
    expect(llm.requests[0]!.schema).toBeDefined();
    expect(llm.requests[0]!.system).toContain('ontología es CERRADA');
  });
});

describe('extractor-docs', () => {
  it('segments markdown by headings', () => {
    const sections = segmentMarkdown(
      'manual-comercial',
      'Manual comercial',
      '# Manual\n\nIntro.\n\n## Pagos\n\nA clientes nuevos se les exige prepago.\n\n## Descuentos\n\nPor volumen.\n',
    );
    expect(sections.map((s) => s.section)).toEqual(['1. Manual', '2. Pagos', '3. Descuentos']);
    expect(sections[1]!.text).toContain('prepago');
  });

  it('emits a document batch through the same validation gate', async () => {
    const llm = new MockLlmClient([
      {
        run_id: 'x',
        source_type: 'document',
        nodes: [
          {
            mention: 'Pago anticipado a clientes nuevos',
            type: 'policy',
            name: 'Pago anticipado a clientes nuevos',
            description: 'No se sirve a clientes nuevos sin pago.',
            evidence: {
              locator: { doc_id: 'manual-comercial', title: 'Manual comercial', section: '2. Pagos' },
              excerpt: 'A clientes nuevos se les exige prepago.',
            },
          },
        ],
        edges: [],
      },
    ]);
    const sections = segmentMarkdown('manual-comercial', 'Manual comercial', '## Pagos\n\nA clientes nuevos se les exige prepago.\n');
    const result = await extractFromSections(llm, sections, { now: NOW });
    expect(result.batch.source_type).toBe('document');
    expect(result.batch.nodes).toHaveLength(1);
    expect(validateBatch(result.batch).valid).toBe(true);
  });
});

const TURN_BATCH = {
  run_id: 'pending',
  source_type: 'interview',
  nodes: [
    {
      mention: 'Facturación mensual',
      type: 'process',
      name: 'Facturación mensual',
      description: 'Emisión de facturas al cierre de mes.',
      evidence: {
        locator: { interview_id: 'int-001', speaker_role: 'administracion', turn: 1 },
        excerpt: 'La facturación la hago yo entera a fin de mes.',
      },
    },
    {
      mention: 'Administración',
      type: 'role',
      name: 'Administración',
      description: 'Rol de facturación y cobros.',
      evidence: {
        locator: { interview_id: 'int-001', speaker_role: 'administracion', turn: 1 },
        excerpt: 'En administración llevamos la facturación.',
      },
    },
  ],
  edges: [
    {
      type: 'EXECUTES',
      source_mention: 'Administración',
      target_mention: 'Facturación mensual',
      evidence: {
        locator: { interview_id: 'int-001', speaker_role: 'administracion', turn: 1 },
        excerpt: 'La facturación la hago yo entera.',
      },
    },
  ],
};

const EMPTY_TURN = { run_id: 'pending', source_type: 'interview', nodes: [], edges: [] };

describe('extractor-interview: turn loop', () => {
  it('opens with a greeting and the first script question', () => {
    const state = startInterview('int-001', 'administracion', {
      script: ['¿Quién aprueba los descuentos?', '¿Qué pasa si falla el cobro?'],
    });
    expect(state.transcript).toHaveLength(1);
    expect(state.transcript[0]!.speaker).toBe('agent');
    expect(state.transcript[0]!.text).toContain('¿Quién aprueba los descuentos?');
    expect(state.scriptIndex).toBe(1);
  });

  it('proposes triples in natural language, repregunta while the topic is open, and advances the script when done', async () => {
    const llm = new MockLlmClient([
      { ...TURN_BATCH, reply: '¿Y qué ocurre si un cliente no paga a fin de mes?', topic_done: false },
      { ...EMPTY_TURN, reply: 'Entendido.', topic_done: true },
    ]);
    const state = startInterview('int-001', 'administracion', {
      script: ['¿Quién lleva la facturación?', '¿Qué pasa si falla el cobro?'],
    });

    const turn1 = await processAnswer(llm, state, 'La facturación la hago yo entera a fin de mes.');
    expect(turn1.proposals).toHaveLength(3);
    expect(turn1.proposals[0]!.statement).toContain('«Facturación mensual» es un proceso');
    expect(turn1.proposals[2]!.statement).toBe('«Administración» ejecuta «Facturación mensual»');
    // topic_done=false: the reply is the repregunta, the script does not advance.
    expect(turn1.reply).toBe('¿Y qué ocurre si un cliente no paga a fin de mes?');
    expect(turn1.finished).toBe(false);
    expect(state.scriptIndex).toBe(1);

    const turn2 = await processAnswer(llm, state, 'Se bloquean los pedidos nuevos hasta que pague.');
    // topic_done=true: the engine appends the next scripted question.
    expect(turn2.reply).toBe('Entendido. ¿Qué pasa si falla el cobro?');
    expect(state.scriptIndex).toBe(2);
    // The LLM saw the conversation context and the strict turn schema.
    expect(llm.requests[1]!.prompt).toContain('ENTREVISTADO: La facturación la hago yo entera');
    expect(llm.requests[1]!.schema).toMatchObject({ $id: 'untacit/interview-turn.v1' });
  });

  it('wraps up when the script is exhausted and reminds of pending verifications', async () => {
    const llm = new MockLlmClient([{ ...EMPTY_TURN, reply: 'Perfecto.', topic_done: true }]);
    const state = startInterview('int-001', 'administracion', {
      script: ['¿Única pregunta?'],
      verifications: [
        {
          edgeKey: 'e1',
          sourceId: 'role-comercial',
          sourceType: 'role',
          sourceName: 'Comercial',
          sourceDescription: 'Función comercial.',
          edgeType: 'EXECUTES',
          targetId: 'process-alta-pedido',
          targetType: 'process',
          targetName: 'Alta de pedido',
          targetDescription: 'Registro de pedidos.',
          confidence: 0.6,
          statement: '«Comercial» ejecuta «Alta de pedido»',
        },
      ],
    });
    expect(state.proposals).toHaveLength(1);
    expect(state.proposals[0]!.kind).toBe('verification');

    const turn = await processAnswer(llm, state, 'Sí, así es.');
    expect(turn.finished).toBe(true);
    expect(turn.reply).toContain('1 afirmación por confirmar o refutar');
  });
});

describe('extractor-interview: live validation actions', () => {
  async function stateWithProposals() {
    const llm = new MockLlmClient([{ ...TURN_BATCH, reply: '', topic_done: false }]);
    const state = startInterview('int-001', 'administracion', { script: ['¿?'] });
    await processAnswer(llm, state, 'La facturación la hago yo entera a fin de mes.');
    return state;
  }

  it('accept/reject drive what enters the batch; rejected endpoints cascade edges out', async () => {
    const state = await stateWithProposals();
    acceptProposal(state, 'p1');
    acceptProposal(state, 'p2');
    acceptProposal(state, 'p3');
    rejectProposal(state, 'p1'); // rejected wins over the earlier accept

    const batch = finishInterview(state, NOW);
    expect(batch.run_id).toBe('2026-07-14T12-00-00-interview');
    expect(batch.nodes.map((n) => n.mention)).toEqual(['Administración']);
    expect(batch.edges).toHaveLength(0); // EXECUTES cascaded out with its endpoint
    expect(batch.nodes[0]!.evidence.validated_by).toBe('administracion');
  });

  it('editProposal applies the correction and re-renders the statement', async () => {
    const state = await stateWithProposals();
    const edited = editProposal(state, 'p1', {
      name: 'Facturación de fin de mes',
      description: 'Emisión y envío de todas las facturas del mes.',
    });
    expect(edited.node!.name).toBe('Facturación de fin de mes');
    expect(edited.node!.mention).toBe('Facturación de fin de mes');
    expect(edited.statement).toContain('«Facturación de fin de mes» es un proceso');

    const editedEdge = editProposal(state, 'p3', { edgeType: 'EXECUTES' });
    expect(editedEdge.statement).toContain('ejecuta');
  });

  it('renaming a node follows through to edge proposals that mention it', async () => {
    const state = await stateWithProposals();
    editProposal(state, 'p1', { name: 'Facturación de fin de mes' });
    const edge = state.proposals.find((p) => p.id === 'p3')!;
    expect(edge.edge!.target_mention).toBe('Facturación de fin de mes');
    expect(edge.statement).toBe('«Administración» ejecuta «Facturación de fin de mes»');

    acceptProposal(state, 'p1');
    acceptProposal(state, 'p2');
    acceptProposal(state, 'p3');
    const batch = finishInterview(state, NOW);
    expect(batch.edges).toHaveLength(1); // the renamed endpoint did not orphan the edge
    expect(validateBatch(batch).valid).toBe(true);
  });

  it('accepting an edge pulls its still-pending endpoint nodes into the batch', async () => {
    const state = await stateWithProposals();
    acceptProposal(state, 'p3'); // only the edge; p1/p2 stay 'proposed'
    const batch = finishInterview(state, NOW);
    expect(batch.edges).toHaveLength(1);
    expect(batch.nodes.map((n) => n.mention).sort()).toEqual(['Administración', 'Facturación mensual']);
    expect(state.proposals.find((p) => p.id === 'p1')!.status).toBe('accepted');
    expect(batch.nodes.every((n) => n.evidence.validated_by === 'administracion')).toBe(true);
  });

  it('a failed LLM call leaves the state untouched so the answer can be retried', async () => {
    const llm = new MockLlmClient([]); // first call throws "no scripted responses left"
    const state = startInterview('int-001', 'administracion', { script: ['¿?'] });
    await expect(processAnswer(llm, state, 'respuesta')).rejects.toThrow();
    expect(state.turn).toBe(0);
    expect(state.transcript).toHaveLength(1); // only the opening agent turn
    expect(state.proposals).toHaveLength(0);
  });

  it('stamps the trusted locator over whatever the LLM emitted', async () => {
    const tampered = JSON.parse(JSON.stringify(TURN_BATCH)) as typeof TURN_BATCH & Record<string, unknown>;
    tampered.nodes[0]!.evidence.locator = { interview_id: 'FORGED', speaker_role: 'gerencia', turn: 99 };
    const llm = new MockLlmClient([{ ...tampered, reply: '', topic_done: false }]);
    const state = startInterview('int-001', 'administracion', { script: ['¿?'] });
    const { proposals } = await processAnswer(llm, state, 'La facturación la hago yo.');
    expect(proposals[0]!.node!.evidence.locator).toEqual({
      interview_id: 'int-001',
      speaker_role: 'administracion',
      turn: 1,
    });
  });

  it('acceptAll accepts every pending proposal except the exceptions', async () => {
    const state = await stateWithProposals();
    rejectProposal(state, 'p2');
    const accepted = acceptAll(state, ['p3']);
    expect(accepted.map((p) => p.id)).toEqual(['p1']);
    expect(state.proposals.find((p) => p.id === 'p2')!.status).toBe('rejected');
    expect(state.proposals.find((p) => p.id === 'p3')!.status).toBe('proposed');
  });

  it('verification proposals reject accept/reject and demand a verdict', async () => {
    const state = startInterview('int-001', 'administracion', {
      verifications: verificationFixture(),
    });
    expect(() => acceptProposal(state, 'v1')).toThrow(/confirm\/refute\/skip/);
    expect(() => editProposal(state, 'v1', { name: 'x' })).toThrow(/cannot be edited/);
    resolveVerification(state, 'v1', 'skip');
    expect(state.proposals[0]!.status).toBe('skipped');
  });
});

function verificationFixture() {
  return [
    {
      edgeKey: 'e1',
      sourceId: 'role-comercial',
      sourceType: 'role' as const,
      sourceName: 'Comercial',
      sourceDescription: 'Función comercial.',
      edgeType: 'EXECUTES' as const,
      targetId: 'process-alta-pedido',
      targetType: 'process' as const,
      targetName: 'Alta de pedido',
      targetDescription: 'Registro de pedidos.',
      confidence: 0.6,
      statement: '«Comercial» ejecuta «Alta de pedido»',
    },
  ];
}

describe('extractor-interview: cross-verification (docs/03 §4.3.5)', () => {
  it('confirm emits a supports edge over anchor nodes with candidate_id', () => {
    const state = startInterview('int-007', 'administracion', {
      verifications: verificationFixture(),
    });
    resolveVerification(state, 'v1', 'confirm');
    const batch = finishInterview(state, NOW);

    expect(batch.nodes).toHaveLength(2);
    expect(batch.nodes.map((n) => n.candidate_id)).toEqual(['role-comercial', 'process-alta-pedido']);
    expect(batch.edges).toHaveLength(1);
    expect(batch.edges[0]!).toMatchObject({
      type: 'EXECUTES',
      source_mention: 'Comercial',
      target_mention: 'Alta de pedido',
      stance: 'supports',
    });
    expect(batch.edges[0]!.evidence.validated_by).toBe('administracion');
    expect(batch.edges[0]!.evidence.excerpt).toContain('Confirmado en entrevista');
    // The whole verification batch passes the core validator.
    expect(validateBatch(batch).valid).toBe(true);
  });

  it('refute emits a contradicts edge', () => {
    const state = startInterview('int-007', 'administracion', {
      verifications: verificationFixture(),
    });
    resolveVerification(state, 'v1', 'refute');
    const batch = finishInterview(state, NOW);
    expect(batch.edges[0]!.stance).toBe('contradicts');
    expect(batch.edges[0]!.evidence.excerpt).toContain('Refutado en entrevista');
  });

  it('skip emits nothing', () => {
    const state = startInterview('int-007', 'administracion', {
      verifications: verificationFixture(),
    });
    resolveVerification(state, 'v1', 'skip');
    const batch = finishInterview(state, NOW);
    expect(batch.nodes).toHaveLength(0);
    expect(batch.edges).toHaveLength(0);
  });
});

describe('extractor-interview: end-to-end against a real graph repo', () => {
  let repo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'untacit-interview-'));
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
    core.gitInit(repo);
    core.gitCommitAll(repo, 'fixture');
  });

  afterAll(() => rmSync(repo, { recursive: true, force: true }));

  it('findCoverageGaps sees processes without triggers and low-confidence edges', () => {
    const index = core.GraphIndex.open(repo);
    try {
      const gaps = findCoverageGaps(index, 20);
      const kinds = gaps.map((g) => g.kind);
      expect(kinds).toContain('missing-trigger');
      expect(kinds).toContain('low-confidence-edge');
      // role-comercial EXECUTES the process, so no missing-role gap for it.
      expect(gaps.some((g) => g.kind === 'missing-role' && g.nodeId === 'process-alta-pedido')).toBe(false);
    } finally {
      index.close();
    }
  });

  it('verificationTargets renders the low-confidence edge as a claim', () => {
    const index = core.GraphIndex.open(repo);
    try {
      const targets = verificationTargets(index);
      expect(targets).toHaveLength(1);
      expect(targets[0]!).toMatchObject({
        sourceId: 'role-comercial',
        edgeType: 'EXECUTES',
        targetId: 'process-alta-pedido',
        confidence: 0.6,
        statement: '«Comercial» ejecuta «Alta de pedido»',
      });
    } finally {
      index.close();
    }
  });

  it('confirming raises the edge to 0.95; refuting opens a conflict', async () => {
    const index = core.GraphIndex.open(repo);
    let targets: ReturnType<typeof verificationTargets>;
    try {
      targets = verificationTargets(index);
    } finally {
      index.close();
    }

    // Confirm: supports evidence validated live → confidence 0.95.
    const confirmState = startInterview('int-010', 'administracion', { verifications: targets });
    resolveVerification(confirmState, 'v1', 'confirm');
    const confirmResult = await core.importBatch(
      repo,
      finishInterview(confirmState, new Date('2026-07-15T09:00:00Z')),
      { embeddings: null, now: NOW },
    );
    expect(confirmResult.rejections).toEqual([]);
    let store = core.GraphStore.load(repo);
    let edge = store.getNode('role-comercial')!.edges.find((e) => e.type === 'EXECUTES')!;
    expect(edge.confidence).toBe(0.95);
    expect(edge.status).toBe('active');
    expect(edge.evidence.some((ev) => ev.validated_by === 'administracion')).toBe(true);
    // No duplicate nodes were created: candidate_id anchored the mentions.
    expect(store.getNode('role-comercial-2')).toBeUndefined();

    // Refute: contradicts evidence from the interview → conflicted edge.
    const refuteState = startInterview('int-011', 'produccion', { verifications: targets });
    resolveVerification(refuteState, 'v1', 'refute');
    const refuteResult = await core.importBatch(
      repo,
      finishInterview(refuteState, new Date('2026-07-15T10:00:00Z')),
      { embeddings: null, now: NOW },
    );
    expect(refuteResult.rejections).toEqual([]);
    store = core.GraphStore.load(repo);
    edge = store.getNode('role-comercial')!.edges.find((e) => e.type === 'EXECUTES')!;
    expect(edge.status).toBe('conflicted');
  });
});

describe('parseJsonResponse', () => {
  it('tolerates prose around the JSON object', () => {
    expect(parseJsonResponse('Aquí está:\n{"a": 1}\nEspero que sirva.')).toEqual({ a: 1 });
  });
});

describe('ClaudeCodeLlmClient (engine = Claude Code CLI, no API key)', () => {
  const STUB = join(import.meta.dirname, '..', 'test-fixtures', 'claude-stub.cjs');

  it('runs print mode with tools disabled, system prompt in argv and prompt + schema over stdin', async () => {
    const llm = new ClaudeCodeLlmClient({ bin: STUB });
    const out = await llm.complete({
      system: 'eres un extractor',
      prompt: 'analiza esto',
      schema: { type: 'object', properties: { x: { type: 'number' } } },
    });
    const echoed = JSON.parse(out) as { argv: string[]; stdin: string };
    expect(echoed.argv).toContain('--print');
    expect(echoed.argv).toContain('--output-format');
    expect(echoed.argv).toContain('json');
    // All built-in tools disabled: pure completion.
    expect(echoed.argv[echoed.argv.indexOf('--tools') + 1]).toBe('');
    expect(echoed.argv[echoed.argv.indexOf('--system-prompt') + 1]).toBe('eres un extractor');
    expect(echoed.stdin).toContain('analiza esto');
    // The emission contract travels inside the prompt.
    expect(echoed.stdin).toContain('JSON Schema');
    expect(echoed.stdin).toContain('"x"');
  });

  it('passes --model only when overridden', async () => {
    const defaultModel = new ClaudeCodeLlmClient({ bin: STUB });
    const out1 = JSON.parse(await defaultModel.complete({ system: 's', prompt: 'p' })) as { argv: string[] };
    expect(out1.argv).not.toContain('--model');

    const pinned = new ClaudeCodeLlmClient({ bin: STUB, model: 'claude-opus-4-8' });
    const out2 = JSON.parse(await pinned.complete({ system: 's', prompt: 'p' })) as { argv: string[] };
    expect(out2.argv[out2.argv.indexOf('--model') + 1]).toBe('claude-opus-4-8');
  });

  it('surfaces engine errors, garbage output and nonzero exits as actionable errors', async () => {
    const saved = process.env.CLAUDE_STUB_MODE;
    try {
      process.env.CLAUDE_STUB_MODE = 'error';
      await expect(new ClaudeCodeLlmClient({ bin: STUB }).complete({ system: 's', prompt: 'p' })).rejects.toThrow(
        /error_during_execution|simulated engine error/,
      );
      process.env.CLAUDE_STUB_MODE = 'garbage';
      await expect(new ClaudeCodeLlmClient({ bin: STUB }).complete({ system: 's', prompt: 'p' })).rejects.toThrow(
        /no-JSON/,
      );
      process.env.CLAUDE_STUB_MODE = 'exit1';
      await expect(new ClaudeCodeLlmClient({ bin: STUB }).complete({ system: 's', prompt: 'p' })).rejects.toThrow(
        /simulated crash|falló/,
      );
    } finally {
      if (saved === undefined) delete process.env.CLAUDE_STUB_MODE;
      else process.env.CLAUDE_STUB_MODE = saved;
    }
  });

  it('claudeCodeAvailable probes the binary', () => {
    expect(claudeCodeAvailable(STUB).ok).toBe(true);
    const missing = claudeCodeAvailable('/nonexistent/claude-bin');
    expect(missing.ok).toBe(false);
    expect(missing.detail).toContain('MCP');
  });
});

describe('extractor-docs adapters (Fase 3: PDF / docx / dispatch)', () => {
  const FIXTURES = join(import.meta.dirname, '..', 'test-fixtures');

  it('segments a PDF into one section per page with page locators', async () => {
    const sections = await loadDocumentSections(join(FIXTURES, 'manual-facturacion.pdf'));
    expect(sections).toHaveLength(2);
    expect(sections[0]).toMatchObject({
      doc_id: 'manual-facturacion',
      section: 'página 1',
      page: 1,
    });
    expect(sections[0]!.text).toContain('recargo del 10 por ciento');
    expect(sections[1]).toMatchObject({ section: 'página 2', page: 2 });
    expect(sections[1]!.text).toContain('pagan siempre por adelantado');
  });

  it('segments a docx by its headings via mammoth', async () => {
    const sections = await loadDocumentSections(join(FIXTURES, 'procedimiento-alta.docx'));
    expect(sections.map((s) => s.section)).toEqual([
      '1. Procedimiento de alta de pedido',
      '2. Condiciones de prepago',
    ]);
    // Title defaults to the first heading of the document.
    expect(sections[0]!.title).toBe('Procedimiento de alta de pedido');
    expect(sections[0]!.text).toContain('comprueba el riesgo del cliente');
    expect(sections[1]!.text).toContain('pagan por adelantado, sin excepciones');
    expect(sections[1]!.text).toContain('Verificar el CIF del cliente');
  });

  it('dispatches markdown files and derives doc_id from the file name', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'untacit-docs-'));
    writeFileSync(
      join(dir, 'Manual Comercial.md'),
      '# Manual comercial\n\nIntro.\n\n## Pagos\n\nPrepago a nuevos.\n',
      'utf8',
    );
    const sections = await loadDocumentSections(join(dir, 'Manual Comercial.md'));
    expect(sections[0]!.doc_id).toBe('manual-comercial');
    expect(sections[0]!.title).toBe('Manual comercial');
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects unsupported formats with an actionable error', async () => {
    await expect(loadDocumentSections('/tmp/informe.odt')).rejects.toThrow(/Unsupported document format/);
  });

  it('feeds PDF sections through the extraction agent with page locators intact', async () => {
    const sections = await loadDocumentSections(join(FIXTURES, 'manual-facturacion.pdf'));
    const llm = new MockLlmClient([
      { run_id: 'x', source_type: 'document', nodes: [], edges: [] },
      { run_id: 'x', source_type: 'document', nodes: [], edges: [] },
    ]);
    await extractFromSections(llm, sections, { now: NOW, sectionsPerCall: 1 });
    // The locator base handed to the agent must include the page number.
    expect(llm.requests[0]!.prompt).toContain('"page":1');
    expect(llm.requests[1]!.prompt).toContain('"page":2');
  });

  it('htmlToMarkdownish keeps headings, lists and entities', () => {
    const markdown = htmlToMarkdownish(
      '<h2>Pagos &amp; cobros</h2><p>Texto <strong>importante</strong>.</p><ul><li>uno</li><li>dos</li></ul>',
    );
    expect(markdown).toContain('## Pagos & cobros');
    expect(markdown).toContain('- uno');
    expect(markdown).toContain('Texto importante.');
  });
});
