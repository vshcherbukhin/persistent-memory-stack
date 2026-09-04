/**
 * @pm/shared/extract — recursive, token-aware chunker.
 *
 * Strategy: recursive split on a separator hierarchy (strongest separator that
 * yields ≤ maxTokens pieces), then greedily pack segments into token-bounded
 * windows with sentence-aligned token overlap. Pure/deterministic (no randomness)
 * → re-run idempotency holds (same text → same ordinals).
 */
import { countTokens } from './tokenizer.ts'
import type { Chunk, ChunkOptions, PageSpan } from './types.ts'

const TEXT_SEPARATORS = ['\n\n', '\n', '. ', '! ', '? ', '; ', ', ', ' ', '']
const MD_SEPARATORS = ['\n# ', '\n## ', '\n### ', '\n#### ', ...TEXT_SEPARATORS]

/**
 * Recursively split `text` so every leaf is ≤ maxTokens, preferring the strongest
 * separator that achieves it. Returns ordered leaf strings.
 */
function recursiveSplit(
  text: string,
  seps: string[],
  maxTokens: number,
  heuristic: boolean,
): string[] {
  if (countTokens(text, heuristic) <= maxTokens) return [text]
  for (let i = 0; i < seps.length; i++) {
    const sep = seps[i]!
    if (sep === '') break
    if (!text.includes(sep)) continue
    const parts = text.split(sep).filter(Boolean)
    if (parts.length < 2) continue
    const out: string[] = []
    for (const p of parts) {
      out.push(...recursiveSplit(p + (sep.trim() ? sep : ''), seps.slice(i + 1), maxTokens, heuristic))
    }
    return out
  }
  // No separator helped (one giant token-less run) → hard char-window slice.
  return hardSlice(text, maxTokens)
}

/** Last resort: slice by character budget (~4 chars/token) when no separator works. */
function hardSlice(text: string, maxTokens: number): string[] {
  const budget = maxTokens * 4
  const out: string[] = []
  for (let i = 0; i < text.length; i += budget) out.push(text.slice(i, i + budget))
  return out
}

export interface ChunkInput {
  text: string
  format: 'pdf' | 'docx' | 'markdown' | 'text'
  pages?: PageSpan[]
}

export function chunkText(input: ChunkInput, options: ChunkOptions = {}): Chunk[] {
  const maxTokens = options.maxTokens ?? 512
  const overlapTokens = options.overlapTokens ?? 64
  const minTokens = options.minTokens ?? 32
  const heuristic = options.useHeuristicTokens ?? false
  const seps = input.format === 'markdown' ? MD_SEPARATORS : TEXT_SEPARATORS

  const leaves = recursiveSplit(input.text, seps, maxTokens, heuristic)

  // Greedy pack with sentence-aligned overlap.
  const chunks: { content: string; tokenCount: number }[] = []
  let cur = ''
  let curTok = 0
  const flush = (): void => {
    if (!cur.trim()) return
    chunks.push({ content: cur.trim(), tokenCount: curTok })
    const tail = takeTail(cur, overlapTokens, heuristic)
    cur = tail
    curTok = countTokens(tail, heuristic)
  }
  for (const leaf of leaves) {
    const t = countTokens(leaf, heuristic)
    if (curTok + t > maxTokens && cur) flush()
    cur += (cur ? ' ' : '') + leaf
    curTok += t
  }
  if (cur.trim()) chunks.push({ content: cur.trim(), tokenCount: curTok })

  // Dangling-tail merge.
  if (chunks.length >= 2 && chunks[chunks.length - 1]!.tokenCount < minTokens) {
    const last = chunks.pop()!
    const prev = chunks[chunks.length - 1]!
    prev.content += '\n' + last.content
    prev.tokenCount = countTokens(prev.content, heuristic)
  }

  // Map ordinal + page (PDF) onto each chunk.
  let cursor = 0
  return chunks.map((c, ordinal) => {
    const at = input.text.indexOf(c.content.slice(0, 40), cursor)
    if (at >= 0) cursor = at
    return { ordinal, content: c.content, tokenCount: c.tokenCount, page: pageOf(cursor, input.pages) }
  })
}

/** Walk back sentence by sentence until ~overlapTokens reached (never mid-word). */
function takeTail(s: string, overlapTokens: number, heuristic: boolean): string {
  const sentences = s.split(/(?<=[.!?])\s+/)
  let acc = ''
  for (let i = sentences.length - 1; i >= 0; i--) {
    const next = sentences[i]! + (acc ? ' ' + acc : '')
    if (countTokens(next, heuristic) > overlapTokens && acc) break
    acc = next
  }
  return acc
}

function pageOf(offset: number, pages?: PageSpan[]): number | undefined {
  if (!pages?.length) return undefined
  for (const p of pages) if (offset >= p.start && offset < p.end) return p.page
  return pages[pages.length - 1]!.page
}
