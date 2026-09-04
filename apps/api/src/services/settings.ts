/**
 * persistent-memory-api — effective System Settings resolver (Phase 9).
 *
 * The SINGLE place that reads the SystemSettings singleton and overlays it on
 * the env-derived boot pin. Both GET /config (public) and GET /dashboard/settings
 * (control plane) call getEffectiveSettings() so they never drift.
 *
 * FALLBACK IS MANDATORY: a fresh DB before the seed upsert has no row → return
 * the env-derived values from services/embedding.ts, never throw/500. The DB
 * enum `client_bridge` is mapped to the wire string `client-bridge` here (Prisma
 * enum values cannot contain a hyphen).
 *
 * CONTROL-TABLE READ: SystemSettings has no RLS and pm_app has no grant on it, so
 * this MUST use ownerPrisma — never runInTenant/prisma. (Same rule as the rest of
 * the control plane.) GET /config is public yet legitimately touches ownerPrisma:
 * the values leak nothing sensitive (model id, dim, named-vector key, mode).
 */
import { ownerPrisma } from '@pm/db'
import { makeActivePin, type EmbeddingMode as WireEmbeddingMode, type EmbeddingTopology } from '@pm/shared'
import { embeddingMode, activePin } from './embedding.ts'
import {
  effectiveFactExtractionFromRow,
  type EffectiveFactExtractionSettings,
} from './fact-extraction.ts'
import { dbModeToWire, legacyModeToEmbeddingTopology } from './embedding-topology.ts'

const SINGLETON_ID = 'singleton'

export interface EffectiveSettings {
  embeddingTopology: EmbeddingTopology
  /** Deprecated compatibility alias. Prefer embeddingTopology. */
  embeddingMode: WireEmbeddingMode
  activeEmbedModel: string
  activeEmbedDim: number
  /** Derived Qdrant named-vector key for the EFFECTIVE (model, dim). */
  activeVectorName: string
  /** true once a SystemSettings row exists (i.e. an admin has saved settings). */
  persisted: boolean
  /** When the row was last written (null if falling back to env). */
  updatedAt: Date | null
  /** Phase 10 (#5) embedding-model-switch status (null = idle). Opaque JSON. */
  embeddingSwitch: unknown
  /** Fact extraction model + masked API-key state (Memory Shape gate). */
  factExtraction: EffectiveFactExtractionSettings
  /** Human dashboard login mode. Tokens remain for MCP/API/recovery access. */
  dashboardLoginMode: 'password' | 'sso'
  /** Stream MCP session idle timeout. Heartbeats do not extend this; real MCP requests do. */
  mcpSessionIdleTimeoutSeconds: number
}

/** The schema defaults — used as the pre-seed fallback (must match prisma defaults). */
export const MCP_SESSION_DEFAULTS = { idleTimeoutSeconds: 15 * 60 } as const

/**
 * Resolve the EFFECTIVE settings: the SystemSettings singleton if present, else
 * the env-derived boot pin. Pure read; never mutates. Always returns a usable
 * pin so callers never branch on absence.
 */
export async function getEffectiveSettings(): Promise<EffectiveSettings> {
  const row = await ownerPrisma.systemSettings.findUnique({
    where: { id: SINGLETON_ID },
  })

  if (!row) {
    // Fresh DB (pre-seed): mirror the boot env pin.
    return {
      embeddingTopology: legacyModeToEmbeddingTopology(embeddingMode),
      embeddingMode,
      activeEmbedModel: activePin.modelId,
      activeEmbedDim: activePin.dim,
      activeVectorName: activePin.vectorName,
      persisted: false,
      updatedAt: null,
      embeddingSwitch: null,
      factExtraction: effectiveFactExtractionFromRow(null),
      dashboardLoginMode: 'password',
      mcpSessionIdleTimeoutSeconds: MCP_SESSION_DEFAULTS.idleTimeoutSeconds,
    }
  }

  const mode = dbModeToWire(row.embeddingMode)
  const model = row.activeEmbedModel
  const dim = row.activeEmbedDim
  // Derive the named-vector key from the EFFECTIVE pin. If the row matches the
  // boot pin, this equals activePin.vectorName; if it diverges (a model/dim
  // change that has not yet been re-embedded), recompute so the displayed key
  // tracks the DB, not the stale boot value.
  const vectorName =
    model === activePin.modelId && dim === activePin.dim
      ? activePin.vectorName
      : makeActivePin(model, dim).vectorName

  return {
    embeddingTopology: legacyModeToEmbeddingTopology(mode),
    embeddingMode: mode,
    activeEmbedModel: model,
    activeEmbedDim: dim,
    activeVectorName: vectorName,
    persisted: true,
    updatedAt: row.updatedAt,
    embeddingSwitch: row.embeddingSwitch ?? null,
    factExtraction: effectiveFactExtractionFromRow(row),
    dashboardLoginMode: row.dashboardLoginMode ?? 'password',
    mcpSessionIdleTimeoutSeconds: row.mcpSessionIdleTimeoutSeconds,
  }
}
