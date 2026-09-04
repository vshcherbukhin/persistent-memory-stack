import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const source = (path: string) => readFileSync(resolve(__dirname, path), 'utf8')

describe('capability-health dashboard presentation', () => {
  it('renders status-bearing overview cards with the approved settings deep links', () => {
    const overview = source('../app/(dashboard)/page.tsx')
    expect(overview).toContain('capabilityHealth')
    expect(overview).toContain('data-health-state')
    expect(overview).toContain("/settings?setting=fact-extraction")
    expect(overview).toContain("/settings?setting=embeddings")
  })

  it('uses healthy as the shared positive status word on summary cards', () => {
    const overview = source('../app/(dashboard)/page.tsx')

    expect(overview).toContain("return { label: 'healthy', tone: 'ok' }")
    expect(overview).not.toContain("return { label: 'health', tone: 'ok' }")
    expect(overview).not.toContain("return { label: 'live', tone: 'ok' }")
  })

  it('renders model capability cards through the reusable OverviewCard so badges use its shared top-right header slot', () => {
    const overview = source('../app/(dashboard)/page.tsx')
    const css = source('../app/globals.css')
    const modelSettings = overview.slice(overview.indexOf('aria-label="Model settings"'))

    expect(modelSettings.match(/<OverviewCard/g)).toHaveLength(2)
    expect(modelSettings).toContain('label="Fact extraction"')
    expect(modelSettings).toContain('label="Embeddings"')
    expect(modelSettings).toContain('actionLabel="Open settings"')
    expect(modelSettings).toContain('compact')
    expect(modelSettings).toContain('dataHealthState=')
    expect(modelSettings).not.toContain('overview-runtime')
    expect(css).toMatch(/\.overview-card\.compact\s*{[^}]*min-height:\s*0/s)
  })

  it('separates model capabilities with selected models and truthful status-update sources', () => {
    const services = source('../app/(dashboard)/services/ServicesClient.tsx')

    expect(services).toContain("const MODEL_CAPABILITY_SERVICE_IDS = new Set(['fact-extraction', 'embeddings'])")
    expect(services).toContain('const modelCapabilityServices = services.filter(isModelCapabilityService)')
    expect(services).toContain("const modelCapabilityCols = 'minmax(210px, 1fr) 140px minmax(245px, 1fr) minmax(300px, 1.5fr)'")
    expect(services).toContain('section-label">Model capabilities</div>')
    expect(services).toContain("renderServiceTable(modelCapabilityServices, 'No model capabilities found.', { activityColumnLabel: 'Status updates', columns: modelCapabilityCols })")
    expect(services).toContain('Selected model · ${s.configuredModel}')
    expect(services).toContain("s.service === 'ollama (host)' ? '' :")
    expect(services).toContain('Status updates after the latest request or a manual Fact extraction test in System Settings.')
    expect(services).toContain('Status updates after the latest embedding request, backfill, or a manual Embeddings test in System Settings.')
    expect(services).toContain('Host reachability is checked by the Ollama probe. Docker logs are not available.')
  })

  it('shows settled health recovery in settings and a keyboard-accessible usage error indicator', () => {
    const settings = source('../components/SettingsForm.tsx')
    const usage = source('../app/(dashboard)/usage/UsageClient.tsx')
    expect(settings).toContain('recovery')
    expect(settings).toContain('safeMessage')
    expect(usage).toContain('HealthErrorIndicator')
    expect(usage).toContain('tabIndex={0}')
    expect(usage).toContain('<Tooltip label=')
  })

  it('renders the scoped client-managed embedding health with the same safe recovery semantics', () => {
    const settings = source('../app/(dashboard)/settings/page.tsx')
    expect(settings).toContain('settings.capabilityHealth.embeddings')
    expect(settings).toContain('capabilityHealthPresentation')
    expect(settings).toContain('data-health-state')
    expect(settings).toContain('Recovery:')
  })
})
