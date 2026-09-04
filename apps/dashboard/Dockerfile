# syntax=docker/dockerfile:1
# -----------------------------------------------------------------------------
# persistent-memory-dashboard — Next.js 15 standalone, multi-stage.
#
# Build context = the repository root (set in deploy/compose/docker-compose.yml)
# so the standalone dashboard can import pure helpers from layers/dashboard while
# still using its own package.json/package-lock.json. The dashboard app is
# SELF-CONTAINED: NO @pm/* deps, NO database, NO prisma generate, NO argon2
# native build — it talks to persistent-memory-api ONLY over HTTP.
#
# next.config.ts sets output: 'standalone'. The runner copies .next/standalone +
# .next/static + public and runs `node server.js`. HOSTNAME=0.0.0.0 so the
# standalone server binds outside the container; host maps 3200:3000.
#
# NEXT_PUBLIC_API_URL is inlined at `next build` (browser, host port) and is
# largely vestigial here (the browser never calls the api directly — the token
# stays server-side). API_URL is RUNTIME-only (compose network) and is read by
# the server-side api client. Do NOT bake API_URL at build time.
# -----------------------------------------------------------------------------

# ── deps ──────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /app/apps/dashboard
COPY apps/dashboard/package.json apps/dashboard/package-lock.json* ./
RUN npm config set fetch-retries 5 >/dev/null \
 && npm config set fetch-retry-factor 2 >/dev/null \
 && npm config set fetch-retry-mintimeout 20000 >/dev/null \
 && npm config set fetch-retry-maxtimeout 120000 >/dev/null \
 && npm config set fetch-timeout 300000 >/dev/null \
 && for i in 1 2 3 4; do \
      if npm ci; then exit 0; fi; \
      status="$?"; \
      if [ "$i" = "4" ]; then echo "npm ci failed after 4 attempts." >&2; exit "$status"; fi; \
      delay=$((5 * i)); \
      echo "npm ci failed with exit ${status}; retrying in ${delay}s (${i}/4)..." >&2; \
      npm cache clean --force >/dev/null 2>&1 || true; \
      sleep "$delay"; \
    done

# ── builder ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app
COPY --from=deps /app/apps/dashboard/node_modules ./apps/dashboard/node_modules
COPY apps/dashboard ./apps/dashboard
COPY layers/dashboard ./layers/dashboard
WORKDIR /app/apps/dashboard
ARG NEXT_PUBLIC_API_URL=http://localhost:8090
ENV NEXT_PUBLIC_API_URL=$NEXT_PUBLIC_API_URL
# DEPLOYMENT_MODE must be present AT BUILD TIME — Next inlines process.env
# into the Edge-runtime middleware bundle at `next build`, so a runtime-only env
# would not reach middleware. The onboard full-local flow passes this build arg
# (compose build.args); switching modes = a rebuild (correct, it's a deploy decision).
ARG DEPLOYMENT_MODE=server
ENV DEPLOYMENT_MODE=$DEPLOYMENT_MODE
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ── runner ──────────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV DASHBOARD_GUIDE_ROOT=/app/documentation
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs

# The standalone output does NOT include public/ or .next/static — copy both.
COPY --from=builder /app/apps/dashboard/public ./public
COPY --from=builder --chown=nextjs:nodejs /app/apps/dashboard/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/dashboard/.next/static ./.next/static
COPY documentation/spaces /app/documentation/spaces
COPY documentation/assets/spaces /app/documentation/assets/spaces

USER nextjs
EXPOSE 3000
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
CMD ["node", "server.js"]
