# @untacit/app

Desktop app (docs/03 §7): Tauri 2 shell + React frontend + Node sidecar. The
core runs as a sidecar process exposing a local HTTP API; the UI consumes it,
so the same frontend works in a plain browser during development.

## Run (dev)

```bash
# 1. Build the core once (the sidecar imports @untacit/core)
pnpm --filter @untacit/core build

# 2. Point the sidecar at a graph repo and start sidecar + vite together
UNTACIT_REPO=/path/to/graph-repo pnpm --filter @untacit/app dev
# → UI on http://localhost:5173, sidecar API on http://localhost:4823
```

Try it with the synthetic dataset: import `examples/acme-manufactura/batches/*`
into a temp repo with the CLI and set `UNTACIT_REPO` to it.

## Views

- **Grafo** — global Sigma.js (WebGL) view: color by node type (Untacit DS
  palette), edge thickness by confidence, conflicted elements in amber, filters
  by type/confidence/status, FTS search with focus-on-click.
- **Panel de detalle** — description, aliases, evidence (excerpt + locator per
  source type, `validated_by`), in/out edges with confidence bars. Code and
  document locators are clickable: `POST /api/open` resolves them against the
  graph repo's `untacit.config.json` sources and opens the local file in your
  editor (`UNTACIT_OPEN_CMD` template, e.g. `code -g {path}:{line}`; defaults
  to VS Code, then the OS opener).
- **Revisión** — the three trays: merge proposals (accept/reject → writes files
  and commits through the core), low-confidence edges, and open conflicts with
  their opposing evidence — the human marks the winning evidence and the edge
  returns to `active` (supports wins) or turns `deprecated` (contradicts wins);
  new evidence re-opens the conflict.
- **Drift** — ontology-level diff between two git refs of the graph repo.
- **Entrevista** — Fase 4 (docs/03 §4.3): chat with the interviewer agent +
  live proposal panel. The agent derives its question script from actual graph
  gaps (processes nobody executes / nothing triggers, isolated nodes) and asks
  follow-ups until statements carry condition and consequence. Every statement
  becomes a triple to **accept, edit or reject** (bulk accept with exceptions);
  existing low-confidence edges appear as claims to **confirm** (evidence
  `validated_by` role → confidence 0.95) or **refute** (`contradicts` evidence
  → conflict in the review queue). Finishing the session imports the batch as
  an interview run (one commit). The transcript never persists; only excerpts
  ≤ 300 chars with the interviewee's **role**, never a name. The engine is the
  local **Claude Code** CLI (print mode, your existing Claude Code auth) — no
  API key anywhere; without Claude Code installed, run interviews from Claude
  Desktop/Claude Code via the MCP server instead.

## Sidecar API

`sidecar/server.ts` (Hono). `GET /api/health | stats | graph | node/:id |
search | conflicts | review | runs | diff`,
`POST /api/review/merge/:id/accept | reject`,
`POST /api/review/conflict/resolve` and `POST /api/open` (resolve an
evidence locator to a local file and open it). Reads always come from the
derived SQLite index; writes go through the core (files first, then commit,
then reindex).

Interview endpoints (in-memory sessions, LLM required except for `gaps`):
`GET /api/interview/gaps | /api/interview/:id`,
`POST /api/interview/start | :id/answer | :id/proposal/:pid (accept · reject ·
edit · confirm · refute · skip) | :id/accept-all | :id/finish`.

For `/api/open` to resolve code locators, declare the source repos in the
graph repo's `untacit.config.json`:

```json
{
  "sources": {
    "code": [{ "name": "web-pedidos", "path": "../web-pedidos" }],
    "documents": [{ "path": "../docs-internos" }]
  }
}
```

## Tauri shell

`src-tauri/` owns the window and the sidecar lifecycle:

- `pnpm tauri dev` (with the Tauri CLI installed): `beforeDevCommand` runs
  `pnpm dev`, so sidecar + vite come up as in the browser flow.
- Release build: `beforeBuildCommand` bundles the sidecar with esbuild
  (`pnpm bundle:sidecar` → `sidecar/dist/server.mjs`, `@untacit/core` stays
  external so its native SQLite dep resolves from the workspace) and
  `src-tauri/src/main.rs` spawns it with the system `node`, killing it on
  exit. `UNTACIT_REPO`, `UNTACIT_PORT`, `UNTACIT_OPEN_CMD` and
  `UNTACIT_SIDECAR` (explicit bundle path) pass through the environment.

The Tauri shell is not built in CI (needs the platform webview toolchains);
`pnpm dev` gives the same UI in a plain browser.
