import Link from 'next/link'
import { requireControlPlane } from '@/lib/session'
import { api } from '@/lib/api'
import { isSuperuserLevel } from '@/lib/authz'
import type { MemoryGraphFacet, OverviewSummary } from '@/lib/types'
import { capabilityHealthPresentation } from '@/lib/capabilityHealth'
import { streamMcpLogRef } from '@/lib/mcpSessionFormat'
import { McpLiveSessionsPanel } from './McpLiveSessionsPanel'
import { OverviewAutoRefresh } from './OverviewAutoRefresh'
import {
  CorpusShapePanel,
  OverviewIncident,
  Sparkline,
  dailyBuckets,
  relativeAgo,
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
  return 'ok'
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
  return 'ok'
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
      <span className="overview-card-action">{actionLabel} <span aria-hidden="true">→</span></span>
      {spark}
    </Link>
  )
}

/** Prototype capability meta — "Observed 4 min ago." — from the raw health timestamps. */
function observedLabel(health: OverviewSummary['capabilityHealth']['factExtraction'], now: number): string {
  const at = health.state === 'healthy' ? health.lastSuccessAt ?? health.observedAt : health.lastFailureAt ?? health.observedAt
  return at ? `Observed ${relativeAgo(at, now)}.` : 'Not observed yet.'
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

  // The lower row is supplementary: an unreachable graph or service monitor must degrade
  // these panels, never fail the whole control-plane summary.
  const [servicesResult, facetsResult, pendingResult, recentResult, usageResult] = await Promise.allSettled([
    // Live MCP sessions are held by the local API; the stream MCP container's log carries their output.
    api.listServices(),
    api.getMemoryGraphFacets({}, space),
    api.pendingEmbeddings(space),
    // Newest records first (the list API orders by createdAt desc): enough to draw the
    // corpus trend and count the last day without a dedicated stats endpoint.
    api.listMemories({ limit: 200 }, space),
    api.getUsage('24h', space),
  ])
  const liveClients = servicesResult.status === 'fulfilled' ? servicesResult.value.mcpClients : []
  const liveLogRef = servicesResult.status === 'fulfilled' ? streamMcpLogRef(servicesResult.value.services) : null
  const liveError = servicesResult.status === 'rejected'
    ? servicesResult.reason instanceof Error ? servicesResult.reason.message : 'The service monitor did not respond.'
    : undefined
  const badgeFacets: MemoryGraphFacet[] = facetsResult.status === 'fulfilled' ? facetsResult.value.badges ?? [] : []
  const facetsUnavailable = facetsResult.status === 'rejected'
  const now = Date.now()
  const recentRecords = recentResult.status === 'fulfilled' ? recentResult.value.results ?? [] : []
  const createdTimes = recentRecords.map((m) => m.createdAt)
  const writeBuckets = dailyBuckets(createdTimes, now)
  const writesLastDay = createdTimes.filter((t) => now - Date.parse(t) < 86_400_000).length
  // A full page entirely inside the last day means the true count is higher.
  const writesCapped = recentRecords.length >= 200 && writesLastDay >= recentRecords.length
  const usageTrend = usageResult.status === 'fulfilled' ? (usageResult.value.trend ?? []).map((p) => p.tokens) : []
  const entityCount = facetsResult.status === 'fulfilled' ? facetsResult.value.tags?.length ?? 0 : 0
  const projectCount = facetsResult.status === 'fulfilled' ? facetsResult.value.projects?.length ?? 0 : 0
  const pendingEmbedding = pendingResult.status === 'fulfilled' ? pendingResult.value.memories : 0
  // Prototype meta: recent writes plus anything still waiting to be searchable.
  const newestWrite = createdTimes[0]
  const savedMemoriesMeta = [
    writesLastDay > 0
      ? `+${writesCapped ? `${writesLastDay}+` : writesLastDay} in the last 24h`
      : newestWrite ? `No writes in 24h · last ${relativeAgo(newestWrite, now)}` : null,
    pendingEmbedding > 0 ? `${pendingEmbedding} awaiting embedding` : null,
  ].filter(Boolean).join(' · ') || 'No memories yet — your agents write here'

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
        {/* Prototype order: the corpus leads, then runtime, then cost, then graph. */}
        <OverviewCard
          href={hrefWithSpace(`/memories?surface=${space}`, space)}
          label="Saved Memories"
          value={compact(overview.counts.memories)}
          meta={savedMemoriesMeta}
          tone="neutral"
          badge={personalMode ? 'personal' : 'shared'}
          spark={<Sparkline points={writeBuckets} />}
        />
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
          spark={<Sparkline points={usageTrend} tone="var(--accent-2)" />}
        />
        <OverviewCard
          href={hrefWithSpace(`/memories?surface=${space}&tab=graph`, space)}
          label="Graph entities"
          value={facetsUnavailable ? '—' : compact(entityCount)}
          meta={
            facetsUnavailable
              ? 'Graph projection unavailable'
              : `${compact(projectCount)} project${projectCount === 1 ? '' : 's'} · ${compact(badgeFacets.length)} categories`
          }
          tone={facetsUnavailable ? 'warn' : 'neutral'}
        />
      </section>

      {showSettingsLink ? (
        <section className="overview-capabilities">
        <div className="section-label">Model capabilities</div>
        <div className="overview-runtime-grid" role="group" aria-label="Model settings">
          <OverviewCard
            href={hrefWithSpace('/settings?setting=fact-extraction', space)}
            label="Fact extraction"
            value={overview.settings.factExtractionModel}
            meta={`${factExtractionHealth.message} ${observedLabel(overview.capabilityHealth.factExtraction, now)}`}
            tone={factExtractionHealth.tone}
            badge={factExtractionHealth.badge === 'healthy' ? 'operational' : factExtractionHealth.badge}
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
            meta={`${embeddingsHealth.message} ${observedLabel(overview.capabilityHealth.embeddings, now)}`}
            tone={embeddingsHealth.tone}
            badge={embeddingsHealth.badge === 'healthy' ? 'operational' : embeddingsHealth.badge}
            badgeTone={embeddingsHealth.tone}
            actionLabel="Open settings"
            compact
            valueClassName="overview-card-model mono"
            dataHealthState={overview.capabilityHealth.embeddings.state}
          />
        </div>
        </section>
      ) : null}

      <section className="overview-lower" aria-label="Live MCP activity and corpus shape">
        <McpLiveSessionsPanel initialClients={liveClients} initialLogRef={liveLogRef} initialError={liveError} />
        <CorpusShapePanel
          badges={badgeFacets}
          unavailable={facetsUnavailable}
        />
      </section>
    </div>
  )
}
