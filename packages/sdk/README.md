# @untacit/sdk

Programmatic surface over an untacit graph repo — the same queries the MCP
tools expose (`context`, `explore`, `impact`, `paths`, `similar`, `evidence`,
`conflicts`, `diff`), plus stats, full-text search, batch import and the
extraction agents. Analogous to what the Claude Agent SDK is to Claude Code:
a stable library for building automations on top of the product's core.

## Stability contract

**This package is the semver surface.** Scripts and automations should depend
on `@untacit/sdk`, not on `@untacit/core` or `@untacit/mcp` — those are
internal layers whose APIs may change shape between minor versions. Within a
major version of the SDK:

- every exported method keeps its signature and result shape (fields may be
  *added*, never removed or retyped);
- the re-exported types (`GraphStats`, `Conflict`, `GraphDiff`,
  `SearchResult`, `ContextResult`, `ExtractionBatch`, `ImportResult`, …) are
  part of that contract.

The SDK is a thin wrapper: it opens the derived SQLite index once per
`Untacit` instance and delegates to the pure query layer behind the MCP
tools, so results are identical to what an agent sees through MCP.

## Quickstart

```ts
import { Untacit, withGraph } from '@untacit/sdk';

// Explicit lifecycle…
const u = Untacit.open('./mi-grafo');
const { nodes } = await u.context('pago anticipado clientes nuevos');
console.log(nodes.map((n) => `[${n.type}] ${n.id} — ${n.name}`).join('\n'));
u.close();

// …or scoped: the handle closes even if the callback throws.
const stats = await withGraph('./mi-grafo', (u) => u.stats());
console.log(`${stats.nodes_total} nodes, ${stats.conflicts_open} open conflicts`);
```

Node ≥ 20, ESM only. `Untacit.open` refreshes the derived index
incrementally, so it is always consistent with the graph repo's files —
opening after a `git pull` just works.

## Examples

### 1. CI gate: fail the build when the graph has open conflicts

```ts
// ci-conflicts.mjs — exit 1 when sources contradict each other.
import { withGraph } from '@untacit/sdk';

const conflicts = await withGraph(process.argv[2] ?? '.', (u) => u.conflicts());
if (conflicts.length > 0) {
  for (const c of conflicts) {
    console.error(`CONFLICT ${c.nodeId} -${c.edgeType}-> ${c.target}`);
    for (const ev of c.supporting) console.error(`  + [${ev.source_type}] "${ev.excerpt}"`);
    for (const ev of c.contradicting) console.error(`  - [${ev.source_type}] "${ev.excerpt}"`);
  }
  process.exit(1);
}
console.log('graph is conflict-free');
```

### 2. Nightly digest: what changed in the graph since yesterday

```ts
// digest.mjs — ontology-level drift plus current health, for a cron job.
import { withGraph } from '@untacit/sdk';

const report = await withGraph('./mi-grafo', (u) => {
  const diff = u.diff('HEAD@{1.day.ago}', 'HEAD');
  const stats = u.stats();
  return [
    `graph: ${stats.nodes_total} nodes / ${stats.edges_total} edges`,
    `open conflicts: ${stats.conflicts_open}, low-confidence edges: ${stats.low_confidence_edges}`,
    `last 24h: +${diff.nodes.filter((n) => n.kind === 'added').length} nodes, ` +
      `${diff.edges.length} edge changes`,
    ...diff.nodes.map((n) => `  ${n.kind} [${n.type}] ${n.id}`),
  ].join('\n');
});
console.log(report); // pipe it to mail/Slack from the cron wrapper
```

### 3. Automated import: extract from a repo and persist the batch

```ts
// reextract.mjs — nightly re-extraction of a source repo (needs the `claude` CLI).
import { extractCode, withGraph } from '@untacit/sdk';

const { batch, rejections } = await extractCode('../acme-erp', { maxCandidates: 100 });
for (const issue of rejections) console.warn(`rejected ${issue.path}: ${issue.message}`);

await withGraph('./mi-grafo', async (u) => {
  const result = await u.importBatch(batch);
  console.log(
    result.noop
      ? 'no changes'
      : `run ${result.runId}: +${result.stats.nodes_created} nodes, commit ${result.commit}`,
  );
});
```

`importBatch` is idempotent: re-importing an identical batch reports
`noop: true` and leaves the graph repo untouched. To land the change on a
review branch instead of the current one, pass `{ branch: 'run/nightly-01' }`
(extraction-as-PR).

## Using the SDK from an installed untacit

The installer keeps a full monorepo checkout under `~/.untacit/app`
(`%LOCALAPPDATA%\untacit\app` on Windows), already built. Link the SDK from
there into your automation project:

```bash
cd ~/.untacit/app/packages/sdk && npm link   # once, registers the package globally
cd /path/to/your/project && npm link @untacit/sdk
```

`untacit update` rebuilds that checkout **in place** (same mechanism the CLI
itself relies on), so the link picks up new versions automatically — no
relink needed after updating.

## Extraction requirements

`extractCode` / `extractDocs` run the extraction agents on the **Claude Code
CLI** (`claude` on PATH, or `UNTACIT_CLAUDE_BIN`). Both throw with a clear
message when it is missing; everything else in the SDK is read/write over
the graph repo and needs no LLM.

## Develop

```bash
pnpm --filter @untacit/sdk build   # or test / typecheck
```
