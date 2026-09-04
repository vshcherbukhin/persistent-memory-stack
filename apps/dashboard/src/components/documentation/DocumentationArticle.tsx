'use client'

import { useEffect, useRef, type ReactNode } from 'react'

export function DocumentationArticle({
  topicSlug,
  children,
}: {
  topicSlug: string
  children: ReactNode
}) {
  const articleRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const article = articleRef.current
    if (article) article.scrollTop = 0
  }, [topicSlug])

  return (
    <article ref={articleRef} className="dashboard-docs-article">
      {children}
    </article>
  )
}
