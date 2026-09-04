'use client'

import { useRef, useState } from 'react'

/**
 * Themed file picker (P5 follow-up). The native <input type=file> "Choose File" button
 * is OS-rendered and can't be styled, so we hide it and drive it from a styled button +
 * a filename label. The hidden input keeps its `name`, so it still submits with the
 * surrounding multipart <form>.
 */
export function FileInput({
  name,
  accept,
  buttonLabel = 'Choose file…',
  onFile,
}: {
  /** When set, the hidden input is named so it submits with a multipart <form>. */
  name?: string
  accept?: string
  buttonLabel?: string
  /** When set, called with the picked File for client-side reading (no form submit). */
  onFile?: (file: File | null) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const [fileName, setFileName] = useState<string | null>(null)
  return (
    <span className="ui-file">
      <input
        ref={ref}
        type="file"
        name={name}
        accept={accept}
        className="ui-file-native"
        onChange={(e) => {
          const f = e.target.files?.[0] ?? null
          setFileName(f?.name ?? null)
          onFile?.(f)
        }}
      />
      <button type="button" className="secondary" onClick={() => ref.current?.click()}>
        {buttonLabel}
      </button>
      <span className="ui-file-name">{fileName ?? 'No file chosen'}</span>
    </span>
  )
}
