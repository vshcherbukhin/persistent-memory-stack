'use client'

import { useRef, useState, type ReactNode } from 'react'
import { Icon } from './Icon'

/**
 * Themed file picker (P5 follow-up). The native <input type=file> "Choose File" button
 * is OS-rendered and can't be styled, so we hide it and drive it from a styled button +
 * a filename label. The hidden input keeps its `name`, so it still submits with the
 * surrounding multipart <form>. `variant="dropzone"` renders the prototype's dashed
 * drop target, which also accepts a dragged file.
 */
export function FileInput({
  name,
  accept,
  buttonLabel = 'Choose file…',
  onFile,
  variant = 'inline',
  dropLabel,
}: {
  /** When set, the hidden input is named so it submits with a multipart <form>. */
  name?: string
  accept?: string
  buttonLabel?: string
  /** When set, called with the picked File for client-side reading (no form submit). */
  onFile?: (file: File | null) => void
  variant?: 'inline' | 'dropzone'
  /** Dropzone copy shown until a file is chosen. */
  dropLabel?: ReactNode
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  const [dragging, setDragging] = useState(false)
  const pick = (file: File | null) => {
    setFileName(file?.name ?? null)
    onFile?.(file)
  }
  const input = (
    <input
      ref={ref}
      type="file"
      name={name}
      accept={accept}
      className="ui-file-native"
      onChange={(e) => pick(e.target.files?.[0] ?? null)}
    />
  )

  if (variant === 'dropzone') {
    return (
      <>
        {input}
        <button
          type="button"
          className={`ui-file dropzone${dragging ? ' dragging' : ''}${fileName ? ' has-file' : ''}`}
          onClick={() => ref.current?.click()}
          onDragOver={(event) => {
            event.preventDefault()
            setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDragging(false)
            const files = event.dataTransfer.files
            // Keep the hidden input in step so a named field still submits the dropped file.
            if (ref.current && files.length > 0) ref.current.files = files
            pick(files[0] ?? null)
          }}
        >
          <Icon name={fileName ? 'description' : 'upload'} size={22} className="dropzone-icon" />
          <span className="dropzone-label">{fileName ?? dropLabel ?? 'Drop a file here'}</span>
          <span className="dropzone-hint">{fileName ? 'Choose a different file' : buttonLabel}</span>
        </button>
      </>
    )
  }

  return (
    <span className="ui-file">
      {input}
      <button type="button" className="secondary" onClick={() => ref.current?.click()}>
        {buttonLabel}
      </button>
      <span className="ui-file-name">{fileName ?? 'No file chosen'}</span>
    </span>
  )
}
