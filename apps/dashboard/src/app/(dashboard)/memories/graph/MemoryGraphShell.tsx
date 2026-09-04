'use client'

import dynamic from 'next/dynamic'
import { Component, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ErrorInfo, type ReactNode } from 'react'
import type {
  MemoryGraphActivity,
  MemoryGraphEdge,
  MemoryGraphFacets,
  MemoryGraphFilters,
  MemoryGraphNode,
  MemoryGraphSnapshot,
  MemorySurface,
} from '@/lib/types'
import {
  FilterChip,
  GraphActivityBeacon,
  GraphEmptyState,
  GraphStatusLegend,
  GraphValidityFilter,
  GraphViewportControls,
  SearchableFacetPicker,
} from '@/components/ui/MemoryGraphControls'
import { Icon } from '@/components/ui/Icon'
import { Tooltip } from '@/components/ui/Tooltip'
import {
  getMemoryGraphActivityAction,
  getMemoryGraphFacetsAction,
  getMemoryGraphSnapshotAction,
} from '../actions'
import { buildFocusedGraph, GRAPH_PULSE_DURATION_MS, LIVE_ACTIVITY_TTL_MS, type GraphCameraState } from './memoryGraphLayout'

const MemoryGraph3DCanvas = dynamic(() => import('./MemoryGraph3DCanvas'), {
  ssr: false,
  loading: () => <GraphCanvasLoading label="Preparing the 3D memory space…" />,
})
const MemoryGraph2DCanvas = dynamic(() => import('./MemoryGraph2DCanvas'), {
  ssr: false,
  loading: () => <GraphCanvasLoading label="Preparing the flat memory map…" />,
})

const EMPTY_FILTERS: MemoryGraphFilters = { projects: [], tags: [], badges: [], validity: 'all' }
const EMPTY_FACETS: MemoryGraphFacets = { projects: [], tags: [], badges: [], partial: false }
const FILTER_RAIL_STORAGE_KEY = 'pm:memory-graph:filter-rail-width:v1'
const FILTER_RAIL_MIN_WIDTH = 242
const FILTER_RAIL_MAX_WIDTH = 420
type FacetKind = 'projects' | 'tags' | 'badges'

function clampFilterRailWidth(value: number): number {
  return Math.min(FILTER_RAIL_MAX_WIDTH, Math.max(FILTER_RAIL_MIN_WIDTH, Math.round(value)))
}

function GraphCanvasLoading({ label }: { label: string }) {
  return <div className="memory-graph-canvas-loading"><Icon name="bubble_chart" size={30} /><span>{label}</span></div>
}

class GraphRendererBoundary extends Component<{
  mode: '3d' | '2d'
  onFailure: (message: string) => void
  children: ReactNode
}, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    this.props.onFailure(`${this.props.mode.toUpperCase()} rendering could not start.`)
  }
  componentDidUpdate(previous: Readonly<{ mode: '3d' | '2d' }>) {
    if (previous.mode !== this.props.mode && this.state.failed) this.setState({ failed: false })
  }
  render() { return this.state.failed ? null : this.props.children }
}

function toggleValue(values: string[], value: string): string[] {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value]
}

function activityIdentity(event: MemoryGraphActivity): string {
  return `${event.memoryId}:${event.kind}:${event.occurredAt}`
}

export function MemoryGraphShell({ surface }: { surface: MemorySurface }) {
  const [rendererFallback, setRendererFallback] = useState(false)
  const [filters, setFilters] = useState<MemoryGraphFilters>(EMPTY_FILTERS)
  const [facets, setFacets] = useState<MemoryGraphFacets>(EMPTY_FACETS)
  const [nodes, setNodes] = useState<MemoryGraphNode[]>([])
  const nodesRef = useRef<MemoryGraphNode[]>([])
  const [edges, setEdges] = useState<MemoryGraphEdge[]>([])
  const [snapshot, setSnapshot] = useState<MemoryGraphSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [autoOverview, setAutoOverview] = useState(true)
  const [pendingRestore, setPendingRestore] = useState(false)
  const [resetSignal, setResetSignal] = useState(0)
  const [pulseIds, setPulseIds] = useState<string[]>([])
  const [pulseSignal, setPulseSignal] = useState(0)
  const [activity, setActivity] = useState<MemoryGraphActivity[]>([])
  const [beacon, setBeacon] = useState<string | null>(null)
  const [rendererNotice, setRendererNotice] = useState<string | null>(null)
  const [activityStale, setActivityStale] = useState(false)
  const [filterRailWidth, setFilterRailWidth] = useState(FILTER_RAIL_MIN_WIDTH)
  const [resizingFilterRail, setResizingFilterRail] = useState(false)
  const activityCursor = useRef<string | undefined>(undefined)
  const seenEvents = useRef(new Set<string>())
  const loadGeneration = useRef(0)
  const facetTimers = useRef<Partial<Record<FacetKind, ReturnType<typeof setTimeout>>>>({})
  const pulseTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const activityTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>())
  // The 3D viewpoint survives the focused 2D detour: the spherical canvas writes
  // its camera here while it is mounted and reinstates it when focus clears.
  const graphViewState = useRef<GraphCameraState | null>(null)
  const overviewBeforeFocus = useRef(true)
  const filterRailWidthRef = useRef(filterRailWidth)
  const filterRailResizeOrigin = useRef({ pointerX: 0, width: filterRailWidth })
  filterRailWidthRef.current = filterRailWidth

  useEffect(() => {
    nodesRef.current = nodes
  }, [nodes])

  useEffect(() => {
    const stored = window.localStorage.getItem(FILTER_RAIL_STORAGE_KEY)
    if (stored === null) return
    const parsed = Number(stored)
    if (!Number.isFinite(parsed)) return
    const restored = clampFilterRailWidth(parsed)
    filterRailWidthRef.current = restored
    setFilterRailWidth(restored)
  }, [])

  // Selecting a node isolates its connections as a flat 2D map; clearing the
  // selection returns to the rotatable 3D corpus. A renderer failure pins the
  // flat map for the rest of the session.
  const mode: '3d' | '2d' = rendererFallback || selectedId ? '2d' : '3d'

  const fallbackTo2D = useCallback((notice: string) => {
    setRendererFallback(true)
    setRendererNotice(notice)
    setAutoOverview(true)
    setResetSignal((current) => current + 1)
  }, [])

  const loadFacets = useCallback(async (facet?: FacetKind, search?: string) => {
    try {
      const result = await getMemoryGraphFacetsAction(search || undefined, facet, surface)
      setFacets((current) => facet
        ? { ...current, [facet]: result[facet], partial: result.partial }
        : result)
    } catch {
      // The graph itself remains useful if an optional facet refresh fails.
    }
  }, [surface])

  const loadGraph = useCallback(async (quiet = false) => {
    const generation = ++loadGeneration.current
    if (!quiet) setLoading(true)
    setError(null)
    try {
      const nodeMap = new Map<string, MemoryGraphNode>()
      const edgeMap = new Map<string, MemoryGraphEdge>()
      let cursor: string | undefined
      let finalSnapshot: MemoryGraphSnapshot | null = null
      let page = 0
      do {
        const response = await getMemoryGraphSnapshotAction(filters, cursor, surface)
        if (generation !== loadGeneration.current) return
        response.nodes.forEach((node) => nodeMap.set(node.id, node))
        response.edges.forEach((edge) => edgeMap.set(edge.id, edge))
        finalSnapshot = response
        cursor = response.nextCursor ?? undefined
        page += 1
      } while (cursor && page < 20)
      if (!finalSnapshot || generation !== loadGeneration.current) return
      const mergedNodes = [...nodeMap.values()]
      const mergedEdges = [...edgeMap.values()]
      setEdges(mergedEdges)
      setSnapshot({
        ...finalSnapshot,
        nodes: mergedNodes,
        edges: mergedEdges,
        counts: {
          ...finalSnapshot.counts,
          loadedEntities: mergedNodes.filter((node) => node.kind === 'entity').length,
          loadedEdges: mergedEdges.length,
        },
        partial: finalSnapshot.partial || Boolean(cursor),
        partialReason: cursor
          ? 'This view reached the 20-page browser safety boundary. Narrow the filters to inspect the remaining nodes.'
          : finalSnapshot.partialReason,
      })
      setNodes((current) => {
        const transients = current.filter((node) => node.id.startsWith('transient:') && !mergedNodes.some((loaded) => loaded.memoryId && loaded.memoryId === node.memoryId))
        return [...mergedNodes, ...transients.slice(-32)]
      })
      setSelectedId((current) => current && mergedNodes.some((node) => node.id === current) ? current : null)
    } catch (reason) {
      if (generation !== loadGeneration.current) return
      setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (generation === loadGeneration.current) setLoading(false)
    }
  }, [filters, surface])

  useEffect(() => { void loadFacets() }, [loadFacets])
  useEffect(() => {
    activityCursor.current = undefined
    seenEvents.current.clear()
    activityTimers.current.forEach((timer) => clearTimeout(timer))
    activityTimers.current.clear()
    setActivity([])
    setAutoOverview(true)
    void loadGraph()
  }, [loadGraph])

  useEffect(() => {
    let disposed = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const schedule = (delay: number) => {
      if (!disposed) timer = setTimeout(() => void poll(), delay)
    }
    const poll = async () => {
      if (disposed) return
      if (document.visibilityState !== 'visible') return
      try {
        const result = await getMemoryGraphActivityAction(filters, activityCursor.current, surface)
        if (disposed) return
        activityCursor.current = result.nextCursor
        setActivityStale(false)
        const freshEvents = result.events.filter((event) => {
          const identity = activityIdentity(event)
          if (seenEvents.current.has(identity)) return false
          seenEvents.current.add(identity)
          return true
        })
        if (seenEvents.current.size > 500) seenEvents.current = new Set([...seenEvents.current].slice(-250))
        if (freshEvents.length > 0) {
          setActivity((current) => [...freshEvents, ...current].slice(0, 12))
          for (const event of freshEvents) {
            const identity = activityIdentity(event)
            const activeTimer = activityTimers.current.get(identity)
            if (activeTimer) clearTimeout(activeTimer)
            activityTimers.current.set(identity, setTimeout(() => {
              setActivity((current) => current.filter((candidate) => activityIdentity(candidate) !== identity))
              activityTimers.current.delete(identity)
            }, LIVE_ACTIVITY_TTL_MS))
          }
          const currentNodes = nodesRef.current
          const touched = new Set<string>()
          const loadedIds = new Set(currentNodes.map((node) => node.memoryId).filter(Boolean))
          const additions: MemoryGraphNode[] = []
          for (const event of freshEvents) {
            currentNodes
              .filter((node) => node.memoryId === event.memoryId || (node.kind === 'entity' && event.entities.includes(node.displayLabel)))
              .forEach((node) => touched.add(node.id))
            if (!loadedIds.has(event.memoryId)) {
              const memoryId = `transient:memory:${event.memoryId}`
              touched.add(memoryId)
              additions.push({
                id: memoryId,
                kind: 'memory',
                displayLabel: event.displayLabel,
                project: event.project,
                category: event.category,
                relation: 'own',
                surface,
                memoryId: event.memoryId,
                entityUuid: null,
                graphStatus: 'syncing',
              })
              for (const entity of event.entities.slice(0, 8)) {
                const entityId = `transient:entity:${event.memoryId}:${encodeURIComponent(entity)}`
                touched.add(entityId)
                additions.push({ id: entityId, kind: 'entity', displayLabel: entity, project: event.project, category: null, relation: 'own', surface, memoryId: null, entityUuid: null, graphStatus: null })
              }
              setBeacon(`${event.kind} · ${event.displayLabel} is reconciling into the loaded view`)
            }
          }
          setNodes((current) => {
            const stable = current.filter((node) => !node.id.startsWith('transient:'))
            const transient = [...current.filter((node) => node.id.startsWith('transient:')), ...additions]
              .filter((node, index, all) => all.findLastIndex((candidate) => candidate.id === node.id) === index)
              .slice(-32)
            return [...stable, ...transient]
          })
          setPulseIds([...touched])
          setPulseSignal((current) => current + 1)
          if (pulseTimer.current) clearTimeout(pulseTimer.current)
          pulseTimer.current = setTimeout(() => setPulseIds([]), GRAPH_PULSE_DURATION_MS)
          setTimeout(() => setBeacon(null), 3200)
          void loadGraph(true)
        }
        schedule(result.partial ? 0 : 2000)
      } catch {
        // Retain the last graph and back off rather than churning a failed read.
        setActivityStale(true)
        schedule(30_000)
      }
    }
    void poll()
    const onVisibility = () => {
      if (timer) clearTimeout(timer)
      timer = null
      if (document.visibilityState === 'visible') void poll()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      disposed = true
      if (timer) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [filters, loadGraph, surface])

  useEffect(() => () => {
    Object.values(facetTimers.current).forEach((timer) => clearTimeout(timer))
    if (pulseTimer.current) clearTimeout(pulseTimer.current)
    activityTimers.current.forEach((timer) => clearTimeout(timer))
    activityTimers.current.clear()
  }, [])

  useEffect(() => {
    if (!resizingFilterRail) return
    const onPointerMove = (event: PointerEvent) => {
      const next = filterRailResizeOrigin.current.width + event.clientX - filterRailResizeOrigin.current.pointerX
      setFilterRailWidth(clampFilterRailWidth(next))
    }
    const onPointerUp = () => {
      setResizingFilterRail(false)
      window.localStorage.setItem(FILTER_RAIL_STORAGE_KEY, String(filterRailWidthRef.current))
    }
    document.body.classList.add('memory-graph-resizing')
    window.addEventListener('pointermove', onPointerMove)
    window.addEventListener('pointerup', onPointerUp, { once: true })
    return () => {
      document.body.classList.remove('memory-graph-resizing')
      window.removeEventListener('pointermove', onPointerMove)
      window.removeEventListener('pointerup', onPointerUp)
    }
  }, [resizingFilterRail])

  const selected = useMemo(() => nodes.find((node) => node.id === selectedId) ?? null, [nodes, selectedId])
  const selectedEdges = useMemo(() => selected ? edges.filter((edge) => edge.source === selected.id || edge.target === selected.id) : [], [edges, selected])
  const focusedGraph = useMemo(() => buildFocusedGraph(nodes, edges, selectedId), [edges, nodes, selectedId])
  const hasFilters = filters.projects.length + filters.tags.length + filters.badges.length > 0 || filters.validity !== 'all'
  const hasActiveGraphFilters = hasFilters || Boolean(selected)
  const rendererData = useMemo(() => {
    const nodeCap = mode === '3d' ? 750 : 1000
    const edgeCap = mode === '3d' ? 1500 : 2000
    const priority = new Set([selectedId, ...pulseIds].filter((value): value is string => Boolean(value)))
    const ordered = [...focusedGraph.nodes].sort((a, b) => Number(priority.has(b.id)) - Number(priority.has(a.id)))
    const visibleNodes = ordered.slice(0, nodeCap)
    const ids = new Set(visibleNodes.map((node) => node.id))
    const visibleEdges = focusedGraph.edges.filter((edge) => ids.has(edge.source) && ids.has(edge.target)).slice(0, edgeCap)
    return { nodes: visibleNodes, edges: visibleEdges, capped: visibleNodes.length < focusedGraph.nodes.length || visibleEdges.length < focusedGraph.edges.length }
  }, [focusedGraph, mode, pulseIds, selectedId])

  const clearSelection = useCallback(() => {
    setSelectedId(null)
    setAutoOverview(overviewBeforeFocus.current)
  }, [])

  const resetViewport = useCallback(() => {
    // A deliberate reset drops the remembered viewpoint so the corpus is framed
    // again from the current rotation.
    graphViewState.current = null
    setPendingRestore(false)
    setSelectedId(null)
    setAutoOverview(true)
    setResetSignal((current) => current + 1)
  }, [])

  const clearGraphFilters = useCallback(() => {
    // Clearing filters restores the whole corpus, so the viewport goes back to
    // the starting frame rather than to whatever the narrowed graph was showing.
    resetViewport()
    setFilters(EMPTY_FILTERS)
  }, [resetViewport])

  const selectNode = useCallback((node: MemoryGraphNode) => {
    if (!selectedId) overviewBeforeFocus.current = autoOverview
    setSelectedId(node.id)
    setPendingRestore(true)
    // Focusing an ego graph is a user-controlled viewport state. Clearing the
    // focus restores the corpus at the exact rotation, zoom and pan it had.
    setAutoOverview(false)
  }, [autoOverview, selectedId])

  const updateFilterRailWidth = useCallback((nextWidth: number) => {
    const clamped = clampFilterRailWidth(nextWidth)
    setFilterRailWidth(clamped)
    filterRailWidthRef.current = clamped
    window.localStorage.setItem(FILTER_RAIL_STORAGE_KEY, String(clamped))
  }, [])

  const searchFacets = (facet: FacetKind, query: string) => {
    const active = facetTimers.current[facet]
    if (active) clearTimeout(active)
    facetTimers.current[facet] = setTimeout(() => void loadFacets(facet, query), 240)
  }

  return (
    <div
      className="memory-graph-shell"
      style={{ '--memory-graph-filter-width': `${filterRailWidth}px` } as CSSProperties}
    >
      <aside className="memory-graph-filter-rail" aria-label="Memory graph filters">
        <div className="memory-graph-rail-head">
          <div><strong>Explore connections</strong><span>Filter the visible neural space</span></div>
          {hasActiveGraphFilters ? <button type="button" className="link" onClick={clearGraphFilters}>Clear</button> : null}
        </div>
        {selected ? (
          <div className="memory-graph-focus-filter" role="status">
            <span>Connected focus</span>
            <strong>{selected.displayLabel}</strong>
            <small>{focusedGraph.nodes.length.toLocaleString()} related nodes · {focusedGraph.edges.length.toLocaleString()} connections</small>
            <button type="button" onClick={clearSelection}>Clear focus</button>
          </div>
        ) : null}
        {hasFilters ? (
          <div className="memory-graph-active-filters">
            {filters.projects.map((value) => <FilterChip key={`p-${value}`} label={value} onRemove={() => setFilters((current) => ({ ...current, projects: toggleValue(current.projects, value) }))} />)}
            {filters.tags.map((value) => <FilterChip key={`t-${value}`} label={value} onRemove={() => setFilters((current) => ({ ...current, tags: toggleValue(current.tags, value) }))} />)}
            {filters.badges.map((value) => <FilterChip key={`b-${value}`} label={value} onRemove={() => setFilters((current) => ({ ...current, badges: toggleValue(current.badges, value) }))} />)}
          </div>
        ) : null}
        <SearchableFacetPicker
          title="Projects"
          icon="folder"
          facets={facets.projects}
          selected={filters.projects}
          allOption={{
            label: 'All projects',
            count: facets.projects.reduce((sum, facet) => sum + facet.count, 0),
            onSelect: () => setFilters((current) => ({ ...current, projects: [] })),
          }}
          onSearch={(query) => searchFacets('projects', query)}
          onToggle={(value) => setFilters((current) => ({ ...current, projects: toggleValue(current.projects, value) }))}
        />
        <SearchableFacetPicker title="Tags" icon="sell" facets={facets.tags} selected={filters.tags} onSearch={(query) => searchFacets('tags', query)} onToggle={(value) => setFilters((current) => ({ ...current, tags: toggleValue(current.tags, value) }))} />
        <SearchableFacetPicker title="Badges" icon="verified" facets={facets.badges} selected={filters.badges} onSearch={(query) => searchFacets('badges', query)} onToggle={(value) => setFilters((current) => ({ ...current, badges: toggleValue(current.badges, value) }))} />
        <GraphValidityFilter value={filters.validity} onChange={(validity) => setFilters((current) => ({ ...current, validity }))} />
        {facets.partial ? <p className="memory-graph-facet-note">Showing recent values from the first 5,000 readable memories.</p> : null}
      </aside>

      <div
        className={`memory-graph-filter-resizer${resizingFilterRail ? ' active' : ''}`}
        role="separator"
        aria-label="Resize graph filters"
        aria-orientation="vertical"
        aria-valuemin={FILTER_RAIL_MIN_WIDTH}
        aria-valuemax={FILTER_RAIL_MAX_WIDTH}
        aria-valuenow={filterRailWidth}
        tabIndex={0}
        onPointerDown={(event) => {
          event.preventDefault()
          filterRailResizeOrigin.current = { pointerX: event.clientX, width: filterRailWidth }
          setResizingFilterRail(true)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight' && event.key !== 'Home' && event.key !== 'End') return
          event.preventDefault()
          const next = event.key === 'Home'
            ? FILTER_RAIL_MIN_WIDTH
            : event.key === 'End'
              ? FILTER_RAIL_MAX_WIDTH
              : filterRailWidth + (event.key === 'ArrowRight' ? 16 : -16)
          updateFilterRailWidth(next)
        }}
      />

      <main className="memory-graph-stage">
        <div className="memory-graph-stage-toolbar">
          <div className="memory-graph-title-block">
            <span className="memory-graph-live-dot" aria-hidden />
            <div><strong>Memory Graph</strong><small>{snapshot ? selected ? `${rendererData.nodes.length.toLocaleString()} connected nodes · ${rendererData.edges.length.toLocaleString()} connections` : `${snapshot.counts.totalFilteredMemories.toLocaleString()} memories · ${rendererData.nodes.length.toLocaleString()}${rendererData.capped ? ` of ${nodes.length.toLocaleString()}` : ''} visible nodes` : 'Connecting…'}</small></div>
          </div>
          <div className="memory-graph-toolbar-actions">
            <GraphViewportControls autoOverview={autoOverview} onReset={resetViewport} />
          </div>
        </div>
        <div className="memory-graph-canvas-wrap">
          {loading && nodes.length === 0 ? <GraphCanvasLoading label="Assembling your memory space…" /> : null}
          {error ? (
            <div className="memory-graph-error"><Icon name="error_outline" size={24} /><strong>Could not load the graph</strong><span>{error}</span><button type="button" className="btn secondary" onClick={() => void loadGraph()}>Try again</button></div>
          ) : null}
          {!loading && !error && nodes.length === 0 ? <GraphEmptyState filtered={hasActiveGraphFilters} /> : null}
          {!error && nodes.length > 0 ? (
            <GraphRendererBoundary
              mode={mode}
              onFailure={(message) => mode === '3d' ? fallbackTo2D(`${message} The flat view is active.`) : setError(message)}
            >
              {mode === '3d' ? (
                <MemoryGraph3DCanvas nodes={rendererData.nodes} layoutNodes={nodes} edges={rendererData.edges} totalFilteredMemories={snapshot?.counts.totalFilteredMemories ?? nodes.length} selectedId={selectedId} pulseIds={pulseIds} pulseSignal={pulseSignal} autoOverview={autoOverview} resetSignal={resetSignal} viewStateRef={graphViewState} restoreView={pendingRestore} onSelect={selectNode} onAutoOverviewChange={setAutoOverview} onFallback={fallbackTo2D} />
              ) : (
                <MemoryGraph2DCanvas nodes={rendererData.nodes} layoutNodes={nodes} edges={rendererData.edges} totalFilteredMemories={snapshot?.counts.totalFilteredMemories ?? nodes.length} selectedId={selectedId} pulseIds={pulseIds} pulseSignal={pulseSignal} autoOverview={autoOverview} resetSignal={resetSignal} onSelect={selectNode} onAutoOverviewChange={setAutoOverview} />
              )}
            </GraphRendererBoundary>
          ) : null}
          <GraphActivityBeacon message={beacon} />
          <div className="memory-graph-canvas-footer"><GraphStatusLegend /><span>{mode === '3d' ? 'Scroll to zoom · drag to rotate · right-drag to move' : 'Scroll to zoom · drag to move'}</span></div>
        </div>
        {rendererNotice ? <div className="memory-graph-partial"><Icon name="info" size={15} />{rendererNotice}</div> : null}
        {activityStale ? <div className="memory-graph-partial"><Icon name="sync_problem" size={15} />Live activity is temporarily stale. The current graph is preserved; retrying in 30 seconds.</div> : null}
        {rendererData.capped ? <div className="memory-graph-partial"><Icon name="data_usage" size={15} />Renderer safety cap reached: showing {rendererData.nodes.length.toLocaleString()} of {focusedGraph.nodes.length.toLocaleString()} loaded nodes. Narrow the filters for more detail.</div> : null}
        {snapshot?.partial ? <div className="memory-graph-partial"><Icon name="info" size={15} />{snapshot.partialReason ?? 'A bounded portion of this graph is shown. Narrow the filters for a complete local view.'}</div> : null}
      </main>

      <aside className="memory-graph-inspector" aria-label="Memory graph inspector">
        <section className="memory-graph-inspector-pane memory-graph-activity-pane" aria-label="Live memory activity">
          <div className="memory-graph-inspector-head"><strong>Live activity</strong></div>
          <div className="memory-graph-activity-legend" aria-label="Activity colors: read cyan, created green, updated amber">
            <span className="read">Read</span><span className="created">Created</span><span className="updated">Updated</span>
          </div>
          <div className="memory-graph-activity-list">
            {activity.length === 0 ? <div className="memory-graph-activity-empty"><Icon name="sensors" size={25} /><span>Waiting for memory activity</span><small>Completed memory operations pulse for a few seconds, then clear.</small></div> : activity.map((event) => (
              <button type="button" key={activityIdentity(event)} onClick={() => {
                const node = nodes.find((candidate) => candidate.memoryId === event.memoryId)
                if (node) selectNode(node)
              }}>
                <i className={event.kind} /><div><strong>{event.displayLabel}</strong><span>{event.kind} · {new Date(event.occurredAt).toLocaleTimeString()}</span></div>
              </button>
            ))}
          </div>
        </section>

        <section className="memory-graph-inspector-pane memory-graph-details-pane" aria-label="Memory node details">
          <div className="memory-graph-inspector-head">
            <strong>Details</strong>
            {selected ? <Tooltip label="Clear selection"><button type="button" className="memory-graph-icon-button" onClick={clearSelection} aria-label="Clear node selection"><Icon name="close" size={16} /></button></Tooltip> : null}
          </div>
          {selected ? (
            <div className="memory-graph-selected">
              <div className={`memory-graph-selected-orb ${selected.kind}`}><Icon name={selected.kind === 'memory' ? 'psychology' : 'grain'} size={24} /></div>
              <h3>{selected.displayLabel}</h3>
              <span className="memory-graph-kind">{selected.kind} node</span>
              <dl>
                <div><dt>Project</dt><dd>{selected.project}</dd></div>
                {selected.category ? <div><dt>Badge</dt><dd>{selected.category}</dd></div> : null}
                <div><dt>Access</dt><dd>{selected.relation === 'own' ? 'Own memory space' : 'Mounted memory space'}</dd></div>
                {selected.graphStatus ? <div><dt>Graph sync</dt><dd>{selected.graphStatus}</dd></div> : null}
                <div><dt>Connections</dt><dd>{selectedEdges.length.toLocaleString()}</dd></div>
              </dl>
              {selectedEdges.length > 0 ? <div className="memory-graph-connections"><span>Nearest connections</span>{selectedEdges.slice(0, 10).map((edge) => <div key={edge.id}><i className={edge.kind} />{edge.label ?? (edge.kind === 'mentions' ? 'mentioned entity' : 'derived fact')}</div>)}</div> : null}
            </div>
          ) : (
            <div className="memory-graph-details-empty"><Icon name="ads_click" size={20} /><span>Select a node to isolate its connected memories and entities.</span></div>
          )}
          <section className="memory-graph-accessible-list" aria-label={`Accessible node list (${rendererData.nodes.length.toLocaleString()})`}>
            <div className="memory-graph-accessible-list-title">Accessible node list ({rendererData.nodes.length.toLocaleString()})</div>
            <div className="memory-graph-accessible-list-body">
              {rendererData.nodes.map((node) => (
                <button type="button" key={node.id} onClick={() => selectNode(node)}>
                  <span>{node.displayLabel}</span><small>{node.kind} · {node.project}</small>
                </button>
              ))}
            </div>
          </section>
        </section>
      </aside>
    </div>
  )
}
