/**
 * persistent-memory-api — fact-extraction prompt loader (Phase 7).
 *
 * Loads prompts/fact-extraction.md ONCE at module init (the LLM verdict's system
 * prompt). Mirrors the Python _load_prompt() fail-fast discipline: a missing
 * prompt file throws at BOOT (config-style), not on the first write.
 *
 * Path is resolved relative to THIS module, not cwd — in the container the
 * prompt ships in the image at persistent-memory/prompts/, and this module lives
 * at persistent-memory/apps/api/src/protocol/ (dev, tsx) or
 * .../apps/api/dist/protocol/ (built). We try a small set of candidate locations
 * and use the first that exists, so the gate works under tsx, the built dist,
 * and vitest alike.
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

/** Candidate prompt locations, in priority order (dev/tsx, build, monorepo). */
const CANDIDATES = [
  // dev (tsx) or built (dist): apps/api/{src,dist}/protocol → persistent-memory/prompts
  resolve(here, '../../../../prompts/fact-extraction.md'),
  // package-local fallback if a future image layout copies prompts beside the app
  resolve(here, '../../../prompts/fact-extraction.md'),
  // env override (set in the container if the layout differs)
  process.env.FACT_EXTRACTION_PROMPT_FILE
    ? resolve(process.env.FACT_EXTRACTION_PROMPT_FILE)
    : '',
].filter(Boolean)

function loadPrompt(): string {
  for (const candidate of CANDIDATES) {
    if (existsSync(candidate)) return readFileSync(candidate, 'utf-8')
  }
  throw new Error(
    `fact-extraction.md not found — checked: ${CANDIDATES.join(', ')}. ` +
      'The Shape-gate prompt must ship in the image; set ' +
      'FACT_EXTRACTION_PROMPT_FILE to override the path.',
  )
}

/** The fact-extraction system prompt, loaded once at boot (fail-fast). */
export const FACT_EXTRACTION_PROMPT: string = loadPrompt()
