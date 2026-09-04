import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createDocumentationServer } from '../src/server.mjs'
import {
  COMPOSE_DOCUMENTATION_URL,
  LOCAL_DOCUMENTATION_URL,
  isComposeDocumentationAvailable,
  isDocumentationServiceRunning,
  launchDocumentation,
} from '../src/launcher.mjs'

function composeService(source, name) {
  const lines = source.split('\n')
  const start = lines.findIndex((line) => line === `  ${name}:`)
  assert.notEqual(start, -1, `missing Compose service ${name}`)
  const relativeEnd = lines.slice(start + 1).findIndex((line) => /^  [a-z0-9][a-z0-9-]*:$/.test(line))
  const end = relativeEnd === -1 ? lines.length : start + 1 + relativeEnd
  return lines.slice(start, end).join('\n')
}

async function withServer(run) {
  const siteDir = await mkdtemp(join(tmpdir(), 'pm-documentation-'))
  await writeFile(join(siteDir, 'index.html'), '<h1>PM documentation</h1>')
  await writeFile(join(siteDir, 'app.js'), 'window.docsReady = true')
  await writeFile(join(siteDir, 'search-index.json'), '{"docs":[]}')
  await mkdir(join(siteDir, 'assets/spaces/personal'), { recursive: true })
  await mkdir(join(siteDir, 'assets/images'), { recursive: true })
  await writeFile(join(siteDir, 'assets/spaces/personal/overview-page.png'), 'guide png')
  await writeFile(join(siteDir, 'assets/images/logo.png'), 'ordinary png')
  const server = createDocumentationServer({ siteDir, version: '0.3.0' })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.equal(typeof address, 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`
  try {
    await run(baseUrl)
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    await rm(siteDir, { recursive: true, force: true })
  }
}

test('documentation server exposes health and static files under root or /docs', async () => {
  await withServer(async (baseUrl) => {
    const health = await fetch(`${baseUrl}/health`)
    assert.equal(health.status, 200)
    assert.deepEqual(await health.json(), { ok: true, service: 'documentation', version: '0.3.0' })

    for (const path of ['/', '/index.html', '/docs/index.html']) {
      const response = await fetch(`${baseUrl}${path}`)
      assert.equal(response.status, 200)
      assert.equal(await response.text(), '<h1>PM documentation</h1>')
    }

    const script = await fetch(`${baseUrl}/docs/app.js`)
    assert.equal(script.headers.get('content-type'), 'text/javascript; charset=utf-8')
    assert.equal(script.headers.get('cache-control'), 'no-cache')

    const searchIndex = await fetch(`${baseUrl}/docs/search-index.json`)
    assert.equal(searchIndex.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.equal(searchIndex.headers.get('cache-control'), 'no-cache')
  })
})

test('documentation server keeps generated guide screenshots private under root or /docs', async () => {
  await withServer(async (baseUrl) => {
    for (const path of [
      '/assets/spaces/personal/overview-page.png',
      '/docs/assets/spaces/personal/overview-page.png',
    ]) {
      const response = await fetch(`${baseUrl}${path}`)
      assert.equal(response.status, 200)
      assert.equal(response.headers.get('content-type'), 'image/png')
      assert.equal(response.headers.get('cache-control'), 'private, no-cache')
      assert.equal(await response.text(), 'guide png')
    }

    const ordinaryPng = await fetch(`${baseUrl}/assets/images/logo.png`)
    assert.equal(ordinaryPng.status, 200)
    assert.equal(ordinaryPng.headers.get('cache-control'), 'public, max-age=3600')
  })
})

test('documentation server rejects traversal, unsupported methods, and missing files', async () => {
  await withServer(async (baseUrl) => {
    assert.equal((await fetch(`${baseUrl}/missing.html`)).status, 404)
    assert.equal((await fetch(`${baseUrl}/health`, { method: 'POST' })).status, 405)
    assert.equal((await fetch(`${baseUrl}/docs/%2e%2e/package.json`)).status, 404)
  })
})

test('Docker detection requires the running documentation Compose service', () => {
  const running = isDocumentationServiceRunning(() => ({ status: 0, stdout: 'dashboard\ndocumentation\n' }))
  const stopped = isDocumentationServiceRunning(() => ({ status: 0, stdout: 'dashboard\n' }))
  const unavailable = isDocumentationServiceRunning(() => ({ status: 127, stdout: '' }))

  assert.equal(running, true)
  assert.equal(stopped, false)
  assert.equal(unavailable, false)
})

test('Compose documentation is available only when its dashboard endpoint responds', async () => {
  const reachable = await isComposeDocumentationAvailable({
    isServiceRunning: () => true,
    probe: async () => new Response(null, { status: 200 }),
  })
  const unreachable = await isComposeDocumentationAvailable({
    isServiceRunning: () => true,
    probe: async () => { throw new Error('gateway stopped') },
  })
  const stopped = await isComposeDocumentationAvailable({
    isServiceRunning: () => false,
    probe: async () => { throw new Error('must not probe') },
  })

  assert.equal(reachable, true)
  assert.equal(unreachable, false)
  assert.equal(stopped, false)
})

test('launcher opens the Compose-backed documentation without rebuilding locally', async () => {
  const events = []
  const result = await launchDocumentation({
    isComposeAvailable: async () => true,
    build: async () => events.push('build'),
    startLocal: async () => events.push('start'),
    openUrl: async (url) => events.push(url),
  })

  assert.deepEqual(result, { mode: 'docker', url: COMPOSE_DOCUMENTATION_URL })
  assert.deepEqual(events, [COMPOSE_DOCUMENTATION_URL])
})

test('launcher builds and starts the local Node service when Compose docs are unavailable', async () => {
  const events = []
  const result = await launchDocumentation({
    isComposeAvailable: async () => false,
    build: async () => events.push('build'),
    startLocal: async () => events.push('start'),
    openUrl: async (url) => events.push(url),
  })

  assert.deepEqual(result, { mode: 'local', url: LOCAL_DOCUMENTATION_URL })
  assert.deepEqual(events, ['build', 'start', LOCAL_DOCUMENTATION_URL])
})

test('Compose exposes canonical dashboard and documentation services', async () => {
  const compose = await readFile(new URL('../../../deploy/compose/docker-compose.yml', import.meta.url), 'utf8')
  const documentationPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  const documentationDockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8')
  const dashboardDockerfile = await readFile(new URL('../../dashboard/Dockerfile', import.meta.url), 'utf8')
  const dashboard = composeService(compose, 'dashboard')
  const gateway = composeService(compose, 'dashboard-gateway')
  const legacyAdmin = composeService(compose, 'admin')

  assert.match(compose, /^  dashboard:\n/m)
  assert.match(compose, /^    image: \$\{PM_IMAGE_PREFIX:-persistent-memory\}-dashboard:latest$/m)
  assert.match(compose, /^    container_name: \$\{PM_CONTAINER_PREFIX:-persistent-memory\}-dashboard$/m)
  assert.match(legacyAdmin, /profiles: \["legacy-admin-upgrade"\]/)
  assert.match(legacyAdmin, /extends:\n      service: dashboard/)
  assert.match(legacyAdmin, /- persistent-memory-admin/)
  assert.doesNotMatch(legacyAdmin, /container_name: persistent-memory-admin/)

  assert.match(compose, /^  documentation:\n/m)
  assert.match(compose, /^    image: \$\{PM_IMAGE_PREFIX:-persistent-memory\}-documentation:latest$/m)
  assert.match(compose, /^    container_name: \$\{PM_CONTAINER_PREFIX:-persistent-memory\}-documentation$/m)
  assert.match(composeService(compose, 'documentation'), new RegExp(`DOCUMENTATION_VERSION: "${documentationPackage.version.replaceAll('.', '\\.')}"`))
  assert.match(dashboard, /DOCUMENTATION_BASE_URL: http:\/\/\$\{PM_CONTAINER_PREFIX:-persistent-memory\}-documentation:8000/)
  assert.match(dashboard, /depends_on:\n      api:\n        condition: service_healthy/)
  assert.doesNotMatch(dashboard, /depends_on:[\s\S]*documentation:/)
  assert.match(gateway, /DASHBOARD_BASE_URL: http:\/\/\$\{PM_CONTAINER_PREFIX:-persistent-memory\}-dashboard:3000/)
  assert.doesNotMatch(gateway, /DOCUMENTATION_BASE_URL/)
  assert.match(gateway, /depends_on:\n      dashboard:\n        condition: service_healthy/)

  assert.match(documentationDockerfile, /mkdocs build --site-dir \/site/)
  assert.match(documentationDockerfile, /CMD \["node", "src\/server.mjs"\]/)
  assert.doesNotMatch(dashboardDockerfile, /AS docs/)
  assert.doesNotMatch(dashboardDockerfile, /public\/docs/)
})

test('redeploy helper uses canonical dashboard and documentation commands', async () => {
  const script = await readFile(new URL('../../../deploy/scripts/dev-redeploy.sh', import.meta.url), 'utf8')

  assert.match(script, /redeploy-dashboard/)
  assert.match(script, /redeploy-documentation/)
  assert.match(script, /recreate_dashboard_front_door/)
  assert.match(script, /front_door_args\+=\(dashboard dashboard-gateway\)/)
  assert.match(script, /DASHBOARD_BASE_URL=http:\/\/persistent-memory-dashboard:3000/)
  assert.match(script, /cleanup_legacy_dashboard_containers/)
  assert.match(script, /persistent-memory-dashboard-legacy-upgrade persistent-memory-admin/)
  assert.match(script, /up -d --build --no-deps documentation/)
})

test('post-install verification removes the old dashboard container only after the canonical one is healthy', async () => {
  const script = await readFile(new URL('../../../deploy/scripts/verify-install.sh', import.meta.url), 'utf8')
  const cleanup = script.slice(script.indexOf('cleanup_legacy_dashboard_container()'))

  assert.match(cleanup, /legacy_containers=\(persistent-memory-dashboard-legacy-upgrade persistent-memory-admin\)/)
  assert.match(cleanup, /canonical_state.*!= "healthy".*gateway_state.*!= "healthy"/)
  assert.match(cleanup, /docker rm -f "\$cname"/)
  assert.ok(cleanup.indexOf('canonical_state') < cleanup.indexOf('docker rm -f "$cname"'))
})

test('MkDocs exposes user-facing Space guides and related documents for every Stack Layer', async () => {
  const config = await readFile(new URL('../../../mkdocs.yml', import.meta.url), 'utf8')
  const home = await readFile(new URL('../../../documentation/index.md', import.meta.url), 'utf8')
  const personalGuidePaths = [
    'spaces/personal/index.md',
    'spaces/personal/navigation-and-spaces.md',
    'spaces/personal/overview.md',
    'spaces/personal/memories.md',
    'spaces/personal/services.md',
    'spaces/personal/workers.md',
    'spaces/personal/token-usage.md',
    'spaces/personal/security.md',
    'spaces/personal/notifications.md',
    'spaces/personal/system-settings.md',
    'spaces/personal/profile.md',
    'spaces/personal/releases-and-updates.md',
  ]
  const layerPages = [
    'core.md',
    'memory-vector.md',
    'graph.md',
    'evidence-files.md',
    'security-dlp.md',
    'mcp-runtime.md',
    'dashboard.md',
    'onboarding.md',
    'update-ops.md',
    'docs-system.md',
  ]

  assert.match(config, /- "Personal Space Documentation":/)
  assert.match(config, /- "Shared Space Documentation":\n          - "In development": spaces\/shared\/index\.md/)
  assert.match(config, /- "Hosted Server Dashboard Documentation":\n          - "In development": spaces\/hosted-server\/index\.md/)
  for (const path of personalGuidePaths) assert.match(config, new RegExp(path.replaceAll('.', '\\.')))
  assert.doesNotMatch(config, /- Local Personal:/)
  assert.doesNotMatch(config, /- Local Shared Client:/)
  assert.doesNotMatch(config, /- Shared Server:/)
  assert.match(home, /^## Start with$/m)
  assert.match(home, /\[Installation\]\(installation\/installation-steps\.md\)/)
  assert.match(home, /personal-space-start\.png/)
  assert.doesNotMatch(home, /\]\(spaces\//)

  for (const page of layerPages) {
    const source = await readFile(new URL(`../../../documentation/stack-layers/${page}`, import.meta.url), 'utf8')
    assert.match(source, /^## Related documentation$/m)
    assert.match(source, /\[[^\]]+\]\([^\)]+\)/)
  }
})

test('Markdown frontmatter produces the approved documentation information architecture', async () => {
  const config = await readFile(new URL('../../../mkdocs.yml', import.meta.url), 'utf8')
  const expectedNavigation = [
    '- "Home": index.md',
    '- "Installation":\n      - "Installation steps": installation/installation-steps.md\n      - "Uninstall memory stack": installation/uninstall-memory-stack.md',
    '- "Spaces":',
    '- "Stack Architecture":\n      - "Architecture": stack-architecture/architecture.md\n      - "Operations": stack-architecture/operations.md\n      - "Security": stack-architecture/security.md\n      - "Access Model": stack-architecture/access-model.md\n      - "Memory Protocol": stack-architecture/memory-protocol.md\n      - "Ingest": stack-architecture/ingest.md\n      - "Embedding": stack-architecture/embedding.md\n      - "Benchmarking": stack-architecture/benchmarking.md',
    '- "Stack Layers":',
    '- "Components":',
  ]

  let previousIndex = -1
  for (const entry of expectedNavigation) {
    const index = config.indexOf(entry)
    assert.notEqual(index, -1, `missing navigation entry: ${entry}`)
    assert.ok(index > previousIndex, `navigation entry appears out of order: ${entry}`)
    previousIndex = index
  }

  assert.doesNotMatch(config, /Release History/)
  assert.ok(existsSync(new URL('../../../documentation/stack-layers/core.md', import.meta.url)))
  assert.ok(!existsSync(new URL('../../../documentation/layers', import.meta.url)))
})

test('the documentation home starts users with Persistent Memory Stack and the installation path', async () => {
  const config = await readFile(new URL('../../../mkdocs.yml', import.meta.url), 'utf8')
  const home = await readFile(new URL('../../../documentation/index.md', import.meta.url), 'utf8')

  assert.match(home, /^# Persistent Memory Stack$/m)
  assert.match(home, /local-first memory and evidence system/i)
  assert.match(home, /personal-space-start\.png/)
  assert.match(home, /^## Start with$/m)
  assert.match(home, /\[Architecture\]\(stack-architecture\/architecture\.md\)/)
  assert.match(home, /\[Operations\]\(stack-architecture\/operations\.md\)/)
  assert.match(home, /\[Security\]\(stack-architecture\/security\.md\)/)
  assert.match(home, /\[Access Model\]\(stack-architecture\/access-model\.md\)/)
  assert.match(home, /\[Installation\]\(installation\/installation-steps\.md\)/)
  assert.doesNotMatch(home, /```mermaid/)
  assert.match(config, /- "Installation":\n      - "Installation steps": installation\/installation-steps\.md\n      - "Uninstall memory stack": installation\/uninstall-memory-stack\.md/)
})

test('lifecycle guides keep every installer and uninstall screenshot distinct and in separate flows', async () => {
  const root = new URL('../../../documentation/assets/lifecycle/', import.meta.url)
  const installGuide = await readFile(new URL('../../../documentation/installation/installation-steps.md', import.meta.url), 'utf8')
  const uninstallGuide = await readFile(new URL('../../../documentation/installation/uninstall-memory-stack.md', import.meta.url), 'utf8')
  const installer = (await readdir(new URL('onboarding/', root))).filter((name) => name.endsWith('.png')).sort()
  const uninstall = (await readdir(new URL('uninstall/', root))).filter((name) => name.endsWith('.png')).sort()
  const digest = async (directory, name) => createHash('sha256').update(await readFile(new URL(name, directory))).digest('hex')

  assert.equal(installer.length, 13)
  assert.equal(uninstall.length, 5)
  assert.equal(new Set(await Promise.all(installer.map((name) => digest(new URL('onboarding/', root), name)))).size, 13)
  assert.equal(new Set(await Promise.all(uninstall.map((name) => digest(new URL('uninstall/', root), name)))).size, 5)
  assert.match(installGuide, /## 13\. Open your dashboard/)
  assert.match(installGuide, /sandbox simulation of the installer flow/i)
  assert.match(uninstallGuide, /separate terminal process/i)
  assert.match(uninstallGuide, /sandbox simulation of the script prompts/i)
  for (const name of installer) assert.match(installGuide, new RegExp(name.replace('.', '\\.')))
  for (const name of uninstall) assert.match(uninstallGuide, new RegExp(name.replace('.', '\\.')))
})

test('every canonical Mermaid definition has a committed SVG fallback for plain Markdown renderers', async () => {
  const documentationDir = new URL('../../../documentation/', import.meta.url)
  const files = await readdir(documentationDir, { recursive: true })
  const fallbackPattern = /!\[Diagram fallback: [^\]]+\]\(([^)]+assets\/diagrams\/[^)]+\.svg)\)\n\n```mermaid/g
  const markdownWithDiagrams = []
  let diagrams = 0

  for (const file of files.filter((name) => name.endsWith('.md') && !name.split('/').includes('node_modules'))) {
    const sourceUrl = new URL(file, documentationDir)
    const source = await readFile(sourceUrl, 'utf8')
    const definitions = source.match(/^```mermaid$/gm) ?? []
    if (definitions.length === 0) continue

    const fallbackLinks = [...source.matchAll(fallbackPattern)].map((match) => match[1])
    markdownWithDiagrams.push(file)
    diagrams += definitions.length
    assert.equal(fallbackLinks.length, definitions.length, `${file} needs one SVG fallback immediately before every Mermaid definition`)
    for (const link of fallbackLinks) {
      const svg = await readFile(new URL(link, sourceUrl), 'utf8')
      assert.match(svg, /^<svg\b/, `${file} fallback must be an SVG: ${link}`)
    }
  }

  const styles = await readFile(new URL('../../../documentation/stylesheets/pm-management.css', import.meta.url), 'utf8')
  assert.equal(markdownWithDiagrams.length, 17)
  assert.equal(diagrams, 17)
  assert.match(styles, /img\[alt\^="Diagram fallback:"\]/)
})

test('committed documentation contains no development-plan phase labels', async () => {
  const documentationDir = new URL('../../../documentation/', import.meta.url)
  const files = await readdir(documentationDir, { recursive: true })
  const violations = []
  const planMarker = /\bP(?:[1-9]|1[0-9]|2[0-9])\b|\bPhase(?:\s+|-)(?:[0-9]+|[A-Z])\b/gi

  for (const file of files.filter((name) => name.endsWith('.md'))) {
    const source = await readFile(new URL(file, documentationDir), 'utf8')
    for (const match of source.matchAll(planMarker)) violations.push(`${file}:${match[0]}`)
  }

  assert.deepEqual(violations, [])
  assert.doesNotMatch('Prisma P2002 is a runtime error code.', planMarker)
})

test('Markdown is the sole source tree for grouped system docs and dashboard-space guides', async () => {
  const config = await readFile(new URL('../../../mkdocs.yml', import.meta.url), 'utf8')
  const template = await readFile(new URL('../../../mkdocs.template.yml', import.meta.url), 'utf8')
  const generator = await readFile(new URL('../scripts/generate-mkdocs-config.mjs', import.meta.url), 'utf8')
  const dockerfile = await readFile(new URL('../Dockerfile', import.meta.url), 'utf8')
  const requiredPages = [
    'documentation/stack-architecture/access-model.md',
    'documentation/stack-architecture/memory-protocol.md',
    'documentation/stack-architecture/architecture.md',
    'documentation/stack-architecture/embedding.md',
    'documentation/stack-architecture/ingest.md',
    'documentation/installation/installation-steps.md',
    'documentation/stack-architecture/benchmarking.md',
    'documentation/stack-architecture/operations.md',
    'documentation/release-history.md',
    'documentation/stack-architecture/security.md',
    'documentation/installation/uninstall-memory-stack.md',
  ]

  for (const page of requiredPages) assert.equal(existsSync(new URL(`../../../${page}`, import.meta.url)), true, `missing Markdown source ${page}`)
  assert.equal(existsSync(new URL('../../../documentation/user-guide/', import.meta.url)), false)
  assert.equal(existsSync(new URL('../../../documentation/dashboard-user-guide/', import.meta.url)), false)
  assert.equal(existsSync(new URL('../../../documentation/spaces/personal/index.md', import.meta.url)), true)
  assert.equal(existsSync(new URL('../../../documentation/spaces/shared/index.md', import.meta.url)), true)
  assert.equal(existsSync(new URL('../../../documentation/spaces/hosted-server/index.md', import.meta.url)), true)
  assert.doesNotMatch(config, /(?<!dashboard-)user-guide\/personal|ACCESS-MODEL\.md|ARCHITECTURE\.md/)
  assert.doesNotMatch(template, /^nav:/m)
  assert.match(generator, /Missing frontmatter/)
  assert.match(generator, /Missing \$\{field\}/)
  assert.match(dockerfile, /generate-mkdocs-config\.mjs/)
})

test('the Markdown source tree mirrors the approved documentation navigation groups', async () => {
  const requiredSources = [
    'documentation/installation/installation-steps.md',
    'documentation/installation/uninstall-memory-stack.md',
    'documentation/spaces/personal/index.md',
    'documentation/spaces/shared/index.md',
    'documentation/spaces/hosted-server/index.md',
    'documentation/stack-architecture/architecture.md',
    'documentation/stack-architecture/operations.md',
    'documentation/stack-architecture/security.md',
    'documentation/stack-architecture/access-model.md',
    'documentation/stack-architecture/memory-protocol.md',
    'documentation/stack-architecture/ingest.md',
    'documentation/stack-architecture/embedding.md',
    'documentation/stack-architecture/benchmarking.md',
    'documentation/stack-layers/core.md',
    'documentation/components/api.md',
  ]
  const legacySources = [
    'documentation/installation.md',
    'documentation/uninstall-and-export.md',
    'documentation/dashboard-user-guide',
    'documentation/architecture.md',
    'documentation/operations.md',
    'documentation/security.md',
    'documentation/access-model.md',
    'documentation/agent-memory-protocol.md',
    'documentation/ingest.md',
    'documentation/embedding.md',
    'documentation/memory-benchmarking.md',
  ]

  for (const source of requiredSources) assert.equal(existsSync(new URL(`../../../${source}`, import.meta.url)), true, `missing source ${source}`)
  for (const source of legacySources) assert.equal(existsSync(new URL(`../../../${source}`, import.meta.url)), false, `legacy source must not remain: ${source}`)
})

test('release history modal is an accessible view of the canonical generated release page', async () => {
  const header = await readFile(new URL('../../../documentation/overrides/partials/header.html', import.meta.url), 'utf8')
  const main = await readFile(new URL('../../../documentation/overrides/main.html', import.meta.url), 'utf8')
  const releaseHistory = await readFile(new URL('../../../documentation/javascripts/release-history.mjs', import.meta.url), 'utf8')
  const styles = await readFile(new URL('../../../documentation/stylesheets/pm-management.css', import.meta.url), 'utf8')

  assert.match(header, /<button class="pm-docs-version"/)
  assert.match(header, /data-pm-release-trigger/)
  assert.match(header, /<dialog[^>]+data-pm-release-dialog/)
  assert.match(header, /data-pm-release-close/)
  assert.match(header, /data-pm-release-content/)
  assert.match(main, /javascripts\/release-history\.mjs/)
  assert.doesNotMatch(main, /javascripts\/navigation\.mjs/)
  assert.match(releaseHistory, /fetch\('release-history\.html'/)
  assert.match(releaseHistory, /\.md-content__inner/)
  assert.match(releaseHistory, /showModal\(\)/)
  assert.match(releaseHistory, /releaseDialog\.close\(\)/)
  assert.match(styles, /\.pm-release-dialog/)
  assert.match(styles, /\.pm-release-shell/)
})
