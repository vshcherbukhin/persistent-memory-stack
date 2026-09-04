/**
 * /dashboard/settings — System Settings: embedding topology (server-managed/client-managed embeddings) + the pinned
 * model/dim (Phase 9). GET = requireAdmin; PUT = requireSuperuser (the second
 * superuser-only op besides admin_level assignment, per plan P9).
 *
 * Reads/writes the SystemSettings singleton via ownerPrisma (control table, no
 * RLS). The wire enum is `server | client-bridge`; the DB enum uses
 * `client_bridge` (no hyphen) — mapped here via wireModeToDb / dbModeToWire.
 *
 * VALIDATION: the (model, dim) pair is validated against the embedding registry
 * before persisting, so an invalid pin is a 422, never a poisoned singleton.
 *
 * LIVE-SAFETY: flipping server-managed/client-managed topology with the SAME model/dim is data-safe (decision
 * 11) — persist freely; GET /config picks it up and the MCP re-reads on startup.
 * Changing the MODEL/DIM is NOT live-safe: services/embedding.ts derives the
 * embedder + activePin as boot consts, and existing Qdrant vectors live under the
 * old named-vector key. The response sets modelChanged + a warning; the UI must
 * surface "this triggers a re-embed migration" and the operator must run the
 * Qdrant switch tool + restart the api/worker. This phase does NOT hot-swap.
 */
import type { FastifyInstance } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { z } from 'zod/v4'
import { ownerPrisma, Prisma } from '@pm/db'
import { validateModelDim, MODEL_REGISTRY, makeEmbedderForPin } from '@pm/shared'
import type { ProviderName } from '@pm/shared'
import { requireSuperuser } from '../../authz/guards.ts'
import { ValidationError } from '../../authz/errors.ts'
import { getEffectiveSettings, type EffectiveSettings } from '../../services/settings.ts'
import { wireModeToDb } from '../../services/embedding-topology.ts'
import { embeddingMode as bootEmbeddingMode, applyActivePin } from '../../services/embedding.ts'
import { EmbeddingDimensionMismatchError, EmbeddingProviderError, withEmbeddingHealth } from '../../services/embedding-health.ts'
import { getDashboardCapabilityHealth } from '../../services/dashboard-capability-health.ts'
import { runModelSwitch, isSwitchRunning, resumableFailedSwitch } from '../../services/model-switch.ts'
import {
  FACT_EXTRACTION_MODELS,
  providerForFactExtractionModel,
  testFactExtractionSettings,
} from '../../services/fact-extraction.ts'
import { DashboardCapabilityHealthSchema, SafeModelDependencyHealthSchema } from './capability-health.ts'

const SINGLETON_ID = 'singleton'

/** Phase 10 embedding-model-switch status (SystemSettings.embeddingSwitch). */
const SwitchPins = z.object({ model: z.string(), dim: z.number().int().positive() })
const SwitchStatusSchema = z
  .object({
    state: z.enum(['running', 'done', 'failed']),
    from: SwitchPins,
    to: SwitchPins,
    migrated: z.number().int(),
    startedAt: z.string(),
    finishedAt: z.string().optional(),
    error: z.string().optional(),
  })
  .nullable()

const SettingsOut = z.object({
  embeddingTopology: z.enum(['server-managed-embeddings', 'client-managed-embeddings']),
  /** Deprecated compatibility alias. Prefer embeddingTopology. */
  embeddingMode: z.enum(['server', 'client-bridge']),
  activeEmbedModel: z.string(),
  activeEmbedDim: z.number().int().positive(),
  activeVectorName: z.string(),
  persisted: z.boolean(),
  updatedAt: z.date().nullable(),
  mcpSessionIdleTimeoutSeconds: z.number().int().min(0),
  // Phase 10 (#5): live model-switch status (null = idle).
  embeddingSwitch: SwitchStatusSchema,
  factExtraction: z.object({
    provider: z.enum(['anthropic', 'openai']),
    model: z.string(),
    apiKeyMasked: z.string().nullable(),
    apiKeySource: z.enum(['settings', 'env', 'missing']),
    availableModels: z.array(z.object({
      value: z.string(),
      label: z.string(),
      provider: z.enum(['anthropic', 'openai']),
    })),
    keys: z.object({
      anthropic: z.object({
        hasKey: z.boolean(),
        source: z.enum(['settings', 'env', 'missing']),
        masked: z.string().nullable(),
      }),
      openai: z.object({
        hasKey: z.boolean(),
        source: z.enum(['settings', 'env', 'missing']),
        masked: z.string().nullable(),
      }),
    }),
  }),
  dashboardLoginMode: z.enum(['password', 'sso']),
  capabilityHealth: DashboardCapabilityHealthSchema,
})

/** Map the effective settings → the wire response (one place; used by all routes). */
async function toSettingsOut(s: EffectiveSettings, userId: string): Promise<z.infer<typeof SettingsOut>> {
  return {
    embeddingTopology: s.embeddingTopology,
    embeddingMode: s.embeddingMode,
    activeEmbedModel: s.activeEmbedModel,
    activeEmbedDim: s.activeEmbedDim,
    activeVectorName: s.activeVectorName,
    persisted: s.persisted,
    updatedAt: s.updatedAt,
    mcpSessionIdleTimeoutSeconds: s.mcpSessionIdleTimeoutSeconds,
    embeddingSwitch: (s.embeddingSwitch ?? null) as z.infer<typeof SwitchStatusSchema>,
    factExtraction: s.factExtraction,
    dashboardLoginMode: s.dashboardLoginMode,
    capabilityHealth: await getDashboardCapabilityHealth(s, userId),
  }
}

const TestResult = z.object({
  ok: z.boolean(),
  provider: z.enum(['anthropic', 'openai']).optional(),
  model: z.string(),
  message: z.string(),
  details: z.string().optional(),
  outcome: z.enum(['accept', 'restructure', 'reject']).optional(),
  reason: z.string().optional(),
  health: SafeModelDependencyHealthSchema.optional(),
})

async function testEmbedding(model: string, dim: number): Promise<z.infer<typeof TestResult>> {
  try {
    const spec = MODEL_REGISTRY[model]
    if (!spec) {
      return {
        ok: false,
        model,
        message: `Unknown embedding model "${model}".`,
        details: `Known models: ${Object.keys(MODEL_REGISTRY).join(', ')}.`,
      }
    }
    validateModelDim(spec.provider as ProviderName, model, dim)
    if (bootEmbeddingMode !== 'server') {
      return {
        ok: false,
        model,
        message: 'Server-side embedding is disabled in client-bridge mode.',
        details: 'Test embeddings from the MCP/client bridge, or switch the install topology to server mode.',
      }
    }
    const probe = '[component_embedding_probe] persistent-memory embedding settings probe'
    const embedder = makeEmbedderForPin(model, dim)
    await withEmbeddingHealth(
      { observerScope: 'server', provider: embedder.provider, model: embedder.model },
      async () => {
        const result = await embedder.embed([probe], 'query')
        const actualDim = result.vectors[0]?.length ?? 0
        if (actualDim !== dim) throw new EmbeddingDimensionMismatchError(actualDim, dim)
        return result
      },
    )
    return { ok: true, model, message: `Embedding test passed with ${model} @ ${dim}.` }
  } catch (err) {
    return {
      ok: false,
      model,
      message: err instanceof EmbeddingProviderError ? err.message : 'Embedding test failed.',
      details: err instanceof EmbeddingProviderError
        ? undefined
        : 'The provider could not complete the test. Check its configuration and try again.',
    }
  }
}

export async function dashboardSettingsRoutes(app: FastifyInstance): Promise<void> {
  const z4 = app.withTypeProvider<ZodTypeProvider>()

  z4.get(
    '/settings',
    { schema: { response: { 200: SettingsOut } } },
    async (req) => toSettingsOut(await getEffectiveSettings(), req.identity!.userId),
  )

  // ── PUT /dashboard/settings/retention — the memory-retention knobs (superuser) ───
  // Separate from the model-pin PUT (which validates the embedding registry) so a
  // retention tweak doesn't require re-submitting the pin. Creates the singleton
  // with the current effective pin if it doesn't exist yet.
  z4.put(
    '/settings/dashboard-login',
    {
      preHandler: [requireSuperuser],
      schema: {
        body: z.object({ mode: z.enum(['password', 'sso']) }).strict(),
        response: { 200: SettingsOut },
      },
    },
    async (req) => {
      const eff = await getEffectiveSettings()
      await ownerPrisma.systemSettings.upsert({
        where: { id: SINGLETON_ID },
        update: {
          dashboardLoginMode: req.body.mode,
          updatedById: req.identity!.userId,
        },
        create: {
          id: SINGLETON_ID,
          embeddingMode: wireModeToDb(eff.embeddingMode),
          activeEmbedModel: eff.activeEmbedModel,
          activeEmbedDim: eff.activeEmbedDim,
          dashboardLoginMode: req.body.mode,
          updatedById: req.identity!.userId,
        },
      })
      return toSettingsOut(await getEffectiveSettings(), req.identity!.userId)
    },
  )

  z4.put(
    '/settings/mcp-session-timeout',
    {
      preHandler: [requireSuperuser],
      schema: {
        body: z
          .object({
            mcpSessionIdleTimeoutSeconds: z.number().int().min(60).max(86_400),
          })
          .strict(),
        response: { 200: SettingsOut },
      },
    },
    async (req) => {
      const eff = await getEffectiveSettings()
      await ownerPrisma.systemSettings.upsert({
        where: { id: SINGLETON_ID },
        update: {
          mcpSessionIdleTimeoutSeconds: req.body.mcpSessionIdleTimeoutSeconds,
          updatedById: req.identity!.userId,
        },
        create: {
          id: SINGLETON_ID,
          embeddingMode: wireModeToDb(eff.embeddingMode),
          activeEmbedModel: eff.activeEmbedModel,
          activeEmbedDim: eff.activeEmbedDim,
          mcpSessionIdleTimeoutSeconds: req.body.mcpSessionIdleTimeoutSeconds,
          updatedById: req.identity!.userId,
        },
      })
      return toSettingsOut(await getEffectiveSettings(), req.identity!.userId)
    },
  )

  z4.post(
    '/settings/embedding/test',
    {
      preHandler: [requireSuperuser],
      schema: {
        body: z
          .object({
            activeEmbedModel: z.string().min(1),
            activeEmbedDim: z.number().int().positive(),
          })
          .strict(),
        response: { 200: TestResult },
      },
    },
    async (req) => {
      const [result, settings] = await Promise.all([
        testEmbedding(req.body.activeEmbedModel, req.body.activeEmbedDim),
        getEffectiveSettings(),
      ])
      const health = await getDashboardCapabilityHealth(settings, req.identity!.userId)
      return { ...result, health: health.embeddings }
    },
  )

  z4.post(
    '/settings/fact-extraction/test',
    {
      preHandler: [requireSuperuser],
      schema: {
        body: z
          .object({
            model: z.string().min(1),
            apiKey: z.string().optional(),
          })
          .strict(),
        response: { 200: TestResult.required({ provider: true }) },
      },
    },
    async (req) => {
      const [result, settings] = await Promise.all([
        testFactExtractionSettings(req.body),
        getEffectiveSettings(),
      ])
      const health = await getDashboardCapabilityHealth(settings, req.identity!.userId)
      return { ...result, health: health.factExtraction }
    },
  )

  z4.put(
    '/settings/fact-extraction',
    {
      preHandler: [requireSuperuser],
      schema: {
        body: z
          .object({
            model: z.string().min(1),
            apiKey: z.string().optional(),
          })
          .strict(),
        response: { 200: SettingsOut },
      },
    },
    async (req) => {
      const model = req.body.model.trim()
      const provider = providerForFactExtractionModel(model)
      if (!provider) {
        throw new ValidationError({
          error: 'validation_failed',
          reason: `Unknown fact extraction model "${model}".`,
          missing: [],
          rewrite_templates: {},
          entity_format: null,
          valid_categories: [],
          valid_sources: [],
          your_submission: {
            content_excerpt: model,
            content_length: model.length,
            metadata_received: { model },
          },
          suggestion: `Known models: ${FACT_EXTRACTION_MODELS.map((m) => m.value).join(', ')}.`,
        })
      }
      const eff = await getEffectiveSettings()
      const apiKey = req.body.apiKey?.trim()
      await ownerPrisma.systemSettings.upsert({
        where: { id: SINGLETON_ID },
        update: {
          factExtractionProvider: provider,
          factExtractionModel: model,
          ...(apiKey
            ? provider === 'anthropic'
              ? { factExtractionAnthropicApiKey: apiKey }
              : { factExtractionOpenaiApiKey: apiKey }
            : {}),
          updatedById: req.identity!.userId,
        },
        create: {
          id: SINGLETON_ID,
          embeddingMode: wireModeToDb(eff.embeddingMode),
          activeEmbedModel: eff.activeEmbedModel,
          activeEmbedDim: eff.activeEmbedDim,
          factExtractionProvider: provider,
          factExtractionModel: model,
          ...(apiKey
            ? provider === 'anthropic'
              ? { factExtractionAnthropicApiKey: apiKey }
              : { factExtractionOpenaiApiKey: apiKey }
            : {}),
          updatedById: req.identity!.userId,
        },
      })
      return toSettingsOut(await getEffectiveSettings(), req.identity!.userId)
    },
  )

  z4.put(
    '/settings',
    {
      preHandler: [requireSuperuser],
      schema: {
        body: z
          .object({
            embeddingMode: z.enum(['server', 'client-bridge']),
            activeEmbedModel: z.string().min(1),
            activeEmbedDim: z.number().int().positive(),
          })
          .strict(),
        response: {
          200: SettingsOut.extend({
            modelChanged: z.boolean(),
            /** Phase 10: true when a live server-managed re-embed migration was kicked off. */
            switchStarted: z.boolean().optional(),
            warning: z.string().optional(),
          }),
          409: z.object({ error: z.string(), message: z.string() }),
        },
      },
    },
    async (req, reply) => {
      const { embeddingMode, activeEmbedModel, activeEmbedDim } = req.body

      // Validate the (provider, model, dim) triple via the registry before
      // persisting — a bad pin is a Shape-style 422, not a poisoned singleton.
      const spec = MODEL_REGISTRY[activeEmbedModel]
      if (!spec) {
        throw new ValidationError({
          error: 'validation_failed',
          reason: `Unknown embedding model "${activeEmbedModel}".`,
          missing: [],
          rewrite_templates: {},
          entity_format: null,
          valid_categories: [],
          valid_sources: [],
          your_submission: {
            content_excerpt: activeEmbedModel,
            content_length: activeEmbedModel.length,
            metadata_received: { activeEmbedModel, activeEmbedDim },
          },
          suggestion: `Known models: ${Object.keys(MODEL_REGISTRY).join(', ')}.`,
        })
      }
      try {
        validateModelDim(spec.provider as ProviderName, activeEmbedModel, activeEmbedDim)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Invalid (model, dim).'
        throw new ValidationError({
          error: 'validation_failed',
          reason: message,
          missing: [],
          rewrite_templates: {},
          entity_format: null,
          valid_categories: [],
          valid_sources: [],
          your_submission: {
            content_excerpt: `${activeEmbedModel} @ ${activeEmbedDim}`,
            content_length: activeEmbedModel.length,
            metadata_received: { activeEmbedModel, activeEmbedDim },
          },
        })
      }

      // Detect a model/dim change vs the currently EFFECTIVE pin — that is the
      // non-live-safe case requiring a re-embed.
      const before = await getEffectiveSettings()
      const modelChanged =
        before.activeEmbedModel !== activeEmbedModel || before.activeEmbedDim !== activeEmbedDim
      const dbMode = wireModeToDb(embeddingMode)

      // A concurrent delete can leave an otherwise-safe switch failed after its
      // pin flip but before the final reconciliation/drop. Saving the unchanged
      // target pin explicitly resumes that idempotent work; it never switches to
      // a different model/dimension behind the operator's back.
      const resumeFrom = resumableFailedSwitch(before.embeddingSwitch, { model: activeEmbedModel, dim: activeEmbedDim })
      if (!modelChanged && resumeFrom && embeddingMode === 'server' && bootEmbeddingMode === 'server') {
        const startedAt = new Date().toISOString()
        const to = { model: activeEmbedModel, dim: activeEmbedDim }
        const runningStatus = { state: 'running', from: resumeFrom, to, migrated: 0, startedAt }
        await ownerPrisma.systemSettings.update({
          where: { id: SINGLETON_ID },
          data: { embeddingMode: dbMode, embeddingSwitch: runningStatus as unknown as Prisma.InputJsonValue, updatedById: req.identity!.userId },
        })
        void runModelSwitch(resumeFrom, to, startedAt)
        return {
          ...(await toSettingsOut(await getEffectiveSettings(), req.identity!.userId)),
          modelChanged: false,
          switchStarted: true,
          warning: `Resuming the final reconciliation for ${to.model}@${to.dim}; search remains on the active pin.`,
        }
      }

      // ── Branch A — live server-side switch (the "done right" path) ────────────
      // Only when the model/dim actually changes AND both the requested mode AND
      // the running process are server-managed embeddings (the server must own the embedder to
      // re-embed). The switch runs in the background; search stays on the old pin
      // until the flip, then this api updates its live pin in-process (no restart).
      if (modelChanged && embeddingMode === 'server' && bootEmbeddingMode === 'server') {
        if (isSwitchRunning(before.embeddingSwitch)) {
          return reply.code(409).send({
            error: 'switch_in_progress',
            message: 'A model switch is already running. Wait for it to finish (watch System Settings).',
          })
        }
        const startedAt = new Date().toISOString()
        const from = { model: before.activeEmbedModel, dim: before.activeEmbedDim }
        const to = { model: activeEmbedModel, dim: activeEmbedDim }
        const runningStatus = { state: 'running', from, to, migrated: 0, startedAt }
        // Persist the mode + the running status, but NOT the new pin yet — the
        // switch's flip step persists activeEmbedModel/Dim after pass-1 backfill.
        await ownerPrisma.systemSettings.upsert({
          where: { id: SINGLETON_ID },
          update: { embeddingMode: dbMode, embeddingSwitch: runningStatus, updatedById: req.identity!.userId },
          create: {
            id: SINGLETON_ID,
            embeddingMode: dbMode,
            activeEmbedModel: from.model, // FROM pin until the switch flips it
            activeEmbedDim: from.dim,
            embeddingSwitch: runningStatus,
            updatedById: req.identity!.userId,
          },
        })
        void runModelSwitch(from, to, startedAt) // fire-and-forget; updates status as it goes
        return {
          ...(await toSettingsOut(await getEffectiveSettings(), req.identity!.userId)), // still the OLD pin (active until flip)
          modelChanged: true,
          switchStarted: true,
          warning:
            `Re-embed migration started in the background (${from.model}@${from.dim} → ${to.model}@${to.dim}). ` +
            'Search stays on the current pin until the backfill completes, then flips automatically — no restart. ' +
            'Track progress here (the status refreshes to "done" or "failed").',
        }
      }

      // ── Branch B — model change that cannot run a live server switch ──────────
      // client-managed embeddings (no server embedder) OR a mode flip alongside the model change.
      // Persist the flip + update the live pin (so client-managed bridges with a stale pin
      // get a 422 embedding_pin_mismatch and re-pull); guidance, not a backfill.
      if (modelChanged) {
        await ownerPrisma.systemSettings.upsert({
          where: { id: SINGLETON_ID },
          update: { embeddingMode: dbMode, activeEmbedModel, activeEmbedDim, updatedById: req.identity!.userId },
          create: {
            id: SINGLETON_ID,
            embeddingMode: dbMode,
            activeEmbedModel,
            activeEmbedDim,
            updatedById: req.identity!.userId,
          },
        })
        applyActivePin(activeEmbedModel, activeEmbedDim)
        return {
          ...(await toSettingsOut(await getEffectiveSettings(), req.identity!.userId)),
          modelChanged: true,
          warning:
            'Model/dim changed without a server-side re-embed (client-managed embeddings, or a simultaneous server-managed/client-managed topology flip). ' +
            'Existing vectors live under the OLD named-vector key and are not searchable on the new pin. ' +
            `Each member must re-pull "${activeEmbedModel}" in their local Ollama and RESTART their MCP. ` +
            'A server-side backfill is impossible in client-managed embeddings — switch to server-managed embeddings to re-embed the corpus, then change the model there.',
        }
      }

      // ── Branch C — no model change (mode flip and/or retention-unrelated save) ─
      await ownerPrisma.systemSettings.upsert({
        where: { id: SINGLETON_ID },
        update: { embeddingMode: dbMode, activeEmbedModel, activeEmbedDim, updatedById: req.identity!.userId },
        create: {
          id: SINGLETON_ID,
          embeddingMode: dbMode,
          activeEmbedModel,
          activeEmbedDim,
          updatedById: req.identity!.userId,
        },
      })
      return { ...(await toSettingsOut(await getEffectiveSettings(), req.identity!.userId)), modelChanged: false }
    },
  )
}
