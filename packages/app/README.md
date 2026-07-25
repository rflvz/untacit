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
  by type/confidence/status, search with focus-on-click in three modes:
  exact (FTS5), hybrid (RRF fusion) and semantic (embedding k-NN), like the
  CLI's `search --mode`.
- **Panel de detalle** — description, aliases, evidence (excerpt + locator per
  source type, `validated_by`), in/out edges with confidence bars. Code and
  document locators are clickable: `POST /api/open` resolves them against the
  graph repo's `untacit.config.json` sources and opens the local file in your
  editor (`UNTACIT_OPEN_CMD` template, e.g. `code -g {path}:{line}`; defaults
  to VS Code, then the OS opener).
- **Revisión** — the three trays: merge proposals (accept/reject → writes files
  and commits through the core) with both nodes' name/description inline,
  low-confidence edges (with a shortcut to verify them in an interview), and
  open conflicts with their opposing evidence — the human marks the winning
  evidence and the edge returns to `active` (supports wins) or turns
  `deprecated` (contradicts wins); new evidence re-opens the conflict. A
  reviewer **role** (persisted locally, never a name) is recorded as `by` in
  every decision, and node ids link back to the graph view.
- **Runs** — the graph-repo lifecycle without the terminal: run history
  (id, source, stats, commit), **extraction from the app** (see below), batch
  import (paste or pick the JSON produced by `untacit extract … --out`, with
  rejections and merge proposals surfaced), and remote sync — ahead/behind
  against the upstream, ff-only pull and push.
- **Extracción** (Runs tab) — `untacit extract code|docs --import` without the
  terminal. Pick one of the sources declared in `untacit.config.json`, get a
  **preview that costs no LLM call** (the CLI's `--candidates-only` /
  `--sections-only`: candidates with their heuristic signals, or document
  sections with their locators, plus how many agent calls the run would make),
  then launch it. Extraction is a job: the card shows the phase (escaneo de
  candidatos → llamadas al agente → import), a progress bar over the planned
  calls, validator rejections as they happen, and a **cancel** button. When it
  lands, the run's stats/commit are shown with a shortcut to Revisión if the
  resolver queued merge proposals. Options mirror the CLI: max candidates,
  candidates/sections per call, `--model`, and `--branch` (commit the run on
  `run/<run_id>` for extraction-as-PR). Cancelling aborts before the next agent
  call and discards the partial batch, like Ctrl+C on the CLI; if the *import*
  fails instead, the emitted batch stays downloadable so the LLM spend is never
  lost. The engine is the local **Claude Code** CLI — with it missing, the card
  explains how to install it (or set `UNTACIT_CLAUDE_BIN`, or extract via MCP)
  and keeps the preview working.
- **Drift** — ontology-level diff between two git refs of the graph repo; the
  ref inputs autocomplete from the repo's recent commits.
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
  Desktop/Claude Code via the MCP server instead. The agent's **model** is
  selectable (the CLI's `--model`; the default is Claude Code's own).

  Sessions are **resumable**: the sidecar writes the same snapshot the CLI's
  `untacit interview --resume` reads — `.untacit/interview-session.json`
  (version 1), atomically, after every turn and every validation decision — so
  closing the app, switching repos or losing the sidecar no longer costs the
  sitting, and a session started in the app can be finished from the terminal
  (or vice versa). Reopening the tab offers **reanudar** or **descartar** with
  the saved role, turn count and pending proposals. What is persisted is role,
  script, script index and proposals; **the transcript is not** — on resume the
  agent opens with a recap of where you left off, not with the conversation
  (docs/05-auditoria-privacidad.md). Only a successful import removes the
  snapshot, and only if it is still ours: a concurrent CLI interview over the
  same graph repo keeps its own resumable work.

## Sidecar API

`sidecar/server.ts` (Hono). `GET /api/health | stats | graph | node/:id |
search (mode=fts|semantic|hybrid) | conflicts | review | runs | diff |
git/log | git/status (?fetch=1)`,
`POST /api/extract` (run an extraction agent over a declared source),
`POST /api/init` (create the graph-repo skeleton in the configured folder),
`POST /api/import` (materialize an extraction batch as a run + commit),
`POST /api/git/pull | push` (ff-only pull / push against the upstream),
`POST /api/review/merge/:id/accept | reject`,
`POST /api/review/conflict/resolve` and `POST /api/open` (resolve an
evidence locator to a local file and open it). Reads always come from the
derived SQLite index; writes go through the core (files first, then commit,
then reindex).

`GET/PUT /api/settings` covers `embeddings`, `retrieval` **and `sources`**,
so the source repos below can be edited from Ajustes instead of by hand.
When the picked folder has no `untacit.config.json`, the frontend shows an
"initialize here" screen backed by `POST /api/init` — and it never queries
the graph routes on an uninitialized folder (no stray `.untacit/`).

Extraction endpoints (`sidecar/extract.ts`; LLM required except for `sources`
and `preview`):

| route | what it does |
| --- | --- |
| `GET /api/extract/sources` | declared sources resolved against this machine (existence, document counts) + whether the local `claude` binary is reachable + the job currently running |
| `POST /api/extract/preview` | `{kind, source, maxCandidates?, paths?, chunkSize?}` → candidates or sections and the number of agent calls a run would make. **No LLM call** |
| `POST /api/extract` | `{kind, source, model?, chunkSize?, maxCandidates?, paths?, branch?}` → `202` with the job snapshot |
| `GET /api/extract` | remembered jobs, newest first |
| `GET /api/extract/:id` | one job snapshot (polling) |
| `GET /api/extract/:id/events` | the same snapshots as SSE (`event: job`), ending on the terminal phase |
| `POST /api/extract/:id/cancel` | abort before the next agent call |
| `GET /api/extract/:id/batch` | the emitted batch, verbatim — survives a failed import |

Job phases: `scanning → extracting → importing` then `done | error |
cancelled`. Two deliberate constraints: **one running job at a time** (a second
`POST /api/extract` answers `409`), because the import writes files and commits;
and **`reindex: false`** on the import — the sidecar's own index reindexes on
the next read, so `.untacit/index.db` never has two writers. `paths` scopes a
code run to specific files/dirs (partial re-extraction, docs/03 §5); the UI
does not expose it yet.

Interview endpoints (live session in memory, resumable snapshot on disk; LLM
required except for `gaps` and `saved`):
`GET /api/interview/gaps | /api/interview/saved | /api/interview/:id`,
`POST /api/interview/start (role, model?) | /api/interview/resume (model?) |
:id/answer | :id/proposal/:pid (accept · reject · edit · confirm · refute ·
skip) | :id/accept-all | :id/finish`,
`DELETE /api/interview/saved` (discard the interrupted session). `gaps` carries
the saved-session summary so the start screen needs one request; an unreadable
or future-version snapshot answers `409` on `saved`/`resume` (and `null` on
`gaps`) so "descartar" stays reachable.

For `/api/open` to resolve code locators, and for extraction to know what to
read, declare the sources in the graph repo's `untacit.config.json`:

```json
{
  "sources": {
    "code": [{ "name": "web-pedidos", "path": "../web-pedidos" }],
    "documents": [{ "path": "../docs-internos" }]
  }
}
```

`include`/`exclude` on a source are **regular-expression fragments** (joined
with `|`), matched against the absolute file path — that is what the
extractors' scanner takes. Document sources are walked for `.md`, `.markdown`,
`.txt`, `.pdf` and `.docx` (max 200 files per source); a file that cannot be
parsed is reported and skipped, never fatal.

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

## Known gaps

Deliberately out of scope so far, and what would have to change:

- **Multi-workspace.** One sidecar process serves exactly one graph repo, and
  switching folders restarts it (so extraction jobs and live interview
  transcripts are dropped, though the interview snapshot on disk survives per
  repo). Several graphs open side by side means a repo-keyed sidecar registry
  and per-repo job/session maps.
- **Job durability.** Extraction jobs live in the sidecar's memory (capped at
  20, an hour's TTL). Killing the sidecar mid-run loses the progress view; the
  agent calls already paid for go with it. Interviews *are* durable — extraction
  is not, and would need the same snapshot treatment.
- **Layout stability.** The views are single-column pages with fixed
  breakpoints; panels do not remember their size, the graph canvas does not
  restore its viewport across tab switches, and very narrow windows wrap rather
  than reflow.
- **i18n.** Every user-facing string is Spanish, inline in the components.
  There is no message catalog and no locale switch.
- **Partial re-extraction from the UI.** `POST /api/extract` accepts `paths`
  (the CLI's `--paths`) but the card has no picker for it yet.
