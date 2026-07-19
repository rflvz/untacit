/**
 * Agent surface of the untacit MCP server: everything a host with its own
 * model (Claude Code, Claude Desktop) needs to run extraction and interviews
 * against the graph WITHOUT untacit calling any LLM itself.
 *
 * - Deterministic read tools: interview gap analysis + verification targets,
 *   code candidates (heuristic scan), document sections (segmentation with
 *   locators).
 * - MCP prompts serving the versioned extractor protocols (docs/03 §4), so
 *   the host model follows the exact same emission contract as the built-in
 *   engine. They emit through untacit_import_batch, which lives in the write
 *   surface (src/review.ts) and needs the server running with writes enabled.
 */

import { BATCH_JSON_SCHEMA, GraphIndex } from '@untacit/core';
import {
  PROMPT_VERSIONS,
  codeSystemPrompt,
  docsSystemPrompt,
  findCoverageGaps,
  interviewSystemPrompt,
  loadDocumentSections,
  scanRepo,
  slugifyDocId,
  verificationTargets,
} from '@untacit/extractors';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

const READ_ONLY = { readOnlyHint: true, openWorldHint: false } as const;

export function registerAgentSurface(server: McpServer, repoRoot: string): void {
  // ---------------------------------------------------------------------------
  // untacit_interview_gaps — where the graph is weakest (docs/03 §4.3.1 + .5)
  // ---------------------------------------------------------------------------
  server.registerTool(
    'untacit_interview_gaps',
    {
      title: 'Interview targets: coverage gaps and claims to verify',
      description:
        'Zones of the graph worth interviewing about: processes nobody executes or nothing ' +
        'triggers, isolated nodes, and existing low-confidence edges rendered as natural-language ' +
        'claims to confirm or refute with the interviewee. Use this to derive a CONCRETE question ' +
        'script before an interview (see the untacit-interview prompt). Takes no required input.',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe('Max gaps (default 12)'),
        verifications_limit: z.number().int().min(1).max(20).optional().describe('Max claims to verify (default 5)'),
      },
      annotations: READ_ONLY,
    },
    async ({ limit, verifications_limit }) => {
      const index = GraphIndex.open(repoRoot);
      try {
        const gaps = findCoverageGaps(index, limit ?? 12);
        const verifications = verificationTargets(index, verifications_limit ?? 5);
        const lines = [
          ...gaps.map((g) => `[${g.kind}] ${g.detail}`),
          ...(verifications.length > 0
            ? [
                '',
                'Afirmaciones de baja confianza para confirmar o refutar en vivo:',
                ...verifications.map(
                  (v) => `- ${v.statement} (confianza actual ${v.confidence}; arista ${v.sourceId} -${v.edgeType}-> ${v.targetId})`,
                ),
              ]
            : []),
        ];
        return {
          content: [
            {
              type: 'text',
              text: lines.length > 0 ? lines.join('\n') : 'Sin huecos detectados: el grafo cubre sus procesos.',
            },
          ],
          structuredContent: { gaps, verifications } as unknown as Record<string, unknown>,
        };
      } finally {
        index.close();
      }
    },
  );

  // ---------------------------------------------------------------------------
  // untacit_code_candidates — deterministic half of extractor-code (§4.1)
  // ---------------------------------------------------------------------------
  server.registerTool(
    'untacit_code_candidates',
    {
      title: 'Business-logic candidates in a source repo',
      description:
        'Heuristic scan of a source repository for business-logic candidates (domain conditionals, ' +
        'business constants, reject/throw paths); infra, tests and generic utilities are excluded. ' +
        'Classify each candidate yourself and emit a batch via untacit_import_batch (see the ' +
        'untacit-extract-code prompt). Example: { "repo_path": "/home/user/web-pedidos", "repo_name": "web-pedidos" }.',
      inputSchema: {
        repo_path: z.string().describe('Absolute path of the source repo to scan'),
        repo_name: z.string().optional().describe('Repo name recorded in code locators (default: last path segment)'),
        max: z.number().int().min(1).max(200).optional().describe('Max candidates (default 50)'),
        paths: z
          .array(z.string())
          .optional()
          .describe('Repo-relative files/dirs to scan instead of the whole repo (partial re-extraction, e.g. the paths a merge changed)'),
      },
      annotations: READ_ONLY,
    },
    async ({ repo_path, repo_name, max, paths }) => {
      const cap = max ?? 50;
      const name = repo_name ?? repo_path.replace(/\/+$/, '').split('/').pop() ?? repo_path;
      const candidates = scanRepo(repo_path, {
        repoName: name,
        maxCandidates: cap,
        ...(paths !== undefined ? { paths } : {}),
      });
      const lines = candidates.map(
        (c) => `${c.path}:${c.line_start}-${c.line_end} [${c.signals.join(', ')}]\n${c.snippet}`,
      );
      return {
        content: [
          {
            type: 'text',
            text: candidates.length > 0 ? lines.join('\n\n---\n\n') : `No candidates found under ${repo_path}.`,
          },
        ],
        structuredContent: { repo: name, candidates } as unknown as Record<string, unknown>,
      };
    },
  );

  // ---------------------------------------------------------------------------
  // untacit_doc_sections — deterministic half of extractor-docs (§4.2)
  // ---------------------------------------------------------------------------
  server.registerTool(
    'untacit_doc_sections',
    {
      title: 'Segment documents into locatable sections',
      description:
        'Load internal documents (.md/.markdown/.txt by headings, .pdf per page, .docx by headings) ' +
        'into sections carrying their locator (doc_id + section/page). Extract business logic from ' +
        'each section and emit a batch via untacit_import_batch (see the untacit-extract-docs ' +
        'prompt). Example: { "files": ["/docs/manual-comercial.pdf"] }.',
      inputSchema: {
        files: z.array(z.string()).min(1).describe('Absolute paths of the documents to segment'),
        limit: z.number().int().min(1).max(100).optional().describe('Max sections returned (default 40)'),
        offset: z.number().int().min(0).optional().describe('Skip this many sections (pagination)'),
      },
      annotations: READ_ONLY,
    },
    async ({ files, limit, offset }) => {
      const sections = [];
      const usedDocIds = new Set<string>();
      for (const file of files) {
        const base = slugifyDocId(file);
        let docId = base;
        for (let n = 2; usedDocIds.has(docId); n++) docId = `${base}-${n}`;
        usedDocIds.add(docId);
        sections.push(...(await loadDocumentSections(file, { docId })));
      }
      const start = offset ?? 0;
      const cap = limit ?? 40;
      const page = sections.slice(start, start + cap);
      const lines = page.map(
        (s) => `[${s.doc_id} · ${s.section}${s.page !== undefined ? ` · página ${s.page}` : ''}]\n${s.text}`,
      );
      if (start + page.length < sections.length) {
        lines.push(`(… ${sections.length - start - page.length} secciones más — repite con offset=${start + page.length})`);
      }
      return {
        content: [{ type: 'text', text: page.length > 0 ? lines.join('\n\n---\n\n') : 'No sections.' }],
        structuredContent: {
          total: sections.length,
          offset: start,
          sections: page,
        } as unknown as Record<string, unknown>,
      };
    },
  );

  // ---------------------------------------------------------------------------
  // Prompts: the versioned extractor protocols (docs/03 §4) served over MCP
  // ---------------------------------------------------------------------------
  const batchContract = (sourceType: string): string =>
    [
      `Contrato de emisión (untacit/extraction-batch.v1, source_type "${sourceType}"):`,
      JSON.stringify(BATCH_JSON_SCHEMA),
      'Cuando tengas el batch, impórtalo con la tool untacit_import_batch (requiere el servidor con --write).',
    ].join('\n');

  server.registerPrompt(
    'untacit-interview',
    {
      title: 'Entrevista agéntica (protocolo docs/03 §4.3)',
      description:
        `Conduce una entrevista de captura de conocimiento tácito (${PROMPT_VERSIONS.interview}): ` +
        'huecos → guion → repreguntas → triples validados en vivo → verificación cruzada → import.',
      argsSchema: {
        role: z.string().describe('Rol de la persona entrevistada (p. ej. "administracion") — NUNCA su nombre'),
      },
    },
    ({ role }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              interviewSystemPrompt(),
              '',
              `Rol del entrevistado: ${role}. Genera un interview_id corto y úsalo en todos los locators.`,
              'Pasos: (1) llama a untacit_interview_gaps y deriva un guion de preguntas CONCRETAS;',
              '(2) entrevista a la persona, repreguntando hasta obtener condición y consecuencia;',
              '(3) propón cada triple en lenguaje natural y captura solo lo que acepte o corrija;',
              '(4) presenta las afirmaciones de baja confianza para confirmar (evidencia supports con validated_by) o refutar (stance contradicts);',
              '(5) al cerrar, emite el batch (source_type "interview", validated_by = rol) y llama a untacit_import_batch.',
              '',
              batchContract('interview'),
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'untacit-extract-code',
    {
      title: 'Extracción de lógica de negocio desde código (docs/03 §4.1)',
      description: `Protocolo del extractor de código (${PROMPT_VERSIONS.code}): candidatos → clasificación → batch → import.`,
      argsSchema: {
        repo_path: z.string().describe('Ruta absoluta del repo fuente a extraer'),
      },
    },
    ({ repo_path }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              codeSystemPrompt(),
              '',
              `Repo objetivo: ${repo_path}.`,
              'Pasos: (1) llama a untacit_code_candidates con esa ruta; (2) clasifica cada candidato',
              '(¿negocio o infraestructura?) leyendo el código que necesites; (3) emite el batch',
              '(source_type "code", locators con repo/path/líneas exactas) y llama a untacit_import_batch.',
              '',
              batchContract('code'),
            ].join('\n'),
          },
        },
      ],
    }),
  );

  server.registerPrompt(
    'untacit-extract-docs',
    {
      title: 'Extracción desde documentos internos (docs/03 §4.2)',
      description: `Protocolo del extractor de documentos (${PROMPT_VERSIONS.docs}): secciones → batch → import.`,
      argsSchema: {
        files: z.string().describe('Rutas absolutas de los documentos, separadas por comas'),
      },
    },
    ({ files }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: [
              docsSystemPrompt(),
              '',
              `Documentos: ${files}.`,
              'Pasos: (1) llama a untacit_doc_sections con esas rutas (pagina con offset si hay muchas);',
              '(2) extrae por sección con su locator exacto (doc_id + sección/página); (3) emite el batch',
              '(source_type "document") y llama a untacit_import_batch.',
              '',
              batchContract('document'),
            ].join('\n'),
          },
        },
      ],
    }),
  );
}
