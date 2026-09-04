import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import type { IconName } from '@/components/ui/Icon'

export type DashboardDocumentationSpace = 'local-personal' | 'local-shared-client' | 'shared-server'

export type DashboardDocumentationTopic = {
  slug: string
  title: string
  summary: string
  icon: IconName
  spaces: DashboardDocumentationSpace[]
  markdown: string
}

type GuideMetadata = Record<string, string>
type GuideSource = DashboardDocumentationTopic & { space: DashboardDocumentationSpace; order: number }

const DASHBOARD_SPACES = new Set<DashboardDocumentationSpace>([
  'local-personal',
  'local-shared-client',
  'shared-server',
])

export function dashboardDocumentationRoot(): string {
  if (process.env.DASHBOARD_GUIDE_ROOT) return path.resolve(process.env.DASHBOARD_GUIDE_ROOT)

  const candidates = [
    path.resolve(process.cwd(), 'documentation'),
    path.resolve(process.cwd(), '../../documentation'),
    '/app/documentation',
  ]
  return candidates.find((candidate) => existsSync(path.join(candidate, 'spaces'))) ?? candidates[0]
}

function parseFrontmatter(source: string, guidePath: string): [GuideMetadata, string] {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) throw new Error(`Invalid dashboard guide frontmatter: ${guidePath}`)
  const frontmatter = Object.fromEntries(
    match[1]
      .split(/\r?\n/)
      .map((line) => line.match(/^([a-zA-Z][\w-]*):\s*(.+)$/))
      .filter((entry): entry is RegExpMatchArray => Boolean(entry))
      .map((entry) => [entry[1], entry[2].trim()]),
  )
  return [frontmatter, match[2].trim()]
}

function markdownGuideFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(directory, entry.name)
      if (entry.isDirectory()) return markdownGuideFiles(entryPath)
      return entry.isFile() && entry.name.endsWith('.md') ? [entryPath] : []
    })
    .sort()
}

function parseGuide(guidePath: string): GuideSource {
  const [frontmatter, markdown] = parseFrontmatter(readFileSync(guidePath, 'utf8'), guidePath)
  const required = ['title', 'description', 'icon', 'dashboard_space', 'nav_order']
  if (required.some((field) => !frontmatter[field])) {
    throw new Error(`Incomplete dashboard guide frontmatter: ${guidePath}`)
  }
  if (!DASHBOARD_SPACES.has(frontmatter.dashboard_space as DashboardDocumentationSpace)) {
    throw new Error(`Invalid dashboard space in ${guidePath}: ${frontmatter.dashboard_space}`)
  }

  const order = Number(frontmatter.nav_order)
  if (!Number.isInteger(order)) throw new Error(`Invalid dashboard guide order: ${guidePath}`)
  const filename = path.basename(guidePath, '.md')
  return {
    slug: filename === 'index' ? 'getting-started' : filename,
    title: frontmatter.title,
    summary: frontmatter.description,
    icon: frontmatter.icon as IconName,
    spaces: [frontmatter.dashboard_space as DashboardDocumentationSpace],
    markdown,
    space: frontmatter.dashboard_space as DashboardDocumentationSpace,
    order,
  }
}

function dashboardGuideSources(): GuideSource[] {
  const root = path.join(dashboardDocumentationRoot(), 'spaces')
  return markdownGuideFiles(root).map(parseGuide)
}

export function dashboardDocumentationFor(space: DashboardDocumentationSpace): DashboardDocumentationTopic[] {
  return dashboardGuideSources()
    .filter((guide) => guide.space === space)
    .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title))
    .map(({ space: _space, order: _order, ...topic }) => topic)
}

export function dashboardDocumentationTopic(
  space: DashboardDocumentationSpace,
  slug: string | undefined,
): DashboardDocumentationTopic {
  const topics = dashboardDocumentationFor(space)
  if (topics.length === 0) throw new Error(`No dashboard documentation for ${space}`)
  return topics.find((topic) => topic.slug === slug) ?? topics[0]
}
