export interface ReleaseServiceRow {
  service: string
  version: string
  change: string
}

export interface ReleaseHistoryItem {
  version: string
  date: string
  body: string
  latest: boolean
  services: ReleaseServiceRow[]
}

function parseHeading(raw: string): { version: string; date: string } | null {
  const m = /^([0-9]+\.[0-9]+\.[0-9]+)\s+-\s+([0-9]{4}-[0-9]{2}-[0-9]{2})\s*$/u.exec(raw.trim())
  if (!m) return null
  return { version: m[1]!, date: m[2]! }
}

function parseServiceTable(body: string): ReleaseServiceRow[] {
  const rows = body.split(/\r?\n/u)
  const headerIndex = rows.findIndex((line) => /^\|\s*Service\s*\|\s*Version\s*\|\s*Change\s*\|/iu.test(line))
  if (headerIndex < 0) return []
  const out: ReleaseServiceRow[] = []
  for (const line of rows.slice(headerIndex + 2)) {
    if (!line.trim().startsWith('|')) break
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim().replace(/^`|`$/g, '').trim())
    if (cells.length < 3 || !cells[0] || !cells[1]) continue
    out.push({ service: cells[0], version: cells[1], change: cells[2] ?? '' })
  }
  return out
}

function stripServiceTable(body: string): string {
  const rows = body.split(/\r?\n/u)
  const headerIndex = rows.findIndex((line) => /^\|\s*Service\s*\|\s*Version\s*\|\s*Change\s*\|/iu.test(line))
  if (headerIndex < 0) return body.trim()
  let end = headerIndex + 2
  while (end < rows.length && rows[end]?.trim().startsWith('|')) end += 1
  return [...rows.slice(0, headerIndex), ...rows.slice(end)].join('\n').trim()
}

export function parseReleaseHistoryForUi(markdown: string): ReleaseHistoryItem[] {
  const matches = [...markdown.matchAll(/^##\s+(.+)$/gmu)]
  return matches
    .map((match, index) => {
      const heading = parseHeading(match[1] ?? '')
      if (!heading) return null
      const start = (match.index ?? 0) + match[0].length
      const end = matches[index + 1]?.index ?? markdown.length
      const body = markdown.slice(start, end).trim()
      return { ...heading, body: stripServiceTable(body), latest: index === 0, services: parseServiceTable(body) }
    })
    .filter((release): release is ReleaseHistoryItem => release != null)
}
