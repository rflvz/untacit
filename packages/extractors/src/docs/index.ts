/**
 * extractor-docs (docs/03 §4.2): document (PDF/markdown/docx) → sections →
 * agent → validated batch. Parsing stays out of the agent: every format is
 * reduced to DocumentSection in load.ts before any LLM call.
 */

import { newRunId, validateBatch } from '@untacit/core';
import type { ExtractionBatch, ValidationIssue } from '@untacit/core';

import type { LlmClient } from '../llm.js';
import { parseJsonResponse } from '../llm.js';
import { PROMPT_VERSIONS, batchSchemaForLlm, docsSystemPrompt } from '../prompts.js';
import type { DocumentSection } from './load.js';

export * from './load.js';

export interface DocsExtractionOptions {
  sectionsPerCall?: number;
  now?: Date;
}

export interface DocsExtractionResult {
  batch: ExtractionBatch;
  rejections: ValidationIssue[];
  llmCalls: number;
}

export async function extractFromSections(
  llm: LlmClient,
  sections: DocumentSection[],
  opts: DocsExtractionOptions = {},
): Promise<DocsExtractionResult> {
  // Clamp hard: perCall < 1 (or NaN) would loop forever making real LLM calls.
  const rawPerCall = opts.sectionsPerCall ?? 4;
  const perCall = Number.isFinite(rawPerCall) ? Math.max(1, Math.floor(rawPerCall)) : 4;
  const runId = newRunId('document', opts.now ?? new Date());
  const merged: ExtractionBatch = {
    run_id: runId,
    source_type: 'document',
    extractor: { name: 'extractor-docs', model: llm.model, prompt_version: PROMPT_VERSIONS.docs },
    nodes: [],
    edges: [],
  };
  const rejections: ValidationIssue[] = [];
  let llmCalls = 0;

  for (let i = 0; i < sections.length; i += perCall) {
    const chunk = sections.slice(i, i + perCall);
    const blocks = chunk.map(
      (s) =>
        `### ${s.title} — sección ${s.section}\nlocator base: ${JSON.stringify({
          doc_id: s.doc_id,
          title: s.title,
          section: s.section,
          ...(s.page !== undefined ? { page: s.page } : {}),
        })}\n\n${s.text}`,
    );
    const raw = await llm.complete({
      system: docsSystemPrompt(),
      prompt: [
        `run_id: "${runId}", source_type: "document".`,
        'Extrae la lógica de negocio de estas secciones (recuerda: los documentos producen sobre todo policy/process/role; usa stance "contradicts" cuando el texto derogue o contradiga una norma).',
        '',
        ...blocks,
      ].join('\n'),
      schema: batchSchemaForLlm(),
    });
    llmCalls++;

    const parsed = parseJsonResponse(raw) as ExtractionBatch;
    const validation = validateBatch({ ...parsed, run_id: runId, source_type: 'document' });
    rejections.push(...validation.issues);
    if (validation.sanitized) {
      merged.nodes.push(...validation.sanitized.nodes.filter((n) => !merged.nodes.some((m) => m.type === n.type && m.mention.toLowerCase() === n.mention.toLowerCase())));
      merged.edges.push(...validation.sanitized.edges);
    }
  }

  return { batch: merged, rejections, llmCalls };
}
