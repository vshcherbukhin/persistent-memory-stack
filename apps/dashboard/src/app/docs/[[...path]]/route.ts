import { type NextRequest } from 'next/server'
import { requireSession } from '@/lib/session'

const DOCUMENTATION_BASE_URL = process.env.DOCUMENTATION_BASE_URL ?? 'http://persistent-memory-documentation:8000'
const REQUEST_HEADERS = ['accept', 'if-modified-since', 'if-none-match', 'range']
const RESPONSE_HEADERS = [
  'accept-ranges',
  'cache-control',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
]

type RouteContext = {
  params: Promise<{ path?: string[] }>
}

async function proxyDocumentation(request: NextRequest, context: RouteContext): Promise<Response> {
  await requireSession()
  const path = (await context.params).path ?? ['index.html']
  const relativePath = path.join('/')
  const encodedPath = relativePath.split('/').map(encodeURIComponent).join('/')
  const target = new URL(encodedPath, `${DOCUMENTATION_BASE_URL.replace(/\/$/, '')}/`)
  target.search = request.nextUrl.search

  const requestHeaders = new Headers()
  for (const name of REQUEST_HEADERS) {
    const value = request.headers.get(name)
    if (value) requestHeaders.set(name, value)
  }

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers: requestHeaders,
      redirect: 'manual',
      cache: 'no-store',
    })
    const responseHeaders = new Headers()
    for (const name of RESPONSE_HEADERS) {
      const value = upstream.headers.get(name)
      if (value) responseHeaders.set(name, value)
    }
    responseHeaders.set('x-content-type-options', 'nosniff')
    return new Response(request.method === 'HEAD' ? null : upstream.body, {
      status: upstream.status,
      headers: responseHeaders,
    })
  } catch (error) {
    return Response.json({
      error: 'documentation_unavailable',
      message: error instanceof Error ? error.message : String(error),
    }, { status: 502 })
  }
}

export const GET = proxyDocumentation
export const HEAD = proxyDocumentation
