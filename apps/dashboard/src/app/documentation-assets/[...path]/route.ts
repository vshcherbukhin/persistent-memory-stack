import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import { dashboardDocumentationRoot } from '@/lib/dashboardDocumentation'
import { requireSession } from '@/lib/session'

export const dynamic = 'force-dynamic'

type AssetRouteContext = {
  params: Promise<{ path: string[] }>
}

const SAFE_SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

function notFoundResponse(): Response {
  return new Response(null, { status: 404 })
}

async function assetResponse(context: AssetRouteContext, includeBody: boolean): Promise<Response> {
  await requireSession()
  try {
    const { path: segments } = await context.params
    if (
      segments.length < 2 ||
      segments[0] !== 'spaces' ||
      segments.some((segment) => !SAFE_SEGMENT.test(segment) || segment === '.' || segment === '..') ||
      path.extname(segments.at(-1) ?? '').toLowerCase() !== '.png'
    ) {
      return notFoundResponse()
    }

    const assetRoot = await realpath(path.join(dashboardDocumentationRoot(), 'assets', 'spaces'))
    const requestedPath = path.resolve(assetRoot, ...segments.slice(1))
    const canonicalPath = await realpath(requestedPath)
    if (!canonicalPath.startsWith(`${assetRoot}${path.sep}`)) return notFoundResponse()

    const fileStat = await stat(canonicalPath)
    if (!fileStat.isFile()) return notFoundResponse()
    const body = includeBody ? await readFile(canonicalPath) : null
    return new Response(body, {
      headers: {
        'Cache-Control': 'private, no-cache',
        'Content-Length': String(fileStat.size),
        'Content-Type': 'image/png',
        'X-Content-Type-Options': 'nosniff',
      },
    })
  } catch {
    return notFoundResponse()
  }
}

export async function GET(_request: Request, context: AssetRouteContext): Promise<Response> {
  return assetResponse(context, true)
}

export async function HEAD(_request: Request, context: AssetRouteContext): Promise<Response> {
  return assetResponse(context, false)
}
