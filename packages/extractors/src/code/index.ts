/**
 * extractor-code (docs/03 §4.1): candidates → agent → validated batch.
 * The returned batch is the emission contract only — persisting it goes
 * through core's importBatch (validator → resolver → canonical files).
 */

import { newRunId, validateBatch } from '@untacit/core';
import type { ExtractionBatch, ValidationIssue } from '@untacit/core';

import type { LlmClient } from '../llm.js';
import { parseJsonResponse } from '../llm.js';
import { PROMPT_VERSIONS, batchSchemaForLlm, codeSystemPrompt } from '../prompts.js';
import type { Candidate } from './candidates.js';

export * from './candidates.js';

export interface CodeExtractionOptions {
  /** Candidates per LLM call. */
  chunkSize?: number;
  commit?: string;
  now?: Date;
}

export interface ExtractionRunResult {
  batch: ExtractionBatch;
  rejections: ValidationIssue[];
  llmCalls: number;
}

export async function extractFromCandidates(
  llm: LlmClient,
  candidates: Candidate[],
  opts: CodeExtractionOptions = {},
): Promise<ExtractionRunResult> {
  const chunkSize = opts.chunkSize ?? 8;
  const runId = newRunId('code', opts.now ?? new Date());
  const merged: ExtractionBatch = {
    run_id: runId,
    source_type: 'code',
    extractor: { name: 'extractor-code', model: llm.model, prompt_version: PROMPT_VERSIONS.code },
    nodes: [],
    edges: [],
  };
  const rejections: ValidationIssue[] = [];
  let llmCalls = 0;

  for (let i = 0; i < candidates.length; i += chunkSize) {
    const chunk = candidates.slice(i, i + chunkSize);
    const prompt = buildPrompt(runId, chunk, opts.commit);
    const raw = await llm.complete({
      system: codeSystemPrompt(),
      prompt,
      schema: batchSchemaForLlm(),
    });
    llmCalls++;

    const parsed = parseJsonResponse(raw) as ExtractionBatch;
    // Per-chunk validation: salvage the good parts, log every rejection with
    // its reason — that log is the signal for iterating prompts (docs/03 §4).
    const validation = validateBatch({ ...parsed, run_id: runId, source_type: 'code' });
    rejections.push(...validation.issues);
    if (validation.sanitized) {
      appendBatch(merged, validation.sanitized);
    }
  }

  return { batch: merged, rejections, llmCalls };
}

function buildPrompt(runId: string, candidates: Candidate[], commit?: string): string {
  const blocks = candidates.map((c, idx) => {
    const locator = JSON.stringify({
      repo: c.repo,
      path: c.path,
      line_start: c.line_start,
      line_end: c.line_end,
      ...(commit ? { commit } : {}),
    });
    return `### Candidato ${idx + 1}\nlocator base: ${locator}\n\`\`\`\n${c.snippet}\n\`\`\``;
  });
  return [
    `run_id: "${runId}", source_type: "code".`,
    'Analiza estos fragmentos candidatos. Decide por cada uno si contiene lógica de negocio; si la contiene, emite los nodos y aristas correspondientes con su evidencia (ajusta line_start/line_end a las líneas exactas que respaldan cada afirmación).',
    '',
    ...blocks,
  ].join('\n');
}

/** Merge a sanitized chunk batch into the accumulated run batch (dedup by mention/type and edge triple). */
function appendBatch(target: ExtractionBatch, chunk: ExtractionBatch): void {
  const nodeKey = (n: { mention: string; type: string }) => `${n.type}|${n.mention.toLowerCase()}`;
  const seenNodes = new Set(target.nodes.map(nodeKey));
  for (const node of chunk.nodes) {
    if (!seenNodes.has(nodeKey(node))) {
      seenNodes.add(nodeKey(node));
      target.nodes.push(node);
    }
  }
  const edgeKey = (e: { type: string; source_mention: string; target_mention: string; stance?: string }) =>
    `${e.type}|${e.source_mention.toLowerCase()}|${e.target_mention.toLowerCase()}|${e.stance ?? 'supports'}`;
  const seenEdges = new Set(target.edges.map(edgeKey));
  for (const edge of chunk.edges) {
    if (!seenEdges.has(edgeKey(edge))) {
      seenEdges.add(edgeKey(edge));
      target.edges.push(edge);
    }
  }
}
