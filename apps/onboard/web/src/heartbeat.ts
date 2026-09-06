interface HeartbeatPage {
  readonly visibilityState: string
  addEventListener(event: 'visibilitychange', listener: () => void): void
  removeEventListener(event: 'visibilitychange', listener: () => void): void
}

interface WizardHeartbeatOptions {
  page?: HeartbeatPage
  fetchImpl?: typeof fetch
}

/** Keep the local wizard available while its visible page is being used. */
export function startWizardHeartbeat({
  page = document,
  fetchImpl = fetch,
}: WizardHeartbeatOptions = {}): () => void {
  let stopped = false
  let inFlight = false
  let activeRequest: AbortController | null = null

  const ping = async (): Promise<void> => {
    if (stopped || page.visibilityState !== 'visible' || inFlight) return
    inFlight = true
    const controller = new AbortController()
    activeRequest = controller
    const timeout = setTimeout(() => controller.abort(), 5000)
    try {
      await fetchImpl('/healthz', { method: 'GET', cache: 'no-store', signal: controller.signal })
    } catch {
      // A health check never changes form state or replaces the error from a
      // user-requested action. The next visible interval can try again.
    } finally {
      clearTimeout(timeout)
      activeRequest = null
      inFlight = false
    }
  }

  const onVisibilityChange = (): void => { void ping() }
  page.addEventListener('visibilitychange', onVisibilityChange)
  const interval = setInterval(() => { void ping() }, 60_000)
  void ping()

  return () => {
    stopped = true
    clearInterval(interval)
    page.removeEventListener('visibilitychange', onVisibilityChange)
    activeRequest?.abort()
  }
}
