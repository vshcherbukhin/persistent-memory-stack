/**
 * Stable Qdrant named-vector key from (model, dim).
 *
 *   "qwen3-embedding:0.6b" @ 1024  ->  "qwen3-embedding-0.6b__1024"
 *
 * Only characters that are NOT alphanumeric / dot / hyphen collapse to a single
 * hyphen — so the model version dot (0.6b) is PRESERVED while colons, slashes,
 * and spaces become hyphens. The dim is appended after a double underscore so
 * the model slug and dim are unambiguously separable. This is the one place the
 * key is computed — embeddings AND qdrant both import it so they never drift.
 */
export function vectorName(model: string, dim: number): string {
  const slug = model
    .replace(/[^a-zA-Z0-9.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `${slug}__${dim}`
}
