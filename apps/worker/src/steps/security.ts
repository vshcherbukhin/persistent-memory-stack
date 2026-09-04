/**
 * worker/steps/security — write SecurityAlert rows for DLP findings (Phase 8, #10).
 *
 * Used by both the ingest pipeline (a blocked document, ambient team ctx) and the
 * pii-scan scheduled job (cross-team, global-admin ctx). The caller passes the
 * runInTenant opts that match its context:
 *   • ingest block → no opts (the ambient withWorkerTenant team ctx; team_write).
 *   • pii-scan     → { globalAdmin: true } (cross-team via the GUC path, NOT ownerPrisma).
 *
 * Findings are REDACTION-SAFE (GateFinding.redactedExcerpt never carries the raw value).
 */
import { runInTenant, type Tx } from '@pm/db'
import type { GateFinding } from '@pm/security-dlp'

export type AlertSourceKind = 'memory' | 'chunk' | 'ingest'

export interface AlertTarget {
  teamId: string
  project: string
  sourceKind: AlertSourceKind
  rowId: string | null
}

type RunOpts = Parameters<typeof runInTenant>[1]

/** Persist one SecurityAlert per finding. Returns the count written. */
export async function recordSecurityAlerts(
  findings: GateFinding[],
  target: AlertTarget,
  opts?: RunOpts,
): Promise<number> {
  if (findings.length === 0) return 0
  return runInTenant(async (tx: Tx) => {
    let n = 0
    for (const f of findings) {
      await tx.securityAlert.create({
        data: {
          teamId: target.teamId,
          project: target.project,
          sourceKind: target.sourceKind,
          rowId: target.rowId,
          detector: f.detector,
          findingType: f.findingType,
          severity: f.severity,
          redactedExcerpt: f.redactedExcerpt,
        },
        select: { id: true },
      })
      n++
    }
    return n
  }, opts) as Promise<number>
}
