# untacit — Visión y PRD

> Estado: borrador v1 para revisión. Documentos hermanos: `02-ontologia-spec.md`, `03-arquitectura.md`, `04-plan-de-fases.md`.

## 1. Resumen

untacit es una herramienta local-first y repo-first que construye un **grafo ontológico de la lógica de negocio** de una organización a partir de tres fuentes — código fuente, documentos internos y conocimiento tácito capturado mediante entrevistas agénticas — y lo expone a través de una desktop app de visualización y de un servidor MCP para agentes. Hereda la tesis de CodeGraph (colbymchenry/codegraph, MIT): darle al agente y al humano un mapa estructurado en vez de obligarlos a explorar a ciegas. Cambia el territorio: no símbolos y llamadas, sino procesos, reglas, políticas y entidades de negocio.

## 2. Problema

La lógica de negocio de una empresa no vive en ningún sitio consultable. Está repartida entre condicionales enterrados en el código, manuales que nadie actualiza, hojas de cálculo y, sobre todo, cabezas de personas concretas. Las consecuencias observables:

1. **Onboarding lento**: entender "cómo funciona realmente la facturación aquí" requiere semanas de preguntas.
2. **Reglas huérfanas**: nadie sabe por qué existe una validación en el código ni quién la decidió.
3. **Contradicciones invisibles**: el código hace X, el manual dice Y, y la persona de administración hace Z. Nadie lo detecta hasta que duele.
4. **Agentes sin contexto de negocio**: un agente de código (Claude Code) puede mapear símbolos con CodeGraph, pero no sabe que tocar esa función rompe una política comercial.
5. **Drift**: las políticas cambian y las implementaciones quedan obsoletas sin que exista un mecanismo que lo señale.

## 3. Tesis del producto

**Un grafo tipado con procedencia obligatoria es la representación correcta de la lógica de negocio**, porque:

- Un grafo captura lo que la lógica de negocio es: entidades relacionadas por dependencias, disparadores y reglas de gobierno.
- El tipado estricto (ontología cerrada, ver doc 02) hace la extracción verificable y la consulta precisa.
- La procedencia (cada arista sabe de qué fichero, documento o entrevista salió, con qué fragmento y con qué confianza) es lo que separa un producto auditable de una demo de LLM.
- Exponerlo por MCP convierte el grafo en infraestructura de contexto para agentes, no solo en un visor para humanos.

La diferencia estructural con CodeGraph: allí el ground truth es determinista (tree-sitter parsea gramática). Aquí no hay parser — la extracción es un problema de agentes con confianza y evidencia, y el producto entero se diseña alrededor de esa incertidumbre en vez de ignorarla.

## 4. Usuario y estrategia de release

| Etapa | Usuario | Implicación de diseño |
|---|---|---|
| v1 (dogfood) | Rafa en Diseños NT (grupo industrial, 6 empresas, 300+ empleados) | Datos reales, sensibles. Todo local. El grafo de Diseños NT jamás entra en el repositorio. |
| v2 (release) | Comunidad open source | Repo público con dataset sintético en `examples/`, instalación en una máquina ajena sin fricción, documentación en inglés. |

Restricciones derivadas (no negociables):

- **Repo-first**: la representación canónica del grafo son ficheros de texto plano en un repositorio git dedicado. La persistencia "en la nube" es un remoto de GitHub (privado para Diseños NT), no un backend propio: historial, backup, permisos y colaboración quedan delegados en la plataforma.
- **Local-first sin excepciones**: grafo en ficheros locales e índice SQLite derivado, sin backend, sin telemetría. Las únicas salidas a red son las llamadas a la API de Anthropic durante la extracción (key del usuario) y el push/pull al remoto git.
- **Licencia propuesta: MIT** (coherente con la herencia de CodeGraph; decisión abierta pendiente de confirmar).
- No hay multiusuario, colaboración en tiempo real ni cloud en el horizonte de este documento.

## 5. Casos de uso v1

1. **Auditoría de una regla**: "¿Dónde está implementado el descuento por volumen y de dónde sale?" → nodo `Regla` con evidencias enlazadas a líneas de código, sección del manual comercial y minuto de entrevista.
2. **Onboarding**: un empleado nuevo explora el subgrafo "de pedido a factura" en la app: procesos, quién los ejecuta, qué reglas los validan, qué sistemas los implementan.
3. **Detección de contradicción**: el extractor de documentos afirma una regla que el extractor de código niega → arista en estado `conflicted`, visible en la cola de revisión con las dos evidencias enfrentadas.
4. **Contexto de negocio para agentes**: antes de modificar la lógica de facturación, Claude Code consulta `untacit_impact` y descubre qué políticas gobiernan esa regla y qué procesos dependen de ella.
5. **Drift**: tras un cambio de política comercial, se re-ejecuta la extracción; el diff entre runs muestra reglas nuevas, eliminadas y modificadas — y qué implementaciones quedaron obsoletas.
6. **Captura de conocimiento tácito**: el agente entrevistador detecta que la zona "producción" del grafo tiene baja cobertura, genera un guion, entrevista al responsable y propone triples que la persona valida en vivo.

## 6. Alcance v1

**Dentro:**

- Ontología cerrada v1: 7 tipos de nodo, 9 tipos de arista (doc 02).
- Tres extractores: código, documentos, entrevistas agénticas (doc 03).
- Repo de grafo en texto plano (formato canónico) con índice SQLite derivado; runs materializados como commits y drift como diff entre ellos.
- Resolución de entidades con cola de merge validada por humano.
- Desktop app (Tauri): grafo global, panel de evidencias, cola de revisión, chat de entrevista, vista de drift.
- Servidor MCP local (stdio) con 6 tools de consulta read-only.

**Fuera (explícitamente):**

- ERP y bases de datos como fuente de extracción (decisión de alcance v1; el diseño de extractores debe permitir añadirlo después).
- SaaS, cuentas, sincronización, colaboración multiusuario.
- Edición libre del grafo desde la UI (solo validar, mergear y resolver conflictos; el grafo lo escriben los extractores).
- Inferencia automática de ontología (el esquema es fijo en v1).
- Vistas de proceso curadas tipo diagrama de flujo (candidato post-v1 con React Flow).

## 7. Principios de producto

1. **Ninguna arista sin evidencia.** Provenance obligatoria a nivel de esquema, no de convención.
2. **Los extractores nunca emiten texto libre.** Solo batches JSON validados contra el esquema de la ontología.
3. **La incertidumbre es de primera clase.** Confianza y estado (`active`/`conflicted`/`deprecated`) son campos del modelo, no metadatos opcionales.
4. **El humano valida lo dudoso.** Confianza baja, merges de entidades y conflictos van a una cola de revisión; nada se resuelve en silencio.
5. **Local-first sin excepciones.**
6. **El grafo es un repositorio.** Formato canónico en texto plano con serialización determinista; todo lo binario o derivado (índice SQLite) es regenerable y no se versiona.

## 8. Métricas de éxito del dogfood

- **Precisión de extracción**: ≥80% de aristas correctas en una muestra revisada a mano de 50 aristas por extractor (gate de la Fase 1, doc 04).
- **Valor de auditoría**: ≥5 contradicciones o reglas huérfanas reales encontradas en Diseños NT durante el dogfood. Si el grafo no descubre nada que no supiéramos, el producto no justifica su coste.
- **Valor para agentes**: Claude Code responde correctamente ≥8/10 preguntas de negocio del set de evals usando solo el MCP (doc 03, §MCP).
- **Uso sostenido**: consulta propia del grafo al menos semanal una vez completada la Fase 5. Si el propio autor no lo usa, no se publica.

## 9. Decisiones abiertas

| Decisión | Propuesta | Estado |
|---|---|---|
| Nombre definitivo | untacit | Cerrada |
| Licencia | MIT | Abierta |
| Umbrales de confianza por defecto | Ver doc 02 §7 | Propuestos, revisar tras Fase 1 |
| Idioma del grafo en Diseños NT | Español (nombres y descripciones); identificadores y esquema en inglés | Propuesta |
