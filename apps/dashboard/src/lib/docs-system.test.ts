import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { NextRequest } from 'next/server'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VisualGuide, guideImageUrl } from '../components/documentation/VisualGuide'

const { requireSessionMock } = vi.hoisted(() => ({
  requireSessionMock: vi.fn(),
}))

vi.mock('@/components/ui/Icon', () => ({
  Icon: ({ name }: { name: string }) => createElement('span', null, name),
}))
vi.mock('@/lib/session', () => ({ requireSession: requireSessionMock }))

const dashboard = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const root = (path: string) => readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8')

const personalGuidePages = [
  { file: 'index.md', screenshots: ['personal-space-start.png'] },
  { file: 'navigation-and-spaces.md', screenshots: ['navigation-sidebar.png', 'space-switcher.png', 'tooltip-example.png'] },
  { file: 'overview.md', screenshots: ['overview-widgets.png'] },
  { file: 'memories.md', screenshots: ['memories-page.png', 'memory-details-modal.png', 'memory-edit-modal.png', 'memory-tools.png'] },
  { file: 'services.md', screenshots: ['services-page.png', 'mcp-sessions.png', 'service-logs-modal.png'] },
  { file: 'workers.md', screenshots: ['workers-page.png', 'worker-schedule-modal.png', 'worker-logs-modal.png'] },
  { file: 'token-usage.md', screenshots: ['token-usage-page.png'] },
  { file: 'security.md', screenshots: ['security-empty.png', 'security-finding.png'] },
  { file: 'notifications.md', screenshots: ['system-notifications.png'] },
  { file: 'system-settings.md', screenshots: ['settings-fact-extraction.png', 'settings-embeddings.png', 'settings-stream-sessions.png'] },
  { file: 'profile.md', screenshots: ['profile-modal.png'] },
  { file: 'releases-and-updates.md', screenshots: ['application-updates.png', 'release-notes-modal.png', 'update-progress.png'] },
] as const

const personalSpaceNavigation = [
  ['Start here', 'spaces/personal/index.md'],
  ['Navigation and spaces', 'spaces/personal/navigation-and-spaces.md'],
  ['Overview', 'spaces/personal/overview.md'],
  ['Memories', 'spaces/personal/memories.md'],
  ['Services', 'spaces/personal/services.md'],
  ['Workers', 'spaces/personal/workers.md'],
  ['Token usage', 'spaces/personal/token-usage.md'],
  ['Security', 'spaces/personal/security.md'],
  ['Notifications', 'spaces/personal/notifications.md'],
  ['System Settings', 'spaces/personal/system-settings.md'],
  ['Profile', 'spaces/personal/profile.md'],
  ['Releases and updates', 'spaces/personal/releases-and-updates.md'],
] as const

beforeEach(() => {
  requireSessionMock.mockReset()
  requireSessionMock.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.resetModules()
})

describe('dashboard documentation integration', () => {
  it('builds documentation as a dedicated service instead of bundling it into dashboard', () => {
    const compose = root('deploy/compose/docker-compose.yml')
    const documentationDockerfile = root('apps/documentation/Dockerfile')
    const dashboardDockerfile = root('apps/dashboard/Dockerfile')
    const componentDoc = root('documentation/components/dashboard.md')
    const servicesClient = dashboard('../app/(dashboard)/services/ServicesClient.tsx')

    expect(compose).toMatch(/^  documentation:\n/m)
    expect(compose).toContain('image: ${PM_IMAGE_PREFIX:-persistent-memory}-documentation:latest')
    expect(compose).toContain('DOCUMENTATION_BASE_URL: http://${PM_CONTAINER_PREFIX:-persistent-memory}-documentation:8000')
    expect(documentationDockerfile).toContain('mkdocs build --site-dir /site')
    expect(documentationDockerfile).toContain('CMD ["node", "src/server.mjs"]')
    expect(dashboardDockerfile).not.toMatch(/AS docs/)
    expect(dashboardDockerfile).not.toContain('public/docs')
    expect(componentDoc).toContain('`DOCUMENTATION_BASE_URL`')
    expect(componentDoc).toContain('native dashboard guide')
    expect(componentDoc).toContain('opens the stack documentation separately')
    expect(componentDoc).not.toContain('`DASHBOARD_DOCS_URL`')
    expect(componentDoc).not.toContain('public/docs')
    expect(servicesClient).toContain("dashboard: ['api', 'documentation']")
    expect(servicesClient).toContain("'dashboard-gateway': ['dashboard']")
  })

  it('keeps dashboard help native and opens stack documentation separately', () => {
    const page = dashboard('../app/(dashboard)/documentation/page.tsx')
    const proxyRouteUrl = new URL('../app/docs/[[...path]]/route.ts', import.meta.url)

    expect(page).not.toContain('redirect(')
    expect(page).not.toContain('<iframe')
    expect(page).toContain('dashboardDocumentationFor')
    expect(page).toContain('href="/docs/index.html"')
    expect(page).toContain('target="_blank"')
    expect(page).toContain('Stack documentation')
    expect(existsSync(proxyRouteUrl)).toBe(true)
    const proxyRoute = readFileSync(proxyRouteUrl, 'utf8')
    expect(proxyRoute).toContain("process.env.DOCUMENTATION_BASE_URL ?? 'http://persistent-memory-documentation:8000'")
    expect(proxyRoute).toContain("path.join('/')")
  })

  it('authenticates documentation handlers before upstream or filesystem work', async () => {
    const proxySource = dashboard('../app/docs/[[...path]]/route.ts')
    const assetSource = dashboard('../app/documentation-assets/[...path]/route.ts')

    expect(proxySource).toContain("import { requireSession } from '@/lib/session'")
    expect(assetSource).toContain("import { requireSession } from '@/lib/session'")
    expect(proxySource.indexOf('await requireSession()')).toBeLessThan(proxySource.indexOf('await fetch('))
    expect(assetSource.indexOf('await requireSession()')).toBeLessThan(assetSource.indexOf('await context.params'))

    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    requireSessionMock.mockRejectedValueOnce(new Error('authentication rejected'))
    const { GET: proxyGET } = await import('../app/docs/[[...path]]/route')
    await expect(proxyGET(
      new NextRequest('http://localhost/docs/index.html'),
      { params: Promise.resolve({ path: ['index.html'] }) },
    )).rejects.toThrow('authentication rejected')
    expect(fetchMock).not.toHaveBeenCalled()

    vi.resetModules()
    vi.stubEnv('DASHBOARD_GUIDE_ROOT', '/definitely/not/a/documentation/root')
    requireSessionMock.mockRejectedValueOnce(new Error('asset authentication rejected'))
    const { GET: assetGET } = await import('../app/documentation-assets/[...path]/route')
    await expect(assetGET(
      new NextRequest('http://localhost/documentation-assets/spaces/personal/overview-page.png'),
      { params: Promise.resolve({ path: ['spaces', 'personal', 'overview-page.png'] }) },
    )).rejects.toThrow('asset authentication rejected')
  })

  it('forwards private guide screenshot caching after authenticating the docs proxy', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('png', {
      headers: {
        'cache-control': 'private, no-cache',
        'content-type': 'image/png',
      },
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { GET } = await import('../app/docs/[[...path]]/route')

    const response = await GET(
      new NextRequest('http://localhost/docs/assets/spaces/personal/overview-page.png'),
      { params: Promise.resolve({ path: ['assets', 'spaces', 'personal', 'overview-page.png'] }) },
    )

    expect(response.headers.get('cache-control')).toBe('private, no-cache')
    expect(requireSessionMock).toHaveBeenCalledOnce()
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(requireSessionMock.mock.invocationCallOrder[0]).toBeLessThan(fetchMock.mock.invocationCallOrder[0])
  })

  it('loads canonical Personal guide frontmatter and preserves topic order and slugs', async () => {
    vi.stubEnv(
      'DASHBOARD_GUIDE_ROOT',
      fileURLToPath(new URL('../../../../documentation', import.meta.url)),
    )
    const { dashboardDocumentationFor, dashboardDocumentationTopic } = await import('./dashboardDocumentation')

    const topics = dashboardDocumentationFor('local-personal')

    expect(topics.map((topic) => topic.slug)).toEqual([
      'getting-started',
      'navigation-and-spaces',
      'overview',
      'memories',
      'services',
      'workers',
      'token-usage',
      'security',
      'notifications',
      'system-settings',
      'profile',
      'releases-and-updates',
    ])
    expect(topics[0]).toMatchObject({
      title: 'Personal Space guide',
      summary: 'Start here to understand and safely operate the local Personal Memories dashboard.',
      icon: 'home',
    })
    expect(topics[0].markdown).toContain('# Personal Space guide')
    expect(topics[0].markdown).toContain('../../assets/spaces/personal/personal-space-start.png')
    expect(topics[0].markdown).not.toMatch(/^---/)
    expect(dashboardDocumentationTopic('local-personal', 'not-a-topic').slug).toBe('getting-started')
  })

  it('renders the canonical article through VisualGuide instead of summary sections', () => {
    const page = dashboard('../app/(dashboard)/documentation/page.tsx')
    const visualGuideUrl = new URL('../components/documentation/VisualGuide.tsx', import.meta.url)

    expect(existsSync(visualGuideUrl)).toBe(true)
    expect(page).toContain("import { VisualGuide } from '@/components/documentation/VisualGuide'")
    expect(page).toContain('<VisualGuide markdown={topic.markdown}')
    expect(page).not.toContain('topic.sections.map')
  })

  it('uses react-markdown with GFM tables and safe guide image mapping', () => {
    const packageJson = JSON.parse(dashboard('../../package.json')) as {
      dependencies?: Record<string, string>
    }
    const packageLock = JSON.parse(dashboard('../../package-lock.json')) as {
      packages?: Record<string, { dependencies?: Record<string, string>; version?: string }>
    }
    const visualGuideUrl = new URL('../components/documentation/VisualGuide.tsx', import.meta.url)
    const visualGuide = existsSync(visualGuideUrl) ? readFileSync(visualGuideUrl, 'utf8') : ''

    expect(packageJson.dependencies?.['react-markdown']).toBe('10.1.0')
    expect(packageJson.dependencies?.['remark-gfm']).toBe('4.0.1')
    expect(packageLock.packages?.['']?.dependencies?.['react-markdown']).toBe('10.1.0')
    expect(packageLock.packages?.['']?.dependencies?.['remark-gfm']).toBe('4.0.1')
    expect(packageLock.packages?.['node_modules/react-markdown']?.version).toBe('10.1.0')
    expect(packageLock.packages?.['node_modules/remark-gfm']?.version).toBe('4.0.1')
    expect(visualGuide).toContain("from 'react-markdown'")
    expect(visualGuide).toContain("from 'remark-gfm'")
    expect(visualGuide).toContain('remarkPlugins: [remarkGfm]')
    expect(visualGuide).toContain('defaultUrlTransform')
    expect(visualGuide).toContain("../../assets/spaces/")
    expect(visualGuide).toContain("/documentation-assets/spaces/")
    expect(visualGuide).not.toContain('rehypeRaw')
    expect(visualGuide).not.toContain('dangerouslySetInnerHTML')
  })

  it('maps only canonical Personal guide PNG image references', () => {
    expect(typeof guideImageUrl).toBe('function')
    expect(guideImageUrl('../../assets/spaces/personal/overview-page.png')).toBe(
      '/documentation-assets/spaces/personal/overview-page.png',
    )
    for (const rejected of [
      'https://example.com/overview-page.png',
      '../../assets/spaces/personal/../overview-page.png',
      '../../assets/spaces/personal/overview-page.jpg',
      '/documentation-assets/spaces/personal/overview-page.png',
      'data:image/png;base64,AAAA',
    ]) {
      expect(guideImageUrl(rejected)).toBe('')
    }
  })

  it('server-renders mapped guide images while suppressing raw HTML and external images', () => {
    const markup = renderToStaticMarkup(createElement(VisualGuide, {
      summary: 'Safe guide rendering',
      markdown: [
        '# Guide',
        '',
        '<script>alert("raw html")</script>',
        '',
        '![Canonical screenshot](../../assets/spaces/personal/overview-page.png)',
        '',
        '![External screenshot](https://example.com/external.png)',
      ].join('\n'),
    }))

    expect(markup).toContain('/documentation-assets/spaces/personal/overview-page.png')
    expect(markup).not.toContain('<script')
    expect(markup).not.toContain('raw html')
    expect(markup).not.toContain('example.com')
  })

  it('server-renders guide tables as semantic HTML', () => {
    const markup = renderToStaticMarkup(createElement(VisualGuide, {
      summary: 'Readable guide tables',
      markdown: ['# Guide', '', '| State | Meaning |', '| --- | --- |', '| Healthy | Available |'].join('\n'),
    }))

    expect(markup).toContain('<table>')
    expect(markup).toContain('<th>State</th>')
    expect(markup).toContain('<td>Available</td>')
  })

  it('provides an accessible click-to-enlarge guide image', () => {
    const guideImageUrl = new URL('../components/documentation/GuideImage.tsx', import.meta.url)
    const guideImage = existsSync(guideImageUrl) ? readFileSync(guideImageUrl, 'utf8') : ''

    expect(existsSync(guideImageUrl)).toBe(true)
    expect(guideImage).toContain("'use client'")
    expect(guideImage).toContain("'aria-label': `Enlarge ${alt}`")
    expect(guideImage).toContain("role: 'dialog'")
    expect(guideImage).toContain("'aria-modal': 'true'")
    expect(guideImage).toContain("event.key === 'Escape'")
    expect(guideImage).toContain('containGuideImageFocus(event, closeRef.current)')
    expect(guideImage).toContain("document.body.style.overflow = 'hidden'")
    expect(guideImage).toContain('triggerRef.current?.focus()')
    expect(guideImage).toContain("createElement(Icon, { name: 'close'")
  })

  it('keeps Tab and Shift+Tab focus on the only dialog control', async () => {
    const guideImageModule = await import('../components/documentation/GuideImage') as unknown as {
      containGuideImageFocus?: (
        event: { key: string; shiftKey: boolean; preventDefault: () => void },
        closeButton: { focus: () => void } | null,
      ) => boolean
    }

    expect(typeof guideImageModule.containGuideImageFocus).toBe('function')
    if (!guideImageModule.containGuideImageFocus) return

    for (const shiftKey of [false, true]) {
      const preventDefault = vi.fn()
      const focus = vi.fn()
      expect(guideImageModule.containGuideImageFocus(
        { key: 'Tab', shiftKey, preventDefault },
        { focus },
      )).toBe(true)
      expect(preventDefault).toHaveBeenCalledOnce()
      expect(focus).toHaveBeenCalledOnce()
    }

    const preventDefault = vi.fn()
    expect(guideImageModule.containGuideImageFocus(
      { key: 'Escape', shiftKey: false, preventDefault },
      { focus: vi.fn() },
    )).toBe(false)
    expect(preventDefault).not.toHaveBeenCalled()
  })

  it('serves only canonical PNG guide assets with GET and HEAD', async () => {
    vi.stubEnv(
      'DASHBOARD_GUIDE_ROOT',
      fileURLToPath(new URL('../../../../documentation', import.meta.url)),
    )
    const routeUrl = new URL('../app/documentation-assets/[...path]/route.ts', import.meta.url)
    expect(existsSync(routeUrl)).toBe(true)
    if (!existsSync(routeUrl)) return

    const { GET, HEAD } = await import(routeUrl.href)
    const context = (path: string[]) => ({ params: Promise.resolve({ path }) })
    const validPath = ['spaces', 'personal', 'overview-page.png']
    const getResponse = await GET(
      new NextRequest('http://localhost/documentation-assets/spaces/personal/overview-page.png'),
      context(validPath),
    )
    const headResponse = await HEAD(
      new NextRequest('http://localhost/documentation-assets/spaces/personal/overview-page.png'),
      context(validPath),
    )

    expect(getResponse.status).toBe(200)
    expect(getResponse.headers.get('content-type')).toBe('image/png')
    expect(getResponse.headers.get('x-content-type-options')).toBe('nosniff')
    expect(Number(getResponse.headers.get('content-length'))).toBeGreaterThan(0)
    expect(getResponse.headers.get('cache-control')).toBe('private, no-cache')
    expect(headResponse.status).toBe(200)
    expect((await headResponse.arrayBuffer()).byteLength).toBe(0)

    for (const path of [
      ['spaces', 'personal', '..', 'overview-page.png'],
      ['spaces', 'personal', 'overview-page.jpg'],
      ['other', 'personal', 'overview-page.png'],
    ]) {
      const response = await GET(new NextRequest('http://localhost/documentation-assets/rejected'), context(path))
      expect(response.status).toBe(404)
    }
  })

  it('copies canonical Personal guide Markdown and assets into the production dashboard image', () => {
    const dockerfile = root('apps/dashboard/Dockerfile')

    expect(dockerfile).toContain('COPY documentation/spaces /app/documentation/spaces')
    expect(dockerfile).toContain('COPY documentation/assets/spaces /app/documentation/assets/spaces')
    expect(dockerfile).toContain('ENV DASHBOARD_GUIDE_ROOT=/app/documentation')
  })

  it('keeps the visual guide responsive at desktop and narrow dashboard widths', () => {
    const styles = dashboard('../app/globals.css')
    const mobileStart = styles.indexOf('@media (max-width: 680px)')
    const mobileEnd = styles.indexOf('.page-fill,', mobileStart)
    const mobileStyles = styles.slice(mobileStart, mobileEnd)

    expect(styles).toMatch(/\.dashboard-docs-layout\s*{[^}]*grid-template-columns: 230px minmax\(0, 1fr\)/s)
    expect(styles).toMatch(/\.guide-image-button\s*{[^}]*aspect-ratio: 16 \/ 9[^}]*width: 100%/s)
    expect(mobileStart).toBeGreaterThan(-1)
    expect(mobileStyles).toMatch(/\.dashboard-docs-layout\s*{[^}]*display: flex[^}]*flex-direction: column/s)
    expect(mobileStyles).toMatch(/\.dashboard-docs-nav\s*{[^}]*overflow-x: auto/s)
    expect(mobileStyles).toMatch(/\.guide-image-dialog\s*{[^}]*padding: 50px 10px 10px/s)
  })

  it('loads the canonical development guides for Shared and Hosted dashboard spaces', async () => {
    vi.stubEnv(
      'DASHBOARD_GUIDE_ROOT',
      fileURLToPath(new URL('../../../../documentation', import.meta.url)),
    )
    const guideUrl = new URL('../lib/dashboardDocumentation.ts', import.meta.url)
    const guide = existsSync(guideUrl) ? readFileSync(guideUrl, 'utf8') : ''
    const { dashboardDocumentationFor } = await import('./dashboardDocumentation')

    expect(guide).toContain("export type DashboardDocumentationSpace = 'local-personal' | 'local-shared-client' | 'shared-server'")
    expect(dashboardDocumentationFor('local-personal').map((topic) => topic.icon)).toEqual(
      expect.arrayContaining(['dashboard', 'memory']),
    )
    expect(dashboardDocumentationFor('local-shared-client')).toEqual([
      expect.objectContaining({
        slug: 'getting-started',
        title: 'Shared Space Documentation',
        icon: 'cloud_sync',
      }),
    ])
    expect(dashboardDocumentationFor('shared-server')).toEqual([
      expect.objectContaining({
        slug: 'getting-started',
        title: 'Hosted Server Dashboard Documentation',
        icon: 'admin_panel_settings',
      }),
    ])
    expect(dashboardDocumentationFor('local-shared-client')[0].markdown).toContain('**Status: In development.**')
    expect(dashboardDocumentationFor('local-shared-client')[0].markdown).toContain('Personal Space remains the supported local workflow')
    expect(dashboardDocumentationFor('shared-server')[0].markdown).toContain('**Status: In development.**')
    expect(dashboardDocumentationFor('shared-server')[0].markdown).toContain('separate hosted control-plane dashboard')
    expect(guide).toContain('dashboardGuideSources')
    expect(guide).toContain('dashboard_space')
    expect(guide).not.toContain('FALLBACK_TOPICS')
    expect(guide).toContain('dashboardDocumentationFor')
  })

  it('publishes the exact user-facing Spaces tree and every Personal guide path', () => {
    const config = root('mkdocs.yml')
    const spacesBlock = [
      '  - "Spaces":',
      '      - "Personal Space Documentation":',
      ...personalSpaceNavigation.map(([label, path]) => `          - "${label}": ${path}`),
      '      - "Shared Space Documentation":',
      '          - "In development": spaces/shared/index.md',
      '      - "Hosted Server Dashboard Documentation":',
      '          - "In development": spaces/hosted-server/index.md',
    ].join('\n')

    expect(config).toMatch(/^strict: true$/m)
    expect(config).toContain(spacesBlock)
    expect(config).not.toContain('      - Local Personal:')
    expect(config).not.toContain('      - Local Shared Client:')
    expect(config).not.toContain('      - Shared Server:')
  })

  it('keeps Shared and Hosted user guides explicitly in development', () => {
    const sharedUrl = new URL('../../../../documentation/spaces/shared/index.md', import.meta.url)
    const hostedUrl = new URL('../../../../documentation/spaces/hosted-server/index.md', import.meta.url)

    expect(existsSync(sharedUrl)).toBe(true)
    expect(existsSync(hostedUrl)).toBe(true)
    if (!existsSync(sharedUrl) || !existsSync(hostedUrl)) return

    const shared = readFileSync(sharedUrl, 'utf8')
    const hosted = readFileSync(hostedUrl, 'utf8')
    expect(shared).toContain('title: Shared Space Documentation')
    expect(shared).toContain('**Status: In development.**')
    expect(shared).toContain('local Shared Space client and dashboard are in development')
    expect(shared).toContain('Personal Space remains the supported local workflow')
    expect(shared).not.toMatch(/^##? (Setup|Testing)$/m)
    expect(hosted).toContain('title: Hosted Server Dashboard Documentation')
    expect(hosted).toContain('**Status: In development.**')
    expect(hosted).toContain('separate hosted control-plane dashboard')
    expect(hosted).toMatch(/for superusers only/)
    expect(hosted).not.toMatch(/authorized\s+administrator roles/)
    expect(hosted).toMatch(/not a third local\s+space/)
  })

  it('uses a fluid desktop grid with restrained sidebars and responsive overflow', () => {
    const styles = root('documentation/stylesheets/pm-management.css')

    expect(styles).toMatch(/\.md-grid\s*{[^}]*max-width:\s*112rem[^}]*width:\s*100%/s)
    expect(styles).toMatch(/\.md-content\s*{[^}]*min-width:\s*0/s)
    expect(styles).toMatch(/\.md-content__inner\s*{[^}]*max-width:\s*none/s)
    expect(styles).toMatch(/@media screen and \(min-width:\s*76\.25em\)[\s\S]*\.md-sidebar--primary[\s\S]*max-width:\s*13rem/s)
    expect(styles).toMatch(/@media screen and \(min-width:\s*76\.25em\)[\s\S]*\.md-sidebar--secondary[\s\S]*max-width:\s*12rem/s)
    expect(styles).toMatch(/\.md-typeset__table\s*{[^}]*overflow-x:\s*auto/s)
    expect(styles).not.toMatch(/font-size:\s*(?:clamp|min|max|calc)\([^;]*(?:vw|vh|vmin|vmax)/)
  })

  it('does not install custom primary-navigation scrolling behavior', () => {
    const mainOverride = root('documentation/overrides/main.html')
    const navItemOverride = root('documentation/overrides/partials/nav-item.html')

    expect(mainOverride).not.toContain("'javascripts/navigation.mjs' | url")
    expect(mainOverride).not.toContain('pm-docs-primary-navigation')
    expect(navItemOverride).not.toContain('data-md-scrollfix')
  })

  it('places documentation controls in the top bar and bottom sidebar', () => {
    const header = dashboard('../components/AppHeader.tsx')
    const nav = dashboard('../components/Nav.tsx')

    expect(header).toContain("documentation: ['Documentation', 'Dashboard help for pages and tools']")
    expect(header).toContain('aria-label="Open documentation"')
    expect(header).toContain('<Icon name="menu_book"')
    expect(header.indexOf('aria-label="Open documentation"')).toBeLessThan(header.indexOf('aria-label="Open release notes"'))
    expect(nav).toContain('className="nav-documentation"')
    expect(nav).toContain("withSpace('/documentation', selectedSpace)")
    expect(nav).toContain('<Icon name="menu_book"')
  })

  it('bundles and initializes Mermaid for architecture diagrams', () => {
    const config = root('mkdocs.yml')
    const initializerUrl = new URL('../../../../documentation/javascripts/mermaid.mjs', import.meta.url)
    const mainOverrideUrl = new URL('../../../../documentation/overrides/main.html', import.meta.url)
    const docsPackageUrl = new URL('../../../../apps/documentation/package.json', import.meta.url)
    const dockerfile = root('apps/documentation/Dockerfile')
    const rootPackage = JSON.parse(root('package.json')) as {
      scripts?: Record<string, string>
    }

    expect(config).not.toContain('assets/javascripts/mermaid.min.js')
    expect(config).not.toContain('javascripts/mermaid.mjs')
    expect(config).toContain('class: pm-mermaid-source')
    expect(config).toMatch(/^  node_modules\/$/m)
    expect(existsSync(docsPackageUrl)).toBe(true)
    const docsPackage = JSON.parse(readFileSync(docsPackageUrl, 'utf8')) as {
      devDependencies?: Record<string, string>
    }
    expect(docsPackage.devDependencies?.mermaid).toBe('11.16.0')
    expect(dockerfile).toContain('node_modules/mermaid/dist/mermaid.min.js')
    expect(dockerfile).toContain('/site/assets/javascripts/mermaid.min.js')
    expect(rootPackage.scripts?.['docs:install']).toContain('npm ci --prefix apps/documentation')
    expect(rootPackage.scripts?.['docs:build']).toContain('mermaid.min.js')
    expect(existsSync(initializerUrl)).toBe(true)
    expect(existsSync(mainOverrideUrl)).toBe(true)
    const mainOverride = existsSync(mainOverrideUrl) ? readFileSync(mainOverrideUrl, 'utf8') : ''
    expect(mainOverride).toContain("'assets/javascripts/mermaid.min.js' | url")
    expect(mainOverride).toContain("'javascripts/mermaid.mjs' | url")
    expect(mainOverride).toContain('?v={{ config.extra.docs_version }}')
    expect(mainOverride).toContain('?v={{ config.extra.docs_version }}-ui')
    expect(mainOverride.indexOf("'assets/javascripts/mermaid.min.js' | url")).toBeLessThan(mainOverride.indexOf("'javascripts/mermaid.mjs' | url"))
    expect(mainOverride.indexOf("'javascripts/mermaid.mjs' | url")).toBeLessThan(mainOverride.indexOf('{{ super() }}'))
    const initializer = readFileSync(initializerUrl, 'utf8')
    expect(initializer).toContain('const pmMermaid = window.mermaid')
    expect(initializer).toContain('window.mermaid = pmMermaid')
    expect(initializer).not.toContain('https://')
    expect(initializer).not.toContain('mermaid.run(')
    expect(initializer).toContain('pmMermaid.render(')
    expect(initializer).toContain("className = 'pm-mermaid-diagram'")
    expect(initializer).toContain('source.replaceWith(diagram)')
    expect(initializer).toContain('new MutationObserver')
    expect(initializer).toContain('pm-diagram-dialog')
    expect(initializer).toContain("addEventListener('wheel'")
    expect(initializer).toContain("addEventListener('pointermove'")
    expect(initializer).toContain("addEventListener('keydown'")
    expect(initializer).toContain('scale(')
  })

  it('uses compact hierarchy, document tables, and local Material icons in MkDocs', () => {
    const config = root('mkdocs.yml')
    const navItemUrl = new URL('../../../../documentation/overrides/partials/nav-item.html', import.meta.url)
    const navItem = existsSync(navItemUrl) ? readFileSync(navItemUrl, 'utf8') : ''
    const mainOverride = root('documentation/overrides/main.html')
    const styles = root('documentation/stylesheets/pm-management.css')
    const materialFont = new URL('../../../../documentation/assets/fonts/material-icons-outlined.woff2', import.meta.url)

    expect(config).toContain('stylesheets/material-icons-outlined.css')
    expect(existsSync(materialFont)).toBe(true)
    expect(navItem).toContain('material-icons-outlined')
    expect(navItem).toContain('folder')
    expect(navItem).toContain('description')
    expect(mainOverride).toContain('item.meta.pop("icon")')
    expect(styles).toContain('.md-nav[data-md-level="1"]')
    expect(styles).toContain('.md-nav[data-md-level="2"]')
    expect(styles).toContain('.md-typeset table:not([class]) tbody tr:nth-child(even)')
    expect(styles).toContain('.pm-diagram-dialog')
    expect(styles).toContain('.pm-diagram-stage')
  })

  it('brands and versions the MkDocs site from the documentation service package', () => {
    const config = root('mkdocs.yml')
    const requirements = root('documentation/requirements.txt')
    const docsPackage = JSON.parse(root('apps/documentation/package.json')) as { version: string }
    const header = root('documentation/overrides/partials/header.html')
    const styles = root('documentation/stylesheets/pm-management.css')
    const history = root('documentation/release-history.md')

    expect(docsPackage.version).toBe('0.2.8')
    expect(requirements.trim()).toBe('mkdocs-material==9.7.6')
    expect(config).toContain('site_name: PM Management Documentation')
    expect(config).toContain('custom_dir: documentation/overrides')
    expect(config).toContain('logo: assets/images/pm-logo.svg')
    expect(config).toContain('stylesheets/pm-management.css')
    expect(config).toContain('docs_version: 0.2.8')
    expect(header).toContain('{% include "partials/search.html" %}')
    expect(header).toContain('class="pm-docs-version"')
    expect(header.indexOf('{% include "partials/search.html" %}')).toBeLessThan(header.indexOf('class="pm-docs-version"'))
    expect(header).toContain('{{ config.extra.docs_version }}')
    expect(styles).toContain('--pm-accent: #16a7db')
    expect(styles).toContain('.pm-docs-version')
    expect(history).toMatch(/^# Documentation Release History/m)
    expect(history).toContain('## 0.1.0 - 2026-07-13')
    expect(history).not.toContain('## 0.4.0')
  })

  it('keeps a complete screenshot-backed Personal Space guide', () => {
    const guideDirectory = new URL('../../../../documentation/spaces/personal/', import.meta.url)
    const expectedGuideFiles = personalGuidePages.map(({ file }) => file).sort()
    const actualGuideFiles = readdirSync(guideDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .filter((file) => !['install.md', 'uninstall.md'].includes(file))
      .sort()
    const guides = personalGuidePages.map(({ file, screenshots }) => ({
      file,
      screenshots,
      url: new URL(file, guideDirectory),
    }))

    expect(actualGuideFiles).toEqual(expectedGuideFiles)
    expect(guides.filter(({ url }) => !existsSync(url)).map(({ file }) => file)).toEqual([])

    for (const { file, screenshots, url } of guides) {
      if (!existsSync(url)) continue
      const content = readFileSync(url, 'utf8')
      const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/)

      expect(frontmatter, `${file} must start with YAML frontmatter`).not.toBeNull()
      expect(frontmatter?.[1], `${file} needs a title`).toMatch(/^title:\s*.+$/m)
      expect(frontmatter?.[1], `${file} needs a description`).toMatch(/^description:\s*.+$/m)
      expect(frontmatter?.[1], `${file} needs an icon`).toMatch(/^icon:\s*.+$/m)
      expect(content, `${file} must use portable Markdown cautions`).not.toMatch(/^!!! caution\b/m)

      const imageLinks = [...content.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((match) => match[1])
      expect(imageLinks.length, `${file} needs a real Personal Space screenshot`).toBeGreaterThan(0)
      expect(imageLinks[0], `${file} must lead with its full-page or primary-state screenshot`).toBe(`../../assets/spaces/personal/${screenshots[0]}`)
      expect(imageLinks.map((link) => link.split('/').at(-1))).toEqual(expect.arrayContaining([...screenshots]))
      for (const imageLink of imageLinks) {
        expect(imageLink, `${file} screenshot must use the Personal Space asset directory`).toMatch(/^\.\.\/\.\.\/assets\/spaces\/personal\//)
        expect(imageLink, `${file} screenshot must be a PNG`).toMatch(/\.png$/)
        expect(existsSync(new URL(imageLink, url)), `${file} references missing screenshot ${imageLink}`).toBe(true)
      }

      for (const section of ['Purpose', 'Read the page', 'Actions', 'States', 'Cautions', 'Troubleshooting']) {
        expect(content, `${file} needs a ${section} section`).toMatch(new RegExp(`^## ${section}$`, 'm'))
      }
    }
  })

  it('requires a unique primary guide image for every Personal topic', () => {
    const guideDirectory = new URL('../../../../documentation/spaces/personal/', import.meta.url)
    const primaryScreenshots = personalGuidePages.map(({ file }) => {
      const content = readFileSync(new URL(file, guideDirectory), 'utf8')
      return [...content.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)][0]?.[1]
    })
    const duplicatePrimaryScreenshots = primaryScreenshots.filter(
      (screenshot, index) => screenshot && primaryScreenshots.indexOf(screenshot) !== index,
    )

    expect(duplicatePrimaryScreenshots).toEqual([])
  })

  it('requires real PNG bytes when guide assets are served as image/png', () => {
    const assetDirectory = new URL('../../../../documentation/assets/spaces/personal/', import.meta.url)
    const assetRoute = dashboard('../app/documentation-assets/[...path]/route.ts')

    expect(assetRoute).toContain("'Content-Type': 'image/png'")
    expect(assetRoute).toContain("'X-Content-Type-Options': 'nosniff'")

    for (const asset of readdirSync(assetDirectory)) {
      const bytes = readFileSync(new URL(asset, assetDirectory))
      expect(asset, 'guide assets must use a PNG filename').toMatch(/\.png$/)
      expect([...bytes.subarray(0, 8)], `${asset} must contain PNG bytes`).toEqual([
        0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      ])
    }
  })

  it('requires the screenshot privacy policy to cover identifiers and raw captures', () => {
    const privacyPolicy = root('documentation/readme.md')

    for (const requiredPolicyTerm of [
      'session IDs',
      'credential fingerprints',
      'private URLs',
      'metadata',
      'Never retain',
      'raw captures',
    ]) {
      expect(privacyPolicy).toContain(requiredPolicyTerm)
    }
  })

  it('keeps Shared and hosted guides isolated from Personal media', async () => {
    vi.stubEnv(
      'DASHBOARD_GUIDE_ROOT',
      fileURLToPath(new URL('../../../../documentation', import.meta.url)),
    )
    const { VisualGuide } = await import('../components/documentation/VisualGuide')
    const { dashboardDocumentationFor } = await import('./dashboardDocumentation')

    for (const space of ['local-shared-client', 'shared-server'] as const) {
      const topic = dashboardDocumentationFor(space)[0]
      const markup = renderToStaticMarkup(createElement(VisualGuide, {
        markdown: topic.markdown,
        summary: topic.summary,
      }))
      expect(topic.markdown).not.toContain('../../assets/spaces/personal/')
      expect(markup).not.toContain('/documentation-assets/spaces/personal/')
    }
  })

  it('uses document icons only for dashboard documentation topics', () => {
    const page = dashboard('../app/(dashboard)/documentation/page.tsx')

    expect(page).toContain('<Icon name="description"')
    expect(page).not.toContain('<Icon name={item.icon}')
    expect(page).not.toContain('<Icon name="folder"')
    expect(page).not.toContain('dashboard-docs-nav-title')
  })

  it('places the stack documentation action above document topics and resets article scroll for each topic', () => {
    const page = dashboard('../app/(dashboard)/documentation/page.tsx')
    const styles = dashboard('../app/globals.css')
    const article = dashboard('../components/documentation/DocumentationArticle.tsx')

    expect(page).toContain('dashboard-docs-stack-link')
    expect(page.indexOf('<aside')).toBeLessThan(page.indexOf('dashboard-docs-stack-link'))
    expect(page.indexOf('dashboard-docs-stack-link')).toBeLessThan(page.indexOf('<nav>'))
    expect(page).not.toContain('dashboard-docs-toolbar')
    expect(page).toContain('<DocumentationArticle topicSlug={topic.slug}>')
    expect(styles).toMatch(/\.dashboard-docs-stack-link\s*{[\s\S]*margin-bottom:\s*14px/)
    expect(article).toContain('article.scrollTop = 0')
    expect(article).toContain('[topicSlug]')
  })

  it('keeps guide-image pointer hover neutral while preserving keyboard focus visibility', () => {
    const styles = dashboard('../app/globals.css')
    const guideImageHover = styles.match(/\.guide-image-button:hover\s*{([^}]*)}/)?.[1] ?? ''

    expect(guideImageHover).toContain('background: var(--panel)')
    expect(guideImageHover).toContain('border-color: var(--divider-section)')
    expect(styles).toMatch(/\.guide-image-button:focus-visible,[\s\S]*outline:\s*2px solid var\(--accent\)/)
  })

  it('keeps proxied documentation pages and assets behind server-mode middleware', async () => {
    vi.stubEnv('DEPLOYMENT_MODE', 'server')
    const { middleware } = await import('../middleware')

    for (const path of [
      '/docs/index.html',
      '/docs/ARCHITECTURE.html',
      '/docs/assets/stylesheets/main.css',
      '/documentation-assets/spaces/personal/overview-page.png',
    ]) {
      const response = middleware(new NextRequest(`http://localhost${path}`))
      expect(response.status).toBe(307)
      expect(response.headers.get('location')).toBe('http://localhost/login')
    }
  })
})
