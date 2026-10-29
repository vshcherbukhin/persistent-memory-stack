export const REQUIRED_ENVIRONMENT_CHECKS = ['node', 'npm', 'git', 'bash', 'docker', 'compose', 'buildx', 'composeConfig', 'rootWrite', 'ports', 'network'] as const
export type EnvironmentCheck = typeof REQUIRED_ENVIRONMENT_CHECKS[number]
export interface EnvironmentProbe { ok: boolean; detail: string; installed?: boolean; running?: boolean }
export interface EnvironmentSnapshot {
  capturedAt: string
  ok: boolean
  checks: Record<EnvironmentCheck, EnvironmentProbe>
}

export function environmentIssues(snapshot: EnvironmentSnapshot, now = Date.now()): Array<{ check: string; message: string }> {
  const captured = Date.parse(snapshot?.capturedAt)
  if (!Number.isFinite(captured) || now - captured > 30_000 || captured - now > 5_000) {
    return [{ check: 'freshness', message: 'Environment checks are stale or unavailable. Check this machine again before installing.' }]
  }
  return REQUIRED_ENVIRONMENT_CHECKS.flatMap((check) => snapshot.checks?.[check]?.ok === true ? [] : [{
    check, message: snapshot.checks?.[check]?.detail ?? `${check} could not be verified. Check this machine again.`,
  }])
}
