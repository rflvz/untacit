/** Script generation from graph gaps (docs/03 §4.3.2). */

import type { LlmClient } from '../llm.js';
import { parseJsonResponse } from '../llm.js';
import { interviewSystemPrompt } from '../prompts.js';
import type { CoverageGap } from './gaps.js';
import { FALLBACK_QUESTION } from './state.js';

/** Generate the opening script from graph gaps. */
export async function generateScript(llm: LlmClient, gaps: CoverageGap[]): Promise<string[]> {
  if (gaps.length === 0) return [FALLBACK_QUESTION];
  const raw = await llm.complete({
    system: interviewSystemPrompt(),
    prompt: [
      'Genera un guion de preguntas concretas (una por línea, sin numerar) a partir de estos huecos del grafo:',
      ...gaps.map((g) => `- ${g.detail}`),
      'Devuelve JSON: { "questions": ["...", "..."] }',
    ].join('\n'),
    schema: {
      type: 'object',
      properties: { questions: { type: 'array', items: { type: 'string' } } },
      required: ['questions'],
      additionalProperties: false,
    },
  });
  const parsed = parseJsonResponse(raw) as { questions: string[] };
  const questions = parsed.questions.filter((q) => q.trim().length > 0);
  return questions.length > 0 ? questions : [FALLBACK_QUESTION];
}
