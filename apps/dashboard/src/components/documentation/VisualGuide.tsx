import { createElement } from 'react'
import Markdown, { defaultUrlTransform, type UrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { GuideImage } from './GuideImage'

const GUIDE_ASSET_PREFIX = '../../assets/spaces/'
const GUIDE_ASSET_PATH = /^[a-zA-Z0-9][a-zA-Z0-9/_-]*\.png$/

export function guideImageUrl(url: string): string {
  if (!url.startsWith(GUIDE_ASSET_PREFIX)) return ''
  const assetPath = url.slice(GUIDE_ASSET_PREFIX.length)
  if (!GUIDE_ASSET_PATH.test(assetPath) || assetPath.includes('//')) return ''
  return `/documentation-assets/spaces/${assetPath}`
}

const guideUrlTransform: UrlTransform = (url, key, node) => {
  if (key === 'src' && node.tagName === 'img') return guideImageUrl(url)
  return defaultUrlTransform(url)
}

export function VisualGuide({ markdown, summary, eyebrow }: { markdown: string; summary: string; eyebrow?: string }) {
  return createElement(
    'div',
    { className: 'visual-guide' },
    createElement(
      Markdown,
      {
        skipHtml: true,
        remarkPlugins: [remarkGfm],
        urlTransform: guideUrlTransform,
        components: {
          h1({ children }) {
            return createElement(
              'header',
              { className: 'dashboard-docs-article-head' },
              eyebrow ? createElement('span', { className: 'dashboard-docs-eyebrow' }, eyebrow) : null,
              createElement('h1', null, children),
              createElement('p', null, summary),
            )
          },
          img({ src, alt }) {
            if (typeof src !== 'string' || !src) return null
            return createElement(GuideImage, { src, alt: alt || 'Guide screenshot' })
          },
        },
      },
      markdown,
    ),
  )
}
