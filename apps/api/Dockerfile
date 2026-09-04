# syntax=docker/dockerfile:1
# =============================================================================
# persistent-memory-api — multi-stage TS/Node build (Phase 3, workspace P5, P6).
#
# BUILD CONTEXT = the persistent-memory/ directory (NOT apps/api/), set in
# deploy/compose/docker-compose.yml as `build: { context: ., dockerfile: apps/api/Dockerfile }`.
# This is ALSO the npm-workspace root, so the context contains the root
# package.json + package-lock.json + packages/shared/ + packages/db/ + layers/memory-vector/ + layers/graph/ + layers/evidence-files/ + layers/security-dlp/ + layers/core/schema/ + apps/api/.
#
# WORKSPACE (P6): the api depends on @pm/shared (embeddings + Qdrant + storage +
# queue + extract), @pm/db (the two Prisma clients + runInTenant), and
# @pm/memory-vector (topology + rerank helpers), and @pm/graph (Graphiti client
# + graph sync helpers), @pm/evidence-files (storage singleton), and
# @pm/security-dlp (fail-closed DLP gate). These are
# consumed as BUILT PACKAGES via their `exports` maps (NOT path-aliases into their
# src — that revives the api's TS6059/ESM-emit traps). `tsc -b apps/api/tsconfig.json`
# is reference-aware: it builds ../../packages/shared then ../../packages/db then
# ../../layers/memory-vector, ../../layers/graph, ../../layers/evidence-files,
# ../../layers/security-dlp, then api in order. @pm/db's
# build needs the generated Prisma client, so `prisma generate` must run FIRST.
#
# The generated Prisma client (../generated/prisma) is OWNED by @pm/db now — it
# travels INSIDE packages/db/dist/generated/** after db's no-rootDir emit, so the runtime
# stage needs only packages/db/dist (no separate generated/ copy). The api's own dist is a
# clean dist/** tree (rootDir:"src"); entry = dist/server.js.
#
#   node:22-alpine = Maintenance LTS (security-supported to 2027-04-30).
#
# Stages: deps (workspace install) → shared-build → build (prisma + db + api) → runtime.
# Runtime reuses the deps stage and prunes locally instead of running a second
# networked `npm ci --omit=dev`; fresh installs may build several Node images at
# once, and duplicate registry downloads have caused transient OpenSSL GCM errors.
# =============================================================================

# ── Stage 1: workspace install (root lockfile) ───────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
# Root manifest + lockfile + each member's manifest, then a deterministic install.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY layers/memory-vector/package.json ./layers/memory-vector/
COPY layers/graph/package.json ./layers/graph/
COPY layers/evidence-files/package.json ./layers/evidence-files/
COPY layers/security-dlp/package.json ./layers/security-dlp/
COPY apps/api/package.json ./apps/api/
COPY layers/core/schema/package.json ./layers/core/schema/
COPY deploy/scripts/npm-ci-with-retry.sh /usr/local/bin/npm-ci-with-retry
RUN chmod +x /usr/local/bin/npm-ci-with-retry
RUN --mount=type=cache,target=/root/.npm npm-ci-with-retry

# ── Stage 2: build @pm/shared (composite library) ────────────────────────────
# NOTE: npm does NOT fully hoist this workspace — it keeps per-member
# node_modules (apps/api/node_modules, layers/core/schema/node_modules) alongside the root one
# (version-driven nesting). So every stage must carry the node_modules it needs
# from BOTH the root AND the relevant member dir.
FROM node:22-alpine AS shared-build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
RUN rm -f packages/shared/tsconfig.tsbuildinfo
RUN node /app/node_modules/typescript/bin/tsc -p packages/shared/tsconfig.json

# ── Stage 3: build — generate the Prisma client, then compile @pm/db + the api ─
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
# Carry member node_modules forward (npm keeps fastify/zod/@fastify-multipart/
# bullmq/argon2 nested under apps/api/, and the prisma CLI nested under layers/core/schema/).
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/layers/core/schema/node_modules ./layers/core/schema/node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/api/package.json ./apps/api/
COPY packages/db/package.json ./packages/db/
COPY layers/memory-vector/package.json ./layers/memory-vector/
COPY layers/graph/package.json ./layers/graph/
COPY layers/evidence-files/package.json ./layers/evidence-files/
COPY layers/security-dlp/package.json ./layers/security-dlp/
COPY layers/core/schema/package.json ./layers/core/schema/
# Bring in the already-built shared package (dist + the symlink target).
COPY --from=shared-build /app/packages/shared ./packages/shared
# Prisma schema + config. Generate the client to /app/generated/prisma (matching
# `output = ../../../generated/prisma`, resolved from /app/layers/core/schema). Schema-only.
COPY layers/core/schema/ ./layers/core/schema/
RUN npm exec --workspace persistent-memory-prisma -- prisma generate
# The generated client is ESM source with no governing package.json → mark its
# dir as a module package so tsc emits ESM for it (else broken CommonJS).
RUN echo '{"type":"module"}' > /app/generated/package.json
# Compile @pm/db + @pm/memory-vector + @pm/graph + @pm/evidence-files +
# @pm/security-dlp + the api. `tsc -b apps/api/tsconfig.json` walks the references
# (../../packages/shared already built, ../../packages/db,
# ../../layers/memory-vector, ../../layers/graph, ../../layers/evidence-files,
# and ../../layers/security-dlp built here) and rewrites the relative `.ts`
# import specifiers to `.js`; the bare `@pm/shared` / `@pm/db` specifiers resolve
# through their package.json exports. db emits to packages/db/dist/packages/db/src + packages/db/dist/generated;
# api emits to apps/api/dist/** (entry dist/server.js).
COPY packages/db/tsconfig.json ./packages/db/
COPY packages/db/src ./packages/db/src
COPY layers/memory-vector/tsconfig.json ./layers/memory-vector/
COPY layers/memory-vector/src ./layers/memory-vector/src
COPY layers/graph/tsconfig.json ./layers/graph/
COPY layers/graph/src ./layers/graph/src
COPY layers/evidence-files/tsconfig.json ./layers/evidence-files/
COPY layers/evidence-files/src ./layers/evidence-files/src
COPY layers/security-dlp/tsconfig.json ./layers/security-dlp/
COPY layers/security-dlp/src ./layers/security-dlp/src
COPY apps/api/tsconfig.json ./apps/api/
COPY apps/api/src ./apps/api/src
RUN node /app/node_modules/typescript/bin/tsc -b apps/api/tsconfig.json

# ── Stage 4: runtime — prod deps + the self-contained dist trees ──────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Prod-only deps at the workspace ROOT so @pm/shared + @pm/db are present as
# hoisted symlinks and argon2's prebuilt alpine binding is installed.
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/db/package.json ./packages/db/
COPY layers/memory-vector/package.json ./layers/memory-vector/
COPY layers/graph/package.json ./layers/graph/
COPY layers/evidence-files/package.json ./layers/evidence-files/
COPY layers/security-dlp/package.json ./layers/security-dlp/
COPY apps/api/package.json ./apps/api/
COPY layers/core/schema/package.json ./layers/core/schema/
# Carry the already-downloaded install tree forward, then prune dev deps without
# hitting the registry again. Keep member node_modules because npm may version-nest
# production deps under apps/api/ and the prisma workspace.
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/api/node_modules ./apps/api/node_modules
COPY --from=deps /app/layers/core/schema/node_modules ./layers/core/schema/node_modules
RUN npm prune --omit=dev && npm cache clean --force
# The built libs (their dist + package.json). The workspace symlinks
# node_modules/@pm/shared -> ../../packages/shared and @pm/db -> ../../packages/db (created by npm ci)
# point here. @pm/db's dist carries the generated Prisma client INSIDE
# packages/db/dist/generated/** (its no-rootDir emit), so no separate generated/ copy.
COPY --from=shared-build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/db/dist ./packages/db/dist
COPY --from=build /app/layers/memory-vector/dist ./layers/memory-vector/dist
COPY --from=build /app/layers/graph/dist ./layers/graph/dist
COPY --from=build /app/layers/evidence-files/dist ./layers/evidence-files/dist
COPY --from=build /app/layers/security-dlp/dist ./layers/security-dlp/dist
# The compiled api tree: apps/api/dist/** (entry dist/server.js). @pm/shared + @pm/db
# resolve via the root node_modules symlinks → packages/shared/dist + packages/db/dist/packages/db/src.
COPY --from=build /app/apps/api/dist ./apps/api/dist
# Runtime prompts (Shape-gate fact-extraction + graph-extraction) are loaded at
# boot by apps/api/src/protocol/prompt.ts from /app/prompts/*.md — they MUST ship in
# the image (build context is the repo root, so prompts/ is available here).
COPY prompts/ ./prompts/
WORKDIR /app/apps/api
EXPOSE 8090
# server.js binds 0.0.0.0:API_PORT (default 8090).
CMD ["node", "dist/server.js"]
