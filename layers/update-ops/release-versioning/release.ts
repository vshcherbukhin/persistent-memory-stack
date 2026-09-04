export interface ServiceRelease {
  service: string
  version: string
  change: string
}

export interface ParsedRelease {
  version: string
  date: string
  body: string
  latest: boolean
  services: ServiceRelease[]
  mcpRestartRequired: boolean
}

function parseHeading(raw: string): { version: string; date: string } | null {
  const m = /^([0-9]+\.[0-9]+\.[0-9]+)\s+-\s+([0-9]{4}-[0-9]{2}-[0-9]{2})\s*$/u.exec(raw.trim())
  if (!m) return null
  return { version: m[1]!, date: m[2]! }
}

function stripCell(cell: string): string {
  return cell.trim().replace(/^`|`$/g, '').trim()
}

export function parseServiceTable(body: string): ServiceRelease[] {
  const rows = body.split(/\r?\n/u)
  const headerIndex = rows.findIndex((line) => /^\|\s*Service\s*\|\s*Version\s*\|\s*Change\s*\|/iu.test(line))
  if (headerIndex < 0) return []
  const out: ServiceRelease[] = []
  for (const line of rows.slice(headerIndex + 2)) {
    if (!line.trim().startsWith('|')) break
    const cells = line.split('|').slice(1, -1).map(stripCell)
    if (cells.length < 3) continue
    const [service, version, change] = cells
    if (!service || !version) continue
    out.push({ service, version, change: change ?? '' })
  }
  return out
}

export function stripServiceTable(body: string): string {
  const rows = body.split(/\r?\n/u)
  const headerIndex = rows.findIndex((line) => /^\|\s*Service\s*\|\s*Version\s*\|\s*Change\s*\|/iu.test(line))
  if (headerIndex < 0) return body.trim()
  let end = headerIndex + 2
  while (end < rows.length && rows[end]?.trim().startsWith('|')) end += 1
  return [...rows.slice(0, headerIndex), ...rows.slice(end)].join('\n').trim()
}

export function parseReleaseHistory(markdown: string): ParsedRelease[] {
  const matches = [...markdown.matchAll(/^##\s+(.+)$/gmu)]
  return matches
    .map((match, index) => {
      const heading = parseHeading(match[1] ?? '')
      if (!heading) return null
      const start = (match.index ?? 0) + match[0].length
      const end = matches[index + 1]?.index ?? markdown.length
      const body = markdown.slice(start, end).trim()
      const services = parseServiceTable(body)
      return {
        ...heading,
        body: stripServiceTable(body),
        latest: index === 0,
        services,
        mcpRestartRequired: /\[mcp-restart\]/iu.test(body),
      }
    })
    .filter((release): release is ParsedRelease => release != null)
}

function semverParts(value: string): [number, number, number] {
  const [major = '0', minor = '0', patch = '0'] = value.split('.')
  return [Number(major) || 0, Number(minor) || 0, Number(patch) || 0]
}

export function compareSemver(a: string, b: string): number {
  const av = semverParts(a)
  const bv = semverParts(b)
  for (let i = 0; i < 3; i += 1) {
    const diff = av[i]! - bv[i]!
    if (diff !== 0) return diff
  }
  return 0
}

const MCP_RESTART_PATHS = [
  /^apps\/mcp\//u,
  /^mcp\//u,
  /^apps\/onboard\/server\/register\.ts$/u,
  /^apps\/onboard\/server\/rule\.ts$/u,
  /^apps\/onboard\/templates\//u,
  /^onboard\/server\/register\.ts$/u,
  /^onboard\/server\/rule\.ts$/u,
  /^onboard\/templates\//u,
  /^scripts\/onboard\.sh$/u,
  /^scripts\/install\.sh$/u,
]

export function detectMcpRestartRequired(paths: string[]): boolean {
  return paths.some((path) => MCP_RESTART_PATHS.some((pattern) => pattern.test(path)))
}
