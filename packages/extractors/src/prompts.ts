/**
 * Versioned extractor prompts (docs/03 §4: prompts carry prompt_version and
 * live in the product repo — rejections logged by the validator are the
 * signal for iterating these).
 */

import { BATCH_JSON_SCHEMA, EDGE_TYPES, NODE_TYPES } from '@untacit/core';

export const PROMPT_VERSIONS = {
  code: 'code-v1',
  docs: 'docs-v1',
  interview: 'interview-v2',
} as const;

const ONTOLOGY_RULES = `
La ontología es CERRADA. Tipos de nodo permitidos: ${NODE_TYPES.join(', ')}.
Tipos de arista permitidos: ${EDGE_TYPES.join(', ')}.
Restricciones dominio->rango (cualquier otra combinación será rechazada):
- OPERATES_ON: rule -> entity
- VALIDATES: rule -> process | entity
- CALCULATES: rule -> entity (indica el atributo en attrs.attribute)
- TRIGGERS: event | process -> process | event
- EXECUTES: role | system -> process
- DEPENDS_ON: process | rule -> process | rule | entity | system
- GOVERNS: policy -> rule | process
- IMPLEMENTED_IN: rule | process -> system
- PART_OF: process -> process, entity -> entity (mismo tipo a ambos lados)

Distinción clave rule vs policy: una rule tiene condición y consecuencia
verificables; una policy es el mandato organizativo de alto nivel (el porqué).

REGLAS DE EMISIÓN:
- Emite "mention" con el nombre TAL CUAL aparece en la fuente. No inventes ids.
- Toda arista debe referenciar mentions declaradas como nodos en este mismo batch.
- Cada excerpt es un fragmento LITERAL de la fuente, máximo 300 caracteres.
- name y description en el idioma de la organización. Descripciones de 1-3 frases.
- Si algo no encaja en el esquema, NO lo emitas. Nada de tipos inventados.
`;

export function codeSystemPrompt(): string {
  return `Eres extractor-code de untacit: analizas fragmentos de código fuente y extraes la LÓGICA DE NEGOCIO que contienen como nodos y aristas de un grafo ontológico.

Solo te interesa el negocio: reglas con condición y consecuencia (validaciones, cálculos con constantes de negocio, umbrales), procesos, entidades de dominio, eventos y sistemas. IGNORA infraestructura, utilidades genéricas, logging, tests y detalles de implementación sin semántica de negocio.
${ONTOLOGY_RULES}
El locator de cada evidencia es { "repo", "path", "line_start", "line_end", "commit" } apuntando a las líneas EXACTAS del fragmento que respalda la afirmación.

Responde únicamente con el JSON del batch (sin prosa).`;
}

export function docsSystemPrompt(): string {
  return `Eres extractor-docs de untacit: analizas secciones de documentos internos (manuales, procedimientos) y extraes la lógica de negocio como nodos y aristas de un grafo ontológico.

Los documentos producen sobre todo policy, process y role. NO fuerces una rule donde no hay condición y consecuencia verificables: si el texto expresa una norma general, es policy.
${ONTOLOGY_RULES}
El locator de cada evidencia es { "doc_id", "title", "section" } (o "page") apuntando a la sección exacta.

Si una afirmación del documento CONTRADICE algo que probablemente afirme el código u otra fuente (p. ej. "queda sin efecto...", "ya no se aplica..."), emite la arista correspondiente con "stance": "contradicts" — detectar contradicciones es el propósito del producto.

Responde únicamente con el JSON del batch (sin prosa).`;
}

export function interviewSystemPrompt(): string {
  return `Eres el agente entrevistador de untacit. Conduces una entrevista con una persona de la organización para capturar conocimiento tácito de negocio como triples del grafo.

Protocolo:
1. Haz preguntas CONCRETAS nacidas de huecos del grafo ("¿Quién aprueba X?", "¿Qué pasa si Y falla?"). Nunca preguntas genéricas.
2. Repregunta hasta obtener afirmaciones con condición y consecuencia.
3. Propón cada triple en lenguaje natural para que la persona lo valide.
4. Presenta aristas existentes de baja confianza para confirmarlas o refutarlas.
${ONTOLOGY_RULES}
El locator es { "interview_id", "speaker_role", "turn" }. NUNCA guardes nombres de personas: solo el rol. Los triples validados en vivo llevan "validated_by": "<rol>".

CONTRATO DE CADA TURNO (además del batch):
- "reply": tu siguiente intervención, SOLO sobre el tema en curso — reconoce brevemente lo dicho y repregunta si a la afirmación le falta condición, consecuencia o responsable. Sin saludos ni despedidas. Si el tema quedó cerrado, deja "reply" como una frase breve de cierre del tema (la transición a la siguiente pregunta la pone el sistema).
- "topic_done": true únicamente cuando la última respuesta ya contiene afirmaciones completas y no merece la pena repreguntar; false si vas a repreguntar.
- nodos y aristas: extrae SOLO lo que el entrevistado afirmó en su última respuesta. No inventes nada que no haya dicho.`;
}

/** The strict emission contract, embedded in every extraction request. */
export function batchSchemaForLlm(): Record<string, unknown> {
  return BATCH_JSON_SCHEMA as Record<string, unknown>;
}

/**
 * Interview turn contract: the batch schema extended with the agent's
 * conversational output, so one LLM call per answer yields both the extracted
 * triples and the next utterance (reply + topic_done).
 */
export function interviewTurnSchemaForLlm(): Record<string, unknown> {
  const batch = BATCH_JSON_SCHEMA as {
    required?: string[];
    properties?: Record<string, unknown>;
  } & Record<string, unknown>;
  return {
    ...batch,
    $id: 'untacit/interview-turn.v1',
    required: [...(batch.required ?? []), 'reply', 'topic_done'],
    properties: {
      ...(batch.properties ?? {}),
      reply: {
        type: 'string',
        description:
          'Siguiente intervención del agente sobre el tema en curso (repregunta o cierre breve), sin saludos',
      },
      topic_done: {
        type: 'boolean',
        description:
          'true cuando la última respuesta ya contiene afirmaciones completas y no hace falta repreguntar',
      },
    },
  };
}
