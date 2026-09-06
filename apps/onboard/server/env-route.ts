import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { genSecrets, maskEnv, renderEnv, validateEnvForDeploy, type Answers } from './env.js'
import { parseEnvFile } from './install.js'

/** Register the saved configuration write without starting a server or host work. */
export function registerEnvWriteRoute(app: FastifyInstance, envPath: string): void {
  app.post<{ Body: { answers: Answers } }>('/api/env', async (req) => {
    const oldText = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
    const oldEnv = parseEnvFile(oldText)
    const a: Answers = { ...req.body.answers }
    // Blank provider fields retain the user's saved API keys.
    if (!a.anthropicApiKey?.trim() && oldEnv.ANTHROPIC_API_KEY) a.anthropicApiKey = oldEnv.ANTHROPIC_API_KEY
    if (!a.openaiApiKey?.trim() && oldEnv.OPENAI_API_KEY) a.openaiApiKey = oldEnv.OPENAI_API_KEY
    if (!a.voyageApiKey?.trim() && oldEnv.VOYAGE_API_KEY) a.voyageApiKey = oldEnv.VOYAGE_API_KEY
    if ((a.deploymentMode ?? 'server') === 'local') {
      a.userPasswordConfiguredAt = new Date().toISOString()
    }
    // Stored hashes depend on TOKEN_PEPPER; services and persistent volumes also
    // depend on their saved credentials. Configuration saves must not rotate them.
    const secrets = genSecrets(oldEnv)
    const env = renderEnv(a, secrets, oldEnv)
    writeFileSync(envPath, env, { mode: 0o600 })
    return { path: envPath, preview: maskEnv(env), issues: validateEnvForDeploy(parseEnvFile(env)) }
  })
}
