---
name: untacit
description: "Trigger: untacit, grafo de logica de negocio, business logic graph, graph repo, .untacit, untacit_context/explore/impact/evidence/diff/conflicts, MCP untacit. Query and operate the untacit ontological business-logic graph via CLI and MCP."
license: MIT
metadata:
  author: untacit
  version: "1.0"
---

## Activation Contract

Use this skill when:
- The user asks about business rules/policies, or "why does X work this way", in a repo that has (or could have) an untacit graph.
- A repo mentions `untacit.config.json`, a graph repo (markdown nodes + `.untacit/index.db`), or asks to extract/query/interview business logic.
- The user wants drift over time, open contradictions, or to launch the desktop viewer in window mode.

Skip it for generic ontology/knowledge-graph questions with no untacit repo, config, or CLI in scope.

## Hard Rules

- untacit has TWO distinct repos: the **source repo** (code/docs to extract FROM) and the **graph repo** (created by `untacit init`, holds node markdown + derived `.untacit/index.db`). Never point `--graph` / `UNTACIT_REPO` at the source repo.
- Inside an agent session with the untacit MCP connected, prefer MCP tools over shelling out to the CLI.
- Read-only tools (no `--write` needed): `untacit_context` (search by text — start here) → `untacit_explore` (node detail) → `untacit_evidence` (provenance/citations) → `untacit_impact` (blast radius) → `untacit_diff` / `untacit_conflicts` (drift & open contradictions).
- Write tools (`untacit_import_batch`, `untacit_review_queue`, `untacit_merge_accept/reject/revert`, `untacit_conflict_resolve`) only work if the server was started with `--write` — never assume they're available; if a call fails, say the server needs `--write`, don't silently downgrade.
- Every edge carries mandatory evidence. Cite it via `untacit_evidence` instead of trusting a one-line summary.

## Decision Gates

| Need | Command / tool |
|---|---|
| No graph repo yet | `untacit init <dir>` |
| Extract rules from a source repo | `untacit extract code <repoDir> --graph <dir> --import` (`--paths` for partial re-extraction, `--branch` for extraction-as-PR) |
| Extract rules from docs (pdf/md/docx) | `untacit extract docs <files...> --graph <dir> --import` |
| Fill knowledge gaps from a person | `untacit interview --graph <dir> --role <rol>` |
| Query without an agent host | `untacit search \| stats \| conflicts \| diff --graph <dir>` |
| Serve to an agent host (Claude Code/Desktop) | `untacit serve-mcp --graph <dir> [--write] [--http --port <n>]` |
| `untacit` not on PATH | `cd packages/cli && npm link` (from this monorepo) |
| Visual explorer in a window | Install the NSIS setup from [Releases](https://github.com/rflvz/untacit/releases), or build it: `pnpm --filter @untacit/app tauri build --bundles nsis` (see `docs/08-guia-app-escritorio-windows.md`). First launch shows a native folder picker for the graph repo; the choice persists to `%APPDATA%\dev.untacit.app\shell.json` — later runs reopen it automatically, no env var needed. |
| Point the app at a different graph | Use the tray menu ("Cambiar carpeta del grafo…") or the top-bar chip inside the app, NOT by relaunching with `UNTACIT_REPO` — the persisted config always wins over the env var once a graph has been picked once. |

## Execution Steps

1. Identify which repo is the graph repo (has `untacit.config.json` / `nodes/` / `.untacit/`) versus the source repo being analyzed.
2. If no MCP connection exists yet, add one: `claude mcp add untacit -- untacit serve-mcp --graph <dir>`.
3. Answer business-logic questions by chaining `untacit_context` → `untacit_explore`/`untacit_impact` → `untacit_evidence`. Never invent a threshold/rule the graph doesn't back with evidence — say so and offer to extract or interview instead.
4. Before calling a write tool, confirm the server is running with `--write`.
5. For "open it visually", resolve the graph repo path first. If the app has never opened a graph before, launch it with `UNTACIT_REPO=<graph-dir>` set (or let the native picker run); afterwards, switch graphs from the app's tray/top-bar UI, not env vars.

## Output Contract

- Cite node/edge ids and evidence excerpts backing any business-logic claim.
- Surface open conflicts (`status: conflicted`) explicitly instead of picking a side.
- If a write action isn't available (server not in `--write` mode), state that rather than substituting a read-only workaround.

## References

- `README.md` — architecture, full CLI/MCP tool table, quickstart.
- `docs/08-guia-app-escritorio-windows.md` — desktop app install, tray, folder picker, env vars, troubleshooting.
- `docs/` — ontology spec, phase plan, drift & extraction-as-PR guide, self-hosted server deployment.
- `examples/acme-manufactura/DEMO.md` — guided walkthrough over a synthetic 150-node graph.
