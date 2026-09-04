'use client'

/**
 * The interactive Memories UI. Reads are universal; edit/delete is gated per role
 * (member → own-created; admin → their team; super-admin → any team). Every
 * team member gets scoped bulk deletion; export/import/rebuild remain admin-only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { Memory, Team, WhoAmI, PendingEmbeddings, MemorySurface, GraphDeletePreview, BulkGraphDeletePreview } from '@/lib/types'
import { Select } from '@/components/ui/Select'
import { ConfidenceRangeSelect } from '@/components/ui/ConfidenceRangeSelect'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Icon } from '@/components/ui/Icon'
import { Tooltip } from '@/components/ui/Tooltip'
import { useToast } from '@/components/ui/Toast'
import { memoryImportNotice } from '@/lib/memoryImportResult'
import { handleMemoryUpdateResult } from '@/lib/memoryUpdateResult'
import { DashboardTools } from './DashboardTools'
import { MemoryGraphShell } from './graph/MemoryGraphShell'
import {
  listMemoriesAction,
  searchMemoriesAction,
  updateMemoryAction,
  deleteMemoryAction,
  previewMemoryDeleteAction,
  previewBulkDeleteAction,
  bulkDeleteAction,
  exportMemoriesAction,
  importMemoriesAction,
  pendingEmbeddingsAction,
  runBackfillAction,
  rebuildMemoryGraphAction,
} from './actions'

/** The persisted memory-category enum (matches the Shape gate). */
const CATEGORY_OPTS = [
  'gotcha',
  'fix',
  'user-correction',
  'tool-gap',
  'prd',
  'migration-pattern',
  'data-constraint',
  'permission',
  'flag-state',
]

type MemoryView = 'list' | 'graph' | 'tools'

const MEMORY_TIME_WIDTH = 112
const compactMemoryTime = new Intl.DateTimeFormat([], {
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
})
const fullMemoryTime = new Intl.DateTimeFormat([], {
  dateStyle: 'full',
  timeStyle: 'long',
})

function MemoryTimeCell({ value }: { value: string }) {
  const date = new Date(value)
  const valid = !Number.isNaN(date.getTime())
  return (
    <Tooltip as="div" className="memory-time-cell" label={valid ? fullMemoryTime.format(date) : value}>
      <time dateTime={value}>{valid ? compactMemoryTime.format(date) : 'Unknown'}</time>
    </Tooltip>
  )
}

const fixedMemoryColumn = (width: number) => `minmax(${width}px, ${width}px)`

const estimateMemoryColumnWidth = (values: string[], min: number, extra = 28, charWidth = 6.8) => {
  const longest = values.reduce((max, value) => Math.max(max, value.length), 0)
  return Math.max(min, Math.ceil(longest * charWidth + extra))
}

export function MemoriesClient({
  who,
  surface,
  isAdmin,
  canRunBackfill,
  graphEnabled,
  initial,
  initialTotal,
  initialNextCursor,
  initialBadges,
  teams,
  users,
  projects,
  projectScopes,
  initialPending,
}: {
  who: WhoAmI
  surface: MemorySurface
  isAdmin: boolean
  canRunBackfill: boolean
  graphEnabled: boolean
  initial: Memory[]
  initialTotal: number
  initialNextCursor: string | null
  initialBadges: string[]
  teams: Team[]
  users: { id: string; label: string }[]
  projects: string[]
  projectScopes: { name: string; teamId: string }[]
  initialPending: PendingEmbeddings | null
}) {
  const isPersonalSurface = surface === 'personal'
  const showTeamColumn = surface === 'shared'
  const [rows, setRows] = useState<Memory[]>(initial)
  const [total, setTotal] = useState(initialTotal)
  const [nextCursor, setNextCursor] = useState(initialNextCursor)
  const [badges, setBadges] = useState(initialBadges)
  const pathname = usePathname()
  const router = useRouter()
  const searchParams = useSearchParams()
  // Personal Memories never needs a shared-team binding. Shared tools remain
  // tied to the caller's current team so their destructive scope is explicit.
  const canUseMemoryTools = isPersonalSurface || !!who.teamId
  const requestedView = searchParams.get('tab')
  const activeView: MemoryView = requestedView === 'graph' && graphEnabled
    ? 'graph'
    : requestedView === 'tools' && canUseMemoryTools
      ? 'tools'
      : 'list'
  const [query, setQuery] = useState('')
  const [filterTeam, setFilterTeam] = useState('')
  const [filterProject, setFilterProject] = useState('')
  const [filterBadge, setFilterBadge] = useState('')
  const [scoreMin, setScoreMin] = useState('')
  const [scoreMax, setScoreMax] = useState('')
  const [editing, setEditing] = useState<Memory | null>(null)
  const [viewing, setViewing] = useState<Memory | null>(null)
  const [deleting, setDeleting] = useState<{ memory: Memory; preview: GraphDeletePreview } | null>(null)
  const [bulkDeleting, setBulkDeleting] = useState<BulkGraphDeletePreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<PendingEmbeddings | null>(initialPending)
  const refreshInFlight = useRef(false)
  const loadMoreInFlight = useRef(false)
  const scrollBodyRef = useRef<HTMLDivElement>(null)
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null)
  const toast = useToast()

  const teamName = (id: string) => teams.find((t) => t.id === id)?.name ?? `${id.slice(0, 8)}…`
  const authorName = (id: string | null) => {
    if (!id) return 'System'
    const label = users.find((u) => u.id === id)?.label
    if (label) return id === who.userId ? `${label} (you)` : label
    return id === who.userId ? 'you' : `${id.slice(0, 8)}…`
  }
  const memoryTeamName = (m: Memory) => {
    if (isPersonalSurface) return 'Personal'
    if (isAdmin) return teamName(m.teamId)
    if (who.teamId === m.teamId) return who.teamName ?? 'your team'
    return m.isOwnTeam ? 'your team' : `team ${m.teamId.slice(0, 8)}…`
  }
  const canMutate = (m: Memory) => isAdmin || m.createdById === who.userId
  const tableColumns = useMemo(() => {
    const projectWidth = estimateMemoryColumnWidth(['Project', ...rows.map((m) => m.project)], 126)
    const categoryWidth = Math.max(
      132,
      ...rows.map((m) => {
        const confidenceWidth = typeof m.confidence === 'number' ? 48 : 0
        const statusBadgeWidth = m.embeddingStatus === 'pending' ? 78 : 0
        const primaryWidth = m.graphPrimary ? 92 : 0
        return estimateMemoryColumnWidth([m.category, 'Category'], 132, 28 + confidenceWidth + statusBadgeWidth + primaryWidth)
      }),
    )
    const teamWidth = showTeamColumn
      ? estimateMemoryColumnWidth(['Team', ...rows.map((m) => (isAdmin ? teamName(m.teamId) : m.isOwnTeam ? 'your team' : 'other'))], 120)
      : 0
    const authorWidth = estimateMemoryColumnWidth(['Author', ...rows.map((m) => authorName(m.createdById))], 116)
    const actionsWidth = Math.max(84,
      ...rows.map((m) => {
        if (!canMutate(m)) return estimateMemoryColumnWidth(['Read-Only', 'Actions'], 116)
        const count = 2
        return Math.max(84, 28 + count * 26 + Math.max(0, count - 1) * 8)
      }),
    )
    const contentTrack = 'minmax(0, 1fr)'
    return showTeamColumn
      ? [
          contentTrack,
          fixedMemoryColumn(projectWidth),
          fixedMemoryColumn(categoryWidth),
          fixedMemoryColumn(MEMORY_TIME_WIDTH),
          fixedMemoryColumn(MEMORY_TIME_WIDTH),
          fixedMemoryColumn(teamWidth),
          fixedMemoryColumn(authorWidth),
          fixedMemoryColumn(actionsWidth),
        ].join(' ')
      : [
          contentTrack,
          fixedMemoryColumn(projectWidth),
          fixedMemoryColumn(categoryWidth),
          fixedMemoryColumn(MEMORY_TIME_WIDTH),
          fixedMemoryColumn(MEMORY_TIME_WIDTH),
          fixedMemoryColumn(authorWidth),
          fixedMemoryColumn(actionsWidth),
        ].join(' ')
  }, [isAdmin, rows, showTeamColumn, teams, users, who.userId])

  const selectMemoryTab = (view: MemoryView) => {
    const params = new URLSearchParams(searchParams.toString())
    if (view === 'list') params.delete('tab')
    else params.set('tab', view)
    const queryString = params.toString()
    router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false })
  }

  const wrap = async (fn: () => Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const wrapResult = async <T,>(fn: () => Promise<T>) => {
    setBusy(true)
    try {
      return await fn()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
      throw e
    } finally {
      setBusy(false)
    }
  }

  const parsedScore = (value: string) => {
    const parsed = Number(value)
    return value.trim() === '' || Number.isNaN(parsed) ? undefined : parsed
  }

  const loadRows = useCallback(async (cursor?: string) => {
    const project = filterProject || undefined
    const teamId = showTeamColumn ? filterTeam || undefined : undefined
    return query.trim()
      ? await searchMemoriesAction(query, teamId, project, filterBadge || undefined, parsedScore(scoreMin), parsedScore(scoreMax), surface)
      : await listMemoriesAction({
          teamId,
          project,
          category: filterBadge || undefined,
          cursor,
          limit: 50,
          scoreMin: parsedScore(scoreMin),
          scoreMax: parsedScore(scoreMax),
        }, surface)
  }, [filterBadge, filterProject, filterTeam, query, scoreMax, scoreMin, showTeamColumn, surface])

  const refresh = useCallback(async (opts: { silent?: boolean } = {}) => {
    if (refreshInFlight.current) return
    refreshInFlight.current = true
    if (!opts.silent) setBusy(true)
    try {
      const res = await loadRows()
      setRows(res.rows)
      setTotal(res.total)
      setNextCursor(res.nextCursor)
      // Search responses do not calculate facets. Retain the discovered list so an
      // active badge remains both visible and selectable while text search is on.
      if (res.badges.length > 0) setBadges(res.badges)
    } catch (e) {
      if (!opts.silent) toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      if (!opts.silent) setBusy(false)
      refreshInFlight.current = false
    }
  }, [loadRows, toast])

  const loadMore = useCallback(async () => {
    if (!nextCursor || query.trim() || loadMoreInFlight.current) return
    loadMoreInFlight.current = true
    try {
      const res = await loadRows(nextCursor)
      setRows((current) => {
        const known = new Set(current.map((row) => row.id))
        return [...current, ...res.rows.filter((row) => !known.has(row.id))]
      })
      setNextCursor(res.nextCursor)
      setBadges(res.badges)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e))
    } finally {
      loadMoreInFlight.current = false
    }
  }, [loadRows, nextCursor, query, toast])

  // Agent/API writes happen outside this React state; keep the visible table fresh.
  useEffect(() => {
    const id = setInterval(() => {
      if (scrollBodyRef.current?.scrollTop === 0) void refresh({ silent: true })
    }, 10_000)
    return () => clearInterval(id)
  }, [refresh])

  // Live dashboard filtering: dropdowns and typing update the visible list without
  // a separate Search click. Debounce typing so semantic fallback does not churn.
  useEffect(() => {
    if (activeView !== 'list') return
    const id = setTimeout(() => void refresh({ silent: true }), 300)
    return () => clearTimeout(id)
  }, [activeView, filterBadge, filterProject, filterTeam, query, refresh, scoreMax, scoreMin])

  useEffect(() => {
    const target = loadMoreSentinelRef.current
    const root = scrollBodyRef.current
    if (!target || !root || query.trim() || !nextCursor) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) void loadMore()
      },
      { root, rootMargin: '240px' },
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [loadMore, nextCursor, query])

  return (
    <div className="page-fill memories-page">
      <div className="memory-page-tabs service-view-switcher" role="tablist" aria-label="Memory sections">
        <button
          type="button"
          role="tab"
          aria-selected={activeView === 'list'}
          className={`service-view-button${activeView === 'list' ? ' active' : ''}`}
          onClick={() => selectMemoryTab('list')}
        >
           Memory List ({total.toLocaleString()})
        </button>
        {graphEnabled ? <>
          <span className="service-view-separator" aria-hidden="true" />
          <button
            type="button"
            role="tab"
            aria-selected={activeView === 'graph'}
            className={`service-view-button${activeView === 'graph' ? ' active' : ''}`}
            onClick={() => selectMemoryTab('graph')}
          >
            Memory Graph
          </button>
        </> : null}
        {canUseMemoryTools ? (
          <>
            <span className="service-view-separator" aria-hidden="true" />
            <button
              type="button"
              role="tab"
              aria-selected={activeView === 'tools'}
              className={`service-view-button${activeView === 'tools' ? ' active' : ''}`}
              onClick={() => selectMemoryTab('tools')}
            >
              Memory Tools
            </button>
          </>
        ) : null}
      </div>
      {activeView === 'list' ? (
        <div className="memory-list-pane">
      {/* Search + filters */}
      <form
        className="memory-filter-row"
        onSubmit={(e) => {
          e.preventDefault()
          void refresh()
        }}
      >
        <Input
          placeholder="Search memory text, project, category…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className="memory-search-input"
          icon={<Icon name="search" size={16} />}
        />
        {/* Team filter only belongs to the Shared Memories surface. */}
        {showTeamColumn && isAdmin && teams.length > 0 ? (
          <div className="memory-team-filter">
            <Select
              ariaLabel="Filter by team"
              value={filterTeam}
              onChange={setFilterTeam}
              options={[{ value: '', label: 'All teams' }, ...teams.map((t) => ({ value: t.id, label: t.name }))]}
            />
          </div>
        ) : null}
        {/* Project filter — populated from the backend (distinct projects in the corpus). */}
        {projects.length > 0 ? (
          <div className="memory-project-filter">
            <Select
              ariaLabel="Filter by project"
              value={filterProject}
              onChange={setFilterProject}
              options={[{ value: '', label: 'All projects' }, ...projects.map((p) => ({ value: p, label: p }))]}
            />
          </div>
        ) : null}
        <div className="memory-badge-filter">
          <Select
            ariaLabel="Filter by badge"
            value={filterBadge}
            onChange={setFilterBadge}
            options={[{ value: '', label: 'All badges' }, ...badges.map((badge) => ({ value: badge, label: badge }))]}
          />
        </div>
        <ConfidenceRangeSelect
          min={scoreMin || '0.0'}
          max={scoreMax || '1.0'}
          onChange={({ min, max }) => {
            setScoreMin(min === '0.0' ? '' : min)
            setScoreMax(max === '1.0' ? '' : max)
          }}
        />
        <button
          type="button"
          className="btn secondary"
          disabled={busy}
          onClick={() => {
            setQuery('')
            setFilterTeam('')
            setFilterProject('')
            setFilterBadge('')
            setScoreMin('')
            setScoreMax('')
          }}
        >
          Reset
        </button>
      </form>

      {/* The list */}
      <div className="gt table-scroll">
        <div className="gt-head" style={{ gridTemplateColumns: tableColumns }}>
          <div>Content</div>
          <div>Project</div>
          <div>Category</div>
          <div>Created</div>
          <div>Updated</div>
          {showTeamColumn ? <div>Team</div> : null}
          <div>Author</div>
          <div style={{ textAlign: 'right' }}>Actions</div>
        </div>
        <div ref={scrollBodyRef} className="gt-scroll-body">
          {rows.map((m) => (
            <div
              className="gt-row memory-row"
              key={m.id}
              role="button"
              tabIndex={0}
              aria-label={`Open memory details for ${m.id}`}
              onClick={() => setViewing(m)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setViewing(m)
                }
              }}
              style={{ gridTemplateColumns: tableColumns }}
            >
              <div>
                <Tooltip label="Open memory details">
                  <span className="memory-content-trigger">
                    {m.content.length > 160 ? `${m.content.slice(0, 160)}…` : m.content}
                  </span>
                </Tooltip>
              </div>
              <div className="mono" style={{ color: 'var(--soft)', fontSize: 11.5, whiteSpace: 'nowrap' }}>{m.project}</div>
              <div className="memory-category-badges">
                <span className="chip-category">{m.category}</span>
                {m.embeddingStatus === 'pending' ? (
                  <Tooltip label="Awaiting embedding (backfill target)">
                    <span className="badge warn-badge inline-icon-label" style={{ fontSize: 10 }}>
                      <Icon name="hourglass_empty" size={13} />
                      pending
                    </span>
                  </Tooltip>
                ) : null}
                {m.graphPrimary ? (
                  <Tooltip label="Graph primary source — deleting it cascades its primary graph facts">
                    <span className="badge warn-badge" style={{ fontSize: 10 }}>
                      graph primary
                    </span>
                  </Tooltip>
                ) : null}
                {typeof m.confidence === 'number' ? (
                  <Tooltip label={`Confidence ${m.confidence.toFixed(2)} · ${m.sourceProvenance ?? ''} · ${m.memoryTier ?? ''}`}>
                    <span className="badge" style={{ fontSize: 10, color: m.confidence < 0.5 ? 'var(--coral-soft)' : 'var(--soft)' }}>~{m.confidence.toFixed(2)}</span>
                  </Tooltip>
                ) : null}
              </div>
              <MemoryTimeCell value={m.createdAt} />
              <MemoryTimeCell value={m.recordUpdatedAt} />
              {showTeamColumn ? (
                <div style={{ color: 'var(--soft)', fontSize: 12 }}>{isAdmin ? teamName(m.teamId) : m.isOwnTeam ? 'your team' : 'other'}</div>
              ) : null}
              <Tooltip
                as="div"
                className="mono"
                label={authorName(m.createdById)}
                style={{ color: 'var(--muted)', fontSize: 12, whiteSpace: 'nowrap' }}
              >
                {authorName(m.createdById)}
              </Tooltip>
              <div style={{ textAlign: 'right' }} onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
                {canMutate(m) ? (
                  <div className="memory-actions">
                    <Tooltip label="Edit memory">
                      <button
                        type="button"
                        className="memory-action-button"
                        aria-label="Edit memory"
                        onClick={() => setEditing(m)}
                      >
                        <Icon name="edit" size={17} />
                      </button>
                    </Tooltip>
                    <Tooltip label="Delete memory">
                      <button
                        type="button"
                        className="memory-action-button danger"
                        disabled={busy}
                        aria-label="Delete memory"
                        onClick={() => {
                          if (isAdmin) {
                            void wrap(async () => {
                              const preview = await previewMemoryDeleteAction(m.id, surface)
                              setDeleting({ memory: m, preview })
                            })
                            return
                          }
                          void wrap(async () => {
                            await deleteMemoryAction(m.id, {}, surface)
                            setRows((rs) => rs.filter((x) => x.id !== m.id))
                            setTotal((n) => Math.max(0, n - 1))
                          })
                        }}
                      >
                        <Icon name="delete" size={17} />
                      </button>
                    </Tooltip>
                  </div>
                ) : <span className="badge-readonly">Read-Only</span>}
              </div>
            </div>
          ))}
          {!query.trim() && nextCursor ? (
            <div ref={loadMoreSentinelRef} className="memory-load-more" role="status">
              Loading more memories as you scroll…
            </div>
          ) : null}
          {rows.length === 0 ? <div className="gt-empty">No memories. <span style={{ color: 'var(--dim)' }}>Start an ingest or write one from your agent to populate this list.</span></div> : null}
        </div>
      </div>
      <p className="note" style={{ margin: '12px 2px 0' }}>
        {isPersonalSurface
          ? 'Personal memories stay in this local stack. You can manage the local records here; shared-memory team permissions only apply in the Shared Memories surface.'
          : <>Universal read. Edit/delete is gated by role: members → own-authored, team-admin → own team, super-admin → any team. Cross-team rows show <b>Read-Only</b>. Mounts extend MCP read scope (invisible here).</>}
      </p>
        </div>
      ) : activeView === 'graph' ? (
        <MemoryGraphShell surface={surface} />
      ) : canUseMemoryTools ? (
        <DashboardTools
          surface={surface}
          teams={teams}
          users={users}
          projectScopes={projectScopes}
          localTeamId={who.teamId ?? undefined}
          teamName={who.teamName}
          canManageAdminTools={isAdmin}
          isSuper={canRunBackfill}
          canRunBackfill={canRunBackfill}
          busy={busy}
          pending={pending}
          onExport={(teamId, project) => exportMemoriesAction({ teamId, project, surface })}
          onImport={(memories, teamId, project) => wrapResult(async () => {
            const r = await importMemoriesAction(memories, teamId, project, surface)
            const notice = memoryImportNotice(r)
            toast[notice.kind](notice.text)
            await refresh()
            return r
          })}
          onGraphRebuild={(input) => wrapResult(async () => {
            const r = await rebuildMemoryGraphAction({ ...input, surface })
            toast.success(`Graph rebuild queued for ${r.matched.toLocaleString()} memor${r.matched === 1 ? 'y' : 'ies'}.`)
            return r
          })}
          onRequestBulkDelete={(project) => void wrap(async () => {
            setBulkDeleting(await previewBulkDeleteAction(project, surface))
          })}
          onBackfill={() => void wrap(async () => {
            const r = await runBackfillAction()
            if (r.error) { toast.error(r.error); return }
            toast.success('Backfill triggered — see the Workers page for status.')
            // Give the worker a moment, then refresh counts + rows.
            await new Promise((res) => setTimeout(res, 1500))
            setPending(await pendingEmbeddingsAction(surface))
            await refresh()
          })}
        />
      ) : null}

      {viewing ? (
        <MemoryDetailsModal
          memory={viewing}
          teamLabel={showTeamColumn ? memoryTeamName(viewing) : null}
          authorLabel={authorName(viewing.createdById)}
          onClose={() => setViewing(null)}
        />
      ) : null}

      {editing ? (
        <EditModal
          memory={editing}
          isAdmin={isAdmin}
          teamLabel={showTeamColumn ? memoryTeamName(editing) : null}
          authorLabel={authorName(editing.createdById)}
          onClose={() => setEditing(null)}
          onSave={(patch) => wrap(async () => {
            const result = await updateMemoryAction({ id: editing.id, ...patch, surface })
            await handleMemoryUpdateResult(
              result,
              (error) => toast.error(error),
              async () => {
                setEditing(null)
                await refresh()
              },
            )
          })}
        />
      ) : null}

      {deleting ? (
        <PrimaryCascadeDeleteModal
          memory={deleting.memory}
          preview={deleting.preview}
          busy={busy}
          onClose={() => setDeleting(null)}
          onConfirm={() => void wrap(async () => {
            await deleteMemoryAction(deleting.memory.id, { previewToken: deleting.preview.token }, surface)
            setRows((rs) => rs.filter((x) => x.id !== deleting.memory.id))
            setTotal((n) => Math.max(0, n - 1))
            setDeleting(null)
          })}
        />
      ) : null}

      {bulkDeleting ? (
        <BulkDeletePreviewModal
          preview={bulkDeleting}
          busy={busy}
          onClose={() => setBulkDeleting(null)}
          onConfirm={() => void wrap(async () => {
            const deleted = await bulkDeleteAction({ previewToken: bulkDeleting.token, surface })
            toast.success(`Deleted ${deleted.toLocaleString()} memory row${deleted === 1 ? '' : 's'}.`)
            setBulkDeleting(null)
            await refresh()
          })}
        />
      ) : null}
    </div>
  )
}

function BulkDeletePreviewModal({
  preview,
  busy,
  onClose,
  onConfirm,
}: {
  preview: BulkGraphDeletePreview
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const hasPrimary = preview.primaryMemoryCount > 0
  const canConfirm = !hasPrimary || preview.canConfirmPrimary
  return (
    <Modal
      title={hasPrimary ? 'Review graph-primary bulk deletion' : 'Review bulk deletion'}
      onClose={onClose}
      width={620}
      accent
      footer={
        <>
          <button className="btn secondary" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn danger" disabled={busy || !canConfirm} onClick={onConfirm}>
            {hasPrimary ? 'Delete and cascade graph facts' : 'Delete selected memories'}
          </button>
        </>
      }
    >
      <p>This preview covers <b>{preview.memoryCount.toLocaleString()}</b> selected memor{preview.memoryCount === 1 ? 'y' : 'ies'} and <b>{preview.episodeCount.toLocaleString()}</b> recorded graph episode{preview.episodeCount === 1 ? '' : 's'}.</p>
      {hasPrimary ? (
        <p><b>{preview.primaryMemoryCount.toLocaleString()}</b> selected memor{preview.primaryMemoryCount === 1 ? 'y is' : 'ies are'} primary sources for <b>{preview.primaryFactCount.toLocaleString()}</b> current graph fact{preview.primaryFactCount === 1 ? '' : 's'}. Deleting them cascades those facts and any entities left without support.</p>
      ) : <p>No selected memory is currently a primary source. Deletion still removes the graph episodes recorded for every selected memory.</p>}
      {!canConfirm ? <p className="notice danger">A Shared team member cannot confirm a graph-primary cascade. Ask a team admin to review this scope.</p> : null}
      <p className="note">This confirmation token expires in five minutes and is rejected if any selected memory or graph episode changes before you confirm.</p>
    </Modal>
  )
}

function PrimaryCascadeDeleteModal({
  memory,
  preview,
  busy,
  onClose,
  onConfirm,
}: {
  memory: Memory
  preview: GraphDeletePreview
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const factCount = preview.primaryFactCount
  return (
    <Modal
      title={factCount > 0 ? 'Delete graph-primary memory?' : 'Delete memory?'}
      onClose={onClose}
      width={620}
      accent
      footer={
        <>
          <button className="btn secondary" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn danger" disabled={busy} onClick={onConfirm}>{factCount > 0 ? 'Delete and cascade graph facts' : 'Delete memory'}</button>
        </>
      }
    >
      {factCount > 0 ? <>
        <p>This memory is the primary source for <b>{factCount}</b> current graph fact{factCount === 1 ? '' : 's'}.</p>
        <p>Deleting it permanently removes those derived facts and any graph entities left without support. Later memories may remain as records, but the primary provenance chain is intentionally removed.</p>
      </> : <p>This live preview found no primary graph facts. Deletion still removes every graph episode recorded for this memory.</p>}
      <div className="memory-full-text">{memory.content}</div>
    </Modal>
  )
}

function MemoryDetailsModal({
  memory,
  teamLabel,
  authorLabel,
  onClose,
}: {
  memory: Memory
  teamLabel: string | null
  authorLabel: string
  onClose: () => void
}) {
  return (
    <Modal title="Memory details" onClose={onClose} width={720}>
      <MemoryMetaRow memory={memory} />
      <MemoryEgoGraph memory={memory} />
      <div>
        <span className="label">Full memory text</span>
        <div className="memory-full-text">{memory.content}</div>
      </div>
      <MemoryDetailBadges memory={memory} teamLabel={teamLabel} authorLabel={authorLabel} />
    </Modal>
  )
}

function MemoryEgoGraph({ memory }: { memory: Memory }) {
  const entities = memory.entities.slice(0, 8)
  if (entities.length === 0) return null
  const center = { x: 220, y: 92 }
  return (
    <section className="memory-ego-graph" aria-label={`Focused graph for memory ${memory.id}`}>
      <span className="label">Focused connections</span>
      <svg viewBox="0 0 440 184" role="img" aria-label={`${entities.length} entity connections for this memory`}>
        {entities.map((entity, index) => {
          const angle = (index / entities.length) * Math.PI * 2 - Math.PI / 2
          const x = center.x + Math.cos(angle) * 148
          const y = center.y + Math.sin(angle) * 64
          return <line key={`line-${entity}`} x1={center.x} y1={center.y} x2={x} y2={y} />
        })}
        <circle className="memory-ego-center" cx={center.x} cy={center.y} r="18" />
        <text className="memory-ego-center-label" x={center.x} y={center.y + 34}>memory {memory.id.slice(0, 8)}</text>
        {entities.map((entity, index) => {
          const angle = (index / entities.length) * Math.PI * 2 - Math.PI / 2
          const x = center.x + Math.cos(angle) * 148
          const y = center.y + Math.sin(angle) * 64
          return <g key={entity}><circle className="memory-ego-entity" cx={x} cy={y} r="8" /><text x={x} y={y + 20}>{entity.length > 20 ? `${entity.slice(0, 19)}…` : entity}</text></g>
        })}
      </svg>
      {memory.entities.length > entities.length ? <small>Showing 8 of {memory.entities.length.toLocaleString()} entity connections.</small> : null}
    </section>
  )
}

function EditModal({
  memory,
  isAdmin,
  teamLabel,
  authorLabel,
  onClose,
  onSave,
}: {
  memory: Memory
  isAdmin: boolean
  teamLabel: string | null
  authorLabel: string
  onClose: () => void
  onSave: (patch: { content?: string; project?: string; category?: string }) => void
}) {
  const [content, setContent] = useState(memory.content)
  const [project, setProject] = useState(memory.project)
  const [category, setCategory] = useState(memory.category)
  return (
    <Modal
      title="Edit memory"
      onClose={onClose}
      width={720}
      footer={
        <>
          <button className="btn secondary" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => onSave({ content, project, ...(isAdmin ? { category } : {}) })}>Save &amp; re-embed</button>
        </>
      }
    >
      <MemoryMetaRow memory={memory} />
      <label>
        <span className="label">Content</span>
        <textarea rows={6} value={content} onChange={(e) => setContent(e.target.value)} style={{ width: '100%' }} />
      </label>
      <div style={{ display: 'grid', gridTemplateColumns: isAdmin ? '1fr 1fr' : '1fr', gap: 14 }}>
        <label>
          <span className="label">Project</span>
          <Input value={project} onChange={(e) => setProject(e.target.value)} />
        </label>
        {isAdmin ? (
          <label>
            <span className="label">Category</span>
            <Select
              ariaLabel="Category"
              value={category}
              onChange={setCategory}
              options={(CATEGORY_OPTS.includes(category) ? CATEGORY_OPTS : [...CATEGORY_OPTS, category]).map((c) => ({ value: c, label: c }))}
            />
          </label>
        ) : null}
      </div>
      <MemoryDetailBadges
        memory={memory}
        teamLabel={teamLabel}
        authorLabel={authorLabel}
        includeCategory={false}
        includeProject={false}
      />
    </Modal>
  )
}

function MemoryMetaRow({ memory }: { memory: Memory }) {
  return (
    <div className="meta-row">
      <span>id {memory.id.slice(0, 8)}…</span>
      <span>created {new Date(memory.createdAt).toLocaleString()}</span>
      <span>updated {new Date(memory.recordUpdatedAt).toLocaleString()}</span>
      {memory.sessionId ? <span>session {memory.sessionId.slice(0, 8)}…</span> : null}
    </div>
  )
}

function MemoryDetailBadges({
  memory,
  teamLabel,
  authorLabel,
  includeCategory = true,
  includeProject = true,
}: {
  memory: Memory
  teamLabel: string | null
  authorLabel: string
  includeCategory?: boolean
  includeProject?: boolean
}) {
  return (
    <div>
      <span className="label">Details</span>
      <div className="memory-detail-badges">
        {includeCategory ? <DetailBadge label="category" value={memory.category} className="chip-category" /> : null}
        {includeProject ? <DetailBadge label="project" value={memory.project} mono /> : null}
        <DetailBadge label="user" value={authorLabel} />
        {teamLabel ? <DetailBadge label="team" value={teamLabel} /> : null}
        {typeof memory.score === 'number' ? <DetailBadge label="score" value={memory.score.toFixed(3)} mono /> : null}
        {typeof memory.confidence === 'number' ? <DetailBadge label="confidence" value={memory.confidence.toFixed(2)} mono /> : null}
        {memory.memoryTier ? <DetailBadge label="tier" value={memory.memoryTier} /> : null}
        {memory.sourceProvenance ? <DetailBadge label="source" value={memory.sourceProvenance} /> : null}
        {memory.shape ? <DetailBadge label="shape" value={memory.shape} mono /> : null}
        {memory.embeddingStatus ? (
          <DetailBadge
            label="embedding"
            value={memory.embeddingStatus}
            className={memory.embeddingStatus === 'pending' ? 'badge warn-badge' : undefined}
          />
        ) : null}
        {memory.graphPrimary ? <DetailBadge label="graph role" value={`primary source · ${memory.graphPrimaryFactCount ?? 0} fact${memory.graphPrimaryFactCount === 1 ? '' : 's'} cascade`} className="badge warn-badge" /> : null}
        {memory.entities.map((entity) => (
          <DetailBadge key={entity} label="entity" value={entity} mono className="chip-entity" />
        ))}
      </div>
    </div>
  )
}

function DetailBadge({
  label,
  value,
  className,
  mono,
}: {
  label: string
  value: string
  className?: string
  mono?: boolean
}) {
  const cls = className ?? 'badge-readonly'
  return (
    <span className={`memory-detail-badge ${cls}${mono ? ' mono' : ''}`}>
      <span className="memory-detail-badge-label">{label}</span>
      <span>{value}</span>
    </span>
  )
}
