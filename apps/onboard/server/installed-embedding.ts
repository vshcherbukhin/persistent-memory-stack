import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { parseEnv } from 'node:util'
import { EMBEDDING_MODELS, validateEmbeddingSelection, type EmbeddingSelection } from './embedding-config.js'
import { hostCommand } from './host.js'
import { EMBEDDING_CORPUS_TABLES } from '../../../layers/core/schema/embedding-corpus.js'

export type InstalledPinCommand = (args: string[]) => Promise<string>
const RECOVERY_MESSAGE = 'Existing memory storage could not be checked safely. Start or recover this installation’s database, then retry. Setup will not change an unverified corpus’s embedding model.'
export class InstalledEmbeddingCheckError extends Error {
  constructor() { super(RECOVERY_MESSAGE) }
}

function commandReader(root: string): InstalledPinCommand {
  return args => new Promise((resolve, reject) => {
    const command = hostCommand('docker', args)
    const child = spawn(command.command, command.args, { cwd: root, env: command.env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] })
    let output = ''
    const timer = setTimeout(() => { child.kill(); reject(new InstalledEmbeddingCheckError()) }, 6000)
    child.stdout.on('data', (data: Buffer) => {
      output += data.toString()
      if (output.length > 256 * 1024) { child.kill(); reject(new InstalledEmbeddingCheckError()) }
    })
    child.once('error', () => { clearTimeout(timer); reject(new InstalledEmbeddingCheckError()) })
    child.once('close', code => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new InstalledEmbeddingCheckError()) })
  })
}

// Includes sources, ingest work and provenance, not just visible memory rows.
const readOnly = (sql: string) => `BEGIN READ ONLY; SET LOCAL row_security = off; SET LOCAL statement_timeout = '3000ms'; ${sql}; COMMIT;`

/** Does not start containers, load models, change DB rows or expose credentials.
 * Volume existence means data may exist even when an old install has no marker. */
export async function readInstalledEmbeddingPin(root: string, envPath: string, run: InstalledPinCommand = commandReader(root)): Promise<EmbeddingSelection | null> {
  const env = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {}
  const volumePrefix = env.PM_VOLUME_PREFIX || 'persistent_memory'
  const container = `${env.PM_CONTAINER_PREFIX || 'persistent-memory'}-postgres`
  const dbVolume = `${volumePrefix}_postgres_data`
  try {
    const volumes = new Set((await run(['volume', 'ls', '--format', '{{.Name}}'])).split(/\r?\n/).filter(Boolean))
    if (![dbVolume, `${volumePrefix}_qdrant_data`, `${volumePrefix}_falkordb_data`, `${volumePrefix}_neo4j_data`, `${volumePrefix}_minio_data`].some(name => volumes.has(name))) return null
    if (!volumes.has(dbVolume)) throw new InstalledEmbeddingCheckError()
    const inspected = JSON.parse(await run(['inspect', '--format', '{"running":{{json .State.Running}},"mounts":{{json .Mounts}},"service":{{json (index .Config.Labels "com.docker.compose.service")}}}', container])) as { running?: boolean; mounts?: Array<{ Type?: string; Name?: string; Destination?: string }>; service?: string }
    if (!inspected.running || inspected.service !== 'postgres' || !inspected.mounts?.some(mount => mount.Type === 'volume' && mount.Name === dbVolume && mount.Destination === '/var/lib/postgresql/data')) throw new InstalledEmbeddingCheckError()
    const psql = (sql: string) => run(['exec', container, 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', env.POSTGRES_USER || 'pmuser', '-d', env.POSTGRES_DB || 'persistent_memory', '-c', readOnly(sql)])
    const tables = JSON.parse(await psql("SELECT COALESCE(json_agg(tablename), '[]'::json) FROM pg_tables WHERE schemaname = 'public'")) as string[]
    if (!Array.isArray(tables)) throw new InstalledEmbeddingCheckError()
    const corpus = EMBEDDING_CORPUS_TABLES.filter(table => tables.includes(table))
    // No known schema is common before first migrations, but cannot prove an
    // unknown/partial old database contains no recoverable user data.
    if (!tables.includes('system_settings') || corpus.length !== EMBEDDING_CORPUS_TABLES.length) throw new InstalledEmbeddingCheckError()
    const hasData = corpus.length ? corpus.map(table => `EXISTS (SELECT 1 FROM "${table}" LIMIT 1)`).join(' OR ') : 'false'
    const data = JSON.parse(await psql(`SELECT json_build_object('hasData', ${hasData}, 'model', (SELECT active_embed_model FROM system_settings WHERE id = 'singleton'), 'dim', (SELECT active_embed_dim FROM system_settings WHERE id = 'singleton'), 'switch', (SELECT embedding_switch FROM system_settings WHERE id = 'singleton'))`)) as { hasData?: boolean; model?: string; dim?: number; switch?: unknown }
    if (data.switch != null) throw new InstalledEmbeddingCheckError()
    if (data.hasData === false) return null
    if (data.hasData !== true || typeof data.model !== 'string') throw new InstalledEmbeddingCheckError()
    const selection = { provider: EMBEDDING_MODELS[data.model]?.provider, model: data.model, dim: data.dim } as EmbeddingSelection
    if (validateEmbeddingSelection(selection)) throw new InstalledEmbeddingCheckError()
    return selection
  } catch { throw new InstalledEmbeddingCheckError() }
}
