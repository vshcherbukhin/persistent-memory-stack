'use client'

import { createPortal } from 'react-dom'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type FocusEvent,
  type HTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react'

type TooltipPlacement = 'top' | 'bottom'
type TooltipPosition = {
  arrowLeft: number
  left: number
  placement: TooltipPlacement
  ready: boolean
  top: number
}

const GAP = 9
const VIEWPORT_MARGIN = 8

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

export function Tooltip({
  label,
  children,
  as = 'span',
  className,
  onBlur,
  onFocus,
  onMouseEnter,
  onMouseLeave,
  ...props
}: {
  label: ReactNode
  children: ReactNode
  as?: 'span' | 'div'
  className?: string
} & HTMLAttributes<HTMLElement>) {
  const tooltipId = useId()
  const triggerRef = useRef<HTMLElement | null>(null)
  const bubbleRef = useRef<HTMLSpanElement | null>(null)
  const [open, setOpen] = useState(false)
  const [position, setPosition] = useState<TooltipPosition>({
    arrowLeft: 0,
    left: -9999,
    placement: 'top',
    ready: false,
    top: -9999,
  })
  const classes = `ui-tooltip${as === 'div' ? ' ui-tooltip-block' : ''}${className ? ` ${className}` : ''}`

  const placeTooltip = useCallback(() => {
    const trigger = triggerRef.current
    const bubble = bubbleRef.current
    if (!trigger || !bubble) return

    const triggerRect = trigger.getBoundingClientRect()
    const bubbleRect = bubble.getBoundingClientRect()
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const maxLeft = Math.max(VIEWPORT_MARGIN, viewportWidth - bubbleRect.width - VIEWPORT_MARGIN)
    const centeredLeft = triggerRect.left + triggerRect.width / 2 - bubbleRect.width / 2
    const left = clamp(centeredLeft, VIEWPORT_MARGIN, maxLeft)
    const spaceAbove = triggerRect.top
    const spaceBelow = viewportHeight - triggerRect.bottom
    const placement: TooltipPlacement = spaceAbove >= bubbleRect.height + GAP || spaceAbove > spaceBelow
      ? 'top'
      : 'bottom'
    const desiredTop = placement === 'top'
      ? triggerRect.top - bubbleRect.height - GAP
      : triggerRect.bottom + GAP
    const top = clamp(
      desiredTop,
      VIEWPORT_MARGIN,
      Math.max(VIEWPORT_MARGIN, viewportHeight - bubbleRect.height - VIEWPORT_MARGIN),
    )
    const arrowLeft = clamp(
      triggerRect.left + triggerRect.width / 2 - left,
      12,
      Math.max(12, bubbleRect.width - 12),
    )

    setPosition((current) => {
      const next = { arrowLeft, left, placement, ready: true, top }
      return current.arrowLeft === next.arrowLeft &&
        current.left === next.left &&
        current.placement === next.placement &&
        current.ready === next.ready &&
        current.top === next.top
        ? current
        : next
    })
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    setPosition((current) => ({ ...current, ready: false }))
    const raf = window.requestAnimationFrame(placeTooltip)
    return () => window.cancelAnimationFrame(raf)
  }, [label, open, placeTooltip])

  useEffect(() => {
    if (!open) return
    window.addEventListener('resize', placeTooltip)
    window.addEventListener('scroll', placeTooltip, true)
    return () => {
      window.removeEventListener('resize', placeTooltip)
      window.removeEventListener('scroll', placeTooltip, true)
    }
  }, [open, placeTooltip])

  const show = (event: MouseEvent<HTMLElement>) => {
    onMouseEnter?.(event)
    setOpen(true)
  }
  const hide = (event: MouseEvent<HTMLElement>) => {
    onMouseLeave?.(event)
    setOpen(false)
  }
  const focus = (event: FocusEvent<HTMLElement>) => {
    onFocus?.(event)
    setOpen(true)
  }
  const blur = (event: FocusEvent<HTMLElement>) => {
    onBlur?.(event)
    if (triggerRef.current?.contains(event.relatedTarget as Node | null)) return
    setOpen(false)
  }

  const bubbleStyle = {
    left: position.left,
    top: position.top,
    '--tooltip-arrow-left': `${position.arrowLeft}px`,
  } as CSSProperties
  const bubble = typeof document === 'undefined' || !open
    ? null
    : createPortal(
        <span
          className="ui-tooltip-bubble"
          data-placement={position.placement}
          data-ready={position.ready ? 'true' : 'false'}
          id={tooltipId}
          ref={bubbleRef}
          role="tooltip"
          style={bubbleStyle}
        >
          {label}
        </span>,
        document.body,
      )
  const setDivTriggerRef = (node: HTMLDivElement | null) => {
    triggerRef.current = node
  }
  const setSpanTriggerRef = (node: HTMLSpanElement | null) => {
    triggerRef.current = node
  }

  if (as === 'div') {
    return (
      <div
        {...props}
        aria-describedby={open ? tooltipId : props['aria-describedby']}
        className={classes}
        onBlur={blur}
        onFocus={focus}
        onMouseEnter={show}
        onMouseLeave={hide}
        ref={setDivTriggerRef}
      >
        {children}
        {bubble}
      </div>
    )
  }

  return (
    <span
      {...props}
      aria-describedby={open ? tooltipId : props['aria-describedby']}
      className={classes}
      onBlur={blur}
      onFocus={focus}
      onMouseEnter={show}
      onMouseLeave={hide}
      ref={setSpanTriggerRef}
    >
      {children}
      {bubble}
    </span>
  )
}
