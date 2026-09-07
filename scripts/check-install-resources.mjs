#!/usr/bin/env node
/** Native host preflight using the same compiled policy as the wizard. No
 * downloads, models, Docker starts or configuration writes occur here. */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseEnv } from 'node:util'

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const rootArg = args.indexOf('--root')
const root = rootArg >= 0 ? resolve(args[rootArg + 1] ?? '') : sourceRoot
const dist = join(sourceRoot, 'apps/onboard/dist/apps/onboard')
try {
  if (!existsSync(join(dist, 'server/resources.js'))) throw new Error('Resource checker is not built. Run npm ci --prefix apps/onboard and npm run build:server --prefix apps/onboard, then retry. No Docker images were changed.')
  const [{ readResources }, { resourceGate }, { evaluateResources }] = await Promise.all([
    import(pathToFileURL(join(dist, 'server/resources.js')).href),
    import(pathToFileURL(join(dist, 'server/resource-gate.js')).href),
    import(pathToFileURL(join(dist, 'shared/resource-policy.js')).href),
  ])
  const envPath = join(root, '.env.persistent-memory')
  if (!existsSync(envPath)) throw new Error('Configure .env.persistent-memory with an embedding provider first, or run npm run install-persistent-memory.')
  const config = parseEnv(readFileSync(envPath, 'utf8'))
  const snapshot = await readResources({ installPath: root })
  const selection = { provider: config.EMBED_PROVIDER ?? '', model: config.EMBED_MODEL ?? '' }
  const assessment = evaluateResources(snapshot, selection)
  const problem = resourceGate(snapshot, selection, args.includes('--acknowledge-warnings'))
  console.log(JSON.stringify({ snapshot, assessment }, null, 2))
  if (problem) throw new Error(problem + (assessment.allowed ? ' After reviewing the warnings, rerun with --acknowledge-warnings (or PM_RESOURCE_WARNINGS_ACKNOWLEDGED=1 in the shell installer).' : ''))
  console.log('PASS Installation resources meet the selected embedding configuration minimums.')
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}
