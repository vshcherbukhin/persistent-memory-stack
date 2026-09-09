import Link from 'next/link'
import { Icon, type IconName } from '@/components/ui/Icon'
import type { MemoryGraphActivity, MemoryGraphFacet } from '@/lib/types'

/**
 * Lower Overview row: what the memory system has been doing, and what it is
 * accumulating. Both panels render from data the graph already exposes — the
 * activity stream and the badge facet — so nothing here is decorative.
 */

const ACTIVITY_TONE: Record<MemoryGraphActivity['kind'], { dot: string; label: string }> = {
  created: { dot: 'ok', label: 'created' },
  updated: { dot: 'warn', label: 'updated' },
  read: { dot: 'accent', label: 'recalled' },
}

/** Coarse relative time. Server-rendered, so it deliberately avoids sub-minute precision. */
export function sinceLabel(iso: string, now: number): string {
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return ''
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}

/** Hourly counts over the trailing window, oldest first — the metric-card sparkline. */
export function hourlyBuckets(events: MemoryGraphActivity[], now: number, hours = 24): number[] {
  const buckets = new Array(hours).fill(0)
  for (const event of events) {
    const at = Date.parse(event.occurredAt)
    if (Number.isNaN(at)) continue
    const hoursAgo = Math.floor((now - at) / 3_600_000)
    if (hoursAgo < 0 || hoursAgo >= hours) continue
    buckets[hours - 1 - hoursAgo] += 1
  }
  return buckets
}

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

export function MemoryActivityPanel({
  events,
  now,
  href,
  unavailable,
}: {
  events: MemoryGraphActivity[]
  now: number
  href: string
  unavailable: boolean
}) {
  return (
    <section className="panel overview-panel" aria-label="Memory activity">
      <div className="overview-panel-head">
        <div>
          <h2 className="card-title">Memory activity</h2>
          <p className="note">What your agents did with memory, from the stream MCP service.</p>
        </div>
        {!unavailable && events.length > 0 ? (
          <span className="state-badge ok inline-icon-label"><i className="live-dot" aria-hidden="true" />live</span>
        ) : null}
      </div>
      {unavailable ? (
        <div className="overview-panel-empty">
          <Icon name="sensors_off" size={22} />
          <span>Activity is unavailable while the graph service is unreachable.</span>
        </div>
      ) : events.length === 0 ? (
        <div className="overview-panel-empty">
          <Icon name="sensors" size={22} />
          <span>No memory operations yet. Recalls and writes from Claude or Codex appear here.</span>
        </div>
      ) : (
        <ol className="activity-feed">
          {events.slice(0, 8).map((event) => {
            const tone = ACTIVITY_TONE[event.kind] ?? ACTIVITY_TONE.read
            return (
              <li key={`${event.memoryId}-${event.occurredAt}-${event.kind}`} className="activity-item">
                <i className={`dot ${tone.dot}`} aria-hidden="true" />
                <span className="activity-body">
                  <span className="activity-line">
                    <span className={`state-badge ${tone.dot}`}>{tone.label}</span>
                    <span className="activity-label">{event.displayLabel}</span>
                  </span>
                  <span className="activity-meta">
                    {event.project}
                    {event.category ? ` · ${event.category}` : ''}
                  </span>
                </span>
                <span className="activity-when">{sinceLabel(event.occurredAt, now)}</span>
              </li>
            )
          })}
        </ol>
      )}
      <Link className="overview-panel-action" href={href}>
        Open the memory graph <Icon name="arrow_forward" size={14} />
      </Link>
    </section>
  )
}

export function CorpusShapePanel({
  badges,
  total,
  href,
  unavailable,
}: {
  badges: MemoryGraphFacet[]
  total: number
  href: string
  unavailable: boolean
}) {
  const top = badges.slice(0, 8)
  const max = top.reduce((peak, badge) => Math.max(peak, badge.count), 0) || 1
  return (
    <section className="panel overview-panel" aria-label="Corpus shape">
      <div className="overview-panel-head">
        <div>
          <h2 className="card-title">Corpus shape</h2>
          <p className="note">Where memory is accumulating, by category.</p>
        </div>
        {total > 0 ? <span className="badge-readonly">{total.toLocaleString()} records</span> : null}
      </div>
      {unavailable || top.length === 0 ? (
        <div className="overview-panel-empty">
          <Icon name="donut_small" size={22} />
          <span>
            {unavailable
              ? 'Category distribution is unavailable while the graph service is unreachable.'
              : 'Categories appear once your agents have written a few memories.'}
          </span>
        </div>
      ) : (
        <ul className="corpus-list">
          {top.map((badge) => (
            <li key={badge.value} className="corpus-row">
              <span className="corpus-label" title={badge.value}>{badge.value}</span>
              <span className="corpus-track" aria-hidden="true">
                <span className="corpus-fill" style={{ width: `${Math.max(3, Math.round((badge.count / max) * 100))}%` }} />
              </span>
              <span className="corpus-count mono">{badge.count.toLocaleString()}</span>
            </li>
          ))}
        </ul>
      )}
      <Link className="overview-panel-action" href={href}>
        Browse memories <Icon name="arrow_forward" size={14} />
      </Link>
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
