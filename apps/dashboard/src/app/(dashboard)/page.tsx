import Link from 'next/link'
import { requireControlPlane } from '@/lib/session'
import { api } from '@/lib/api'
import { isSuperuserLevel } from '@/lib/authz'
import type { MemoryGraphActivity, MemoryGraphFacet, OverviewSummary } from '@/lib/types'
import { capabilityHealthPresentation } from '@/lib/capabilityHealth'
import { OverviewAutoRefresh } from './OverviewAutoRefresh'
import {
  CorpusShapePanel,
  MemoryActivityPanel,
  OverviewIncident,
  Sparkline,
  hourlyBuckets,
} from './OverviewPanels'

export const dynamic = 'force-dynamic'

type Tone = 'accent' | 'ok' | 'warn' | 'bad' | 'neutral'
type BadgeTone = 'ok' | 'warn' | 'bad' | 'neutral'

function compact(n: number): string {
  return Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(n)
}

function money(n: number): string {
  if (n === 0) return '$0'
  return '$' + n.toFixed(n < 1 ? 4 : 2)
}

function serviceTone(s: OverviewSummary['services']): Tone {
  if (s.unavailable || s.failed > 0) return 'bad'
  if (s.stopped > 0 || s.total === 0) return 'warn'
  return 'neutral'
}

function serviceBadge(s: OverviewSummary['services']): { label: string; tone: BadgeTone } {
  if (s.unavailable || s.failed > 0) return { label: 'error', tone: 'bad' }
  if (s.stopped > 0 || s.total === 0) return { label: 'attention', tone: 'warn' }
  return { label: 'healthy', tone: 'ok' }
}

function workerStopped(w: OverviewSummary['workers']): number {
  return Math.max(0, w.total - w.enabled)
}

function workerTone(w: OverviewSummary['workers']): Tone {
  if (!w.alive || w.failed > 0) return 'bad'
  if (workerStopped(w) > 0 || w.total === 0) return 'warn'
  return 'neutral'
}

function workerBadge(w: OverviewSummary['workers']): { label: string; tone: BadgeTone } {
  if (!w.alive || w.failed > 0) return { label: 'error', tone: 'bad' }
  if (workerStopped(w) > 0 || w.total === 0) return { label: 'attention', tone: 'warn' }
  return { label: 'healthy', tone: 'ok' }
}

function mcpSessionTone(s: OverviewSummary['mcpSessions']): Tone {
  return s.serviceStatus === 'error' ? 'bad' : 'neutral'
}

function mcpSessionBadge(s: OverviewSummary['mcpSessions']): { label: string; tone: BadgeTone } {
  if (s.serviceStatus === 'error') return { label: 'error', tone: 'bad' }
  if (s.active > 0) return { label: 'active', tone: 'ok' }
  return { label: 'no active sessions', tone: 'neutral' }
}

function OverviewCard({
  href,
  label,
  value,
  meta,
  tone = 'neutral',
  badge,
  badgeTone = 'neutral',
  actionLabel = 'Open details',
  compact = false,
  valueClassName,
  dataHealthState,
  spark,
}: {
  href: string
  label: string
  value: string
  meta: string
  tone?: Tone
  badge?: string
  badgeTone?: BadgeTone
  actionLabel?: string
  compact?: boolean
  valueClassName?: string
  dataHealthState?: string
  spark?: React.ReactNode
}) {
  return (
    <Link
      href={href}
      className={`overview-card ${tone}${compact ? ' compact' : ''}`}
      aria-label={`${label}: ${value}`}
      data-health-state={dataHealthState}
    >
      <span className="overview-card-head">
        <span className="overview-card-label">{label}</span>
        {badge ? <span className={`state-badge ${badgeTone}`}>{badge}</span> : null}
      </span>
      <span className={`overview-card-value${valueClassName ? ` ${valueClassName}` : ''}`}>{value}</span>
      <span className="overview-card-meta">{meta}</span>
      <span className="overview-card-action">{actionLabel}</span>
      {spark}
    </Link>
  )
}

function hrefWithSpace(href: string, space: 'personal' | 'shared'): string {
  const [path, rawQuery = ''] = href.split('?')
  const params = new URLSearchParams(rawQuery)
  params.set('space', space)
  return `${path}?${params.toString()}`
}

/** Overview — control-plane summary (admin+; a plain member lands on /memories). */
export default async function OverviewPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = searchParams ? await searchParams : {}
  const space = (Array.isArray(params.space) ? params.space[0] : params.space) === 'shared' ? 'shared' : 'personal'
  const localWho = await requireControlPlane()
  const who = space === 'shared' ? await api.memoryWhoami('shared') : localWho
  const overview = await api.getOverview(space)
  const personalMode = localWho.deploymentMode === 'local' && space === 'personal'
  const peopleHref = hrefWithSpace(space === 'shared' ? '/teams' : '/team-settings', space)
  const showSettingsLink = isSuperuserLevel(who.adminLevel)
  const mcpSessions = overview.mcpSessions ?? { active: 0, stream: 0, legacy: 0, serviceStatus: 'unknown' as const }
  const servicesBadge = serviceBadge(overview.services)
  const workersBadge = workerBadge(overview.workers)
  const mcpBadge = mcpSessionBadge(mcpSessions)
  const workerStoppedCount = workerStopped(overview.workers)
  const factExtractionHealth = capabilityHealthPresentation(overview.capabilityHealth.factExtraction)
  const embeddingsHealth = capabilityHealthPresentation(overview.capabilityHealth.embeddings)

  // The lower row is supplementary: the graph being unreachable must degrade these
  // panels, never fail the whole control-plane summary.
  const [activityResult, facetsResult] = await Promise.allSettled([
    api.getMemoryGraphActivity({ projects: [], tags: [], badges: [], validity: 'all' }, space),
    api.getMemoryGraphFacets({ facet: 'badges' }, space),
  ])
  const activityEvents: MemoryGraphActivity[] = activityResult.status === 'fulfilled' ? activityResult.value.events ?? [] : []
  const badgeFacets: MemoryGraphFacet[] = facetsResult.status === 'fulfilled' ? facetsResult.value.badges ?? [] : []
  const activityUnavailable = activityResult.status === 'rejected'
  const facetsUnavailable = facetsResult.status === 'rejected'
  const now = Date.now()
  const writeBuckets = hourlyBuckets(activityEvents.filter((e) => e.kind !== 'read'), now)
  const writesLastDay = writeBuckets.reduce((sum, n) => sum + n, 0)

  // One incident line, highest severity first, so a degraded stack states itself
  // before the reader has to interpret six cards.
  const incident = overview.services.unavailable
    ? {
        title: 'Docker control sidecar is unavailable',
        detail: 'Service state cannot be read and start/stop actions are disabled. Running services are unaffected.',
        href: hrefWithSpace('/services', space),
        actionLabel: 'Open Services',
      }
    : overview.capabilityHealth.factExtraction.state === 'unhealthy'
      ? {
          title: 'Fact extraction is failing',
          detail: `${overview.capabilityHealth.factExtraction.safeMessage ?? 'The extraction provider is returning errors.'} New memories are queued, not lost; reads and search are unaffected.`,
          href: hrefWithSpace('/settings?setting=fact-extraction', space),
          actionLabel: 'Open settings',
        }
      : overview.capabilityHealth.embeddings.state === 'unhealthy'
        ? {
            title: 'Embeddings are failing',
            detail: `${overview.capabilityHealth.embeddings.safeMessage ?? 'The embedding provider is returning errors.'} Search results stay incomplete until this recovers.`,
            href: hrefWithSpace('/settings?setting=embeddings', space),
            actionLabel: 'Open settings',
          }
        : overview.services.failed > 0
          ? {
              title: `${overview.services.failed} service${overview.services.failed === 1 ? '' : 's'} failed`,
              detail: 'Memory operations that depend on the failed containers will error until they are restarted.',
              href: hrefWithSpace('/services', space),
              actionLabel: 'Open Services',
            }
          : !overview.workers.alive
            ? {
                title: 'The worker process is not reporting',
                detail: 'Scheduled jobs — embedding backfill and graph consolidation — are not running. Stored memories are unaffected.',
                href: hrefWithSpace('/workers', space),
                actionLabel: 'Open Workers',
              }
            : null

  return (
    <div className="overview-page">
      <OverviewAutoRefresh />
      {incident ? (
        <OverviewIncident
          title={incident.title}
          detail={incident.detail}
          href={incident.href}
          actionLabel={incident.actionLabel}
        />
      ) : null}
      <section className="overview-grid" aria-label="Dashboard summary">
        {!personalMode ? (
          <OverviewCard
            href={peopleHref}
            label="Team & Users"
            value={`${compact(overview.counts.teams)} / ${compact(overview.counts.users)}`}
            meta={`${overview.counts.superusers} superuser, ${overview.counts.admins} admin`}
            tone="accent"
            badge="teams / users"
          />
        ) : null}
        <OverviewCard
          href={hrefWithSpace('/services', space)}
          label="Services"
          value={overview.services.unavailable ? 'Unavailable' : `${overview.services.active}/${overview.services.total}`}
          meta={
            overview.services.unavailable
              ? 'Docker control sidecar unavailable'
              : `${overview.services.active} active, ${overview.services.stopped} stopped, ${overview.services.failed} failed`
          }
          tone={serviceTone(overview.services)}
          badge={servicesBadge.label}
          badgeTone={servicesBadge.tone}
        />
        <OverviewCard
          href={hrefWithSpace('/services?tab=mcp', space)}
          label="MCP sessions"
          value={compact(mcpSessions.active)}
          meta="Sessions managed by stream MCP service"
          tone={mcpSessionTone(mcpSessions)}
          badge={mcpBadge.label}
          badgeTone={mcpBadge.tone}
        />
        <OverviewCard
          href={hrefWithSpace('/workers', space)}
          label="Workers"
          value={`${overview.workers.enabled}/${overview.workers.total}`}
          meta={`${overview.workers.enabled} active, ${workerStoppedCount} stopped, ${overview.workers.failed} failed`}
          tone={workerTone(overview.workers)}
          badge={workersBadge.label}
          badgeTone={workersBadge.tone}
        />
        <OverviewCard
          href={hrefWithSpace('/usage', space)}
          label="Token usage"
          value={compact(overview.usage.tokens)}
          meta={`${compact(overview.usage.requests)} requests in 24h, ${money(overview.usage.cost)}`}
          tone="neutral"
          badge="24h"
          badgeTone="neutral"
        />
        <OverviewCard
          href={hrefWithSpace(`/memories?surface=${space}`, space)}
          label="Saved Memories"
          value={compact(overview.counts.memories)}
          meta={
            activityUnavailable
              ? 'Browse, search, verify, and edit memory records'
              : `${writesLastDay} written or updated in the last 24h`
          }
          tone="neutral"
          spark={<Sparkline points={writeBuckets} />}
        />
      </section>

      {showSettingsLink ? (
        <section className="overview-runtime-grid" aria-label="Model settings">
          <OverviewCard
            href={hrefWithSpace('/settings?setting=fact-extraction', space)}
            label="Fact extraction"
            value={overview.settings.factExtractionModel}
            meta={`${factExtractionHealth.message} Observed ${factExtractionHealth.observedAt}.`}
            tone={factExtractionHealth.tone}
            badge={factExtractionHealth.badge}
            badgeTone={factExtractionHealth.tone}
            actionLabel="Open settings"
            compact
            valueClassName="overview-card-model mono"
            dataHealthState={overview.capabilityHealth.factExtraction.state}
          />
          <OverviewCard
            href={hrefWithSpace('/settings?setting=embeddings', space)}
            label="Embeddings"
            value={`${overview.settings.activeEmbedModel} @ ${overview.settings.activeEmbedDim}`}
            meta={`${embeddingsHealth.message} Observed ${embeddingsHealth.observedAt}.`}
            tone={embeddingsHealth.tone}
            badge={embeddingsHealth.badge}
            badgeTone={embeddingsHealth.tone}
            actionLabel="Open settings"
            compact
            valueClassName="overview-card-model mono"
            dataHealthState={overview.capabilityHealth.embeddings.state}
          />
        </section>
      ) : null}

      <section className="overview-lower" aria-label="Memory activity and corpus shape">
        <MemoryActivityPanel
          events={activityEvents}
          now={now}
          unavailable={activityUnavailable}
          href={hrefWithSpace(`/memories?surface=${space}&tab=graph`, space)}
        />
        <CorpusShapePanel
          badges={badgeFacets}
          total={overview.counts.memories}
          unavailable={facetsUnavailable}
          href={hrefWithSpace(`/memories?surface=${space}`, space)}
        />
      </section>
    </div>
  )
}
