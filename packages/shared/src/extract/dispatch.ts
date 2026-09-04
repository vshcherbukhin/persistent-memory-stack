/**
 * @pm/shared/extract — format dispatch. mime/ext are ADVISORY (clients lie / send
 * octet-stream); we sniff PDF (%PDF) and docx (PK\x03\x04) magic bytes as a
 * tiebreak, defaulting to plain text (plain.ts throws 'encoding' on binary garbage).
 */
import { extractPdf } from './pdf.ts'
import { extractDocx } from './docx.ts'
import { extractPlain } from './plain.ts'
import { ExtractError, type DocFormat, type ExtractedDoc } from './types.ts'

const MIME: Record<string, DocFormat> = {
  'application/pdf': 'pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'text/markdown': 'markdown',
  'text/plain': 'text',
}

const EXT: Record<string, DocFormat> = {
  pdf: 'pdf',
  docx: 'docx',
  md: 'markdown',
  markdown: 'markdown',
  txt: 'text',
  text: 'text',
  log: 'text',
  ts: 'text',
  js: 'text',
  py: 'text',
  json: 'text',
  csv: 'text',
  yml: 'text',
  yaml: 'text',
}

export function resolveFormat(
  mime: string | undefined,
  filename: string | undefined,
  bytes: Uint8Array,
): DocFormat {
  const byMime = mime && MIME[mime.split(';')[0]!.trim().toLowerCase()]
  if (byMime) return byMime
  const ext = filename?.split('.').pop()?.toLowerCase()
  const byExt = ext && EXT[ext]
  if (byExt) return byExt
  // magic-byte sniff
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46
  ) {
    return 'pdf' // %PDF
  }
  if (
    bytes.length >= 4 &&
    bytes[0] === 0x50 &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x03 &&
    bytes[3] === 0x04 &&
    ext === 'docx'
  ) {
    return 'docx' // PK.. + .docx
  }
  return 'text'
}

export interface ExtractInput {
  bytes: Uint8Array
  mime?: string
  filename?: string
  /** Default false — images are opt-in (cost + native dep). */
  extractImages?: boolean
}

export async function extractText(input: ExtractInput): Promise<ExtractedDoc> {
  const fmt = resolveFormat(input.mime, input.filename, input.bytes)
  switch (fmt) {
    case 'pdf':
      return extractPdf(input.bytes, { images: input.extractImages ?? false })
    case 'docx':
      return extractDocx(input.bytes)
    case 'markdown':
    case 'text':
      return extractPlain(input.bytes, fmt)
    default:
      throw new ExtractError(`Unsupported format ${fmt}`, { format: fmt, kind: 'unsupported' })
  }
}
