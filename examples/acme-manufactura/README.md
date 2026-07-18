# Acme Manufactura S.L. — repo de grafo sintético

Dataset de demostración de untacit: una empresa ficticia de embalaje de
cartón (clientes, pedidos, bobinas, troquelado, compras, almacén, logística,
calidad, mantenimiento, RRHH y finanzas). Sirve para desarrollo, tests y como
demo del release; no contiene ningún dato real.

El dataset son **seis batches de extracción** (el contrato de emisión de
`docs/02-ontologia-spec.md §8`): dos de código, dos de documentos y dos
entrevistas. El repo de grafo canónico se materializa importándolos con la
CLI. El guion de demo paso a paso está en [`DEMO.md`](DEMO.md).

## Los seis batches

| Batch | Fuente simulada | Contenido |
|---|---|---|
| `batches/01-code.json` | Repos `acme-erp` y `web-pedidos` | Núcleo de ventas y producción: reglas y procesos con evidencia de líneas de código |
| `batches/02-docs.json` | Manuales comercial, administración y producción | Políticas, roles y procesos; re-afirma aristas del código y **contradice dos** |
| `batches/03-interview.json` | Entrevista a administración (`int-001`) | Conocimiento tácito con `validated_by` (confianza 0.95) |
| `batches/04-code-extended.json` | Repos `acme-erp`, `acme-wms`, `acme-mrp`, `acme-conta`, `portal-proveedores`, `plataforma-transporte` | Compras, almacén, logística, presupuestos, crédito y contabilidad |
| `batches/05-docs-extended.json` | Manuales de compras, logística y calidad; plan de mantenimiento; normativa laboral; política medioambiental | Calidad, mantenimiento, RRHH y sostenibilidad; **contradice el descuento por volumen del código** |
| `batches/06-interview-produccion.json` | Entrevista al jefe de producción (`int-002`) | Valida en vivo reglas de planta y **contradice el plan de mantenimiento** (la parada de las 400 horas no se cumple) |

Las menciones varían deliberadamente entre fuentes («Cliente» / «clientes»,
«OrdenFabricacion» / «Órdenes de fabricación») para ejercitar el resolver de
entidades. Los batches 04–06 se generan con
`tools/generate-extended-batches.mjs` (contenido semilla escrito a mano,
locators deterministas).

## Métricas esperadas tras importar los seis batches

- **150 nodos** (32 entity, 36 process, 36 rule, 11 policy, 16 event,
  7 system, 12 role) y **233 aristas**.
- **4 conflictos abiertos** (el producto funcionando):
  1. `rule-aprobacion-de-gerencia-para-pedidos-altos -VALIDATES-> entity-pedido`:
     el código aplica un umbral de 10.000 €; el manual de procedimientos dice
     que solo aplica a clientes nuevos sin límite de importe.
  2. `rule-recargo-por-pedido-urgente -CALCULATES-> entity-pedido`: la web
     sigue cobrando un recargo del 15 % que el manual y administración dan por
     eliminado desde 2024.
  3. `rule-descuento-por-volumen -CALCULATES-> entity-linea-de-pedido`: el
     código aplica un 8 % desde 5.000 unidades; el manual comercial vigente,
     un 10 % desde 8.000.
  4. `rule-parada-por-horas-de-uso-de-troqueladora -VALIDATES->
     process-mantenimiento-preventivo`: el plan de mantenimiento exige parar
     cada 400 horas; el jefe de producción reconoce que en campaña no se
     cumple (conocimiento tácito contra documento).
- **Aristas multi-fuente** con techo de confianza 0.99, p. ej.
  `rule-bloqueo-de-pedido-sin-prepago -VALIDATES-> process-alta-de-pedido`
  (código + documento + entrevista validada) o
  `rule-fifo-de-bobinas-por-antiguedad -VALIDATES-> process-troquelado`
  (código + entrevista validada).
- **1 propuesta de merge en zona gris** (`MRP Acme` ~ `ERP Acme`, score
  0.875): el resolver nunca fusiona en silencio, la duda va a la cola.
- **1 arista de baja confianza** (entrevista sin validar, 0.6) en la bandeja
  de revisión.
- Re-importar cualquier batch es un **no-op**: `git status` limpio
  (serialización canónica idempotente, criterio de salida de la Fase 0).

## Verificación y evals

```bash
node examples/acme-manufactura/check.mjs            # invariantes del dataset (requiere pnpm build)
node examples/acme-manufactura/evals/run.mjs        # las 10 evals como llamadas MCP reales, sin LLM
node examples/acme-manufactura/benchmark/run-benchmark.mjs  # benchmark agéntico con/sin untacit (usa tu Claude Code local)
```

`check.mjs` importa los seis batches en un directorio temporal y comprueba
todas las métricas de arriba. `evals/` contiene las 10 preguntas verificables
del gate de la Fase 5 (un agente conectado solo al MCP debe responder ≥8/10):
`run.mjs` ejecuta cada receta de verificación como llamadas reales al
servidor MCP (mismas tools y `structuredContent` que ve un agente) y las
comprueba mecánicamente, y `benchmark/run-benchmark.mjs` ejecuta la versión
agéntica comparando el mismo modelo con y sin untacit. El resultado del gate
LLM — Claude Code conectado solo al MCP, 10/10 — está documentado en
[`evals/RESULTS.md`](evals/RESULTS.md).
