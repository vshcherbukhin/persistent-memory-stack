import Link from 'next/link'
import { DocumentationArticle } from '@/components/documentation/DocumentationArticle'
import { VisualGuide } from '@/components/documentation/VisualGuide'
import { Icon } from '@/components/ui/Icon'
import { isLocalMode } from '@/lib/deploymentMode'
import {
  dashboardDocumentationFor,
  dashboardDocumentationTopic,
  type DashboardDocumentationSpace,
} from '@/lib/dashboardDocumentation'

export const dynamic = 'force-dynamic'

function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function documentationSpace(space: string | undefined): DashboardDocumentationSpace {
  if (!isLocalMode) return 'shared-server'
  return space === 'shared' ? 'local-shared-client' : 'local-personal'
}

export default async function DocumentationPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = searchParams ? await searchParams : {}
  const selectedSpace = documentationSpace(firstParam(params.space))
  const spaceQuery = selectedSpace === 'local-personal' ? 'personal' : 'shared'
  const topics = dashboardDocumentationFor(selectedSpace)
  const topic = dashboardDocumentationTopic(selectedSpace, firstParam(params.topic))

  return (
    <div className="dashboard-docs-page">
      <div className="dashboard-docs-layout">
        <aside className="dashboard-docs-nav" aria-label="Dashboard documentation topics">
          <a className="btn secondary dashboard-docs-stack-link" href="/docs/index.html" target="_blank" rel="noreferrer">
            <Icon name="open_in_new" size={17} />
            Stack documentation
          </a>
          <nav>
            {topics.map((item) => (
              <Link
                key={item.slug}
                href={`/documentation?space=${spaceQuery}&topic=${item.slug}`}
                className={`dashboard-docs-nav-link${item.slug === topic.slug ? ' active' : ''}`}
                aria-current={item.slug === topic.slug ? 'page' : undefined}
              >
                <Icon name="description" size={17} />
                <span>{item.title}</span>
              </Link>
            ))}
          </nav>
        </aside>
        <DocumentationArticle topicSlug={topic.slug}>
          <VisualGuide markdown={topic.markdown} summary={topic.summary} />
        </DocumentationArticle>
      </div>
    </div>
  )
}
