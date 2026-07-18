# 06 — Servidor MCP Streamable HTTP autoalojado (multi-grafo)

> Documento de diseño y plan de implementación de la **Fase 7** del plan de
> fases (docs/04). Se desarrolla de una sola vez: los pasos del §11 son los
> commits de la fase.
> Complementa docs/03 §6 (servidor MCP stdio) y el modo HTTP local sin auth de
> `packages/mcp` (`serveMcpHttp`, pensado para localhost/dev), añadiendo el
> despliegue en servidor para empresas: multi-grafo, usuarios y OAuth. La guía
> de despliegue operativa se escribirá como
> `docs/07-guia-despliegue-autoalojado.md` durante la implementación (§10).

## 1. Contexto y objetivo

Hoy el servidor MCP de untacit (`packages/mcp`) funciona solo por **stdio**:
cada usuario necesita el repositorio del grafo clonado en su máquina y un
cliente MCP local. Eso no sirve para el caso "la empresa despliega untacit
una vez y sus empleados/agentes lo consumen por red".

Objetivo: que cada empresa pueda **autoalojar una única instancia HTTP**
(Docker) que:

- expone **varios grafos** (multi-graph), cada uno en su propia URL
  `https://untacit.empresa.com/graphs/<graphId>/mcp`;
- usa el transporte moderno del spec MCP, **Streamable HTTP** (POST/GET/DELETE
  sobre un único endpoint, sesiones vía header `mcp-session-id`, streaming SSE);
- autentica con **OAuth 2.1 según el spec de autorización MCP**: el
  administrador crea usuarios locales; cuando un usuario conecta su cliente
  (Claude, Claude Code, Cursor…) a su URL, el navegador abre la página de
  login de la instancia e inicia sesión — sin IdP externo en v1;
- trata los grafos como **solo lectura**: sirve lo que hay en disco; la
  actualización (git pull / import / index) ocurre fuera del servidor. Las 6
  tools MCP existentes ya son read-only.

Decisiones de producto ya tomadas (propietario del producto):
multi-graph en una instancia; usuarios locales con login por URL; artefactos
Docker + docker-compose; grafos solo lectura desde disco; despliegue fácil
en Vercel como opción gestionada. **Prioridad explícita: la recuperación
híbrida con embeddings semánticos es más importante que Vercel** — el
despliegue recomendado y por defecto es Docker con el modelo local incluido;
el modo Vercel (donde el modelo no cabe y la recuperación degrada a
FTS/hash) pasa a opcional post-v1 (§11).

Los dos objetivos de despliegue comparten el mismo paquete y el mismo flujo
OAuth; difieren en cómo persisten estado y en el modo de sesión (§4.6):

| | **Docker / on-prem (recomendado, v1)** | Vercel (opcional, post-v1) |
|---|---|---|
| **Embeddings / recuperación** | **híbrida completa: modelo local en la imagen, refresco incremental automático** | FTS o `hash` (el modelo no cabe en una function) |
| Proceso | larga vida, estado en memoria + SQLite | efímero por petición |
| Sesiones MCP | con estado (`mcp-session-id`, Map) | stateless (transporte por petición) |
| Tokens | opacos, hash en `server.db`, revocación inmediata | JWT firmados (HS256, `jose` ya en el árbol), revocación al expirar |
| Usuarios | tabla SQLite + CLI en caliente | JSON en env var (generado con la CLI) |
| Índice del grafo | rw, se reindexa solo tras `git pull` | pre-construido en build, solo lectura |
| Actualizar grafo | cron `git pull` | `git push` → redeploy automático |
| `untacit_diff` | completo | degradado (sin binario git) |

## 2. Qué existe ya (verificado en el código)

- **Seam limpio**: `createServer(repoRoot, opts?): McpServer`
  (`packages/mcp/src/index.ts:49`) registra las tools y es agnóstico al
  transporte; `serveMcp()` lo ata a stdio. El camino stdio queda **intacto**
  (lo usa el escritorio). `ServeOptions.write` (`index.ts:44-47`) activa el
  write-gate `untacit_import_batch` — **el servidor de empresa lo deja
  desactivado en v1** (requisito de solo lectura); exponer extracción remota
  por grafo sería una decisión futura explícita.
- **Modo HTTP local ya mergeado**: `serveMcpHttp(repoRoot, opts)` en
  `packages/mcp/src/http.ts` — stateless (un server+transporte por POST,
  `enableJsonResponse: true`), un solo grafo, **sin autenticación**, bind por
  defecto `127.0.0.1`, solo POST. Está pensado para localhost/dev y **se
  conserva tal cual**; valida en el propio repo el patrón stateless que
  §4.6 usa. Lo que este diseño añade y aquél no tiene: multi-grafo, usuarios
  + OAuth, sesiones opcionales con SSE, hardening y despliegue.
- **Superficie de agente**: `createServer` registra siempre, además de las 6
  tools de consulta, la superficie de agente (`registerAgentSurface`,
  `packages/mcp/src/agent.ts`: `untacit_interview_gaps`,
  `untacit_code_candidates`, `untacit_doc_sections` + prompts versionados).
  Esas tools leen las *fuentes* configuradas en `untacit.config.json`
  (repos de código, documentos), que en un servidor no suelen estar
  montadas. El servidor de empresa expone por defecto **solo las tools de
  consulta** y ofrece `tools: "query" | "agent"` por grafo (§4.4) para
  quien monte también las fuentes. Requiere factorizar en `packages/mcp` un
  flag para omitir la superficie de agente (cambio de unas líneas, §7).
- **Concurrencia segura**: cada tool abre y cierra su propio
  `GraphIndex.open(repoRoot)` por llamada — vale para peticiones HTTP
  concurrentes sin estado compartido.
- **SDK listo, sin subir versión**: el lockfile fija
  `@modelcontextprotocol/sdk@1.29.0`, que incluye:
  - `server/streamableHttp.js` → `StreamableHTTPServerTransport` con opciones
    `sessionIdGenerator`, `onsessioninitialized`, `onsessionclosed`,
    `enableJsonResponse`, `eventStore`; método
    `handleRequest(req & { auth?: AuthInfo }, res, parsedBody?)`. Las opciones
    de protección DNS-rebinding del transporte están *deprecated* en 1.29 →
    validaremos `Host`/`Origin` en middleware propio (§6.4).
    Con `sessionIdGenerator: undefined` el transporte funciona **sin
    sesiones** (modo stateless, un transporte por petición) — la base del
    modo Vercel. Existe además `server/webStandardStreamableHttp.js`
    (transporte sobre `Request`/`Response` web estándar) si algún día se
    quiere Edge runtime; en Vercel Node no hace falta: las functions reciben
    `IncomingMessage`/`ServerResponse` y una app Express se exporta tal cual.
  - Framework OAuth completo: `server/auth/router.js` → `mcpAuthRouter`
    (monta `/authorize`, `/token`, `/register`, `/revoke`,
    `/.well-known/oauth-authorization-server`,
    `/.well-known/oauth-protected-resource…`),
    `server/auth/middleware/bearerAuth.js` → `requireBearerAuth` (adjunta
    `req.auth: AuthInfo`, responde 401/403 con `WWW-Authenticate`), y el
    interfaz `server/auth/provider.js` → `OAuthServerProvider`
    (`clientsStore`, `authorize`, `challengeForAuthorizationCode`,
    `exchangeAuthorizationCode`, `exchangeRefreshToken`, `verifyAccessToken`,
    `revokeToken?`). `AuthInfo.extra` permite adjuntar `{ userId }`.
  - El SDK ya arrastra `express@5`, `express-rate-limit`, `pkce-challenge` y
    `jose` — el framework de auth es Express, así que el paquete nuevo usará
    **Express 5** (el sidecar Hono de la app no es precedente aquí: el
    middleware OAuth del SDK es Express).
  - Cliente para tests: `StreamableHTTPClientTransport(url, { authProvider?,
    requestInit? })` — `requestInit.headers` permite inyectar un Bearer token
    y saltarse el flujo de navegador en integración.
- **No existe nada de**: auth entrante, modelo de usuarios, multi-tenant,
  Dockerfile, docs de despliegue. Env vars actuales: `UNTACIT_REPO`,
  `UNTACIT_PORT` (sidecar), `ANTHROPIC_API_KEY` (solo extractors; el
  servidor MCP read-only **no** la necesita).

**Matiz importante de "solo lectura"**: `GraphIndex.open` reindexa
incrementalmente si el repo cambió en disco (escribe en
`<grafo>/.untacit/index.db`, WAL). Por tanto los volúmenes de grafos se
montan **rw** — el servidor solo escribe bajo `.untacit/` (índice derivado,
regenerable); los markdown canónicos jamás se tocan. Beneficio: tras un
`git pull` externo, la siguiente tool call reindexa sola, sin reiniciar.

## 3. Arquitectura

```
                         empresa (on-prem / VPC)
 ┌──────────────────────────────────────────────────────────────────┐
 │  reverse proxy (TLS)  ──▶  untacit-server (contenedor)          │
 │                             Express 5                            │
 │   /authorize /token /register /revoke /.well-known/*  ◀─ OAuth   │
 │   /login (GET form + POST credenciales)                2.1 + PKCE│
 │   /healthz                                                       │
 │   /graphs/acme/mcp     ◀─ Streamable HTTP ─▶  McpServer("acme")  │
 │   /graphs/logistica/mcp                       McpServer("log…")  │
 │        │ requireBearerAuth + grant usuario→grafo                 │
 │        ▼                                                         │
 │   volúmenes:  /data (server.db, config)   /graphs/* (repos git)  │
 │   actualización externa: cron `git pull` en /graphs/*            │
 └──────────────────────────────────────────────────────────────────┘
     usuarios: Claude / Claude Code / Cursor → login en el navegador
```

- **Un despliegue por empresa**, N grafos por despliegue. El aislamiento
  entre empresas lo da la infraestructura (cada una su instancia); el
  aislamiento entre grafos de la misma empresa lo dan los *grants* por
  usuario (§5).
- **Un único authorization server** por instancia (los endpoints OAuth son
  globales); cada endpoint `/graphs/<id>/mcp` es un *protected resource*
  (RFC 9728) que apunta a ese AS.
- TLS y dominio los pone el reverse proxy de la empresa (Caddy/nginx);
  `publicUrl` en config define el issuer OAuth y las URLs anunciadas.

## 4. Paquete nuevo `packages/server` (`@untacit/server`)

Bin `untacit-server`. Deps: `@untacit/core`, `@untacit/mcp`,
`@modelcontextprotocol/sdk`, `express@^5`, `express-rate-limit`, `zod`,
`better-sqlite3`, `commander` (todas ya presentes en el árbol del lockfile;
cero dependencias nuevas de terceros). Build `tsc` plano y `vitest` como los
hermanos.

```
packages/server/
  package.json  tsconfig.json  README.md
  src/
    bin.ts            # CLI: serve | user add|list|disable|enable|set-password
                      #      | grant | revoke | status
    index.ts          # export createHttpApp(config)/startServer para tests
    config.ts         # carga + validación zod de untacit-server.config.json,
                      #   overrides por env, resolución de rutas de grafos
    db.ts             # apertura de <dataDir>/server.db, DDL, PRAGMA user_version
    users/
      store.ts        # interfaz UserStore (verify scrypt+timingSafeEqual, grants)
      sqlite.ts       # Docker: tablas users/user_graphs, gestión en caliente (CLI)
      env.ts          # Vercel: UNTACIT_USERS (JSON con hashes scrypt, generado
                      #   con `untacit-server user hash`)
    oauth/
      provider.ts     # UntacitOAuthProvider implements OAuthServerProvider,
                      #   compuesto por UserStore + TokenStrategy + ClientsStore
      tokens-opaque.ts# TokenStrategy Docker: opacos aleatorios, solo hashes
                      #   SHA-256 en server.db, revocación inmediata, rotación
      tokens-jwt.ts   # TokenStrategy Vercel: JWT HS256 con `jose` (ya en el
                      #   árbol), autocontenidos; códigos de autorización =
                      #   JWT de 10 min con PKCE challenge embebido
      clients-db.ts   # ClientsStore SQLite (registro dinámico persistente)
      clients-signed.ts# ClientsStore stateless: client_id = metadata RFC 7591
                      #   firmada (HMAC) — sin almacenamiento
      login.ts        # GET/POST /login: transacción de autorización pendiente,
                      #   CSRF por transacción, rate limit
      pages.ts        # HTML mínimo server-rendered (login, error), sin plantillas
    http/
      app.ts          # ensamblado Express: seguridad → mcpAuthRouter → login
                      #   → metadata por grafo → /graphs/:id/mcp → /healthz
      mcp.ts          # modo stateful: registro de sesiones (Map en memoria),
                      #   binding sesión↔usuario↔grafo, eviction por inactividad;
                      #   modo stateless: transporte+McpServer por petición
      guards.ts       # validación Host/Origin, resolución de :graphId,
                      #   chequeo de grant y de `resource` del token
  test/  (o src/*.test.ts como hermanos)
```

### 4.1 Modelo de datos (`<dataDir>/server.db`, SQLite)

```sql
users(id TEXT PK, username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,           -- scrypt: salt$N$r$p$hash
      display_name TEXT, disabled INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL);

user_graphs(user_id REFERENCES users(id), graph_id TEXT NOT NULL,
            granted_at TEXT NOT NULL, PRIMARY KEY (user_id, graph_id));

oauth_clients(client_id TEXT PK, metadata_json TEXT NOT NULL,  -- RFC 7591
              created_at TEXT NOT NULL);      -- clientes públicos (PKCE), sin secreto

auth_requests(txn_id TEXT PK, client_id TEXT NOT NULL, params_json TEXT NOT NULL,
              csrf TEXT NOT NULL, expires_at INTEGER NOT NULL);  -- login pendiente, TTL 10 min

auth_codes(code_hash TEXT PK, user_id TEXT NOT NULL, client_id TEXT NOT NULL,
           code_challenge TEXT NOT NULL, redirect_uri TEXT NOT NULL,
           resource TEXT, scopes TEXT NOT NULL,
           expires_at INTEGER NOT NULL, used INTEGER NOT NULL DEFAULT 0);

tokens(token_hash TEXT PK, kind TEXT NOT NULL CHECK (kind IN ('access','refresh')),
       user_id TEXT NOT NULL, client_id TEXT NOT NULL, scopes TEXT NOT NULL,
       resource TEXT, expires_at INTEGER NOT NULL,
       revoked INTEGER NOT NULL DEFAULT 0, parent_hash TEXT,  -- rotación refresh
       created_at TEXT NOT NULL);
```

Notas: contraseñas con `node:crypto` scrypt (N=2^15, r=8, p=1, salt 16B) y
comparación `timingSafeEqual`; tokens = 32 bytes aleatorios base64url, en
disco solo su SHA-256; códigos de autorización un solo uso, TTL 10 min;
mismo esquema de versión que el índice derivado (`PRAGMA user_version`,
recrear tablas de tokens es aceptable, usuarios/grants se migran).

### 4.2 Flujo OAuth (experiencia de usuario)

1. El usuario añade `https://untacit.empresa.com/graphs/acme/mcp` en su
   cliente MCP.
2. El cliente recibe 401 con `WWW-Authenticate: … resource_metadata=…`,
   descubre el AS vía RFC 9728 → RFC 8414, se registra dinámicamente
   (RFC 7591) y lanza el flujo *authorization code + PKCE (S256)*.
3. `GET /authorize` (handler del SDK valida cliente/PKCE/redirect_uri) →
   nuestro `provider.authorize()` crea una `auth_request` y redirige a
   `GET /login?txn=…` → formulario HTML.
4. `POST /login` (rate-limited, CSRF) verifica credenciales → emite código →
   `302` al `redirect_uri` registrado con `code` + `state`.
5. `POST /token` (handler del SDK, valida PKCE) → nuestro
   `exchangeAuthorizationCode` emite access token (TTL 1 h) + refresh token
   (TTL 30 días, rotación). `verifyAccessToken` devuelve
   `AuthInfo { clientId, scopes, expiresAt, resource?, extra: { userId } }`.
6. Cada petición MCP: `requireBearerAuth` → `guards`: usuario activo, grant
   sobre `:graphId`, y si el token lleva `resource` (RFC 8707) debe coincidir
   con la URL canónica del grafo pedido.

Sin pantalla de consentimiento en v1 (login = consentimiento; tools
read-only). Scope único `mcp`. IdP corporativo (OIDC): fuera de v1, hueco
documentado (el interfaz `OAuthServerProvider` lo permite vía
`ProxyOAuthServerProvider` del SDK).

### 4.3 Sesiones Streamable HTTP

- `POST /graphs/:id/mcp` con `initialize` → nuevo
  `StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID,
  onsessioninitialized, onsessionclosed })` + `createServer(graphPath)` de
  `@untacit/mcp`; se guarda en `Map<sessionId, { transport, server, userId,
  graphId, lastSeen }>`.
- Peticiones siguientes (POST/GET/DELETE con header `mcp-session-id`) se
  enrutan a su transporte con `handleRequest(req, res)`; **se rechaza (404)**
  si la sesión pertenece a otro usuario u otro grafo (anti-fixation).
- `GET` abre el stream SSE de notificaciones; `DELETE` termina la sesión
  (el transporte dispara `onsessionclosed` → limpieza del Map).
- Eviction por inactividad (30 min por defecto) + tope de sesiones por
  usuario. Sin `eventStore` en v1 (sin resumabilidad tras reinicio; los
  clientes renegocian sesión de forma transparente).

### 4.4 Configuración

`<dataDir>/untacit-server.config.json` (ruta por `--config` /
`UNTACIT_SERVER_CONFIG`); validación zod con mensajes claros:

```jsonc
{
  "mode": "stateful",                            // "stateful" (Docker) | "stateless" (Vercel), §4.6
  "publicUrl": "https://untacit.empresa.com",   // issuer OAuth + URLs anunciadas
  "host": "0.0.0.0",                             // bind (ignorado en Vercel)
  "port": 8787,
  "graphs": [
    { "id": "acme",      "name": "ACME Manufactura", "path": "/graphs/acme" },
    { "id": "logistica", "name": "Logística",         "path": "/graphs/logistica",
      "tools": "query" }                           // "query" (default) | "agent", §2
  ],
  "auth":    { "accessTokenTtlSeconds": 3600, "refreshTokenTtlSeconds": 2592000 },
  "session": { "idleTimeoutMinutes": 30, "maxSessionsPerUser": 20 },
  "embeddings": { "refresh": "auto" },           // §4.6: refresco incremental tras reindex

  "security": { "allowedHosts": [], "allowedOrigins": [] }  // extra al publicUrl
}
```

Overrides por env (convención `UNTACIT_*`): `UNTACIT_SERVER_CONFIG`,
`UNTACIT_SERVER_DATA_DIR`, `UNTACIT_SERVER_HOST`, `UNTACIT_SERVER_PORT`,
`UNTACIT_SERVER_PUBLIC_URL`; solo modo stateless: `UNTACIT_JWT_SECRET`,
`UNTACIT_USERS`. `graphId` restringido a `[a-z0-9-]{1,64}`
(va en URLs). Arranque falla rápido si un `path` no existe o no es repo git
(warning si falta el índice; se crea en la primera llamada).

### 4.5 CLI de administración (sin UI web en v1)

```
untacit-server serve          --config /data/untacit-server.config.json
untacit-server user add       ana --name "Ana Ruiz" [--password-stdin]
untacit-server user list|disable|enable|set-password
untacit-server grant  ana acme      # acceso de ana al grafo acme
untacit-server revoke ana acme      # + revoca tokens vivos de esa pareja
untacit-server status               # grafos, usuarios, sesiones/tokens activos
```

En Docker: `docker exec untacit untacit-server user add …`.
Para Vercel: `untacit-server user hash ana --graphs acme` imprime la entrada
JSON (hash scrypt incluido) que se pega en la env var `UNTACIT_USERS`.

### 4.6 Modos de ejecución: stateful (Docker) y stateless (Vercel)

El mismo `createHttpApp(config)` sirve para ambos; `config.mode` selecciona
las implementaciones:

- **`mode: "stateful"`** (Docker/systemd): todo lo descrito arriba —
  `server.db`, tokens opacos revocables al instante, sesiones MCP en memoria.
  Además, **el servidor mantiene los embeddings frescos** (prioridad de
  producto): en el arranque y tras cada reindexado por staleness ejecuta
  `GraphIndex.updateEmbeddings(provider)` (incremental por hash de contenido,
  `packages/core/src/indexer/index.ts:670`; no-op si nada cambió) en segundo
  plano y por grafo, serializado para no competir por CPU. Así el cron de la
  empresa es solo `git pull` — sin paso `untacit embed` aparte — y la
  recuperación híbrida nunca se queda atrás del contenido. Configurable con
  `embeddings.refresh: "auto" | "external"` (default `"auto"`).
- **`mode: "stateless"`** (Vercel): ningún estado entre peticiones.
  - **Sesiones MCP**: `sessionIdGenerator: undefined` → el SDK opera sin
    sesión; por cada POST se crea transporte + `McpServer` (barato: registrar
    6 tools) y se cierra al responder. Las tools ya son stateless, no se
    pierde funcionalidad; no hay stream GET de notificaciones (las tools no
    emiten ninguna).
  - **Tokens**: JWT HS256 firmados con `UNTACIT_JWT_SECRET` (access TTL
    corto, 15 min; refresh 30 días). La revocación deja de ser inmediata: al
    refrescar se revalida el usuario contra `UNTACIT_USERS` (usuario
    deshabilitado o sin grant → refresh denegado), así el peor caso de
    acceso tras revocar = TTL del access token. Trade-off documentado.
  - **Códigos de autorización**: JWT de 10 min que embebe `userId`,
    `clientId`, `code_challenge`, `redirect_uri` y `resource`. El un-solo-uso
    estricto no es posible sin almacenamiento; mitigación: TTL corto + PKCE
    (reutilizar el código exige además el `code_verifier`). Endurecimiento
    opcional futuro: Upstash Redis para códigos/rate-limit (v1.1, no v1).
  - **Clientes**: registro dinámico stateless — `client_id` = metadata
    firmada, `getClient` verifica y decodifica. Sin tabla.
  - **Grafo**: pre-indexado en build y abierto **solo lectura**. Requiere un
    cambio pequeño en core (§7): `GraphIndex.openReadonly(repoRoot)` — abre
    better-sqlite3 con `{ readonly: true, fileMustExist: true }` y NO llama a
    `reindexIfStale()` (hoy `open()` siempre sincroniza y fija WAL,
    `packages/core/src/indexer/index.ts:230-237,418-422`). El paso de build
    deja el fichero limpio: `PRAGMA wal_checkpoint(TRUNCATE)` +
    `journal_mode = DELETE`.
  - **Limitación conocida**: `untacit_diff` necesita el binario `git`
    (no existe en las functions) → en stateless responde con un error
    explicativo ("no disponible en despliegue serverless"); las otras 5
    tools funcionan completas. Embeddings: FTS-only por defecto (el modelo
    transformers no cabe en el bundle) o `provider: "hash"`, que sí funciona
    en runtime y habilita el canal semántico aproximado.

## 5. Autorización por grafo

Fuente de verdad: tabla `user_graphs`. El chequeo es **en tiempo de
petición** (no en el scope del token), de modo que revocar un grant corta el
acceso inmediatamente aunque el token siga vivo. El token opcionalmente queda
ligado a un grafo concreto vía `resource` (RFC 8707) si el cliente lo envía —
defensa en profundidad, no sustituto del grant.

## 6. Endpoints HTTP (resumen)

| Ruta | Auth | Quién la implementa |
|---|---|---|
| `POST/GET/DELETE /graphs/:graphId/mcp` | Bearer + grant | nuestra (`http/mcp.ts`) sobre el transporte del SDK |
| `/.well-known/oauth-protected-resource/graphs/:graphId/mcp` | — | nuestra (JSON RFC 9728 por grafo → AS único) |
| `/authorize`, `/token`, `/register`, `/revoke`, `/.well-known/oauth-authorization-server` | — | `mcpAuthRouter` del SDK + nuestro provider |
| `GET/POST /login` | transacción + CSRF + rate limit | nuestra (`oauth/login.ts`) |
| `GET /healthz` | — | nuestra: proceso vivo + `server.db` accesible + grafos legibles |

Middleware de seguridad global (antes de todo): validación de `Host` contra
`publicUrl`+`security.allowedHosts` (anti DNS-rebinding, sustituye las
opciones deprecated del transporte), validación de `Origin` si está presente,
sin CORS por defecto (los clientes MCP no son navegadores; allowlist opcional
en `security.allowedOrigins` para MCP Inspector), `X-Forwarded-*` honrado con
`trust proxy` (documentado para el reverse proxy).

## 7. Cambios en paquetes existentes (mínimos)

- `packages/core`: **un método nuevo, nada más** —
  `GraphIndex.openReadonly(repoRoot)` (§4.6) + helper de checkpoint para el
  build (`checkpointIndex(repoRoot)`). El camino `open()` existente no cambia.
- `packages/mcp`: dos retoques pequeños — `ServeOptions.agentSurface?:
  boolean` (default `true`, hoy `registerAgentSurface` es incondicional en
  `index.ts:305`; el servidor de empresa pasa `false` salvo `tools:
  "agent"`) y un flag para que `untacit_diff` falle con mensaje claro
  cuando no hay git (modo stateless). `serveMcpHttp` (modo local) no se toca.
- `packages/cli`: fuera de alcance (el server tiene su propio bin);
  opcionalmente una nota en la ayuda de `serve-mcp`.
- Raíz: fila nueva en la tabla del README + sección corta "Self-hosted
  server"; CI existente (`pnpm -r build/test`) recoge el paquete solo.
- `.github/workflows/ci.yml`: paso opcional `docker build` (sin push) para
  no romper el Dockerfile silenciosamente.

## 8. Artefactos de despliegue (`deploy/`)

### 8.1 Docker (on-prem)

- **`deploy/Dockerfile`** multi-stage:
  1. `node:22-bookworm-slim` + corepack/pnpm → `pnpm install
     --frozen-lockfile` → `pnpm --filter "@untacit/server..." build` →
     `pnpm --filter @untacit/server deploy --legacy --prod /out` (árbol
     standalone con deps de producción; better-sqlite3 usa prebuilds glibc
     linux x64/arm64 — sin toolchain). El `--legacy` es necesario en pnpm 10
     sin `inject-workspace-packages=true` (si no, `ERR_PNPM_DEPLOY_NONINJECTED_WORKSPACE`).
  2. Runtime `node:22-bookworm-slim` + `git` + `ca-certificates`, usuario no
     root, `WORKDIR /app`, copia de `/out`, `EXPOSE 8787`,
     `HEALTHCHECK` con `node -e "fetch('http://127.0.0.1:<port>/healthz')…"`
     (el puerto se resuelve como en el server: env → config → 8787),
     `ENTRYPOINT ["node", "dist/bin.js"]`, `CMD ["serve", "--config",
     "/data/untacit-server.config.json"]`.
- **`deploy/docker-compose.yml`**: servicio `untacit` (volúmenes
  `./data:/data` y `./graphs:/graphs` — **rw**, ver §2 —, healthcheck,
  `restart: unless-stopped`) + servicio **opcional `caddy`** con TLS
  automático y proxy a `untacit:8787` (perfil `with-tls`).
- **`deploy/config.example.json`**, `deploy/Caddyfile.example`,
  `deploy/Dockerfile.dockerignore` (ignore por-Dockerfile que BuildKit resuelve
  al construir con `-f deploy/Dockerfile`).
- **Embeddings incluidos por defecto** (prioridad de producto): la imagen
  estándar instala `@huggingface/transformers` y **pre-siembra la caché del
  modelo** (`Xenova/multilingual-e5-small`, decenas de MB) en una capa del
  build, de modo que funciona en air-gap y el primer arranque no descarga
  nada. Variante `--build-arg SLIM=true` sin modelo (FTS-only) para quien
  quiera imagen mínima — la excepción, no el default.

### 8.2 Vercel (gestionado, `deploy/vercel/`)

Plantilla que la empresa copia a un repo propio (junto a — o conteniendo —
sus graph-repos) y conecta a Vercel; **cada `git push` del grafo redespliega
con el índice fresco**. Contenido:

- `api/index.ts` — toda la app en una function Node:
  `export default createHttpApp(loadVercelConfig())` (Express es un handler
  `(req, res)` válido para las functions de Vercel; streaming SSE soportado
  por Fluid compute).
- `vercel.json` — `rewrites` de todas las rutas a `api/index`,
  `functions.api/index.ts.maxDuration` (p. ej. 60 s) e `includeFiles` para
  empaquetar `graphs/**` (markdown + `untacit.config.json` + índice
  pre-construido).
- `package.json` con `build`: importar/indexar cada grafo
  (`untacit index --full` + checkpoint §4.6) — el índice viaja en el bundle,
  la function lo abre readonly.
- `config.vercel.example.json` (`mode: "stateless"`, grafos con rutas
  relativas al bundle) y README corto.
- Env vars: `UNTACIT_JWT_SECRET` (obligatoria, 32B aleatorios),
  `UNTACIT_USERS` (JSON generado con `untacit-server user hash`),
  `UNTACIT_SERVER_PUBLIC_URL` (la URL del proyecto). Cambiar
  usuarios/grants = actualizar la env var y redesplegar (instantáneo, sin
  build). Requisito Vercel: functions con runtime **Node** (better-sqlite3 es
  nativo; Edge runtime descartado).

## 9. Plan de tests (vitest, como los hermanos)

**Unit** (`users`, `tokens`, `config`): scrypt round-trip y `verify` con
timing safe; emisión/rotación/revocación y expiración de tokens (solo hashes
en disco); validación de config (ids inválidos, paths inexistentes, env
overrides).

**Integración** (`http/*`): app Express en puerto efímero + grafo fixture
(reutilizar `examples/acme-manufactura` importado a un tmpdir como hacen los
tests del sidecar):

1. **Flujo completo de protocolo**: `StreamableHTTPClientTransport` del SDK
   con `requestInit.headers.Authorization` (token pre-sembrado) → `initialize`
   → `tools/list` → las 6 tools responden sobre el fixture.
2. **Flujo OAuth por HTTP puro**: `/register` → `/authorize` (captura de la
   página de login) → `POST /login` con credenciales sembradas → código →
   `/token` con `code_verifier` correcto e incorrecto (PKCE) → refresh con
   rotación (el refresh viejo queda inválido).
3. **Autorización**: sin token → 401 con `resource_metadata`; token válido
   sin grant → 403; grafo inexistente → 404; usuario deshabilitado → 401.
4. **Aislamiento multi-grafo**: dos grafos, usuario con grant solo en uno;
   sesión creada en `acme` rechazada en `logistica` (404) y por otro usuario.
5. **Ciclo de sesión**: `DELETE` termina y limpia; expiración por inactividad
   (timers falsos).
6. **Guards**: `Host` no permitido → 421/403.
7. **Modo stateless** (misma suite de integración parametrizada por modo):
   flujo completo sin `mcp-session-id`, tokens JWT (verificación, expiración,
   refresh revalidando `UNTACIT_USERS`), códigos JWT con PKCE,
   `clients-signed` round-trip, `GraphIndex.openReadonly` sobre índice
   checkpointeado (y error claro si falta), `untacit_diff` degradado con
   mensaje explicativo.

**Smoke de despliegue** (manual/CI opcional): `docker build` + compose up +
healthcheck verde + tool call con `curl` autenticado; para Vercel,
`vercel build` local de la plantilla (o `vercel dev`) + mismo smoke
(documentado en la guía).

## 10. Guía de despliegue — `docs/07-guia-despliegue-autoalojado.md` (esquema)

1. **Qué vas a desplegar** (diagrama, requisitos: Docker, dominio, TLS).
2. **Inicio rápido (15 min)**: clonar `deploy/`, `config.json`, `docker
   compose up -d`, crear el primer usuario, conectar Claude y primera consulta.
3. **Preparar los grafos**: clonar graph-repos en `./graphs/<id>`, indexado
   inicial, cron/CI de `git pull` (el servidor reindexa solo).
4. **Referencia de configuración** (tabla campo a campo + env vars).
5. **Gestión de usuarios y permisos** (CLI completa, altas/bajas/grants).
6. **Conectar clientes**: Claude (Settings → Connectors), Claude Code
   (`claude mcp add --transport http acme https://…/graphs/acme/mcp`),
   Cursor; qué verá el usuario (pantalla de login).
7. **TLS y reverse proxy**: Caddy del compose; snippet nginx equivalente;
   `publicUrl`/`trust proxy`.
7bis. **Despliegue en Vercel (alternativa gestionada, v1.1)**: copiar la
   plantilla, conectar el repo, env vars, alta de usuarios con
   `user hash`, actualización del grafo por `git push`, límites del modo
   (revocación por TTL, `untacit_diff` no disponible, **recuperación
   degradada a FTS/hash — sin el modelo semántico**).
8. **Backups y recuperación**: qué es canónico (graph-repos git + `server.db`)
   y qué es regenerable (`.untacit/`).
9. **Embeddings / air-gap**: la imagen estándar trae el modelo pre-sembrado
   y el servidor refresca embeddings solo — cómo verificar que el canal
   semántico está activo; variante SLIM (FTS-only) y `provider: "hash"`
   como excepciones.
10. **Endurecimiento**: checklist §12, rotación de credenciales, límites.
11. **Actualizaciones** del servidor (pull imagen nueva; índice se regenera
    si cambia el esquema).
12. **Solución de problemas**: 401/403 típicos, login no abre, sesión
    caducada, reloj/timezone, logs.

Más: README raíz (sección + fila en la tabla del monorepo) y
`packages/server/README.md` (desarrollo local del paquete).

## 11. Pasos de implementación (los commits de la Fase 7, docs/04)

| # | Entrega | Contenido | Riesgo |
|---|---|---|---|
| 1 | Esqueleto + almacén | `packages/server` (package/tsconfig), `config.ts`, `db.ts`, `users/`, CLI `user/grant/revoke/status` + tests unit | bajo |
| 2 | OAuth core | `oauth/{provider,clients-db,tokens-opaque}.ts`, `mcpAuthRouter` montado, tests de emisión/PKCE/rotación | **alto** — es la pieza delicada; validar contra `mcp-inspector` |
| 3 | Login | `oauth/{login,pages}.ts` (form, CSRF, rate limit) + test de flujo OAuth completo por HTTP | medio |
| 4 | Endpoint MCP + embeddings frescos | `http/{app,mcp,guards}.ts`: sesiones, grants, metadata RFC 9728, healthz, refresco incremental de embeddings (§4.6) + integración con cliente SDK, las 6 tools y test de refresco tras cambio en disco | medio |
| 5 | Docker | `deploy/Dockerfile` **con modelo pre-sembrado** (variante SLIM opcional), compose, Caddyfile + smoke manual (incl. búsqueda híbrida) + paso CI `docker build` | medio (pnpm deploy + native deps + capa modelo) |
| 6 | Docs | `docs/07-guia…`, README raíz, README del paquete | bajo |
| — | *v1.1 (opcional)* Modo stateless | `tokens-jwt`, `clients-signed`, `users/env`, `GraphIndex.openReadonly` en core, suite parametrizada por modo | medio |
| — | *v1.1 (opcional)* Plantilla Vercel | `deploy/vercel/*` + smoke `vercel build`/`vercel dev` | medio (empaquetado `includeFiles` + native deps) |

La v1 termina en el paso 6: **Docker con recuperación híbrida completa es el
producto**. Los dos pasos v1.1 quedan diseñados (§4.6, §8.2) pero no bloquean
el cierre de la Fase 7 — se abordan solo si la opción gestionada sigue
interesando con la v1 en producción, asumiendo su recuperación degradada
(FTS/hash).

Validación final end-to-end antes de cerrar: instancia en Docker con el
dataset `examples/acme-manufactura`, conexión real desde Claude Code
(`--transport http`) pasando por el login y ejecutando `untacit_context`
**en modo híbrido con el modelo local de la imagen** (verificar que el canal
semántico está activo, no en fallback FTS).

## 12. Checklist de seguridad (revisión previa a merge)

- [ ] PKCE S256 obligatorio (sin `skipLocalPkceValidation`); código un solo
      uso y TTL 10 min; `redirect_uri` con coincidencia exacta contra lo
      registrado (sin open redirect).
- [ ] Tokens opacos aleatorios (CSPRNG), solo hashes en disco, rotación de
      refresh con invalidación del anterior; revocación de grant/usuario
      revoca tokens vivos.
- [ ] scrypt con parámetros actuales + `timingSafeEqual`; rate limit en
      `/login` y `/register`; sin enumeración de usuarios (mismo error).
- [ ] CSRF por transacción en el form de login; sin cookies de sesión web
      (la "sesión" es la transacción OAuth con TTL).
- [ ] `mcp-session-id` = UUID aleatorio, ligado a usuario+grafo (anti
      fixation/hijack); eviction por inactividad y tope por usuario.
- [ ] Validación de `Host`/`Origin` (anti DNS-rebinding) en middleware
      propio; bind configurable; guía exige TLS delante.
- [ ] El servidor jamás escribe fuera de `<dataDir>` y `<grafo>/.untacit/`;
      no ejecuta git de escritura; tools read-only.
- [ ] Sin telemetría ni llamadas salientes (principio del proyecto,
      docs/03 §8); logs a stdout sin secretos ni contraseñas.
- [ ] Errores homogéneos: 401 (token), 403 (grant), 404 (grafo/sesión ajena
      — sin filtrar existencia).
- [ ] Modo stateless: `UNTACIT_JWT_SECRET` ≥ 32 bytes aleatorios (rechazar
      valores débiles al arrancar), access TTL ≤ 15 min, refresh revalida
      usuario+grant, JWT con `aud`/`iss` fijados al `publicUrl`, algoritmo
      HS256 fijado (rechazar `alg` distinto), documentar que rotar el secreto
      invalida todos los tokens (procedimiento de emergencia).

## 13. Riesgos y alternativas descartadas

- **Hono en vez de Express**: descartado para este paquete — el framework de
  auth del SDK (`mcpAuthRouter`, `requireBearerAuth`) es Express; replicarlo
  en Hono es reimplementar OAuth a mano. El sidecar de la app sigue en Hono,
  no se toca.
- **Tokens JWT en Docker**: descartado — con disco persistente, los tokens
  opacos + tabla dan revocación inmediata sin gestión de claves. JWT queda
  reservado al modo stateless (Vercel), donde es la única opción razonable;
  el trade-off (revocación con latencia = TTL del access token, códigos sin
  un-solo-uso estricto mitigado por PKCE, rate-limit por instancia) está
  aceptado y documentado en §4.6.
- **`mcp-handler` (paquete oficial de Vercel)**: descartado — envuelve su
  propia versión del SDK y su propio `McpServer`, chocando con nuestro
  `createServer` y duplicando versiones; el SDK 1.29 ya soporta stateless
  directamente y Express corre como function sin adaptador.
- **Multi-tenant multi-empresa en una instancia**: fuera de alcance — el
  modelo es una instancia por empresa; los grants separan grafos dentro de
  la empresa.
- **Resumabilidad SSE (`eventStore`)**: pospuesta; los clientes renegocian
  sesión sin pérdida funcional (tools stateless).
- **Riesgo principal**: interoperabilidad del flujo OAuth con clientes
  reales (Claude/Cursor implementan el discovery de forma ligeramente
  distinta). Mitigación: probar con `@modelcontextprotocol/inspector` y
  Claude Code desde la fase 2, no al final.
