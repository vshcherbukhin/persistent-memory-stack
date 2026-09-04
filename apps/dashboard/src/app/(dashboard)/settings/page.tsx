import { requireControlPlane, isSuperuser } from '@/lib/session'
import { api } from '@/lib/api'
import { FactExtractionForm, SettingsForm } from '@/components/SettingsForm'
import { McpSessionTimeoutForm } from '@/components/McpSessionTimeoutForm'
import { DashboardLoginModeForm } from '@/components/DashboardLoginModeForm'
import { SettingsLayout, SettingsPageFrame, SettingsSection, type SettingsNavItem } from '@/components/settings/SettingsShell'
import type { Settings } from '@/lib/types'
import { capabilityHealthPresentation } from '@/lib/capabilityHealth'

export const dynamic = 'force-dynamic'

function ClientBridgeEmbeddingCard({ settings }: { settings: Settings }) {
  const health = capabilityHealthPresentation(settings.capabilityHealth.embeddings)
  const noticeTone = health.tone === 'bad' ? 'danger' : health.tone
  return (
    <div>
      <div className="row" style={{ gap: 8, alignItems: 'center' }}>
        <span className="state-badge warn">Client-managed</span>
        <span className="chip-category">{settings.activeEmbedModel}</span>
        <span className="badge-readonly">dim {settings.activeEmbedDim}</span>
        <span className="badge-readonly">{settings.activeVectorName}</span>
      </div>
      <p className="note" style={{ maxWidth: 680 }}>
        To change this pin, update the server deployment and reconnect Shared Memories so every MCP uses the same local embedding model.
      </p>
      <div className={`notice ${noticeTone}`} data-health-state={settings.capabilityHealth.embeddings.state} style={{ marginTop: 14 }}>
        <div className="notice-title">Client embedding health: {health.badge}</div>
        {settings.capabilityHealth.embeddings.safeMessage ?? health.message}
        <div className="muted" style={{ marginTop: 6 }}>Observed {health.observedAt}. Recovery: {health.recovery}</div>
      </div>
    </div>
  )
}

/**
 * System Settings — SUPERUSER-ONLY. Defense in depth: the Nav link is hidden for
 * non-superusers, AND this page refuses to render the form for them, AND the
 * server's PUT /dashboard/settings is gated by requireSuperuser. Three layers.
 */
export default async function SettingsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const who = await requireControlPlane()
  if (!isSuperuser(who)) {
    return (
      <>
        <h1>System Settings</h1>
        <div className="notice danger">
          Forbidden — system settings are superuser-only. Your admin_level is {who.adminLevel}.
        </div>
      </>
    )
  }

  const settings = await api.getSettings()
  const personalMode = who.deploymentMode === 'local'
  const params = searchParams ? await searchParams : {}
  const requestedSetting = Array.isArray(params.setting) ? params.setting[0] : params.setting
  const settingsItems: SettingsNavItem[] = [
    {
      id: 'fact-extraction',
      label: 'Fact extraction',
      description: 'Shape-gate model and API key',
      href: settingsSettingHref('fact-extraction'),
    },
    {
      id: 'embeddings',
      label: 'Embeddings',
      description: 'Model pin and vector dimension',
      href: settingsSettingHref('embeddings'),
    },
    {
      id: 'stream-sessions',
      label: 'Stream sessions',
      description: 'MCP idle timeout',
      href: settingsSettingHref('stream-sessions'),
    },
    ...(!personalMode
      ? [{
          id: 'dashboard-login',
          label: 'Dashboard login',
          description: 'Password or SSO login mode',
          href: settingsSettingHref('dashboard-login'),
        }]
      : []),
  ]
  const activeSetting = settingsItems.some((item) => item.id === requestedSetting)
    ? requestedSetting!
    : settingsItems[0]?.id ?? 'fact-extraction'

  return (
    <SettingsPageFrame>
      <SettingsLayout items={settingsItems} activeId={activeSetting}>
        <SettingsSection
          id="fact-extraction"
          title="Fact extraction"
          description="Memory Shape-gate model and provider key. Saves use a backend seeded probe unless this form was tested successfully first."
        >
          <FactExtractionForm current={settings} showHeader={false} />
        </SettingsSection>
        <SettingsSection
          id="embeddings"
          title={settings.embeddingMode === 'client-bridge' ? 'Client-managed embedding pin' : 'Embeddings'}
          description={
            settings.embeddingMode === 'client-bridge'
              ? 'Memory vectors are produced by each client MCP, so the server records the required pin but does not manage an embedding engine here.'
              : 'Server-side embedding pin and vector dimension. Model changes trigger the safe re-embed workflow.'
          }
        >
          {settings.embeddingMode === 'client-bridge' ? (
            <ClientBridgeEmbeddingCard settings={settings} />
          ) : (
            <SettingsForm current={settings} deploymentMode={who.deploymentMode ?? 'server'} showHeader={false} />
          )}
        </SettingsSection>
        <SettingsSection
          id="stream-sessions"
          title="Stream service session timeout"
          description="Inactive Stream MCP sessions are closed after this idle period. Codex and Claude can open a fresh session automatically."
        >
          <McpSessionTimeoutForm current={settings} showHeader={false} />
        </SettingsSection>
        {!personalMode ? (
          <SettingsSection
            id="dashboard-login"
            title="Dashboard login"
            description="Password login is used for human dashboard sessions. SSO switches the login page to the SSO card; recovery tokens remain available."
          >
            <DashboardLoginModeForm current={settings} showHeader={false} />
          </SettingsSection>
        ) : null}
      </SettingsLayout>
    </SettingsPageFrame>
  )
}

function settingsSettingHref(setting: string): string {
  const params = new URLSearchParams()
  params.set('setting', setting)
  return `/settings?${params.toString()}`
}
