# Contributing to untacit

Thanks for your interest! untacit is young and moving fast; small, focused
contributions land best.

## Setup

```bash
pnpm install
pnpm build        # builds every package (core first)
pnpm test         # vitest across the monorepo
node examples/acme-manufactura/check.mjs       # dataset invariants
node examples/acme-manufactura/evals/run.mjs   # the 10-question gate, as real MCP calls
```

Requirements: Node ≥ 20 and pnpm (the exact version is pinned in
`package.json#packageManager` — `corepack enable` handles it). The desktop
app additionally needs the Tauri toolchain (Rust), but every other package —
core, CLI, MCP server, extractors — is plain TypeScript/Node.

## Repository map

- `packages/core` — ontology contract, canonical serializer, validator,
  entity resolver, SQLite index, diff, import pipeline. **Start here**; the
  design invariants live in `docs/` (Spanish).
- `packages/cli`, `packages/mcp`, `packages/extractors`, `packages/app`.
- `examples/acme-manufactura` — the synthetic dataset every test and demo
  uses. Batches 04–06 are emitted by `tools/generate-extended-batches.mjs`;
  edit the generator, not the JSON.

## Ground rules

1. **The graph repo stays deterministic.** Re-importing identical data must
   leave `git status` clean. If your change breaks idempotence, `check.mjs`
   will tell you.
2. **The ontology is closed (v1).** New node/edge types are a spec discussion
   (open an issue referencing `docs/02-ontologia-spec.md`), not a PR.
3. **No edge without evidence.** Anything that creates edges must carry
   excerpt + locator.
4. **Synthetic data only in `examples/`.** No real names of people,
   companies, products or code. CI and the privacy audit
   (`docs/05-auditoria-privacidad.md`) assume this.
5. **Tests accompany behavior.** Unit tests in the affected package, plus
   `check.mjs` / `evals/run.mjs` updates when dataset semantics change.

## Pull requests

- Keep PRs single-topic; describe the *why*, link issues.
- CI must pass: build, tests, dataset verification and the deterministic
  evals.
- The docs under `docs/` are the design source of truth (currently in
  Spanish). If your change contradicts them, update them in the same PR.

## Reporting issues

Use GitHub issues. For extraction-quality problems, include a minimal batch
JSON that reproduces the misbehavior; for graph/index bugs, the output of
`untacit stats` and the failing query.
