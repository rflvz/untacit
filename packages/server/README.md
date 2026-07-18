# @untacit/server

Self-hosted MCP server over **Streamable HTTP**: one instance per company,
N graphs per instance, local users with **OAuth 2.1** login per the MCP
authorization spec. Design: [`docs/06`](../../docs/06-servidor-http-autoalojado.md) ·
Deployment guide: [`docs/07`](../../docs/07-guia-despliegue-autoalojado.md).

- `GET/POST/DELETE /graphs/<id>/mcp` — Streamable HTTP endpoint per graph
  (sessions via `mcp-session-id`, bound to user + graph). Read-only: the six
  query tools of `@untacit/mcp`; agent surface opt-in per graph
  (`tools: "agent"`), write gate never.
- `/authorize /token /register /revoke /.well-known/*` — authorization
  server (SDK `mcpAuthRouter` + SQLite-backed provider: PKCE S256, single-use
  codes, opaque tokens hashed at rest, refresh rotation with reuse
  detection, immediate revocation).
- `GET/POST /login` — server-rendered login page (per-transaction CSRF, rate
  limited, no enumeration).
- Per-request **user→graph grants** (revoking cuts live access) and
  RFC 8707 resource binding; RFC 9728 protected-resource metadata per graph.
- Background **embedding refresher**: after every reindex the semantic
  channel catches up automatically (`GraphIndex.updateEmbeddings`,
  incremental) — the graphs' only maintenance is an external `git pull`.

## Develop

```bash
pnpm --filter @untacit/server build   # or test / typecheck
```

## Run locally (no Docker)

```bash
mkdir -p data && cp ../../deploy/config.example.json data/untacit-server.config.json
# edit: publicUrl http://127.0.0.1:8787, graphs[].path → a local graph repo
node dist/bin.js serve --config data/untacit-server.config.json
node dist/bin.js user add ana && node dist/bin.js grant ana <graphId>
claude mcp add --transport http acme http://127.0.0.1:8787/graphs/<graphId>/mcp
```

## Administer

```
untacit-server serve --config /data/untacit-server.config.json
untacit-server user add|list|disable|enable|set-password
untacit-server grant <user> <graphId> · revoke <user> <graphId> · status
```

Production image and compose files live in [`deploy/`](../../deploy).
