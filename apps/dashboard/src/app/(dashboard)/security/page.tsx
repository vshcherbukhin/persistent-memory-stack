import { requireControlPlane } from '@/lib/session'
import { api, normalizeMemorySurface } from '@/lib/api'
import { Icon } from '@/components/ui/Icon'
import { ResolveAlertForm } from './ResolveAlertForm'

export const dynamic = 'force-dynamic'

/**
 * Security — DLP findings (Presidio PII + gitleaks secrets). admin+ baseline:
 * a team-admin sees ONLY their team's findings; a super-admin sees ALL teams
 * (server RLS, rls.sql §5b). The raw secret/PII value is NEVER stored or shown —
 * only the finding TYPE + a redacted location.
 */
const SEVERITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 }

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

  // Resolved history is supplementary — a failure there must not hide open findings.
  const [openResult, resolvedResult] = await Promise.allSettled([
    api.getSecurityAlerts({ resolved: false }, surface),
    api.getSecurityAlerts({ resolved: true }, surface),
  ])
  const alerts = openResult.status === 'fulfilled' ? openResult.value.alerts : []
  const resolved = resolvedResult.status === 'fulfilled' ? resolvedResult.value.alerts : []

  const bySeverity = alerts.reduce<Record<string, number>>((acc, a) => {
    acc[a.severity] = (acc[a.severity] ?? 0) + 1
    return acc
  }, {})
  const highest = alerts.some((a) => a.severity === 'high')
    ? 'bad'
    : alerts.length > 0
      ? 'warn'
      : 'ok'
  const severityLine = ['high', 'medium', 'low']
    .filter((s) => bySeverity[s])
    .map((s) => `${bySeverity[s]} ${s}`)
    .join(', ')
  const sorted = [...alerts].sort(
    (a, b) =>
      (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3) ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt),
  )

  return (
    <div className="page-fill security-page">
      <h1>Security</h1>
      <p className="muted" style={{ maxWidth: 720 }}>
        Open DLP findings — PII (Presidio) and secrets (gitleaks) detected in stored memories
        or blocked document ingests. You see your team&apos;s findings; super-admins see all
        teams. The flagged value is never stored, only its type + location.
      </p>

      <section className="security-metrics" aria-label="Security summary">
        <div className={`panel security-metric ${highest}`}>
          <div className="section-label">Open findings</div>
          <div className="security-metric-value">{alerts.length}</div>
          <div className="muted">{severityLine || 'nothing needs attention'}</div>
        </div>
        <div className="panel security-metric">
          <div className="section-label">Resolved</div>
          <div className="security-metric-value">{resolved.length}</div>
          <div className="muted">kept as history, never re-opened automatically</div>
        </div>
        <div className="panel security-metric">
          <div className="section-label">Detectors</div>
          <div className="security-metric-value security-metric-small">Presidio · gitleaks</div>
          <div className="muted">every stored memory and document ingest is scanned</div>
        </div>
      </section>

      {alerts.length === 0 ? (
        <div className="security-clear">
          <Icon name="verified_user" size={34} className="security-clear-icon" />
          <strong>No open security findings</strong>
          <span>
            Persistent Memory scans stored memory text and document ingests for PII and secret
            patterns. Findings appear here with their type and a redacted location — never the
            value itself.
          </span>
          {resolved.length > 0 ? (
            <span className="security-clear-foot">{resolved.length} finding{resolved.length === 1 ? '' : 's'} resolved previously.</span>
          ) : null}
        </div>
      ) : (
        <>
          <div className="section-label" style={{ margin: '12px 0 10px' }}>
            {alerts.length} open finding{alerts.length === 1 ? '' : 's'} · highest severity first
          </div>
          <div className="table-scroll security-scroll-list">
            {sorted.map((a) => (
              <div key={a.id} className={`panel security-alert sev-${a.severity}`}>
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
        </>
      )}
    </div>
  )
}
