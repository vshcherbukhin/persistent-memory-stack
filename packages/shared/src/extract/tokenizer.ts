/**
 * @pm/shared/extract — token counting via js-tiktoken (pure-JS, no WASM/native
 * artifact in the alpine worker image). o200k_base is a model-agnostic proxy for
 * chunk sizing — chunk sizes only need to be stable + roughly calibrated, not
 * identical to the embedding model's tokenizer. A chars/4 heuristic fallback is
 * always available so the module degrades gracefully if tiktoken init ever fails.
 */
import { getEncoding, type Tiktoken } from 'js-tiktoken'

let enc: Tiktoken | null = null
let tiktokenFailed = false

function encoder(): Tiktoken | null {
  if (enc || tiktokenFailed) return enc
  try {
    enc = getEncoding('o200k_base') // model-agnostic, current GPT ranks
  } catch {
    tiktokenFailed = true // fall back to the heuristic forever
  }
  return enc
}

/** Token count. heuristic=true (or tiktoken init failed) → chars/4 estimate. */
export function countTokens(text: string, heuristic = false): number {
  if (!heuristic) {
    const e = encoder()
    if (e) return e.encode(text).length
  }
  return Math.ceil(text.length / 4)
}
