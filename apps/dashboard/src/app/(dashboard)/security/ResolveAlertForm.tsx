'use client'

import { resolveAlertAction } from './actions'
import { SubmitButton } from '@/components/SubmitButton'
import type { MemorySurface } from '@/lib/types'

export function ResolveAlertForm({ id, surface }: { id: string; surface: MemorySurface }) {
  async function resolve(formData: FormData): Promise<void> {
    if (await resolveAlertAction(formData)) {
      window.dispatchEvent(new Event('pm:navigation-attention-changed'))
    }
  }

  return (
    <form action={resolve}>
      <input type="hidden" name="id" value={id} />
      <input type="hidden" name="surface" value={surface} />
      <SubmitButton pendingText="Resolving…">Resolve</SubmitButton>
    </form>
  )
}
