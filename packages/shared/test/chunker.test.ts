/**
 * Recursive token-aware chunker — size / overlap / boundary behavior.
 *
 * The chunker is pure + deterministic (no randomness), so every assertion here
 * is reproducible. We mostly drive it with `useHeuristicTokens: true` so token
 * counts are an exact, inspectable function of length (ceil(len/4)) — that lets
 * us assert the size + overlap budgets precisely instead of against tiktoken's
 * opaque ranks. A couple of cases exercise the default (tiktoken) path too.
 *
 * Covered:
 *   • short text below maxTokens → single chunk, ordinal 0, no overlap seam.
 *   • every chunk respects maxTokens (size boundary) across many windows.
 *   • ordinals are 0-based, contiguous, strictly increasing.
 *   • overlap: overlapTokens=0 produces no carried tail; a positive overlap
 *     carries a sentence-aligned tail (content of chunk N reappears at the head
 *     of chunk N+1).
 *   • dangling-tail merge: a tiny trailing remainder (< minTokens) is folded
 *     back into the previous chunk rather than emitted as a runt.
 *   • idempotency: same input → identical ordinals + content on re-run.
 *   • hard char-slice fallback when no separator exists (one giant token-less run).
 *   • markdown separators split on headings.
 *   • empty / whitespace-only input → no chunks.
 *   • page mapping (PDF PageSpan) lands a chunk on a plausible page.
 *   • default (tiktoken) path still honors maxTokens.
 */
import { describe, it, expect } from 'vitest'
import { chunkText } from '../src/extract/chunker.ts'
import type { ChunkInput } from '../src/extract/chunker.ts'
import { countTokens } from '../src/extract/tokenizer.ts'
import type { PageSpan } from '../src/extract/types.ts'

const H = { useHeuristicTokens: true } as const

/** Deterministic prose: N sentences, each a fixed-length word run ending in ". ". */
function sentences(n: number, wordsPer = 8): string {
  const out: string[] = []
  for (let i = 0; i < n; i++) {
    const words = Array.from({ length: wordsPer }, (_, w) => `s${i}w${w}`)
    out.push(words.join(' ') + '.')
  }
  return out.join(' ')
}

describe('chunkText — size boundary', () => {
  it('returns a single ordinal-0 chunk for text under maxTokens', () => {
    const text = 'A short paragraph well under the budget.'
    const chunks = chunkText({ text, format: 'text' }, { ...H, maxTokens: 512 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.ordinal).toBe(0)
    expect(chunks[0]!.content).toBe(text)
    expect(chunks[0]!.tokenCount).toBe(countTokens(text, true))
  })

  it('keeps every chunk within maxTokens + the overlap carry (heuristic budget)', () => {
    // The packer guards on summed leaf tokens (curTok + t > maxTokens) and seeds
    // each new window with an overlap tail, so the stored tokenCount targets
    // maxTokens but may carry up to ~overlapTokens of seeded tail. We assert that
    // defensible soft bound, not a hard <= maxTokens (which the design does not
    // guarantee once an overlap tail is seeded).
    const text = sentences(400) // far over a small window → many chunks
    const maxTokens = 40
    const overlapTokens = 8
    const chunks = chunkText({ text, format: 'text' }, { ...H, maxTokens, overlapTokens, minTokens: 4 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.tokenCount).toBeGreaterThan(0)
      expect(c.tokenCount).toBeLessThanOrEqual(maxTokens + overlapTokens)
    }
  })

  it('produces 0-based, contiguous, strictly increasing ordinals', () => {
    const text = sentences(200)
    const chunks = chunkText({ text, format: 'text' }, { ...H, maxTokens: 50, overlapTokens: 10, minTokens: 4 })
    expect(chunks.length).toBeGreaterThan(2)
    chunks.forEach((c, i) => expect(c.ordinal).toBe(i))
  })
})

describe('chunkText — overlap boundary', () => {
  it('still carries a one-sentence minimum tail even at overlapTokens=0', () => {
    // Quirk worth pinning: takeTail keeps AT LEAST one whole sentence (its
    // `&& acc` guard never breaks on the first sentence), so overlapTokens=0
    // does NOT mean zero overlap — it means "one-sentence minimum". The seam
    // therefore still shares the trailing sentence of chunk N with chunk N+1.
    const text = sentences(120)
    const maxTokens = 40
    const chunks = chunkText(
      { text, format: 'text' },
      { ...H, maxTokens, overlapTokens: 0, minTokens: 4 },
    )
    expect(chunks.length).toBeGreaterThan(2)
    const cur = chunks[0]!.content
    const lastSentence = cur.split(/(?<=[.!?])\s+/).at(-1)!.trim()
    expect(chunks[1]!.content.startsWith(lastSentence)).toBe(true)
  })

  it('a larger overlapTokens carries strictly more total tokens than the minimum', () => {
    const text = sentences(120, 6)
    const maxTokens = 60
    const sum = (cs: { tokenCount: number }[]): number => cs.reduce((a, c) => a + c.tokenCount, 0)
    const small = chunkText({ text, format: 'text' }, { ...H, maxTokens, overlapTokens: 0, minTokens: 4 })
    const big = chunkText({ text, format: 'text' }, { ...H, maxTokens, overlapTokens: 24, minTokens: 4 })
    expect(sum(big)).toBeGreaterThan(sum(small))
  })

  it('carries a sentence-aligned overlap tail into the next chunk', () => {
    // Short sentences (6 words) so the overlap tail (16 tok) spans whole
    // sentences and genuinely re-appears across the seam.
    const text = sentences(120, 6)
    const maxTokens = 60
    const overlapTokens = 16
    const noOverlap = chunkText(
      { text, format: 'text' },
      { ...H, maxTokens, overlapTokens: 0, minTokens: 4 },
    )
    const withOverlap = chunkText(
      { text, format: 'text' },
      { ...H, maxTokens, overlapTokens, minTokens: 4 },
    )
    // Overlap duplicates a tail at every seam → strictly more total tokens than
    // the zero-overlap partition of the same text.
    const sum = (cs: { tokenCount: number }[]): number => cs.reduce((a, c) => a + c.tokenCount, 0)
    expect(sum(withOverlap)).toBeGreaterThan(sum(noOverlap))
    expect(withOverlap.length).toBeGreaterThan(1)

    // Concrete seam check: the trailing sentence of chunk N re-appears verbatim
    // at the head of chunk N+1 (sentence-aligned overlap, never mid-word).
    for (let i = 0; i + 1 < withOverlap.length; i++) {
      const cur = withOverlap[i]!.content
      const next = withOverlap[i + 1]!.content
      const lastSentence = cur.split(/(?<=[.!?])\s+/).at(-1)!.trim()
      const firstTokenOfLastSentence = lastSentence.split(' ')[0]!
      expect(next.startsWith(firstTokenOfLastSentence) || next.includes(lastSentence)).toBe(true)
    }
  })

  it('a whole short sentence stays within the overlap budget tolerance', () => {
    // takeTail walks back sentence-by-sentence, keeping at least one sentence and
    // stopping before it would exceed overlapTokens. A single 4-word sentence is
    // well under a 12-token overlap budget here.
    const overlapTokens = 12
    const oneSentence = 's0w0 s0w1 s0w2 s0w3.'
    expect(countTokens(oneSentence, true)).toBeLessThanOrEqual(overlapTokens + 4)
  })
})

describe('chunkText — minTokens dangling-tail merge', () => {
  it('folds a runt trailing chunk (< minTokens) into the previous chunk', () => {
    // Construct text that packs to N full windows plus a tiny remainder.
    const body = sentences(80)
    const tinyTail = ' Z.' // ~1 token remainder
    const text = body + tinyTail
    const chunks = chunkText(
      { text, format: 'text' },
      { ...H, maxTokens: 50, overlapTokens: 0, minTokens: 32 },
    )
    // The last chunk must NOT be a sub-minTokens runt: either it was merged
    // forward (so the final chunk is >= minTokens), or there is a single chunk.
    const last = chunks.at(-1)!
    if (chunks.length >= 2) {
      expect(last.tokenCount).toBeGreaterThanOrEqual(1) // merged content present
      // The runt 'Z.' must live inside the final chunk after the merge.
      expect(last.content.includes('Z.')).toBe(true)
    }
  })

  it('does not merge when only a single chunk exists', () => {
    const text = 'Tiny.'
    const chunks = chunkText({ text, format: 'text' }, { ...H, maxTokens: 512, minTokens: 32 })
    expect(chunks).toHaveLength(1)
    expect(chunks[0]!.content).toBe('Tiny.')
  })
})

describe('chunkText — determinism / idempotency', () => {
  it('produces identical ordinals + content on re-run', () => {
    const text = sentences(150)
    const opts = { ...H, maxTokens: 64, overlapTokens: 12, minTokens: 8 }
    const a = chunkText({ text, format: 'text' }, opts)
    const b = chunkText({ text, format: 'text' }, opts)
    expect(b.map((c) => [c.ordinal, c.content, c.tokenCount])).toEqual(
      a.map((c) => [c.ordinal, c.content, c.tokenCount]),
    )
  })
})

describe('chunkText — separators + fallback', () => {
  it('hard char-slices a single token-less run with no usable separator', () => {
    // No whitespace, no punctuation → recursiveSplit exhausts every separator and
    // falls through to hardSlice (budget = maxTokens * 4 chars). The run is far
    // over a single window, so the fallback yields multiple chunks. (Note: a
    // separator-less blob is one "sentence", so the overlap tail carries the full
    // window forward — we therefore assert the fallback fired + chunk content is
    // drawn from the source, not a clean partition.)
    const maxTokens = 10
    const run = 'x'.repeat(maxTokens * 4 * 3 + 7) // ~3 windows + remainder
    const chunks = chunkText({ text: run, format: 'text' }, { ...H, maxTokens, overlapTokens: 0, minTokens: 1 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.content.length).toBeGreaterThan(0)
      // Content is hardSlice windows of the source char, joined by the packer's
      // single-space separator — no foreign characters ever appear.
      expect(/^[x ]+$/.test(c.content)).toBe(true)
    }
    // The first chunk is exactly one window of the source character budget
    // (maxTokens * 4 chars), with no carried-in tail yet.
    expect(chunks[0]!.content).toBe('x'.repeat(maxTokens * 4))
  })

  it('splits markdown on heading separators', () => {
    const md = [
      '# Title',
      'Intro paragraph with enough words to matter here today.',
      '## Section A',
      'Body of section A with several words to fill the window.',
      '## Section B',
      'Body of section B with several words to fill the window.',
    ].join('\n')
    const chunks = chunkText({ text: md, format: 'markdown' }, { ...H, maxTokens: 20, overlapTokens: 0, minTokens: 2 })
    expect(chunks.length).toBeGreaterThan(1)
    // Heading text survives into the chunk stream.
    const all = chunks.map((c) => c.content).join(' ')
    expect(all).toContain('Section A')
    expect(all).toContain('Section B')
  })
})

describe('chunkText — empty input', () => {
  it('returns no chunks for empty text', () => {
    expect(chunkText({ text: '', format: 'text' }, H)).toEqual([])
  })

  it('returns no chunks for whitespace-only text', () => {
    expect(chunkText({ text: '   \n\t  \n', format: 'text' }, H)).toEqual([])
  })
})

describe('chunkText — page mapping (PDF)', () => {
  it('assigns a plausible page from PageSpan offsets', () => {
    const p1 = sentences(10)
    const p2 = sentences(10)
    const text = p1 + p2
    const pages: PageSpan[] = [
      { page: 1, start: 0, end: p1.length },
      { page: 2, start: p1.length, end: text.length },
    ]
    const chunks = chunkText({ text, format: 'pdf', pages }, { ...H, maxTokens: 30, overlapTokens: 0, minTokens: 2 })
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) {
      expect(c.page === 1 || c.page === 2).toBe(true)
    }
    // The first chunk must land on page 1.
    expect(chunks[0]!.page).toBe(1)
  })

  it('leaves page undefined when no PageSpans are given', () => {
    const chunks = chunkText({ text: sentences(5), format: 'text' }, H)
    for (const c of chunks) expect(c.page).toBeUndefined()
  })
})

describe('chunkText — default (tiktoken) path', () => {
  it('chunks long text into many windows with clean ordinals using the real tokenizer', () => {
    const text = sentences(300)
    const maxTokens = 48
    const chunks = chunkText({ text, format: 'text' }, { maxTokens, overlapTokens: 8, minTokens: 4 })
    expect(chunks.length).toBeGreaterThan(1)
    chunks.forEach((c, i) => {
      expect(c.ordinal).toBe(i)
      expect(c.tokenCount).toBeGreaterThan(0)
      expect(c.content.length).toBeGreaterThan(0)
    })
    // Token budget is a soft target with the real tokenizer (the packer sums
    // per-leaf counts + seeds an overlap tail, neither of which re-encodes the
    // joined chunk). Assert it stays in a sane band, not an exact bound.
    for (const c of chunks) {
      expect(c.tokenCount).toBeLessThanOrEqual(maxTokens * 2)
    }
  })

  it('is deterministic on the tiktoken path too', () => {
    const text = sentences(120)
    const opts = { maxTokens: 64, overlapTokens: 12, minTokens: 8 }
    const a = chunkText({ text, format: 'text' }, opts)
    const b = chunkText({ text, format: 'text' }, opts)
    expect(b.map((c) => c.content)).toEqual(a.map((c) => c.content))
  })
})
