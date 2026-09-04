import { api, whoamiWithToken } from '@/lib/api'
import { compareSemver } from '@/lib/clientUpdate'
import { SESSION_COOKIE } from '@/lib/cookies'
import { isLocalMode } from '@/lib/deploymentMode'
import { hasValidLocalSession } from '@/lib/local-session'
import { APP_VERSION } from '@/lib/version'
import { cookies } from 'next/headers'

export const dynamic = 'force-dynamic'

function notReady(reason: string, status = 503, message?: string): Response {
  return Response.json({ ready: false, reason, message }, { status })
}

export async function GET(req: Request): Promise<Response> {
  const targetVersion = new URL(req.url).searchParams.get('version')
  if (targetVersion && compareSemver(APP_VERSION, targetVersion) < 0) {
    return notReady('dashboard_version_not_deployed')
  }

  try {
    if (isLocalMode) {
      const localAuth = await api.localAuthStatus()
      if (localAuth.passwordSet && !(await hasValidLocalSession())) {
        return notReady('local_session_required', 401)
      }
      await Promise.all([api.whoami(), api.getProfile(), api.getOverview('personal')])
      return Response.json({ ready: true })
    }

    const token = (await cookies()).get(SESSION_COOKIE)?.value
    if (!token) return notReady('session_required', 401)
    const who = await whoamiWithToken(token)
    if (!who) return notReady('session_invalid', 401)
    await Promise.all([api.getProfile(), api.getOverview('personal')])
    return Response.json({ ready: true })
  } catch (err) {
    return notReady('dashboard_dependencies_unready', 503, err instanceof Error ? err.message : String(err))
  }
}
