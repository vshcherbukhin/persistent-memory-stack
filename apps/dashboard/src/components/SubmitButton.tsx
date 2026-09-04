'use client'

import { useFormStatus } from 'react-dom'

/** A submit button that disables itself + shows pending text while its parent
 * <form action={serverAction}> is in flight. Generic across all the action forms. */
export function SubmitButton({
  children,
  pendingText,
  className,
  confirm,
}: {
  children: React.ReactNode
  pendingText?: string
  className?: string
  confirm?: string
}) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      className={className}
      onClick={(e) => {
        if (confirm && !window.confirm(confirm)) e.preventDefault()
      }}
    >
      {pending ? (pendingText ?? 'Working…') : children}
    </button>
  )
}
