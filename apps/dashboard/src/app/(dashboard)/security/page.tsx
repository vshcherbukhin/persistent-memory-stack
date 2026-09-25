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
      {/* Prototype d-security: three metric cards — tone on the edge, state in the badge. */}
      <section className="security-metrics" aria-label="Security summary">
        <div className={`panel security-metric ${highest}`}>
          <div className="security-metric-head">
            <span className="section-label">Open findings</span>
            <span className={`badge up ${highest === 'ok' ? 'ok' : 'bad'}`}>{highest === 'ok' ? 'clear' : 'action needed'}</span>
          </div>
          <div className="security-metric-value">{alerts.length}</div>
          <div className="muted">{severityLine || 'nothing needs attention'}</div>
        </div>
        <div className="panel security-metric">
          <div className="security-metric-head">
            <span className="section-label">Resolved</span>
          </div>
          <div className="security-metric-value">{resolved.length}</div>
          <div className="muted">kept as history, never re-opened automatically</div>
        </div>
        <div className="panel security-metric">
          <div className="security-metric-head">
            <span className="section-label">Detectors</span>
          </div>
          <div className="security-metric-value security-metric-small">Presidio · gitleaks</div>
          <div className="muted">every stored memory and document ingest is scanned; values are never stored</div>
        </div>
      </section>

      {alerts.length === 0 ? (
        <div className="panel security-clear">
          <Icon name="shield" size={34} className="security-clear-icon" />
          <strong>No open security alerts</strong>
          <span>
            Persistent Memory scans stored memory text and document ingests for PII and secret patterns. Findings appear
            here with their type and a redacted location — never the value itself.
          </span>
          {resolved.length > 0 ? (
            <span className="security-clear-foot">{resolved.length} finding{resolved.length === 1 ? '' : 's'} resolved previously.</span>
          ) : null}
        </div>
      ) : (
        <section className="security-alerts" aria-label="Open alerts">
          <div className="section-label">
            Open alerts · {alerts.length} · highest severity first
          </div>
          <div className="table-scroll security-scroll-list">
            {sorted.map((a) => {
              const tone = a.severity === 'high' ? 'bad' : a.severity === 'medium' ? 'warn' : 'neutral'
              return (
                <article key={a.id} className={`panel security-alert sev-${a.severity} tone-${tone}`}>
                  <span className="security-alert-icon" aria-hidden="true">
                    <Icon name={a.severity === 'high' ? 'error_outline' : 'warning'} size={18} />
                  </span>
                  <div className="security-alert-body">
                    <div className="security-alert-title">
                      <b>{a.detector} · {a.findingType}</b>
                      <span className={`badge up${tone === 'neutral' ? '' : ` ${tone}`}`}>{a.severity}</span>
                    </div>
                    {a.redactedExcerpt ? <p className="note">{a.redactedExcerpt}</p> : null}
                    <div className="cell-mono security-alert-meta">
                      {a.sourceKind}
                      {a.rowId ? ` ${a.rowId.slice(0, 8)}` : ''} · {a.project}
                    </div>
                    <div className="btn-row">
                      <ResolveAlertForm id={a.id} surface={surface} />
                      <span className="note security-alert-when">{new Date(a.createdAt).toLocaleString()}</span>
                    </div>
                  </div>
                </article>
              )
            })}
          </div>
        </section>
      )}
    </div>
  )
}
