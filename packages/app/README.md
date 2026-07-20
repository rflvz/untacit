# @untacit/app

Desktop app (docs/03 §7): Tauri 2 shell + React frontend + Node sidecar. The
core runs as a sidecar process exposing a local HTTP API; the UI consumes it,
so the same frontend works in a plain browser during development.

**Installing on Windows?** See the user guide:
[`docs/08-guia-app-escritorio-windows.md`](../../docs/08-guia-app-escritorio-windows.md)
(requirements, installer, first run, tray usage, troubleshooting). Installers
are published by [`.github/workflows/desktop.yml`](../../.github/workflows/desktop.yml)
on every `v*` tag.

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

`src-tauri/` owns the window, the system tray and the sidecar lifecycle,
split by concern: `config.rs` (persisted repo choice + MRU list under the OS
config dir), `nodejs.rs` (Node runtime discovery + missing-Node dialog),
`shell.rs` (managed state, sidecar spawn/restart/kill), `tray.rs` (tray icon
+ menu) and `commands.rs` (frontend commands: `shell_state`, `pick_repo`,
`set_repo`, `open_repo_folder`, plus the `untacit://repo-changed` event).

Desktop UX:

- **Folder picking, no env vars**: on first run the frontend shows a welcome
  screen (`src/views/WelcomeView.tsx`) and the user picks the graph repo with
  the native folder dialog; the choice persists (`shell.json`) with a recents
  list. Switching folders restarts the sidecar and retitles the window.
- **System tray**: closing the window hides to the tray; the tray menu shows
  the window, switches/reveals the graph folder and quits. Left click
  restores the window. If the tray can't be created (some Linux setups),
  closing the window quits normally.
- **Single instance**: a second launch focuses the existing window.
- **Node detection**: the shell looks for Node ≥ 20 in `UNTACIT_NODE`, PATH
  and the standard Windows install locations, and shows a dialog linking to
  nodejs.org when missing.

Build/run:

- `pnpm tauri dev`: `beforeDevCommand` runs `pnpm dev`, so sidecar + vite
  come up as in the browser flow (the shell spawns nothing in debug).
- `pnpm tauri build --bundles nsis`: `beforeBuildCommand` builds the
  frontend and stages a **self-contained sidecar** via `pnpm bundle:sidecar`
  (`scripts/stage-sidecar.mjs`): esbuild bundles the sidecar *with*
  `@untacit/core` and `@untacit/extractors` compiled in from sources
  (tsconfig.sidecar.json paths), leaving only `better-sqlite3` external and
  copying it (prebuilt `.node` included) into `sidecar/dist/node_modules/`.
  The whole `sidecar/dist/` ships as a Tauri resource, so the installed app
  only needs a system Node ≥ 20 — staging must run on the target OS/arch.
  `UNTACIT_REPO`, `UNTACIT_PORT`, `UNTACIT_OPEN_CMD`, `UNTACIT_NODE` and
  `UNTACIT_SIDECAR` (explicit bundle path) pass through the environment.

CI: PRs type-check the shell with `cargo check` on `windows-latest`
(ci.yml `desktop-shell-check`); installers build in
`.github/workflows/desktop.yml` (tags `v*` → attached to a draft release;
manual runs → uploaded artifact). `pnpm dev` gives the same UI in a plain
browser. User-facing guide: `docs/08-guia-app-escritorio-windows.md`.
