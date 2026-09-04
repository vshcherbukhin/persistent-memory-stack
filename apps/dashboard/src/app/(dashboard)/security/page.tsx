import { requireControlPlane } from '@/lib/session'
import { api, normalizeMemorySurface } from '@/lib/api'
import { ResolveAlertForm } from './ResolveAlertForm'

export const dynamic = 'force-dynamic'

/**
 * Security — DLP findings (Presidio PII + gitleaks secrets). admin+ baseline:
 * a team-admin sees ONLY their team's findings; a super-admin sees ALL teams
 * (server RLS, rls.sql §5b). The raw secret/PII value is NEVER stored or shown —
 * only the finding TYPE + a redacted location.
 */
function sevClass(s: string): 'super' | 'admin' | 'member' {
  return s === 'high' ? 'super' : s === 'medium' ? 'admin' : 'member'
}

export default async function SecurityPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = searchParams ? await searchParams : {}
  const surface = normalizeMemorySurface(Array.isArray(params.space) ? params.space[0] : params.space)
  await requireControlPlane()
  const { alerts } = await api.getSecurityAlerts({ resolved: false }, surface)

  return (
    <div className="page-fill security-page">
      <h1>Security</h1>
      <p className="muted" style={{ maxWidth: 720 }}>
        Open DLP findings — PII (Presidio) and secrets (gitleaks) detected in stored memories
        or blocked document ingests. You see your team&apos;s findings; super-admins see all
        teams. The flagged value is never stored, only its type + location.
      </p>

      <div className="section-label" style={{ margin: '12px 0 10px' }}>
        {alerts.length} open finding(s)
      </div>

      {alerts.length === 0 ? (
        <div className="notice">No open security findings.</div>
      ) : (
        <div className="table-scroll security-scroll-list">
          {alerts.map((a) => (
            <div
              key={a.id}
              className="panel"
              style={{ marginBottom: 0, padding: '14px 16px', display: 'flex', alignItems: 'center', gap: 14 }}
            >
              <span className={`role-badge ${sevClass(a.severity)}`}>{a.severity}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600 }}>
                  {a.detector} · {a.findingType}
                </div>
                <div className="muted mono" style={{ fontSize: 12.5, marginTop: 2 }}>
                  {a.sourceKind}
                  {a.rowId ? ` ${a.rowId.slice(0, 8)}` : ''} · {a.project} ·{' '}
                  {new Date(a.createdAt).toLocaleString()}
                </div>
                {a.redactedExcerpt ? (
                  <div className="muted" style={{ fontSize: 12.5, marginTop: 2 }}>{a.redactedExcerpt}</div>
                ) : null}
              </div>
              <ResolveAlertForm id={a.id} surface={surface} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
