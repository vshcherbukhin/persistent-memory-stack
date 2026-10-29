import Link from 'next/link'
import { Icon, type IconName } from '@/components/ui/Icon'
import { Tooltip } from '@/components/ui/Tooltip'
import type { MemoryGraphFacet } from '@/lib/types'

/**
 * Overview building blocks: the corpus-shape panel, metric sparklines and the incident
 * notice, all rendered from data the API already exposes. Live MCP activity is the
 * client-polled McpLiveSessionsPanel.
 */

export function Sparkline({ points, tone = 'var(--accent)' }: { points: number[]; tone?: string }) {
  if (points.length < 2 || points.every((p) => p === 0)) return null
  const width = 108
  const height = 34
  const max = Math.max(...points)
  const min = Math.min(...points)
  const span = max - min || 1
  const path = points
    .map((p, i) => `${((i / (points.length - 1)) * width).toFixed(1)},${(height - ((p - min) / span) * (height - 5) - 2).toFixed(1)}`)
    .join(' L')
  return (
    <svg className="metric-spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} fill="none" aria-hidden="true">
      <path d={`M${path}`} stroke={tone} strokeWidth="1.4" strokeLinejoin="round" opacity=".85" />
      <path d={`M${path} L${width},${height} L0,${height}Z`} fill={tone} opacity=".07" />
    </svg>
  )
}

export function CorpusShapePanel({
  badges,
  unavailable,
}: {
  badges: MemoryGraphFacet[]
  unavailable: boolean
}) {
  const top = badges.slice(0, 8)
  const max = top.reduce((peak, badge) => Math.max(peak, badge.count), 0) || 1
  return (
    <section className="panel overview-panel" aria-label="Corpus shape">
      <div className="overview-panel-head">
        <div>
          <h2 className="card-title">Corpus shape</h2>
          <p className="card-sub">Where memory is accumulating.</p>
        </div>
      </div>
      {unavailable || top.length === 0 ? (
        <div className="overview-panel-empty">
          <Icon name="donut_small" size={22} />
          <span>
            {unavailable
              ? 'Category distribution is temporarily unavailable. The summary could not be read.'
              : 'Categories appear once your agents have written a few memories.'}
          </span>
        </div>
      ) : (
        <ul className="corpus-list">
          {top.map((badge) => (
            <li key={badge.value} className="corpus-row">
              <Tooltip as="span" className="corpus-label" label={badge.value}>{badge.value}</Tooltip>
              <span className="corpus-track" aria-hidden="true">
                <span className="corpus-fill" style={{ width: `${Math.max(3, Math.round((badge.count / max) * 100))}%` }} />
              </span>
              <span className="corpus-count mono">{badge.count.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

export function OverviewIncident({
  title,
  detail,
  href,
  actionLabel,
  icon = 'error_outline',
}: {
  title: string
  detail: string
  href: string
  actionLabel: string
  icon?: IconName
}) {
  return (
    <div className="notice danger overview-incident" role="status">
      <Icon name={icon} size={18} className="overview-incident-icon" />
      <div>
        <div className="notice-title">{title}</div>
        <p>{detail}</p>
        <Link className="overview-incident-action" href={href}>
          {actionLabel} <Icon name="arrow_forward" size={13} />
        </Link>
      </div>
    </div>
  )
}

/** Daily counts over the trailing window, oldest first, from record timestamps. */
export function dailyBuckets(timestamps: string[], now: number, days = 14): number[] {
  const buckets = new Array(days).fill(0)
  for (const value of timestamps) {
    const at = Date.parse(value)
    if (Number.isNaN(at)) continue
    const daysAgo = Math.floor((now - at) / 86_400_000)
    if (daysAgo < 0 || daysAgo >= days) continue
    buckets[days - 1 - daysAgo] += 1
  }
  return buckets
}

/** "4 min ago" · "2 h ago" · "3 days ago" — the prototype's relative observation copy. */
export function relativeAgo(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return 'at an unknown time'
  const minutes = Math.round(Math.max(0, now - then) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} h ago`
  const days = Math.round(hours / 24)
  return `${days} day${days === 1 ? '' : 's'} ago`
}
