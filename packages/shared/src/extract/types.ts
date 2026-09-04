/**
 * @pm/shared/extract — text extraction + chunking types. Pure: bytes in, text +
 * chunk objects out. No Postgres, no Qdrant, no MinIO coupling (the worker owns
 * those; this module returns artifacts as in-memory buffers for the worker to
 * put back).
 */

export type DocFormat = 'pdf' | 'docx' | 'markdown' | 'text'

/** A page boundary inside the extracted text (PDF) — char offsets into `text`. */
export interface PageSpan {
  page: number
  start: number
  end: number
}

/**
 * Derivative bytes the worker should PUT back to MinIO (extracted plaintext,
 * page images). The module produces buffers + a suggested key SUFFIX; the worker
 * owns the team/project/sourceId prefix (storage key scheme).
 */
export interface ExtractArtifact {
  kind: 'text' | 'image'
  /** Suffix only, e.g. "extracted.txt". Worker prefixes team/project/sourceId/. */
  keySuffix: string
  contentType: string
  body: Uint8Array
}

export interface ExtractedDoc {
  format: DocFormat
  /** Full normalized text (whitespace-collapsed, control chars scrubbed). */
  text: string
  pageCount?: number // PDF; → Document.pageCount
  pages?: PageSpan[] // PDF page boundaries (absent for docx/text)
  /** Non-fatal extraction warnings (mammoth messages, empty-page notes). */
  warnings: string[]
  artifacts: ExtractArtifact[]
  /** Source metadata for Document.metadata (PDF /Info, docx core props). */
  meta?: Record<string, unknown>
}

export interface Chunk {
  ordinal: number // 0-based; → Chunk.ordinal (unique per document)
  content: string // → Chunk.content
  tokenCount: number // → Chunk.tokenCount
  page?: number // first page this chunk touches (PDF only)
}

export interface ChunkOptions {
  maxTokens?: number // default 512
  overlapTokens?: number // default 64 (~12%)
  minTokens?: number // default 32 — merge dangling tail forward
  useHeuristicTokens?: boolean // default false (use tiktoken); true = chars/4
}

/**
 * Typed, actionable error — mirrors EmbeddingError's shape so the api/worker
 * boundary can map .kind → HTTP status / IngestJob.error consistently.
 */
export class ExtractError extends Error {
  override readonly name = 'ExtractError'
  constructor(
    message: string,
    readonly meta: {
      format?: DocFormat
      kind: 'unsupported' | 'parse' | 'empty' | 'encoding' | 'too_large'
      cause?: unknown
    },
  ) {
    super(message)
  }
}
