/**
 * persistent-memory-api — Fastify app assembly (Phase 3).
 *
 * Layout:
 *   • Zod compilers (validator + serializer) installed app-wide.
 *   • A central error handler maps AuthError→401, ForbiddenError→403, Zod
 *     validation→400, everything else→500. The token is redacted from logs and
 *     never appears in any error body.
 *   • /health is registered at the top level (NO auth).
 *   • All authenticated routes live in an ENCAPSULATED plugin scope whose
 *     onRequest hook is `authenticate` — so /health stays open while everything
 *     in the scope is gated and runs inside the ALS tenant context.
 *
 * Deny-by-default: there is no default-allow path. A route is public only if it
 * is registered OUTSIDE the secured scope (health/config/login/internal usage).
 */
import Fastify, { type FastifyInstance } from 'fastify'
import fastifyMultipart from '@fastify/multipart'
import {
  serializerCompiler,
  validatorCompiler,
  hasZodFastifySchemaValidationErrors,
} from 'fastify-type-provider-zod'
import { AuthError, ForbiddenError, ValidationError, PiiDetectedError } from './authz/errors.ts'
import { ConflictError, NotFoundError } from './routes/dashboard/shared.ts'
import { GraphitiError } from './clients/graphiti.ts'
import { LlmProviderError } from './protocol/llm/client.ts'
import { EmbeddingProviderError } from './services/embedding-health.ts'
import { authenticate, authenticateLocal, enterTenantScope } from './auth/authenticate.ts'
import { config } from './config.ts'
import { healthRoutes } from './routes/health.ts'
import { configRoutes } from './routes/config.ts'
import { internalUsageRoutes } from './routes/internal/usage.ts'
import { whoamiRoutes } from './routes/whoami.ts'
import { profileRoutes } from './routes/profile.ts'
import { localAuthRoutes } from './routes/local-auth.ts'
import { dashboardAuthRoutes } from './routes/dashboard-auth.ts'
import { ingestRoutes } from './routes/ingest.ts'
import { memoryRoutes } from './routes/memories.ts'
import { graphRoutes } from './routes/graph.ts'
import { memoryGraphRoutes } from './routes/memory-graph.ts'
import { documentRoutes } from './routes/documents.ts'
import { investigationRoutes } from './routes/investigations.ts'
import { projectRoutes } from './routes/projects.ts'
import { projectMemoryBindingRoutes } from './routes/project-memory-bindings.ts'
import { mcpSessionRoutes } from './routes/mcp-sessions.ts'
import { connectRoutes } from './routes/connect.ts'
import { embeddingHealthRoutes } from './routes/embedding-health.ts'
import { dashboardRoutes } from './routes/dashboard/index.ts'

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      // Redact the token so it never lands in logs even if headers are logged.
      redact: ['req.headers.authorization', 'headers.authorization'],
    },
  })

  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof AuthError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message })
    }
    if (err instanceof ForbiddenError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message })
    }
    // P7 Shape-gate SEMANTIC failure → 422. MUST come BEFORE the Zod branch so
    // it isn't swallowed as a generic 400: the MCP needs to distinguish
    // "malformed JSON" (400) from "failed the Shape gate, here are the templates"
    // (422). The whole actionable payload IS the body.
    if (err instanceof ValidationError) {
      return reply.code(err.statusCode).send(err.payload)
    }
    // P8 DLP/PII gate → 422 with a redaction-safe findings payload. Distinct
    // `error: 'pii_detected'` so the MCP tells it apart from the Shape gate.
    if (err instanceof PiiDetectedError) {
      return reply.code(err.statusCode).send(err.payload)
    }
    // P9 control-plane domain errors. NotFound (404) + Conflict (409) — e.g.
    // unknown team/user, duplicate team name, team_not_empty, last_superuser.
    if (err instanceof NotFoundError || err instanceof ConflictError) {
      return reply.code(err.statusCode).send({ error: err.code, message: err.message })
    }
    // Graphiti backend failure on a /graph/* proxy read → 502 (not our bug).
    if (err instanceof GraphitiError) {
      return reply.code(502).send({ error: err.code, message: err.message })
    }
    // Shape-gate extraction provider failures are transient provider issues, not
    // memory API 500s. The MCP needs the exact code so it can tell the agent to
    // retry without implying the local stack is down.
    if (err instanceof LlmProviderError) {
      req.log.warn(
        err.toLogFields(),
        'fact extraction provider failed',
      )
      return reply.code(503).send({
        error: err.code,
        message: err.message,
        provider: err.provider,
        model: err.model,
        retryable: err.retryable,
      })
    }
    if (err instanceof EmbeddingProviderError) {
      req.log.warn(err.toLogFields(), 'embedding provider failed')
      return reply.code(err.statusCode).send({
        error: err.code,
        message: err.message,
        provider: err.provider,
        model: err.model,
        retryable: err.retryable,
      })
    }
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply
        .code(400)
        .send({ error: 'validation_error', issues: err.validation })
    }
    req.log.error({ err }, 'unhandled error') // err logged; token is redacted above
    return reply
      .code(500)
      .send({ error: 'internal_error', message: 'Internal Server Error' })
  })

  // Public surface — no auth. /config is public like /health: the MCP needs the
  // effective embedding mode/pin at startup, before it has authenticated, and the
  // values (model id, dim, named-vector key, mode) leak nothing sensitive.
  void app.register(healthRoutes)
  void app.register(configRoutes)
  void app.register(dashboardAuthRoutes)
  // Internal usage ingest — outside the secured scope (no user token); its own
  // shared-secret gate (USAGE_INGEST_TOKEN). graphiti-service POSTs here.
  void app.register(internalUsageRoutes)

  // Local-dashboard password gate (P1) — public, no identity, and ONLY in local mode.
  // It backs the dashboard app's OPTIONAL login (a UI soft lock); it does NOT gate the
  // local API/MCP (those stay no-auth by design). Never registered in server mode.
  if (config.DEPLOYMENT_MODE === 'local') {
    void app.register(localAuthRoutes)
  }

  // Auth hook chosen ONCE at boot (not per-request): server → token-verifying
  // `authenticate`; local (DEPLOYMENT_MODE=local) → `authenticateLocal` which reads
  // the DB-backed local super-user with no token. enterTenantScope is unchanged.
  const authHook = config.DEPLOYMENT_MODE === 'local' ? authenticateLocal : authenticate

  // Secured surface — encapsulated scope; the auth hook runs first, enters the
  // ALS tenant context, then route-level guards (requireWrite/...) run.
  void app.register(async (secured) => {
    secured.addHook('onRequest', authHook)
    // SYNC hook: enters the ALS tenant scope from req.identity with no preceding
    // await, so the store survives to the handlers (the async authenticate hook
    // cannot do this post-await — confirmed Fastify+Node gotcha).
    secured.addHook('onRequest', enterTenantScope)
    // Multipart for POST /ingest — stream-only (NO attachFieldsToBody, which would
    // buffer the whole file into memory). Registered INSIDE the secured scope so
    // the upload surface is gated. One file per request, capped at the env limit.
    await secured.register(fastifyMultipart, {
      limits: { files: 1, fileSize: config.INGEST_MAX_FILE_BYTES },
    })
    await secured.register(whoamiRoutes)
    // P1 — self-service profile (displayName/email/password).
    await secured.register(profileRoutes)
    await secured.register(ingestRoutes)
    // P7 — the memory protocol layer + graph proxy + documents/investigations.
    await secured.register(memoryRoutes)
    await secured.register(graphRoutes)
    await secured.register(memoryGraphRoutes)
    await secured.register(documentRoutes)
    await secured.register(investigationRoutes)
    // P8 — distinct projects across the readable corpus (backs list_projects).
    await secured.register(projectRoutes)
    await secured.register(projectMemoryBindingRoutes)
    // Non-admin connector portal: authenticated users can mint a local-dashboard
    // connector token without entering the server operator dashboard.
    await secured.register(connectRoutes)
    // Client-managed embedding bridges report only a canonical outcome here; the
    // route derives their observer scope from the authenticated identity.
    await secured.register(embeddingHealthRoutes)
    // MCP runtime session heartbeat (stream clients plus legacy client rows).
    await secured.register(mcpSessionRoutes)
  })

  // CONTROL plane (P9) — a SEPARATE encapsulated scope, registered AFTER the
  // data-secured scope. It reuses the same authenticate + enterTenantScope hooks
  // (to derive req.identity); dashboardRoutes then applies requireAdmin to the inner
  // CONTROL surface, while the operational READS (Services list/logs + Usage) are
  // viewable by any authenticated user (the Services mutation keeps requireSuperuser).
  // Handlers use ownerPrisma exclusively — they never open the tenant tx, so
  // admin_level grants ZERO data access (control ≠ data).
  void app.register(async (dashboard) => {
    dashboard.addHook('onRequest', authHook)
    dashboard.addHook('onRequest', enterTenantScope)
    await dashboard.register(dashboardRoutes)
  })

  return app
}
