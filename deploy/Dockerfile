# syntax=docker/dockerfile:1
# untacit-server image (docs/06 §8.1). Build from the repo root:
#
#   docker build -f deploy/Dockerfile -t untacit-server .
#   docker build -f deploy/Dockerfile -t untacit-server:slim --build-arg SLIM=true .
#
# The standard image ships the local embedding model pre-seeded (hybrid
# retrieval works air-gapped, nothing downloads at runtime). The SLIM
# variant drops transformers.js + model (lexical retrieval only) — the
# exception, not the default (docs/06: embeddings are the product priority).

ARG NODE_VERSION=22

# ---------------------------------------------------------------- build ----
FROM node:${NODE_VERSION}-bookworm-slim AS build
RUN corepack enable
WORKDIR /src
COPY . .
ARG SLIM=false
RUN pnpm install --frozen-lockfile
# transformers.js goes into the image, not into the repo: the runtime model
# provider resolves it with a dynamic import (packages/core). onnxruntime-node
# needs its postinstall to fetch the native binaries, hence --allow-build.
RUN if [ "$SLIM" != "true" ]; then \
      pnpm --filter @untacit/server add --allow-build=onnxruntime-node "@huggingface/transformers@^3"; \
    fi
RUN pnpm --filter "@untacit/server..." build
RUN pnpm --filter @untacit/server deploy --legacy --prod /out
# Pre-seed the model cache. transformers.js caches inside its own package dir
# (env.cacheDir default), so the weights ride along with the /out copy below.
# We also run one real inference here — not just load the pipeline — so the
# full runtime path (onnxruntime kernels + their shared libs) is validated at
# BUILD time. Otherwise a broken inference only surfaces as a silent crash of
# the server's startup embedding refresher, never in the always-captured build
# logs.
RUN if [ "$SLIM" != "true" ]; then \
      cd /out && node --input-type=module -e "\
        const { pipeline } = await import('@huggingface/transformers'); \
        const extractor = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small'); \
        const out = await extractor(['warmup'], { pooling: 'mean', normalize: true }); \
        console.log('model cache pre-seeded + inference OK, dims', JSON.stringify(out.dims));"; \
    fi

# -------------------------------------------------------------- runtime ----
FROM node:${NODE_VERSION}-bookworm-slim
# git: graph repos are live clones (external `git pull` + untacit_diff).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 # Mounted graph volumes belong to a host user; without this, git refuses
 # to read them ("dubious ownership") and untacit_diff breaks.
 && git config --system safe.directory '*'
WORKDIR /app
COPY --from=build --chown=node:node /out /app
# The admin CLI of the guide (`docker exec … untacit-server user add`).
RUN chmod +x /app/dist/bin.js && ln -s /app/dist/bin.js /usr/local/bin/untacit-server
ENV NODE_ENV=production UNTACIT_SERVER_CONFIG=/data/untacit-server.config.json
USER node
EXPOSE 8787
# Resolve the probe port exactly as the server does (config.ts): env override
# wins, else the config file's `port`, else 8787 — otherwise a custom `port` in
# the config would leave the healthcheck probing the wrong port.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "const fs=require('fs'); let cp=8787; try { cp=JSON.parse(fs.readFileSync(process.env.UNTACIT_SERVER_CONFIG,'utf8')).port || 8787; } catch {} const p=process.env.UNTACIT_SERVER_PORT || cp; fetch('http://127.0.0.1:'+p+'/healthz').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["node", "dist/bin.js"]
CMD ["serve", "--config", "/data/untacit-server.config.json"]
