/** @pm/shared/extract — public surface of text extraction + token-aware chunking. */
export { extractText, resolveFormat } from './dispatch.ts'
export type { ExtractInput } from './dispatch.ts'
export { chunkText } from './chunker.ts'
export type { ChunkInput } from './chunker.ts'
export { countTokens } from './tokenizer.ts'
export { normalize, isLikelyGarbled } from './plain.ts'
export {
  ExtractError,
} from './types.ts'
export type {
  ExtractedDoc,
  Chunk,
  ChunkOptions,
  ExtractArtifact,
  PageSpan,
  DocFormat,
} from './types.ts'
