# untacit — Arquitectura técnica

> Estado: borrador v2 (incorpora la decisión repo-first). Depende de `02-ontologia-spec.md` (modelo de datos) y alimenta `04-plan-de-fases.md` (orden de construcción).

## 1. Vista general

```
  FUENTES               EXTRACCIÓN                    CORE                      CONSUMO
┌────────────┐    ┌─────────────────────┐    ┌────────────────────┐    ┌──────────────────┐
│ repos git  │───▶│ extractor-code      │    │ validador          │    │ desktop app      │
│ docs (pdf, │───▶│ extractor-docs      │───▶│ resolver           │◀──▶│ (Tauri + React + │
│  md, docx) │    │ extractor-interview │    │ serializador       │    │  Sigma.js)       │
│ personas   │───▶│ (motor: Claude Code)│    │ canónico           │    ├──────────────────┤
└────────────┘    └─────────────────────┘    └─────────┬──────────┘    │ MCP server stdio │
                                                       ▼               │ (Claude Code y   │
                                        ┌────────────────────────────┐ │  otros agentes)  │
                                        │ REPO DE GRAFO (git)        │ └────────┬─────────┘
                                        │  graph/**/*.md (canónico)  │◀─────────┘
                                        │  .untacit/index.db         │
                                        │  (derivado, gitignored)    │──push/pull──▶ GitHub
                                        └────────────────────────────┘
```

Principios rectores: **un solo core en TypeScript** que sirve a tres frontales (CLI, MCP, app), y **repo-first**: la verdad del sistema son ficheros de texto plano en un repositorio git; SQLite es un índice derivado y regenerable.

## 2. Decisión de lenguaje y estructura del repo del producto

Todo TypeScript salvo el shell de Tauri (Rust generado, sin lógica propia). Razones: el Agent SDK y el MCP SDK recomendado son TS; el frontend es TS; es el stack principal del autor; un solo lenguaje elimina duplicación de modelo de datos.

```
untacit/
  packages/
    core/          # esquema, serializador canónico, validador, índice SQLite, resolver, retrieval, diff, pipeline. Sin dependencias de UI ni de LLM
    extractors/    # agentes (motor Claude Code): code, docs, interview. Dependen de core
    mcp/           # servidor MCP (stdio o Streamable HTTP) sobre core
    cli/           # untacit init | import | index | embed | stats | search | conflicts | diff | doctor | extract | interview | update | serve-mcp
    app/           # Tauri 2 + React + Vite + Tailwind
    server/        # servidor MCP HTTP multi-grafo autoalojado con OAuth (docs/06)
    sdk/           # @untacit/sdk: superficie programática estable para automatizaciones (contrato semver sobre core + mcp)
  docs/            # estos documentos
  examples/        # repo de grafo sintético (empresa ficticia de manufactura) en formato canónico
```

Monorepo con pnpm workspaces. `core` no importa nada de `extractors` ni de `app`: la dependencia va siempre hacia el core.

## 3. Almacenamiento: repo-first

Decisión estructural: **la representación canónica del grafo son ficheros de texto plano en un repositorio git dedicado** (el "repo de grafo"). GitHub como remoto (privado para Diseños NT) resuelve la persistencia en la nube, el backup, el historial y los permisos sin construir backend alguno. SQLite queda relegado a **índice local derivado**, nunca versionado.

Layout del repo de grafo:

```
<graph-repo>/
  untacit.config.json           # fuentes, exclusiones, umbrales, idioma
  graph/
    entity/entity-cliente.md    # un fichero markdown por nodo, agrupado por tipo
    rule/rule-bloqueo-pedido-sin-prepago.md
    process/…  policy/…  event/…  system/…  role/…
  runs/
    2026-07-13T10-30-code.json  # metadatos del run: extractor, modelo, prompt_version, stats, commit
  .gitignore                    # .untacit/
  .untacit/
    index.db                    # SQLite + FTS5 + vectores de nodo, derivado y regenerable
```

Formato de fichero de nodo — markdown con frontmatter YAML; **el `id` del nodo es el nombre del fichero**:

```markdown
---
type: rule
name: Bloqueo de pedido sin prepago
status: active
aliases: [regla de prepago]
attrs: {}
edges:
  - type: VALIDATES
    target: process/process-alta-pedido
    confidence: 0.9
    status: active
    evidence:
      - source_type: code
        locator: { repo: web-pedidos, path: src/checkout.ts, line_start: 84, line_end: 91, commit: abc123 }
        excerpt: "if (customer.isNew && !order.prepaid) reject(…)"
        stance: supports
        extracted_at: 2026-07-13
        run: 2026-07-13T10-30-code
---

Se rechaza el pedido de un cliente nuevo sin pago registrado.
```

Las aristas viven en el fichero del nodo **origen**; la evidencia propia de un nodo, en una clave `evidence` de su frontmatter. Ventajas del formato: GitHub lo renderiza tal cual, Obsidian abre `graph/` como vault (con su vista de grafo incluida, gratis), y `git log` sobre un fichero es la historia completa de ese elemento de negocio.

**Serialización canónica** — requisito duro del core, no una convención: orden estable de claves del frontmatter, aristas ordenadas por `(type, target)`, evidencias por `(source_type, locator)`, YAML normalizado (quoting y formato fijos). Consecuencia operativa: re-extraer sin cambios en las fuentes deja el working tree limpio; **la idempotencia del sistema se verifica con `git status`**.

**Índice derivado**: `.untacit/index.db` (better-sqlite3 con FTS5 + su sombra `fts5vocab` para estadísticas de términos, una tabla `embeddings` de BLOBs float32 — un vector mean-pooled por nodo — y una tabla `embeddings_facets` con varios vectores por nodo para la interacción tardía de §6.1; k-NN por escaneo lineal, suficiente a escala v1 — sqlite-vec queda como upgrade si el grafo lo desborda) se reconstruye desde los ficheros con `untacit index`; app y MCP reindexan automáticamente al detectar hashes cambiados (post-pull, post-checkout, edición manual). El índice incluye los **embeddings de nodo** (sobre `type + name + aliases + description`), calculados con un modelo local multilingüe (familia e5/bge vía transformers.js, pluggable) e incrementales por hash de contenido: los vectores son dato derivado y jamás entran en el repo. Sirven a dos consumidores — el match difuso del resolver y la recuperación híbrida del MCP (§6.1). Toda lectura (búsqueda FTS, vecindarios, CTEs recursivas de impacto) va contra el índice; **toda escritura va primero a ficheros y después al índice**. El esquema relacional (nodes, node_aliases, edges, evidence, conflicts, merges, search) se conserva del diseño anterior, pero sin exigencia de durabilidad: el índice se puede borrar y regenerar en cualquier momento, y su DDL definitivo vive en `core/src/index/`.

Escala: objetivo v1 ~10k nodos / ~50k aristas ≈ 10k ficheros pequeños; tanto git como la reconstrucción del índice lo manejan sin fricción. Kùzu sigue documentada como plan B *del índice* si las consultas de caminos se vuelven cuello de botella — el formato canónico no cambiaría.

**Dónde vive el repo de grafo**: repositorio dedicado por organización (p. ej. `disenos-nt-graph`, privado), separado de los repos de código fuente; `untacit.config.json` apunta a las fuentes. El modo subcarpeta (grafo dentro de un repo existente) queda soportado, pero el default es repo dedicado.

**Acceso desde la app**: el core corre como *sidecar* de Tauri (proceso Node local que expone la API del core por IPC). Alternativa descartada: reimplementar serializador, validador y resolver en Rust con tauri-plugin-sql, duplicando el modelo en un segundo lenguaje.

## 4. Extractores (motor: Claude Code)

Patrón común a los tres:

```
fuente → segmentación → agente (system prompt + esquema de batch v1) → batch JSON
      → validador (JSON Schema + dominio→rango) → staging → resolver de entidades
      → serializador canónico → ficheros del repo de grafo → commit del run → reindex
```

Los batches JSON (`02-ontologia-spec.md §8`) son el contrato de emisión de los agentes y **nunca se persisten**: se materializan en ficheros canónicos. Reglas compartidas: todo lo rechazado por el validador se registra con motivo (es señal para iterar prompts); cada ejecución completa es un run que termina en commit; los prompts llevan `prompt_version` y viven en el repo del producto.

**Motor LLM**: el razonamiento corre siempre sobre **Claude Code / Claude Desktop**, nunca contra la API directa. Dos vías equivalentes: (a) el `LlmClient` de `extractors` invoca el CLI `claude` local en modo print (`--print --output-format json --tools ""`), heredando la autenticación que Claude Code ya tenga — es lo que usan la CLI de untacit y el sidecar de la app; (b) el host (Claude Code o Claude Desktop) conduce la extracción o la entrevista él mismo vía MCP, usando las tools agénticas y los prompts versionados del servidor (§6) — la única puerta de escritura es `untacit_import_batch`, siempre a través del mismo pipeline validador → resolver → serializador → commit.

### 4.1 extractor-code

- **No reinventa el parsing**: usa tree-sitter (o el índice de CodeGraph si está presente en el repo objetivo) para localizar *candidatos*: funciones con condicionales sobre términos de dominio, validaciones, cálculos con constantes de negocio, mensajes de error de negocio.
- El agente decide por candidato: ¿es lógica de negocio o infraestructura? Si es negocio, emite `rule`/`process` + aristas con evidencia (path, líneas, commit).
- Heurística de foco: capas de dominio y aplicación; excluir infra, tests y utilidades genéricas por configuración (`untacit.config.json`).

### 4.2 extractor-docs

- Entrada: PDF, Markdown, docx en carpetas configuradas.
- Segmentación por secciones/páginas; el locator guarda `doc_id + sección/página`.
- Sesgo esperado: los documentos producen sobre todo `policy` y `process`; el prompt lo explicita para no forzar `rule` donde no hay condición verificable.

### 4.3 extractor-interview (entrevistas agénticas)

La pieza diferencial. Protocolo del agente entrevistador:

1. **Selección de objetivo**: consulta el grafo y elige zonas de baja cobertura (tipos ausentes alrededor de un proceso) o baja confianza.
2. **Guion**: genera preguntas concretas a partir de esos huecos ("¿Quién aprueba X?", "¿Qué pasa si Y falla?").
3. **Entrevista**: conversación en la app (o CLI) con la persona; el agente repregunta hasta obtener afirmaciones con condición y consecuencia.
4. **Propuesta en vivo**: por cada afirmación, muestra el triple propuesto en un panel lateral; el entrevistado **acepta, corrige o rechaza** cada uno.
5. **Verificación cruzada**: además de capturar, el agente presenta aristas existentes de baja confianza sobre el mismo tema para confirmar (sube confianza, `validated_by` = rol) o refutar (evidencia `contradicts` → conflicto).
6. **Commit**: los triples aceptados entran con confianza 0.95; la sesión completa queda como run de tipo interview.

Privacidad: en el grafo y en las evidencias se guarda el **rol** del entrevistado, nunca el nombre. La transcripción completa de la entrevista no entra en el repo de grafo: solo los excerpts de evidencia (≤300 caracteres).

## 5. Runs, drift y flujo de revisión

Con repo-first, la maquinaria de historial se delega en git:

- **Un run = un commit** en el repo de grafo. `runs/<id>.json` guarda los metadatos y el hash del commit asociado.
- **Diff y drift = `git diff`** entre commits o tags, presentado por CLI, app y MCP en términos de la ontología (aristas añadidas / retiradas / con confianza o estado cambiados), no de líneas de YAML.
- **Extracción como pull request** (flujo recomendado desde la Fase 5): el extractor escribe en una rama y abre PR; el cambio de lógica de negocio se revisa exactamente igual que se revisa código. La cola de revisión de la app y la PR son dos vistas del mismo evento.
- Re-extracción parcial: hook post-merge en los repos fuente o bajo demanda, solo sobre los paths cambiados. Las aristas cuya única evidencia apuntaba a un fragmento desaparecido se marcan `stale` en vez de borrarse.
- Sin file-watcher permanente en v1: cada re-extracción cuesta llamadas a la API. Es la diferencia asumida con CodeGraph, donde la sincronización continua es barata porque el parsing es determinista y gratis.

## 6. Servidor MCP

TypeScript SDK oficial, transportes **stdio** (default) y **streamable HTTP** (`serve-mcp --http`), prefijo `untacit_`. Requisitos de calidad para la implementación: esquemas de entrada con Zod y descripciones con ejemplos, `outputSchema`/`structuredContent` en las respuestas, resultados concisos y paginados (`limit` + cursor), errores accionables ("nodo no encontrado; usa untacit_context para buscar por texto"), y annotations correctas (las tools de consulta son `readOnlyHint: true`). El server lee siempre del índice derivado y dispara reindex si detecta el repo de grafo cambiado.

Además de las ocho tools de consulta, el server expone la **superficie agéntica** con la que un host con modelo propio (Claude Code, Claude Desktop) ejecuta extracción y entrevistas: `untacit_interview_gaps` (huecos + afirmaciones a verificar), `untacit_code_candidates` (scan heurístico de un repo fuente), `untacit_doc_sections` (segmentación con locators), los **prompts MCP** versionados (`untacit-interview`, `untacit-extract-code`, `untacit-extract-docs`) y — solo con `--write` — la única tool de escritura, `untacit_import_batch`, que pasa por el pipeline completo (validador → resolver → ficheros canónicos → commit, idempotente).

Tools v1 de consulta:

| Tool | Entrada | Devuelve |
|---|---|---|
| `untacit_context` | `query`, `node_types?`, `limit?`, `depth?` | Subgrafo relevante: nodos (id, tipo, nombre, 1 línea, canal de recuperación y distancia) + aristas del subgrafo inducido. Recuperación híbrida multi-etapa (§6.1) |
| `untacit_explore` | `node_id`, `depth?`, `edge_types?` | Detalle del nodo + vecindario tipado + confianzas |
| `untacit_impact` | `node_id`, `direction?` | Cierre transitivo por `DEPENDS_ON`/`GOVERNS`/`TRIGGERS`: el blast radius de negocio |
| `untacit_paths` | `from_id`, `to_id`, `max_paths?`, `max_length?` | Las k mejores cadenas de evidencia entre dos conceptos (Yen sobre Dijkstra; coste por salto = −ln(confianza × peso de tipo)), de más fuerte a más débil |
| `untacit_similar` | `node_id`, `node_types?`, `limit?` | Nodos similares mezclando coseno de embeddings (significado), Jaccard ponderado de vecindarios (estructura) y similitud de nombre (léxico); lente de duplicados/candidatos a merge |
| `untacit_evidence` | `edge_id \| node_id` | Provenance completa con excerpts y locators |
| `untacit_diff` | `ref_a?`, `ref_b?` | Drift entre dos refs de git del repo de grafo (por defecto, los dos últimos runs) |
| `untacit_conflicts` | `status?` | Contradicciones abiertas con sus evidencias enfrentadas |

### 6.1 Recuperación híbrida

`untacit_context` es un pipeline de cuatro etapas (implementado en `core/src/retrieval` + `mcp/src/queries.ts`):

1. **Seeds** por fusión RRF ponderada (reciprocal rank fusion) de cuatro canales: **léxico** (FTS5/BM25F con pesos por campo — name 8 > aliases 4 > description 1), **léxico-PRF** (expansión de query por pseudo-relevance feedback estilo RM3: términos minados de los documentos de feedback, ponderados tf×idf con las estadísticas de `fts5vocab`, re-ejecutados como `(original) OR t1 OR t2…` — orientado a recall y por eso infra-ponderado en la fusión), **semántico** (k-NN sobre los embeddings de nodo mean-pooled) y **semántico multi-vector** (interacción tardía estilo ColBERT: varias facetas por nodo — nombre+aliases y segmentos de la descripción — puntuadas por MaxSim, para que la frase relevante de una descripción larga no se diluya en el pooling). Sin proveedor de embeddings los dos canales semánticos caen y la siembra degrada a léxico + PRF.
2. **Diversificación MMR** del pool fusionado (similitud entre candidatos: coseno de embeddings si hay vectores, Jaccard de tokens del nombre si no), para que dos nombres del mismo concepto no quemen el presupuesto que merecen los sub-temas distintos de la pregunta.
3. **Expansión por el grafo** desde los seeds: *spreading activation* multi-salto (1–3, por defecto 2) donde cada salto pondera por confianza de la arista × peso semántico del tipo (`DEPENDS_ON`/`GOVERNS`/`TRIGGERS` > `VALIDATES`/`CALCULATES` > `OPERATES_ON`/`PART_OF` > `IMPLEMENTED_IN`), con decaimiento por profundidad y amortiguación de hubs, mezclada con **PageRank personalizado** (random walk con reinicio en los seeds) para premiar también al nodo bien conectado cerca de varios seeds, no solo a la cadena corta fuerte.
4. **Recorte a presupuesto** (3× el límite) por score mezclado, devolviendo el subgrafo inducido con resúmenes de una línea, canal de origen (`lexical`/`semantic`/`graph`) y distancia en saltos por nodo — profundizar es trabajo de `untacit_explore` y `untacit_evidence`.

Sobre las mismas primitivas: `untacit_paths` responde "¿cómo se conectan estos dos conceptos?" con las k mejores rutas sin ciclos (Yen sobre Dijkstra, fuerza multiplicativa por cadena), y `untacit_similar` mezcla tres señales ortogonales — coseno de embeddings (qué *significa*), estructura (cómo se *conecta*: Jaccard ponderado de vecindarios para el solape local, mezclado con el coseno de **embeddings espectrales** del grafo — descomposición por iteración de potencias con deflación de la adyacencia normalizada y ponderada — para la posición global) y similitud de nombre del resolver (cómo se *llama*) — como lente de duplicados y de conceptos relacionados aún sin arista. El coste extra de estos métodos (facetas × nodos cosenos por query, O(dims × iter × E) el espectro) es deliberado: más cómputo local a cambio de mejor señal, sin servicios externos.

El canal semántico pesa más aquí que en un grafo de código: los identificadores de código son tokens casi únicos y el léxico basta, pero el lenguaje de negocio es sinonímico ("pago anticipado" / "prepago") y las queries de los agentes llegan en lenguaje natural. Los embeddings son los mismos que usa el resolver de entidades (`02-ontologia-spec.md §9`): un pipeline, dos consumidores.

Post-v1 (anotado, no construir): búsqueda **global** estilo Microsoft GraphRAG — detección de comunidades (Leiden) y resúmenes por comunidad para preguntas panorámicas. A escala v1, la recuperación local con expansión cubre el caso.

**Evals**: el repo incluye un set de 10 preguntas read-only, complejas y verificables sobre el grafo sintético de `examples/`, con respuesta única conocida. Gate de la Fase 5: Claude Code responde ≥8/10 usando solo el MCP. El set de evals se escribe al implementar el server, siguiendo el criterio: independientes, multi-tool, realistas, estables.

## 7. Desktop app (Tauri 2 + React + Vite + Tailwind)

Vistas v1:

1. **Grafo global** — Sigma.js (WebGL). Color por tipo de nodo, grosor de arista por confianza, estilo diferenciado para `conflicted`. Filtros: tipo, confianza mínima, estado, run. Búsqueda FTS.
2. **Panel de detalle** — al seleccionar nodo/arista: descripción, atributos y lista de evidencias con excerpt y locator (enlace que abre el fichero/documento en local).
3. **Cola de revisión** — tres bandejas: merges propuestos, aristas bajo el umbral de confianza, conflictos. Acciones: aprobar merge, validar, resolver conflicto eligiendo evidencia ganadora. Toda acción escribe ficheros y produce commit.
4. **Entrevista** — chat con el agente entrevistador + panel lateral de triples propuestos con aceptar/editar/rechazar por elemento.
5. **Drift** — selector de dos refs (commits/tags/runs) y diff visual (añadido/retirado/cambiado).

Post-v1 (documentado, no construir ahora): vistas de proceso curadas con React Flow (layout secuencial de un `process` y sus reglas), export a imagen.

## 8. Configuración y seguridad

- `untacit.config.json` en la raíz del repo de grafo: rutas de repos fuente y carpetas de docs, exclusiones, umbrales, idioma.
- Sin API key de Anthropic en ninguna parte: el motor LLM es Claude Code (CLI local en modo print, con la autenticación que Claude Code ya tenga). Los hosts sin Claude Code operan vía MCP con su propio modelo.
- `.untacit/` (índice y cachés) en `.gitignore` desde el primer commit del repo de grafo.
- El repo de grafo de Diseños NT es **privado**; su remoto en GitHub es la única "nube" del sistema.
- Transcripciones completas de entrevistas: nunca en el repo; al grafo solo llegan excerpts ≤300 caracteres, con rol y sin nombres de personas.
- Sin telemetría de ningún tipo. `examples/` del repo del producto es, sencillamente, un repo de grafo de juguete en el formato canónico.

## 9. Decisiones y alternativas descartadas

| Decisión | Elegido | Descartado | Motivo |
|---|---|---|---|
| Formato canónico | Ficheros markdown + frontmatter YAML en repo git | SQLite como formato canónico; JSON monolítico (nodes.json/edges.json) | El binario es inversionable en git (diffs opacos, merges imposibles, bloat); los JSON monolíticos concentran todos los conflictos de merge en dos ficheros. Un fichero por nodo da diffs legibles y superficie de conflicto mínima |
| Persistencia en la nube | Remoto git (GitHub privado) | Backend/servicio propio | Cero infraestructura; historial, backup, permisos y colaboración resueltos por la plataforma |
| Índice de consulta | SQLite + FTS5 derivado, gitignored | Kùzu, Neo4j | Local, cero operación, regenerable; CTEs bastan a escala v1. Neo4j exige servidor. Kùzu queda como plan B del índice |
| Búsqueda semántica | Embeddings locales multilingües en el índice derivado (BLOBs + escaneo lineal; sqlite-vec como upgrade futuro) | Vectores versionados en el repo; Qdrant u otro servicio externo | Los vectores son binarios regenerables: versionarlos viola repo-first, y un servicio externo rompe local-first. El modelo local hace el reindex gratis y offline |
| Shell desktop | Tauri 2 | Electron | Peso, arranque, un solo runtime web; el core vive en sidecar Node igualmente |
| Render de grafo | Sigma.js | React Flow (global), D3 force a mano | WebGL para miles de nodos; React Flow reservado a vistas curadas |
| Salida de extractores | Batch JSON schema-first, materializado a ficheros | Texto libre + parseo posterior; el LLM escribiendo ficheros directamente | La validación estricta es la defensa anti-alucinación, y el serializador único garantiza la forma canónica |
| Motor LLM | Claude Code / Claude Desktop (CLI local en modo print, o el host vía MCP) | Cliente directo de la Messages API con ANTHROPIC_API_KEY | Cero gestión de claves y un solo punto de facturación/autenticación (la suscripción de Claude Code); el flujo de información pasa por MCP (stdio o streamable HTTP) y la escritura por una única tool validada |
| Canonicalización | Resolver en core con cola humana | IDs emitidos por el LLM; merge automático agresivo | Un merge erróneo silencioso es el peor bug posible del sistema |
| Sincronización | Drift bajo demanda / hooks | File-watcher continuo | Cada re-extracción cuesta API; el watcher continuo solo tiene sentido con parsing gratis |

## 10. Requisitos no funcionales

- Fluidez del visor con ~10k nodos / ~50k aristas.
- Reindex incremental por hash de fichero como camino normal; la reconstrucción completa del índice es cuestión de segundos, y de minutos si incluye recalcular todos los embeddings locales a escala v1.
- Serialización determinista verificable: importar dos veces el mismo batch deja `git status` limpio.
- Extracción reanudable: un run interrumpido no deja el repo de grafo a medias (staging en directorio temporal + escritura y commit atómicos al final).
- Instalación limpia del release OSS en una máquina ajena: clonar, `pnpm install`, key en env, funcionar.
