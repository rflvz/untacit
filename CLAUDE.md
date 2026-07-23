# CLAUDE.md

untacit builds an ontological graph of a company's business logic (rules,
processes, roles, entities…) extracted from code, documents and interviews,
with mandatory provenance on every edge. The graph lives in its own git repo
as canonical markdown plus a derived SQLite index, and is queried via CLI,
MCP tools or a desktop viewer.

## Packages (pnpm monorepo, TypeScript ESM)

- `packages/core` — types, deterministic canonical serializer, batch
  validator, graph store, SQLite index, retrieval, ontology diff, import
  pipeline (`untacit init`/`import` internals).
- `packages/cli` — `untacit` command (commander): init, import, extract,
  search, stats, conflicts, diff, interview, serve-mcp.
- `packages/mcp` — MCP server: read-only tools `untacit_context`/`explore`/
  `impact`/`paths`/`similar`/`evidence`/`diff`/`conflicts`, plus a write
  surface behind `--write`.
- `packages/extractors` — LLM extraction agents for code, documents and
  interviews (engine = local `claude` CLI).
- `packages/app` — Tauri desktop viewer.
- `packages/server` — self-hosted multi-graph MCP HTTP server with OAuth.

## Commands

- `pnpm install` — install the workspace.
- `pnpm build` — build all packages (`tsc`); scope with
  `pnpm --filter @untacit/core build`.
- `pnpm test` — vitest per package; scope with
  `pnpm --filter @untacit/core test`.
- `pnpm typecheck` — `tsc --noEmit` across packages.
- CLI tests run `packages/cli/src/bin.ts` through tsx — they do not need the
  cli built, but they DO need up-to-date `dist/` builds of core and
  extractors (they import `@untacit/core` / `@untacit/extractors` from dist).

## Invariants an agent can silently break

1. **Deterministic canonical serialization.** Node files under
   `graph/<type>/<id>.md` are byte-deterministic — stable key order, sorted
   edges/evidence/aliases (`packages/core/src/serializer/index.ts`).
   Re-importing an identical batch must leave `git status` clean. Canary:
   the idempotence test in `packages/cli/src/cli.test.ts` ("re-import of the
   same batch is a no-op").
2. **Every edge carries mandatory evidence.** The validator rejects
   nodes/edges without `evidence` (locator + excerpt ≤300 chars) —
   `packages/core/src/validator/index.ts`. Never make evidence optional.
3. **Interview transcripts are NEVER persisted.** Only the interviewee's
   role plus evidence excerpts reach the graph repo — no names, no full
   transcripts (`docs/03-arquitectura.md` §privacidad; audit in
   `docs/05-auditoria-privacidad.md`).
4. **No Anthropic API client, no ANTHROPIC_API_KEY.** All LLM calls go
   through the local `claude` binary (`packages/extractors/src/llm.ts`).
   Do not add an SDK/API-key path.
5. **Source repo vs graph repo.** The source repo is the client's code being
   extracted FROM; the graph repo (created by `untacit init`) is where the
   graph lives. Never point `--graph` at the source repo.
6. **The acme-manufactura dataset has counts asserted in CI.**
   `.github/workflows/ci.yml` runs `examples/acme-manufactura/check.mjs`
   (150 nodes, 233 edges, 4 conflicts…). If you change the dataset, update
   the counts there.

## Pointers

- `docs/03-arquitectura.md` — architecture (pipeline, graph-repo layout, MCP).
- `docs/02-ontologia-spec.md` — closed ontology v1 (node/edge types, evidence).
- `.claude/skills/untacit/SKILL.md` — how to operate untacit as an agent
  (CLI/MCP).
