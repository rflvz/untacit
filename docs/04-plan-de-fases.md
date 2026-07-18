# untacit — Plan de fases

> Estado: borrador v1. Cada fase termina con un criterio de salida verificable y algo dogfoodeado en Diseños NT. Tamaños relativos (S/M/L), sin estimaciones en horas: el orden está dictado por riesgo, no por calendario.

## Filosofía

El riesgo existencial del producto **no es la UI ni el MCP: es la calidad de la extracción**. Si los agentes no producen aristas mayoritariamente correctas sobre fuentes reales, nada de lo demás importa. Por eso la validación de la tesis (Fase 1) va antes que el visualizador, y el visualizador mínimo va antes que los extractores difíciles: sin ver el grafo no se puede evaluar bien la extracción.

Dependencias: `0 → 1 → 2 → 3 → 4 → 5 → 6 → 7`, con 3 y 4 intercambiables si conviene.

---

## Fase 0 — Cimientos (S)

Repo y contrato de datos. Sin LLM todavía.

**Entregables**

- Monorepo pnpm con `core`, `cli` y esqueletos vacíos del resto (estructura de `03-arquitectura.md §2`).
- Serializador canónico (nodo ↔ fichero markdown con frontmatter, orden determinista) con tests de ida y vuelta; JSON Schema del batch de extracción; validador (schema + dominio→rango) con tests.
- Índice derivado: esquema SQLite completo y `untacit index` (reconstrucción total e incremental desde ficheros).
- CLI: `untacit init` (crea el repo de grafo con su `.gitignore`), `untacit import <batch.json>`, `untacit stats`.
- Dataset sintético inicial en `examples/`: un repo de grafo de juguete (~30 nodos, ~60 aristas) escrito a mano en formato canónico. Sirve para desarrollo, para los tests y después para el release.

**Criterio de salida**: importar el dataset sintético por CLI y consultarlo con `stats` y con una query FTS; que el validador rechace correctamente un batch malformado de test; y que re-importar el mismo batch deje el repo de grafo con `git status` limpio (serialización determinista, idempotencia demostrada).

**Riesgo**: sobrediseñar el core antes de tener datos reales. Mitigación: el core de esta fase es solo lo que la CLI necesita.

---

## Fase 1 — Extractor de código y validación de la tesis (M)

La fase gate del proyecto.

**Entregables**

- `extractor-code` completo: localización de candidatos con tree-sitter, agente clasificador/emisor, pipeline validador → resolver (versión mínima: solo match exacto de alias) → commit a run.
- Ejecución sobre **un repo real de Diseños NT** (elegir el de mayor densidad de lógica de negocio).
- Protocolo de evaluación manual: muestra aleatoria de 50 aristas, revisadas a mano con tres veredictos — correcta / incorrecta / correcta-pero-irrelevante.

**Criterio de salida (GATE)**: ≥80% de aristas correctas en la muestra. Entre 60–80%: iterar prompts y heurísticas de candidatos y repetir. **<60%: parar y replantear el enfoque de extracción antes de escribir una sola línea de UI.**

**Riesgos**: ruido infra/negocio (mitigación: heurísticas de foco por capas y exclusiones en config); coste de API descontrolado (mitigación: presupuesto por run, extracción por paths acotados).

---

## Fase 2 — Visualizador mínimo (M)

**Entregables**

- App Tauri con sidecar del core.
- Vista de grafo global (Sigma.js): color por tipo, grosor por confianza, filtros por tipo/confianza/estado, búsqueda FTS.
- Panel de detalle con evidencias (excerpt + locator clicable que abre el fichero local).

**Criterio de salida**: navegando el grafo del dataset sintético (`examples/acme-manufactura`), localizar tres reglas de negocio y llegar desde cada una a su línea de código en menos de un minuto, sin usar la terminal.

**Riesgo**: rabbit hole de estética del grafo. Mitigación: layout por defecto de Sigma, cero física personalizada en v1.

---

## Fase 3 — Documentos y resolución de entidades (L)

La fase técnicamente más dura por la canonicalización.

**Entregables**

- `extractor-docs` (PDF/MD/docx) con locator por sección/página.
- Resolver completo: match exacto → difuso → zona gris con propuestas de merge; tabla `merges` reversible.
- Pipeline de embeddings (modelo local multilingüe, incremental por hash) en el índice derivado: nace aquí porque el match difuso del resolver lo necesita; en Fase 5 lo reutiliza la recuperación híbrida.
- Cola de revisión en la app: bandeja de merges y bandeja de baja confianza.
- Ejecución sobre un lote real de documentos internos de Diseños NT (manuales, procedimientos).

**Criterio de salida**: tras extraer código + docs, una muestra de 30 entidades no contiene duplicados evidentes sin propuesta de merge asociada; al menos un caso real donde código y documento aportan evidencia a la misma arista (la señal multi-fuente funciona).

**Riesgos**: sobre-merge silencioso (mitigación: umbrales conservadores, todo lo dudoso a la cola); documentos obsoletos que ensucian el grafo (mitigación: es una feature — deben aflorar como conflictos, no filtrarse a mano antes de entrar).

---

## Fase 4 — Entrevistas agénticas (L)

La feature diferencial.

**Entregables**

- Agente entrevistador con el protocolo de `03-arquitectura.md §4.3`: selección de huecos, guion, entrevista, propuesta de triples en vivo, verificación cruzada de aristas de baja confianza.
- Vista de entrevista en la app: chat + panel de triples con aceptar/editar/rechazar.
- Dos entrevistas reales en Diseños NT: una al propio autor (bootstrap) y una a un rol no técnico (administración o producción).

**Criterio de salida**: las dos entrevistas añaden ≥20 aristas validadas en vivo y producen ≥1 conflicto o confirmación cruzada contra evidencia de código o documentos. Prueba de usabilidad implícita: la persona no técnica completa la sesión sin ayuda.

**Riesgos**: el agente hace preguntas genéricas (mitigación: el guion nace de huecos concretos del grafo, no de una plantilla); fricción de validar triple a triple (mitigación: aceptar en bloque con excepciones, redacción de triples en lenguaje natural).

---

## Fase 5 — MCP y drift (M)

**Entregables**

- Servidor MCP stdio con las seis tools de `03-arquitectura.md §6`, con Zod, structuredContent y annotations; `untacit_context` con recuperación híbrida completa (fusión RRF léxico + vectorial y expansión tipada, §6.1).
- Drift sobre git: `untacit diff` entre refs del repo de grafo, presentado en términos de ontología (no de líneas YAML), en CLI y app; hook post-merge de ejemplo para re-extracción parcial; flujo de extracción-como-PR documentado y ejecutado al menos una vez.
- Set de 10 evals read-only sobre el dataset sintético, con respuestas verificables.

**Criterio de salida**: Claude Code, con el MCP conectado y sin acceso a las fuentes, responde correctamente ≥8/10 evals. Un cambio real en el repo de Diseños NT dispara drift y el diff muestra el cambio de regla correspondiente.

**Riesgo**: tools que devuelven demasiado y queman contexto (mitigación: límites y paginación por defecto, respuestas resumidas con opción de profundizar vía `untacit_evidence`).

---

## Fase 6 — Release open source (M)

**Entregables**

- Auditoría de privacidad: ni un dato de Diseños NT en el historial de git (si lo hubo, reescritura de historia o repo nuevo).
- `examples/` ampliado a un grafo sintético demostrativo (~150 nodos) con guion de demo.
- README en inglés con la tesis, GIF del visor, benchmark propio estilo CodeGraph: misma pregunta de negocio respondida por un agente con y sin untacit (tool calls, aciertos).
- Licencia (MIT, pendiente de confirmar), CONTRIBUTING, CI (build + tests + evals sobre el dataset sintético).

**Criterio de salida**: instalación limpia desde el repo público en una máquina ajena siguiendo solo el README, demo funcional con `examples/` en <10 minutos.

---

## Fase 7 — Servidor MCP HTTP autoalojado por empresa (L)

El grafo deja de estar atado a la máquina de cada usuario: cada empresa despliega **una instancia** (Docker) que sirve **sus grafos** por Streamable HTTP con usuarios propios y login. Diseño completo y decisiones cerradas en [`06-servidor-http-autoalojado.md`](06-servidor-http-autoalojado.md); **se desarrolla de una sola vez** — los seis pasos de su §11 son los commits de esta fase, no fases del plan.

**Entregables**

- Paquete `@untacit/server` (bin `untacit-server`): multi-grafo (`/graphs/<id>/mcp`), OAuth 2.1 del spec MCP con almacén local de usuarios (scrypt, tokens opacos revocables, PKCE, registro dinámico de clientes), página de login propia, permisos por usuario→grafo y CLI de administración (`user add | grant | revoke | status`). Sin IdP externo en v1.
- Endpoint Streamable HTTP con sesiones (`mcp-session-id` ligada a usuario+grafo), guards (Host/Origin, grants, `resource` RFC 8707), metadata RFC 9728 por grafo y `/healthz`. Por defecto solo las tools de consulta (`tools: "query" | "agent"` por grafo); write-gate fuera de v1 — el servidor jamás escribe fuera de `<dataDir>` y `.untacit/`.
- Embeddings de serie (prioridad de producto): imagen Docker con el modelo local pre-sembrado (funciona en air-gap) y refresco incremental automático tras cada reindexado (`GraphIndex.updateEmbeddings`); el mantenimiento del grafo en la empresa se reduce a un cron de `git pull`.
- `deploy/`: Dockerfile multi-stage (variante SLIM opcional), docker-compose con volúmenes `/data` + `/graphs`, healthcheck y Caddy opcional para TLS; paso `docker build` en CI.
- `docs/07-guia-despliegue-autoalojado.md` (esquema ya definido en 06 §10) + README raíz y del paquete.
- Cambios mínimos fuera del paquete nuevo: `ServeOptions.agentSurface` y mensaje claro de `untacit_diff` sin git en `packages/mcp`; `GraphIndex.openReadonly` en core (para el modo stateless v1.1). El camino stdio y `serveMcpHttp` local no se tocan.

**Criterio de salida**: con la instancia Docker sirviendo el dataset sintético, un usuario creado por CLI conecta Claude Code a su URL (`claude mcp add --transport http`), completa el login OAuth en el navegador y `untacit_context` responde **en modo híbrido con el canal semántico activo** (verificado, no en fallback FTS silencioso); un segundo usuario sin grant sobre ese grafo recibe 403 y una sesión ajena 404; checklist de seguridad de 06 §12 revisado punto a punto antes del merge.

**Riesgos**: interoperabilidad del flujo OAuth con clientes reales (mitigación: probar con MCP Inspector y Claude Code desde el primer commit de OAuth, no al final); imagen con dependencias nativas + capa de modelo (mitigación: smoke `docker build` en CI). El modo stateless/Vercel queda diseñado como v1.1 opcional (06 §4.6 y §8.2) con recuperación degradada a FTS/hash — no bloquea esta fase, coherente con la prioridad embeddings > Vercel.

---

## Después del dogfood (no planificar todavía, solo registrar)

- Extractor de ERP/BD (la fuente excluida de v1).
- Vistas de proceso curadas con React Flow; export a Obsidian/imagen.
- Ontología extensible por el usuario (v2 del esquema).
- Modo multi-workspace (varios grafos por organización) — la vertiente servidor la cubre la Fase 7 (multi-grafo con permisos por usuario); queda pendiente solo la vertiente escritorio/local.

## Traslado a Linear

Cada fase mapea a un proyecto/épica con sus entregables como issues y los criterios de salida como definición de done. Montarlo al cerrar la revisión de estos documentos, empezando solo por Fases 0–2: planificar en detalle más allá del gate de la Fase 1 es especulativo por definición.
