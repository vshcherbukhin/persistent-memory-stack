#!/usr/bin/env node
/**
 * Thin CLI wrapper over runSwitch — the admin-triggerable dimension/provider
 * migration entrypoint (foundation for the P9 web app). Run via:
 *
 *   tsx packages/shared/src/switch/cli.ts \
 *     --to-provider ollama --to-model nomic-embed-text --to-dim 768 \
 *     [--from-model qwen3-embedding:0.6b --from-dim 1024] \
 *     [--no-flip] [--no-drop] [--page 256]
 *
 * Reads QDRANT_URL + EMBED_* from env. The FROM pin defaults to the current
 * EMBED_MODEL/EMBED_DIM (the active pin in server-managed embeddings). The TARGET embedder is built
 * for the --to-* triple. The flip/dual-write hooks here are LOCAL ONLY (they log)
 * — persisting the active pin lives in the dashboard settings path (routes/dashboard/settings.ts
 * writes the SystemSettings singleton); this CLI proves the Qdrant migration
 * mechanics + is usable for test collections.
 *
 * NOTE: this CLI cannot fetch Postgres source text (shared is Prisma-free), so it
 * embeds the empty string per point unless --self-embed-from-payload is added in
 * a later phase. It is intended for the worker/dashboard to call runSwitch directly
 * with a real fetchText. The CLI is for mechanics smoke-testing + dry runs.
 */
import { makeEmbedder } from '../embeddings/factory.ts'
import { validateModelDim } from '../embeddings/registry.ts'
import type { ProviderName } from '../types/index.ts'
import { makeQdrantClient, resolveQdrantConfig } from '../qdrant/client.ts'
import { planSwitch } from './migration.ts'
import { runSwitch } from './run.ts'

interface Args {
  toProvider: ProviderName
  toModel: string
  toDim: number
  fromModel: string
  fromDim: number
  noFlip: boolean
  noDrop: boolean
  pageSize: number
}

function parseArgs(argv: string[]): Args {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const has = (flag: string): boolean => argv.includes(flag)

  const toProvider = (get('--to-provider') ?? process.env.EMBED_PROVIDER ?? 'ollama') as ProviderName
  const toModel = get('--to-model')
  const toDimRaw = get('--to-dim')
  if (!toModel || !toDimRaw) {
    throw new Error('Required: --to-model <model> --to-dim <dim>. See file header for usage.')
  }
  return {
    toProvider,
    toModel,
    toDim: Number(toDimRaw),
    fromModel: get('--from-model') ?? process.env.EMBED_MODEL ?? 'qwen3-embedding:4b',
    fromDim: Number(get('--from-dim') ?? process.env.EMBED_DIM ?? 2560),
    noFlip: has('--no-flip'),
    noDrop: has('--no-drop'),
    pageSize: Number(get('--page') ?? 256),
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  validateModelDim(args.toProvider, args.toModel, args.toDim) // fail-fast

  const client = makeQdrantClient(resolveQdrantConfig())
  const plan = planSwitch(args.fromModel, args.fromDim, args.toModel, args.toDim)

  const targetEmbedder = makeEmbedder({
    provider: args.toProvider,
    model: args.toModel,
    dim: args.toDim,
    ollamaUrl: process.env.OLLAMA_URL ?? 'http://host.docker.internal:11434',
    voyageApiKey: process.env.VOYAGE_API_KEY,
    openaiApiKey: process.env.OPENAI_API_KEY,
    batchSize: Number(process.env.EMBED_BATCH_SIZE ?? 16),
    maxRetries: Number(process.env.EMBED_MAX_RETRIES ?? 4),
    requestTimeoutMs: Number(process.env.EMBED_TIMEOUT_MS ?? 30000),
  })

  const result = await runSwitch(client, plan, {
    embed: async (texts) => (await targetEmbedder.embed(texts, 'document')).vectors,
    // CLI cannot read Postgres (shared is DB-free). Returns no text → the worker
    // path supplies a real fetchText. Here every point re-embeds the empty string.
    fetchText: async (rowIds) => new Map(rowIds.map((r) => [r, ''])),
    savePin: async (pin) =>
      console.log(`[cli] would persist active pin: ${pin.modelId}@${pin.dim} (${pin.vectorName})`),
    setDualWrite: async (t) =>
      console.log(`[cli] would set dual-write target: ${t ? t.vectorName : 'OFF'}`),
    onProgress: (n) => process.stdout.write(`\r[cli] migrated ${n} points...`),
    log: (m) => console.log(m),
    noFlip: args.noFlip,
    noDrop: args.noDrop,
    pageSize: args.pageSize,
  })

  console.log('\n[cli] switch result:', JSON.stringify(result))
}

main().catch((err: unknown) => {
  console.error('[cli] switch failed:', err instanceof Error ? err.message : err)
  process.exit(1)
})
