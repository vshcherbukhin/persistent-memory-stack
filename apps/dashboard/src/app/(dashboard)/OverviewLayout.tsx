'use client'

import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { Icon } from '@/components/ui/Icon'
import { Tooltip } from '@/components/ui/Tooltip'
import {
  OVERVIEW_CARD_SPECS,
  completeOverviewGesture,
  defaultOverviewLayout,
  loadOverviewLayout,
  overviewCardWidth,
  overviewDropTarget,
  overviewLayoutKey,
  overviewMoveKey,
  overviewResizeKey,
  resizeOverviewCard,
  saveOverviewLayout,
  type OverviewCardId,
  type OverviewLayoutState,
} from '@/lib/overviewLayout'

export interface OverviewLayoutCard { id: OverviewCardId; content: ReactNode }
type Gesture = {
  kind: 'move' | 'resize'; id: OverviewCardId; pointerId: number; startX: number; startY: number;
  initial: OverviewLayoutState; width: number; available: number; moved: boolean
}

export function OverviewLayout({ identity, cards }: {
  identity: { userId: string; teamId: string | null }; cards: OverviewLayoutCard[]
}) {
  const key = overviewLayoutKey(identity)
  const ids = cards.map((card) => card.id)
  const idsKey = ids.join(',')
  const [layout, setLayout] = useState(() => defaultOverviewLayout(ids))
  const layoutRef = useRef(layout)
  const [ready, setReady] = useState(false)
  const [available, setAvailable] = useState(0)
  const [notice, setNotice] = useState<string | null>(null)
  const [announcement, setAnnouncement] = useState('')
  const [moving, setMoving] = useState<OverviewCardId | null>(null)
  const [drop, setDrop] = useState<ReturnType<typeof overviewDropTarget>>(null)
  const dropRef = useRef(drop)
  const grid = useRef<HTMLDivElement>(null)
  const gesture = useRef<Gesture | null>(null)
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
    setReady(false)
    let loaded
    try { loaded = loadOverviewLayout(window.localStorage, key, idsKey.split(',') as OverviewCardId[]) }
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
    const measure = () => setAvailable(Math.max(0, element.getBoundingClientRect().width))
    measure()
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(element)
    window.addEventListener('resize', measure)
    return () => { observer?.disconnect(); window.removeEventListener('resize', measure) }
  }, [])

  const begin = (event: PointerEvent<HTMLButtonElement>, id: OverviewCardId, kind: Gesture['kind']) => {
    if (!ready || event.button !== 0 || available <= 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    dropRef.current = null
    gesture.current = { kind, id, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY,
      initial: layoutRef.current, width: overviewCardWidth(id, available, layoutRef.current), available, moved: false }
  }
  const updateGesture = (event: PointerEvent<HTMLButtonElement>) => {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    if (!current.moved && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < 5) return
    current.moved = true
    if (current.kind === 'resize') {
      apply(resizeOverviewCard(current.initial, current.id, current.width + event.clientX - current.startX, current.available))
    } else {
      setMoving(current.id)
      const rects = [...(grid.current?.querySelectorAll<HTMLElement>('[data-overview-card]') ?? [])].map((element) => {
        const { left, right, top, bottom } = element.getBoundingClientRect()
        return { id: element.dataset.overviewCard as OverviewCardId, left, right, top, bottom }
      })
      dropRef.current = overviewDropTarget(rects, event.clientX, event.clientY)
      setDrop(dropRef.current)
    }
  }
  const finish = (event: PointerEvent<HTMLButtonElement>, cancel = false) => {
    const current = gesture.current
    if (!current || current.pointerId !== event.pointerId) return
    gesture.current = null
    const result = completeOverviewGesture(current.initial, layoutRef.current, { ...current, cancelled: cancel, target: dropRef.current })
    if (result.commit) persist(result.layout, `${OVERVIEW_CARD_SPECS[current.id].label} ${current.kind === 'move' ? 'moved' : 'resized'}.`)
    else apply(result.layout)
    setMoving(null)
    setDrop(null)
    dropRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }
  const cancelWithEscape = (event: KeyboardEvent<HTMLButtonElement>) => {
    const current = gesture.current
    if (event.key !== 'Escape' || !current) return false
    event.preventDefault()
    gesture.current = null
    apply(current.initial)
    setMoving(null)
    setDrop(null)
    dropRef.current = null
    if (event.currentTarget.hasPointerCapture(current.pointerId)) event.currentTarget.releasePointerCapture(current.pointerId)
    return true
  }

  return (
    <section className="overview-layout" aria-label="Overview cards">
      <div className="overview-layout-toolbar">
        <span className="note">Move cards with the grip; drag the resize handle to change width.</span>
        <button type="button" className="btn sm ghost" disabled={!ready} onClick={() => persist(defaultOverviewLayout(ids), 'Default layout restored.')}>
          <Icon name="restart_alt" size={15} /> Restore defaults
        </button>
      </div>
      {notice ? <div className="notice overview-layout-notice" role="status">{notice}</div> : null}
      <span className="sr-only" aria-live="polite">{announcement}</span>
      <div className="overview-layout-grid" ref={grid}>
        {layout.order.map((id) => {
          const card = cards.find((candidate) => candidate.id === id)
          if (!card) return null
          const spec = OVERVIEW_CARD_SPECS[id]
          const width = overviewCardWidth(id, available, layout)
          const style = { '--overview-content-min': `${spec.minWidth}px`, width: width > 0 ? `${width}px` : '100%' } as CSSProperties
          const position = layout.order.indexOf(id)
          return (
            <article key={id} className={`overview-layout-item${moving === id ? ' moving' : ''}`} style={style}
              data-overview-card={id} data-drop-edge={drop?.id === id && moving !== id ? drop.edge : undefined} aria-label={spec.label}>
              <div className="overview-layout-card-tools">
                <Tooltip label={`Move ${spec.label}. Drag, or use arrow keys to move earlier or later; Home moves first and End moves last.`}>
                  <button type="button" className="icon-btn overview-move-handle" disabled={!ready} aria-label={`Move ${spec.label}`} aria-keyshortcuts="ArrowLeft ArrowRight ArrowUp ArrowDown Home End"
                    onPointerDown={(event) => begin(event, id, 'move')} onPointerMove={updateGesture} onPointerUp={(event) => finish(event)} onPointerCancel={(event) => finish(event, true)}
                    onLostPointerCapture={(event) => finish(event, true)} onKeyDown={(event) => {
                      if (cancelWithEscape(event)) return
                      const next = overviewMoveKey(layoutRef.current, id, event.key)
                      if (!next) return
                      event.preventDefault()
                      if (next === layoutRef.current) return
                      persist(next, `${spec.label} moved to position ${next.order.indexOf(id) + 1} of ${next.order.length}.`)
                    }}>
                    <Icon name="drag_indicator" size={17} />
                  </button>
                </Tooltip>
                <span className="sr-only">Position {position + 1} of {layout.order.length}.</span>
                <Tooltip label={`Resize ${spec.label}. Drag horizontally, or use Left/Right to adjust; Home sets the minimum and End fills the row.`}>
                  <button type="button" className="icon-btn overview-resize-handle" role="separator" aria-orientation="vertical" disabled={!ready || available <= 0}
                    aria-label={`Resize ${spec.label}`} aria-valuemin={Math.round(Math.min(spec.minWidth, available))} aria-valuemax={Math.round(available)} aria-valuenow={Math.round(width)} aria-valuetext={`${Math.round(width)} pixels wide`}
                    onPointerDown={(event) => begin(event, id, 'resize')} onPointerMove={updateGesture} onPointerUp={(event) => finish(event)} onPointerCancel={(event) => finish(event, true)}
                    onLostPointerCapture={(event) => finish(event, true)} onKeyDown={(event) => {
                      if (cancelWithEscape(event)) return
                      const pixels = overviewResizeKey(event.key, overviewCardWidth(id, available, layoutRef.current), id, available)
                      if (pixels === null) return
                      event.preventDefault()
                      persist(resizeOverviewCard(layoutRef.current, id, pixels, available), `${spec.label} resized.`)
                    }}>
                    <Icon name="drag_handle" size={17} />
                  </button>
                </Tooltip>
              </div>
              <div className="overview-layout-scroll"><div className="overview-layout-body">{card.content}</div></div>
            </article>
          )
        })}
      </div>
    </section>
  )
}
