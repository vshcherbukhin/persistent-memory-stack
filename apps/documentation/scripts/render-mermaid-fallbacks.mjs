import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(scriptDir, '../../..')
const documentationDir = resolve(rootDir, 'documentation')
const assetsDir = resolve(documentationDir, 'assets/diagrams')
const configPath = resolve(documentationDir, 'mermaid-fallback-config.json')
const manifestPath = resolve(assetsDir, 'manifest.json')
const mmdcPath = resolve(rootDir, 'apps/documentation/node_modules/@mermaid-js/mermaid-cli/src/cli.js')
const checkOnly = process.argv.includes('--check')
const mermaidBlock = /^```mermaid\r?\n([\s\S]*?)^```\s*$/gm
const fallbackImage = /^!\[Diagram fallback: [^\]]+\]\([^)]+\)\r?\n\r?\n/gm

function digest(value) {
  return createHash('sha256').update(value).digest('hex')
}

function slug(value) {
  return value
    .replace(/\\/g, '/')
    .replace(/\.md$/, '')
    .replace(/[^a-zA-Z0-9]+/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/^-+|-+$/g, '')
    .toLowerCase()
}

function title(value, sequence) {
  return `${value.replace(/\.md$/, '').replace(/[\\/_-]+/g, ' ')} diagram ${sequence}`
}

function markdownPath(from, to) {
  const path = relative(dirname(from), to).split(sep).join('/')
  return path.startsWith('.') ? path : `./${path}`
}

async function markdownFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = await Promise.all(entries.map(async (entry) => {
    const path = resolve(directory, entry.name)
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : markdownFiles(path)
    return entry.isFile() && entry.name.endsWith('.md') ? [path] : []
  }))
  return files.flat().sort()
}

async function collectDiagrams(config) {
  const files = await markdownFiles(documentationDir)
  const diagrams = []
  const sources = []

  for (const file of files) {
    // Git may check out Markdown as CRLF on Windows. Content hashes and generated
    // links must have the same meaning as the LF originals on macOS/Linux.
    const original = (await readFile(file, 'utf8')).replace(/\r\n/g, '\n')
    const withoutFallbacks = original.replace(fallbackImage, '')
    const relativeSource = relative(documentationDir, file).split(sep).join('/')
    let sequence = 0
    const expected = withoutFallbacks.replace(mermaidBlock, (block, definition) => {
      sequence += 1
      const fileName = `${slug(relativeSource)}--${String(sequence).padStart(2, '0')}.svg`
      const output = resolve(assetsDir, fileName)
      const source = definition.trim()
      const sourceHash = digest(`${source}\n${config}`)
      const alt = `Diagram fallback: ${title(relativeSource, sequence)}`
      const link = markdownPath(file, output)
      diagrams.push({ alt, fileName, output, relativeSource, source, sourceHash })
      return `![${alt}](${link})\n\n${block}`
    })
    sources.push({ expected, file, original, relativeSource })
  }

  return { diagrams, sources }
}

function manifestFor(diagrams) {
  return {
    schemaVersion: 1,
    generator: '@mermaid-js/mermaid-cli@11.16.0',
    diagrams: diagrams.map(({ fileName, relativeSource, sourceHash }) => ({ fileName, relativeSource, sourceHash })),
  }
}

async function assertFresh({ diagrams, sources }) {
  const staleSources = sources.filter(({ expected, original }) => expected !== original).map(({ relativeSource }) => relativeSource)
  if (staleSources.length > 0) {
    throw new Error(`Missing or stale Markdown fallback links: ${staleSources.join(', ')}. Run npm run diagrams:render --prefix apps/documentation.`)
  }
  if (!existsSync(manifestPath)) {
    throw new Error('Missing Mermaid fallback manifest. Run npm run diagrams:render --prefix apps/documentation.')
  }

  const expectedManifest = `${JSON.stringify(manifestFor(diagrams), null, 2)}\n`
  const actualManifest = (await readFile(manifestPath, 'utf8')).replace(/\r\n/g, '\n')
  if (actualManifest !== expectedManifest) {
    throw new Error('Mermaid source or fallback configuration changed. Run npm run diagrams:render --prefix apps/documentation.')
  }

  const expectedAssets = new Set([...diagrams.map(({ fileName }) => fileName), 'manifest.json'])
  const actualAssets = new Set(await readdir(assetsDir))
  const unexpectedAssets = [...actualAssets].filter((file) => !expectedAssets.has(file))
  if (unexpectedAssets.length > 0) throw new Error(`Unexpected Mermaid fallback assets: ${unexpectedAssets.join(', ')}`)

  for (const { fileName, output, sourceHash } of diagrams) {
    if (!existsSync(output)) throw new Error(`Missing Mermaid fallback asset: ${fileName}`)
    const svg = await readFile(output, 'utf8')
    if (!svg.startsWith('<svg') || !svg.includes(`persistent-memory mermaid source-sha256: ${sourceHash}`)) {
      throw new Error(`Stale Mermaid fallback asset: ${fileName}. Run npm run diagrams:render --prefix apps/documentation.`)
    }
  }
}

function render(input, output) {
  const result = spawnSync(process.execPath, [mmdcPath, '-i', input, '-o', output, '-c', configPath, '-b', 'transparent'], {
    cwd: rootDir,
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) throw new Error(`Mermaid CLI failed: ${result.stderr || result.stdout || 'unknown error'}`)
}

async function writeFallbacks({ diagrams, sources }) {
  await mkdir(assetsDir, { recursive: true })
  const expectedAssets = new Set(diagrams.map(({ fileName }) => fileName))
  for (const fileName of await readdir(assetsDir)) {
    if (fileName.endsWith('.svg') && !expectedAssets.has(fileName)) {
      await rm(resolve(assetsDir, fileName), { force: true })
    }
  }
  const workDir = await mkdtemp(resolve(tmpdir(), 'pm-mermaid-fallbacks-'))
  try {
    for (const [index, diagram] of diagrams.entries()) {
      const input = resolve(workDir, `${String(index + 1).padStart(2, '0')}.mmd`)
      const output = resolve(workDir, diagram.fileName)
      await writeFile(input, `${diagram.source}\n`)
      render(input, output)
      const svg = await readFile(output, 'utf8')
      await writeFile(diagram.output, `${svg}\n<!-- persistent-memory mermaid source-sha256: ${diagram.sourceHash} -->\n`)
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }

  for (const { expected, file } of sources) await writeFile(file, expected)
  await writeFile(manifestPath, `${JSON.stringify(manifestFor(diagrams), null, 2)}\n`)
}

const config = (await readFile(configPath, 'utf8')).replace(/\r\n/g, '\n')
const collected = await collectDiagrams(config)
if (checkOnly) {
  await assertFresh(collected)
  console.log(`Verified ${collected.diagrams.length} Mermaid SVG fallbacks.`)
} else {
  await writeFallbacks(collected)
  console.log(`Rendered ${collected.diagrams.length} Mermaid SVG fallbacks.`)
}
