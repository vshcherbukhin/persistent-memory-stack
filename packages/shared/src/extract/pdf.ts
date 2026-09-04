/**
 * @pm/shared/extract — PDF text via unpdf (pure-JS serverless pdf.js; NO native
 * deps — the decisive factor vs pdf-parse/pdfjs-dist raw in the alpine worker
 * image). mergePages:false gives a per-page array, so we keep page boundaries
 * for free. Scanned/image-only PDFs extract to nothing → ExtractError(empty)
 * rather than silently writing zero chunks (OCR is out of scope for P6).
 */
import { getDocumentProxy, extractText as unpdfText, getMeta } from 'unpdf'
import {
  ExtractError,
  type ExtractedDoc,
  type PageSpan,
  type ExtractArtifact,
} from './types.ts'
import { normalize, isLikelyGarbled } from './plain.ts'

export async function extractPdf(
  bytes: Uint8Array,
  opts: { images: boolean },
): Promise<ExtractedDoc> {
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>
  try {
    pdf = await getDocumentProxy(bytes) // pure-JS pdf.js; no native dep
  } catch (cause) {
    throw new ExtractError('PDF parse failed (corrupt/encrypted?).', {
      format: 'pdf',
      kind: 'parse',
      cause,
    })
  }

  // Per-page array (mergePages:false) → we keep page boundaries.
  const { totalPages, text: pageTexts } = await unpdfText(pdf, { mergePages: false })

  // Assemble full text + page char-offset spans.
  const pages: PageSpan[] = []
  let buf = ''
  for (let i = 0; i < pageTexts.length; i++) {
    const norm = normalize(pageTexts[i] ?? '')
    const start = buf.length
    buf += (buf ? '\n\n' : '') + norm
    pages.push({ page: i + 1, start, end: buf.length })
  }
  const text = buf

  const warnings: string[] = []
  const emptyPages = pages.filter((_p, i) => (pageTexts[i] ?? '').trim().length === 0).length
  if (emptyPages > 0) {
    warnings.push(
      `${emptyPages}/${totalPages} page(s) yielded no text (likely scanned images — OCR not wired).`,
    )
  }

  // Empty / garbled guard: a scanned PDF extracts to ~nothing.
  if (text.trim().length === 0) {
    throw new ExtractError(
      'PDF produced no extractable text (scanned/image-only — needs OCR, out of scope for P6).',
      { format: 'pdf', kind: 'empty' },
    )
  }
  if (isLikelyGarbled(text)) warnings.push('PDF text may be garbled (font/encoding issue).')

  let meta: Record<string, unknown> | undefined
  try {
    meta = (await getMeta(pdf)).info as Record<string, unknown>
  } catch {
    /* meta is best-effort */
  }

  const artifacts: ExtractArtifact[] = [
    {
      kind: 'text',
      keySuffix: 'extracted.txt',
      contentType: 'text/plain; charset=utf-8',
      body: new TextEncoder().encode(text),
    },
  ]
  if (opts.images) {
    // Opt-in: encoding extracted pixel buffers to PNG needs `sharp` (native),
    // which would reintroduce the native-dep footprint unpdf avoids. Deferred.
    warnings.push('extractImages requested but image artifact encoding is deferred (needs sharp).')
  }

  return { format: 'pdf', text, pageCount: totalPages, pages, warnings, artifacts, meta }
}
