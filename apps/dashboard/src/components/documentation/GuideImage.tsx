'use client'

import { createElement, Fragment, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import { Icon } from '@/components/ui/Icon'

type FocusKeyEvent = Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'>
type FocusTarget = Pick<HTMLButtonElement, 'focus'>

export function containGuideImageFocus(event: FocusKeyEvent, closeButton: FocusTarget | null): boolean {
  if (event.key !== 'Tab') return false
  event.preventDefault()
  closeButton?.focus()
  return true
}

export function GuideImage({ src, alt }: { src: string; alt: string }) {
  const [isOpen, setIsOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!isOpen) return

    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    closeRef.current?.focus()

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false)
        return
      }
      containGuideImageFocus(event, closeRef.current)
    }
    window.addEventListener('keydown', onKeyDown)

    return () => {
      window.removeEventListener('keydown', onKeyDown)
      document.body.style.overflow = previousOverflow
      triggerRef.current?.focus()
    }
  }, [isOpen])

  const trigger = createElement(
    'button',
    {
      ref: triggerRef,
      type: 'button',
      className: 'guide-image-button',
      'aria-label': `Enlarge ${alt}`,
      onClick: () => setIsOpen(true),
    },
    createElement('img', { src, alt, loading: 'lazy' }),
    createElement(
      'span',
      { className: 'guide-image-expand', 'aria-hidden': 'true' },
      createElement(Icon, { name: 'zoom_out_map', size: 18 }),
    ),
  )

  const dialog = isOpen
    ? createElement(
        'div',
        {
          className: 'guide-image-dialog',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': `Enlarged ${alt}`,
          onMouseDown: (event: ReactMouseEvent<HTMLDivElement>) => {
            if (event.target === event.currentTarget) setIsOpen(false)
          },
        },
        createElement(
          'button',
          {
            ref: closeRef,
            type: 'button',
            className: 'guide-image-close',
            'aria-label': 'Close enlarged image',
            onClick: () => setIsOpen(false),
          },
          createElement(Icon, { name: 'close', size: 22 }),
        ),
        createElement('img', { src, alt }),
      )
    : null

  return createElement(Fragment, null, trigger, dialog)
}
