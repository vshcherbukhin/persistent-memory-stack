export type MemoryUpdateActionResult =
  | { ok: true }
  | { ok: false; error: string }

/**
 * Resolve an update result without turning an expected API conflict into a
 * render error. The success callback owns editor close + list refresh, so a
 * failure cannot accidentally discard the user's draft.
 */
export async function handleMemoryUpdateResult(
  result: MemoryUpdateActionResult,
  onError: (error: string) => void,
  onSuccess: () => void | Promise<void>,
): Promise<boolean> {
  if (!result.ok) {
    onError(result.error)
    return false
  }

  await onSuccess()
  return true
}
