/**
 * Validate the MCP environment ONCE at boot (fail-fast).
 *
 * A missing required var prints to STDERR (stdout is the JSON-RPC channel) and
 * exits 1 — the client gets a clean "server failed to start" rather than a
 * half-initialized server. The token VALUE is never logged. Full-local installs
 * deliberately run the API with no token auth; server mode is enforced after
 * GET /config reports deploymentMode=server.
 *
 * Client-managed note: OLLAMA_URL / EMBED_* are only BRIDGE HINTS, validated lazily after
 * GET /config reports client-bridge. The MCP does NOT trust its own
 * EMBEDDING_MODE — the effective mode/pin come from the API at startup
 * (admin-toggleable at runtime in P9). EMBEDDING_MODE is intentionally NOT read
 * here.
 */
import { z } from 'zod'
import { log } from './log.ts'

const optionalEnvString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().optional(),
)

const optionalEnvUrl = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().url().optional(),
)

const EnvSchema = z
  .object({
    PM_USER_TOKEN: z.string().optional(),
    API_URL: z
      .string()
      .url('API_URL must be a full URL, e.g. http://host.docker.internal:8090 or the QA server URL.'),
    // ── client-managed bridge hints (only used if GET /config reports client-bridge) ──
    OLLAMA_URL: z.string().url().default('http://host.docker.internal:11434'),
    EMBED_PROVIDER: z.enum(['ollama', 'voyage', 'openai']).default('ollama'),
    // Cross-checked against the server pin; the SERVER pin always wins.
    EMBED_MODEL: z.string().optional(),
    EMBED_DIM: z.coerce.number().int().positive().optional(),
    VOYAGE_API_KEY: z.string().optional(),
    OPENAI_API_KEY: z.string().optional(),
    PM_API_TIMEOUT_MS: z.coerce.number().int().positive().default(60_000),
    PM_MCP_TRANSPORT: z.enum(['http']).default('http'),
    PM_MCP_CLIENT_NAME: z.string().default('persistent-memory-mcp'),
    PM_MCP_HTTP_HOST: z.string().default('127.0.0.1'),
    PM_MCP_HTTP_PORT: z.coerce.number().int().positive().default(8091),
    PM_MEMORY_INSTALL_MODE: z.enum(['shared-only', 'personal-only', 'personal-and-shared']).default('shared-only'),
    PM_DEFAULT_MEMORY_SURFACE: z.enum(['personal', 'shared']).default('shared'),
    PM_PERSONAL_API_URL: optionalEnvUrl,
    PM_PERSONAL_USER_TOKEN: optionalEnvString,
    PM_SHARED_API_URL: optionalEnvUrl,
    PM_SHARED_USER_TOKEN: optionalEnvString,
  })
  .passthrough()

export type McpConfig = z.infer<typeof EnvSchema>

export function loadConfig(env: NodeJS.ProcessEnv = process.env): McpConfig {
  const r = EnvSchema.safeParse(env)
  if (!r.success) {
    // STDERR ONLY — never stdout. z.treeify keeps the field-level messages.
    log.error('invalid environment', { issues: z.treeifyError(r.error) })
    process.exit(1)
  }
  return r.data
}

export function requireTokenForServerMode(cfg: McpConfig): void {
  if (cfg.PM_USER_TOKEN && cfg.PM_USER_TOKEN.length >= 3) return
  log.error('invalid environment', {
    issues: {
      errors: [],
      properties: {
        PM_USER_TOKEN: {
          errors: ['PM_USER_TOKEN is required in server mode (format <tokenId>.<secret>, issued once in the dashboard webapp).'],
        },
      },
    },
  })
  process.exit(1)
}
