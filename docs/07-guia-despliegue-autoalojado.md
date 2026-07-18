# 07 — Guía de despliegue del servidor autoalojado

> Guía operativa del servidor MCP Streamable HTTP de empresa
> (`@untacit/server`, diseño en [`06-servidor-http-autoalojado.md`](06-servidor-http-autoalojado.md)).
> Una instancia por empresa, N grafos por instancia, usuarios locales con
> login OAuth 2.1 desde cualquier cliente MCP (Claude, Claude Code, Cursor).

## 1. Qué vas a desplegar

```
   usuarios (Claude / Claude Code / Cursor)
        │  https + login en el navegador
        ▼
 ┌──────────────────────────── tu servidor ────────────────────────────┐
 │  Caddy/nginx (TLS)  ──▶  untacit-server (contenedor Docker)        │
 │                           /graphs/<id>/mcp   ← Streamable HTTP      │
 │                           /authorize /token /login /healthz         │
 │   volúmenes:  ./data  (config + server.db)                          │
 │               ./graphs/<id>  (clones git de tus graph-repos)        │
 │   actualización: cron de `git pull` en ./graphs/*                   │
 └──────────────────────────────────────────────────────────────────────┘
```

Requisitos: Docker (o un host con Node 22 + git), un dominio apuntando al
servidor y TLS delante (el compose trae Caddy opcional que lo automatiza).

La imagen estándar incluye el modelo local de embeddings
(`Xenova/multilingual-e5-small`) **pre-sembrado**: la recuperación híbrida
(léxica + semántica) funciona sin acceso a internet y sin configurar nada.

## 2. Inicio rápido (~15 minutos)

```bash
# 1. Clona el repo y construye la imagen
git clone https://github.com/rflvz/code-graph untacit && cd untacit
docker build -f deploy/Dockerfile -t untacit-server .

# 2. Prepara el directorio de despliegue
cd deploy
mkdir -p data graphs
cp config.example.json data/untacit-server.config.json
#    → edita publicUrl y la lista de grafos

# 3. Trae tus grafos (clones git; ver §3)
git clone git@git.empresa.com:conocimiento/grafo-acme.git graphs/acme

# 3b. El contenedor corre como uid 1000 (usuario `node`): dale la propiedad de
#     los volúmenes para que pueda escribir server.db y <grafo>/.untacit.
#     Hazlo DESPUÉS del clon para cubrir también el .untacit que se creará.
sudo chown -R 1000:1000 data graphs

# 4. Arranca (TLS con Caddy: añade --profile with-tls y copia Caddyfile.example)
UNTACIT_SERVER_PUBLIC_URL=https://untacit.empresa.com docker compose up -d
curl -s http://127.0.0.1:8787/healthz   # → {"status":"ok",...}

# 5. Crea el primer usuario y dale acceso
docker compose exec untacit untacit-server user add ana --name "Ana Ruiz"
docker compose exec untacit untacit-server grant ana acme

# 6. Conecta un cliente (ver §6) y haz la primera consulta
claude mcp add --transport http acme https://untacit.empresa.com/graphs/acme/mcp
```

Al conectar, el cliente abre `https://untacit.empresa.com/login` en el
navegador; el usuario entra con su usuario/contraseña y el cliente queda
autorizado (authorization code + PKCE, tokens rotados automáticamente).

## 3. Preparar los grafos

Cada grafo es un **clon git** del graph-repo (el formato canónico de
markdown + `untacit.config.json` que producen `untacit init/import`):

- Clónalo en `./graphs/<graphId>` — el `<graphId>` es el de la config y el
  de la URL (`[a-z0-9-]{1,64}`).
- El índice derivado (`.untacit/index.db`) se construye solo en el primer
  uso; si quieres evitar esa primera espera, ejecútalo tú:
  `docker compose exec untacit node -e "..."` o `untacit index` desde
  cualquier checkout con la CLI.
- **Actualización**: el servidor nunca escribe los ficheros canónicos ni hace
  `git pull`. Prográmalo fuera (cron, CI):

  ```cron
  */10 * * * * cd /srv/untacit/graphs/acme && git pull --ff-only
  ```

  Tras un pull, la siguiente consulta reindexa incrementalmente y el propio
  servidor refresca los embeddings en segundo plano
  (`embeddings.refresh: "auto"`). No hay que reiniciar nada.

## 4. Referencia de configuración

`data/untacit-server.config.json` (validada al arranque; el servidor falla
rápido con el motivo exacto):

| Campo | Default | Notas |
|---|---|---|
| `mode` | `"stateful"` | `"stateless"` (Vercel) es diseño v1.1, aún no incluido |
| `publicUrl` | — | URL pública (issuer OAuth). https obligatorio salvo loopback |
| `host` / `port` | `0.0.0.0` / `8787` | bind del proceso |
| `graphs[].id` | — | `[a-z0-9-]{1,64}`, único; va en la URL |
| `graphs[].name` | = id | nombre humano (aparece en la metadata y el login) |
| `graphs[].path` | — | ruta del clon (absoluta o relativa a la config); debe ser repo git |
| `graphs[].tools` | `"query"` | `"agent"` añade las tools de extracción/entrevista — solo si montaste sus fuentes |
| `auth.accessTokenTtlSeconds` | `3600` | access tokens opacos, revocables al instante |
| `auth.refreshTokenTtlSeconds` | `2592000` | refresh con rotación y detección de reuso |
| `session.idleTimeoutMinutes` | `30` | eviction de sesiones MCP inactivas |
| `session.maxSessionsPerUser` | `20` | al superarlo se desaloja la más antigua |
| `embeddings.refresh` | `"auto"` | `"external"` si prefieres tu propio `untacit embed` |
| `security.allowedHosts` | `[]` | hosts extra admitidos además del de `publicUrl` |
| `security.allowedOrigins` | `[]` | orígenes de navegador permitidos (p. ej. MCP Inspector) |
| `security.trustProxy` | `false` | detrás de Caddy/nginx ponlo a `true` (= confiar en **un** salto); un número = nº de saltos. Nunca confía en todos los saltos: eso permitiría falsear la IP y saltarse el rate limit del login |

Overrides por entorno: `UNTACIT_SERVER_CONFIG`, `UNTACIT_SERVER_DATA_DIR`,
`UNTACIT_SERVER_HOST`, `UNTACIT_SERVER_PORT`, `UNTACIT_SERVER_PUBLIC_URL`.

## 5. Usuarios y permisos

Sin IdP externo en v1: usuarios locales (scrypt en `server.db`) y permisos
usuario→grafo. Todo por CLI, en caliente:

```bash
untacit-server user add ana --name "Ana Ruiz"   # pide contraseña (o --password-stdin)
untacit-server user list
untacit-server user set-password ana
untacit-server user disable ana                 # además revoca sus tokens vivos
untacit-server user enable ana
untacit-server grant ana acme
untacit-server revoke ana acme                  # corta el acceso al instante
untacit-server status                           # grafos, usuarios, tokens vivos
```

En Docker, antepón `docker compose exec untacit`. El grant se comprueba en
**cada petición**: revocar no espera a que caduque ningún token.

## 6. Conectar clientes

La URL de cada grafo es `https://<dominio>/graphs/<graphId>/mcp`.

- **Claude Code**:
  `claude mcp add --transport http acme https://untacit.empresa.com/graphs/acme/mcp`
- **Claude (web/desktop)**: Settings → Connectors → Add custom connector →
  esa URL.
- **Cursor y otros**: transporte "streamable HTTP" con la misma URL.

Qué verá el usuario: su cliente detecta que hace falta autorización (401 →
discovery RFC 9728/8414 → registro dinámico RFC 7591), abre la página de
login de la instancia en el navegador, y tras iniciar sesión vuelve al
cliente ya conectado. Las seis tools de consulta (`untacit_context`,
`explore`, `impact`, `evidence`, `diff`, `conflicts`) quedan disponibles.

## 7. TLS y reverse proxy

- **Caddy (incluido)**: `cp Caddyfile.example Caddyfile`, pon tu dominio y
  arranca con `--profile with-tls`. Certificados automáticos.
- **nginx equivalente**:

  ```nginx
  server {
    listen 443 ssl http2;
    server_name untacit.empresa.com;
    location / {
      proxy_pass http://127.0.0.1:8787;
      proxy_set_header Host $host;
      proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
      proxy_set_header X-Forwarded-Proto $scheme;
      proxy_buffering off;   # SSE
    }
  }
  ```

- En ambos casos: `publicUrl` = la URL pública y
  `security.trustProxy: true`. El guard de `Host` rechaza con 421 cualquier
  petición que no llegue con el host público (anti DNS-rebinding); si
  accedes también por otro nombre interno, añádelo a
  `security.allowedHosts`.

## 7bis. Despliegue en Vercel (v1.1, aún no disponible)

El modo stateless (tokens JWT, usuarios en env var, índice pre-construido
solo lectura, sin `untacit_diff` y **recuperación degradada a FTS/hash, sin
el modelo semántico**) está diseñado en 06 §4.6 y §8.2 pero no incluido en
v1. El core ya expone lo que necesita (`GraphIndex.openReadonly`,
`checkpointIndex`).

## 8. Backups y recuperación

- **Canónico** (haz backup): los graph-repos (ya viven en tu git) y
  `data/server.db` (usuarios, grants, clientes OAuth, tokens).
- **Regenerable** (no hace falta): `graphs/*/.untacit/` — índice y
  embeddings se reconstruyen solos.
- Restaurar = volver a clonar grafos + restaurar `server.db` + `docker
  compose up`.

## 9. Embeddings y air-gap

La imagen estándar trae el modelo pre-sembrado y el servidor mantiene los
vectores frescos (al arrancar y tras cada cambio detectado). Para verificar
que el canal semántico está activo:

```bash
docker compose logs untacit | grep "embeddings refreshed"
#  [untacit-server] graph "acme": embeddings refreshed (+150/-0, provider transformers:Xenova/multilingual-e5-small)
```

Si en su lugar no aparece nada y el grafo tiene `embeddings.provider:
"auto"`, el modelo no está disponible (¿imagen SLIM?) y `untacit_context`
sigue funcionando **solo léxico** — útil, pero no es el despliegue
recomendado. Excepciones deliberadas: `--build-arg SLIM=true` (imagen mínima
sin modelo) y `provider: "hash"` en el `untacit.config.json` del grafo
(determinista, para demos offline).

## 10. Endurecimiento

Antes de exponerlo, repasa la checklist de seguridad de
[06 §12](06-servidor-http-autoalojado.md#12-checklist-de-seguridad-revisión-previa-a-merge).
Resumen operativo:

- TLS siempre delante; `publicUrl` https; `trustProxy` solo si hay proxy.
- El servidor no escribe fuera de `/data` y `graphs/*/.untacit/`; las tools
  son read-only y el write-gate no existe en este despliegue.
- Sin telemetría ni llamadas salientes; logs a stdout sin secretos.
- Rotación de credenciales: `user set-password` + `user disable` revocan
  tokens vivos; borra usuarios que se van.
- Rate limit ya activo en `/login`, `/token`, `/register` y `/authorize`.

## 11. Actualizaciones

```bash
git pull && docker build -f deploy/Dockerfile -t untacit-server . \
  && docker compose up -d
```

`server.db` y los índices derivados llevan versión de esquema
(`PRAGMA user_version`): el índice se regenera solo si cambia; una versión
de `server.db` más nueva que el binario se rechaza con mensaje claro.

## 12. Solución de problemas

| Síntoma | Causa típica | Arreglo |
|---|---|---|
| `401 invalid_token` constante | token caducado y el cliente no refresca | reconecta el servidor MCP en el cliente (re-login) |
| `403 access_denied` | falta el grant | `untacit-server grant <user> <graphId>` |
| `403 invalid_resource` | token ligado a otro grafo (RFC 8707) | reconecta apuntando al grafo correcto |
| `404` en `/graphs/x/mcp` | id no está en la config | revisa `graphs[].id` |
| `421 misdirected_request` | Host ≠ `publicUrl` | accede por el dominio público o añade el host a `allowedHosts` |
| el login no abre | `publicUrl` mal puesta (el cliente descubre el AS por ella) | corrígela y reinicia |
| `Sign-in link expired` | transacción de login de >10 min | vuelve a conectar desde el cliente |
| sesión caducada (404 en tool calls) | inactividad > `idleTimeoutMinutes` | el cliente renegocia solo; sube el timeout si molesta |
| reloj desviado | TTLs de tokens/códigos dependen de la hora | NTP en el host |
| logs | — | `docker compose logs -f untacit` (stdout, sin secretos) |
