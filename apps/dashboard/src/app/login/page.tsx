import { redirect } from 'next/navigation'
import { isLocalMode } from '@/lib/deploymentMode'
import { api } from '@/lib/api'
import { LoginForm } from './LoginForm'

/**
 * Login page. Server mode reads /config to decide password vs SSO card. Local
 * mode is only reachable when a dashboard password is configured; otherwise the
 * dashboard opens directly.
 */
export default async function LoginPage() {
  if (isLocalMode) {
    const { passwordSet } = await api.localAuthStatus().catch(() => ({ passwordSet: false }))
    if (!passwordSet) redirect('/')
    return <LoginForm mode="local" />
  }
  const cfg = await api.getPublicConfig().catch(() => ({ dashboardLoginMode: 'password' as const }))
  return <LoginForm mode="server" dashboardLoginMode={cfg.dashboardLoginMode} />
}
