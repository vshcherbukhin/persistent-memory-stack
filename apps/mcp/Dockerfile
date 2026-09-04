# syntax=docker/dockerfile:1
# =============================================================================
# persistent-memory-mcp — TS MCP server.
#
# Used by the shared Streamable HTTP Compose service (`mcp-stream` profile).
# Legacy command-based wrappers are retained only for upgrade cleanup and smoke
# workflows; new persistent-memory registration uses the stream service.
#
# BUILD CONTEXT = the persistent-memory/ directory. That is ALSO the npm-workspace
# root, so the context contains the root package.json + package-lock.json +
# packages/shared/ + apps/mcp/.
#
# WORKSPACE: the MCP depends on @pm/shared (the Ollama embedder for the client-managed
# bridge) — and NOTHING else from the monorepo (it is Prisma-free; all DB access
# is over the HTTP API). @pm/shared is consumed as a BUILT PACKAGE via its
# `exports` map. `tsc -b apps/mcp/tsconfig.json` is reference-aware: it builds
# ../../packages/shared then mcp in order, and rewrites the relative `.ts` import specifiers
# to `.js` so the dist is runnable Node ESM.
#
#   node:22-alpine = Maintenance LTS (matches the api/worker images).
#
# Diagnostics go to stderr so JSON-RPC/HTTP framing stays clean.
# The Compose stream service provides its own healthcheck in deploy/compose/docker-compose.yml.
#
# Stages: deps (workspace install) → shared-build → build (mcp) → deps-prod (prune) → runtime.
# deps-prod reuses the deps stage and prunes locally instead of running a second
# networked `npm ci --omit=dev`; fresh installs may build several Node images at
# once, and duplicate registry downloads have caused transient OpenSSL GCM errors.
# =============================================================================

# ── Stage 1: workspace install (root lockfile) ───────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY layers/mcp-runtime/package.json ./layers/mcp-runtime/
COPY apps/mcp/package.json ./apps/mcp/
COPY deploy/scripts/npm-ci-with-retry.sh /usr/local/bin/npm-ci-with-retry
RUN chmod +x /usr/local/bin/npm-ci-with-retry
RUN --mount=type=cache,target=/root/.npm npm-ci-with-retry

# ── Stage 2: build @pm/shared as a consumable workspace package ──────────────
# A clean image has no shared dist/*.d.ts for the @pm/shared exports map yet.
# Build it separately before TypeScript resolves MCP/runtime's bare package imports.
FROM node:22-alpine AS shared-build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY tsconfig.base.json ./
COPY packages/shared/ ./packages/shared/
RUN rm -f packages/shared/tsconfig.tsbuildinfo
RUN node /app/node_modules/typescript/bin/tsc -p packages/shared/tsconfig.json

# ── Stage 3: build the MCP ───────────────────────────────────────────────────
# npm hoists every mcp dependency (typescript, @modelcontextprotocol/sdk, zod, …)
# to the ROOT node_modules — there is NO per-member /app/apps/mcp/node_modules to carry
# forward, so the root copy on the line below is all the build stage needs.
FROM node:22-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY --from=shared-build /app/packages/shared ./packages/shared
COPY layers/mcp-runtime/ ./layers/mcp-runtime/
COPY apps/mcp/tsconfig.json ./apps/mcp/
COPY apps/mcp/package.json ./apps/mcp/
COPY apps/mcp/src ./apps/mcp/src
RUN rm -f layers/mcp-runtime/tsconfig.tsbuildinfo
# tsc -b builds the remaining mcp-runtime and MCP references.
RUN node /app/node_modules/typescript/bin/tsc -b apps/mcp/tsconfig.json

# ── Stage 4: prune to production deps ─────────────────────────────────────────
FROM node:22-alpine AS deps-prod
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json ./packages/shared/
COPY layers/mcp-runtime/package.json ./layers/mcp-runtime/
COPY apps/mcp/package.json ./apps/mcp/
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --omit=dev && npm cache clean --force

# ── Stage 5: runtime — slim, non-root, stdio ──────────────────────────────────
FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Prod deps at the workspace ROOT so @pm/shared resolves via the hoisted symlink.
COPY --from=deps-prod /app/node_modules ./node_modules
# The built libs (their dist + package.json). The workspace symlink
# node_modules/@pm/shared -> ../../packages/shared (created by npm ci) points here.
COPY --from=build /app/packages/shared/dist ./packages/shared/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/layers/mcp-runtime/dist ./layers/mcp-runtime/dist
COPY --from=build /app/layers/mcp-runtime/package.json ./layers/mcp-runtime/package.json
# The compiled MCP tree: apps/mcp/dist/** (entry apps/mcp/dist/index.js).
COPY --from=build /app/apps/mcp/dist ./apps/mcp/dist
COPY --from=build /app/apps/mcp/package.json ./apps/mcp/package.json
USER node
# stdio server. NO EXPOSE, NO HEALTHCHECK — all logs go to stderr.
CMD ["node", "apps/mcp/dist/index.js"]
