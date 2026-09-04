export interface IdleTrackedSession {
  lastRequestAt: number
}

export function idleSessionIds<T extends IdleTrackedSession>(
  sessions: Map<string, T>,
  timeoutSeconds: number,
  nowMs = Date.now(),
): string[] {
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) return []
  const timeoutMs = timeoutSeconds * 1000
  return [...sessions.entries()]
    .filter(([, session]) => nowMs - session.lastRequestAt >= timeoutMs)
    .map(([id]) => id)
}
