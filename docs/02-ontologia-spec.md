# untacit — Especificación de la ontología

> Estado: borrador v1. Este documento es la fuente de verdad del modelo de datos. Los extractores, el validador del core, el esquema SQLite y las tools MCP se derivan de aquí.

## 1. Filosofía del esquema

La ontología v1 es **cerrada y pequeña**: 7 tipos de nodo y 9 tipos de arista, con restricciones de dominio→rango. Razones:

1. Un esquema cerrado permite **validación estricta** de lo que emiten los extractores LLM: cualquier triple fuera del esquema se rechaza antes de tocar la base de datos. Es la defensa principal contra la alucinación taxonómica.
2. Un vocabulario pequeño produce grafos **consultables**: las tools MCP y los filtros de la app razonan sobre tipos conocidos.
3. La extensibilidad llega por `attrs` (JSON libre por nodo/arista) y por versionado del esquema, no por tipos ad hoc.

Idioma: los **identificadores del esquema van en inglés** (tipos, campos, valores de enum); los **contenidos** (`name`, `description`, excerpts) van en el idioma de la organización (español en Diseños NT).

## 2. Tipos de nodo

| Tipo | Definición | Ejemplos (manufactura) | No es |
|---|---|---|---|
| `entity` | Objeto de negocio con identidad propia sobre el que operan procesos y reglas | Cliente, Pedido, Factura, Bobina, Orden de fabricación | Una tabla de BD concreta (eso es implementación, va en `attrs` o en evidencia) |
| `process` | Secuencia de actividades con inicio y fin reconocibles | Alta de pedido, Facturación mensual, Control de calidad de tirada | Una función del código (la función es evidencia de un proceso o regla) |
| `rule` | Decisión, validación o cálculo concreto y operativo | "Pedidos > 10.000 € requieren aprobación de gerencia", "El precio unitario aplica descuento por volumen a partir de 5.000 uds" | Una preferencia vaga sin condición verificable |
| `policy` | Norma de alto nivel de origen humano/organizativo que gobierna reglas y procesos | "No se sirve mercancía a clientes nuevos sin pago anticipado" | La implementación de la norma (eso es una `rule` gobernada por esta policy) |
| `event` | Suceso que dispara o resulta de un proceso | Pedido creado, Fin de mes, Rechazo de calidad | Un estado permanente |
| `system` | Software o plataforma donde vive lógica | ERP, web de pedidos, warehouse de datos | Un servidor físico |
| `role` | Función humana u organizativa que ejecuta o decide | Comercial, Administración, Jefe de producción | Una persona concreta con nombre (los nombres de personas no entran en el grafo) |

**Distinción `rule` vs `policy`** (la más importante del esquema): una `policy` es el *porqué* organizativo; una `rule` es el *cómo* operativo. Una policy típicamente gobierna una o varias rules. Si una afirmación tiene condición y consecuencia verificables, es `rule`; si expresa intención o mandato general, es `policy`.

## 3. Tipos de arista

Con restricción de dominio → rango. El validador del core rechaza cualquier arista que las viole.

| Tipo | Dominio → Rango | Semántica |
|---|---|---|
| `OPERATES_ON` | `rule` → `entity` | La regla lee o modifica la entidad |
| `VALIDATES` | `rule` → `process` \| `entity` | La regla actúa como condición de paso |
| `CALCULATES` | `rule` → `entity` | La regla calcula un atributo de la entidad (atributo en `attrs.attribute`) |
| `TRIGGERS` | `event` \| `process` → `process` \| `event` | Disparo causal |
| `EXECUTES` | `role` \| `system` → `process` | Quién o qué lleva a cabo el proceso |
| `DEPENDS_ON` | `process` \| `rule` → `process` \| `rule` \| `entity` \| `system` | Dependencia: si el destino cambia o falla, el origen se ve afectado |
| `GOVERNS` | `policy` → `rule` \| `process` | La política es la razón de existencia del destino |
| `IMPLEMENTED_IN` | `rule` \| `process` → `system` | Dónde vive la implementación |
| `PART_OF` | `process` → `process`, `entity` → `entity` | Composición (subproceso, entidad parte de un agregado) |

## 4. Propiedades

**Nodo:**

```
id            slug kebab-case estable, p.ej. "rule-descuento-volumen"
type          enum de §2
name          nombre humano corto
description   1–3 frases
aliases       string[] — otros nombres con los que aparece en las fuentes
status        active | deprecated | conflicted
attrs         objeto JSON libre, específico por tipo
schema_version
```

**Arista:**

```
id            hash estable de (type, source_id, target_id)
type          enum de §3
source_id, target_id
confidence    0.0–1.0 (ver §7)
status        active | deprecated | conflicted
attrs         objeto JSON libre (p.ej. CALCULATES.attribute)
run_id        run que la afirmó por última vez
schema_version
```

## 5. Modelo de provenance

**Ninguna arista existe sin al menos una evidencia.** Una arista puede acumular N evidencias de fuentes distintas — evidencia múltiple e independiente es la señal de calidad más fuerte del sistema. Los nodos también llevan evidencia, con el mismo modelo.

```
evidence {
  id
  edge_id | node_id          # a qué elemento respalda
  source_type                # code | document | interview
  locator                    # por tipo, ver abajo
  excerpt                    # fragmento literal ≤ 300 caracteres
  stance                     # supports | contradicts
  extractor {                # trazabilidad del agente
    name, model, prompt_version
  }
  extracted_at
  run_id
  validated_by               # null | identificador de rol humano
}
```

`locator` por tipo de fuente:

- `code`: `{ repo, path, line_start, line_end, commit }`
- `document`: `{ doc_id, title, section | page }`
- `interview`: `{ interview_id, speaker_role, turn }` — se guarda el **rol** del entrevistado, nunca su nombre.

`stance: contradicts` es el mecanismo de contradicción: una fuente puede aportar evidencia *en contra* de una arista afirmada por otra.

## 6. Contradicciones

Definición operativa — una arista pasa a `status: conflicted` cuando:

1. Recibe evidencias con `stance` opuesto de fuentes distintas, o
2. Dos aristas mutuamente excluyentes coexisten (misma pareja source/target con semántica incompatible declarada en `attrs`).

Los conflictos se materializan en una tabla propia (`conflicts`) que enfrenta las evidencias, y se resuelven **solo** desde la cola de revisión de la app: el humano marca la evidencia ganadora, la arista vuelve a `active` (o pasa a `deprecated`) y la resolución queda registrada. Un conflicto es un hallazgo de producto, no un error del sistema: es exactamente lo que untacit existe para encontrar.

## 7. Confianza

Asignación v1, deliberadamente simple (revisar con datos de la Fase 1):

| Origen de la evidencia | Confianza base |
|---|---|
| `interview` validada en vivo por el entrevistado | 0.95 |
| `code` | 0.90 |
| `document` | 0.70 |
| `interview` sin validación en vivo | 0.60 |

Reglas de combinación:

- Confianza de la arista = máxima de sus evidencias `supports`, con bonus de +0.05 por cada fuente **de tipo distinto** adicional, techo 0.99.
- `status: conflicted` es independiente de la confianza (una arista puede tener confianza alta y estar en conflicto).
- Umbral de revisión por defecto: aristas con confianza < 0.7 entran en la cola de revisión.

## 8. Formato de emisión de los extractores

Los extractores **solo** producen batches con este esquema. El core valida contra el JSON Schema y contra las restricciones dominio→rango de §3 antes de insertar nada. Todo lo rechazado se registra con motivo.

```json
{
  "$id": "untacit/extraction-batch.v1",
  "type": "object",
  "required": ["run_id", "source_type", "nodes", "edges"],
  "properties": {
    "run_id": { "type": "string" },
    "source_type": { "enum": ["code", "document", "interview"] },
    "nodes": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["mention", "type", "name", "description", "evidence"],
        "properties": {
          "mention": { "type": "string", "description": "Nombre tal cual aparece en la fuente" },
          "candidate_id": { "type": ["string", "null"], "description": "id canónico si el extractor cree reconocer un nodo existente" },
          "type": { "enum": ["entity", "process", "rule", "policy", "event", "system", "role"] },
          "name": { "type": "string" },
          "description": { "type": "string" },
          "attrs": { "type": "object" },
          "evidence": { "$ref": "#/$defs/evidence" }
        }
      }
    },
    "edges": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["type", "source_mention", "target_mention", "evidence"],
        "properties": {
          "type": { "enum": ["OPERATES_ON", "VALIDATES", "CALCULATES", "TRIGGERS", "EXECUTES", "DEPENDS_ON", "GOVERNS", "IMPLEMENTED_IN", "PART_OF"] },
          "source_mention": { "type": "string" },
          "target_mention": { "type": "string" },
          "stance": { "enum": ["supports", "contradicts"], "default": "supports" },
          "attrs": { "type": "object" },
          "evidence": { "$ref": "#/$defs/evidence" }
        }
      }
    }
  },
  "$defs": {
    "evidence": {
      "type": "object",
      "required": ["locator", "excerpt"],
      "properties": {
        "locator": { "type": "object" },
        "excerpt": { "type": "string", "maxLength": 300 }
      }
    }
  }
}
```

Nota de diseño: los extractores emiten `mention` (el nombre tal cual en la fuente), **no** ids canónicos. La canonicalización es responsabilidad del resolver del core (§9). Esto evita que el LLM invente ids y concentra la resolución de entidades en un único punto auditable.

## 9. Resolución de entidades

El problema duro del sistema: "Cliente" en el código, "cliente" en el manual y "los clientes" en una entrevista son el mismo nodo. Pipeline del resolver:

1. **Match exacto** contra `name` y `aliases` del registro canónico (normalizando mayúsculas, tildes y singular/plural) → resuelve.
2. **Match difuso** (similitud de embedding o distancia de edición sobre name+description) por encima del umbral alto → resuelve y añade la mention como alias.
3. **Zona gris** (entre umbrales) → crea el nodo como provisional y encola una **propuesta de merge** para revisión humana en la app.
4. **Sin match** → nodo nuevo.

Reglas:

- **Nunca** se mergea automáticamente en la zona gris. Un merge erróneo silencioso corrompe el grafo de forma difícil de detectar.
- Los merges son reversibles: la tabla `merges` conserva qué se fusionó, cuándo y quién lo aprobó.
- Umbrales iniciales propuestos: ≥0.92 automático, 0.75–0.92 zona gris, <0.75 nodo nuevo. Calibrar en Fase 3.

## 10. Ejemplo end-to-end

Regla real de tipo comercial vista desde las tres fuentes:

- **Código**: `if (customer.isNew && !order.prepaid) reject(...)` en `checkout.ts`
- **Documento**: manual comercial, sección 4.2: "A clientes de nueva incorporación se les exigirá el pago por adelantado"
- **Entrevista**: administración confirma la norma y añade el porqué (impagos históricos)

Resultado en el grafo (abreviado):

```
(policy)  policy-pago-anticipado-clientes-nuevos
   "Los clientes nuevos pagan por adelantado"
   evidencias: document(manual 4.2), interview(role: administración, validada)

(rule)    rule-bloqueo-pedido-sin-prepago
   "Se rechaza el pedido de un cliente nuevo sin pago registrado"
   evidencias: code(checkout.ts L84-L91)

(rule)  -GOVERNS←        (policy)                       conf 0.95
(rule)  -VALIDATES→      (process) process-alta-pedido  conf 0.90
(rule)  -OPERATES_ON→    (entity)  entity-cliente       conf 0.90
(rule)  -OPERATES_ON→    (entity)  entity-pedido        conf 0.90
(rule)  -IMPLEMENTED_IN→ (system)  system-web-pedidos   conf 0.90
```

Si mañana el manual cambia a "pago anticipado solo por encima de 3.000 €" y el código no, la re-extracción produce evidencia `contradicts` sobre la rule → `conflicted` → cola de revisión. Ese es el producto funcionando.

## 11. Versionado del esquema

- `schema_version` (entero) en la tabla `meta` de la BD y en cada nodo/arista.
- Cambios de ontología (añadir tipos, cambiar restricciones) → migración SQL numerada + bump de versión + actualización de este documento en el mismo commit.
- Los batches de extracción declaran contra qué versión se emitieron; el core rechaza batches de versiones incompatibles.

## 12. Serialización canónica (repo-first)

El grafo persiste como **un fichero markdown por nodo** dentro de un repositorio git dedicado: frontmatter YAML con los campos estructurados de §4 y las aristas salientes (con su evidencia de §5 embebida), descripción en el cuerpo. El `id` del nodo es el nombre del fichero. La serialización es determinista — orden estable de claves, aristas ordenadas por `(type, target)` y evidencias por `(source_type, locator)` — de modo que re-extraer sin cambios en las fuentes deja el repositorio sin diff.

Los batches de §8 son el contrato de emisión de los extractores y nunca se persisten: el core los materializa en ficheros canónicos. El layout del repo de grafo y el formato completo de fichero se especifican en `03-arquitectura.md §3`.
