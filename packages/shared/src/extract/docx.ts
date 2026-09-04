/**
 * @pm/shared/extract — DOCX text via mammoth (pure JS, no native deps).
 *
 * mammoth wants a Node Buffer, not a bare Uint8Array (it silently mis-parses on
 * some versions) — pass { buffer: Buffer.from(bytes) }.
 */
import mammoth from 'mammoth'
import { ExtractError, type ExtractedDoc, type ExtractArtifact } from './types.ts'
import { normalize } from './plain.ts'

export async function extractDocx(bytes: Uint8Array): Promise<ExtractedDoc> {
  let value: string
  let messages: { message: string }[]
  try {
    const res = await mammoth.extractRawText({ buffer: Buffer.from(bytes) })
    value = res.value
    messages = res.messages
  } catch (cause) {
    throw new ExtractError('DOCX parse failed (not a valid .docx zip?).', {
      format: 'docx',
      kind: 'parse',
      cause,
    })
  }
  const text = normalize(value)
  if (text.trim().length === 0) {
    throw new ExtractError('DOCX produced no extractable text.', { format: 'docx', kind: 'empty' })
  }

  const warnings = messages.map((m) => m.message).slice(0, 20)
  const artifacts: ExtractArtifact[] = [
    {
      kind: 'text',
      keySuffix: 'extracted.txt',
      contentType: 'text/plain; charset=utf-8',
      body: new TextEncoder().encode(text),
    },
  ]
  return { format: 'docx', text, warnings, artifacts }
}
