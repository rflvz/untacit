# Fase 5 — Resultado del gate de evals

> Criterio de salida (docs/04 §Fase 5): Claude Code, con el MCP conectado y **sin acceso a las fuentes**, responde correctamente ≥ 8/10 evals de `evals.json`.

## Resultado: **10/10** ✅ (gate superado)

> Nota (Fase 6): este resultado se registró sobre el grafo de 3 batches
> (31 nodos, 2 conflictos). El dataset se amplió después a 6 batches /
> 150 nodos / 4 conflictos, y las respuestas esperadas de eval-03 y eval-06
> se actualizaron en `evals.json`; la mitad determinista (`run.mjs`) cubre el
> grafo ampliado en CI. El gate LLM puede re-ejecutarse con el mismo
> procedimiento de abajo (o con `../benchmark/run-benchmark.mjs`).

- **Fecha**: 2026-07-16
- **Agente**: Claude Code CLI en modo print (`claude --print`), sin API key propia.
- **Aislamiento**: `--strict-mcp-config --mcp-config` con el servidor stdio de untacit como único MCP; `--allowedTools` restringido a las seis tools de consulta `untacit_*`; `Bash`, `Read`, `Glob`, `Grep`, `Write`, `Edit` y web deshabilitados — el agente solo vio el grafo a través del MCP.
- **Grafo**: repo temporal construido importando `batches/01-code.json`, `02-docs.json` y `03-interview.json` (31 nodos, 53 aristas, 2 conflictos).
- **Prompt por pregunta**: «Responde usando EXCLUSIVAMENTE las tools MCP de untacit (no tienes acceso a las fuentes ni al sistema de ficheros). Sé conciso y cita los ids de nodo. Pregunta: …»

| Eval | Veredicto | Nota |
|---|---|---|
| eval-01 | ✅ | Regla + `IMPLEMENTED_IN` → `system-web-de-pedidos`, con confianza citada |
| eval-02 | ✅ | Política + evidencia document (manual comercial 4.1) + interview validada por administración |
| eval-03 | ✅ | Exactamente los 2 conflictos, con sus ids y evidencias enfrentadas |
| eval-04 | ✅ | Código = umbral 10.000 € (`LIMITE_APROBACION`); manual 2.3 = solo clientes nuevos, sin umbral |
| eval-05 | ✅ | Identifica el conflicto: el código lo sigue cobrando, manual 4.5 + entrevista dicen eliminado en 2024 |
| eval-06 | ✅ | Directos (alta, reclamaciones) + cadena transitiva completa hasta facturación, con distancias |
| eval-07 | ✅ | `role-administracion` EXECUTES con confianza 0.99 |
| eval-08 | ✅ | `event-pedido-creado`, generado por `process-alta-de-pedido` |
| eval-09 | ✅ | DEPENDS_ON → `rule-calculo-de-merma-de-bobina`, que calcula la merma de la bobina |
| eval-10 | ✅ | Política, `role-jefe-de-produccion` y PART_OF → `process-troquelado` |

La mitad determinista del gate — cada receta de `verification` ejecutada como llamadas MCP reales y comprobada mecánicamente — corre en CI con `node examples/acme-manufactura/evals/run.mjs` (10/10 sobre `structuredContent` del servidor real).

Reproducción del gate LLM:

```bash
pnpm build
node packages/cli/dist/bin.js init /tmp/acme-graph
for b in examples/acme-manufactura/batches/*.json; do
  node packages/cli/dist/bin.js import "$b" --graph /tmp/acme-graph; done
cat > /tmp/mcp.json <<'EOF'
{ "mcpServers": { "untacit": { "command": "node",
  "args": ["<repo>/packages/mcp/dist/bin.js", "--graph", "/tmp/acme-graph"] } } }
EOF
echo "…pregunta…" | claude --print --strict-mcp-config --mcp-config /tmp/mcp.json \
  --allowedTools "mcp__untacit__untacit_context,mcp__untacit__untacit_explore,mcp__untacit__untacit_impact,mcp__untacit__untacit_evidence,mcp__untacit__untacit_diff,mcp__untacit__untacit_conflicts" \
  --disallowedTools "Bash,Read,Glob,Grep,WebSearch,WebFetch,Write,Edit,Task"
```
