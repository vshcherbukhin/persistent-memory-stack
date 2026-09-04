import { createReadStream, readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import http from 'node:http'
import { dirname, extname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(APP_DIR, '../..')
const DEFAULT_SITE_DIR = resolve(REPO_ROOT, '.local/generated-docs/site')

const CONTENT_TYPES = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.ico', 'image/x-icon'],
  ['.jpeg', 'image/jpeg'],
  ['.jpg', 'image/jpeg'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.webmanifest', 'application/manifest+json'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
  ['.xml', 'application/xml; charset=utf-8'],
])
const REVALIDATED_EXTENSIONS = new Set(['.css', '.html', '.js', '.json', '.mjs'])

function cacheControlFor(siteDir, filePath, extension) {
  const guideAssetRoot = resolve(siteDir, 'assets/spaces')
  if (extension === '.png' && filePath.startsWith(`${guideAssetRoot}${sep}`)) return 'private, no-cache'
  return REVALIDATED_EXTENSIONS.has(extension) ? 'no-cache' : 'public, max-age=3600'
}

function readPackageVersion() {
  const packageJson = JSON.parse(readFileSync(resolve(APP_DIR, 'package.json'), 'utf8'))
  return packageJson.version
}

function sendText(res, status, body, headers = {}) {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(body)
}

function safeFilePath(siteDir, rawPathname) {
  let pathname
  try {
    pathname = decodeURIComponent(rawPathname)
  } catch {
    return null
  }
  if (pathname.includes('\0')) return null
  if (pathname === '/docs') pathname = '/docs/'
  if (pathname.startsWith('/docs/')) pathname = pathname.slice('/docs'.length)
  if (pathname === '/' || pathname.endsWith('/')) pathname += 'index.html'

  const root = resolve(siteDir)
  const filePath = resolve(root, `.${pathname}`)
  if (filePath !== root && !filePath.startsWith(`${root}${sep}`)) return null
  return filePath
}

export function createDocumentationServer({
  siteDir = process.env.DOCUMENTATION_SITE_DIR ?? DEFAULT_SITE_DIR,
  version = process.env.DOCUMENTATION_VERSION ?? readPackageVersion(),
} = {}) {
  return http.createServer((req, res) => {
    void (async () => {
      const method = req.method ?? 'GET'
      const url = new URL(req.url ?? '/', 'http://documentation')
      if (url.pathname === '/health') {
        if (method !== 'GET' && method !== 'HEAD') {
          sendText(res, 405, 'Method not allowed\n', { allow: 'GET, HEAD' })
          return
        }
        const body = `${JSON.stringify({ ok: true, service: 'documentation', version })}\n`
        res.writeHead(200, {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
          'content-length': Buffer.byteLength(body),
        })
        res.end(method === 'HEAD' ? undefined : body)
        return
      }
      if (method !== 'GET' && method !== 'HEAD') {
        sendText(res, 405, 'Method not allowed\n', { allow: 'GET, HEAD' })
        return
      }

      const filePath = safeFilePath(siteDir, url.pathname)
      if (!filePath) {
        sendText(res, 404, 'Not found\n')
        return
      }
      const fileStat = await stat(filePath).catch(() => null)
      if (!fileStat?.isFile()) {
        sendText(res, 404, 'Not found\n')
        return
      }

      const extension = extname(filePath).toLowerCase()
      res.writeHead(200, {
        'content-type': CONTENT_TYPES.get(extension) ?? 'application/octet-stream',
        'content-length': fileStat.size,
        'cache-control': cacheControlFor(siteDir, filePath, extension),
        'x-content-type-options': 'nosniff',
      })
      if (method === 'HEAD') {
        res.end()
        return
      }
      createReadStream(filePath).pipe(res)
    })().catch((error) => {
      console.error('ERROR: [documentation] request failed', error)
      if (!res.headersSent) sendText(res, 500, 'Internal server error\n')
      else res.destroy(error)
    })
  })
}

export function startDocumentationServer() {
  const port = Number.parseInt(process.env.PORT ?? process.env.DOCUMENTATION_PORT ?? '8000', 10)
  const host = process.env.HOSTNAME ?? '0.0.0.0'
  const server = createDocumentationServer()
  server.listen(port, host, () => {
    console.info(`INFO: [documentation] listening on http://${host}:${port}`)
  })
  return server
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startDocumentationServer()
}
