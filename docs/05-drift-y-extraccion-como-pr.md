# untacit — Drift y extracción-como-PR

> Estado: v1, Fase 5. Guía operativa del entregable de drift de `04-plan-de-fases.md §Fase 5`: `untacit diff` en términos de ontología, hook post-merge de re-extracción parcial y flujo de extracción-como-PR. Incluye la transcripción de una ejecución real completa (§4).

## 1. Drift = git diff, presentado en ontología

Con repo-first, la historia del grafo es la historia de git (`03-arquitectura.md §5`). El drift entre dos estados se consulta en tres superficies, siempre en términos de negocio (nodos y aristas añadidos / retirados / cambiados), nunca de líneas de YAML:

- **CLI**: `untacit diff <refA> <refB> --graph <repo>` (sin refs: working tree vs HEAD).
- **App**: vista Drift, selector de dos refs (commits/tags/runs) con diff visual.
- **MCP**: tool `untacit_diff` (`ref_a`, `ref_b`; por defecto, los dos últimos runs).

Los refs son cualquier cosa que git resuelva: hashes, `HEAD~1`, tags, ramas — incluidas las ramas `run/<run_id>` que produce la extracción-como-PR (§3).

## 2. Re-extracción parcial: hook post-merge

Cada re-extracción cuesta llamadas LLM, así que v1 no tiene file-watcher: la sincronización es bajo demanda o por hook (`03-arquitectura.md §9`). El hook de ejemplo vive en [`examples/hooks/post-merge`](../examples/hooks/post-merge) y se instala en los **repos fuente**:

```bash
cp examples/hooks/post-merge <repo-fuente>/.git/hooks/post-merge
chmod +x <repo-fuente>/.git/hooks/post-merge
export UNTACIT_GRAPH=/ruta/al/repo-de-grafo   # y opcionalmente UNTACIT_BIN
```

Tras cada merge (incluido `git pull`), el hook:

1. Calcula los paths cambiados con `git diff --name-only ORIG_HEAD HEAD`, filtrados a extensiones de código.
2. Lanza `untacit extract code <repo> --paths <cambiados> --import --graph $UNTACIT_GRAPH --branch`.

El scoping por paths (`--paths`, también disponible en la tool MCP `untacit_code_candidates`) limita el escaneo de candidatos a los ficheros o directorios indicados; los paths que el merge borró se saltan en silencio — un fichero eliminado es entrada normal, no un error. Las aristas cuya única evidencia apuntaba a un fragmento desaparecido no se borran: afloran como estado a revisar al comparar el run con el estado anterior.

## 3. Extracción-como-PR

Flujo recomendado desde la Fase 5 (`03-arquitectura.md §5`): **un cambio de lógica de negocio se revisa exactamente igual que se revisa código**. En vez de aplicar el run directamente sobre la rama actual del repo de grafo, el run se materializa en una rama propia:

```bash
untacit import batch.json --graph <repo> --branch            # rama run/<run_id>
untacit import batch.json --graph <repo> --branch mi-rama    # nombre explícito
untacit extract code <fuente> --import --graph <repo> --branch
```

Mecánica (opción `branch` de `importBatch` en core):

1. Se valida que la rama no exista y que el repo esté sobre una rama (antes de escribir nada).
2. Pipeline normal: validador → resolver → ficheros canónicos + metadatos del run.
3. Se crea la rama desde HEAD, se commitea el run en ella y **el working tree vuelve a la rama anterior, limpio**: el cambio queda propuesto, no aplicado; el índice derivado sigue reflejando el estado vigente.
4. `git push` de la rama y PR en el remoto del repo de grafo. La revisión de la PR y la cola de revisión de la app son dos vistas del mismo evento.
5. Revisar la propuesta antes del merge: `untacit diff <rama-actual> run/<run_id> --graph <repo>`.

## 4. Ejecución real del flujo completo

Transcripción de la ejecución de referencia (2026-07-16, motor = Claude Code CLI local, sin API key). Fuente: un repo `web-pedidos` con dos reglas en `src/checkout.ts` — bloqueo de pedido sin pago anticipado para clientes nuevos y recargo del 15% a pedidos urgentes.

**Extracción base** (grafo vacío → primera foto):

```
$ untacit extract code ./web-pedidos --import --graph ./pedidos-graph
2 candidates, 1 LLM calls → 6 nodes, 5 edges
run 2026-07-16T13-04-42-code: +6/~0 nodes, +5/~0 edges, +11 evidence
  commit 4c1486a1da
```

**Cambio real de negocio**: en una rama del repo fuente, el recargo urgente baja del 15% al 12%; se mergea a main con el hook post-merge instalado. El merge dispara la re-extracción parcial (solo `src/checkout.ts`) y el run aterriza en su propia rama del repo de grafo:

```
$ git merge --no-ff bajar-recargo-urgente
untacit: re-extracting 1 changed path(s)…
2 candidates, 1 LLM calls → 6 nodes, 5 edges
run 2026-07-16T13-05-33-code: +0/~6 nodes, +1/~4 edges, +11 evidence
  commit 59db889163 on branch run/2026-07-16T13-05-33-code (push it and open a PR to review the change)
untacit: run committed on its own branch of …/pedidos-graph — push it and open a PR to review the drift.
```

**El diff muestra el cambio de regla en términos de ontología** (criterio de salida de la Fase 5), con el working tree de la rama vigente intacto (`git status` limpio):

```
$ untacit diff master run/2026-07-16T13-05-33-code --graph ./pedidos-graph
graph diff master..run/2026-07-16T13-05-33-code: nodes 0 added, 0 removed, 2 changed; edges 1 added, 0 removed, 0 changed

nodes:
~ node rule/rule-pago-anticipado-obligatorio-para-clientes-nuevos (changed: aliases, attrs)
~ node rule/rule-recargo-por-pedido-urgente (changed: aliases, attrs)

edges:
+ edge process-calculo-de-importe-de-pedido -DEPENDS_ON-> rule/rule-recargo-por-pedido-urgente (added)
```

En el fichero canónico de la regla, la propuesta registra la nueva consecuencia (`importe = base * 1.12`, constante `RECARGO_URGENTE_PCT = 12`) con su evidencia nueva — path, líneas y commit del merge — junto a la evidencia anterior del 15%: el conflicto potencial entre estados queda documentado con provenance completa y se resuelve en la revisión de la PR.

La parte del criterio de salida que exige un cambio real en el repo de Diseños NT requiere datos reales y queda registrada como pendiente en el README, igual que los gates con datos reales de las fases 1–4.
