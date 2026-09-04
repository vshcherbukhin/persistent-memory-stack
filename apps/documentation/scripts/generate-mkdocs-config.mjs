import { readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(scriptDir, '../../..')
const documentationDir = resolve(rootDir, 'documentation')
const templatePath = resolve(rootDir, 'mkdocs.template.yml')
const outputPath = resolve(rootDir, 'mkdocs.yml')
const checkOnly = process.argv.includes('--check')

function parseFrontmatter(source, file) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  if (!match) throw new Error(`Missing frontmatter: ${file}`)
  return Object.fromEntries(match[1]
    .split(/\r?\n/)
    .map((line) => line.match(/^([a-z][\w-]*):\s*(.+)$/i))
    .filter(Boolean)
    .map((entry) => [entry[1], entry[2].trim()]))
}

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return ['assets', 'javascripts', 'node_modules', 'overrides', 'stylesheets'].includes(entry.name) ? [] : markdownFiles(path)
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : []
  }))
  return nested.flat().sort()
}

function quoted(value) {
  return JSON.stringify(value)
}

function number(metadata, field, file) {
  const value = Number(metadata[field])
  if (!Number.isInteger(value)) throw new Error(`Invalid ${field} in ${file}`)
  return value
}

async function collectNavigation() {
  const pages = []
  for (const file of await markdownFiles(documentationDir)) {
    const source = await readFile(file, 'utf8')
    const metadata = parseFrontmatter(source, file)
    if (metadata.nav_hidden === 'true') continue
    for (const field of ['nav_group', 'nav_group_order', 'nav_group_title', 'nav_order', 'nav_title']) {
      if (!metadata[field]) throw new Error(`Missing ${field} in ${file}`)
    }
    const path = relative(documentationDir, file).split(sep).join('/')
    pages.push({
      path,
      title: metadata.nav_title,
      order: number(metadata, 'nav_order', file),
      group: metadata.nav_group,
      groupOrder: number(metadata, 'nav_group_order', file),
      groupTitle: metadata.nav_group_title,
      section: metadata.nav_section ?? '',
      sectionOrder: metadata.nav_section ? number(metadata, 'nav_section_order', file) : 0,
      sectionTitle: metadata.nav_section_title ?? '',
    })
  }
  return pages
}

function renderPage(page, indent) {
  return `${' '.repeat(indent)}- ${quoted(page.title)}: ${page.path}`
}

function renderNavigation(pages) {
  const groups = [...new Map(pages.map((page) => [page.group, { order: page.groupOrder, title: page.groupTitle }])).entries()]
    .map(([name, value]) => ({ name, ...value }))
    .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title))
  const lines = ['nav:']

  for (const group of groups) {
    const groupPages = pages.filter((page) => page.group === group.name).sort((left, right) => left.order - right.order || left.title.localeCompare(right.title))
    if (group.name === 'root') {
      lines.push(...groupPages.map((page) => renderPage(page, 2)))
      continue
    }
    lines.push(`  - ${quoted(group.title)}:`)
    const sections = [...new Map(groupPages.filter((page) => page.section).map((page) => [page.section, { order: page.sectionOrder, title: page.sectionTitle }])).entries()]
      .map(([name, value]) => ({ name, ...value }))
      .sort((left, right) => left.order - right.order || left.title.localeCompare(right.title))
    const directPages = groupPages.filter((page) => !page.section)
    lines.push(...directPages.map((page) => renderPage(page, 6)))
    for (const section of sections) {
      lines.push(`      - ${quoted(section.title)}:`)
      lines.push(...groupPages.filter((page) => page.section === section.name).map((page) => renderPage(page, 10)))
    }
  }
  return `${lines.join('\n')}\n`
}

const [template, pages] = await Promise.all([readFile(templatePath, 'utf8'), collectNavigation()])
const generated = `${template.trimEnd()}\n${renderNavigation(pages)}`
if (checkOnly) {
  const current = await readFile(outputPath, 'utf8')
  if (current !== generated) throw new Error('mkdocs.yml is stale. Run npm run docs:generate.')
  console.log(`Verified MkDocs navigation from ${pages.length} Markdown pages.`)
} else {
  await writeFile(outputPath, generated)
  console.log(`Generated MkDocs navigation from ${pages.length} Markdown pages.`)
}
