/**
 * runSwitch — sequences the named-vector migration end to end. The callable API
 * the P9 admin "System Settings" panel and the worker drive.
 *
 * Steps 1→3→(4 flip)→5 with hooks. Step 4 (flip the active pin) + the dual-write
 * flag live in the CALLER's control plane (env/System Settings DB row): runSwitch
 * invokes `savePin(plan.to)` at the flip and lets the caller toggle dual-write
 * via `setDualWrite`. This keeps shared DB-free while still expressing the full
 * sequence.
 *
 * --no-drop / dryRun let an operator stop before the irreversible drop and
 * observe dual-write. Each Qdrant step is independently idempotent (resume-safe).
 */
import type { QdrantClient } from '@qdrant/js-client-rest'
import type { ActivePin } from '../types/index.ts'
import type { ReembedDeps, SwitchPlan } from './migration.ts'
import {
  step1AddVector,
  step3Reembed,
  step4FlipTarget,
  step5DropOld,
} from './migration.ts'

export interface RunSwitchHooks extends ReembedDeps {
  /** Persist the active pin (step 4 flip). Caller writes env/System Settings. */
  savePin: (pin: ActivePin) => Promise<void>
  /** Toggle the dual-write flag the write path reads (step 2 on / post-drop off). */
  setDualWrite?: (target: ActivePin | null) => Promise<void>
  /** Stop after backfill — do NOT flip or drop (observe dual-write first). */
  noFlip?: boolean
  /** Flip but do NOT drop the old vector (reversible window). */
  noDrop?: boolean
  /** Log each step. */
  log?: (msg: string) => void
}

export interface SwitchResult {
  added: boolean
  migrated: number
  flipped: boolean
  dropped: boolean
}

export async function runSwitch(
  client: QdrantClient,
  plan: SwitchPlan,
  hooks: RunSwitchHooks,
): Promise<SwitchResult> {
  const log = hooks.log ?? (() => {})

  log(`[switch] step 1: add named vector "${plan.to.vectorName}" (size ${plan.to.dim})`)
  const { added } = await step1AddVector(client, plan)
  log(added ? '[switch] step 1: added' : '[switch] step 1: already present (resume)')

  log('[switch] step 2: enabling dual-write')
  await hooks.setDualWrite?.(plan.to)

  log('[switch] step 3: backfilling (scroll + re-embed → target vector)')
  const { migrated } = await step3Reembed(client, plan, hooks)
  log(`[switch] step 3: migrated ${migrated} points`)

  if (hooks.noFlip) {
    log('[switch] noFlip set — stopping before flip. Old pin still active.')
    return { added, migrated, flipped: false, dropped: false }
  }

  log(`[switch] step 4: flipping active pin → ${plan.to.modelId}@${plan.to.dim}`)
  await hooks.savePin(step4FlipTarget(plan))

  if (hooks.noDrop) {
    log('[switch] noDrop set — flipped but old vector retained (reversible window).')
    return { added, migrated, flipped: true, dropped: false }
  }

  log('[switch] step 5: dropping old vector + disabling dual-write')
  await hooks.setDualWrite?.(null)
  const { dropped } = await step5DropOld(client, plan)
  log(dropped ? '[switch] step 5: dropped old vector' : '[switch] step 5: old vector already gone')

  return { added, migrated, flipped: true, dropped }
}
