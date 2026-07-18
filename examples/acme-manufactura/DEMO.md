# Demo script — Acme Manufactura (~10 minutes)

A guided tour of untacit over the synthetic graph of **Acme Manufactura
S.L.**, a fictitious cardboard-packaging manufacturer: 150 nodes, 233 edges,
6 extraction batches (2 code runs, 2 document runs, 2 interviews), 4 designed
conflicts and a populated review queue. Everything below runs offline.

Prerequisites: `pnpm install && pnpm build` at the repo root.

```bash
alias untacit="node $PWD/packages/cli/dist/bin.js"
export GRAPH=/tmp/acme-graph
```

## 1. Build the graph from extraction batches (~2 min)

Each batch is what an extraction agent emits (the strict-JSON contract in
`docs/02-ontologia-spec.md §8`). Importing runs the full pipeline: validator →
entity resolver → canonical markdown files → git commit → derived SQLite index.

```bash
untacit init $GRAPH
for b in examples/acme-manufactura/batches/*.json; do
  untacit import "$b" --graph $GRAPH
done
untacit stats --graph $GRAPH
```

Talking points while it imports:

- **One run = one commit.** `git -C $GRAPH log --oneline` shows the six runs.
- The graph repo is **plain markdown** — open any file under `$GRAPH/graph/`.
- `stats` shows 150 nodes / 233 edges across 7 node types, **4 open
  conflicts** and a review queue.

## 2. Find a business rule and walk to its evidence (~2 min)

```bash
untacit search prepago --graph $GRAPH
untacit search "pago anticipado" --mode hybrid --graph $GRAPH   # semantic + lexical (RRF)
```

Open `rule-bloqueo-de-pedido-sin-prepago` (CLI output or the app): the same
edge is backed by **code + document + validated interview** → confidence
pinned at the 0.99 ceiling. No edge in the graph exists without a literal
excerpt and a locator back to its source.

## 3. Conflicts: where sources disagree (~3 min)

```bash
untacit conflicts --graph $GRAPH
```

Four designed conflicts, each a real organizational failure mode:

1. **Aprobación de gerencia** — the code applies a 10.000 € threshold; the
   procedures manual says it applies to new customers regardless of amount.
2. **Recargo por pedido urgente** — the order website still charges a 15%
   surcharge that both the sales manual and the administration interview say
   was dropped in 2024. *The customer is being overcharged today.*
3. **Descuento por volumen** — code: 8% from 5.000 units; the current sales
   manual: 10% from 8.000 units, old table void since January 2026.
4. **Parada de las 400 horas** — the maintenance plan mandates stopping the
   die-cutter every 400 hours; the production chief admits on record the
   counter "waits" when there is a campaign. *Tacit knowledge contradicting
   the official document — only an interview can surface this.*

Resolve one from the CLI or the app's review queue; the decision is pinned to
the evidence set, so re-importing the same batches never re-opens it.

## 4. Impact analysis (~1 min)

"What breaks if we change the prepayment policy?"

```bash
# In the app: select the policy node → Impact. Via MCP: untacit_impact.
```

The closure reaches order intake, production planning, die-cutting,
expedition, picking, monthly invoicing and the accounting close — 13 nodes an
onboarding engineer would otherwise discover one incident at a time.

## 5. The graph as agent context — MCP (~2 min)

```bash
claude mcp add untacit -- node $PWD/packages/mcp/dist/bin.js --graph $GRAPH
```

Ask Claude (which has **no access to the sources**):

> ¿Sigue vigente el recargo del 15% a pedidos urgentes?

It should answer from `untacit_conflicts`/`untacit_evidence` that the rule
is **in conflict** — the code still applies it but newer sources say it was
dropped — and cite the excerpts. The 10-question gate is reproducible:

```bash
node examples/acme-manufactura/evals/run.mjs               # deterministic (real MCP calls), CI
node examples/acme-manufactura/benchmark/run-benchmark.mjs # agentic, uses your local Claude Code
```

## 6. Drift (~1 min)

```bash
git -C $GRAPH log --oneline               # pick two run commits
untacit diff <older> <newer> --graph $GRAPH
```

The diff speaks ontology — rules appearing, confidences moving, conflicts
opening — not YAML lines.

## Desktop app

```bash
UNTACIT_REPO=$GRAPH pnpm --filter @untacit/app dev   # browser dev mode
```

Graph view (color = type, thickness = confidence), detail panel with clickable
evidence, review queue (merges + low confidence + conflicts), drift view.
