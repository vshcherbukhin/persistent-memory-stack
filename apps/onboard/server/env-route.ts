import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { parseEnv } from 'node:util'
import type { FastifyInstance } from 'fastify'
import { genSecrets, maskEnv, renderEnv, validateEnvForDeploy, type Answers } from './env.js'
import { parseEnvFile } from './install.js'
import { readEmbeddingSelection, validateEmbeddingSelection, type EmbeddingSelection } from './embedding-config.js'

export interface EnvWriteRouteOptions {
  /** Return the installed data's active vector pin, never a draft wizard value. */
  readInstalledPin?: () => Promise<EmbeddingSelection | null>
  /** Keep Compose and installer steps on one stable configuration while running. */
  canWrite?: () => boolean
}

function readSuccessfulInstallPin(envPath: string): EmbeddingSelection | null {
  const path = join(dirname(envPath), '.local', 'install-artifacts', 'success.json')
  if (!existsSync(path)) return null
  try {
    const marker = JSON.parse(readFileSync(path, 'utf8')) as { embedding?: { provider?: string; model?: string; dimension?: number } }
    const raw = marker.embedding
    const selection = { provider: raw?.provider, model: raw?.model, dim: raw?.dimension } as EmbeddingSelection
    return validateEmbeddingSelection(selection) ? null : selection
  } catch { return null }
}

/** Register the saved configuration write without starting a server or host work. */
export function registerEnvWriteRoute(app: FastifyInstance, envPath: string, options: EnvWriteRouteOptions = {}): void {
  app.post<{ Body: { answers: Answers } }>('/api/env', async (req, reply) => {
    const busy = () => reply.code(409).send({ error: 'installation_active', message: 'An installation is running. Wait for it to finish before changing configuration.' })
    if (options.canWrite?.() === false) return busy()
    const oldText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
    const oldEnv = parseEnvFile(oldText)
    const a: Answers = { ...req.body.answers }
    // Blank provider fields retain the user's saved API keys.
    if (!a.anthropicApiKey?.trim() && oldEnv.ANTHROPIC_API_KEY) a.anthropicApiKey = oldEnv.ANTHROPIC_API_KEY
    if (!a.openaiApiKey?.trim() && oldEnv.OPENAI_API_KEY) a.openaiApiKey = oldEnv.OPENAI_API_KEY
    if (!a.voyageApiKey?.trim() && oldEnv.VOYAGE_API_KEY) a.voyageApiKey = oldEnv.VOYAGE_API_KEY
    const requested: EmbeddingSelection = { provider: a.embedProvider, model: a.embedModel, dim: a.embedDim }
    const previous = readEmbeddingSelection(parseEnv(oldText))
    const changesPin = !previous || previous.provider !== requested.provider || previous.model !== requested.model || previous.dim !== requested.dim
    let installed: EmbeddingSelection | null
    try {
      // A live database check can prove the corpus empty; null then intentionally
      // overrides a historical success marker. Markers are a fallback only when
      // no reliable data probe is configured (for isolated route tests/adapters).
      // An unchanged valid tuple remains repairable even if the DB is stopped.
      installed = options.readInstalledPin ? changesPin ? await options.readInstalledPin() : null : readSuccessfulInstallPin(envPath)
    } catch {
      const message = 'Existing memory storage could not be checked safely. Start or recover this installation’s database, then retry. Setup will not overwrite an unverified embedding configuration.'
      return reply.code(409).send({ error: 'embedding_storage_unverified', issues: [{ key: 'EMBED_MODEL', message }], message })
    }
    // The data probe yields: another request may have started installation.
    // Everything from this second check through the atomic write is synchronous.
    if (options.canWrite?.() === false) return busy()
    if (installed && (installed.provider !== requested.provider || installed.model !== requested.model || installed.dim !== requested.dim)) {
      const message = `Existing memories use ${installed.model} (${installed.dim} dimensions). Keep that model during reinstall; use the dashboard embedding migration to change it safely.`
      return reply.code(409).send({ error: 'embedding_migration_required', issues: [{ key: 'EMBED_MODEL', message }], message })
    }
    // Newlines in browser-provided secrets must not introduce extra dotenv keys.
    for (const key of ['anthropicApiKey', 'openaiApiKey', 'voyageApiKey'] as const) {
      if (/[\r\n]/.test(a[key] ?? '')) return reply.code(422).send({ error: 'invalid_api_key', message: 'API keys must be a single line.', issues: [{ key, message: 'API keys must be a single line.' }] })
    }
    if ((a.deploymentMode ?? 'server') === 'local') {
      a.userPasswordConfiguredAt = new Date().toISOString()
    }
    // Stored hashes depend on TOKEN_PEPPER; services and persistent volumes also
    // depend on their saved credentials. Configuration saves must not rotate them.
    const secrets = genSecrets(oldEnv)
    const env = renderEnv(a, secrets, oldEnv)
    const issues = validateEnvForDeploy(parseEnvFile(env))
    if (issues.length) return reply.code(422).send({ error: 'invalid_configuration', message: issues[0]!.message, issues })
    // A full disk must not truncate the existing working configuration.
    const temporary = `${envPath}.${randomUUID()}.tmp`
    try {
      writeFileSync(temporary, env, { mode: 0o600, flag: 'wx' })
      renameSync(temporary, envPath)
    } finally { rmSync(temporary, { force: true }) }
    return { path: envPath, preview: maskEnv(env), issues }
  })
}
