'use client'

import { useEffect, useId, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { Icon } from '@/components/ui/Icon'
import { Tooltip } from '@/components/ui/Tooltip'
import { armOverviewHold, guardOverviewTouchScroll } from '@/lib/overviewHold'
import {
  OVERVIEW_CARD_SPECS, defaultOverviewLayout, loadOverviewLayout, overviewLayoutKey,
  overviewLegacyLayoutKey, saveOverviewLayout, type OverviewCardId, type OverviewLayoutState, type OverviewPlacement,
} from '@/lib/overviewLayout'
import {
  OVERVIEW_GRID_COLUMNS, moveOverviewPlacement, moveOverviewPlacementKey, overviewGridRows, overviewGridUnit,
  overviewPlacementWidth, overviewResizeRange, resizeOverviewPlacement, resizeOverviewPlacementKey, resolveOverviewGrid,
} from '@/lib/overviewGrid'

export interface OverviewLayoutCard { id: OverviewCardId; content: ReactNode }
type Gesture = {
  kind: 'move' | 'resize'; id: OverviewCardId; pointerId: number; startX: number; startY: number;
  initial: OverviewLayoutState; starting: OverviewLayoutState; grabColumnOffset: number; available: number; moved: boolean; active: boolean;
  element: HTMLElement; edge?: 'left' | 'right'; hold?: ReturnType<typeof armOverviewHold>; releaseTouchGuard?: () => void
}
type MovingCard = { id: OverviewCardId; left: number; top: number; width: number; height: number }

export function OverviewLayout({ identity, cards }: {
  identity: { userId: string; teamId: string | null }; cards: OverviewLayoutCard[]
}) {
  const key = overviewLayoutKey(identity)
  const ids = cards.map((card) => card.id)
  const idsKey = ids.join(',')
  const helpId = useId()
  const [layout, setLayout] = useState(() => defaultOverviewLayout(ids))
  const layoutRef = useRef(layout)
  const [ready, setReady] = useState(false)
  const [available, setAvailable] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [moving, setMoving] = useState<MovingCard | null>(null)
  const [resizing, setResizing] = useState<{ id: OverviewCardId; edge: 'left' | 'right'; rowHeights: number[] } | null>(null)
  const [drop, setDrop] = useState<OverviewPlacement | null>(null)
  const dropRef = useRef(drop)
  const grid = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
  const finishRef = useRef<(cancel: boolean) => void>(() => {})
  const suppressedClick = useRef<{ id: OverviewCardId; until: number } | null>(null)
  const hydratedKey = useRef<string | null>(null)

  const apply = (next: OverviewLayoutState) => { layoutRef.current = next; setLayout(next) }
  const persist = (next: OverviewLayoutState, message: string) => {
    apply(next)
    if (hydratedKey.current !== key) return
    let saved = false
    try { saved = saveOverviewLayout(window.localStorage, key, next) } catch { /* browser storage disabled */ }
    setNotice(saved ? null : 'Browser storage is unavailable. This layout will last only for this page.')
    setAnnouncement(saved ? `${message} Layout saved in this browser.` : `${message} Layout could not be saved.`)
  }

  useEffect(() => {
    finishRef.current(true)
    setReady(false)
    let loaded
    try { loaded = loadOverviewLayout(window.localStorage, key, idsKey.split(',') as OverviewCardId[], overviewLegacyLayoutKey(identity)) }
    catch { loaded = { layout: defaultOverviewLayout(idsKey.split(',') as OverviewCardId[]), storageAvailable: false, status: 'default' as const } }
    layoutRef.current = loaded.layout
    setLayout(loaded.layout)
    setNotice(!loaded.storageAvailable ? 'Browser storage is unavailable. Layout changes cannot survive a reload.'
      : loaded.status === 'unsupported' ? 'The saved layout uses an unsupported version. Defaults are shown; change the layout or restore defaults to replace it.'
        : loaded.status === 'invalid' ? 'The saved layout could not be read. Defaults are shown; change the layout or restore defaults to replace it.' : null)
    hydratedKey.current = key
    setReady(true)
  }, [key, idsKey])

  useEffect(() => {
    const element = grid.current
    if (!element) return
    const measure = () => {
      // Hold the grid measurement stable during a gesture. Only a genuine
      // viewport resize cancels it; our own preview must not cancel capture.
      if (gesture.current) return
      const width = Math.max(0, element.getBoundingClientRect().width)
      setAvailable(width)
    }
    const viewportResize = () => { finishRef.current(true); measure() }
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    window.addEventListener('resize', viewportResize)
    return () => { observer?.disconnect(); window.removeEventListener('resize', viewportResize) }
  }, [])

  useEffect(() => {
    const release = (event: globalThis.PointerEvent) => {
      if (gesture.current?.pointerId === event.pointerId) finishRef.current(false)
    }
    const cancel = () => finishRef.current(true)
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape' && gesture.current) { event.preventDefault(); cancel() }
    }
    window.addEventListener('pointerup', release)
    window.addEventListener('pointercancel', cancel)
    window.addEventListener('blur', cancel)
    window.addEventListener('keydown', escape)
    return () => {
      cancel()
      window.removeEventListener('pointerup', release)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('blur', cancel)
      window.removeEventListener('keydown', escape)
    }
  }, [])

  const finish = (cancel: boolean) => {
    const current = gesture.current
    if (!current) return
    gesture.current = null
    current.hold?.cancel()
    current.releaseTouchGuard?.()
    const target = dropRef.current
    const next = current.kind === 'move' && target
      ? moveOverviewPlacement(current.starting, current.id, target.row, target.column, current.available)
      : layoutRef.current
    const changed = JSON.stringify(next.placements) !== JSON.stringify(current.starting.placements)
    if (!cancel && current.moved && changed && (current.kind === 'resize' || target)) {
      persist(next, `${OVERVIEW_CARD_SPECS[current.id].label} ${current.kind === 'move' ? 'moved' : 'resized'}.`)
    } else if (current.active) apply(current.initial)
    if (current.active) suppressedClick.current = { id: current.id, until: Date.now() + 500 }
    setMoving(null)
    setResizing(null)
    setDrop(null)
    dropRef.current = null
    current.element.style.removeProperty('--overview-drag-x')
    current.element.style.removeProperty('--overview-drag-y')
    if (current.kind === 'resize') document.documentElement.classList.remove('pm-overview-resizing')
    if (current.element.hasPointerCapture(current.pointerId)) current.element.releasePointerCapture(current.pointerId)
    if (grid.current) setAvailable(Math.max(0, grid.current.getBoundingClientRect().width))
  }
  finishRef.current = finish

  const beginMove = (event: PointerEvent<HTMLElement>, id: OverviewCardId) => {
    if (!ready || gesture.current || event.button !== 0 || event.isPrimary === false || available <= 0) return
    // Whole summary links support holding, while buttons and links inside panels keep their own gestures.
    const control = (event.target as Element).closest('button, input, select, textarea, a, [role="button"], [contenteditable]:not([contenteditable="false"])')
    if (control && !control.matches('a.overview-card')) return
    const element = event.currentTarget
    const starting = resolveOverviewGrid(layoutRef.current, available)
    const current: Gesture = { kind: 'move', id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      initial: layoutRef.current, starting, grabColumnOffset: (event.clientX - element.getBoundingClientRect().left) / overviewGridUnit(available),
      available, moved: false, active: false, element }
    gesture.current = current
    if (event.pointerType === 'touch') current.releaseTouchGuard = guardOverviewTouchScroll(element, () => current.active)
    current.hold = armOverviewHold(event.clientX, event.clientY, () => {
      if (gesture.current !== current || !element.isConnected) return
      try { element.setPointerCapture(current.pointerId) } catch { finishRef.current(true); return }
      const { left, top, width, height } = element.getBoundingClientRect()
      current.active = true
      apply(starting)
      suppressedClick.current = { id, until: Infinity }
      setMoving({ id, left, top, width, height })
      setAnnouncement(`${OVERVIEW_CARD_SPECS[id].label} ready to move. Drop in a grid position; Escape cancels.`)
    })
  }
  const beginResize = (event: PointerEvent<HTMLButtonElement>, id: OverviewCardId, edge: 'left' | 'right') => {
    if (!ready || gesture.current || event.button !== 0 || event.isPrimary === false || available <= 0) return
    event.preventDefault()
    event.stopPropagation()
    const element = event.currentTarget.closest<HTMLElement>('[data-overview-card]')!
    element.setPointerCapture(event.pointerId)
    document.documentElement.classList.add('pm-overview-resizing')
    const starting = resolveOverviewGrid(layoutRef.current, available)
    gesture.current = { kind: 'resize', id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      initial: layoutRef.current, starting, grabColumnOffset: 0, available, moved: false, active: true, element, edge }
    apply(starting)
    const rowHeights = [...grid.current!.querySelectorAll<HTMLElement>('[data-overview-row]')].map((row) => row.getBoundingClientRect().height)
    setResizing({ id, edge, rowHeights })
  }
  const updateGesture = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    if (!current.active) {
      if (!current.hold?.move(event.clientX, event.clientY)) finish(true)
      return
    }
    event.preventDefault()
    if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 5) return
    current.moved = true
    if (current.kind === 'resize') {
      const next = resizeOverviewPlacement(current.starting, current.id, current.edge!, event.clientX - current.startX, current.available)
      const before = layoutRef.current.placements?.[current.id]
      const after = next.placements?.[current.id]
      if (before?.column !== after?.column || before?.span !== after?.span) apply(next)
    } else {
      current.element.style.setProperty('--overview-drag-x', `${event.clientX - current.startX}px`)
      current.element.style.setProperty('--overview-drag-y', `${event.clientY - current.startY}px`)
      const rect = grid.current!.getBoundingClientRect()
      const rows = [...grid.current!.querySelectorAll<HTMLElement>('[data-overview-row]')]
      const nearest = rows.reduce<HTMLElement | null>((best, row) => {
        const distance = (element: HTMLElement) => { const r = element.getBoundingClientRect(); return Math.max(r.top - event.clientY, 0, event.clientY - r.bottom) }
        return !best || distance(row) < distance(best) ? row : best
      }, null)
      const span = current.starting.placements![current.id]!.span
      const target = nearest && event.clientX >= rect.left - 24 && event.clientX <= rect.right + 24 && event.clientY >= rect.top - 24 && event.clientY <= rect.bottom + 24
        ? { row: Number(nearest.dataset.overviewRow), column: Math.max(1, Math.min(OVERVIEW_GRID_COLUMNS - span + 1,
          Math.round((event.clientX - rect.left) / overviewGridUnit(current.available) - current.grabColumnOffset) + 1)), span }
        : null
      if (target?.row !== dropRef.current?.row || target?.column !== dropRef.current?.column) {
        dropRef.current = target
        setDrop(target)
      }
    }
  }
  const moveKey = (event: KeyboardEvent<HTMLElement>, id: OverviewCardId) => {
    if (event.target !== event.currentTarget || !event.altKey || !ready || gesture.current) return
    const next = moveOverviewPlacementKey(resolveOverviewGrid(layoutRef.current, available), id, event.key, available)
    if (!next) return
    event.preventDefault()
    if (next !== layoutRef.current) persist(next, `${OVERVIEW_CARD_SPECS[id].label} moved.`)
  }
  const resolved = resolveOverviewGrid(layout, available)

  return (
    <section className="overview-layout" aria-label="Overview cards">
      <div className="overview-layout-toolbar">
        <span className="note">Hold a card for one second to move it. Resize from either side.</span>
        <button type="button" className="btn sm ghost" disabled={!ready || !!moving || !!resizing} onClick={() => persist(defaultOverviewLayout(ids), 'Default layout restored.')}>
          <Icon name="restart_alt" size={15} /> Restore defaults
        </button>
      </div>
      {notice ? <div className="notice overview-layout-notice" role="status">{notice}</div> : null}
      <span id={helpId} className="overview-layout-sr-only">Hold for one second to move. With the card focused, use Alt and arrow keys to move between grid cells, or Alt and Home or End to move first or last. Escape cancels. Focus either resize edge to move that edge with arrow keys. Home selects minimum width; End grows into available empty cells. Other cards stay in place during resizing.</span>
      <span className="overview-layout-sr-only" aria-live="polite">{announcement}</span>
      <div className={`overview-layout-grid${moving ? ' dragging' : ''}${resizing ? ' resizing' : ''}`} ref={grid}
        style={resizing ? { gridTemplateRows: resizing.rowHeights.map((height) => `${height}px`).join(' ') } : undefined}>
        {Array.from({ length: overviewGridRows(resolved) + (moving ? 1 : 0) }, (_, index) => (
          <div key={`row-${index + 1}`} data-overview-row={index + 1} className="overview-grid-row" aria-hidden="true" style={{ gridRow: index + 1, gridColumn: '1 / -1' }} />
        ))}
        {moving && drop ? <div className="overview-grid-drop" aria-hidden="true" style={{ gridRow: drop.row, gridColumn: `${drop.column} / span ${drop.span}` }} /> : null}
        {resolved.order.map((id) => {
          const card = cards.find((candidate) => candidate.id === id)
          if (!card) return null
          const spec = OVERVIEW_CARD_SPECS[id]
          const placement = resolved.placements![id]!
          const width = overviewPlacementWidth(placement, available)
          const isMoving = moving?.id === id
          const style = { '--overview-content-min': `${spec.minWidth}px`, gridRow: placement.row, gridColumn: `${placement.column} / span ${placement.span}`,
            ...(isMoving ? { minHeight: moving.height, '--overview-drag-left': `${moving.left}px`, '--overview-drag-top': `${moving.top}px`,
              '--overview-drag-width': `${moving.width}px`, '--overview-drag-height': `${moving.height}px` } : {}) } as CSSProperties
          return (
            <article key={id} className={`overview-layout-item${isMoving ? ' moving' : ''}${resizing?.id === id ? ' resizing' : ''}`} style={style}
              data-overview-card={id}
              tabIndex={ready ? 0 : -1} aria-label={spec.label} aria-describedby={helpId} aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+ArrowUp Alt+ArrowDown Alt+Home Alt+End"
              onPointerDown={(event) => beginMove(event, id)} onPointerMove={updateGesture}
              onPointerUp={(event) => { if (gesture.current?.pointerId === event.pointerId) finish(false) }}
              onPointerCancel={() => finish(true)} onLostPointerCapture={(event) => { if (gesture.current?.pointerId === event.pointerId && event.target === event.currentTarget) finish(true) }}
              onPointerLeave={() => { if (gesture.current?.id === id && !gesture.current.active) finish(true) }}
              onDragStart={(event) => { if (gesture.current) { event.preventDefault(); if (!gesture.current.active) finish(true) } }}
              onContextMenu={(event) => { if (gesture.current?.id === id) event.preventDefault() }} onKeyDown={(event) => moveKey(event, id)}
              onClickCapture={(event) => {
                const suppressed = suppressedClick.current
                if (event.detail > 0 && suppressed?.id === id && Date.now() <= suppressed.until) {
                  event.preventDefault(); event.stopPropagation(); suppressedClick.current = null
                }
              }}>
              <div className="overview-layout-scroll" inert={!!moving}><div className="overview-layout-body">{card.content}</div></div>
              {(['left', 'right'] as const).map((edge) => {
                const range = overviewResizeRange(resolved, id, edge, available)
                return <Tooltip key={edge} as="div" className={`overview-resize-zone${resizing?.id === id && resizing.edge === edge ? ' active' : ''}`} data-resize-edge={edge} label={`Resize ${spec.label}. Move this edge between grid cells; the opposite edge and other cards stay fixed. Left/Right moves this edge; Home selects minimum width and End grows into free space.`}>
                <button type="button" className="overview-resize-handle" role="separator" aria-orientation="vertical" disabled={!ready || available <= 0 || !!moving}
                  aria-label={`Resize ${spec.label}${edge === 'left' ? ' from left' : ''}`} aria-valuemin={Math.round(range.min)} aria-valuemax={Math.round(range.max)} aria-valuenow={Math.round(width)} aria-valuetext={`${Math.round(width)} pixels wide`}
                  onPointerDown={(event) => beginResize(event, id, edge)} onKeyDown={(event) => {
                    if (gesture.current) return
                    const next = resizeOverviewPlacementKey(resolveOverviewGrid(layoutRef.current, available), id, edge, event.key, available)
                    if (!next) return
                    event.preventDefault()
                    persist(next, `${spec.label} resized.`)
                  }}>
                  <Icon name="drag_handle" size={17} />
                </button>
              </Tooltip>
              })}
            </article>
          )
        })}
      </div>
    </section>
  )
}
