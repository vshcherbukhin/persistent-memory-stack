import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** A saved env alone can be a failed first attempt. This marker is written only
 * after the install's migrations, runtime verification and registration succeed. */
export function writeInstallSuccess(root: string, env: Record<string, string>): void {
  const provider = env.EMBED_PROVIDER?.trim() || 'ollama'
  const model = env.EMBED_MODEL?.trim()
  const dimension = Number(env.EMBED_DIM)
  if (!model || !Number.isSafeInteger(dimension) || dimension <= 0) throw new Error('Cannot record installation completion: embedding model/dimension is invalid.')
  const directory = join(root, '.local', 'install-artifacts')
  mkdirSync(directory, { recursive: true })
  const target = join(directory, 'success.json')
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    writeFileSync(temporary, JSON.stringify({ version: 1, finishedAt: new Date().toISOString(), embedding: { provider, model, dimension } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
    renameSync(temporary, target)
  } finally { if (existsSync(temporary)) unlinkSync(temporary) }
}
