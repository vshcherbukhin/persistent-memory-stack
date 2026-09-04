# syntax=docker/dockerfile:1
# =============================================================================
# persistent-memory-worker — workspace-aware multi-stage TS/Node build (Phase 6).
#
# BUILD CONTEXT = the persistent-memory/ directory (NOT apps/worker/), set in
# deploy/compose/docker-compose.yml as `build: { context: ., dockerfile: apps/worker/Dockerfile }`.
# This is the npm-workspace root: it contains the root package.json +
# package-lock.json + packages/shared/ + packages/db/ + layers/graph/ + layers/evidence-files/ + layers/security-dlp/ + apps/worker/ + layers/core/schema/.
#
# The worker depends on @pm/shared (queue + embeddings + qdrant + storage +
# extract), @pm/db (the Prisma clients + runInTenant), and @pm/graph (Graphiti
# episode helpers), @pm/evidence-files (chunk persistence helpers), and
# @pm/security-dlp (fail-closed DLP gate). These
# are consumed as
# BUILT PACKAGES via their `exports` maps. `tsc -b apps/worker/tsconfig.json` is
# reference-aware: it builds ../../packages/shared then ../../packages/db then
# ../../layers/graph then ../../layers/evidence-files then
# ../../layers/security-dlp then worker. @pm/db's build
# needs the generated Prisma client, so `prisma generate` runs FIRST.
#
# No host port — long-lived BullMQ consumer; compose restart: unless-stopped.
# Entry = dist/index.js (worker uses rootDir:"src", clean emit).
#
# Stages: deps → shared-build → build (prisma + db + worker) → runtime.
# Runtime reuses the deps stage and prunes locally instead of running a second
# networked `npm ci --omit=dev`; fresh installs may build several Node images at
# once, and duplicate registry downloads have caused transient OpenSSL GCM errors.
# =============================================================================

# ── Stage 1: workspace install (root lockfile) ───────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY layers/graph/package.json ./layers/graph/
COPY layers/evidence-files/package.json ./layers/evidence-files/
COPY layers/security-dlp/package.json ./layers/security-dlp/
COPY apps/worker/package.json ./apps/worker/
COPY layers/core/schema/package.json ./layers/core/schema/
COPY deploy/scripts/npm-ci-with-retry.sh /usr/local/bin/npm-ci-with-retry
RUN chmod +x /usr/local/bin/npm-ci-with-retry
RUN --mount=type=cache,target=/root/.npm npm-ci-with-retry
# npm fully dedupes/hoists workspace deps into the ROOT node_modules, so a
# workspace may end up with NO own node_modules dir. The build stage COPYs
# apps/worker/ + layers/core/schema/ node_modules unconditionally — guarantee they exist (empty is
# fine; deps resolve from the hoisted root node_modules COPY'd alongside).
RUN mkdir -p apps/worker/node_modules layers/core/schema/node_modules

# ── Stage 2: build @pm/shared (composite library) ────────────────────────────
FROM node:22-alpine AS shared-build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
RUN rm -f packages/shared/tsconfig.tsbuildinfo
RUN node /app/node_modules/typescript/bin/tsc -p packages/shared/tsconfig.json

# ── Stage 3: build — generate the Prisma client, then compile @pm/db + worker ─
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# npm version-nests bullmq/ioredis/zod/dotenv under apps/worker/, and the prisma CLI
# under layers/core/schema/ — carry both forward or tsc -b fails TS2307.
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /app/layers/core/schema/node_modules ./layers/core/schema/node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/db/package.json ./packages/db/
COPY layers/graph/package.json ./layers/graph/
COPY layers/evidence-files/package.json ./layers/evidence-files/
COPY layers/security-dlp/package.json ./layers/security-dlp/
COPY layers/core/schema/package.json ./layers/core/schema/
# The already-built shared package (dist + symlink target).
COPY --from=shared-build /app/packages/shared ./packages/shared
# Generate the Prisma client (@pm/db's build input) + the ESM marker.
COPY layers/core/schema/ ./layers/core/schema/
RUN npm exec --workspace persistent-memory-prisma -- prisma generate
RUN echo '{"type":"module"}' > /app/generated/package.json
# Compile @pm/db + @pm/graph + @pm/evidence-files + @pm/security-dlp + the
# worker. tsc -b walks the references (../../packages/shared, ../../packages/db,
# ../../layers/graph, ../../layers/evidence-files, ../../layers/security-dlp).
COPY packages/db/tsconfig.json ./packages/db/
COPY packages/db/src ./packages/db/src
COPY layers/graph/tsconfig.json ./layers/graph/
COPY layers/graph/src ./layers/graph/src
COPY layers/evidence-files/tsconfig.json ./layers/evidence-files/
COPY layers/evidence-files/src ./layers/evidence-files/src
COPY layers/security-dlp/tsconfig.json ./layers/security-dlp/
COPY layers/security-dlp/src ./layers/security-dlp/src
COPY apps/worker/tsconfig.json ./apps/worker/
COPY apps/worker/src ./apps/worker/src
RUN node /app/node_modules/typescript/bin/tsc -b apps/worker/tsconfig.json

# ── Stage 4: runtime — prod deps + the self-contained dist trees ──────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY layers/graph/package.json ./layers/graph/
COPY layers/evidence-files/package.json ./layers/evidence-files/
COPY layers/security-dlp/package.json ./layers/security-dlp/
COPY apps/worker/package.json ./apps/worker/
COPY layers/core/schema/package.json ./layers/core/schema/
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=deps /app/layers/core/schema/node_modules ./layers/core/schema/node_modules
RUN npm prune --omit=dev && npm cache clean --force
# Built libs (the workspace symlinks node_modules/@pm/shared -> ../../packages/shared and
# @pm/db -> ../../packages/db point here). @pm/db's dist carries the generated Prisma client
# inside packages/db/dist/generated/** — no separate generated/ copy.
COPY --from=shared-build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/layers/graph/dist ./layers/graph/dist
COPY --from=build /app/layers/evidence-files/dist ./layers/evidence-files/dist
COPY --from=build /app/layers/security-dlp/dist ./layers/security-dlp/dist
COPY --from=build /app/apps/worker/dist ./apps/worker/dist
WORKDIR /app/apps/worker
# No EXPOSE — the worker has no HTTP surface. Heartbeat key in Redis backs the
# compose healthcheck.
CMD ["node", "dist/index.js"]
