'use client'

/**
 * The interactive Memories UI. Reads are universal; edit/delete is gated per role
 * (member → own-created; admin → their team; super-admin → any team). Every
 * team member gets scoped bulk deletion; export/import/rebuild remain admin-only.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import type { Memory, Team, WhoAmI, PendingEmbeddings, MemorySurface, GraphDeletePreview, BulkGraphDeletePreview } from '@/lib/types'
import { Select } from '@/components/ui/Select'
import { ConfidenceRangeSelect } from '@/components/ui/ConfidenceRangeSelect'
import { Input } from '@/components/ui/Input'
import { Modal } from '@/components/ui/Modal'
import { Icon } from '@/components/ui/Icon'
import { Tooltip } from '@/components/ui/Tooltip'
import { MemoryTimeCell } from '@/components/ui/MemoryTimeCell'
import { MemoryLattice } from '@/components/ui/MemoryLattice'
import { useToast } from '@/components/ui/Toast'
import { memoryImportNotice } from '@/lib/memoryImportResult'
import { handleMemoryUpdateResult } from '@/lib/memoryUpdateResult'
import { DashboardTools } from './DashboardTools'
import { MemoryGraphShell } from './graph/MemoryGraphShell'
import { NewMemoryModal } from './NewMemoryModal'
import {
  listMemoriesAction,
  createMemoryAction,
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
  const [creating, setCreating] = useState(false)
  const [viewing, setViewing] = useState<Memory | null>(null)
  const [deleting, setDeleting] = useState<{ memory: Memory; preview: GraphDeletePreview } | null>(null)
  // The scope travels with the preview: a bulk delete confirmation that cannot
  // name what it is about to delete is not a confirmation.
  const [bulkDeleting, setBulkDeleting] = useState<{ preview: BulkGraphDeletePreview; scope: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState<PendingEmbeddings | null>(initialPending)
  // Filter state drives three things: the reset affordance, the result line, and
  // which blank state the table shows when a query returns nothing.
  const filterCount = [
    query.trim(),
    filterTeam,
    filterProject,
    filterBadge,
    scoreMin || scoreMax,
  ].filter(Boolean).length
  const filtersActive = filterCount > 0
  const clearFilters = () => {
    setQuery('')
    setFilterTeam('')
    setFilterProject('')
    setFilterBadge('')
    setScoreMin('')
    setScoreMax('')
  }
  // What besides the search text narrows the list — named in the no-results state.
  const narrowing = [
    filterTeam ? teams.find((t) => t.id === filterTeam)?.name ?? 'team' : '',
    filterProject,
    filterBadge,
    scoreMin || scoreMax ? `confidence ${scoreMin || '0.0'} – ${scoreMax || '1.0'}` : '',
  ].filter(Boolean)
  const scopeFiltersActive = Boolean(filterTeam || filterProject || filterBadge)
  const searchEverywhere = () => {
    setFilterTeam('')
    setFilterProject('')
    setFilterBadge('')
  }
  const refreshInFlight = useRef(false)
  const loadMoreInFlight = useRef(false)
  const scrollBodyRef = useRef<HTMLDivElement>(null)
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null)
  const toast = useToast()
  // The top bar owns the prototype's "New memory" button; it signals this page.
  useEffect(() => {
    const open = () => setCreating(true)
    window.addEventListener('pm:new-memory', open)
    return () => window.removeEventListener('pm:new-memory', open)
  }, [])

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
        const statusBadgeWidth = m.embeddingStatus === 'pending' ? 30 : 0
        const primaryWidth = m.graphPrimary ? 30 : 0
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
    // A graph focus belongs to one "Open in graph" jump, not to the tab itself.
    params.delete('memory')
    if (view === 'list') params.delete('tab')
    else params.set('tab', view)
    const queryString = params.toString()
    router.replace(queryString ? `${pathname}?${queryString}` : pathname, { scroll: false })
  }

  // Record detail → graph: the graph tab selects this memory once its node loads.
  const openInGraph = (memory: Memory) => {
    const params = new URLSearchParams(searchParams.toString())
    params.set('tab', 'graph')
    params.set('memory', memory.id)
    setViewing(null)
    router.replace(`${pathname}?${params.toString()}`, { scroll: false })
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

  // Admins review the graph cascade first; members delete their own rows directly.
  const requestDelete = (m: Memory) => {
    setViewing(null)
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
  }

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
      <div className="memory-toolbar">
      <div className="memory-page-tabs service-view-switcher" role="tablist" aria-label="Memory sections">
        <button
          type="button"
          role="tab"
          aria-selected={activeView === 'list'}
          className={`service-view-button${activeView === 'list' ? ' active' : ''}`}
          onClick={() => selectMemoryTab('list')}
        >
          <Icon name="memory" size={15} /> Memories <span className="service-view-count">{total.toLocaleString()}</span>
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
            <Icon name="hub" size={15} /> Memory graph
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
              <Icon name="storage" size={15} /> Tools
            </button>
          </>
        ) : null}
      </div>
        <span className="memory-toolbar-note">Universal read · edit and delete gated by role</span>
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
            ariaLabel="Filter by category"
            value={filterBadge}
            onChange={setFilterBadge}
            options={[{ value: '', label: 'All categories' }, ...badges.map((badge) => ({ value: badge, label: badge }))]}
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
        {/* Prototype d-memories: the filter count is itself the reset control, and
            export sits in reach of the filtered view rather than only inside Tools. */}
        <span className="memory-filter-spacer" aria-hidden="true" />
        {filtersActive && rows.length === 0 ? (
          <button type="button" className="btn secondary" onClick={clearFilters}>
            <Icon name="close" size={15} /> Clear filters
          </button>
        ) : (
          <Tooltip label={filtersActive ? 'Clear all filters' : 'No filters applied'}>
            <button
              type="button"
              className="btn secondary memory-filter-count"
              disabled={busy || !filtersActive}
              onClick={clearFilters}
            >
              <Icon name="filter_alt" size={15} /> {filterCount} filter{filterCount === 1 ? '' : 's'}
            </button>
          </Tooltip>
        )}
        {canUseMemoryTools && !(filtersActive && rows.length === 0) ? (
          <button type="button" className="btn accent-quiet" onClick={() => selectMemoryTab('tools')}>
            <Icon name="download" size={15} /> Export
          </button>
        ) : null}
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
                    <span className="badge warn memory-flag" aria-label="Awaiting embedding"><Icon name="schedule" size={11} /></span>
                  </Tooltip>
                ) : null}
                {m.graphPrimary ? (
                  <Tooltip label="Graph primary source — deleting it cascades its primary graph facts">
                    <span className="badge warn memory-flag" aria-label="Graph primary source"><Icon name="hub" size={11} /></span>
                  </Tooltip>
                ) : null}
                {typeof m.confidence === 'number' ? (
                  <Tooltip label={`Confidence ${m.confidence.toFixed(2)} · ${m.sourceProvenance ?? ''} · ${m.memoryTier ?? ''}`}>
                    <span className={`badge${m.confidence < 0.5 ? ' bad' : ''}`}>~{m.confidence.toFixed(2)}</span>
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
                style={{ color: 'var(--soft)', fontSize: 11.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
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
                        <Icon name="edit" size={15} />
                      </button>
                    </Tooltip>
                    <Tooltip label="Delete memory">
                      <button
                        type="button"
                        className="memory-action-button danger"
                        disabled={busy}
                        aria-label="Delete memory"
                        onClick={() => requestDelete(m)}
                      >
                        <Icon name="delete" size={15} />
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
          {rows.length === 0 ? (
            filtersActive ? (
              // Prototype d-memories-noresult: name what narrows the corpus and hand
              // the filters back, rather than a dead end.
              <div className="memory-blank" role="status">
                <Icon name="search" size={30} className="memory-blank-icon" />
                <strong>{query.trim() ? 'No memories match this search' : 'No memories match these filters'}</strong>
                <span>
                  {/* Search returns nearest neighbours rather than threshold matches, so it
                      is the combination with filters that empties the list. Say that. */}
                  {query.trim() ? <>Nothing matched <b>“{query.trim()}”</b></> : <>No stored memory matches</>}
                  {narrowing.length > 0 ? (
                    <> within {narrowing.map((label, index) => <span key={label}>{index > 0 ? ' · ' : ''}<code>{label}</code></span>)}</>
                  ) : null}.
                </span>
                <div className="memory-blank-actions">
                  {query.trim() && scopeFiltersActive ? (
                    <button type="button" className="btn primary" onClick={searchEverywhere}>Search all projects and categories</button>
                  ) : (
                    <button type="button" className="btn primary" onClick={clearFilters}>Clear all filters</button>
                  )}
                  {scoreMin || scoreMax ? (
                    <button
                      type="button"
                      className="btn secondary"
                      onClick={() => {
                        setScoreMin('')
                        setScoreMax('')
                      }}
                    >
                      Lower the confidence filter
                    </button>
                  ) : null}
                </div>
                <span className="memory-blank-foot">{filterCount} filter{filterCount === 1 ? ' is' : 's are'} narrowing {total.toLocaleString()} record{total === 1 ? '' : 's'} down to 0.</span>
              </div>
            ) : (
              <div className="memory-blank" role="status">
                <MemoryLattice width={220} height={118} opacity={0.55} className="memory-blank-art" />
                <strong>No memories yet</strong>
                <span>
                  Your agents write here. Start a session in Claude or Codex and ask it to remember
                  something — or import an existing corpus from the Tools tab.
                </span>
                <div className="memory-blank-actions">
                  <button type="button" className="btn primary" onClick={() => selectMemoryTab('tools')}>
                    <Icon name="upload" size={15} /> Import memories
                  </button>
                  <Link className="btn secondary" href={`/documentation?space=${surface}`}>
                    <Icon name="menu_book" size={15} /> How agents write memory
                  </Link>
                </div>
              </div>
            )
          ) : null}
        </div>
      </div>
      {/* Prototype d-memories: one footnote carries the loaded count and the role gate. */}
      <p className="note memory-footnote" role="status">
        {rows.length > 0 ? (
          <>
            Showing {rows.length.toLocaleString()} of <b>{total.toLocaleString()}</b>
            {filtersActive ? ` matching ${filterCount} filter${filterCount === 1 ? '' : 's'}` : null}
            {!query.trim() && nextCursor ? ' · scroll to load more' : null}.{' '}
          </>
        ) : null}
        {isPersonalSurface
          ? 'Edit and delete are gated by role: members → own-authored, team-admin → own team.'
          : <>Edit and delete are gated by role: members → own-authored, team-admin → own team, super-admin → any team. Cross-team rows show <b>Read-Only</b>.</>}
      </p>
        </div>
      ) : activeView === 'graph' ? (
        <MemoryGraphShell surface={surface} focusMemoryId={searchParams.get('memory')} />
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
            setBulkDeleting({
              preview: await previewBulkDeleteAction(project, surface),
              scope: project?.trim() || 'all projects',
            })
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
          canMutate={canMutate(viewing)}
          busy={busy}
          graphEnabled={graphEnabled}
          onClose={() => setViewing(null)}
          onEdit={() => {
            setEditing(viewing)
            setViewing(null)
          }}
          onDelete={() => requestDelete(viewing)}
          onOpenGraph={() => openInGraph(viewing)}
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

      {creating ? (
        <NewMemoryModal
          projects={projects}
          busy={busy}
          onClose={() => setCreating(false)}
          onCreate={(input) => void wrap(async () => {
            const result = await createMemoryAction(input, surface)
            if (!result.ok) {
              toast.error(result.error)
              return
            }
            toast.success(result.embeddingStatus === 'pending' ? 'Memory saved. Embedding is queued.' : 'Memory saved and embedded.')
            setCreating(false)
            await refresh()
          })}
        />
      ) : null}

      {bulkDeleting ? (
        <BulkDeletePreviewModal
          preview={bulkDeleting.preview}
          scope={bulkDeleting.scope}
          busy={busy}
          onClose={() => setBulkDeleting(null)}
          onConfirm={() => void wrap(async () => {
            const deleted = await bulkDeleteAction({ previewToken: bulkDeleting.preview.token, surface })
            toast.success(`Deleted ${deleted.toLocaleString()} memory row${deleted === 1 ? '' : 's'}.`)
            setBulkDeleting(null)
            await refresh()
          })}
        />
      ) : null}
    </div>
  )
}

/** Impact rows shared by both destructive confirmations (prototype `.kv`). */
function DeleteImpact({ rows }: { rows: { label: string; value: string; tone?: 'warn' | 'danger' }[] }) {
  return (
    <div className="kv delete-impact">
      {rows.map((row) => (
        <div key={row.label} className="kv-row">
          <span>{row.label}</span>
          <b className={row.tone ? `mono ${row.tone}` : 'mono'}>{row.value}</b>
        </div>
      ))}
    </div>
  )
}

function BulkDeletePreviewModal({
  preview,
  scope,
  busy,
  onClose,
  onConfirm,
}: {
  preview: BulkGraphDeletePreview
  scope: string
  busy: boolean
  onClose: () => void
  onConfirm: () => void
}) {
  const hasPrimary = preview.primaryMemoryCount > 0
  const permitted = !hasPrimary || preview.canConfirmPrimary
  // Typing the scope is the gate. A bulk delete is unrecoverable and the count
  // alone is too easy to click past.
  const [typed, setTyped] = useState('')
  const matches = typed.trim() === scope
  const canConfirm = permitted && matches
  const memories = `memor${preview.memoryCount === 1 ? 'y' : 'ies'}`
  return (
    <Modal
      icon={<Icon name="warning" size={18} className="tone-danger" />}
      title="Review bulk delete"
      onClose={onClose}
      width={580}
      footer={
        <>
          <button className="btn secondary" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn danger" disabled={busy || !canConfirm} onClick={onConfirm}>
            {hasPrimary
              ? `Delete ${preview.memoryCount.toLocaleString()} ${memories} and cascade ${preview.primaryFactCount.toLocaleString()} fact${preview.primaryFactCount === 1 ? '' : 's'}`
              : `Delete ${preview.memoryCount.toLocaleString()} ${memories}`}
          </button>
        </>
      }
    >
      <div className="notice with-icon fault delete-warning">
        <span className="n-ic"><Icon name="error_outline" size={16} /></span>
        <span className="n-body">
          <span className="notice-title">This deletes {preview.memoryCount.toLocaleString()} {memories} permanently</span>
          There is no undo and no trash. Export first if you are not certain.
        </span>
      </div>

      <p className="memory-delete-summary">
        This preview covers <b>{preview.memoryCount.toLocaleString()}</b> selected {memories} and{' '}
        <b>{preview.episodeCount.toLocaleString()}</b> recorded graph episode{preview.episodeCount === 1 ? '' : 's'}.
      </p>

      <DeleteImpact
        rows={[
          { label: 'Scope', value: scope },
          { label: 'Memories', value: preview.memoryCount.toLocaleString() },
          { label: 'Graph-primary memories', value: preview.primaryMemoryCount.toLocaleString(), tone: hasPrimary ? 'warn' : undefined },
          { label: 'Graph facts cascaded', value: preview.primaryFactCount.toLocaleString(), tone: hasPrimary ? 'danger' : undefined },
        ]}
      />

      {hasPrimary ? (
        <div className="notice with-icon warn">
          <span className="n-ic"><Icon name="warning" size={16} /></span>
          <span className="n-body">
            {preview.primaryMemoryCount.toLocaleString()} of these memories are primary sources. Deleting them removes{' '}
            {preview.primaryFactCount.toLocaleString()} derived fact{preview.primaryFactCount === 1 ? '' : 's'} that other
            memories may still reference by name.
          </span>
        </div>
      ) : null}

      {!permitted ? (
        <div className="notice with-icon danger">
          <span className="n-ic"><Icon name="error_outline" size={16} /></span>
          <span className="n-body">A Shared team member cannot confirm a graph-primary cascade. Ask a team admin to review this scope.</span>
        </div>
      ) : (
        <div className="field delete-confirm-field">
          <label htmlFor="bulk-delete-confirm">
            Type <code>{scope}</code> to confirm
          </label>
          <input
            id="bulk-delete-confirm"
            className={`ui-input mono${typed && !matches ? ' invalid' : ''}`}
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={scope}
            autoComplete="off"
            spellCheck={false}
          />
          {typed && !matches ? (
            <span className="field-error"><Icon name="error_outline" size={13} /> Enter the scope exactly to enable deletion.</span>
          ) : null}
        </div>
      )}

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
  const cascades = factCount > 0
  const facts = `fact${factCount === 1 ? '' : 's'}`
  return (
    <Modal
      icon={<Icon name="warning" size={18} className="tone-danger" />}
      title={cascades ? 'Delete memory and cascade graph facts' : 'Delete memory'}
      onClose={onClose}
      width={540}
      footer={
        <>
          <button className="btn secondary" disabled={busy} onClick={onClose}>Cancel</button>
          <button className="btn danger" disabled={busy} onClick={onConfirm}>
            <Icon name="delete" size={14} /> {cascades ? `Delete and cascade ${factCount} ${facts}` : 'Delete memory'}
          </button>
        </>
      }
    >
      <div className={`notice with-icon ${cascades ? 'fault' : 'warn'} delete-warning`}>
        <span className="n-ic"><Icon name="error_outline" size={16} /></span>
        <span className="n-body">
          {cascades ? (
            <>
              This memory is the primary source for <b>{factCount.toLocaleString()} current graph {facts}</b>. Deleting it
              permanently removes those derived facts and any graph entities left without support.
            </>
          ) : (
            'This deletes the memory permanently. The graph episodes recorded for it are removed too.'
          )}
        </span>
      </div>
      <p className="note">
        {cascades
          ? 'Later memories may remain as records, but the primary provenance chain is intentionally removed. This cannot be undone.'
          : 'There is no undo and no trash.'}
      </p>

      <div className="memory-full-text memory-delete-excerpt">{memory.content}</div>

      <DeleteImpact
        rows={[
          { label: 'Project', value: memory.project },
          { label: 'Graph facts removed', value: factCount.toLocaleString(), tone: cascades ? 'danger' : undefined },
          { label: 'Graph episodes removed', value: preview.episodeCount.toLocaleString() },
        ]}
      />
      <p className="note">This confirmation token expires in five minutes and is rejected if the memory or its graph episodes change before you confirm.</p>
    </Modal>
  )
}

/** Prototype d-memory-detail: the text first, then provenance chips, then the record's ego-graph. */
function MemoryDetailsModal({
  memory,
  teamLabel,
  authorLabel,
  canMutate,
  busy,
  graphEnabled,
  onClose,
  onEdit,
  onDelete,
  onOpenGraph,
}: {
  memory: Memory
  teamLabel: string | null
  authorLabel: string
  canMutate: boolean
  busy: boolean
  graphEnabled: boolean
  onClose: () => void
  onEdit: () => void
  onDelete: () => void
  onOpenGraph: () => void
}) {
  return (
    <Modal
      icon={<Icon name="memory" size={18} />}
      title={<>Memory record <code>{memory.id.slice(0, 8)}…{memory.id.slice(-5)}</code></>}
      onClose={onClose}
      width={760}
      headActions={canMutate ? (
        <>
          <button type="button" className="btn sm secondary" onClick={onEdit}>
            <Icon name="edit" size={13} /> Edit
          </button>
          <button type="button" className="btn sm danger" disabled={busy} onClick={onDelete}>
            <Icon name="delete" size={13} /> Delete
          </button>
        </>
      ) : null}
      footer={
        <>
          <button type="button" className="btn secondary" onClick={onClose}>Close</button>
          {graphEnabled ? (
            <button type="button" className="btn primary" onClick={onOpenGraph}>
              <Icon name="hub" size={14} /> Open in graph
            </button>
          ) : null}
        </>
      }
    >
      <section className="memory-record-section">
        <div className="section-label">Full memory text</div>
        <div className="memory-full-text">{memory.content}</div>
      </section>
      <MemoryDetailBadges memory={memory} teamLabel={teamLabel} authorLabel={authorLabel} />
      <MemoryEgoGraph memory={memory} />
    </Modal>
  )
}

function MemoryEgoGraph({ memory }: { memory: Memory }) {
  const entities = memory.entities.slice(0, 8)
  if (entities.length === 0) return null
  const center = { x: 220, y: 92 }
  return (
    <section className="memory-record-section" aria-label={`Focused graph for memory ${memory.id}`}>
      <div className="section-label">Focused connections</div>
      <div className="memory-ego-graph">
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
      </div>
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
  const primaryFacts = memory.graphPrimaryFactCount ?? 0
  return (
    <section className="memory-record-section">
      <div className="section-label">Details</div>
      <div className="memory-detail-badges">
        {includeCategory ? <span className="chip chip-category">{memory.category}</span> : null}
        {includeProject ? <DetailBadge label="project" value={memory.project} /> : null}
        <DetailBadge label="user" value={authorLabel} />
        {teamLabel ? <DetailBadge label="team" value={teamLabel} /> : null}
        {typeof memory.score === 'number' ? <DetailBadge label="score" value={memory.score.toFixed(3)} /> : null}
        {typeof memory.confidence === 'number' ? <DetailBadge label="confidence" value={memory.confidence.toFixed(2)} /> : null}
        {memory.memoryTier ? <DetailBadge label="tier" value={memory.memoryTier} /> : null}
        {memory.sourceProvenance ? <DetailBadge label="source" value={memory.sourceProvenance} /> : null}
        {memory.shape ? <DetailBadge label="shape" value={memory.shape} /> : null}
        {memory.sessionId ? <DetailBadge label="session" value={`${memory.sessionId.slice(0, 8)}…`} /> : null}
        {memory.entities.map((entity) => (
          <span key={entity} className="chip chip-entity">{entity}</span>
        ))}
        {memory.embeddingStatus === 'pending' ? (
          <span className="badge warn"><Icon name="schedule" size={11} /> awaiting embedding</span>
        ) : null}
        {memory.graphPrimary ? (
          <span className="badge warn">
            <Icon name="hub" size={11} /> graph primary · {primaryFacts} fact{primaryFacts === 1 ? '' : 's'} cascade
          </span>
        ) : null}
      </div>
    </section>
  )
}

/** One provenance fact as a prototype chip: "label · value". */
function DetailBadge({ label, value }: { label: string; value: string }) {
  return <span className="chip memory-detail-chip">{label} · {value}</span>
}
