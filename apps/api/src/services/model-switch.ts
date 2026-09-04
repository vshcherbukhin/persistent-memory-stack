/**
 * Embedding-model SWITCH DRIVER (Phase 10, #5) — wires the @pm/shared named-vector
 * switch tool to real persistence + a live in-process pin flip, so a superuser can
 * change the pinned embedding model from the dashboard with NO blackout and NO
 * manual restart.
 *
 * WHO RUNS IT: the api, as a background task kicked off by PUT /dashboard/settings
 * (server-managed embeddings only — the server must own the embedder to re-embed the corpus). The api
 * already holds the Qdrant client + DB access + can build a target embedder, so a
 * separate BullMQ job type is unnecessary. The Qdrant steps are each idempotent +
 * resume-safe, so an api crash mid-switch is recovered by re-triggering the PUT
 * (ponytail: interrupted switch → manual re-trigger; a watchdog auto-resume is the
 * upgrade path if it ever matters).
 *
 * NO-BLACKOUT via TWO PASSES (not a live dual-write path threaded through every
 * write handler):
 *   add target vector → backfill pass 1 → FLIP the pin → backfill pass 2 → drop old.
 * Reads use the OLD vector until the flip (pass 1 fully populated it), then the NEW
 * vector after (also fully populated). Rows WRITTEN during pass 1 land under the old
 * pin only; pass 2 (after the flip) re-embeds everything again and reconciles them.
 * The cost is one extra idempotent backfill pass — cheap for the rare admin op on a
 * small corpus, and it removes the dual-write branch from memories/documents/worker.
 * (ponytail: live dual-write — add when the corpus is large enough that the
 * sub-second pass-2 reconcile window matters.)
 *
 * The flip is in-process (applyActivePin) so THIS api picks up the new pin instantly;
 * the WORKER (a separate process) polls SystemSettings to refresh — see worker boot.
 */
import { ownerPrisma, runInTenant, tenantStore, Prisma, type TenantCtx, type Tx } from '@pm/db'
import {
  planSwitch,
  runSwitch,
  step3Reembed,
  step5DropOld,
  makeEmbedderForPin,
  type ActivePin,
} from '@pm/shared'
import { qdrant, applyActivePin } from './embedding.ts'
import { withEmbeddingHealth } from './embedding-health.ts'

const SINGLETON_ID = 'singleton'
/** A 'running' status older than this is treated as a crashed switch, not a live
 *  one — a fresh PUT may override it (otherwise an api crash mid-switch would wedge
 *  the pin forever). ponytail: stale-by-age; a heartbeat is the upgrade path. */
const STALE_RUNNING_MS = 30 * 60_000

export interface SwitchPins {
  model: string
  dim: number
}

export interface SwitchStatus {
  state: 'running' | 'done' | 'failed'
  from: SwitchPins
  to: SwitchPins
  migrated: number
  startedAt: string
  finishedAt?: string
  error?: string
}

/** True iff a non-stale switch is currently running (blocks a concurrent switch). */
export function isSwitchRunning(status: unknown): boolean {
  const s = status as SwitchStatus | null
  if (!s || s.state !== 'running') return false
  const started = Date.parse(s.startedAt)
  if (Number.isNaN(started)) return false
  return Date.now() - started < STALE_RUNNING_MS
}

/**
 * A migration can fail after its safe flip but before the second reconciliation
 * pass/drop (for example, a row is deleted during that pass).  In that state the
 * active pin is already the target and a same-pin settings save should resume the
 * idempotent switch rather than force an operator through a needless round trip.
 */
export function resumableFailedSwitch(status: unknown, active: SwitchPins): SwitchPins | null {
  const s = status as Partial<SwitchStatus> | null
  if (!s || s.state !== 'failed' || !s.from || !s.to) return null
  if (s.to.model !== active.model || s.to.dim !== active.dim) return null
  if (s.from.model === active.model && s.from.dim === active.dim) return null
  return s.from
}

/**
 * A SYSTEM global ctx for the cross-team re-embed read (mirrors apps/worker/src/tenant.ts
 * buildSystemCtx — keep in sync). userId='' is LOAD-BEARING: pm_current_user_id()
 * casts app.user_id to uuid, so a non-empty non-uuid string throws even on a
 * global-admin read path. This driver only READS source text (no memory write), so
 * the owner floor never fires, but '' keeps it identical to the proven worker twin.
 */
function withSystemTenant<T>(fn: () => Promise<T>): Promise<T> {
  const ctx: TenantCtx = {
    userId: '',
    teamId: null,
    adminLevel: 'superuser',
    isTeamMember: false,
    isTeamAdmin: false,
    isGlobalSuperuser: true,
    mountedTeamIds: [],
    insideTenantTx: false,
  }
  return tenantStore.run(ctx, fn)
}

/**
 * Cross-team source-text lookup by Qdrant row_id (a row_id is a Memory OR a Chunk
 * id — the scroll loses source_kind, so we query both; uuids never collide). Uses
 * the global-admin RLS read path (NOT ownerPrisma) so RLS stays the backstop.
 */
async function fetchText(rowIds: string[]): Promise<Map<string, string>> {
  if (rowIds.length === 0) return new Map()
  return withSystemTenant(() =>
    runInTenant(
      async (tx: Tx) => {
        const [mems, chunks] = await Promise.all([
          tx.memory.findMany({ where: { id: { in: rowIds } }, select: { id: true, content: true } }),
          tx.chunk.findMany({ where: { id: { in: rowIds } }, select: { id: true, content: true } }),
        ])
        const out = new Map<string, string>()
        for (const r of mems) out.set(r.id, r.content)
        for (const r of chunks) out.set(r.id, r.content)
        return out
      },
      { globalAdmin: true, readOnly: true, readAllMemory: true },
    ),
  )
}

async function persistPin(pin: ActivePin): Promise<void> {
  await ownerPrisma.systemSettings.update({
    where: { id: SINGLETON_ID },
    data: { activeEmbedModel: pin.modelId, activeEmbedDim: pin.dim },
  })
}

async function writeStatus(s: SwitchStatus): Promise<void> {
  await ownerPrisma.systemSettings.update({
    where: { id: SINGLETON_ID },
    data: { embeddingSwitch: s as unknown as Prisma.InputJsonValue },
  })
}

/**
 * Drive the named-vector re-embed migration end to end (server-managed embeddings). Fire-and-forget:
 * the route awaits nothing — this updates SystemSettings.embeddingSwitch as it goes
 * (running → done|failed) and the dashboard reads that for progress. Always writes a
 * TERMINAL status (never leaves 'running' on a handled error).
 */
export async function runModelSwitch(from: SwitchPins, to: SwitchPins, startedAt: string): Promise<void> {
  const plan = planSwitch(from.model, from.dim, to.model, to.dim)
  const status: SwitchStatus = { state: 'running', from, to, migrated: 0, startedAt }
  try {
    const target = makeEmbedderForPin(to.model, to.dim) // validates; throws on a bad pin
    const embed = async (texts: string[]): Promise<number[][]> =>
      (await withEmbeddingHealth(
        { observerScope: 'server', provider: target.provider, model: target.model },
        () => target.embed(texts, 'document'),
      )).vectors

    // Pass 1 + flip (noDrop): add the target vector, backfill from Postgres text,
    // then flip the pin (persist + in-process applyActivePin). setDualWrite is
    // omitted on purpose — pass 2 reconciles the flip window instead.
    await runSwitch(qdrant, plan, {
      embed,
      fetchText,
      onProgress: (n) => {
        status.migrated = n
      },
      savePin: async (pin) => {
        await persistPin(pin)
        applyActivePin(pin.modelId, pin.dim) // this api picks up the new pin instantly
      },
      noDrop: true,
      log: (m) => console.log(`[model-switch] ${m}`),
    })

    // Pass 2: now the pin is flipped, re-embed everything again — catches rows
    // written under the OLD pin during pass 1 (harmless re-embed for the rest).
    const p2 = await step3Reembed(qdrant, plan, {
      embed,
      fetchText,
      onProgress: (n) => {
        status.migrated = n
      },
    })
    status.migrated = p2.migrated

    // Point of no return — old vector fully superseded.
    await step5DropOld(qdrant, plan)

    await writeStatus({ ...status, state: 'done', finishedAt: new Date().toISOString() })
    console.log(
      `[model-switch] done: ${from.model}@${from.dim} → ${to.model}@${to.dim} (${status.migrated} re-embedded)`,
    )
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await writeStatus({ ...status, state: 'failed', finishedAt: new Date().toISOString(), error: message }).catch(
      () => {},
    )
    console.error(`ERROR: [model-switch] failed (${from.model}@${from.dim} → ${to.model}@${to.dim}): ${message}`)
  }
}
