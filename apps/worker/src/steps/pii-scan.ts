/**
 * pii-scan — the periodic DLP safety net (Phase 8, #10).
 *
 * The write-gate (api) + the ingest block (pipeline) are the PRIMARY guards; this
 * scheduled job re-checks STORED memories + chunks for PII/secrets that predate the
 * gate (legacy rows) or otherwise slipped through, raises SecurityAlerts, and notifies
 * the owning team + the global super-admin row.
 *
 * Cross-team by design → withSystemTenant + runInTenant({globalAdmin:true}) (the GUC
 * global-admin path, NOT ownerPrisma on data tables), exactly like embed-backfill.
 *
 * Idempotent + progressive via the pii_scanned_at cursor: each run takes a bounded
 * batch of rows that were never scanned OR edited since their last scan, then stamps
 * pii_scanned_at = now. FAIL-CLOSED here means ABORT the run (the scanner being down
 * must not falsely flag — or falsely clear — every row); the next tick retries.
 */
import { runInTenant, type Tx } from '@pm/db'
import { dlpGate, type GateFinding } from '@pm/security-dlp'
import type { WorkerDeps } from '../deps.ts'
import { withSystemTenant } from '../tenant.ts'
import { recordSecurityAlerts } from './security.ts'
import { notifyAlert } from '../notify.ts'

/** Per-run, per-kind cap — bounded DLP calls; the cursor makes the next run continue. */
const BATCH = 100

type Kind = 'memory' | 'chunk'

interface ScanRow {
  id: string
  teamId: string
  project: string
  content: string
}

interface KindResult {
  scanned: number
  flagged: number
  capHit: boolean
  scannerDown: boolean
  /** teamId → findings flagged in that team this run (for notification). */
  byTeam: Map<string, { rowId: string; findings: GateFinding[] }[]>
}

/** Scan one kind's un-scanned/edited rows. Returns counts + per-team flags. */
async function scanKind(deps: WorkerDeps, kind: Kind): Promise<KindResult> {
  const result: KindResult = { scanned: 0, flagged: 0, capHit: false, scannerDown: false, byTeam: new Map() }

  // Rows never scanned OR edited since the last scan. Raw SQL for the column-vs-column
  // predicate (Prisma can't express updatedAt > piiScannedAt in a where filter).
  const table = kind === 'memory' ? 'memory' : 'chunk'
  const rows = (await runInTenant<ScanRow[]>(
    (tx: Tx) =>
      tx.$queryRawUnsafe(
        `SELECT id, team_id AS "teamId", project, content
           FROM "${table}"
          WHERE pii_scanned_at IS NULL OR updated_at > pii_scanned_at
          ORDER BY created_at ASC
          LIMIT ${BATCH}`,
      ) as PromiseLike<ScanRow[]>,
    { globalAdmin: true, readOnly: true },
  )) as ScanRow[]

  if (rows.length === 0) return result
  result.capHit = rows.length === BATCH

  const scannedIds: string[] = []
  for (const row of rows) {
    const gate = await dlpGate(deps.dlpClient, row.content, {
      entities: deps.piiEntities,
      scoreThreshold: deps.piiScoreThreshold,
    })
    if (gate.failClosed) {
      // Scanner down — abort: do NOT stamp or alert anything from this run.
      result.scannerDown = true
      return result
    }
    scannedIds.push(row.id)
    if (gate.blocked) {
      result.flagged++
      await recordSecurityAlerts(
        gate.findings,
        { teamId: row.teamId, project: row.project, sourceKind: kind, rowId: row.id },
        { globalAdmin: true },
      ).catch((e) => console.warn('WARN: [pii-scan] securityAlert write failed (non-fatal):', e))
      const list = result.byTeam.get(row.teamId) ?? []
      list.push({ rowId: row.id, findings: gate.findings })
      result.byTeam.set(row.teamId, list)
    }
  }

  // Stamp the cursor for every row we actually scanned (clean or flagged).
  if (scannedIds.length > 0) {
    await runInTenant(async (tx: Tx) => {
      const now = new Date()
      if (kind === 'memory') {
        await tx.memory.updateMany({ where: { id: { in: scannedIds } }, data: { piiScannedAt: now } })
      } else {
        await tx.chunk.updateMany({ where: { id: { in: scannedIds } }, data: { piiScannedAt: now } })
      }
    }, { globalAdmin: true })
  }
  result.scanned = scannedIds.length
  return result
}

/** The scheduled-job entry point. Returns a short summary for ScheduledJob.logTail. */
export async function piiScan(deps: WorkerDeps): Promise<string> {
  return withSystemTenant(async () => {
    const mem = await scanKind(deps, 'memory')
    if (mem.scannerDown) return 'skipped — DLP scanner unavailable; will retry next run'
    const chunk = await scanKind(deps, 'chunk')
    if (chunk.scannerDown) {
      return `scanned ${mem.scanned} memory row(s); chunk scan skipped — DLP scanner unavailable`
    }

    // Notify per team (one summary per team, not per finding — avoid alert spam).
    const byTeam = new Map<string, number>()
    for (const [teamId, flags] of mem.byTeam) byTeam.set(teamId, (byTeam.get(teamId) ?? 0) + flags.length)
    for (const [teamId, flags] of chunk.byTeam) byTeam.set(teamId, (byTeam.get(teamId) ?? 0) + flags.length)
    for (const [teamId, count] of byTeam) {
      await notifyAlert(teamId, {
        subject: `pii-scan flagged ${count} stored item(s)`,
        body:
          `The periodic DLP scan flagged ${count} stored memory/chunk row(s) in this team containing ` +
          `PII or secrets. Review them on the dashboard Security page and remediate.`,
        severity: 'high',
      }).catch(() => 0)
    }

    const scanned = mem.scanned + chunk.scanned
    const flagged = mem.flagged + chunk.flagged
    if (scanned === 0) return 'nothing to scan (all rows up to date)'
    const capNote = mem.capHit || chunk.capHit ? ' (batch cap hit — next run continues)' : ''
    return `scanned ${scanned} row(s); flagged ${flagged} with PII/secrets across ${byTeam.size} team(s)${capNote}`
  })
}
